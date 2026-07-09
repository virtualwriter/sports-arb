// Crypto monotonic-middle scanner (shadow only, separate deploy package).
//
// Scans BOTH venues for monotonic ladder middles on crypto price markets and
// records every cheap package to an audit stream so mispricings can be
// measured over time. No execution — this is a read-only screener that can
// later back a dedicated crypto deploy.
//
//   Polymarket: monthly "what price will <asset> hit in <month> <year>"
//               ladders (yearly "before-2027"/"in-2026" families are
//               deliberately EXCLUDED — only daily/monthly cadences matter).
//   Kalshi:     daily above/below ladders (KXBTCD, KXETHD) and monthly
//               one-touch max/min ladders (KX<ASSET>MAXMON / MINMON).
//               Read-only public endpoints; no API key required.
//
// A middle = YES on the broad strike + NO on the narrow strike of the same
// ladder. packageCost < 1.00 is a locked-profit arb; rows are recorded up to
// CRYPTO_RECORD_MAX_COST (default 1.05) so near-misses build a time series.
//
// Output: $DATA_DIR/crypto-middle-audit.jsonl
// Run:    npm run crypto:middle-scanner   (deploy/crypto-middle-scanner.service)

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  fetchJson,
  polymarketAssetForSlug,
  scanEvent,
  type ArbCoreConfig,
  type Candidate,
  type GammaEvent,
} from "./lib/monotonic-arb-core.js";
import {
  bookQuotes,
  KalshiClient,
  type KalshiMarket,
} from "./lib/kalshi-client.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
  ?? process.env.SPORTS_ARB_STATE_DIR
  ?? process.env.POLYMARKET_TRADER_STATE_DIR
  ?? join(process.cwd(), "data"),
);
const AUDIT_PATH = join(DATA_DIR, "crypto-middle-audit.jsonl");

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";

const REFRESH_MS = Number(process.env.CRYPTO_SCANNER_REFRESH_MS ?? 120_000);
const RECORD_MAX_COST = Number(process.env.CRYPTO_RECORD_MAX_COST ?? 1.05);
const MIN_SIZE = Number(process.env.CRYPTO_SCANNER_MIN_SIZE ?? 5);
const FETCH_TIMEOUT_MS = Number(process.env.CRYPTO_SCANNER_FETCH_TIMEOUT_MS ?? 10_000);
const PM_DISCOVERY_PAGES = Number(process.env.CRYPTO_PM_DISCOVERY_PAGES ?? 5);
const KALSHI_ORDERBOOK_CONCURRENCY = Number(process.env.CRYPTO_KALSHI_ORDERBOOK_CONCURRENCY ?? 3);

// Crypto assets followed on Polymarket (matched via polymarketAssetForSlug).
const PM_ASSETS = new Set((process.env.CRYPTO_PM_ASSETS ?? "BTC,ETH,SOL,XRP,DOGE,HYPE,BNB")
  .split(",").map((a) => a.trim().toUpperCase()).filter(Boolean));
const PM_TAGS = (process.env.CRYPTO_PM_TAGS ?? "crypto,crypto-prices")
  .split(",").map((t) => t.trim()).filter(Boolean);

// Kalshi ladder series: daily above/below + monthly one-touch max/min.
const KALSHI_SERIES = (process.env.CRYPTO_KALSHI_SERIES
  ?? "KXBTCD,KXETHD,KXBTCMAXMON,KXBTCMINMON,KXETHMAXMON,KXETHMINMON,KXSOLMAXMON,KXSOLMINMON,KXXRPMAXMON,KXXRPMINMON,KXDOGEMAXMON,KXDOGEMINMON")
  .split(",").map((s) => s.trim()).filter(Boolean);

const pmConfig: ArbCoreConfig = {
  host: CLOB_HOST,
  gammaApi: GAMMA_API,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  marketConcurrency: Number(process.env.CRYPTO_PM_MARKET_CONCURRENCY ?? 4),
  eventConcurrency: 2,
  allowedAssets: new Set(["ALL"]),
  minEdge: -1,
  maxSpread: 1,
  minLiquidity: 0,
  minAvailableShares: 1,
};

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function log(msg: string): void {
  console.log(`[crypto-scanner ${new Date().toISOString()}] ${msg}`);
}

function emitAudit(row: Record<string, unknown>): void {
  ensureParent(AUDIT_PATH);
  appendFileSync(AUDIT_PATH, JSON.stringify(row) + "\n");
}

// ---- cadence classification (Polymarket slugs) ----

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const MONTHLY_RE = new RegExp(`-(?:in|during)-(?:${MONTHS})-\\d{4}$`, "i");
const DAILY_RE = new RegExp(`-(?:on-)?(?:${MONTHS})-\\d{1,2}(?:-\\d{4})?$`, "i");
const YEARLY_RE = /(?:before|by|in)-\d{4}$|this-year/i;

export type Cadence = "daily" | "monthly" | "yearly" | "unknown";

