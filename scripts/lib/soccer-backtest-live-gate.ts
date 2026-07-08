// Daemon-layer live gate for SOCCER and MLB: a shape trades live only when the
// continuous backtest says it is positive-ROI at worst observed costs, and the
// candidate's cost clears BOTH caps:
//   1. shape worstAvgCost (the price population the backtest ROI was earned on)
//   2. an EV-margin cap: cost <= (1 + middleRate) / (1 + EV_MARGIN), so every
//      entry carries a minimum expected ROI using the shape's own middle rate.
// The margin exists because live fills adversely select toward no-middle games
// (live middle rate ran ~5pp below backtest); trading at backtest breakeven
// converts that selection gap directly into losses.
//
// The shape file is regenerated nightly with a growing window; the cache is
// mtime-keyed so the daemon picks up every rebuild without a restart.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./monotonic-arb-core.js";
import type { MarketType } from "./types.js";

export type SportsBacktestShape = {
  asset: string;
  marketType: string;
  lineFamily: string;
  middleWidth: number;
  resolved: number;
  middleRate: number;
  worstRoiPct: number;
  worstAvgCost: number;
  /** Effective live cost cap after applying the EV margin. */
  maxLiveCost: number;
};

type RawShapeRow = {
  asset?: string;
  marketType?: string;
  lineFamily?: string;
  middleWidth?: number;
  resolved?: number;
  middleRate?: number;
  worstRoiPct?: number;
  worstAvgCost?: number;
};

const GATED_ASSETS = new Set(["SOCCER", "MLB"]);
const ALLOWED_MARKET_TYPES: Record<string, Set<string>> = {
  SOCCER: new Set(["match_total", "spread"]),
  MLB: new Set(["game_total", "spread"]),
};

const MIN_RESOLVED = Number(
  process.env.ARB_DAEMON_SPORTS_BACKTEST_MIN_RESOLVED
  ?? process.env.ARB_DAEMON_SOCCER_BACKTEST_MIN_RESOLVED
  ?? 8,
);
const COST_TOLERANCE = Number(process.env.ARB_DAEMON_SOCCER_BACKTEST_COST_TOLERANCE ?? 0.005);
// Minimum expected ROI at entry cost, computed from the shape's backtest
// middle rate: expected payout per share = 1 + middleRate.
const EV_MARGIN = Number(process.env.ARB_DAEMON_SPORTS_BACKTEST_EV_MARGIN ?? 0.03);
const BACKTEST_SHAPE_PATH = process.env.ARB_DAEMON_SOCCER_BACKTEST_SHAPE_PATH
  ?? join(process.cwd(), "analysis", "shape-roi-jun16-jul3-continuous.json");

// The nightly strategy-rebuild service regenerates the shape file while the
// daemon keeps running, so the cache is keyed on file mtime: every nightly
// rebuild is picked up automatically without a daemon restart.
let cachedPositiveShapes: Map<string, SportsBacktestShape> | null = null;
let cachedShapesMtimeMs: number | null = null;
let lastMtimeCheckMs = 0;
const MTIME_CHECK_INTERVAL_MS = 60_000;

function shapeFileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function formatStrike(strike: number): string {
  return String(strike);
}

/** Match Python shape_roi_best_worst.classify_shape family formatting. */
export function backtestLineFamily(candidate: Candidate, marketType: MarketType | string): string {
  let low = Math.min(candidate.broad.strike, candidate.narrow.strike);
  let high = Math.max(candidate.broad.strike, candidate.narrow.strike);
  if (marketType === "spread" && low > 0 && high > 0) {
    low = -high;
    high = -Math.min(candidate.broad.strike, candidate.narrow.strike);
  }
  return `${formatStrike(low)}-${formatStrike(high)}`;
}

export function backtestMiddleWidth(candidate: Candidate): number {
  const low = Math.min(candidate.broad.strike, candidate.narrow.strike);
  const high = Math.max(candidate.broad.strike, candidate.narrow.strike);
  return Math.round(high - low);
}

