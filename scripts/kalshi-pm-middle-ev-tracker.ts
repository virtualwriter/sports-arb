/**
 * Cross-venue MLB middle EV tracker — Kalshi vs Polymarket vs PA-chain fair.
 *
 * For each tracked game, polls:
 *   - StatsAPI game state (score/outs/bases) -> PA-chain fair per band
 *   - Kalshi total-rung orderbooks (public REST)
 *   - Polymarket CLOB books for the published total rungs
 * Computes middle package cost (YES lo ask + NO hi ask) per venue per band and
 * logs edge = fair - cost. Tightens the poll cadence for 90s after any score
 * change so the before/during/after window is captured on both venues.
 *
 * Alerts (stdout `EV_POS`) whenever any venue's executable middle has edge > 0.
 *
 * Usage:
 *   npx tsx scripts/kalshi-pm-middle-ev-tracker.ts
 * Env:
 *   EV_TRACKER_OUT   output JSONL (default data/kalshi-pm-middle-ev-<date>.jsonl)
 *   EV_TRACKER_GAMES JSON array [{name, gamePk, kalshiEvent, pmSlug}] (defaults to Jul 17 slate)
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { computeMlbBandState } from "./lib/mlb-pa-chain.js";
import { DUST_NO_ASK, DUST_YES_ASK } from "./lib/mlb-middle-arb-filters.js";
import { pollMlbFeed, type FeedSnapshot } from "./lib/state-feed-map.js";
import { REPO_ROOT } from "./lib/paths.js";

type GameCfg = { name: string; gamePk: string; kalshiEvent: string; pmSlug: string };

const DEFAULT_GAMES: GameCfg[] = [
  { name: "LAD@NYY", gamePk: "823524", kalshiEvent: "KXMLBTOTAL-26JUL171905LADNYY", pmSlug: "mlb-lad-nyy-2026-07-17" },
  { name: "TB@BOS G2", gamePk: "824737", kalshiEvent: "KXMLBTOTAL-26JUL171910TBBOSG2", pmSlug: "mlb-tb-bos-2026-07-17" },
  { name: "TEX@ATL", gamePk: "824901", kalshiEvent: "KXMLBTOTAL-26JUL171915TEXATL", pmSlug: "mlb-tex-atl-2026-07-17" },
  { name: "CWS@TOR", gamePk: "822789", kalshiEvent: "KXMLBTOTAL-26JUL171915CWSTOR", pmSlug: "mlb-cws-tor-2026-07-17" },
  { name: "MIA@MIL", gamePk: "823766", kalshiEvent: "KXMLBTOTAL-26JUL171940MIAMIL", pmSlug: "mlb-mia-mil-2026-07-17" },
  { name: "MIN@CHC", gamePk: "824655", kalshiEvent: "KXMLBTOTAL-26JUL172005MINCHC", pmSlug: "mlb-min-chc-2026-07-17" },
  { name: "SD@KC", gamePk: "824090", kalshiEvent: "KXMLBTOTAL-26JUL172010SDKC", pmSlug: "mlb-sd-kc-2026-07-17" },
  { name: "BAL@HOU", gamePk: "824170", kalshiEvent: "KXMLBTOTAL-26JUL172010BALHOU", pmSlug: "mlb-bal-hou-2026-07-17" },
  { name: "CIN@COL", gamePk: "824332", kalshiEvent: "KXMLBTOTAL-26JUL172040CINCOL", pmSlug: "mlb-cin-col-2026-07-17" },
  { name: "DET@LAA", gamePk: "824009", kalshiEvent: "KXMLBTOTAL-26JUL172138DETLAA", pmSlug: "mlb-det-laa-2026-07-17" },
  { name: "WSH@ATH", gamePk: "824981", kalshiEvent: "KXMLBTOTAL-26JUL172140WSHATH", pmSlug: "mlb-wsh-oak-2026-07-17" },
  { name: "STL@ARI", gamePk: "825060", kalshiEvent: "KXMLBTOTAL-26JUL172140STLAZ", pmSlug: "mlb-stl-ari-2026-07-17" },
  { name: "SF@SEA", gamePk: "823115", kalshiEvent: "KXMLBTOTAL-26JUL172210SFSEA", pmSlug: "mlb-sf-sea-2026-07-17" },
];

const GAMES: GameCfg[] = process.env.EV_TRACKER_GAMES
  ? (JSON.parse(process.env.EV_TRACKER_GAMES) as GameCfg[])
  : DEFAULT_GAMES;

const OUT = process.env.EV_TRACKER_OUT
  ?? join(REPO_ROOT, "data", `kalshi-pm-middle-ev-${new Date().toISOString().slice(0, 10)}.jsonl`);

const BASE_POLL_MS = 5_000;
const HOT_POLL_MS = 1_000;
const HOT_WINDOW_MS = 90_000;
/** Max band width (hi - lo) when building bands from the published rungs. */
const MAX_BAND_WIDTH = Number(process.env.EV_TRACKER_MAX_BAND_WIDTH ?? 5);

