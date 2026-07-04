// Shape-level backtest evidence (Jun 16–Jul 3 continuous scan). This is the
// authoritative source for live gate design in sports-strategy.ts — not the
// live ledger.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  /** Per-family max fill cost from current allowlist, when applicable. */
  familyMaxLiveCost: number | null;
  enforcedLive: boolean;
};

const BACKTEST_SHAPE_PATH = join(process.cwd(), "analysis", "shape-roi-jun16-jul3-continuous.json");

/** Primary middle width per soccer match-total family in the frozen doc. */
const SOCCER_FAMILY_PRIMARY_WIDTH: Record<string, number> = {
  "2.5-4.5": 2,
  "2.5-5.5": 3,
  "2.5-6.5": 4,
  "3.5-5.5": 2,
  "3.5-6.5": 3,
};

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

function pickPrimaryRow(rows: RawShapeRow[], family: string, allowedWidths: number[]): RawShapeRow | null {
  const candidates = rows.filter((row) => row.lineFamily === family && allowedWidths.includes(row.middleWidth ?? -1));
  if (candidates.length === 0) return null;
  const preferredWidth = SOCCER_FAMILY_PRIMARY_WIDTH[family];
  const preferred = candidates.find((row) => row.middleWidth === preferredWidth);
  if (preferred) return preferred;
  return candidates.sort((a, b) => (b.resolved ?? 0) - (a.resolved ?? 0))[0] ?? null;
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
  const rawRows = (payload.rows ?? []).filter(
    (row) => row.asset === "SOCCER" && row.marketType === "match_total",
  );
  const families = allowlist.soccer.matchTotalLineFamilies;
  const widths = allowlist.soccer.matchTotalWidthsAllowed;
  const out: BacktestShapeRow[] = [];
  for (const family of families) {
    const row = pickPrimaryRow(rawRows, family, widths);
    if (!row) continue;
    const familyMax = allowlist.soccer.matchTotalFamilyMaxLiveCost[family] ?? null;
    out.push({
      sportId: "SOCCER",
      marketType: "match_total",
      lineFamily: family,
      middleWidth: row.middleWidth ?? 0,
      resolved: row.resolved ?? 0,
      middles: row.middles ?? 0,
      middleRate: row.middleRate ?? 0,
      bestAvgCost: row.bestAvgCost ?? 0,
      worstAvgCost: row.worstAvgCost ?? 0,
      bestRoiPct: row.bestRoiPct ?? 0,
      worstRoiPct: row.worstRoiPct ?? 0,
      familyMaxLiveCost: familyMax,
      enforcedLive: familyMax != null,
    });
  }
  out.sort((a, b) => b.worstRoiPct - a.worstRoiPct);
  return out;
}

export function backtestMiddleRateByFamily(shapes: BacktestShapeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const shape of shapes) out.set(shape.lineFamily, shape.middleRate);
  return out;
}

export function compactBacktestShapesForLlm(shapes: BacktestShapeRow[]) {
  return shapes.map((shape) => ({
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

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
