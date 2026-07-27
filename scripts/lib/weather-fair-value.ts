/**
 * Hourly temperature fair value for Kalshi "°F or above" strikes.
 *
 * Model (from the NYC hourly desk): T ~ N(μ, σ²), half-up integer settle bins,
 * pYes(floor) = P(round(T) > floor).
 */

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCdf(x: number, mu: number, sigma: number): number {
  if (sigma <= 0) return x >= mu ? 1 : 0;
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

/** P(round(T) = k) under T ~ N(mu, sigma^2), half-up bins. */
export function pInteger(mu: number, sig: number, k: number): number {
  return Math.max(0, normalCdf(k + 0.5, mu, sig) - normalCdf(k - 0.5, mu, sig));
}

export function pYesAboveFloor(mu: number, sig: number, floor: number): number {
  const lo = Math.floor(mu - 6 * sig) - 2;
  const hi = Math.ceil(mu + 6 * sig) + 2;
  let p = 0;
  for (let k = lo; k <= hi; k++) {
    if (k > floor) p += pInteger(mu, sig, k);
  }
  return Math.min(1, Math.max(0, p));
}

export type FairValueState = {
  /** Indifference μ (°F) after bias */
  mu: number;
  sigma: number;
  /** Raw lead reading before bias */
  readingF: number;
  bias: number;
  /** Where μ came from */
  source: "metar51" | "synoptic" | "speci" | "nws" | "twc" | "manual" | "blend";
  updatedAtMs: number;
  /** Anchor :51 print that started the hour */
  anchor51F: number | null;
};

/**
 * Start-of-hour fair value: last decisive :51 METAR is the prior for the next hour.
 * Mid-hour corrections replace μ when a trusted lead reading moves.
 */
export function fairFromReading(opts: {
  readingF: number;
  bias?: number;
  sigma?: number;
  source: FairValueState["source"];
  anchor51F?: number | null;
  nowMs?: number;
}): FairValueState {
  const bias = opts.bias ?? 0;
  const sigma = Math.max(0.05, opts.sigma ?? 0.7);
  const readingF = opts.readingF;
  return {
    mu: readingF + bias,
    sigma,
    readingF,
    bias,
    source: opts.source,
    updatedAtMs: opts.nowMs ?? Date.now(),
    anchor51F: opts.anchor51F ?? null,
  };
}

/**
 * Correct true price off a temperature reading change.
 * Returns previous state if the reading did not move by minDeltaF.
 */
export function correctFairOnReadingChange(
  prev: FairValueState | null,
  readingF: number,
  source: FairValueState["source"],
  opts?: { bias?: number; sigma?: number; minDeltaF?: number; nowMs?: number },
): { state: FairValueState; changed: boolean } {
  const minDelta = opts?.minDeltaF ?? 0.05;
  if (prev && Math.abs(readingF - prev.readingF) < minDelta) {
    return { state: prev, changed: false };
  }
  const state = fairFromReading({
    readingF,
    bias: opts?.bias ?? prev?.bias ?? 0,
    sigma: opts?.sigma ?? prev?.sigma ?? 0.7,
    source,
    anchor51F: prev?.anchor51F ?? null,
    nowMs: opts?.nowMs,
  });
  return { state, changed: true };
}