/** All (lo, hi) pairs over the union of both venues' rung lines, width-capped.
 * Fair is memoized per game state, so pricing every pair is one MC run. */
function buildBands(lines: number[]): Array<[number, number]> {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j] - sorted[i] > MAX_BAND_WIDTH) break;
      out.push([sorted[i], sorted[j]]);
    }
  }
  return out;
}

const UA = { "User-Agent": "sports-arb-ev-tracker" };

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function emit(row: Record<string, unknown>): void {
  appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), ...row })}\n`);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---------- Kalshi ----------

type VenueQuote = { yesAsk: number; yesAskSz: number; noAsk: number; noAskSz: number };

async function kalshiRungs(eventTicker: string): Promise<Map<number, string>> {
  const d = (await getJson(
    `https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${eventTicker}&limit=50`,
  )) as { markets?: Array<{ ticker: string; status?: string; floor_strike?: number }> };
  const out = new Map<number, string>();
  for (const m of d.markets ?? []) {
    if (m.status === "active" && m.floor_strike != null) out.set(m.floor_strike, m.ticker);
  }
  return out;
}

async function kalshiQuote(ticker: string): Promise<VenueQuote | null> {
  const d = (await getJson(
    `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}/orderbook?depth=1`,
  )) as { orderbook_fp?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> } };
  const ob = d.orderbook_fp;
  if (!ob) return null;
  const best = (lv: Array<[string, string]> | undefined): [number, number] | null => {
    if (!lv?.length) return null;
    let bp = -1;
    let bs = 0;
    for (const [p, s] of lv) {
      const pn = Number(p);
      if (pn > bp) { bp = pn; bs = Number(s); }
    }
    return bp >= 0 ? [bp, bs] : null;
  };
  const yesBid = best(ob.yes_dollars);
  const noBid = best(ob.no_dollars);
  if (!yesBid || !noBid) return null;
  return {
    yesAsk: Number((1 - noBid[0]).toFixed(2)),
    yesAskSz: noBid[1],
    noAsk: Number((1 - yesBid[0]).toFixed(2)),
    noAskSz: yesBid[1],
  };
}

// ---------- Polymarket ----------

type PmRung = { line: number; overToken: string; underToken: string };

async function pmRungs(slug: string): Promise<PmRung[]> {
  const evs = (await getJson(`https://gamma-api.polymarket.com/events?slug=${slug}`)) as Array<{
    markets?: Array<{ sportsMarketType?: string; active?: boolean; closed?: boolean; line?: number; clobTokenIds?: string }>;
  }>;
  const out: PmRung[] = [];
  for (const m of evs[0]?.markets ?? []) {
    if (m.sportsMarketType !== "totals" || !m.active || m.closed || m.line == null || !m.clobTokenIds) continue;
    const toks = JSON.parse(m.clobTokenIds) as string[];
    if (toks.length >= 2) out.push({ line: m.line, overToken: toks[0], underToken: toks[1] });
  }
  return out;
}

async function pmQuote(rung: PmRung): Promise<VenueQuote | null> {
  const book = (await getJson(`https://clob.polymarket.com/book?token_id=${rung.overToken}`)) as {
    asks?: Array<{ price: string; size: string }>;
    bids?: Array<{ price: string; size: string }>;
  };
  const asks = (book.asks ?? []).map((l) => [Number(l.price), Number(l.size)] as const);
  const bids = (book.bids ?? []).map((l) => [Number(l.price), Number(l.size)] as const);
  if (!asks.length || !bids.length) return null;
  const bestAsk = asks.reduce((a, b) => (b[0] < a[0] ? b : a));
  const bestBid = bids.reduce((a, b) => (b[0] > a[0] ? b : a));
  return {
    yesAsk: bestAsk[0],
    yesAskSz: bestAsk[1],
    noAsk: Number((1 - bestBid[0]).toFixed(2)),
    noAskSz: bestBid[1],
  };
}

// ---------- main loop ----------

type GameState = {
  cfg: GameCfg;
  kalshi: Map<number, string>;
  pm: PmRung[];
  bands: Array<[number, number]>;
  lastScoreKey: string | null;
  hotUntil: number;
  done: boolean;
};

function middleCost(loQ: VenueQuote | undefined, hiQ: VenueQuote | undefined): {
  cost: number;
  size: number;
  yesAskLo: number;
  yesAskLoSz: number;
  noAskHi: number;
  noAskHiSz: number;
  dust: boolean;
} | null {
  if (!loQ || !hiQ) return null;
  return {
    cost: Number((loQ.yesAsk + hiQ.noAsk).toFixed(2)),
    size: Math.min(loQ.yesAskSz, hiQ.noAskSz),
    yesAskLo: loQ.yesAsk,
    yesAskLoSz: loQ.yesAskSz,
    noAskHi: hiQ.noAsk,
    noAskHiSz: hiQ.noAskSz,
    dust: loQ.yesAsk <= DUST_YES_ASK || hiQ.noAsk >= DUST_NO_ASK,
  };
}

