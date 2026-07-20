/**
 * Soccer middle-arb screening package (shock lane).
 *
 * Captures the ENG–ARG ladder-lag filters that kept the 3 tradeable post-goal
 * packages and dropped dust / scare-shock junk:
 *   1. Live dust / leg gates (mirror daemon soccer strategy)
 *   2. Goal-like ML shock hygiene (mag + concurrent totals move)
 *   3. T+1 flip: −EV at current score, +EV after +1 goal
 *
 * Not wired into the daemon yet — shared constants/logic for paper loggers and
 * a future shock-triggered path. Bwin score confirm is a separate slow lane.
 */

export const SOCCER_MIDDLE_ARB_FILTERS_VERSION = "2026-07-15.1";

/** Package cost band used for post-shock opportunity scans. */
export const COST_LO = 0.85;
export const COST_HI = 1.45;

/** Mirror ARB_DAEMON_SPORTS_MAX_ENTRY_LEG_PRICE / soccer strategy. */
export const MAX_ENTRY_LEG_PRICE = 0.98;

/** Mirror ARB_DAEMON_SOCCER_MIN/MAX_NARROW_YES_BID. */
export const MIN_NARROW_YES_BID = 0.02;
export const MAX_NARROW_YES_BID = 0.10;

/** Analysis dust: broad YES ask at or below this is junk. */
export const DUST_YES_ASK = 0.02;

/** ML TOB jump size to treat as a shock candidate. */
export const SHOCK_MIN_ML_JUMP = 0.08;

/** Require some totals ladder TOB move in the shock window (kills FT flicker). */
export const SHOCK_MIN_TOTAL_MOVE = 0.03;

/** Single-leg mag≈1.0 with no totals move = settlement noise. */
export const SHOCK_FT_FLICKER_ML_JUMP = 0.99;
export const SHOCK_FT_FLICKER_MAX_TOTAL_MOVE = 0.01;

/** Optional persistence window (tie-break only; weak alone on ENG–ARG). */
export const SHOCK_PERSIST_MS = 100;

export type SoccerMiddleArbLegQuotes = {
  /** Broad YES ask (lower total / less-extreme spread). */
  broadYesAsk: number;
  /** Narrow NO ask (higher total / more-extreme spread). */
  narrowNoAsk: number;
};

export type SoccerMiddleArbShockFeatures = {
  /** Max |Δ| on any ML YES ask in the cluster. */
  maxMlJumpAbs: number;
  /** Max |Δ| on any totals TOB ask near the shock (e.g. ±200ms). */
  maxTotalMoveAbs: number;
  /** True after FT / settlement-only regime when known. */
  afterFt?: boolean;
};

export type SoccerMiddleArbEvSnapshot = {
  /** Edge at current score / margin: (1 + P_middle) − cost. */
  edgeAtCurrent: number;
  /** Edge after +1 goal (totals) or shock-implied scorer branch (spreads). */
  edgeAtTPlus1: number;
};

export type SoccerMiddleArbFilterReason =
  | "ok"
  | "cost_out_of_band"
  | "max_entry_leg"
  | "narrow_yes_bid_low"
  | "narrow_yes_bid_high"
  | "dust_yes_ask"
  | "shock_mag"
  | "shock_total_move"
  | "shock_ft_flicker"
  | "shock_after_ft"
  | "no_t1_flip"
  | "t1_not_positive";

export type SoccerMiddleArbFilterResult = {
  ok: boolean;
  reason: SoccerMiddleArbFilterReason;
};

export function packageCost(legs: SoccerMiddleArbLegQuotes): number {
  return legs.broadYesAsk + legs.narrowNoAsk;
}

export function impliedNarrowYesBid(narrowNoAsk: number): number {
  return Math.max(0, Math.min(1, 1 - narrowNoAsk));
}

