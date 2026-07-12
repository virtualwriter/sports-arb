// Strat 2 (state-priced middles) live gate for MLB game totals.
//
// Validated in shadow (analysis/strat2-state-score.md): calibrated Poisson
// middle probabilities (lambdaScale fitted at 1.8), an edge margin over fair
// value, and exclusion of terminal game states produced +10-14% ROI across
// a few hundred resolved packages. This module ports that exact selection
// logic so the daemon can take those entries live, in-play, with its own
// (small) sizing caps.
//
// Fail-closed by design: no feed binding, stale feed, non-live game, terminal
// state, or insufficient model edge all reject. Enabled only when
// ARB_DAEMON_STRAT2_MLB_LIVE=1.
import type { Candidate } from "./monotonic-arb-core.js";
import { evaluateSportsStrategy } from "./sports-strategy.js";
import {
  type EventMapFile,
  type FeedSnapshot,
  ensureBinding,
  loadEventMap,
  pollMlbFeed,
  saveEventMap,
} from "./state-feed-map.js";
import { PATHS } from "./paths.js";

export const STRAT2_MLB_LIVE = process.env.ARB_DAEMON_STRAT2_MLB_LIVE === "1";
// Frozen calibration from fit_strat2_calibration.py (Jul 12 fit on 36 games /
// ~29k observations). Re-fit periodically and update deliberately; do not
// auto-read the nightly analysis file so live behavior only changes on purpose.
const LAMBDA_SCALE = Number(process.env.ARB_DAEMON_STRAT2_LAMBDA_SCALE ?? 1.8);
// Required model edge over fair value (fair = 1 + pMiddle). Shadow ROI was
// +10.5%/+11.8%/+13.7% at margins 0.05/0.08/0.12; 0.08 balances volume vs edge.
const EDGE_MARGIN = Number(process.env.ARB_DAEMON_STRAT2_EDGE_MARGIN ?? 0.08);
const FEED_MAX_AGE_MS = Number(process.env.ARB_DAEMON_STRAT2_FEED_MAX_AGE_MS ?? 45_000);
export const STRAT2_MAX_PACKAGE_USD = Number(process.env.ARB_DAEMON_STRAT2_MAX_PACKAGE_USD ?? 10);
export const STRAT2_MAX_DAILY_USD = Number(process.env.ARB_DAEMON_STRAT2_MAX_DAILY_USD ?? 50);
// Mirrors the shadow scorer's dust filters (DUST_YES=0.02 / DUST_NO=0.98).
const DUST_YES_ASK = 0.02;
const DUST_NO_ASK = 0.98;
const MAX_PACKAGE_COST = Number(process.env.ARB_DAEMON_STRAT2_MAX_COST ?? 1.55);

const MLB_RUNS_PER_INNING = 0.48;

export function poissonPmf(k: number, lam: number): number {
  if (lam < 0) return 0;
  if (lam === 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lam);
  if (k === 0) return p;
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}

/** P(final total in (lo, hi]) where final = current + X, X ~ Poisson(lam). */
export function poissonPInBand(current: number, lo: number, hi: number, lam: number, maxExtra = 20): number {
  let lowX = Math.floor(lo - current) + 1;
  const highX = Math.floor(hi - current);
  if (highX < 0) return 0;
  lowX = Math.max(0, lowX);
  let total = 0;
  for (let x = lowX; x <= Math.min(highX, maxExtra); x++) total += poissonPmf(x, lam);
  return Math.max(0, Math.min(1, total));
}

