#!/usr/bin/env tsx
// Nightly aggregator: rebuilds the per-bucket live evidence snapshot used by
// the LLM learning pass and the morning operator review. Reads:
//   - Daemon ledger + archives (resolved live trades since Jun 23)
//   - analysis/monotonic-chronological-ledger-long.csv (frozen Jun 16-22)
//   - Current sports-strategy.ts allowlist snapshot
// Writes:
//   - analysis/strategy-buckets-live.json (deterministic)
//   - analysis/strategy-changes-YYYY-MM-DD.md (human diff vs yesterday)
//
// This script never touches sports-strategy.ts. Promote/demote recommendations
// are advisory only -- the operator decides when (if ever) to edit the gate.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import {
  aggregateLiveBuckets,
  type LiveBucketStats,
  type StrategyBucketsSnapshot,
} from "./lib/llm/bucket-aggregator.js";
import { loadBaselineBuckets } from "./lib/llm/baseline-evidence.js";
import { loadDaemonSportsArbPackages } from "./lib/llm/daemon-bridge.js";
import { ensureParent, ensureStateDirs, REPO_ROOT } from "./lib/paths.js";
import { currentStrategyAllowlist } from "./lib/sports-strategy.js";

config({ path: "config.env" });
config({ path: ".env" });

const ANALYSIS_DIR = join(REPO_ROOT, "analysis");
const SNAPSHOT_PATH = join(ANALYSIS_DIR, "strategy-buckets-live.json");
const HISTORY_DIR = join(ANALYSIS_DIR, "strategy-buckets-history");

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadPreviousSnapshot(): StrategyBucketsSnapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as StrategyBucketsSnapshot;
  } catch {
    return null;
  }
}

function findMostRecentHistoryBefore(today: string): StrategyBucketsSnapshot | null {
  if (!existsSync(HISTORY_DIR)) return null;
  const files = readdirSync(HISTORY_DIR)
    .filter((name) => name.endsWith(".json") && name < `strategy-buckets-${today}.json`)
    .sort();
  const last = files.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(readFileSync(join(HISTORY_DIR, last), "utf8")) as StrategyBucketsSnapshot;
  } catch {
    return null;
  }
}

function bucketKey(b: LiveBucketStats): string {
  return b.comparisonGroup;
}

function bucketsByKey(snap: StrategyBucketsSnapshot | null): Map<string, LiveBucketStats> {
  const out = new Map<string, LiveBucketStats>();
  if (!snap) return out;
  for (const b of snap.buckets) out.set(bucketKey(b), b);
  return out;
}

function formatRoi(roi: number): string {
  const sign = roi >= 0 ? "+" : "";
  return `${sign}${roi.toFixed(2)}%`;
}

function formatBucketLine(b: LiveBucketStats): string {
  const tag = b.enforcedLive ? "LIVE" : "shadow";
  const rec = b.recommendation === "hold" ? "" : ` **[${b.recommendation}]**`;
  return `- \`${b.comparisonGroup}\` (${tag}, ${b.tier}, n=${b.resolved}, roi=${formatRoi(b.capitalWeightedRoiPct)}, middles=${b.middles}/${b.resolved})${rec}`;
}

