import type { Candidate } from "./monotonic-arb-core.js";

const EPS = 1e-9;

export const SOCCER_BEST_SEEN_GATE_ENABLED = process.env.ARB_DAEMON_SOCCER_BEST_SEEN_GATE === "1";
export const SOCCER_BEST_SEEN_TOLERANCE = Number(process.env.ARB_DAEMON_SOCCER_BEST_SEEN_TOLERANCE ?? 0.03);

const bestByEventFamily = new Map<string, number>();

export function soccerLineFamily(candidate: Candidate): string {
  const lo = Math.min(candidate.broad.strike, candidate.narrow.strike);
  const hi = Math.max(candidate.broad.strike, candidate.narrow.strike);
  return `${lo}-${hi}`;
}

export function soccerEventFamilyKey(eventSlug: string, lineFamily: string): string {
  return `${eventSlug}|${lineFamily}`;
}

/** Track the lowest live-observed package cost for an event + line family. */
export function recordSoccerEventShapeCost(candidate: Candidate): void {
  if (candidate.asset !== "SOCCER") return;
  const cost = candidate.packageCost;
  if (!Number.isFinite(cost) || cost <= 0) return;
  const key = soccerEventFamilyKey(candidate.eventSlug, soccerLineFamily(candidate));
  const prev = bestByEventFamily.get(key);
  if (prev === undefined || cost + EPS < prev) {
    bestByEventFamily.set(key, cost);
  }
}

export function soccerEventShapeBestCost(eventSlug: string, lineFamily: string): number | undefined {
  return bestByEventFamily.get(soccerEventFamilyKey(eventSlug, lineFamily));
}

export function soccerBestSeenCostBlock(candidate: Candidate): string | null {
  if (!SOCCER_BEST_SEEN_GATE_ENABLED || candidate.asset !== "SOCCER") return null;
  const family = soccerLineFamily(candidate);
  const best = soccerEventShapeBestCost(candidate.eventSlug, family);
  if (best === undefined) return null;
  const ceiling = best + SOCCER_BEST_SEEN_TOLERANCE;
  if (candidate.packageCost > ceiling + EPS) {
    return `soccer_above_best_seen event=${candidate.eventSlug} family=${family} cost=${candidate.packageCost.toFixed(4)} best=${best.toFixed(4)} tol=${SOCCER_BEST_SEEN_TOLERANCE.toFixed(4)}`;
  }
  return null;
}

/** Test helper */
export function resetSoccerEventBestCosts(): void {
  bestByEventFamily.clear();
}