export function backtestShapeKey(
  asset: string,
  marketType: string,
  lineFamily: string,
  middleWidth: number,
): string {
  return `${asset}|${marketType}|${lineFamily}|w${middleWidth}`;
}

export function evMarginMaxCost(middleRate: number, margin: number = EV_MARGIN): number {
  return (1 + middleRate) / (1 + margin);
}

export function loadSportsBacktestPositiveShapes(
  path: string = BACKTEST_SHAPE_PATH,
): Map<string, SportsBacktestShape> {
  const now = Date.now();
  if (cachedPositiveShapes && now - lastMtimeCheckMs < MTIME_CHECK_INTERVAL_MS) {
    return cachedPositiveShapes;
  }
  lastMtimeCheckMs = now;
  const mtimeMs = shapeFileMtimeMs(path);
  if (cachedPositiveShapes && mtimeMs === cachedShapesMtimeMs) {
    return cachedPositiveShapes;
  }
  cachedShapesMtimeMs = mtimeMs;
  const out = new Map<string, SportsBacktestShape>();
  if (!existsSync(path)) {
    cachedPositiveShapes = out;
    return out;
  }
  let payload: { rows?: RawShapeRow[] };
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as { rows?: RawShapeRow[] };
  } catch {
    cachedPositiveShapes = out;
    return out;
  }
  for (const row of payload.rows ?? []) {
    const asset = row.asset ?? "";
    if (!GATED_ASSETS.has(asset)) continue;
    const marketType = row.marketType ?? "unknown";
    if (!ALLOWED_MARKET_TYPES[asset]?.has(marketType)) continue;
    const resolved = row.resolved ?? 0;
    const worstRoiPct = row.worstRoiPct ?? Number.NEGATIVE_INFINITY;
    if (resolved < MIN_RESOLVED || worstRoiPct <= 0) continue;
    const lineFamily = row.lineFamily ?? "";
    const middleWidth = row.middleWidth ?? 0;
    if (!lineFamily || middleWidth <= 0) continue;
    const middleRate = row.middleRate ?? 0;
    const worstAvgCost = row.worstAvgCost ?? Number.POSITIVE_INFINITY;
    out.set(backtestShapeKey(asset, marketType, lineFamily, middleWidth), {
      asset,
      marketType,
      lineFamily,
      middleWidth,
      resolved,
      middleRate,
      worstRoiPct,
      worstAvgCost,
      maxLiveCost: Math.min(worstAvgCost, evMarginMaxCost(middleRate)),
    });
  }
  cachedPositiveShapes = out;
  return out;
}

export function resetSportsBacktestShapeCacheForTests(): void {
  cachedPositiveShapes = null;
  cachedShapesMtimeMs = null;
  lastMtimeCheckMs = 0;
}

export function sportsBacktestLiveGateBlock(
  candidate: Candidate,
  marketType: MarketType | string,
): string | null {
  const asset = candidate.asset;
  if (!GATED_ASSETS.has(asset)) return null;
  if (!ALLOWED_MARKET_TYPES[asset]?.has(String(marketType))) {
    return `sports_backtest_gate_market_type=${marketType}`;
  }
  const lineFamily = backtestLineFamily(candidate, marketType);
  const middleWidth = backtestMiddleWidth(candidate);
  const shape = loadSportsBacktestPositiveShapes().get(
    backtestShapeKey(asset, String(marketType), lineFamily, middleWidth),
  );
  if (!shape) {
    return `sports_backtest_shape_not_positive asset=${asset} type=${marketType} family=${lineFamily} width=${middleWidth}`;
  }
  if (candidate.packageCost > shape.maxLiveCost + COST_TOLERANCE) {
    return `sports_backtest_cost_above_ev_cap cost=${candidate.packageCost.toFixed(4)} cap=${shape.maxLiveCost.toFixed(4)} worstAvg=${shape.worstAvgCost.toFixed(4)} midRate=${(shape.middleRate * 100).toFixed(1)}% shape=${asset}:${marketType}:${lineFamily}:w${middleWidth}`;
  }
  return null;
}
