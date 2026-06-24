#!/usr/bin/env tsx
import { appendFileSync } from "node:fs";
import { config } from "dotenv";
import { buildDailyReport } from "./daily-sports-arb-report.js";
import { PATHS, ensureParent } from "./lib/paths.js";
import { readJson } from "./lib/storage.js";
import { sportsPnlTelegramText } from "./sports-pnl-report.js";
import type { HealthSnapshot, SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

const TELEGRAM_API = "https://api.telegram.org";

async function sendMessage(text: string): Promise<void> {
  const token = process.env.SPORTS_ARB_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.SPORTS_ARB_TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing SPORTS_ARB_TELEGRAM_BOT_TOKEN or SPORTS_ARB_TELEGRAM_CHAT_ID");
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
  });
  if (!response.ok) throw new Error(`Telegram send failed ${response.status}: ${await response.text()}`);
}

function recordOperatorAction(action: string): void {
  ensureParent(PATHS.operatorActions);
  appendFileSync(PATHS.operatorActions, JSON.stringify({ action, recordedAt: new Date().toISOString(), source: "telegram_bot" }) + "\n");
}

async function main() {
  const command = process.argv[2] ?? "daily";
  if (command === "daily") {
    const report = buildDailyReport();
    await sendMessage(report.markdown.slice(0, 3900));
    await sendMessage((await sportsPnlTelegramText()).slice(0, 3900));
    console.log(`[telegram] sent daily report ${report.markdownPath}`);
    return;
  }
  if (command === "pnl") {
    await sendMessage((await sportsPnlTelegramText()).slice(0, 3900));
    return;
  }
  if (["pause", "resume", "kill"].includes(command)) {
    recordOperatorAction(command);
    await sendMessage(`Sports arb operator action queued: ${command}`);
    return;
  }
  if (command === "status") {
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
    const live = readJson<SportsArbPackage[]>(PATHS.livePackages, []);
    await sendMessage([
      `Sports arb status: ${health.status}`,
      `Open packages: ${live.filter((pkg) => !["resolved", "cancelled", "flattened"].includes(pkg.status)).length}`,
      `Large orphan active: ${health.largeOrphanActive}`,
      `Kill switch active: ${health.killSwitchActive}`,
      `Last scan: ${health.lastScanAt ?? "unknown"}`,
    ].join("\n"));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
