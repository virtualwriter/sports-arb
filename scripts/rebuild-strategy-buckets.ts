#!/usr/bin/env tsx
// Nightly aggregator: rebuilds the per-bucket live evidence snapshot used by
// the LLM learning pass and the morning operator review. Reads:
//   - Daemon ledger + archives (resolved live trades since Jun 23)
//   - analysis/monotonic-chronological-ledger-long.csv (frozen Jun 16-22)
//   - analysis/shape-roi-jun16-jul3-continuous.json (shape gate authority)
//   - Current sports-strategy.ts allowlist snapshot (always fresh)
// Writes:
//   - analysis/strategy-buckets-live.json (deterministic)
//   - analysis/strategy-changes-YYYY-MM-DD.md (human diff vs yesterday)
//
// This script never touches sports-strategy.ts. Gate changes are manual.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import type { LiveBucketStats, StrategyBucketsSnapshot } from "./lib/llm/bucket-aggregator.js";
import { buildStrategySnapshot } from "./lib/llm/strategy-snapshot.js";
import { loadDaemonSportsArbPackages } from "./lib/llm/daemon-bridge.js";
import { ensureParent, ensureStateDirs, REPO_ROOT } from "./lib/paths.js";

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

function formatSlippage(cents: number | null): string {
  if (cents == null) return "—";
  const sign = cents >= 0 ? "+" : "";
  return `${sign}${cents.toFixed(1)}¢`;
}

function formatBucketLine(b: LiveBucketStats): string {
  const tag = b.enforcedLive ? "LIVE" : "shadow";
  const flag = b.executionFlag === "hold" || b.executionFlag === "insufficient_evidence"
    ? ""
    : ` **[${b.executionFlag}]**`;
  const slip = b.slippageSampleCount > 0
    ? `, fill=${formatSlippage(b.avgFillSlippageCents)}`
    : "";
  const drift = b.preflightDriftSampleCount > 0
    ? `, preflight=${formatSlippage(b.avgPreflightDriftCents)}`
    : "";
  return `- \`${b.comparisonGroup}\` (${tag}, ${b.tier}, n=${b.resolved}, roi=${formatRoi(b.capitalWeightedRoiPct)}, middles=${b.middles}/${b.resolved}${slip}${drift})${flag}`;
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
  lines.push(`Allowlist snapshot: ${current.allowlist.generatedAt}`);
  lines.push(`Total resolved packages (live ledger): ${current.totalResolvedPackages}`);
  if (previous) lines.push(`Previous snapshot: ${previous.generatedAt} (${previous.totalResolvedPackages} resolved)`);
  lines.push("");
  lines.push("_Gate authority: backtest shapes in \`shape-roi-jun16-jul3-continuous.json\`. Live buckets are execution monitoring only._");
  lines.push("");

  const slippage = current.buckets.filter((b) => b.executionFlag === "slippage_concern");
  const middleGap = current.buckets.filter((b) => b.executionFlag === "middle_rate_gap");
  const execReview = current.buckets.filter((b) => b.executionFlag === "execution_review");
  const newBuckets = current.buckets.filter((b) => !prev.has(bucketKey(b)));
  const growth = current.buckets
    .map((b) => ({ b, p: prev.get(bucketKey(b)) }))
    .filter((entry) => entry.p && entry.b.resolved > entry.p.resolved)
    .map((entry) => ({ ...entry, delta: entry.b.resolved - (entry.p?.resolved ?? 0) }))
    .sort((a, b) => b.delta - a.delta);

  lines.push("## Backtest gate shapes (authority)");
  lines.push("");
  lines.push("| Shape | n | Middle rate | ROI@worst | Family max cost |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const shape of current.backtestShapes) {
    lines.push(`| \`SOCCER:match_total:${shape.lineFamily}\` | ${shape.resolved} | ${(shape.middleRate * 100).toFixed(1)}% | ${formatRoi(shape.worstRoiPct)} | ${shape.familyMaxLiveCost ?? "—"} |`);
  }
  lines.push("");

  lines.push("## Execution alerts (live monitoring)");
  lines.push("");
  if (slippage.length === 0 && middleGap.length === 0 && execReview.length === 0) {
    lines.push("_No execution alerts on enforced-live buckets._");
  } else {
    if (slippage.length > 0) {
      lines.push("### Slippage concern");
      for (const b of slippage) lines.push(formatBucketLine(b));
      lines.push("");
    }
    if (middleGap.length > 0) {
      lines.push("### Middle rate gap vs backtest");
      for (const b of middleGap) lines.push(formatBucketLine(b));
      lines.push("");
    }
    if (execReview.length > 0) {
      lines.push("### Execution review (live loss — check fill vs scan, not auto-demote)");
      for (const b of execReview) lines.push(formatBucketLine(b));
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
  lines.push("| Bucket | Enforced | Tier | n | Cap ROI | Fill slip | Middle rate | Execution flag |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const b of current.buckets) {
    const mr = b.middleRate == null ? "—" : `${(b.middleRate * 100).toFixed(0)}%`;
    lines.push(`| \`${b.comparisonGroup}\` | ${b.enforcedLive ? "live" : "shadow"} | ${b.tier} | ${b.resolved} | ${formatRoi(b.capitalWeightedRoiPct)} | ${formatSlippage(b.avgFillSlippageCents)} | ${mr} | ${b.executionFlag} |`);
  }
  lines.push("");

  ensureParent(outPath);
  writeFileSync(outPath, lines.join("\n"), "utf8");
}

async function main() {
  ensureStateDirs();
  const packages = await loadDaemonSportsArbPackages();
  const snapshot = buildStrategySnapshot(packages);
  const previous = loadPreviousSnapshot() ?? findMostRecentHistoryBefore(todayUtc());

  ensureParent(SNAPSHOT_PATH);
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  const historyPath = join(HISTORY_DIR, `strategy-buckets-${todayUtc()}.json`);
  ensureParent(historyPath);
  writeFileSync(historyPath, JSON.stringify(snapshot, null, 2), "utf8");

  const diffPath = join(ANALYSIS_DIR, `strategy-changes-${todayUtc()}.md`);
  writeDiffMarkdown(snapshot, previous, diffPath);

  console.log(`[strategy-rebuild] resolved=${snapshot.totalResolvedPackages} buckets=${snapshot.buckets.length} backtestShapes=${snapshot.backtestShapes.length}`);
  console.log(`[strategy-rebuild] wrote ${SNAPSHOT_PATH}`);
  console.log(`[strategy-rebuild] wrote ${diffPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
