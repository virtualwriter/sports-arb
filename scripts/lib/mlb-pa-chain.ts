/**
 * PA-chain fair model for MLB middle bands.
 *
 * Replaces the flat Strat2 Poisson (λ = 0.48 × inningsLeft × 1.8) with a
 * Monte Carlo over an empirical plate-appearance transition kernel
 * (outs, bases) → (rbi, outs', bases') trained on 2024 and validated on 2025
 * hold-out (analysis/per-plate-rbi-p-apples-to-apples.md — better Brier and
 * log-loss than the Poisson on all 7 tested bands).
 *
 * Unlike the Poisson, the chain conditions on outs + baserunners and models
 * the discrete half-inning / walk-off structure, which fixes the late-game
 * fair inflation observed live (Strat2 P(exactly 1 more run)=0.36 vs
 * bwin devig 0.21 in bot-8; the chain says 0.22).
 *
 * The simulated (extraAway, extraHome) distribution is memoized per game
 * state, so pricing every band of a ladder costs one MC run (~1–3ms).
 */

import { readFileSync } from "node:fs";
import { PATHS } from "./paths.js";
import {
  computeStrat2SpreadState,
  computeStrat2State,
  parseMlbInningsLeft,
  type Strat2State,
} from "./strat2-mlb-live-gate.js";
import type { FeedSnapshot } from "./state-feed-map.js";

export const MLB_PA_CHAIN_VERSION = "2026-07-16.1";

const SIMS = Math.max(500, Number(process.env.PLR_MLB_PA_CHAIN_SIMS ?? 4000));
const MAX_EXTRA_INNINGS = 12;
const MEMO_MAX = 128;

type Transition = { rbi: number; outsAfter: number; basesAfter: string; cum: number };

export type PaChainTable = {
  path: string;
  generatedAt: string | null;
  trainYear: number | null;
  plateAppearances: number;
  cells: Map<string, { transitions: Transition[]; total: number }>;
};

let cachedTable: PaChainTable | null | undefined;

export function loadPaChainTable(path: string = defaultPaChainPath()): PaChainTable | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      meta?: { generatedAt?: string; trainYear?: number; plateAppearances?: number };
      transitions?: Record<string, Array<[number, number, string, number]>>;
    };
    const cells = new Map<string, { transitions: Transition[]; total: number }>();
    for (const [key, rows] of Object.entries(raw.transitions ?? {})) {
      let cum = 0;
      const transitions: Transition[] = [];
      for (const [rbi, outsAfter, basesAfter, count] of rows) {
        cum += count;
        transitions.push({ rbi, outsAfter, basesAfter, cum });
      }
      if (cum > 0) cells.set(key, { transitions, total: cum });
    }
    if (!cells.size) return null;
    return {
      path,
      generatedAt: raw.meta?.generatedAt ?? null,
      trainYear: raw.meta?.trainYear ?? null,
      plateAppearances: raw.meta?.plateAppearances ?? 0,
      cells,
    };
  } catch {
    return null;
  }
}

export function defaultPaChainPath(): string {
  return process.env.PLR_MLB_PA_CHAIN_PATH ?? PATHS.mlbPaChainTransitions;
}

/** Process-wide table, loaded lazily once (null = missing/unreadable). */
export function paChainTable(): PaChainTable | null {
  if (cachedTable === undefined) cachedTable = loadPaChainTable();
  return cachedTable;
}

export function setPaChainTableForTests(table: PaChainTable | null | undefined): void {
  cachedTable = table;
}

// ---------------------------------------------------------------------------
// Game-state parsing
// ---------------------------------------------------------------------------

export type PaChainGameState = {
  inning: number;
  half: "top" | "bottom";
  outs: number;
  bases: string;
  scoreAway: number;
  scoreHome: number;
};

export function basesKey(onFirst?: boolean | null, onSecond?: boolean | null, onThird?: boolean | null): string {
  return `${onFirst ? "1" : "-"}${onSecond ? "2" : "-"}${onThird ? "3" : "-"}`;
}

/**
 * Feed → simulation start state. Returns null when the period string does not
 * pin down inning+half (e.g. bwin "8th Inning"), so callers can fall back to
 * the Poisson. "Middle N" / "End N" between-halves states advance to the next
 * half with 0 outs and empty bases, as does an outs=3 snapshot.
 */
