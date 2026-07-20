/**
 * Possible RBI outcomes for the current at-bat, from baserunner state.
 *
 * Mapping (runners on base → possible scoring-play sizes):
 *   0 on → {1}
 *   1 on → {1, 2}
 *   2 on → {1, 2, 3}
 *   3 on (loaded) → {1, 2, 3, 4}
 *
 * These are the counterfactual total deltas we cache so that on score confirm
 * we immediately know which middles to hunt/price.
 */

export type MlbRbiDelta = 1 | 2 | 3 | 4;

/**
 * Possible RBI counts given N runners on base (0–3).
 * Unknown runners → assume loaded (widest hunt set).
 */
export function possibleRbiDeltas(runnersOn: number | null | undefined): MlbRbiDelta[] {
  const n = runnersOn == null || !Number.isFinite(runnersOn)
    ? 3
    : Math.max(0, Math.min(3, Math.floor(runnersOn)));
  if (n <= 0) return [1];
  if (n === 1) return [1, 2];
  if (n === 2) return [1, 2, 3];
  return [1, 2, 3, 4];
}

export type MlbScoreBranch = {
  /** Runs added to game total on this scoring play. */
  rbiDelta: MlbRbiDelta;
  /** Away score after branch (batting side scores). */
  scoreAway: number;
  scoreHome: number;
  battingSide: "home" | "away";
};

/** Build counterfactual scores if the batting side plates `delta` runs this AB. */
export function scoreAfterRbiDelta(input: {
  scoreAway: number;
  scoreHome: number;
  battingSide: "home" | "away";
  rbiDelta: MlbRbiDelta;
}): { scoreAway: number; scoreHome: number } {
  if (input.battingSide === "away") {
    return { scoreAway: input.scoreAway + input.rbiDelta, scoreHome: input.scoreHome };
  }
  return { scoreAway: input.scoreAway, scoreHome: input.scoreHome + input.rbiDelta };
}

export function buildActiveRbiBranches(input: {
  scoreAway: number;
  scoreHome: number;
  battingSide: "home" | "away" | null | undefined;
  runnersOn: number | null | undefined;
}): MlbScoreBranch[] {
  const side = input.battingSide === "home" || input.battingSide === "away"
    ? input.battingSide
    : "away";
  return possibleRbiDeltas(input.runnersOn).map((rbiDelta) => {
    const next = scoreAfterRbiDelta({
      scoreAway: input.scoreAway,
      scoreHome: input.scoreHome,
      battingSide: side,
      rbiDelta,
    });
    return {
      rbiDelta,
      scoreAway: next.scoreAway,
      scoreHome: next.scoreHome,
      battingSide: side,
    };
  });
}

/** Match a confirmed scoring play to an RBI delta (capped logic for hunt). */
export function rbiDeltaFromScoreChange(
  prevAway: number,
  prevHome: number,
  away: number,
  home: number,
): number | null {
  const dAway = away - prevAway;
  const dHome = home - prevHome;
  if (dAway > 0 && dHome === 0) return dAway;
  if (dHome > 0 && dAway === 0) return dHome;
  if (dAway > 0 && dHome > 0) return dAway + dHome; // rare same-tick both; sum
  return null;
}
