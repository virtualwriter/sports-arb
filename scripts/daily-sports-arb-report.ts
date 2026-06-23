#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { summarizeEvidence } from "./lib/llm/learning.js";
import { PATHS, ensureParent, ensureStateDirs } from "./lib/paths.js";
import { readShadowPackages } from "./lib/shadow-ledger.js";
import { readJson, writeJson } from "./lib/storage.js";
import type { HealthSnapshot, SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeCsv(path: string, rows: Array<Record<string, unknown>>): void {
  ensureParent(path);
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))];
  writeFileSync(path, lines.join("\n") + "\n");
}

function tradeRows(packages: SportsArbPackage[]): Array<Record<string, unknown>> {
  return packages.map((pkg) => ({
    packageId: pkg.packageId,
    mode: pkg.mode,
    status: pkg.status,
    sportId: pkg.sport.sportId,
    league: pkg.sport.league,
    gender: pkg.sport.gender,
    adapterVersion: pkg.sport.adapterVersion,
    eventSlug: pkg.event.slug,
    marketType: pkg.strategy.marketType,
    lineFamily: pkg.strategy.lineFamily,
    middleWidth: pkg.strategy.middleWidth,
    costBucket: pkg.strategy.costBucket,
    comparisonGroup: pkg.strategy.comparisonGroup,
    shadowPurpose: pkg.shadowPurpose,
    packageCost: pkg.pricing.packageCost,
    lockedEdge: pkg.pricing.lockedEdge,
    availableShares: pkg.pricing.availableShares,
    targetUsd: pkg.sizing.targetUsd,
    intendedShares: pkg.sizing.intendedShares,
    resolutionStatus: pkg.resolution?.status,
    pnlUsd: pkg.resolution?.pnlUsd,
    roiPct: pkg.resolution?.roiPct,
  }));
}

function markdownReport(args: {
  live: SportsArbPackage[];
  shadows: SportsArbPackage[];
  health: HealthSnapshot;
}): string {
  const resolvedLive = args.live.filter((pkg) => pkg.resolution?.status === "resolved");
  const resolvedShadows = args.shadows.filter((pkg) => pkg.resolution?.status === "resolved");
  const openLive = args.live.filter((pkg) => !["resolved", "cancelled", "flattened"].includes(pkg.status));
  const openShadows = args.shadows.filter((pkg) => pkg.status === "shadow_open");
  const livePnl = resolvedLive.reduce((sum, pkg) => sum + (pkg.resolution?.pnlUsd ?? 0), 0);
  const shadowPnl = resolvedShadows.reduce((sum, pkg) => sum + (pkg.resolution?.pnlUsd ?? 0), 0);
  const evidence = summarizeEvidence([...resolvedLive, ...resolvedShadows]).slice(0, 12);
  return [
    `# Sports Arb Daily Report`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Portfolio / Trade Summary`,
    ``,
    `- Live packages open: ${openLive.length}`,
    `- Live packages resolved: ${resolvedLive.length}`,
    `- Live realized P&L: ${livePnl.toFixed(2)} USDC`,
    `- Shadow packages open: ${openShadows.length}`,
    `- Shadow packages resolved: ${resolvedShadows.length}`,
    `- Shadow hypothetical P&L: ${shadowPnl.toFixed(2)} USDC`,
    ``,
    `## Operations`,
    ``,
    `- Health: ${args.health.status}`,
    `- Large orphan active: ${args.health.largeOrphanActive}`,
    `- Kill switch active: ${args.health.killSwitchActive}`,
    `- Last scan: ${args.health.lastScanAt ?? "unknown"}`,
    `- Notes: ${args.health.notes.join("; ") || "none"}`,
    ``,
    `## Setup Family Evidence`,
    ``,
    ...evidence.map((row) => `- ${row.comparisonGroup}: n=${row.resolved}, winRate=${row.winRate === null ? "n/a" : (row.winRate * 100).toFixed(1) + "%"}, avgRoi=${row.avgRoiPct.toFixed(2)}%, promote=${row.promoteEligible}, kill=${row.killCandidate}`),
    ``,
    `## LLM Permissions`,
    ``,
    `DeepSeek may write journal/advice and suggest risk parameter changes. It may not enter trades, promote adapters, or unpause large-orphan incidents.`,
  ].join("\n");
}

export function buildDailyReport() {
  ensureStateDirs();
  const live = readJson<SportsArbPackage[]>(PATHS.livePackages, []);
  const shadows = readShadowPackages(50_000);
  const health = readJson<HealthSnapshot>(PATHS.health, {
    updatedAt: new Date().toISOString(),
    status: "ok",
    clobAuth: "unknown",
    websocket: "unknown",
    openPackages: live.length,
    largeOrphanActive: false,
    killSwitchActive: false,
    notes: [],
  });
  const markdown = markdownReport({ live, shadows, health });
  ensureParent(PATHS.dailyMarkdown);
  writeFileSync(PATHS.dailyMarkdown, markdown + "\n");
  writeCsv(PATHS.dailyCsv, [
    ...tradeRows(live),
    ...tradeRows(shadows),
  ]);
  writeJson(PATHS.excelManifest, {
    generatedAt: new Date().toISOString(),
    note: "Excel-compatible workbook manifest. Import the listed CSV sheets into Excel until a workbook dependency is added.",
    sheets: [
      { name: "combined_trades", path: PATHS.dailyCsv },
      { name: "live_packages", rows: live.length },
      { name: "shadow_packages", rows: shadows.length },
    ],
  });
  return { markdown, markdownPath: PATHS.dailyMarkdown, csvPath: PATHS.dailyCsv, excelManifestPath: PATHS.excelManifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = buildDailyReport();
  console.log(`[report] markdown=${report.markdownPath} csv=${report.csvPath} excelManifest=${report.excelManifestPath}`);
}
