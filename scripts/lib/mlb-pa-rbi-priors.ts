/**
 * Empirical per-PA RBI priors from analysis/per-plate-rbi-p-backtest.json.
 *
 * Used by the MLB paper path to weight +1/+2/+3 branches (not to replace
 * Strat2 fair on score confirm).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.js";
import { possibleRbiDeltas, type MlbRbiDelta } from "./mlb-rbi-branches.js";

export const DEFAULT_PA_RBI_PRIOR_PATH =
  process.env.PLR_MLB_PA_RBI_PRIOR_PATH
  ?? join(REPO_ROOT, "analysis", "per-plate-rbi-p-backtest.json");

export type PaRbiP = {
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
};

export type PaRbiPriorCell = {
  outs: number;
  bases: string;
  runnersOn: number;
  n: number;
  p: PaRbiP;
  pScoring: number;
  expectedRbi: number;
};

export type PaRbiPriors = {
  path: string;
  generatedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  totalPlateAppearances: number;
  /** key: `${outs}|${bases}` e.g. `2|12-` */
  byOutsBases: Map<string, PaRbiPriorCell>;
  /** fallback by runnersOn only */
  byRunnersOn: Map<number, PaRbiP>;
};

type RawFile = {
  generatedAt?: string;
  startDate?: string;
  endDate?: string;
  totalPlateAppearances?: number;
  cells?: Array<{
    outs?: number;
    bases?: string;
    runnersOn?: number;
    n?: number;
    p?: Record<string, number>;
    pScoring?: number;
    expectedRbi?: number;
  }>;
  byRunnersOn?: Array<{
    runnersOn?: number;
    p?: Record<string, number>;
  }>;
};

function asP(raw: Record<string, number> | undefined): PaRbiP {
  const get = (k: string) => {
    const v = raw?.[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return { 0: get("0"), 1: get("1"), 2: get("2"), 3: get("3"), 4: get("4") };
}

/** Bases key from first/second/third occupation — matches backtest (`12-`, `1-3`, `---`). */
export function basesKeyFromFlags(onFirst?: boolean | null, onSecond?: boolean | null, onThird?: boolean | null): string {
  return `${onFirst ? "1" : "-"}${onSecond ? "2" : "-"}${onThird ? "3" : "-"}`;
}

export function loadPaRbiPriors(path: string = DEFAULT_PA_RBI_PRIOR_PATH): PaRbiPriors | null {
  if (!existsSync(path)) return null;
  let raw: RawFile;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as RawFile;
  } catch {
    return null;
  }
  const byOutsBases = new Map<string, PaRbiPriorCell>();
  for (const c of raw.cells ?? []) {
    if (c.outs == null || !c.bases) continue;
    const p = asP(c.p);
    byOutsBases.set(`${c.outs}|${c.bases}`, {
      outs: c.outs,
      bases: c.bases,
      runnersOn: c.runnersOn ?? 0,
      n: c.n ?? 0,
      p,
      pScoring: c.pScoring ?? 1 - p[0],
      expectedRbi: c.expectedRbi ?? (p[1] + 2 * p[2] + 3 * p[3] + 4 * p[4]),
    });
  }
  const byRunnersOn = new Map<number, PaRbiP>();
  for (const r of raw.byRunnersOn ?? []) {
    if (r.runnersOn == null) continue;
    byRunnersOn.set(r.runnersOn, asP(r.p));
  }
  if (!byOutsBases.size && !byRunnersOn.size) return null;
  return {
    path,
    generatedAt: raw.generatedAt ?? null,
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    totalPlateAppearances: raw.totalPlateAppearances ?? 0,
    byOutsBases,
    byRunnersOn,
  };
}

export function lookupPaRbiP(
  priors: PaRbiPriors,
  input: {
    outs?: number | null;
    bases?: string | null;
    onFirst?: boolean | null;
    onSecond?: boolean | null;
    onThird?: boolean | null;
    runnersOn?: number | null;
  },
): { p: PaRbiP; source: "outs_bases" | "runners_on" | "uniform_active"; cellN: number; bases: string; outs: number | null } {
  const outs = input.outs != null && Number.isFinite(input.outs)
    ? Math.max(0, Math.min(2, Math.floor(input.outs)))
    : null;
  const bases = input.bases
    ?? basesKeyFromFlags(input.onFirst, input.onSecond, input.onThird);
  if (outs != null) {
    const cell = priors.byOutsBases.get(`${outs}|${bases}`);
    if (cell) {
      return { p: cell.p, source: "outs_bases", cellN: cell.n, bases, outs };
    }
  }
  const ro = input.runnersOn != null && Number.isFinite(input.runnersOn)
    ? Math.max(0, Math.min(3, Math.floor(input.runnersOn)))
    : (bases.match(/[123]/g)?.length ?? 0);
  const byRo = priors.byRunnersOn.get(ro);
  if (byRo) {
    return { p: byRo, source: "runners_on", cellN: 0, bases, outs };
  }
  // Uniform over legal scoring deltas only (research fallback).
  const deltas = possibleRbiDeltas(ro);
  const u = 1 / deltas.length;
  const p: PaRbiP = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const d of deltas) p[d] = u;
  return { p, source: "uniform_active", cellN: 0, bases, outs };
}

/**
 * Renormalize P(RBI=k) onto the active scoring deltas only (exclude outs),
 * for weighting hunt branches. Returns probs that sum to 1 over `deltas`.
 */
export function scoringDeltaWeights(
  p: PaRbiP,
  deltas: MlbRbiDelta[],
): Record<number, number> {
  let mass = 0;
  for (const d of deltas) mass += p[d] ?? 0;
  const out: Record<number, number> = {};
  if (mass <= 0) {
    const u = 1 / Math.max(deltas.length, 1);
    for (const d of deltas) out[d] = u;
    return out;
  }
  for (const d of deltas) out[d] = (p[d] ?? 0) / mass;
  return out;
}

export type BranchEdgeInput = {
  rbiDelta: number;
  /** Strat2 fair at that counterfactual score. */
  fair: number;
  cost: number | null;
};

/**
 * Expected edge under PA priors: Σ P(delta|scoring) × (fair_delta − cost).
 * Uses current TOB cost for all branches (stale-book latency view).
 */
export function expectedEdgeUnderPaPriors(
  weights: Record<number, number>,
  branches: BranchEdgeInput[],
): number | null {
  let any = false;
  let sum = 0;
  for (const b of branches) {
    const w = weights[b.rbiDelta];
    if (w == null || !(w > 0) || b.cost == null) continue;
    any = true;
    sum += w * (b.fair - b.cost);
  }
  return any ? sum : null;
}

/** Best single-delta Strat2 edge at current cost (confirm path shadow). */
export function bestStrat2BranchEdge(branches: BranchEdgeInput[]): {
  rbiDelta: number;
  edge: number;
  fair: number;
  cost: number;
} | null {
  let best: { rbiDelta: number; edge: number; fair: number; cost: number } | null = null;
  for (const b of branches) {
    if (b.cost == null) continue;
    const edge = b.fair - b.cost;
    if (!best || edge > best.edge) {
      best = { rbiDelta: b.rbiDelta, edge, fair: b.fair, cost: b.cost };
    }
  }
  return best;
}
