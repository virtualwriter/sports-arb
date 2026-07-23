#!/usr/bin/env tsx
// Kalshi crypto + weather ladder middle scanner over WebSocket orderbooks
// (shadow only), plus a Polymarket daily-temperature polling leg.
//
// Kalshi: discovers open markets in CRYPTO_KALSHI_SERIES and
// WEATHER_KALSHI_SERIES via REST, then streams orderbook_delta over Kalshi WS
// for sub-second package detection. Two ladder shapes:
//   - cumulative ("greater"/"less" strikes, e.g. crypto dailies and hourly
//     temperature): middle = YES broad strike + NO narrow strike.
//   - exclusive bins ("between" strikes, e.g. daily high temperature):
//     package = NO bin A + NO bin B. At most one bin can win, so
//     packageCost < 1.00 is locked; both NOs pay if temp lands outside both.
//
// Polymarket: polls gamma for "highest-temperature-in-<city>-on-<date>"
// events (exclusive bins; NO ask = 1 - YES bestBid via mirrored CLOB books)
// and verifies leg sizes against the CLOB /book endpoint before recording.
//
// Requires KALSHI_API_KEY_ID + KALSHI_API_PRIVATE_KEY_PATH (WS is authenticated).
//
// Run:  npm run crypto:kalshi-ws
// Env:  CRYPTO_KALSHI_WS_REEVAL_MS (default 250)
//       CRYPTO_KALSHI_DISCOVER_MS (default 120000)
//       CRYPTO_RECORD_MAX_COST (default 1.05)
//       WEATHER_KALSHI_SERIES (see default below; set empty to disable)
//       PM_WEATHER_POLL_MS (default 60000; 0 disables the Polymarket leg)

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import {
  bookQuotes,
  KalshiClient,
  subscribeOrderbook,
  type KalshiMarket,
  type KalshiWsMessage,
} from "./lib/kalshi-client.js";
import { KalshiBookStore } from "./lib/kalshi-ws-books.js";
import { bestLevel, fetchJson, parseJsonArray, type BookLevel } from "./lib/monotonic-arb-core.js";
import { isSoftball, softballGateLabel } from "./lib/softball-gates.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const AUDIT_PATH = join(DATA_DIR, "crypto-middle-audit.jsonl");

const RECORD_MAX_COST = Number(process.env.CRYPTO_RECORD_MAX_COST ?? 1.05);
const MIN_IMPLIED_MIDDLE = Number(process.env.CRYPTO_MIN_IMPLIED_MIDDLE ?? 0.01);
const MIN_SIZE = Number(process.env.CRYPTO_SCANNER_MIN_SIZE ?? 5);
const REEVAL_MS = Number(process.env.CRYPTO_KALSHI_WS_REEVAL_MS ?? 250);
const DISCOVER_MS = Number(process.env.CRYPTO_KALSHI_DISCOVER_MS ?? 120_000);
const SUBSCRIBE_BATCH = Number(process.env.CRYPTO_KALSHI_WS_SUBSCRIBE_BATCH ?? 40);
// Throttle audit writes: re-log a package only when its cost moves by at least
// LOG_MIN_COST_DELTA, or every LOG_HEARTBEAT_MS as a persistence heartbeat.
// Without this the same qualifying package is re-logged on every book tick
// (up to 4x/sec), which is what bloated the audit stream to 13 GB in July.
const LOG_HEARTBEAT_MS = Number(process.env.CRYPTO_KALSHI_WS_LOG_HEARTBEAT_MS ?? 5_000);
const LOG_MIN_COST_DELTA = Number(process.env.CRYPTO_KALSHI_WS_LOG_MIN_COST_DELTA ?? 0.005);
const CRYPTO_SERIES = (process.env.CRYPTO_KALSHI_SERIES
  ?? "KXBTCD,KXETHD,KXBTCMAXMON,KXBTCMINMON,KXETHMAXMON,KXETHMINMON,KXSOLMAXMON,KXSOLMINMON,KXXRPMAXMON,KXXRPMINMON,KXDOGEMAXMON,KXDOGEMINMON")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Weather: daily max-temp bin ladders + hourly directional (cumulative) ladders.
const WEATHER_DAILY_SERIES_DEFAULT =
  "KXHIGHNY,KXHIGHCHI,KXHIGHMIA,KXHIGHAUS,KXHIGHDEN,KXHIGHLAX,KXHIGHPHIL,"
  + "KXHIGHTDC,KXHIGHTSFO,KXHIGHTSEA,KXHIGHTBOS,KXHIGHTDAL,KXHIGHTLV,"
  + "KXHIGHTPHX,KXHIGHTMIN,KXHIGHTSATX,KXHIGHTOKC";
