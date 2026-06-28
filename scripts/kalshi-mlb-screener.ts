// Kalshi MLB shadow screener.
//
// Discovery flow (validated 2026-06-28):
//   1. Enumerate /events?series_ticker=KXMLBGAME&status=open to get the
//      canonical list of game stamps (e.g. "26JUN281335WSHBAL").
//   2. For each stamp, direct-fetch the parallel events that carry the actual
//      ladder markets (Kalshi files these under their own series, but listEvents
//      does not surface them; only direct /events/{ticker} works):
//        - KXMLBTOTAL-<stamp>   game total Over X.5 (11 strikes 3.5-13.5)
//        - KXMLBSPREAD-<stamp>  game spread (3 strikes per team)
//        - KXMLBF5SPREAD-<stamp> first-5-innings spread (2 strikes per team)
//        - KXMLBTEAMTOTAL-<stamp> per-team totals (7 strikes per team)
//   3. For each strike market, fetch /markets/{ticker}/orderbook to get real
//      bids/asks (the nested-markets response has yes_bid/yes_ask=undefined).
//   4. Build monotonic-middle candidate pairs on the game-totals ladder.
//   5. Score each candidate against cost buckets and write an audit row.
//
// Output: $DATA_DIR/kalshi-middle-audit.jsonl
//
// Cadence: KALSHI_SCREENER_REFRESH_MS (default 60s). With ~15 games × 11
// strikes × 1 orderbook each ≈ 165 REST calls per cycle; 60s leaves plenty of
// headroom for the public-rate limit (~10rps for read endpoints).
//
// Strategy gates: simplified MLB-only cost-bucket allowlist matching the
// historically positive ROI ranges from analysis/monotonic-chronological-ledger.csv.
// Shadow only — no execution.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  bookQuotes,
  KalshiClient,
  type KalshiEvent,
  type KalshiMarket,
} from "./lib/kalshi-client.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
  ?? process.env.SPORTS_ARB_STATE_DIR
  ?? process.env.POLYMARKET_TRADER_STATE_DIR
  ?? join(process.cwd(), "data"),
);
const AUDIT_PATH = join(DATA_DIR, "kalshi-middle-audit.jsonl");

const GAME_SERIES = process.env.KALSHI_MLB_GAME_SERIES ?? "KXMLBGAME";
const TOTAL_PREFIX = process.env.KALSHI_MLB_TOTAL_PREFIX ?? "KXMLBTOTAL";
const SPREAD_PREFIX = process.env.KALSHI_MLB_SPREAD_PREFIX ?? "KXMLBSPREAD";

const REFRESH_MS = Number(process.env.KALSHI_SCREENER_REFRESH_MS ?? 60_000);
const MAX_WIDTH = Number(process.env.KALSHI_SCREENER_MAX_WIDTH ?? 4);
const ORDERBOOK_CONCURRENCY = Number(process.env.KALSHI_SCREENER_ORDERBOOK_CONCURRENCY ?? 4);

// Cost bucket allowlist mirroring the historical Polymarket MLB live ranges.
const COST_BUCKETS: Array<{ lo: number; hi: number; label: string }> = [
  { lo: 0.99, hi: 1.05, label: "0.99-1.05" },
  { lo: 1.05, hi: 1.10, label: "1.05-1.10" },
  { lo: 1.10, hi: 1.16, label: "1.10-1.16" },
  { lo: 1.16, hi: 1.25, label: "1.16-1.25" },
  { lo: 1.25, hi: 1.50, label: "1.25-1.50" },
];

function bucketLabel(cost: number): string | null {
  for (const b of COST_BUCKETS) if (cost >= b.lo && cost < b.hi) return b.label;
  return null;
}

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function log(msg: string): void {
  console.log(`[kalshi-screener ${new Date().toISOString()}] ${msg}`);
}

function emitAudit(row: Record<string, unknown>): void {
  ensureParent(AUDIT_PATH);
  appendFileSync(AUDIT_PATH, JSON.stringify(row) + "\n");
}

type Quoted = {
  ticker: string;
  strike: number;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  yesAskSize: number;
  noAskSize: number;
};

async function fetchGameStamps(client: KalshiClient): Promise<string[]> {
  const stamps: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const resp = await client.listEvents({
      series_ticker: GAME_SERIES,
      status: "open",
      with_nested_markets: false,
      limit: 200,
      cursor,
    });
    for (const e of resp.events ?? []) {
      const t = e.event_ticker;
      if (!t || !t.startsWith(`${GAME_SERIES}-`)) continue;
      stamps.push(t.slice(GAME_SERIES.length + 1));
    }
    cursor = resp.cursor;
    if (!cursor) break;
  }
  return [...new Set(stamps)];
}

async function fetchTotalEvent(client: KalshiClient, stamp: string): Promise<KalshiEvent | null> {
  return client.getEvent(`${TOTAL_PREFIX}-${stamp}`, true);
}

async function quoteMarket(client: KalshiClient, market: KalshiMarket): Promise<Quoted | null> {
  const strike = typeof market.floor_strike === "number" ? market.floor_strike : null;
  if (strike === null) return null;
  try {
    const book = await client.getOrderbook(market.ticker, 10);
    const q = bookQuotes(book);
    return {
      ticker: market.ticker,
      strike,
      yesBid: q.yesBid,
      yesAsk: q.yesAsk,
      noBid: q.noBid,
      noAsk: q.noAsk,
      yesAskSize: q.yesAskSize,
      noAskSize: q.noAskSize,
    };
  } catch (err: any) {
    return null;
  }
}

