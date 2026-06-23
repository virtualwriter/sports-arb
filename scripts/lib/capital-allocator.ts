import type { SportsArbPackage } from "./types.js";

export type CapitalAllocatorConfig = {
  defaultPackageUsd: number;
  maxPackageUsd: number;
  maxOpenPackages: number;
  maxEventUsd: number;
  maxSportUsd: number;
};

export function allocatorConfigFromEnv(): CapitalAllocatorConfig {
  const defaultPackageUsd = Number(process.env.SPORTS_ARB_PACKAGE_USD ?? process.env.MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD ?? 20);
  return {
    defaultPackageUsd,
    maxPackageUsd: Number(process.env.SPORTS_ARB_MAX_PACKAGE_USD ?? Math.max(defaultPackageUsd, 20)),
    maxOpenPackages: Number(process.env.SPORTS_ARB_MAX_OPEN_PACKAGES ?? 50),
    maxEventUsd: Number(process.env.SPORTS_ARB_MAX_EVENT_USD ?? 100),
    maxSportUsd: Number(process.env.SPORTS_ARB_MAX_SPORT_USD ?? 1_000),
  };
}

export function targetUsdForPackage(pkg: Pick<SportsArbPackage, "pricing">, config = allocatorConfigFromEnv()): number {
  if (!(pkg.pricing.packageCost > 0)) return 0;
  return Math.min(config.defaultPackageUsd, config.maxPackageUsd);
}

export function capitalGate(args: {
  candidate: SportsArbPackage;
  openPackages: SportsArbPackage[];
  config?: CapitalAllocatorConfig;
}): string[] {
  const config = args.config ?? allocatorConfigFromEnv();
  const failures: string[] = [];
  if (args.openPackages.length >= config.maxOpenPackages) failures.push("max_open_packages");
  const eventUsd = args.openPackages
    .filter((pkg) => pkg.event.slug === args.candidate.event.slug)
    .reduce((sum, pkg) => sum + pkg.sizing.targetUsd, 0);
  if (eventUsd + args.candidate.sizing.targetUsd > config.maxEventUsd) failures.push("max_event_usd");
  const sportUsd = args.openPackages
    .filter((pkg) => pkg.sport.sportId === args.candidate.sport.sportId)
    .reduce((sum, pkg) => sum + pkg.sizing.targetUsd, 0);
  if (sportUsd + args.candidate.sizing.targetUsd > config.maxSportUsd) failures.push("max_sport_usd");
  return failures;
}
