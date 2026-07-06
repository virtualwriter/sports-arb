// Shape-level backtest evidence (Jun 16–Jul 3 continuous scan). Live soccer
// gate authority is enforced in the daemon via soccer-backtest-live-gate.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backtestShapeKey,
  loadSoccerBacktestPositiveShapes,
} from "../soccer-backtest-live-gate.js";
import type { StrategyAllowlistSnapshot } from "../sports-strategy.js";

export type BacktestShapeRow = {
  sportId: string;
  marketType: string;
  lineFamily: string;
  middleWidth: number;
  resolved: number;
  middles: number;
  middleRate: number;
  bestAvgCost: number;
  worstAvgCost: number;
  bestRoiPct: number;
  worstRoiPct: number;
  familyMaxLiveCost: number | null;
  enforcedLive: boolean;
};

const BACKTEST_SHAPE_PATH = join(process.cwd(), "analysis", "shape-roi-jun16-jul3-continuous.json");

type RawShapeRow = {
  asset?: string;
  marketType?: string;
  lineFamily?: string;
  middleWidth?: number;
  resolved?: number;
  middles?: number;
  middleRate?: number;
  bestAvgCost?: number;
  worstAvgCost?: number;
  bestRoiPct?: number;
  worstRoiPct?: number;
};

function toBacktestShapeRow(row: RawShapeRow, enforcedLive: boolean): BacktestShapeRow | null {
  if (row.asset !== "SOCCER") return null;
  const marketType = row.marketType ?? "unknown";
  if (marketType !== "match_total" && marketType !== "spread") return null;
  const lineFamily = row.lineFamily ?? "";
  const middleWidth = row.middleWidth ?? 0;
  if (!lineFamily || middleWidth <= 0) return null;
  const worstRoiPct = row.worstRoiPct ?? Number.NEGATIVE_INFINITY;
  return {
    sportId: "SOCCER",
    marketType,
    lineFamily,
    middleWidth,
    resolved: row.resolved ?? 0,
    middles: row.middles ?? 0,
    middleRate: row.middleRate ?? 0,
    bestAvgCost: row.bestAvgCost ?? 0,
    worstAvgCost: row.worstAvgCost ?? 0,
    bestRoiPct: row.bestRoiPct ?? 0,
    worstRoiPct,
    familyMaxLiveCost: enforcedLive ? row.worstAvgCost ?? null : null,
    enforcedLive,
  };
}

export function loadBacktestShapeEvidence(
  _allowlist: StrategyAllowlistSnapshot,
  path: string = BACKTEST_SHAPE_PATH,
): BacktestShapeRow[] {
  if (!existsSync(path)) return [];
  let payload: { rows?: RawShapeRow[] };
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as { rows?: RawShapeRow[] };
  } catch {
    return [];
  }
  const positive = loadSoccerBacktestPositiveShapes(path);
  const out: BacktestShapeRow[] = [];
  for (const row of payload.rows ?? []) {
    const marketType = row.marketType ?? "unknown";
    const lineFamily = row.lineFamily ?? "";
    const middleWidth = row.middleWidth ?? 0;
    const enforcedLive = positive.has(backtestShapeKey(marketType, lineFamily, middleWidth));
    const parsed = toBacktestShapeRow(row, enforcedLive);
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => b.worstRoiPct - a.worstRoiPct);
  return out;
}

export function backtestMiddleRateByFamily(shapes: BacktestShapeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const shape of shapes) {
    if (shape.marketType !== "match_total" || !shape.enforcedLive) continue;
    out.set(shape.lineFamily, shape.middleRate);
  }
  return out;
}

export function compactBacktestShapesForLlm(shapes: BacktestShapeRow[]) {
  return shapes
    .filter((shape) => shape.enforcedLive)
    .map((shape) => ({
      shape: `${shape.sportId}:${shape.marketType}:${shape.lineFamily}`,
      width: shape.middleWidth,
      n: shape.resolved,
      middleRatePct: round1(shape.middleRate * 100),
      worstRoiPct: round2(shape.worstRoiPct),
      bestRoiPct: round2(shape.bestRoiPct),
      worstAvgCost: round3(shape.worstAvgCost),
      familyMaxLiveCost: shape.familyMaxLiveCost,
      enforcedLive: shape.enforcedLive,
    }));
}

export function isSoccerBacktestEnforcedShape(
  marketType: string,
  lineFamily: string,
  middleWidth: number,
): boolean {
  return loadSoccerBacktestPositiveShapes().has(backtestShapeKey(marketType, lineFamily, middleWidth));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