const WEATHER_HOURLY_SERIES_DEFAULT =
  "KXTEMPNYCH,KXTEMPLAXH,KXTEMPAUSH,KXTEMPCHIH,KXTEMPBOSH,KXTEMPDCH,KXTEMPMIAH";
const WEATHER_SERIES = (process.env.WEATHER_KALSHI_SERIES
  ?? `${WEATHER_DAILY_SERIES_DEFAULT},${WEATHER_HOURLY_SERIES_DEFAULT}`)
  .split(",").map((s) => s.trim()).filter(Boolean);
const WEATHER_HOURLY_SET = new Set(WEATHER_HOURLY_SERIES_DEFAULT.split(","));

const KALSHI_SERIES = [...CRYPTO_SERIES, ...WEATHER_SERIES];
const CRYPTO_SERIES_SET = new Set(CRYPTO_SERIES);

// Polymarket daily-temperature leg (gamma poll + CLOB book verification).
const PM_WEATHER_POLL_MS = Number(process.env.PM_WEATHER_POLL_MS ?? 60_000);
const PM_WEATHER_PAGES = Number(process.env.PM_WEATHER_PAGES ?? 3);
const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";

type LadderMeta = {
  series: string;
  eventTicker: string;
  title: string;
  domain: "crypto" | "weather";
  cadence: "daily" | "monthly" | "hourly";
  // cumulative: nested greater/less strikes (crypto, hourly temp).
  // bins: mutually-exclusive ranges (daily max-temp ladders).
  kind: "cumulative" | "bins";
  orientation: "greater" | "less";
  markets: KalshiMarket[];
  tickers: string[];
};

function log(msg: string): void {
  console.log(`[crypto-kalshi-ws ${new Date().toISOString()}] ${msg}`);
}

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function emitAudit(row: Record<string, unknown>): void {
  ensureParent(AUDIT_PATH);
  appendFileSync(AUDIT_PATH, `${JSON.stringify(row)}\n`);
}

/** Attach softball flag; loud-log when the three entry gates pass. */
function withSoftball(
  row: Record<string, unknown> & {
    packageCost: number;
    netLockedEdge: number;
    availableSize: number;
    packageId: string;
    minLegAsk?: number;
  },
): Record<string, unknown> & { softball: boolean } {
  const softball = isSoftball(row);
  if (softball) {
    log(
      `!!! SOFTBALL FIRE ${row.venue}/${row.packageKind} `
      + `cost=${Number(row.packageCost).toFixed(3)} `
      + `net=${(Number(row.netLockedEdge) * 100).toFixed(2)}c `
      + `size=${Number(row.availableSize).toFixed(1)} `
      + `id=${row.packageId}`,
    );
  }
  return { ...row, softball };
}

const lastEmitted = new Map<string, { cost: number; at: number }>();

function shouldEmit(packageId: string, cost: number, now: number): boolean {
  const prev = lastEmitted.get(packageId);
  if (prev && Math.abs(cost - prev.cost) < LOG_MIN_COST_DELTA && now - prev.at < LOG_HEARTBEAT_MS) {
    return false;
  }
  lastEmitted.set(packageId, { cost, at: now });
  return true;
}

function assetFromSeries(series: string): string {
  const m = series.match(/^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)/i);
  return m ? m[1].toUpperCase() : series;
}

function seriesCadence(series: string): "daily" | "monthly" | "hourly" {
  if (CRYPTO_SERIES_SET.has(series)) {
    return series.includes("MON") ? "monthly" : "daily";
  }
  return WEATHER_HOURLY_SET.has(series) ? "hourly" : "daily";
}

// Bin range for mutually-exclusive ladders; used for sorting and audit labels.
function kalshiBinRange(m: KalshiMarket): { lo: number; hi: number } | null {
  const floor = typeof m.floor_strike === "number" ? m.floor_strike : null;
  const cap = typeof m.cap_strike === "number" ? m.cap_strike : null;
  if (m.strike_type === "between" && floor !== null && cap !== null) return { lo: floor, hi: cap };
  if (m.strike_type === "less" && cap !== null) return { lo: -Infinity, hi: cap };
  if (m.strike_type === "greater" && floor !== null) return { lo: floor, hi: Infinity };
  if (floor !== null || cap !== null) return { lo: floor ?? -Infinity, hi: cap ?? Infinity };
  return null;
}

