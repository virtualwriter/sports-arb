#!/usr/bin/env tsx
import { appendFileSync } from "node:fs";
import { config } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDaemonSportsArbPackages } from "./lib/llm/daemon-bridge.js";
import { requestDeepSeek } from "./lib/llm/deepseek.js";
import { summarizeEvidence, writeLlmJournal } from "./lib/llm/learning.js";
import { aggregateLiveBuckets, type StrategyBucketsSnapshot } from "./lib/llm/bucket-aggregator.js";
import { loadBaselineBuckets } from "./lib/llm/baseline-evidence.js";
import { PATHS, REPO_ROOT, ensureParent, ensureStateDirs } from "./lib/paths.js";
import { readShadowPackages } from "./lib/shadow-ledger.js";
import { readJson } from "./lib/storage.js";
import { currentStrategyAllowlist } from "./lib/sports-strategy.js";
import type { HealthSnapshot, SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

function loadStrategySnapshot(live: SportsArbPackage[]): StrategyBucketsSnapshot {
  const path = join(REPO_ROOT, "analysis", "strategy-buckets-live.json");
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StrategyBucketsSnapshot;
    } catch {
      // Fall through to in-process rebuild.
    }
  }
  return aggregateLiveBuckets(live, currentStrategyAllowlist(), loadBaselineBuckets());
}

function compactContext(
  live: SportsArbPackage[],
  shadows: SportsArbPackage[],
  health: HealthSnapshot,
  strategy: StrategyBucketsSnapshot,
): string {
  const evidence = summarizeEvidence([...live, ...shadows]).slice(0, 30);
  // The full snapshot can be 5-20 KB. Trim each bucket to the fields the LLM
  // needs for reasoning so the prompt stays tight.
  const bucketsCompact = strategy.buckets.map((b) => ({
    bucket: b.comparisonGroup,
    enforcedLive: b.enforcedLive,
    tier: b.tier,
    n: b.resolved,
    wins: b.wins,
    middles: b.middles,
    capRoi: b.capitalWeightedRoiPct,
    winRate: b.winRate,
    avgFillSlippageCents: b.avgFillSlippageCents,
    avgPreflightDriftCents: b.avgPreflightDriftCents,
    slippageSampleCount: b.slippageSampleCount,
    recommendation: b.recommendation,
    lastResolvedAt: b.lastResolvedAt,
  }));
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
      sub1Open: shadows.filter((pkg) => pkg.pricing.packageCost < 1 && pkg.status === "shadow_open").length,
    },
    // Frozen Jun 16-22 baseline. Same cost-bucket aggregation that originally
    // produced the hardcoded allowlist in sports-strategy.ts.
    frozenBaseline: strategy.baseline,
    // What the daemon currently allows live.
    currentAllowlist: strategy.allowlist,
    // What our live ledger has actually paid out since.
    liveBucketEvidence: bucketsCompact,
    thresholds: strategy.thresholds,
    // Legacy view (no tiering); kept for parity with prior journals.
    setupFamilyEvidence: evidence,
  });
}

async function main() {
  ensureStateDirs();
  // Primary input is the daemon ledger (bridged into SportsArbPackage shape).
  // Fall back to the legacy hourly-executor file if the daemon hasn't been
  // active yet, so we never silently drop history during a transition.
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
  const strategy = loadStrategySnapshot(live);
  const context = compactContext(live, shadows, health, strategy);
  // Nightly learn uses the non-reasoning chat model. Reasoning models (e.g.
  // deepseek-v4-pro) burn the shared max_tokens budget on reasoning_content
  // and often return an empty visible answer for our large strategy prompt.
  const learnModel = process.env.SPORTS_ARB_LLM_LEARN_MODEL ?? "deepseek-chat";
  const result = await requestDeepSeek([
    {
      role: "system",
      content: [
        "You are the sports monotonic arbitrage learning analyst.",
        "Three datasets are provided in the user message:",
        "(1) frozenBaseline -- the Jun 16-22 backtest at cost-bucket granularity (n=4458 resolved). This is the reference window from which the current allowlist was hand-derived.",
        "(2) currentAllowlist -- exactly what the daemon currently allows live (line families, cost ranges, widths, bid floors). Treat as the gate's source of truth.",
        "(3) liveBucketEvidence -- per (sport:marketType:lineFamily:costBucket) stats from the daemon's resolved live ledger since Jun 23. Each entry has a tier (preliminary/actionable/confirmed), recommendation, and execution slippage (avgFillSlippageCents = actual fill minus preflight quote; avgPreflightDriftCents = REST preflight minus WS snapshot).",
        "Your job each day: compare evidence vs the allowlist and the baseline. When a bucket loses money but slippage is high (+fill or +preflight drift), distinguish gate-shape problems from execution-timing problems.",
        "Focus on actionable + confirmed tiers when proposing changes. Preliminary tier may be mentioned but should not drive recommendations.",
        "You may summarize evidence, flag risks, propose hypotheses, and suggest bounded parameter changes (e.g. relax narrow_yes_bid floor for line family X by 0.005, or remove cost bucket Y from MLB game_total).",
        "You may not directly enter trades, promote a sport adapter to live, or unpause after a large orphan incident.",
        "Output sections, in order: (1) risks, (2) baseline-vs-live deltas worth attention, (3) bucket recommendations (only buckets where tier >= actionable AND recommendation != hold), (4) suggested deterministic checks before any change ships. Concise bullets.",
      ].join(" "),
    },
    { role: "user", content: context },
  ], { model: learnModel });
  if (!result.text.trim()) {
    // Empty response is almost always a transient provider hiccup -- the next
    // scheduled run will pick it up. Don't pollute the journal with a header
    // that has no body.
    console.warn(`[llm] empty response from ${result.model}; skipping journal append`);
    return;
  }
  const journal = `\n\n## ${result.calledAt} (${result.model})\n\n${result.text}\n`;
  ensureParent(PATHS.learningJournal);
  appendFileSync(PATHS.learningJournal, journal);
  writeLlmJournal(result.text);
  console.log(`[llm] wrote ${PATHS.learningJournal}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