function writeDiffMarkdown(
  current: StrategyBucketsSnapshot,
  previous: StrategyBucketsSnapshot | null,
  outPath: string,
): void {
  const prev = bucketsByKey(previous);
  const lines: string[] = [];
  lines.push(`# Strategy buckets diff — ${todayUtc()}`);
  lines.push("");
  lines.push(`Generated: ${current.generatedAt}`);
  lines.push(`Total resolved packages (live ledger): ${current.totalResolvedPackages}`);
  if (previous) lines.push(`Previous snapshot: ${previous.generatedAt} (${previous.totalResolvedPackages} resolved)`);
  lines.push("");

  const promote = current.buckets.filter((b) => b.recommendation === "promote_candidate");
  const demote = current.buckets.filter((b) => b.recommendation === "demote_candidate");
  const newBuckets = current.buckets.filter((b) => !prev.has(bucketKey(b)));
  const growth = current.buckets
    .map((b) => ({ b, p: prev.get(bucketKey(b)) }))
    .filter((entry) => entry.p && entry.b.resolved > entry.p.resolved)
    .map((entry) => ({ ...entry, delta: entry.b.resolved - (entry.p?.resolved ?? 0) }))
    .sort((a, b) => b.delta - a.delta);

  lines.push("## Recommendations (actionable)");
  lines.push("");
  if (demote.length === 0 && promote.length === 0) {
    lines.push("_No actionable recommendations. All actionable-tier buckets currently align with the enforced allowlist._");
  } else {
    if (demote.length > 0) {
      lines.push("### Demote candidates (enforced live but losing money)");
      for (const b of demote) lines.push(formatBucketLine(b));
      lines.push("");
    }
    if (promote.length > 0) {
      lines.push("### Promote candidates (not enforced but live evidence is strong)");
      for (const b of promote) lines.push(formatBucketLine(b));
      lines.push("");
    }
  }
  lines.push("");

  lines.push("## New buckets observed since last snapshot");
  lines.push("");
  if (newBuckets.length === 0) lines.push("_None._");
  else for (const b of newBuckets) lines.push(formatBucketLine(b));
  lines.push("");

  lines.push("## Buckets with new resolutions");
  lines.push("");
  if (growth.length === 0) lines.push("_No bucket gained new resolved packages since last snapshot._");
  else {
    for (const { b, delta, p } of growth) {
      const prevRoi = p ? formatRoi(p.capitalWeightedRoiPct) : "n/a";
      lines.push(`- \`${b.comparisonGroup}\` +${delta} (now n=${b.resolved}, roi ${prevRoi} -> ${formatRoi(b.capitalWeightedRoiPct)})`);
    }
  }
  lines.push("");

  lines.push("## All buckets at-a-glance");
  lines.push("");
  lines.push("| Bucket | Enforced | Tier | n | Cap ROI | Win rate | Middle rate | Recommendation |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const b of current.buckets) {
    const wr = b.winRate == null ? "—" : `${(b.winRate * 100).toFixed(0)}%`;
    const mr = b.middleRate == null ? "—" : `${(b.middleRate * 100).toFixed(0)}%`;
    lines.push(`| \`${b.comparisonGroup}\` | ${b.enforcedLive ? "live" : "shadow"} | ${b.tier} | ${b.resolved} | ${formatRoi(b.capitalWeightedRoiPct)} | ${wr} | ${mr} | ${b.recommendation} |`);
  }
  lines.push("");

  lines.push("## Frozen baseline (Jun 16-22, n=4458) for context");
  lines.push("");
  lines.push("| Cost bucket | n | Middle rate | Realized ROI |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const b of current.baseline) {
    lines.push(`| ${b.bucket} | ${b.resolved} | ${(b.middleRate * 100).toFixed(1)}% | ${formatRoi(b.realizedRoiPct)} |`);
  }
  lines.push("");

  ensureParent(outPath);
  writeFileSync(outPath, lines.join("\n"), "utf8");
}

async function main() {
  ensureStateDirs();
  const allowlist = currentStrategyAllowlist();
  const baseline = loadBaselineBuckets();
  if (baseline.length === 0) {
    console.warn("[strategy-rebuild] warning: baseline CSV missing or empty; LLM context will lack pre-Jun-22 reference");
  }

  const packages = await loadDaemonSportsArbPackages();
  const snapshot = aggregateLiveBuckets(packages, allowlist, baseline);
  const previous = loadPreviousSnapshot() ?? findMostRecentHistoryBefore(todayUtc());

  ensureParent(SNAPSHOT_PATH);
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  // Keep a dated copy so day-over-day diffs survive even if SNAPSHOT_PATH is
  // overwritten before the operator reads it.
  const historyPath = join(HISTORY_DIR, `strategy-buckets-${todayUtc()}.json`);
  ensureParent(historyPath);
  writeFileSync(historyPath, JSON.stringify(snapshot, null, 2), "utf8");

  const diffPath = join(ANALYSIS_DIR, `strategy-changes-${todayUtc()}.md`);
  writeDiffMarkdown(snapshot, previous, diffPath);

  console.log(`[strategy-rebuild] resolved=${snapshot.totalResolvedPackages} buckets=${snapshot.buckets.length}`);
  console.log(`[strategy-rebuild] wrote ${SNAPSHOT_PATH}`);
  console.log(`[strategy-rebuild] wrote ${diffPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