export function paChainStateFromFeed(feed: Pick<FeedSnapshot,
  "period" | "status" | "outs" | "scoreHome" | "scoreAway" | "live" | "onFirst" | "onSecond" | "onThird"
>): PaChainGameState | null {
  if (feed.scoreAway == null || feed.scoreHome == null) return null;
  const status = String(feed.status ?? "").toLowerCase();
  if (status.includes("final")) return null;
  const period = String(feed.period ?? "");
  const m = period.match(/(\d{1,2})/);
  if (!m) return null;
  let inning = Number(m[1]);
  const p = period.toLowerCase();
  let half: "top" | "bottom";
  let outs = Number.isFinite(Number(feed.outs)) && feed.outs != null ? Number(feed.outs) : 0;
  let bases = basesKey(feed.onFirst, feed.onSecond, feed.onThird);

  if (p.includes("top")) half = "top";
  else if (p.includes("bottom") || p.includes("bot")) half = "bottom";
  else if (p.includes("middle") || p.includes("mid")) {
    half = "bottom";
    outs = 0;
    bases = "---";
  } else if (p.includes("end")) {
    inning += 1;
    half = "top";
    outs = 0;
    bases = "---";
  } else {
    return null; // ambiguous (e.g. bwin "8th Inning")
  }

  if (outs >= 3) {
    // Between halves: advance.
    if (half === "top") half = "bottom";
    else {
      half = "top";
      inning += 1;
    }
    outs = 0;
    bases = "---";
  }
  return {
    inning,
    half,
    outs: Math.min(Math.max(outs, 0), 2),
    bases,
    scoreAway: Number(feed.scoreAway),
    scoreHome: Number(feed.scoreHome),
  };
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

/** Deterministic PRNG so identical states always price identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleTransition(
  table: PaChainTable,
  outs: number,
  bases: string,
  rand: () => number,
): Transition {
  const cell = table.cells.get(`${outs}|${bases}`) ?? table.cells.get("0|---");
  if (!cell) return { rbi: 0, outsAfter: outs + 1, basesAfter: bases, cum: 0 };
  const target = rand() * cell.total;
  const ts = cell.transitions;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]!.cum <= target) lo = mid + 1;
    else hi = mid;
  }
  return ts[lo]!;
}

export type PaChainDistribution = {
  /** joint counts over (extraAway, extraHome), truncated */
  joint: Map<number, number>; // key = extraAway * 64 + extraHome
  sims: number;
  meanExtraAway: number;
  meanExtraHome: number;
};

const memo = new Map<string, PaChainDistribution>();

function gameOver(state: PaChainGameState): boolean {
  // Bottom 9+ with home already ahead = walk-off/over.
  return state.inning >= 9 && state.half === "bottom" && state.scoreHome > state.scoreAway;
}

/**
 * Simulate remaining runs from a game state. Returns the joint distribution
 * of (extraAway, extraHome). Memoized per state (scores enter via walk-off
 * logic only, so the key clamps the margin to ±6).
 */
export function paChainDistribution(
  table: PaChainTable,
  state: PaChainGameState,
  sims: number = SIMS,
): PaChainDistribution {
  const margin = Math.max(-6, Math.min(6, state.scoreHome - state.scoreAway));
  const key = `${state.inning}|${state.half}|${state.outs}|${state.bases}|${margin}|${sims}`;
  const hit = memo.get(key);
  if (hit) return hit;

  const joint = new Map<number, number>();
  let sumA = 0;
  let sumH = 0;
  const rand = mulberry32(0x5eed ^ (key.length << 16) ^ hashString(key));

  for (let i = 0; i < sims; i++) {
    let extraA = 0;
    let extraH = 0;
    let inn = state.inning;
    let half = state.half;
    let outs = state.outs;
    let bases = state.bases;
    // Normalized margin so walk-off logic matches the memo key.
    let home = margin > 0 ? margin : 0;
    let away = margin < 0 ? -margin : 0;

    let guard = 0;
    while (guard++ < 400) {
      if (inn >= 9 && half === "bottom" && home > away) break; // walk-off / game over
      const tr = sampleTransition(table, outs, bases, rand);
      if (half === "top") {
        away += tr.rbi;
        extraA += tr.rbi;
      } else {
        home += tr.rbi;
        extraH += tr.rbi;
        if (inn >= 9 && home > away) break; // walk-off
      }
      if (tr.outsAfter >= 3) {
        if (half === "top") {
          half = "bottom";
        } else {
          if (inn >= 9 && away !== home) break; // game over after full inning
          inn += 1;
          half = "top";
          if (inn > MAX_EXTRA_INNINGS) break;
        }
        outs = 0;
        bases = "---";
      } else {
        outs = Math.min(tr.outsAfter, 2);
        bases = tr.basesAfter;
      }
    }
    const a = Math.min(extraA, 30);
    const h = Math.min(extraH, 30);
    joint.set(a * 64 + h, (joint.get(a * 64 + h) ?? 0) + 1);
    sumA += a;
    sumH += h;
  }

  const dist: PaChainDistribution = {
    joint,
    sims,
    meanExtraAway: sumA / sims,
    meanExtraHome: sumH / sims,
  };
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, dist);
  return dist;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Band pricing (Strat2State-compatible)
