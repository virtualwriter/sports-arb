// Shape-level backtest evidence (continuous rolling scan, Jun 16 onward).
// Covers BOTH soccer and MLB. Live soccer gate authority is enforced in the
// daemon via soccer-backtest-live-gate.ts; MLB live shapes come from the
// strategy-layer allowlist.

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

const KNOWN_MARKET_TYPES = new Set(["match_total", "spread", "game_total", "team_total"]);

function toBacktestShapeRow(row: RawShapeRow, enforcedLive: boolean): BacktestShapeRow | null {
  const asset = row.asset ?? "";
  if (asset !== "SOCCER" && asset !== "MLB") return null;
  const marketType = row.marketType ?? "unknown";
  if (!KNOWN_MARKET_TYPES.has(marketType)) return null;
  const lineFamily = row.lineFamily ?? "";
  const middleWidth = row.middleWidth ?? 0;
  if (!lineFamily || middleWidth <= 0) return null;
  const worstRoiPct = row.worstRoiPct ?? Number.NEGATIVE_INFINITY;
  return {
    sportId: asset,
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

function mlbShapeEnforcedLive(
  allowlist: StrategyAllowlistSnapshot,
  marketType: string,
  lineFamily: string,
  middleWidth: number,
): boolean {
  if (marketType === "game_total") return lineFamily in allowlist.mlb.gameTotalLineFamilies;
  if (marketType === "spread") return allowlist.mlb.spreadWidthsAllowed.includes(middleWidth);
  return false;
}

export function loadBacktestShapeEvidence(
  allowlist: StrategyAllowlistSnapshot,
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
    const enforcedLive = row.asset === "MLB"
      ? mlbShapeEnforcedLive(allowlist, marketType, lineFamily, middleWidth)
      : positive.has(backtestShapeKey(marketType, lineFamily, middleWidth));
    const parsed = toBacktestShapeRow(row, enforcedLive);
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => b.worstRoiPct - a.worstRoiPct);
  return out;
}

/** Keyed `${sportId}:${marketType}:${lineFamily}` — covers soccer AND MLB. */
export function backtestMiddleRateByFamily(shapes: BacktestShapeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const shape of shapes) {
    if (!shape.enforcedLive) continue;
    out.set(`${shape.sportId}:${shape.marketType}:${shape.lineFamily}`, shape.middleRate);
  }
  return out;
}

// The LLM sees the FULL shape table (both sports, live and shadow, positive
// and negative ROI) so it can reason about promotions/demotions — not just the
// currently-enforced slice. Capped by sample size to keep the prompt bounded.
const LLM_SHAPE_MIN_RESOLVED = 5;
const LLM_SHAPE_MAX_ROWS = 80;

export function compactBacktestShapesForLlm(shapes: BacktestShapeRow[]) {
  return shapes
    .filter((shape) => shape.enforcedLive || shape.resolved >= LLM_SHAPE_MIN_RESOLVED)
    .sort((a, b) => Number(b.enforcedLive) - Number(a.enforcedLive) || b.worstRoiPct - a.worstRoiPct)
    .slice(0, LLM_SHAPE_MAX_ROWS)
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
