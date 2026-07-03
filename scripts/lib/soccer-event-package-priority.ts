import type { Candidate } from "./monotonic-arb-core.js";

const EPS = 1e-9;

export type ScoredWatchPackage = {
  key: string;
  candidate: Candidate;
};

export function soccerLineFamily(candidate: Candidate): string {
  const lo = Math.min(candidate.broad.strike, candidate.narrow.strike);
  const hi = Math.max(candidate.broad.strike, candidate.narrow.strike);
  return `${lo}-${hi}`;
}

/** Lower cost wins; equal cost prefers a narrower middle (e.g. 3.5/5.5 over 3.5/6.5). */
export function isBetterSoccerEventPackage(challenger: Candidate, incumbent: Candidate): boolean {
  if (challenger.packageCost + EPS < incumbent.packageCost) return true;
  if (incumbent.packageCost + EPS < challenger.packageCost) return false;
  const challengerWidth = Math.abs(challenger.narrow.strike - challenger.broad.strike);
  const incumbentWidth = Math.abs(incumbent.narrow.strike - incumbent.broad.strike);
  return challengerWidth + EPS < incumbentWidth;
}

/** One package per eventSlug — the cheapest live-eligible candidate on that event. */
export function pickCheapestSoccerPackagesByEvent(items: ScoredWatchPackage[]): ScoredWatchPackage[] {
  const byEvent = new Map<string, ScoredWatchPackage>();
  for (const item of items) {
    const slug = item.candidate.eventSlug;
    const prev = byEvent.get(slug);
    if (!prev || isBetterSoccerEventPackage(item.candidate, prev.candidate)) {
      byEvent.set(slug, item);
    }
  }
  return [...byEvent.values()];
}

export function findCheapestSoccerEventPackage(items: ScoredWatchPackage[]): ScoredWatchPackage | null {
  if (items.length === 0) return null;
  return pickCheapestSoccerPackagesByEvent(items)[0] ?? null;
}

export function shouldDeferSoccerPackage(
  candidate: Candidate,
  packageKey: string,
  items: ScoredWatchPackage[],
): { defer: boolean; cheaperKey: string; cheaperCost: number } | null {
  const family = soccerLineFamily(candidate);
  const eligible = items.filter((item) =>
    item.candidate.eventSlug === candidate.eventSlug
    && soccerLineFamily(item.candidate) === family
  );
  if (eligible.length === 0) return null;
  const best = findCheapestSoccerEventPackage(eligible);
  if (!best || best.key === packageKey) return null;
  if (isBetterSoccerEventPackage(best.candidate, candidate)) {
    return { defer: true, cheaperKey: best.key, cheaperCost: best.candidate.packageCost };
  }
  return null;
}
