import { PATHS } from "./paths.js";
import { appendJsonl, readJsonl, writeJson } from "./storage.js";
import type { ShadowLedgerRow, SportsArbPackage } from "./types.js";

export function appendShadowPackage(pkg: SportsArbPackage): void {
  appendJsonl(PATHS.shadows, { recordedAt: new Date().toISOString(), package: pkg } satisfies ShadowLedgerRow);
}

export function readShadowPackages(limit = 5_000): SportsArbPackage[] {
  return readJsonl<ShadowLedgerRow>(PATHS.shadows, limit).map((row) => row.package);
}

export function writeShadowBucketSummary(packages: SportsArbPackage[]): void {
  const groups = new Map<string, { count: number; sub1: number; liveGateFailures: Record<string, number> }>();
  for (const pkg of packages) {
    const key = [
      pkg.shadowPurpose ?? "unknown",
      pkg.strategy.costBucket,
      pkg.sport.sportId,
      pkg.sport.league ?? "",
      pkg.sport.gender ?? "unknown",
      pkg.strategy.marketType,
      pkg.strategy.lineFamily,
      pkg.sport.adapterVersion,
    ].join("|");
    const group = groups.get(key) ?? { count: 0, sub1: 0, liveGateFailures: {} };
    group.count += 1;
    if (pkg.pricing.packageCost < 1) group.sub1 += 1;
    for (const failure of pkg.strategy.liveGateFailed ?? []) {
      group.liveGateFailures[failure] = (group.liveGateFailures[failure] ?? 0) + 1;
    }
    groups.set(key, group);
  }
  writeJson(PATHS.shadowBucketSummary, {
    updatedAt: new Date().toISOString(),
    groups: [...groups.entries()].map(([key, value]) => ({ key, ...value })),
  });
}
