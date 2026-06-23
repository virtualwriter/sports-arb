import { PATHS } from "./paths.js";
import { appendJsonl, readJson, writeJson } from "./storage.js";
import type { OrphanIncident, SportsArbPackage } from "./types.js";

export type OrphanCheck = {
  severity: "none" | "dust" | "large";
  unmatchedShares: number;
  shouldPause: boolean;
  incident?: OrphanIncident;
};

export function unmatchedShares(pkg: SportsArbPackage): number {
  const broad = pkg.legs.broad.size;
  const narrow = pkg.legs.narrow.size;
  return Math.abs(broad - narrow);
}

export function checkOrphan(pkg: SportsArbPackage, dustThresholdShares = Number(process.env.SPORTS_ARB_ORPHAN_DUST_SHARES ?? 1)): OrphanCheck {
  const unmatched = unmatchedShares(pkg);
  if (unmatched <= 0) return { severity: "none", unmatchedShares: 0, shouldPause: false };
  const severity = unmatched <= dustThresholdShares ? "dust" : "large";
  const incident: OrphanIncident = {
    incidentId: `${pkg.packageId}:${Date.now()}`,
    packageId: pkg.packageId,
    detectedAt: new Date().toISOString(),
    unmatchedShares: unmatched,
    dustThresholdShares,
    severity,
    action: severity === "large" ? "paused_live_trading" : "ignored_dust",
    reason: severity === "large" ? "large_orphan_requires_operator_review" : "dust_orphan_below_threshold",
  };
  return { severity, unmatchedShares: unmatched, shouldPause: severity === "large", incident };
}

export function recordOrphanIncident(incident: OrphanIncident): void {
  appendJsonl(PATHS.orphanIncidents, incident);
  if (incident.severity === "large") {
    writeJson(PATHS.killSwitch, {
      paused: true,
      reason: "large_orphan_detected",
      incidentId: incident.incidentId,
      updatedAt: incident.detectedAt,
    });
  }
}

export function killSwitchActive(): boolean {
  return readJson<{ paused?: boolean }>(PATHS.killSwitch, {}).paused === true;
}