async function pollGame(g: GameState): Promise<void> {
  let feed: FeedSnapshot;
  try {
    feed = await pollMlbFeed(g.cfg.gamePk);
  } catch (err) {
    log(`FEED_ERR ${g.cfg.name} ${String(err)}`);
    return;
  }
  if (feed.status && /final|game over/i.test(feed.status)) {
    g.done = true;
    log(`GAME_FINAL ${g.cfg.name} ${feed.scoreAway}-${feed.scoreHome}`);
    return;
  }
  const scoreKey = `${feed.scoreAway}-${feed.scoreHome}`;
  if (g.lastScoreKey !== null && scoreKey !== g.lastScoreKey) {
    g.hotUntil = Date.now() + HOT_WINDOW_MS;
    log(`SCORE ${g.cfg.name} ${g.lastScoreKey} -> ${scoreKey} (${feed.period}) — hot window`);
    emit({ kind: "score", game: g.cfg.name, prev: g.lastScoreKey, cur: scoreKey, period: feed.period });
  }
  g.lastScoreKey = scoreKey;

  const kQuotes = new Map<number, VenueQuote>();
  await Promise.all(
    [...g.kalshi.entries()].map(async ([line, ticker]) => {
      try {
        const q = await kalshiQuote(ticker);
        if (q) kQuotes.set(line, q);
      } catch { /* transient */ }
    }),
  );
  const pQuotes = new Map<number, VenueQuote>();
  await Promise.all(
    g.pm.map(async (r) => {
      try {
        const q = await pmQuote(r);
        if (q) pQuotes.set(r.line, q);
      } catch { /* transient */ }
    }),
  );

  const rows: Array<Record<string, unknown>> = [];
  for (const [lo, hi] of g.bands) {
    const state = computeMlbBandState(feed, lo, hi);
    if (!state) continue;
    const fair = state.fair;
    for (const [venue, q] of [["kalshi", middleCost(kQuotes.get(lo), kQuotes.get(hi))],
                              ["pm", middleCost(pQuotes.get(lo), pQuotes.get(hi))]] as const) {
      if (!q) continue;
      const edge = Number((fair - q.cost).toFixed(4));
      rows.push({
        band: `${lo}-${hi}`, venue, cost: q.cost, size: Number(q.size.toFixed(0)),
        fair: Number(fair.toFixed(4)), edge,
        yesAskLo: q.yesAskLo, yesAskLoSz: Number(q.yesAskLoSz.toFixed(1)),
        noAskHi: q.noAskHi, noAskHiSz: Number(q.noAskHiSz.toFixed(1)),
        dust: q.dust,
      });
      if (edge > 0 && q.size >= 1) {
        log(
          `EV_POS ${g.cfg.name} ${venue} ${lo}-${hi} cost=${q.cost} fair=${fair.toFixed(3)} `
          + `edge=+${(edge * 100).toFixed(1)}c size=$${q.size.toFixed(0)}${q.dust ? " DUST" : ""} `
          + `score=${scoreKey} ${feed.period} outs=${feed.outs} model=${state.model}`,
        );
      }
    }
  }
  emit({
    kind: "snap",
    game: g.cfg.name,
    score: scoreKey,
    period: feed.period,
    outs: feed.outs,
    runnersOn: feed.runnersOn,
    hot: Date.now() < g.hotUntil,
    rows,
  });
}

async function main(): Promise<void> {
  const games: GameState[] = [];
  for (const cfg of GAMES) {
    const [kalshi, pm] = await Promise.all([
      kalshiRungs(cfg.kalshiEvent).catch(() => new Map<number, string>()),
      pmRungs(cfg.pmSlug).catch(() => [] as PmRung[]),
    ]);
    const bands = buildBands([...kalshi.keys(), ...pm.map((r) => r.line)]);
    games.push({ cfg, kalshi, pm, bands, lastScoreKey: null, hotUntil: 0, done: false });
    log(
      `init ${cfg.name}: kalshi_rungs=[${[...kalshi.keys()].sort((a, b) => a - b).join(",")}] `
      + `pm_rungs=[${pm.map((r) => r.line).sort((a, b) => a - b).join(",")}] `
      + `bands=${bands.length} (width<=${MAX_BAND_WIDTH})`,
    );
  }
  log(`tracking ${games.length} games -> ${OUT}`);

  const loops = games.map(async (g) => {
    while (!g.done) {
      const started = Date.now();
      await pollGame(g).catch((err) => log(`POLL_ERR ${g.cfg.name} ${String(err)}`));
      const interval = Date.now() < g.hotUntil ? HOT_POLL_MS : BASE_POLL_MS;
      const wait = Math.max(200, interval - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
  });
  await Promise.all(loops);
  log("all games final — exiting");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
