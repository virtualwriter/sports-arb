/**
 * Early MLB next-line Kalshi over softballs (live + shadow).
 *
 * Matches scripts/collect-mlb-softballs.py early cats:
 *   multi_run_early  — 2+ runs, inning ≤ 5
 *   cheap_over_early — ask ∈ [0.50, 0.80), inning ≤ 5
 *
 * Late cheap overs / middles are intentionally out of scope.
 */

/** Inclusive max inning for early over softballs (6th+ is too late / not cheap). */
export const EARLY_OVER_MAX_INNING = 5;

export const CAT_MULTI_RUN_EARLY = "multi_run_early";
export const CAT_CHEAP_OVER_EARLY = "cheap_over_early";

export type MlbOverSoftballCat =
  | typeof CAT_MULTI_RUN_EARLY
  | typeof CAT_CHEAP_OVER_EARLY;

export type KalshiYesTobEntry = {
  ask: number;
  askSize: number;
  ticker: string;
  t?: number;
  /** YES ask ladder from depthNo: [yesAskPrice, size], best→worse. */
  askLevels?: Array<[number, number]>;
};

export type MlbOverSoftballCandidate = {
  line: number;
  ask: number;
  askSize: number;
  ticker: string;
  cats: MlbOverSoftballCat[];
  curTotal: number;
  inning: number;
  runsDelta: number;
  askLevels?: Array<[number, number]>;
};

/** Plan a walk of the YES ask ladder up to ≥ tobMult × TOB size within maxAsk. */
export type AskWalkPlan = {
  tobAsk: number;
  tobSize: number;
  targetSize: number;
  count: number;
  limitPrice: number;
  vwap: number;
  levelsTaken: Array<[number, number]>;
};

/**
 * Convert Kalshi NO-bid depth levels `[noBid, size]` → YES ask levels `[1-noBid, size]`.
 */
