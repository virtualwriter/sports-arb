#!/usr/bin/env tsx
import { appendFileSync } from "node:fs";
import { config } from "dotenv";
import { loadDaemonSportsArbPackages } from "./lib/llm/daemon-bridge.js";
import { requestDeepSeek } from "./lib/llm/deepseek.js";
import { summarizeEvidence, writeLlmJournal } from "./lib/llm/learning.js";
import { PATHS, ensureParent, ensureStateDirs } from "./lib/paths.js";
import { readShadowPackages } from "./lib/shadow-ledger.js";
import { readJson } from "./lib/storage.js";
import type { HealthSnapshot, SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

function compactContext(live: SportsArbPackage[], shadows: SportsArbPackage[], health: HealthSnapshot): string {
  const evidence = summarizeEvidence([...live, ...shadows]).slice(0, 20);
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
  const context = compactContext(live, shadows, health);
  const result = await requestDeepSeek([
    {
      role: "system",
      content: [
        "You are the sports monotonic arbitrage learning analyst.",
        "You may summarize evidence, flag risks, propose hypotheses, and suggest bounded risk parameter changes.",
        "You may not directly enter trades, promote a sport adapter to live, or unpause after a large orphan incident.",
        "Use concise bullets grouped as: risks, evidence, hypotheses, suggested deterministic checks.",
      ].join(" "),
    },
    { role: "user", content: context },
  ]);
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