function kalshiLadderOrientation(markets: KalshiMarket[]): "greater" | "less" {
  return markets.some((m) => m.strike_type === "less") ? "less" : "greater";
}

// Kalshi taker fee: 0.07 * P * (1-P) per contract per leg (Kalshi rounds the
// order total up to the next cent; we record the raw formula per contract).
// Makers pay no fee, but this scanner screens ask-lifting packages, so every
// leg is taker. Fees peak at mid prices (~1.75c at 50c) which is exactly where
// bin ladders concentrate value — gross-locked baskets inside the fee band are
// phantom edge (observed on KXHIGHCHI/KXHIGHAUS 2026-07-22: 3-4c gross locked,
// ~4.4c fees).
function kalshiTakerFees(legPrices: number[]): number {
  return legPrices.reduce((sum, p) => sum + 0.07 * p * (1 - p), 0);
}

function kalshiStrike(m: KalshiMarket): number | null {
  if (typeof m.floor_strike === "number") return m.floor_strike;
  if (typeof m.cap_strike === "number") return m.cap_strike;
  return null;
}

async function discoverLadders(client: KalshiClient): Promise<LadderMeta[]> {
  const out: LadderMeta[] = [];
  for (const series of KALSHI_SERIES) {
    try {
      const resp = await client.listEvents({
        series_ticker: series,
        status: "open",
        with_nested_markets: true,
        limit: 20,
      });
      for (const ev of resp.events ?? []) {
        const markets = (ev.markets ?? []).filter((m) => kalshiStrike(m) !== null);
        if (markets.length < 2) continue;
        const tickers = markets.map((m) => m.ticker).filter(Boolean);
        const hasBins = markets.some((m) => m.strike_type === "between");
        out.push({
          series,
          eventTicker: ev.event_ticker,
          title: ev.title ?? "",
          domain: CRYPTO_SERIES_SET.has(series) ? "crypto" : "weather",
          cadence: seriesCadence(series),
          kind: hasBins || ev.mutually_exclusive === true ? "bins" : "cumulative",
          orientation: kalshiLadderOrientation(markets),
          markets,
          tickers,
        });
      }
    } catch (err) {
      log(`discover ${series} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

type QuotedMarket = {
  ticker: string;
  strike: number;
  binLo: number;
  binHi: number;
  yesAsk: number;
  noAsk: number;
  yesAskSize: number;
  noAskSize: number;
};

function quoteLadder(books: KalshiBookStore, ladder: LadderMeta): QuotedMarket[] {
  const quoted: QuotedMarket[] = [];
  for (const m of ladder.markets) {
    const book = books.getBook(m.ticker);
    if (!book) continue;
    const q = bookQuotes(book);
    const strike = kalshiStrike(m);
    const bin = kalshiBinRange(m);
    if (strike === null || !bin) continue;
    if (!(q.yesAsk > 0) && !(q.noAsk > 0)) continue;
    quoted.push({
      ticker: m.ticker,
      strike,
      binLo: bin.lo,
      binHi: bin.hi,
      yesAsk: q.yesAsk,
      noAsk: q.noAsk,
      yesAskSize: q.yesAskSize,
      noAskSize: q.noAskSize,
    });
  }
  quoted.sort((a, b) => (a.binLo - b.binLo) || (a.strike - b.strike));
  return quoted;
}

function baseRow(ladder: LadderMeta, observedAt: string): Record<string, unknown> {
  return {
    observedAt,
    venue: "kalshi",
    source: "ws",
    domain: ladder.domain,
    asset: assetFromSeries(ladder.series),
    cadence: ladder.cadence,
    series: ladder.series,
    eventTicker: ladder.eventTicker,
    eventTitle: ladder.title,
  };
}

function evaluateCumulative(
  ladder: LadderMeta,
  quoted: QuotedMarket[],
  observedAt: string,
): { evaluated: number; recorded: number; locked: number; softballs: number } {
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  let softballs = 0;
  for (let i = 0; i < quoted.length; i++) {
    for (let j = i + 1; j < quoted.length; j++) {
      const broad = ladder.orientation === "less" ? quoted[j] : quoted[i];
      const narrow = ladder.orientation === "less" ? quoted[i] : quoted[j];
      if (!(broad.yesAsk > 0) || !(narrow.noAsk > 0)) continue;
      evaluated += 1;
      const packageCost = broad.yesAsk + narrow.noAsk;
      if (!(packageCost > 0) || packageCost > RECORD_MAX_COST) continue;
      const availableSize = Math.min(broad.yesAskSize, narrow.noAskSize);
      const impliedMiddle = Math.max(0, broad.yesAsk - (1 - narrow.noAsk));
      const deadTail = impliedMiddle < MIN_IMPLIED_MIDDLE;
      const takerFees = kalshiTakerFees([broad.yesAsk, narrow.noAsk]);
      const netLockedEdge = 1 - packageCost - takerFees;
      const isLocked = packageCost < 1;
      if (netLockedEdge > 0) locked += 1;
      if (availableSize < MIN_SIZE && !isLocked) continue;
      const packageId = `kalshi::${ladder.eventTicker}::YES-${broad.ticker}+NO-${narrow.ticker}`;
      if (!shouldEmit(packageId, packageCost, Date.now())) continue;
      recorded += 1;
      const row = withSoftball({
        ...baseRow(ladder, observedAt),
        packageId,
        packageKind: "middle",
        orientation: ladder.orientation,
        broadStrike: broad.strike,
        narrowStrike: narrow.strike,
        packageCost,
        lockedEdge: 1 - packageCost,
        takerFees,
        netLockedEdge,
        impliedMiddle,
        deadTail,
        locked: isLocked,
        lockedNet: netLockedEdge > 0,
        availableSize,
        minLegAsk: Math.min(broad.yesAsk, narrow.noAsk),
        sizeOk: availableSize >= MIN_SIZE,
        broad: { ticker: broad.ticker, yesAsk: broad.yesAsk, yesAskSize: broad.yesAskSize },
        narrow: { ticker: narrow.ticker, noAsk: narrow.noAsk, noAskSize: narrow.noAskSize },
      });
      if (row.softball) softballs += 1;
      emitAudit(row);
    }
  }
  return { evaluated, recorded, locked, softballs };
}

// Mutually-exclusive bin ladders (daily max temperature). Two structures:
//   - NO/NO pair: at most one bin can win, so a two-leg NO package pays $1
//     guaranteed ($2 if the temp lands outside both bins). cost < 1 = locked.
//   - YES basket across ALL bins: exactly one bin wins, pays exactly $1, so
//     total cost < 1 = locked. Only recorded when every bin has a live ask.
function evaluateBins(
  ladder: LadderMeta,
  quoted: QuotedMarket[],
  observedAt: string,
): { evaluated: number; recorded: number; locked: number; softballs: number } {
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  let softballs = 0;
  const now = Date.now();
  for (let i = 0; i < quoted.length; i++) {
    for (let j = i + 1; j < quoted.length; j++) {
      const a = quoted[i];
      const b = quoted[j];
      if (!(a.noAsk > 0) || !(b.noAsk > 0)) continue;
      evaluated += 1;
      const packageCost = a.noAsk + b.noAsk;
      if (!(packageCost > 0) || packageCost > RECORD_MAX_COST) continue;
      const availableSize = Math.min(a.noAskSize, b.noAskSize);
      // Analogous to impliedMiddle: implied P(temp outside both bins) → $2 leg.
      const impliedOutside = Math.max(0, packageCost - 1);
      const takerFees = kalshiTakerFees([a.noAsk, b.noAsk]);
      const netLockedEdge = 1 - packageCost - takerFees;
      const isLocked = packageCost < 1;
      if (netLockedEdge > 0) locked += 1;
      if (availableSize < MIN_SIZE && !isLocked) continue;
      const packageId = `kalshi::${ladder.eventTicker}::NO-${a.ticker}+NO-${b.ticker}`;
      if (!shouldEmit(packageId, packageCost, now)) continue;
      recorded += 1;
      const row = withSoftball({
        ...baseRow(ladder, observedAt),
        packageId,
        packageKind: "bin-no-pair",
        binA: { lo: a.binLo, hi: a.binHi },
        binB: { lo: b.binLo, hi: b.binHi },
        packageCost,
        lockedEdge: 1 - packageCost,
        takerFees,
        netLockedEdge,
        impliedMiddle: impliedOutside,
        deadTail: impliedOutside < MIN_IMPLIED_MIDDLE,
        locked: isLocked,
        lockedNet: netLockedEdge > 0,
        availableSize,
        minLegAsk: Math.min(a.noAsk, b.noAsk),
        sizeOk: availableSize >= MIN_SIZE,
        broad: { ticker: a.ticker, noAsk: a.noAsk, noAskSize: a.noAskSize },
        narrow: { ticker: b.ticker, noAsk: b.noAsk, noAskSize: b.noAskSize },
      });
      if (row.softball) softballs += 1;
      emitAudit(row);
    }
  }

  // YES basket needs the complete ladder quoted, otherwise the $1 payout is
  // not guaranteed (a missing bin could be the winner).
  if (quoted.length === ladder.markets.length && quoted.every((q) => q.yesAsk > 0)) {
    evaluated += 1;
    const packageCost = quoted.reduce((sum, q) => sum + q.yesAsk, 0);
    if (packageCost > 0 && packageCost <= RECORD_MAX_COST) {
      const availableSize = Math.min(...quoted.map((q) => q.yesAskSize));
      const takerFees = kalshiTakerFees(quoted.map((q) => q.yesAsk));
      const netLockedEdge = 1 - packageCost - takerFees;
      const isLocked = packageCost < 1;
      if (netLockedEdge > 0) locked += 1;
      if (availableSize >= MIN_SIZE || isLocked) {
        const packageId = `kalshi::${ladder.eventTicker}::YES-BASKET`;
        if (shouldEmit(packageId, packageCost, now)) {
          recorded += 1;
          const row = withSoftball({
            ...baseRow(ladder, observedAt),
            packageId,
            packageKind: "yes-basket",
            legs: quoted.map((q) => ({ ticker: q.ticker, yesAsk: q.yesAsk, yesAskSize: q.yesAskSize })),
            packageCost,
            lockedEdge: 1 - packageCost,
            takerFees,
            netLockedEdge,
            locked: isLocked,
            lockedNet: netLockedEdge > 0,
            availableSize,
            minLegAsk: Math.min(...quoted.map((q) => q.yesAsk)),
            sizeOk: availableSize >= MIN_SIZE,
          });
          if (row.softball) softballs += 1;
          emitAudit(row);
        }
      }
    }
  }
  return { evaluated, recorded, locked, softballs };
}

function evaluateLadder(
  books: KalshiBookStore,
  ladder: LadderMeta,
): { evaluated: number; recorded: number; locked: number; softballs: number } {
  const quoted = quoteLadder(books, ladder);
  const observedAt = new Date().toISOString();
  return ladder.kind === "bins"
    ? evaluateBins(ladder, quoted, observedAt)
    : evaluateCumulative(ladder, quoted, observedAt);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Polymarket daily-temperature leg (exclusive bin ladders, gamma poll + CLOB
// verification). Slug family: highest-temperature-in-<city>-on-<date>.
// ---------------------------------------------------------------------------

type PmBin = {
  question: string;
  binLo: number;
  binHi: number;
  unit: "F" | "C";
  yesTokenId: string;
  noTokenId: string;
  bestBid: number;
  bestAsk: number;
};

type PmTempEvent = {
  slug: string;
  title: string;
  city: string;
  bins: PmBin[];
  // Ladder size including closed/non-accepting bins. When bins.length is
  // smaller the ladder is partially resolved and a YES basket over the
  // remaining bins has NO $1 guarantee (the winner may be a closed bin).
  binsTotal: number;
};

// Estimates from gamma bestBid/bestAsk decide which packages are worth a CLOB
// /book round-trip; the margin absorbs staleness in gamma's cached quotes.
const PM_VERIFY_MARGIN = Number(process.env.PM_WEATHER_VERIFY_MARGIN ?? 0.03);

function parsePmTempBin(question: string): { binLo: number; binHi: number; unit: "F" | "C" } | null {
  const unit: "F" | "C" = /°\s*C/i.test(question) ? "C" : "F";
  const between = question.match(/between\s+(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/i);
  if (between) return { binLo: Number(between[1]), binHi: Number(between[2]), unit };
  const below = question.match(/be\s+(-?\d+(?:\.\d+)?)\s*°?\s*[FC]?\s*or\s+(?:below|lower)/i);
  if (below) return { binLo: -Infinity, binHi: Number(below[1]), unit };
  const above = question.match(/be\s+(-?\d+(?:\.\d+)?)\s*°?\s*[FC]?\s*or\s+(?:higher|above)/i);
  if (above) return { binLo: Number(above[1]), binHi: Infinity, unit };
  const exact = question.match(/be\s+(-?\d+(?:\.\d+)?)\s*°\s*[FC]\s+on/i);
  if (exact) return { binLo: Number(exact[1]), binHi: Number(exact[1]), unit };
  return null;
}

async function discoverPmTempEvents(): Promise<PmTempEvent[]> {
  const out: PmTempEvent[] = [];
  for (let page = 0; page < PM_WEATHER_PAGES; page++) {
    const url = `${GAMMA_API}/events?tag_slug=weather&closed=false&order=startDate&ascending=false&limit=100&offset=${page * 100}`;
    const events = (await fetchJson(url, 10_000)) as Array<Record<string, unknown>>;
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events) {
      const slug = String(ev.slug ?? "");
      const m = slug.match(/^highest-temperature-in-(.+?)-on-/);
      if (!m) continue;
      const bins: PmBin[] = [];
      let binsTotal = 0;
      for (const mk of (ev.markets as Array<Record<string, unknown>> | undefined) ?? []) {
        const question = String(mk.question ?? "");
        const parsed = parsePmTempBin(question);
        if (!parsed) continue;
        binsTotal += 1;
        if (mk.closed || mk.active === false || mk.acceptingOrders === false) continue;
        const outcomes = parseJsonArray(mk.outcomes).map((o) => String(o).toLowerCase());
        const tokens = parseJsonArray(mk.clobTokenIds).map(String);
        const yesIdx = outcomes.indexOf("yes");
        const noIdx = outcomes.indexOf("no");
        if (yesIdx < 0 || noIdx < 0 || !tokens[yesIdx] || !tokens[noIdx]) continue;
        bins.push({
          question,
          ...parsed,
          yesTokenId: tokens[yesIdx],
          noTokenId: tokens[noIdx],
          bestBid: Number(mk.bestBid ?? 0),
          bestAsk: Number(mk.bestAsk ?? 0),
        });
      }
      if (bins.length < 3) continue;
      bins.sort((a, b) => a.binLo - b.binLo);
      out.push({ slug, title: String(ev.title ?? slug), city: m[1], bins, binsTotal });
    }
    if (events.length < 100) break;
  }
  return out;
}

async function pmBookAsk(tokenId: string): Promise<{ ask: number; askSize: number }> {
  const book = (await fetchJson(
    `${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`,
    10_000,
  )) as { asks?: BookLevel[] };
  const best = bestLevel(book.asks, "ask");
  return { ask: best.price, askSize: best.size };
}

function pmBaseRow(ev: PmTempEvent, observedAt: string): Record<string, unknown> {
  return {
    observedAt,
    venue: "polymarket",
    source: "gamma+clob",
    domain: "weather",
    asset: `TEMP-${ev.city.toUpperCase()}`,
    cadence: "daily",
    eventSlug: ev.slug,
    eventTitle: ev.title,
  };
}

async function scanPmTempEvent(ev: PmTempEvent): Promise<{ evaluated: number; recorded: number; locked: number; softballs: number }> {
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  let softballs = 0;
  const observedAt = new Date().toISOString();
  const now = Date.now();
  const askCache = new Map<string, { ask: number; askSize: number }>();
  const verifiedAsk = async (tokenId: string) => {
    const hit = askCache.get(tokenId);
    if (hit) return hit;
    const fresh = await pmBookAsk(tokenId);
    askCache.set(tokenId, fresh);
    return fresh;
  };

  // NO/NO bin pairs, screened on gamma estimates (NO ask ~= 1 - YES bestBid).
  for (let i = 0; i < ev.bins.length; i++) {
    for (let j = i + 1; j < ev.bins.length; j++) {
      const a = ev.bins[i];
      const b = ev.bins[j];
      evaluated += 1;
      const estCost = (1 - a.bestBid) + (1 - b.bestBid);
      if (!(estCost > 0) || estCost > RECORD_MAX_COST + PM_VERIFY_MARGIN) continue;
      const [noA, noB] = await Promise.all([verifiedAsk(a.noTokenId), verifiedAsk(b.noTokenId)]);
      if (!(noA.ask > 0) || !(noB.ask > 0)) continue;
      const packageCost = noA.ask + noB.ask;
      if (packageCost > RECORD_MAX_COST) continue;
      const availableSize = Math.min(noA.askSize, noB.askSize);
      const impliedOutside = Math.max(0, packageCost - 1);
      const isLocked = packageCost < 1;
      if (isLocked) locked += 1;
      if (availableSize < MIN_SIZE && !isLocked) continue;
      const packageId = `pm::${ev.slug}::NO-${a.noTokenId.slice(0, 12)}+NO-${b.noTokenId.slice(0, 12)}`;
      if (!shouldEmit(packageId, packageCost, now)) continue;
      recorded += 1;
      const row = withSoftball({
        ...pmBaseRow(ev, observedAt),
        packageId,
        packageKind: "bin-no-pair",
        binA: { lo: a.binLo, hi: a.binHi, question: a.question },
        binB: { lo: b.binLo, hi: b.binHi, question: b.question },
        packageCost,
        lockedEdge: 1 - packageCost,
        takerFees: 0,
        netLockedEdge: 1 - packageCost,
        impliedMiddle: impliedOutside,
        deadTail: impliedOutside < MIN_IMPLIED_MIDDLE,
        locked: isLocked,
        lockedNet: isLocked,
        availableSize,
        minLegAsk: Math.min(noA.ask, noB.ask),
        sizeOk: availableSize >= MIN_SIZE,
        broad: { tokenId: a.noTokenId, noAsk: noA.ask, noAskSize: noA.askSize },
        narrow: { tokenId: b.noTokenId, noAsk: noB.ask, noAskSize: noB.askSize },
      });
      if (row.softball) softballs += 1;
      emitAudit(row);
    }
  }

  // YES basket across the full ladder (exactly one bin wins → pays $1).
  // Requires EVERY bin of the ladder to still be tradable: once any bin has
  // closed/resolved, the remaining YES basket is no longer a guaranteed $1
  // (observed 2026-07-22: Karachi ladder with 3 leftover 0.1c bins looked
  // like net=0.997 "locked" but the winning bin had already resolved).
  evaluated += 1;
  const estBasket = ev.bins.reduce((sum, bin) => sum + (bin.bestAsk > 0 ? bin.bestAsk : 1), 0);
  if (ev.bins.length === ev.binsTotal && estBasket <= RECORD_MAX_COST + PM_VERIFY_MARGIN) {
    const legs = await Promise.all(ev.bins.map(async (bin) => ({ bin, book: await verifiedAsk(bin.yesTokenId) })));
    if (legs.every(({ book }) => book.ask > 0)) {
      const packageCost = legs.reduce((sum, { book }) => sum + book.ask, 0);
      if (packageCost <= RECORD_MAX_COST) {
        const availableSize = Math.min(...legs.map(({ book }) => book.askSize));
        const isLocked = packageCost < 1;
        if (isLocked) locked += 1;
        if (availableSize >= MIN_SIZE || isLocked) {
          const packageId = `pm::${ev.slug}::YES-BASKET`;
          if (shouldEmit(packageId, packageCost, now)) {
            recorded += 1;
            const row = withSoftball({
              ...pmBaseRow(ev, observedAt),
              packageId,
              packageKind: "yes-basket",
              legs: legs.map(({ bin, book }) => ({
                tokenId: bin.yesTokenId,
                bin: { lo: bin.binLo, hi: bin.binHi },
                yesAsk: book.ask,
                yesAskSize: book.askSize,
              })),
              packageCost,
              lockedEdge: 1 - packageCost,
              takerFees: 0,
              netLockedEdge: 1 - packageCost,
              locked: isLocked,
              lockedNet: isLocked,
              availableSize,
              minLegAsk: Math.min(...legs.map(({ book }) => book.ask)),
              sizeOk: availableSize >= MIN_SIZE,
            });
            if (row.softball) softballs += 1;
            emitAudit(row);
          }
        }
      }
    }
  }
  return { evaluated, recorded, locked, softballs };
}

async function main(): Promise<void> {
  if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_API_PRIVATE_KEY_PATH) {
    throw new Error("Kalshi WS requires KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY_PATH");
  }
  const client = new KalshiClient();
  const books = new KalshiBookStore();
  let ladders: LadderMeta[] = [];
  let socket: WebSocket | null = null;
  let subId = 1;
  let dirty = false;
  let stopping = false;
  let lastLockedLog = 0;

  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${sig}, shutting down`);
    try { socket?.close(); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  function socketOpen(): boolean {
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  async function reconnectAndSubscribe(nextLadders: LadderMeta[]): Promise<void> {
    ladders = nextLadders;
    const tickers = [...new Set(ladders.flatMap((l) => l.tickers))];
    log(`discovered ${ladders.length} ladders / ${tickers.length} markets across ${KALSHI_SERIES.length} series`);
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
      socket = null;
    }
    const nextSocket = client.openSocket();
    socket = nextSocket;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("ws open timeout")), 15_000);
      nextSocket.once("open", () => { clearTimeout(t); resolve(); });
      nextSocket.once("error", (err) => { clearTimeout(t); reject(err); });
    });
    log(`ws connected ${client.wsUrl}`);
    for (const batch of chunk(tickers, SUBSCRIBE_BATCH)) {
      subscribeOrderbook(nextSocket, batch, subId++);
    }
    nextSocket.on("message", (raw) => {
      let msg: KalshiWsMessage;
      try {
        msg = JSON.parse(String(raw)) as KalshiWsMessage;
      } catch {
        return;
      }
      const body = (msg as { msg?: Record<string, unknown> }).msg ?? {};
      const ticker = String(body.market_ticker ?? "");
      if (!ticker) return;
      if (msg.type === "orderbook_snapshot") {
        books.applySnapshot(ticker, body);
        dirty = true;
      } else if (msg.type === "orderbook_delta") {
        books.applyDelta(ticker, body);
        dirty = true;
      }
    });
    nextSocket.on("close", () => {
      if (!stopping) log("ws closed; will rediscover/reconnect");
    });
    nextSocket.on("error", (err) => {
      log(`ws error: ${(err as Error).message}`);
    });
  }

  log(`softball gates: ${softballGateLabel()}`);
  ladders = await discoverLadders(client);
  await reconnectAndSubscribe(ladders);

  if (PM_WEATHER_POLL_MS > 0) {
    void (async () => {
      let pmEvents: PmTempEvent[] = [];
      let lastPmDiscover = 0;
      while (!stopping) {
        try {
          if (Date.now() - lastPmDiscover >= DISCOVER_MS || pmEvents.length === 0) {
            lastPmDiscover = Date.now();
            pmEvents = await discoverPmTempEvents();
            log(`pm-weather: tracking ${pmEvents.length} temperature events`);
          }
          let evaluated = 0;
          let recorded = 0;
          let locked = 0;
          let softballs = 0;
          for (const ev of pmEvents) {
            if (stopping) break;
            try {
              const r = await scanPmTempEvent(ev);
              evaluated += r.evaluated;
              recorded += r.recorded;
              locked += r.locked;
              softballs += r.softballs;
            } catch (err) {
              log(`pm-weather scan ${ev.slug} failed: ${(err as Error).message}`);
            }
          }
          if (softballs > 0) log(`!!! pm-weather SOFTBALLS=${softballs}`);
          if (locked > 0) log(`!!! pm-weather ${locked} locked packages`);
          if (recorded > 0) log(`pm-weather eval events=${pmEvents.length} pairs=${evaluated} recorded=${recorded} LOCKED=${locked} SOFTBALLS=${softballs}`);
        } catch (err) {
          log(`pm-weather cycle failed: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, PM_WEATHER_POLL_MS));
      }
    })();
  }

  let lastDiscover = Date.now();
  while (!stopping) {
    await new Promise((r) => setTimeout(r, REEVAL_MS));
    if (stopping) break;

    if (Date.now() - lastDiscover >= DISCOVER_MS || !socketOpen()) {
      lastDiscover = Date.now();
      try {
        const next = await discoverLadders(client);
        const prev = new Set(ladders.flatMap((l) => l.tickers));
        const now = new Set(next.flatMap((l) => l.tickers));
        const changed = prev.size !== now.size || [...now].some((t) => !prev.has(t));
        if (changed || !socketOpen()) {
          await reconnectAndSubscribe(next);
        }
      } catch (err) {
        log(`rediscover failed: ${(err as Error).message}`);
      }
    }

    if (!dirty) continue;
    dirty = false;
    let evaluated = 0;
    let recorded = 0;
    let locked = 0;
    let softballs = 0;
    for (const ladder of ladders) {
      const r = evaluateLadder(books, ladder);
      evaluated += r.evaluated;
      recorded += r.recorded;
      locked += r.locked;
      softballs += r.softballs;
    }
    if (locked > 0 || softballs > 0 || Date.now() - lastLockedLog > 30_000) {
      lastLockedLog = Date.now();
      log(`eval ladders=${ladders.length} pairs=${evaluated} recorded=${recorded} NET_LOCKED=${locked} SOFTBALLS=${softballs}`);
      if (softballs > 0) log(`!!! ${softballs} kalshi SOFTBALL FIRE(s)`);
      if (locked > 0) log(`!!! ${locked} kalshi packages locked NET of taker fees (ws)`);
    }
  }
}

main().catch((err) => {
  console.error(`[crypto-kalshi-ws] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
