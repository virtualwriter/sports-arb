import { PATHS } from "../paths.js";
import { readJson, writeJson } from "../storage.js";
import type { SportsArbPackage } from "../types.js";

export const PROMOTE_THRESHOLD = 0.65;
export const PROMOTE_MIN_TESTS = 20;
export const KILL_THRESHOLD = 0.40;
export const DEMOTE_THRESHOLD = 0.55;

export type SetupFamilyEvidence = {
  comparisonGroup: string;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgRoiPct: number;
  promoteEligible: boolean;
  killCandidate: boolean;
};

export type LlmState = {
  updatedAt: string;
  dailyCallCounts: Record<string, number>;
  lastCallAt?: string;
  lastJournal?: string;
};

export function summarizeEvidence(packages: SportsArbPackage[]): SetupFamilyEvidence[] {
  const grouped = new Map<string, { resolved: number; wins: number; losses: number; roi: number }>();
  for (const pkg of packages) {
    if (pkg.resolution?.status !== "resolved") continue;
    const key = pkg.strategy.comparisonGroup;
    const row = grouped.get(key) ?? { resolved: 0, wins: 0, losses: 0, roi: 0 };
    row.resolved += 1;
    if ((pkg.resolution.roiPct ?? 0) > 0) row.wins += 1;
    else row.losses += 1;
    row.roi += pkg.resolution.roiPct ?? 0;
    grouped.set(key, row);
  }
  return [...grouped.entries()].map(([comparisonGroup, row]) => {
    const winRate = row.resolved > 0 ? row.wins / row.resolved : null;
    const avgRoiPct = row.resolved > 0 ? row.roi / row.resolved : 0;
    return {
      comparisonGroup,
      resolved: row.resolved,
      wins: row.wins,
      losses: row.losses,
      winRate,
      avgRoiPct,
      promoteEligible: row.resolved >= PROMOTE_MIN_TESTS && winRate !== null && winRate >= PROMOTE_THRESHOLD && avgRoiPct > 0,
      killCandidate: row.resolved >= PROMOTE_MIN_TESTS && winRate !== null && winRate < KILL_THRESHOLD,
    };
  }).sort((a, b) => (b.avgRoiPct - a.avgRoiPct) || b.resolved - a.resolved);
}

export function readLlmState(): LlmState {
  return readJson<LlmState>(PATHS.llmState, { updatedAt: "", dailyCallCounts: {} });
}

export function writeLlmJournal(journal: string): void {
  const state = readLlmState();
  writeJson(PATHS.llmState, {
    ...state,
    updatedAt: new Date().toISOString(),
    lastCallAt: new Date().toISOString(),
    lastJournal: journal,
  });
}