// ---------------------------------------------------------------------------

/**
 * PA-chain fair for a game-total middle band (lo, hi]. Falls back to the
 * Strat2 Poisson when the table is missing or the feed cannot be parsed
 * into a simulation state.
 */
export function computeMlbBandState(
  feed: Pick<FeedSnapshot,
    "period" | "status" | "outs" | "scoreHome" | "scoreAway" | "live" | "onFirst" | "onSecond" | "onThird"
  >,
  lo: number,
  hi: number,
): Strat2State | null {
  const table = paChainTable();
  const state = table ? paChainStateFromFeed(feed) : null;
  if (!table || !state) return computeStrat2State(feed, lo, hi);

  const currentTotal = state.scoreAway + state.scoreHome;
  const inningsLeft = parseMlbInningsLeft(feed) ?? 0;

  if (gameOver(state)) {
    const p = lo < currentTotal && currentTotal <= hi ? 1 : 0;
    return baseState(currentTotal, null, inningsLeft, 0, p);
  }

  const dist = paChainDistribution(table, state);
  let inBand = 0;
  for (const [key, n] of dist.joint) {
    const extra = ((key / 64) | 0) + (key % 64);
    const finalTotal = currentTotal + extra;
    if (finalTotal > lo && finalTotal <= hi) inBand += n;
  }
  const pMiddle = inBand / dist.sims;
  return baseState(
    currentTotal,
    null,
    inningsLeft,
    dist.meanExtraAway + dist.meanExtraHome,
    pMiddle,
  );
}

/**
 * PA-chain fair for a same-team spread middle band (lo, hi] of the named
 * side's winning margin. Falls back to the Skellam-style Poisson.
 */
export function computeMlbSpreadBandState(
  feed: Pick<FeedSnapshot,
    "period" | "status" | "outs" | "scoreHome" | "scoreAway" | "live" | "onFirst" | "onSecond" | "onThird"
  >,
  lo: number,
  hi: number,
  side: "home" | "away",
): Strat2State | null {
  const table = paChainTable();
  const state = table ? paChainStateFromFeed(feed) : null;
  if (!table || !state) return computeStrat2SpreadState(feed, lo, hi, side);

  const currentTotal = state.scoreAway + state.scoreHome;
  const currentMargin =
    side === "home" ? state.scoreHome - state.scoreAway : state.scoreAway - state.scoreHome;
  const inningsLeft = parseMlbInningsLeft(feed) ?? 0;

  if (gameOver(state)) {
    const p = lo < currentMargin && currentMargin <= hi ? 1 : 0;
    return {
      ...baseState(currentTotal, currentMargin, inningsLeft, 0, p),
      marketType: "spread",
      side,
    };
  }

  const dist = paChainDistribution(table, state);
  let inBand = 0;
  for (const [key, n] of dist.joint) {
    const extraA = (key / 64) | 0;
    const extraH = key % 64;
    const deltaMargin = side === "home" ? extraH - extraA : extraA - extraH;
    const finalMargin = currentMargin + deltaMargin;
    if (finalMargin > lo && finalMargin <= hi) inBand += n;
  }
  const pMiddle = inBand / dist.sims;
  return {
    ...baseState(
      currentTotal,
      currentMargin,
      inningsLeft,
      dist.meanExtraAway + dist.meanExtraHome,
      pMiddle,
    ),
    marketType: "spread",
    side,
    lambdaTeam: side === "home" ? dist.meanExtraHome : dist.meanExtraAway,
    lambdaOpp: side === "home" ? dist.meanExtraAway : dist.meanExtraHome,
  };
}

function baseState(
  currentTotal: number,
  currentMargin: number | null,
  inningsLeft: number,
  expectedExtraRuns: number,
  pMiddle: number,
): Strat2State {
  return {
    marketType: "game_total",
    currentTotal,
    currentMargin,
    inningsLeft,
    // Report the chain's expected remaining runs in the lambda slot so
    // downstream logging keeps a comparable "run environment" number.
    lambda: expectedExtraRuns,
    lambdaTeam: null,
    lambdaOpp: null,
    side: null,
    pMiddle,
    fair: 1 + pMiddle,
    model: "pa_chain",
  };
}