/** Live dust / leg screen (daemon-compatible + YES dust). */
export function screenSoccerMiddleArbLegs(
  legs: SoccerMiddleArbLegQuotes,
  opts: { costLo?: number; costHi?: number; requireCostBand?: boolean } = {},
): SoccerMiddleArbFilterResult {
  const costLo = opts.costLo ?? COST_LO;
  const costHi = opts.costHi ?? COST_HI;
  const requireCostBand = opts.requireCostBand ?? true;
  const cost = packageCost(legs);

  if (requireCostBand && !(costLo <= cost && cost <= costHi)) {
    return { ok: false, reason: "cost_out_of_band" };
  }
  if (Math.max(legs.broadYesAsk, legs.narrowNoAsk) >= MAX_ENTRY_LEG_PRICE) {
    return { ok: false, reason: "max_entry_leg" };
  }
  const narrowYesBid = impliedNarrowYesBid(legs.narrowNoAsk);
  if (narrowYesBid < MIN_NARROW_YES_BID) {
    return { ok: false, reason: "narrow_yes_bid_low" };
  }
  if (narrowYesBid > MAX_NARROW_YES_BID) {
    return { ok: false, reason: "narrow_yes_bid_high" };
  }
  if (legs.broadYesAsk <= DUST_YES_ASK) {
    return { ok: false, reason: "dust_yes_ask" };
  }
  return { ok: true, reason: "ok" };
}

/** Goal-like shock hygiene (not a score confirm). */
export function screenSoccerMiddleArbShock(
  shock: SoccerMiddleArbShockFeatures,
  opts: {
    minMlJump?: number;
    minTotalMove?: number;
  } = {},
): SoccerMiddleArbFilterResult {
  const minMlJump = opts.minMlJump ?? SHOCK_MIN_ML_JUMP;
  const minTotalMove = opts.minTotalMove ?? SHOCK_MIN_TOTAL_MOVE;

  if (shock.afterFt) {
    return { ok: false, reason: "shock_after_ft" };
  }
  if (
    shock.maxMlJumpAbs >= SHOCK_FT_FLICKER_ML_JUMP
    && shock.maxTotalMoveAbs < SHOCK_FT_FLICKER_MAX_TOTAL_MOVE
  ) {
    return { ok: false, reason: "shock_ft_flicker" };
  }
  if (shock.maxMlJumpAbs < minMlJump) {
    return { ok: false, reason: "shock_mag" };
  }
  if (shock.maxTotalMoveAbs < minTotalMove) {
    return { ok: false, reason: "shock_total_move" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * Economic filter: only fire if the package flips from −EV at the current
 * state to +EV under the T+1 counterfactual (same book cost).
 */
export function screenSoccerMiddleArbT1Flip(
  ev: SoccerMiddleArbEvSnapshot,
): SoccerMiddleArbFilterResult {
  if (!(ev.edgeAtTPlus1 > 0)) {
    return { ok: false, reason: "t1_not_positive" };
  }
  if (!(ev.edgeAtCurrent <= 0 && ev.edgeAtTPlus1 > 0)) {
    return { ok: false, reason: "no_t1_flip" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * Full shock-lane screen: legs + shock hygiene + T+1 flip.
 * First failing reason wins (legs → shock → flip).
 */
export function screenSoccerMiddleArb(input: {
  legs: SoccerMiddleArbLegQuotes;
  shock: SoccerMiddleArbShockFeatures;
  ev: SoccerMiddleArbEvSnapshot;
  requireCostBand?: boolean;
}): SoccerMiddleArbFilterResult {
  const legs = screenSoccerMiddleArbLegs(input.legs, {
    requireCostBand: input.requireCostBand,
  });
  if (!legs.ok) return legs;

  const shock = screenSoccerMiddleArbShock(input.shock);
  if (!shock.ok) return shock;

  return screenSoccerMiddleArbT1Flip(input.ev);
}

/** ENG–ARG non-dust keepers under this package (documentation / tests). */
export const ENG_ARG_FILTERED_KEEPERS = [
  { event: "1-1→1-2", shape: "match_total:2.5-3.5", cost: 1.2475, edge: 0.6695 },
  { event: "0-0→1-0", shape: "match_total:1.5-3.5", cost: 1.2775, edge: 0.2838 },
  { event: "0-0→1-0", shape: "match_total:2.5-3.5", cost: 1.0825, edge: 0.1115 },
] as const;