/** Port of score_strat2_state.parse_mlb_innings_left (expected scoring innings remaining). */
export function parseMlbInningsLeft(feed: Pick<FeedSnapshot, "period" | "status" | "outs" | "scoreHome" | "scoreAway" | "live">): number | null {
  const period = String(feed.period ?? "");
  const status = String(feed.status ?? "").toLowerCase();
  if (status.includes("final")) return 0;
  const m = period.match(/(\d{1,2})/);
  if (!m) return feed.live ? 4.5 : null;
  const inning = Number(m[1]);
  const half = period.toLowerCase();
  const outs = Number.isFinite(Number(feed.outs)) && feed.outs !== null ? Number(feed.outs) : null;
  const home = Number.isFinite(Number(feed.scoreHome)) && feed.scoreHome !== null ? Number(feed.scoreHome) : null;
  const away = Number.isFinite(Number(feed.scoreAway)) && feed.scoreAway !== null ? Number(feed.scoreAway) : null;

  const halfFrac = outs === null ? 1 : Math.max(0, (3 - Math.min(outs, 3)) / 3);
  const isTop = half.includes("top");
  const isBottom = half.includes("bottom");

  if (inning >= 9) {
    if (isBottom && home !== null && away !== null) {
      if (home > away) return 0; // walk-off state
      if (home === away) return halfFrac / 2 + 0.75; // tied bottom 9th+: rest of half + expected extras
      return halfFrac / 2; // home trailing: this half ends the game unless they tie
    }
    if (isTop) {
      let base = halfFrac / 2 + 0.5;
      if (home !== null && away !== null && home === away) base += 0.75;
      return base;
    }
    return halfFrac / 2;
  }

  let remainingHalves = halfFrac + (isTop ? 1 : 0) + 2 * Math.max(0, 9 - inning);
  if (!isTop && !isBottom) remainingHalves = halfFrac + 0.5 + 2 * Math.max(0, 9 - inning);
  return remainingHalves / 2;
}

export type Strat2State = {
  currentTotal: number;
  inningsLeft: number;
  lambda: number;
  pMiddle: number;
  fair: number;
};

/** Port of score_strat2_state.is_terminalish: the model's residual weaknesses
 * (walk-offs, extras) concentrate in end-of-game states, which scored -6 to -8%
 * ROI in shadow; they are excluded from live trading. */
export function isTerminalState(inningsLeft: number, currentTotal: number, lo: number, hi: number): boolean {
  if (inningsLeft <= 1.5) return true;
  if (lo < currentTotal && currentTotal <= hi && inningsLeft <= 3) return true;
  return false;
}

export function computeStrat2State(
  feed: Pick<FeedSnapshot, "period" | "status" | "outs" | "scoreHome" | "scoreAway" | "live">,
  lo: number,
  hi: number,
): Strat2State | null {
  if (feed.scoreHome === null || feed.scoreAway === null) return null;
  const currentTotal = Number(feed.scoreHome) + Number(feed.scoreAway);
  if (!Number.isFinite(currentTotal)) return null;
  const inningsLeft = parseMlbInningsLeft(feed);
  if (inningsLeft === null) return null;
  const lambda = MLB_RUNS_PER_INNING * inningsLeft * LAMBDA_SCALE;
  const pMiddle = poissonPInBand(currentTotal, lo, hi, lambda);
  return { currentTotal, inningsLeft, lambda, pMiddle, fair: 1 + pMiddle };
}

type CachedFeed = { feed: FeedSnapshot; fetchedAt: number };
const feedCache = new Map<string, CachedFeed>();

export function strat2FeedFor(eventSlug: string): FeedSnapshot | null {
  const cached = feedCache.get(eventSlug);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > FEED_MAX_AGE_MS) return null;
  return cached.feed;
}

export function setStrat2FeedForTests(eventSlug: string, feed: FeedSnapshot): void {
  feedCache.set(eventSlug, { feed, fetchedAt: Date.now() });
}

export type Strat2Approval = {
  ok: boolean;
  reason: string;
  state?: Strat2State;
};

/**
 * Decide whether a live in-play MLB game-total package qualifies for a Strat 2
 * entry. Cheap early-outs keep this safe to call from hot gate paths: it does
 * nothing unless the flag is on, the asset is MLB, and a fresh live feed exists.
 */