export function slugCadence(slug: string): Cadence {
  if (MONTHLY_RE.test(slug)) return "monthly";
  if (DAILY_RE.test(slug)) return "daily";
  if (YEARLY_RE.test(slug)) return "yearly";
  return "unknown";
}

// ---- Polymarket side ----

async function discoverPolymarketLadders(): Promise<string[]> {
  const out = new Set<string>();
  for (const tag of PM_TAGS) {
    for (let page = 0; page < PM_DISCOVERY_PAGES; page++) {
      let events: GammaEvent[];
      try {
        events = await fetchJson(`${GAMMA_API}/events?${new URLSearchParams({
          active: "true",
          closed: "false",
          limit: "100",
          offset: String(page * 100),
          tag_slug: tag,
        })}`, FETCH_TIMEOUT_MS) as GammaEvent[];
      } catch (err) {
        log(`pm discovery tag=${tag} page=${page} failed: ${(err as Error).message}`);
        break;
      }
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        const slug = event.slug ?? "";
        if ((event.markets ?? []).length < 3) continue;
        // Volatility-index ladders mention coin names but aren't price markets.
        if (/volatility|implied/i.test(slug)) continue;
        const asset = polymarketAssetForSlug(slug);
        if (!asset || !PM_ASSETS.has(asset)) continue;
        const cadence = slugCadence(slug);
        if (cadence !== "daily" && cadence !== "monthly") continue;
        out.add(slug);
      }
      if (events.length < 100) break;
    }
  }
  return [...out].sort();
}

function emitPolymarketCandidates(slug: string, candidates: Candidate[]): { evaluated: number; recorded: number; locked: number } {
  const observedAt = new Date().toISOString();
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  for (const c of candidates) {
    evaluated += 1;
    if (!(c.packageCost > 0) || c.packageCost > RECORD_MAX_COST) continue;
    const availableSize = c.availableSize;
    const isLocked = c.packageCost < 1 - 1e-9;
    if (isLocked) locked += 1;
    recorded += 1;
    emitAudit({
      observedAt,
      venue: "polymarket",
      asset: c.asset,
      cadence: slugCadence(slug),
      eventSlug: slug,
      packageId: c.packageId,
      direction: c.direction,
      broadStrike: c.broad.strike,
      narrowStrike: c.narrow.strike,
      packageCost: c.packageCost,
      lockedEdge: 1 - c.packageCost,
      locked: isLocked,
      availableSize,
      sizeOk: availableSize >= MIN_SIZE,
      broad: {
        question: c.broad.question,
        yesAsk: c.broad.yesBook.ask,
        yesAskSize: c.broad.yesBook.askSize,
      },
      narrow: {
        question: c.narrow.question,
        noAsk: c.narrow.noBook.ask,
        noAskSize: c.narrow.noBook.askSize,
      },
    });
  }
  return { evaluated, recorded, locked };
}

async function scanPolymarket(): Promise<{ ladders: number; evaluated: number; recorded: number; locked: number }> {
  const slugs = await discoverPolymarketLadders();
  const foundAt = new Date().toISOString();
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  for (const slug of slugs) {
    try {
      const candidates = await scanEvent(pmConfig, slug, foundAt);
      const r = emitPolymarketCandidates(slug, candidates);
      evaluated += r.evaluated;
      recorded += r.recorded;
      locked += r.locked;
    } catch (err) {
      log(`pm scan ${slug} failed: ${(err as Error).message}`);
    }
  }
  return { ladders: slugs.length, evaluated, recorded, locked };
}

// ---- Kalshi side ----

type KalshiQuoted = {
  ticker: string;
  strike: number;
  yesAsk: number;
  noAsk: number;
  yesAskSize: number;
  noAskSize: number;
};

function kalshiSeriesCadence(series: string): Cadence {
  if (/MON$/i.test(series) || /MAXM$|MINM$/i.test(series)) return "monthly";
  return "daily";
}

function kalshiSeriesAsset(series: string): string {
  const m = series.match(/^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)/i);
  return m ? m[1].toUpperCase() : series;
}

// "greater" strikes (above/below + max one-touch): P(YES) falls as strike
// rises → broad = LOW strike. "less" strikes (min one-touch): P(YES) rises as
// strike rises → broad = HIGH strike.
function kalshiLadderOrientation(markets: KalshiMarket[]): "greater" | "less" {
  return markets.some((m) => m.strike_type === "less") ? "less" : "greater";
}

function kalshiStrike(m: KalshiMarket): number | null {
  if (typeof m.floor_strike === "number") return m.floor_strike;
  if (typeof m.cap_strike === "number") return m.cap_strike;
  return null;
}