async function quoteLadder(client: KalshiClient, markets: KalshiMarket[]): Promise<Quoted[]> {
  // Bounded concurrency for the per-market orderbook fetches.
  const out: Quoted[] = [];
  const queue = [...markets];
  async function worker() {
    while (queue.length > 0) {
      const m = queue.shift();
      if (!m) return;
      const q = await quoteMarket(client, m);
      if (q) out.push(q);
    }
  }
  const workers = Array.from({ length: ORDERBOOK_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  out.sort((a, b) => a.strike - b.strike);
  return out;
}

type GameLadder = {
  stamp: string;
  totalEventTicker: string;
  title: string;
  ladder: Quoted[];
};

async function buildGameLadders(client: KalshiClient, stamps: string[]): Promise<GameLadder[]> {
  const out: GameLadder[] = [];
  const queue = [...stamps];
  async function worker() {
    while (queue.length > 0) {
      const stamp = queue.shift();
      if (!stamp) return;
      const ev = await fetchTotalEvent(client, stamp);
      if (!ev || !(ev.markets ?? []).length) continue;
      const ladder = await quoteLadder(client, ev.markets ?? []);
      if (ladder.length >= 2) {
        out.push({
          stamp,
          totalEventTicker: ev.event_ticker,
          title: ev.title ?? "",
          ladder,
        });
      }
    }
  }
  const workers = Array.from({ length: Math.min(4, stamps.length || 1) }, () => worker());
  await Promise.all(workers);
  return out;
}

function buildAndEmitCandidates(game: GameLadder): { evaluated: number; passed: number } {
  const observedAt = new Date().toISOString();
  let evaluated = 0;
  let passed = 0;
  const strikes = game.ladder;
  for (let i = 0; i < strikes.length; i++) {
    for (let j = i + 1; j < strikes.length; j++) {
      const broad = strikes[i];
      const narrow = strikes[j];
      const width = narrow.strike - broad.strike;
      if (width <= 0 || width > MAX_WIDTH) continue;

      const yesAsk = broad.yesAsk;
      const noAsk = narrow.noAsk;
      if (!(yesAsk > 0) || !(noAsk > 0)) continue;
      const packageCost = yesAsk + noAsk;
      const lockedEdge = 1 - packageCost; // negative = pay-to-play, positive = locked profit
      const availableSize = Math.min(broad.yesAskSize, narrow.noAskSize);
      const bucket = bucketLabel(packageCost);
      evaluated += 1;

      const skip: string[] = [];
      if (!bucket) skip.push(`cost_out_of_allowlist=${packageCost.toFixed(4)}`);
      if (availableSize < 10) skip.push(`size_below_min=${availableSize}`);
      const isPass = skip.length === 0;
      if (isPass) passed += 1;

      emitAudit({
        observedAt,
        venue: "kalshi",
        asset: "MLB",
        marketType: "total",
        eventTicker: game.totalEventTicker,
        eventTitle: game.title,
        stamp: game.stamp,
        packageId: `kalshi::${game.totalEventTicker}::YES-${broad.ticker}+NO-${narrow.ticker}`,
        broadStrike: broad.strike,
        narrowStrike: narrow.strike,
        width,
        packageCost,
        lockedEdge,
        availableSize,
        bucket,
        passed: isPass,
        skipReasons: skip,
        broad: {
          ticker: broad.ticker,
          yesBid: broad.yesBid,
          yesAsk: broad.yesAsk,
          noBid: broad.noBid,
          noAsk: broad.noAsk,
        },
        narrow: {
          ticker: narrow.ticker,
          yesBid: narrow.yesBid,
          yesAsk: narrow.yesAsk,
          noBid: narrow.noBid,
          noAsk: narrow.noAsk,
        },
      });
    }
  }
  return { evaluated, passed };
}

async function runOnce(client: KalshiClient): Promise<void> {
  const stamps = await fetchGameStamps(client);
  log(`found ${stamps.length} open MLB game stamps`);
  if (!stamps.length) return;

  const ladders = await buildGameLadders(client, stamps);
  log(`built ${ladders.length} totals ladders (avg strikes=${ladders.length ? (ladders.reduce((s, g) => s + g.ladder.length, 0) / ladders.length).toFixed(1) : 0})`);

  let evaluated = 0;
  let passed = 0;
  for (const game of ladders) {
    const r = buildAndEmitCandidates(game);
    evaluated += r.evaluated;
    passed += r.passed;
  }
  log(`evaluated ${evaluated} candidate pairs, ${passed} passed cost+size gates`);
}

async function main(): Promise<void> {
  const client = new KalshiClient();
  log(`kalshi-mlb-screener starting (env=${process.env.KALSHI_ENV ?? "production"}, gameSeries=${GAME_SERIES}, totalPrefix=${TOTAL_PREFIX}, refresh=${REFRESH_MS}ms, audit=${AUDIT_PATH})`);

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
  console.error(`[kalshi-screener] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
