#!/usr/bin/env tsx
import { appendFileSync } from "node:fs";
import { config } from "dotenv";
import { loadDaemonSportsArbPackages } from "./lib/llm/daemon-bridge.js";
import { requestDeepSeek } from "./lib/llm/deepseek.js";
import { compactBacktestShapesForLlm } from "./lib/llm/backtest-shape-evidence.js";
import { summarizeEvidence, writeLlmJournal } from "./lib/llm/learning.js";
import type { StrategyBucketsSnapshot } from "./lib/llm/bucket-aggregator.js";
import { buildStrategySnapshot } from "./lib/llm/strategy-snapshot.js";
import { PATHS, ensureParent, ensureStateDirs } from "./lib/paths.js";
import { readShadowPackages } from "./lib/shadow-ledger.js";
import { readJson } from "./lib/storage.js";
import type { HealthSnapshot, SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

function compactContext(
  live: SportsArbPackage[],
  shadows: SportsArbPackage[],
  health: HealthSnapshot,
  strategy: StrategyBucketsSnapshot,
): string {
  const evidence = summarizeEvidence([...live, ...shadows]).slice(0, 20);
  const enforcedLiveBuckets = strategy.buckets
    .filter((b) => b.enforcedLive)
    .map((b) => ({
      bucket: b.comparisonGroup,
      tier: b.tier,
      n: b.resolved,
      middles: b.middles,
      middleRatePct: b.middleRate == null ? null : round1(b.middleRate * 100),
      capRoi: b.capitalWeightedRoiPct,
      avgFillSlippageCents: b.avgFillSlippageCents,
      avgPreflightDriftCents: b.avgPreflightDriftCents,
      slippageSampleCount: b.slippageSampleCount,
      executionFlag: b.executionFlag,
      lastResolvedAt: b.lastResolvedAt,
    }));
  const executionAlerts = enforcedLiveBuckets.filter(
    (b) => b.executionFlag !== "hold" && b.executionFlag !== "insufficient_evidence",
  );
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    health,
    live: {
      open: live.filter((pkg) => !["resolved", "cancelled", "flattened"].includes(pkg.status)).length,
      resolved: live.filter((pkg) => pkg.resolution?.status === "resolved").length,
    },
    shadows: {
      open: shadows.filter((pkg) => pkg.status === "shadow_open").length,
      resolved: shadows.filter((pkg) => pkg.resolution?.status === "resolved").length,
    },
    gateAuthority: {
      source: "shape-roi-jun16-jul3-continuous.json + sports-strategy.ts",
      note: "Gates are derived from backtest shape ROI@worst and per-family fill caps. Live PnL alone must NOT drive gate removals.",
      currentAllowlist: strategy.allowlist,
      backtestShapes: compactBacktestShapesForLlm(strategy.backtestShapes),
    },
    frozenBaselineCostBuckets: strategy.baseline,
    liveExecutionMonitoring: {
      enforcedLiveBuckets,
      executionAlerts,
      thresholds: strategy.thresholds,
    },
    setupFamilyEvidence: evidence,
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const SYSTEM_PROMPT = [
  "You are the sports monotonic arbitrage strategy analyst.",
  "Gate authority (what shapes/costs should be live) comes ONLY from backtestShape evidence and currentAllowlist in gateAuthority — both are rebuilt from sports-strategy.ts on every run.",
  "The live ledger (liveExecutionMonitoring) is for execution quality monitoring ONLY: slippage, preflight drift, middle-rate collapse vs backtest, fill-vs-scan gaps.",
  "NEVER recommend removing or demoting a backtest-positive shape solely because live capRoi is negative.",
  "When live loses on a backtest-positive enforced shape with low slippage, diagnose execution/population mismatch (paying above scan cost, low middle rate), not a bad gate.",
  "When executionFlag is slippage_concern or middle_rate_gap, explain the execution issue and suggest operational fixes (timing, preflight freshness, fill caps) — not gate removal.",
  "When executionFlag is execution_review, note the live/backtest gap and recommend monitoring or join analysis — not automatic demotion.",
  "You may affirm that current gates align with backtest when backtestShapes show positive worstRoiPct under familyMaxLiveCost.",
  "You may suggest bounded gate tweaks ONLY when backtest shape evidence itself is weak (negative worstRoiPct at enforced cost cap) or a shape is not in backtestShapes.",
  "You may not enter trades, promote adapters, or unpause orphan incidents.",
  "Output sections in order:",
  "(1) Gate alignment — how currentAllowlist maps to backtestShapes (one bullet per enforced family).",
  "(2) Execution gaps — only buckets with executionFlag != hold and != insufficient_evidence; compare live middleRatePct to backtest middleRatePct.",
  "(3) Monitoring — what to watch next (no gate demotions from live PnL alone).",
  "(4) Optional backtest-driven gate tweaks — only if backtest worstRoiPct is negative at the enforced cap; otherwise say none needed.",
  "Concise bullets.",
].join(" ");

async function main() {
  ensureStateDirs();
  const daemonLive = await loadDaemonSportsArbPackages();
  const legacyLive = readJson<SportsArbPackage[]>(PATHS.livePackages, []);
  const live = daemonLive.length > 0 ? daemonLive : legacyLive;
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
  const strategy = buildStrategySnapshot(live);
  const context = compactContext(live, shadows, health, strategy);
  const learnModel = process.env.SPORTS_ARB_LLM_LEARN_MODEL ?? "deepseek-chat";
  const result = await requestDeepSeek([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: context },
  ], { model: learnModel });
  if (!result.text.trim()) {
    console.warn(`[llm] empty response from ${result.model}; skipping journal append`);
    return;
  }
  const journal = `\n\n## ${result.calledAt} (${result.model})\n\n${result.text}\n`;
  ensureParent(PATHS.learningJournal);
  appendFileSync(PATHS.learningJournal, journal);
  writeLlmJournal(result.text);
  console.log(`[llm] wrote ${PATHS.learningJournal} (allowlist=${strategy.allowlist.generatedAt})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