export function strat2MlbApproval(candidate: Candidate): Strat2Approval | null {
  if (!STRAT2_MLB_LIVE) return null;
  if (candidate.asset !== "MLB") return null;
  const feed = strat2FeedFor(candidate.eventSlug);
  if (!feed) return { ok: false, reason: "strat2_no_fresh_feed" };
  if (!feed.live) return { ok: false, reason: "strat2_game_not_live" };
  const marketType = evaluateSportsStrategy(candidate).marketType;
  if (marketType !== "game_total") return { ok: false, reason: `strat2_market_type_${marketType}` };
  const lo = candidate.broad.strike;
  const hi = candidate.narrow.strike;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { ok: false, reason: "strat2_bad_strikes" };
  }
  if (candidate.broad.yesBook.ask <= DUST_YES_ASK || candidate.narrow.noBook.ask >= DUST_NO_ASK) {
    return { ok: false, reason: "strat2_dust_leg" };
  }
  if (candidate.packageCost >= MAX_PACKAGE_COST) {
    return { ok: false, reason: `strat2_cost_above_max cost=${candidate.packageCost.toFixed(4)}` };
  }
  const state = computeStrat2State(feed, lo, hi);
  if (!state) return { ok: false, reason: "strat2_no_game_state" };
  if (isTerminalState(state.inningsLeft, state.currentTotal, lo, hi)) {
    return { ok: false, reason: `strat2_terminal_state inningsLeft=${state.inningsLeft.toFixed(2)}`, state };
  }
  const edge = state.fair - candidate.packageCost;
  if (edge < EDGE_MARGIN) {
    return {
      ok: false,
      reason: `strat2_insufficient_edge p=${state.pMiddle.toFixed(3)} fair=${state.fair.toFixed(4)} cost=${candidate.packageCost.toFixed(4)} edge=${edge.toFixed(4)} need=${EDGE_MARGIN.toFixed(2)}`,
      state,
    };
  }
  return {
    ok: true,
    reason: `strat2_state_edge p=${state.pMiddle.toFixed(3)} fair=${state.fair.toFixed(4)} cost=${candidate.packageCost.toFixed(4)} edge=${edge.toFixed(4)} inningsLeft=${state.inningsLeft.toFixed(2)}`,
    state,
  };
}

// ---------------------------------------------------------------------------
// Feed polling. The daemon calls refreshStrat2Feeds() on an interval with the
// MLB events currently on its watchlist; bindings are shared with the shadow
// logger via the same event-map file.
// ---------------------------------------------------------------------------

export type Strat2WatchEvent = { slug: string; title: string; startMs: number | null };

const finalSlugs = new Set<string>();
let eventMap: EventMapFile | null = null;
const MAP_PATH = process.env.STATE_FEED_MAP_PATH ?? PATHS.stateFeedEventMap;
// Start polling shortly before first pitch so the gate has state at go-live.
const POLL_LEAD_MS = Number(process.env.ARB_DAEMON_STRAT2_POLL_LEAD_MS ?? 10 * 60 * 1000);

export async function refreshStrat2Feeds(
  events: Strat2WatchEvent[],
  log: (...args: unknown[]) => void,
): Promise<void> {
  if (!STRAT2_MLB_LIVE) return;
  const now = Date.now();
  const due = events.filter((e) =>
    e.slug.startsWith("mlb-")
    && !finalSlugs.has(e.slug)
    && (e.startMs === null || now >= e.startMs - POLL_LEAD_MS),
  );
  if (!due.length) return;
  if (!eventMap) eventMap = loadEventMap(MAP_PATH);
  let mapDirty = false;
  for (const event of due) {
    try {
      const hadBinding = Boolean(eventMap.bindings[event.slug]?.feedId);
      const binding = await ensureBinding(eventMap, event.slug, "MLB", event.title);
      if (!binding) continue;
      if (!hadBinding) mapDirty = true;
      const feed = await pollMlbFeed(binding.feedId);
      feedCache.set(event.slug, { feed, fetchedAt: Date.now() });
      if (String(feed.status ?? "").toLowerCase().includes("final")) {
        finalSlugs.add(event.slug);
      }
    } catch (err: any) {
      log(`strat2 feed poll failed ${event.slug}: ${err?.message ?? String(err)}`);
    }
  }
  if (mapDirty) {
    try {
      saveEventMap(MAP_PATH, eventMap);
    } catch (err: any) {
      log(`strat2 event map save failed: ${err?.message ?? String(err)}`);
    }
  }
}
