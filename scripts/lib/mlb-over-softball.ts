/**
 * Early MLB next-line Kalshi over softballs (live + shadow).
 *
 * Matches scripts/collect-mlb-softballs.py early cats:
 *   multi_run_early  — 2+ runs, inning ≤ 6
 *   cheap_over_early — ask ∈ [0.50, 0.80), inning ≤ 6
 *
 * Late cheap overs / middles are intentionally out of scope.
 */

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
};

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
  if (inning != null && runsDelta >= 2 && inning <= 6) {
    cats.push(CAT_MULTI_RUN_EARLY);
  }
  if (inning != null && ask >= 0.5 && ask < 0.8 && inning <= 6) {
    cats.push(CAT_CHEAP_OVER_EARLY);
  }
  return cats;
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

  let best: { line: number; ask: number; askSize: number; ticker: string } | null = null;
  for (const [line, q] of entries) {
    const dist = line - curTotal;
    if (!(dist > 0 && dist <= 1)) continue;
    if (!(q.ask > 0.05 && q.ask < 0.95)) continue;
    if (!q.ticker || !(q.askSize > 0)) continue;
    if (best == null || q.ask < best.ask) {
      best = { line, ask: q.ask, askSize: q.askSize, ticker: q.ticker };
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
  };
}

/** Build line → YES TOB map from paper keys like `total_7.5:yes`. */
export function kalshiYesTobFromPaperMap(
  kalshiTob: ReadonlyMap<string, { ask: number; askSize: number; t: number; ticker?: string }>,
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
    });
  }
  return out;
}
