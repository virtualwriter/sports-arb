#!/usr/bin/env tsx
import { appendFileSync } from "node:fs";
import { config } from "dotenv";
import { requestDeepSeek } from "./lib/llm/deepseek.js";
import { compactBacktestShapesForLlm } from "./lib/llm/backtest-shape-evidence.js";
import { writeLlmJournal } from "./lib/llm/learning.js";
import type { StrategyBucketsSnapshot } from "./lib/llm/bucket-aggregator.js";
import { buildStrategySnapshot } from "./lib/llm/strategy-snapshot.js";
import { PATHS, ensureParent, ensureStateDirs } from "./lib/paths.js";
import { readJson } from "./lib/storage.js";
import type { HealthSnapshot } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

function compactContext(
  health: HealthSnapshot,
  strategy: StrategyBucketsSnapshot,
): string {
  const resolvedLive = strategy.buckets.filter((b) => b.resolved > 0);
  const evidence = resolvedLive.slice(0, 20).map((b) => ({
    comparisonGroup: b.comparisonGroup,
    resolved: b.resolved,
    capRoi: b.capitalWeightedRoiPct,
    middleRate: b.middleRate,
    executionFlag: b.executionFlag,
  }));
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
      resolvedPackages: strategy.totalResolvedPackages,
      bucketCount: strategy.buckets.length,
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
  "You are the senior quantitative strategist for a sports monotonic-middle arbitrage desk trading Polymarket SOCCER and MLB markets.",
  "Think like a world-class quant: reason from sample sizes and confidence, distinguish signal from noise, never draw conclusions from n<5, and always separate STRATEGY questions (which shapes/costs are +EV) from EXECUTION questions (are fills matching scans).",
  "",
  "EVIDENCE MODEL:",
  "- backtestShapes covers BOTH sports: SOCCER (match_total, spread) is daemon-gated — every shape with worstRoiPct>0 and n>=5 trades live at or below its worstAvgCost; MLB (game_total, spread) live shapes come from currentAllowlist cost ranges.",
  "- backtestShapes includes shadow/negative shapes too (enforcedLive=false). Use them to spot promotion candidates (positive worstRoiPct, decent n, not yet live) and to confirm exclusions are justified.",
  "- The backtest window is rolling and grows nightly; n increasing over time is expected and strengthens or weakens shapes — call out shapes whose evidence changed materially.",
  "- The live ledger (liveExecutionMonitoring) is for execution quality ONLY: slippage, preflight drift, middle-rate collapse vs backtest, fill-vs-scan gaps.",
  "",
  "DISCIPLINE RULES:",
  "- NEVER recommend removing or demoting a backtest-positive shape solely because live capRoi is negative; live samples are tiny vs backtest.",
  "- When live loses on a backtest-positive enforced shape with low slippage, diagnose execution/population mismatch (paying above scan cost, adverse-selection in what actually fills, low middle rate), not a bad gate.",
  "- executionFlag slippage_concern / middle_rate_gap => explain the execution issue and suggest operational fixes (timing, preflight freshness, fill caps) — not gate removal.",
  "- executionFlag execution_review => note the live/backtest gap and recommend monitoring or a join analysis — not automatic demotion.",
  "- Gate tweak suggestions are allowed ONLY when backtest evidence itself supports them: negative worstRoiPct at the enforced cap (tighten/demote) or a shadow shape with positive worstRoiPct and n>=8 (promotion candidate).",
  "- Sanity-check the data you are given: if package counts, costs, or PnL look internally inconsistent (e.g. duplicated positions, costs far above per-package caps), SAY SO explicitly rather than analyzing corrupt numbers.",
  "- You may not enter trades, promote adapters, or unpause orphan incidents.",
  "",
  "OUTPUT SECTIONS (in order, concise bullets, numbers over adjectives):",
  "(1) Health & data sanity — daemon health plus any internal inconsistencies in the evidence itself.",
  "(2) Gate alignment — SOCCER and MLB separately: how enforced-live shapes map to backtest worstRoiPct/n; flag any enforced shape whose backtest support is weak.",
  "(3) Execution gaps — only buckets with executionFlag not in {hold, insufficient_evidence}; compare live middleRatePct to backtest middleRatePct and quantify the gap.",
  "(4) Promotion / demotion candidates — backtest-driven only, with the exact evidence (shape, n, worstRoiPct, cost cap); say 'none' if none qualify.",
  "(5) Monitoring — the 2-3 highest-information things to watch next, and what threshold would change a decision.",
].join("\n");

async function main() {
  ensureStateDirs();
  const health = readJson<HealthSnapshot>(PATHS.health, {
    updatedAt: new Date().toISOString(),
    status: "ok",
    clobAuth: "unknown",
    websocket: "unknown",
    openPackages: 0,
    largeOrphanActive: false,
    killSwitchActive: false,
    notes: [],
  });
  const strategy = buildStrategySnapshot();
  const context = compactContext(health, strategy);
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
