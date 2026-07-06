// Daemon-layer live gate for soccer: allow shapes with positive backtest ROI@worst
// at or below the backtest worst-case average cost for that shape.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./monotonic-arb-core.js";
import type { MarketType } from "./types.js";

export type SoccerBacktestShape = {
  marketType: string;
  lineFamily: string;
  middleWidth: number;
  resolved: number;
  worstRoiPct: number;
  worstAvgCost: number;
};

type RawShapeRow = {
  asset?: string;
  marketType?: string;
  lineFamily?: string;
  middleWidth?: number;
  resolved?: number;
  worstRoiPct?: number;
  worstAvgCost?: number;
};

const MIN_RESOLVED = Number(process.env.ARB_DAEMON_SOCCER_BACKTEST_MIN_RESOLVED ?? 5);
const COST_TOLERANCE = Number(process.env.ARB_DAEMON_SOCCER_BACKTEST_COST_TOLERANCE ?? 0.005);
const BACKTEST_SHAPE_PATH = process.env.ARB_DAEMON_SOCCER_BACKTEST_SHAPE_PATH
  ?? join(process.cwd(), "analysis", "shape-roi-jun16-jul3-continuous.json");

let cachedPositiveShapes: Map<string, SoccerBacktestShape> | null = null;

function formatStrike(strike: number): string {
  return Number.isInteger(strike) ? String(strike) : String(strike);
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

export function backtestShapeKey(marketType: string, lineFamily: string, middleWidth: number): string {
  return `${marketType}|${lineFamily}|w${middleWidth}`;
}

export function loadSoccerBacktestPositiveShapes(path: string = BACKTEST_SHAPE_PATH): Map<string, SoccerBacktestShape> {
  if (cachedPositiveShapes) return cachedPositiveShapes;
  const out = new Map<string, SoccerBacktestShape>();
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
    if (row.asset !== "SOCCER") continue;
    const resolved = row.resolved ?? 0;
    const worstRoiPct = row.worstRoiPct ?? Number.NEGATIVE_INFINITY;
    if (resolved < MIN_RESOLVED || worstRoiPct <= 0) continue;
    const marketType = row.marketType ?? "unknown";
    const lineFamily = row.lineFamily ?? "";
    const middleWidth = row.middleWidth ?? 0;
    if (!lineFamily || middleWidth <= 0) continue;
    out.set(backtestShapeKey(marketType, lineFamily, middleWidth), {
      marketType,
      lineFamily,
      middleWidth,
      resolved,
      worstRoiPct,
      worstAvgCost: row.worstAvgCost ?? Number.POSITIVE_INFINITY,
    });
  }
  cachedPositiveShapes = out;
  return out;
}

export function resetSoccerBacktestShapeCacheForTests(): void {
  cachedPositiveShapes = null;
}

export function soccerBacktestLiveGateBlock(
  candidate: Candidate,
  marketType: MarketType | string,
): string | null {
  if (candidate.asset !== "SOCCER") return null;
  if (marketType !== "match_total" && marketType !== "spread") {
    return `soccer_backtest_gate_market_type=${marketType}`;
  }
  const lineFamily = backtestLineFamily(candidate, marketType);
  const middleWidth = backtestMiddleWidth(candidate);
  const shape = loadSoccerBacktestPositiveShapes().get(backtestShapeKey(marketType, lineFamily, middleWidth));
  if (!shape) {
    return `soccer_backtest_shape_not_positive type=${marketType} family=${lineFamily} width=${middleWidth}`;
  }
  if (candidate.packageCost > shape.worstAvgCost + COST_TOLERANCE) {
    return `soccer_backtest_cost_above_positive_roi cost=${candidate.packageCost.toFixed(4)} max=${shape.worstAvgCost.toFixed(4)} shape=${marketType}:${lineFamily}:w${middleWidth}`;
  }
  return null;
}
