/**
 * Paper market-making quotes for Kalshi hourly temp ladders.
 *
 * Maps Brett Harrison components onto weather:
 *   fair value → Gaussian pYes
 *   order placement → two-sided quotes, inventory skew, last-10m widen/pull
 */

import { pYesAboveFloor, type FairValueState } from "./weather-fair-value.js";

export type QuoteMode = "normal" | "widen" | "pull";

export type MmQuoteParams = {
  /** Half-spread in probability units during normal quoting (default 2¢) */
  halfSpread: number;
  /** Half-spread when widening in the last N minutes (default 8¢) */
  widenHalfSpread: number;
  /** Minutes before close to start widening / pulling (default 10) */
  lastMinutes: number;
  /** Minutes before close to fully pull liquidity (default 3) */
  pullMinutes: number;
  /** Quote size in contracts */
  size: number;
  /** Inventory skew: shift mid by skewBps * inventory (contracts) */
  invSkewPerContract: number;
  /** Min/max prices */
  tick: number;
  minPx: number;
  maxPx: number;
};

export const DEFAULT_MM_PARAMS: MmQuoteParams = {
  halfSpread: 0.02,
  widenHalfSpread: 0.08,
  lastMinutes: 10,
  pullMinutes: 3,
  size: 10,
  invSkewPerContract: 0.001,
  tick: 0.01,
  minPx: 0.01,
  maxPx: 0.99,
};

export type StrikeQuote = {
  ticker: string;
  floor: number;
  pYes: number;
  mid: number;
  yesBid: number | null;
  yesAsk: number | null;
  size: number;
  mode: QuoteMode;
  reason: string;
};

export function quoteModeForMinutesToClose(
  minutesToClose: number | null,
  params: Pick<MmQuoteParams, "lastMinutes" | "pullMinutes"> = DEFAULT_MM_PARAMS,
): QuoteMode {
  if (minutesToClose == null) return "normal";
  if (minutesToClose <= params.pullMinutes) return "pull";
  if (minutesToClose <= params.lastMinutes) return "widen";
  return "normal";
}

function clampPx(px: number, params: MmQuoteParams): number {
  const stepped = Math.round(px / params.tick) * params.tick;
  return Math.min(params.maxPx, Math.max(params.minPx, Number(stepped.toFixed(4))));
}

/**
 * Build a two-sided YES quote around fair value.
 * Inventory > 0 (long YES) shades bid/ask down; short shades up.
 */
export function buildStrikeQuote(opts: {
  ticker: string;
  floor: number;
  fair: FairValueState;
  inventoryYes?: number;
  minutesToClose?: number | null;
  params?: Partial<MmQuoteParams>;
}): StrikeQuote {
  const params: MmQuoteParams = { ...DEFAULT_MM_PARAMS, ...opts.params };
  const mode = quoteModeForMinutesToClose(opts.minutesToClose ?? null, params);
  const pYes = pYesAboveFloor(opts.fair.mu, opts.fair.sigma, opts.floor);
  const inv = opts.inventoryYes ?? 0;
  const mid = Math.min(
    params.maxPx,
    Math.max(params.minPx, pYes - inv * params.invSkewPerContract),
  );

  if (mode === "pull") {
    return {
      ticker: opts.ticker,
      floor: opts.floor,
      pYes,
      mid,
      yesBid: null,
      yesAsk: null,
      size: 0,
      mode,
      reason: `pull: ≤${params.pullMinutes}m to close`,
    };
  }

  const half = mode === "widen" ? params.widenHalfSpread : params.halfSpread;
  let bid = clampPx(mid - half, params);
  let ask = clampPx(mid + half, params);
  if (ask <= bid) {
    ask = clampPx(bid + params.tick, params);
  }
  // Don't quote one-sided junk near 0/1
  if (mid <= params.minPx + params.tick || mid >= params.maxPx - params.tick) {
    return {
      ticker: opts.ticker,
      floor: opts.floor,
      pYes,
      mid,
      yesBid: null,
      yesAsk: null,
      size: 0,
      mode,
      reason: "pull: fair near boundary",
    };
  }

  return {
    ticker: opts.ticker,
    floor: opts.floor,
    pYes,
    mid,
    yesBid: bid,
    yesAsk: ask,
    size: params.size,
    mode,
    reason:
      mode === "widen"
        ? `widen: ≤${params.lastMinutes}m to close (half=${half})`
        : `normal: half=${half} src=${opts.fair.source}`,
  };
}

export function buildLadderQuotes(opts: {
  strikes: Array<{ ticker: string; floor: number }>;
  fair: FairValueState;
  inventoryByTicker?: Record<string, number>;
  minutesToClose?: number | null;
  params?: Partial<MmQuoteParams>;
}): StrikeQuote[] {
  return opts.strikes.map((s) =>
    buildStrikeQuote({
      ticker: s.ticker,
      floor: s.floor,
      fair: opts.fair,
      inventoryYes: opts.inventoryByTicker?.[s.ticker] ?? 0,
      minutesToClose: opts.minutesToClose,
      params: opts.params,
    }),
  );
}
