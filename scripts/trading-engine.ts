#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { config } from "dotenv";
import { capitalGate } from "./lib/capital-allocator.js";
import { markLifecycle } from "./lib/order-lifecycle.js";
import { checkOrphan, killSwitchActive, recordOrphanIncident } from "./lib/orphan-monitor.js";
import { PATHS, ensureStateDirs } from "./lib/paths.js";
import { runPreflight } from "./lib/preflight.js";
import { readJson, writeJson } from "./lib/storage.js";
import type { HealthSnapshot, SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

type ScannerOutput = {
  generatedAt: string;
  live: SportsArbPackage[];
  shadows: SportsArbPackage[];
};

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const DRY_RUN = process.argv.includes("--dry-run") || process.env.SPORTS_ARB_LIVE !== "1" || process.env.DISABLE_REAL_PM_TRADING === "1";
const scannerPath = argValue("--scanner-out") ?? PATHS.livePackages.replace("live-packages", "scanner-candidates");

function readScannerOutput(): ScannerOutput {
  if (!existsSync(scannerPath)) return { generatedAt: new Date(0).toISOString(), live: [], shadows: [] };
  return JSON.parse(readFileSync(scannerPath, "utf8")) as ScannerOutput;
}

function loadOpenPackages(): SportsArbPackage[] {
  return readJson<SportsArbPackage[]>(PATHS.livePackages, []).filter((pkg) => !["resolved", "cancelled", "flattened"].includes(pkg.status));
}

function savePackages(packages: SportsArbPackage[]): void {
  writeJson(PATHS.livePackages, packages);
}

function packageAlreadySeen(packages: SportsArbPackage[], candidate: SportsArbPackage): boolean {
  return packages.some((pkg) => pkg.idempotencyKey === candidate.idempotencyKey);
}

function executeRealPackage(pkg: SportsArbPackage): void {
  const result = spawnSync("npm", ["run", "monotonic:real-pm"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ENABLE_MONOTONIC_ARB_REAL_PM: "1",
      DISABLE_REAL_PM_TRADING: "0",
      MONOTONIC_ARB_REAL_PM_DRY_RUN: "0",
      MONOTONIC_ARB_REAL_PM_SOURCE: "scan",
      MONOTONIC_ARB_REAL_PM_PACKAGE_ID: pkg.sourceCandidate.packageId,
      MONOTONIC_ARB_REAL_PM_EVENT_SLUGS: pkg.event.slug,
      MONOTONIC_ARB_REAL_PM_ASSETS: pkg.sport.sportId,
      MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD: String(pkg.sizing.targetUsd),
      POLYMARKET_TRADER_STATE_DIR: process.env.SPORTS_ARB_RUNTIME_DIR ?? process.env.SPORTS_ARB_STATE_DIR ?? process.env.POLYMARKET_TRADER_STATE_DIR ?? "",
    },
  });
  if (result.status !== 0) throw new Error(`real executor failed for ${pkg.packageId} exit=${result.status}`);
}

async function main() {
  ensureStateDirs();
  const scanner = readScannerOutput();
  const open = loadOpenPackages();
  const healthNotes: string[] = [];

  for (const pkg of open) {
    const orphan = checkOrphan(pkg);
    if (orphan.incident) recordOrphanIncident(orphan.incident);
    if (orphan.shouldPause) {
      const health: HealthSnapshot = {
        updatedAt: new Date().toISOString(),
        status: "paused",
        lastScanAt: scanner.generatedAt,
        clobAuth: "unknown",
        websocket: "unknown",
        openPackages: open.length,
        largeOrphanActive: true,
        killSwitchActive: true,
        notes: [`large orphan detected package=${pkg.packageId}; live entries paused`],
      };
      writeJson(PATHS.health, health);
      console.error(`[engine] large orphan detected package=${pkg.packageId}; refusing live entries`);
      return;
    }
  }

  if (killSwitchActive()) {
    healthNotes.push("kill switch active; no live entries");
  }

  const preflight = await runPreflight({ requireLive: !DRY_RUN, requireLlm: process.env.SPORTS_ARB_LLM_ENABLED === "1" });
  if (!preflight.ok) {
    writeJson(PATHS.health, {
      updatedAt: new Date().toISOString(),
      status: "degraded",
      lastScanAt: scanner.generatedAt,
      clobAuth: "failed",
      websocket: "unknown",
      openPackages: open.length,
      largeOrphanActive: false,
      killSwitchActive: killSwitchActive(),
      notes: preflight.failures,
    } satisfies HealthSnapshot);
    throw new Error(`preflight failed: ${preflight.failures.join(", ")}`);
  }

  const next = open.slice();
  for (const candidate of scanner.live) {
    if (packageAlreadySeen(next, candidate)) continue;
    const capitalFailures = capitalGate({ candidate, openPackages: next });
    if (capitalFailures.length > 0) {
      healthNotes.push(`capital gate ${candidate.packageId}: ${capitalFailures.join(",")}`);
      continue;
    }
    let pkg = markLifecycle(candidate, "qualified");
    pkg = markLifecycle(pkg, "preflight_started");
    pkg = markLifecycle(pkg, "preflight_passed");
    if (DRY_RUN) {
      pkg.status = "live_qualified";
      healthNotes.push(`dry-run qualified ${pkg.packageId}`);
    } else {
      pkg.status = "preflight_passed";
      pkg = markLifecycle(pkg, "submit_started");
      executeRealPackage(pkg);
      pkg = markLifecycle(pkg, "paired");
      pkg.status = "paired";
      healthNotes.push(`submitted via real executor ${pkg.packageId}`);
    }
    next.push(pkg);
  }

  savePackages(next);
  writeJson(PATHS.health, {
    updatedAt: new Date().toISOString(),
    status: killSwitchActive() ? "paused" : "ok",
    lastScanAt: scanner.generatedAt,
    lastOrderAttemptAt: new Date().toISOString(),
    clobAuth: DRY_RUN ? "unknown" : "ok",
    websocket: "unknown",
    openPackages: next.length,
    largeOrphanActive: false,
    killSwitchActive: killSwitchActive(),
    notes: healthNotes,
  } satisfies HealthSnapshot);
  console.log(`[engine] dryRun=${DRY_RUN} open=${next.length} notes=${healthNotes.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