async function quoteKalshiLadder(client: KalshiClient, markets: KalshiMarket[]): Promise<KalshiQuoted[]> {
  const out: KalshiQuoted[] = [];
  const queue = markets.filter((m) => kalshiStrike(m) !== null);
  async function worker() {
    while (queue.length > 0) {
      const m = queue.shift();
      if (!m) return;
      try {
        const book = await client.getOrderbook(m.ticker, 5);
        const q = bookQuotes(book);
        if (!(q.yesAsk > 0) && !(q.noAsk > 0)) continue;
        out.push({
          ticker: m.ticker,
          strike: kalshiStrike(m)!,
          yesAsk: q.yesAsk,
          noAsk: q.noAsk,
          yesAskSize: q.yesAskSize,
          noAskSize: q.noAskSize,
        });
      } catch {
        // skip unquotable strikes
      }
    }
  }
  await Promise.all(Array.from({ length: KALSHI_ORDERBOOK_CONCURRENCY }, () => worker()));
  out.sort((a, b) => a.strike - b.strike);
  return out;
}

function emitKalshiPairs(
  series: string,
  eventTicker: string,
  title: string,
  orientation: "greater" | "less",
  ladder: KalshiQuoted[],
): { evaluated: number; recorded: number; locked: number } {
  const observedAt = new Date().toISOString();
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  for (let i = 0; i < ladder.length; i++) {
    for (let j = i + 1; j < ladder.length; j++) {
      const broad = orientation === "less" ? ladder[j] : ladder[i];
      const narrow = orientation === "less" ? ladder[i] : ladder[j];
      if (!(broad.yesAsk > 0) || !(narrow.noAsk > 0)) continue;
      evaluated += 1;
      const packageCost = broad.yesAsk + narrow.noAsk;
      if (!(packageCost > 0) || packageCost > RECORD_MAX_COST) continue;
      const availableSize = Math.min(broad.yesAskSize, narrow.noAskSize);
      const isLocked = packageCost < 1 - 1e-9;
      if (isLocked) locked += 1;
      recorded += 1;
      emitAudit({
        observedAt,
        venue: "kalshi",
        asset: kalshiSeriesAsset(series),
        cadence: kalshiSeriesCadence(series),
        series,
        eventTicker,
        eventTitle: title,
        packageId: `kalshi::${eventTicker}::YES-${broad.ticker}+NO-${narrow.ticker}`,
        orientation,
        broadStrike: broad.strike,
        narrowStrike: narrow.strike,
        packageCost,
        lockedEdge: 1 - packageCost,
        locked: isLocked,
        availableSize,
        sizeOk: availableSize >= MIN_SIZE,
        broad: { ticker: broad.ticker, yesAsk: broad.yesAsk, yesAskSize: broad.yesAskSize },
        narrow: { ticker: narrow.ticker, noAsk: narrow.noAsk, noAskSize: narrow.noAskSize },
      });
    }
  }
  return { evaluated, recorded, locked };
}

async function scanKalshi(client: KalshiClient): Promise<{ ladders: number; evaluated: number; recorded: number; locked: number }> {
  let ladders = 0;
  let evaluated = 0;
  let recorded = 0;
  let locked = 0;
  for (const series of KALSHI_SERIES) {
    try {
      const resp = await client.listEvents({
        series_ticker: series,
        status: "open",
        with_nested_markets: true,
        limit: 20,
      });
      for (const ev of resp.events ?? []) {
        const markets = ev.markets ?? [];
        if (markets.length < 2) continue;
        const ladder = await quoteKalshiLadder(client, markets);
        if (ladder.length < 2) continue;
        ladders += 1;
        const r = emitKalshiPairs(series, ev.event_ticker, ev.title ?? "", kalshiLadderOrientation(markets), ladder);
        evaluated += r.evaluated;
        recorded += r.recorded;
        locked += r.locked;
      }
    } catch (err) {
      log(`kalshi ${series} scan failed: ${(err as Error).message}`);
    }
  }
  return { ladders, evaluated, recorded, locked };
}

// ---- main loop ----

async function runOnce(client: KalshiClient): Promise<void> {
  const [pm, ks] = await Promise.all([scanPolymarket(), scanKalshi(client)]);
  log(`polymarket: ${pm.ladders} ladders, ${pm.evaluated} pairs, ${pm.recorded} recorded (<=${RECORD_MAX_COST}), ${pm.locked} LOCKED(<1)`);
  log(`kalshi: ${ks.ladders} ladders, ${ks.evaluated} pairs, ${ks.recorded} recorded (<=${RECORD_MAX_COST}), ${ks.locked} LOCKED(<1)`);
  if (pm.locked + ks.locked > 0) log(`!!! ${pm.locked + ks.locked} locked-profit middles observed this cycle`);
}

async function main(): Promise<void> {
  const client = new KalshiClient({ unauthenticated: !process.env.KALSHI_API_KEY_ID });
  log(`crypto-middle-scanner starting (refresh=${REFRESH_MS}ms, recordMaxCost=${RECORD_MAX_COST}, pmAssets=${[...PM_ASSETS].join("/")}, kalshiSeries=${KALSHI_SERIES.length}, audit=${AUDIT_PATH})`);

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${sig}, shutting down`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    const startMs = Date.now();
    try {
      await runOnce(client);
    } catch (err) {
      log(`refresh failed: ${(err as Error).message}`);
    }
    const elapsed = Date.now() - startMs;
    const wait = Math.max(1_000, REFRESH_MS - elapsed);
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((err) => {
  console.error(`[crypto-scanner] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