export function yesAskLevelsFromNoBids(
  depthNo: Array<[number, number]> | null | undefined,
  tobAsk: number,
  tobSize: number,
): Array<[number, number]> {
  const levels: Array<[number, number]> = [];
  if (depthNo?.length) {
    for (const lvl of depthNo) {
      if (!lvl || lvl.length < 2) continue;
      const noBid = Number(lvl[0]);
      const sz = Number(lvl[1]);
      if (!(noBid >= 0 && noBid < 1) || !(sz > 0)) continue;
      levels.push([Number((1 - noBid).toFixed(4)), sz]);
    }
  }
  if (levels.length === 0 && tobAsk > 0 && tobSize > 0) {
    levels.push([tobAsk, tobSize]);
  }
  levels.sort((a, b) => a[0] - b[0]);
  // Deduplicate prices (sum sizes)
  const merged = new Map<number, number>();
  for (const [p, s] of levels) {
    merged.set(p, (merged.get(p) ?? 0) + s);
  }
  return [...merged.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Walk YES asks from best until we reach targetSize or hit maxAsk / maxContracts / maxUsd.
 * Limit price = worst level included.
 *
 * - Default target: max(tobSize, floor(tobMult * tobSize))
 * - fillBook=true: take every level ≤ maxAsk up to maxContracts / maxUsd (ignore tobMult)
 * - maxWalkAboveTob: also cap at tobAsk + delta so a cheap TOB isn't walked into at-cost
 */
export function planAskWalk(input: {
  tobAsk: number;
  tobSize: number;
  askLevels?: Array<[number, number]> | null;
  maxAsk: number;
  maxContracts: number;
  maxUsd: number;
  tobMult?: number;
  /** When true, clear the visible book ≤ maxAsk (capped by maxContracts/maxUsd). */
  fillBook?: boolean;
  /**
   * Max cents above TOB to walk (e.g. 0.02). Applied as
   * effectiveMaxAsk = min(maxAsk, tobAsk + maxWalkAboveTob).
   */
  maxWalkAboveTob?: number;
}): AskWalkPlan {
  const tobMult = Math.max(1, input.tobMult ?? 2);
  const tobAsk = input.tobAsk;
  const tobSize = Math.max(0, input.tobSize);
  const walkCap =
    input.maxWalkAboveTob != null && Number.isFinite(input.maxWalkAboveTob)
      ? tobAsk + Math.max(0, input.maxWalkAboveTob)
      : input.maxAsk;
  const effectiveMaxAsk = Math.min(input.maxAsk, walkCap);
  const levels =
    input.askLevels && input.askLevels.length > 0
      ? [...input.askLevels].sort((a, b) => a[0] - b[0])
      : ([[tobAsk, tobSize]] as Array<[number, number]>);

  const targetSize = input.fillBook
    ? input.maxContracts
    : Math.min(
      input.maxContracts,
      Math.max(Math.floor(tobSize), Math.floor(tobSize * tobMult)),
    );

  let count = 0;
  let notional = 0;
  let limitPrice = tobAsk;
  const levelsTaken: Array<[number, number]> = [];

  for (const [ask, sz] of levels) {
    if (!(ask > 0) || ask > effectiveMaxAsk + 1e-9) break;
    if (count >= targetSize) break;
    const roomContracts = targetSize - count;
    const roomUsd = input.maxUsd - notional;
    if (roomUsd <= 0) break;
    const maxByUsd = Math.floor(roomUsd / ask + 1e-9);
    const take = Math.min(Math.floor(sz), roomContracts, maxByUsd);
    if (take <= 0) {
      if (maxByUsd <= 0) break;
      continue;
    }
    levelsTaken.push([ask, take]);
    count += take;
    notional += take * ask;
    limitPrice = ask;
  }

  // If depth missing/thin, still try at least TOB size at tob ask (capped).
  if (count <= 0 && tobAsk <= effectiveMaxAsk && tobSize > 0) {
    const take = Math.min(
      Math.floor(tobSize),
      input.maxContracts,
      Math.floor(input.maxUsd / tobAsk),
    );
    if (take > 0) {
      levelsTaken.push([tobAsk, take]);
      count = take;
      notional = take * tobAsk;
      limitPrice = tobAsk;
    }
  }

  const vwap = count > 0 ? notional / count : tobAsk;
  return {
    tobAsk,
    tobSize,
    targetSize,
    count,
    limitPrice: Number(limitPrice.toFixed(4)),
    vwap: Number(vwap.toFixed(4)),
    levelsTaken,
  };
}

/** Parse "Top 5th" / "5th Inning" / "Bot 8" → inning number. */
export function parseMlbInning(period: string | null | undefined): number | null {
  if (!period) return null;
  const m = String(period).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function earlyOverCategories(
  inning: number | null,
  runsDelta: number,
  ask: number,
): MlbOverSoftballCat[] {
  const cats: MlbOverSoftballCat[] = [];
  if (inning != null && runsDelta >= 2 && inning <= EARLY_OVER_MAX_INNING) {
    cats.push(CAT_MULTI_RUN_EARLY);
  }
  if (inning != null && ask >= 0.5 && ask < 0.8 && inning <= EARLY_OVER_MAX_INNING) {
    cats.push(CAT_CHEAP_OVER_EARLY);
  }
  return cats;
}

/**
 * Proposed tighten: no multi_run_early chase at ask ≥ threshold from minInning on
 * (default: ≥ $0.90 from the 5th). Cheap-over-early alone is unaffected.
 */
export function isMultiRunLateHighAsk(input: {
  cats: readonly MlbOverSoftballCat[];
  inning: number;
  ask: number;
  minInning?: number;
  askThreshold?: number;
}): boolean {
  if (!input.cats.includes(CAT_MULTI_RUN_EARLY)) return false;
  const minInning = input.minInning ?? 5;
  const askThreshold = input.askThreshold ?? 0.9;
  return input.inning >= minInning && input.ask + 1e-12 >= askThreshold;
}

/** Kalshi taker fee on a YES contract priced at `p` (dollars). */
export function kalshiYesFee(p: number): number {
  return 0.07 * p * (1 - p);
}

/**
 * Paper multi_run_early hit rates by inning (collector samples through mid-Aug).
 * Inn 4 is the weak bucket (~90%); 1–3/5 are much higher.
 */
export const MULTI_RUN_EARLY_WR_BY_INNING: Readonly<Record<number, number>> = {
  1: 0.98,
  2: 0.98,
  3: 0.98,
  4: 0.90,
  5: 0.975,
};

export const MULTI_RUN_EARLY_WR_DEFAULT = 0.97;

export function multiRunEarlyWinRate(inning: number | null | undefined): number {
  if (inning == null) return MULTI_RUN_EARLY_WR_DEFAULT;
  return MULTI_RUN_EARLY_WR_BY_INNING[inning] ?? MULTI_RUN_EARLY_WR_DEFAULT;
}

/**
 * Model edge $/contract for a YES buy at `ask`, using the multi_run_early
 * inning prior (fee-adjusted). Negative ⇒ paying above fair.
 */
export function modelEdgePerContract(ask: number, inning: number | null | undefined): number {
  const p = multiRunEarlyWinRate(inning);
  return p * (1 - ask) + (1 - p) * (-ask) - kalshiYesFee(ask);
}

/**
 * Cheapest Kalshi total YES with 0 < line − curTotal ≤ 1 and ask in (0.05, 0.95).
 * Returns null unless at least one early softball category matches.
 */
export function selectEarlyOverSoftball(input: {
  inning: number | null;
  runsDelta: number;
  curTotal: number;
  kalshiYesTob: ReadonlyMap<number, KalshiYesTobEntry> | Iterable<[number, KalshiYesTobEntry]>;
}): MlbOverSoftballCandidate | null {
  const { inning, runsDelta, curTotal } = input;
  if (inning == null || !(runsDelta > 0)) return null;

  const entries =
    input.kalshiYesTob instanceof Map
      ? input.kalshiYesTob.entries()
      : input.kalshiYesTob;

  let best: {
    line: number;
    ask: number;
    askSize: number;
    ticker: string;
    askLevels?: Array<[number, number]>;
  } | null = null;
  for (const [line, q] of entries) {
    const dist = line - curTotal;
    if (!(dist > 0 && dist <= 1)) continue;
    if (!(q.ask > 0.05 && q.ask < 0.95)) continue;
    if (!q.ticker || !(q.askSize > 0)) continue;
    if (best == null || q.ask < best.ask) {
      best = {
        line,
        ask: q.ask,
        askSize: q.askSize,
        ticker: q.ticker,
        askLevels: q.askLevels,
      };
    }
  }
  if (!best) return null;

  const cats = earlyOverCategories(inning, runsDelta, best.ask);
  if (cats.length === 0) return null;

  return {
    line: best.line,
    ask: best.ask,
    askSize: best.askSize,
    ticker: best.ticker,
    cats,
    curTotal,
    inning,
    runsDelta,
    ...(best.askLevels ? { askLevels: best.askLevels } : {}),
  };
}

/** Build line → YES TOB map from paper keys like `total_7.5:yes`. */
export function kalshiYesTobFromPaperMap(
  kalshiTob: ReadonlyMap<string, {
    ask: number;
    askSize: number;
    t: number;
    ticker?: string;
    askLevels?: Array<[number, number]>;
  }>,
): Map<number, KalshiYesTobEntry> {
  const out = new Map<number, KalshiYesTobEntry>();
  for (const [key, q] of kalshiTob) {
    if (!key.endsWith(":yes")) continue;
    const m = key.match(/^total_(\d+(?:\.\d+)?):yes$/);
    if (!m) continue;
    if (!q.ticker) continue;
    out.set(Number(m[1]), {
      ask: q.ask,
      askSize: q.askSize,
      ticker: q.ticker,
      t: q.t,
      ...(q.askLevels ? { askLevels: q.askLevels } : {}),
    });
  }
  return out;
}
