#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import {
  type ArbCoreConfig,
  type Candidate,
  fetchJson,
  findStructuralCandidates,
  mapLimit,
} from "./lib/monotonic-arb-core.js";
import { allocatorConfigFromEnv, targetUsdForPackage } from "./lib/capital-allocator.js";
import { recordMarketMetadataSnapshot } from "./lib/market-metadata-cache.js";
import { packageFromCandidate } from "./lib/package-factory.js";
import { ensureParent, ensureStateDirs, PATHS } from "./lib/paths.js";
import { appendShadowPackage, readShadowPackages, writeShadowBucketSummary } from "./lib/shadow-ledger.js";
import { enabledDiscoveryAdapters } from "./lib/sports-registry.js";
import { evaluateSportsStrategy } from "./lib/sports-strategy.js";
import { writeJson } from "./lib/storage.js";
import type { SportsArbPackage } from "./lib/types.js";

config({ path: "config.env" });
config({ path: ".env" });

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const FETCH_TIMEOUT_MS = Number(process.env.SPORTS_ARB_FETCH_TIMEOUT_MS ?? 12_000);
const DISCOVERY_LIMIT = Number(process.env.SPORTS_ARB_DISCOVERY_LIMIT ?? 200);
const EVENT_CONCURRENCY = Number(process.env.SPORTS_ARB_EVENT_CONCURRENCY ?? 3);
const MARKET_CONCURRENCY = Number(process.env.SPORTS_ARB_MARKET_CONCURRENCY ?? 2);
const MAX_SHADOW_PROBES_PER_GROUP = Number(process.env.SPORTS_ARB_MAX_SHADOW_PROBES_PER_GROUP ?? 25);

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const outPath = argValue("--out") ?? PATHS.livePackages.replace("live-packages", "scanner-candidates");

function arbConfig(): ArbCoreConfig {
  return {
    host: HOST,
    gammaApi: GAMMA_API,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    marketConcurrency: MARKET_CONCURRENCY,
    eventConcurrency: EVENT_CONCURRENCY,
    allowedAssets: new Set(["MLB", "SOCCER", "NBA", "COLLEGE_BASEBALL", "TENNIS", "WOMENS_TENNIS", "GOLF", "NCAAF", "NFL", "WNBA"]),
    minEdge: Number(process.env.SPORTS_ARB_MIN_EDGE ?? -1),
    maxSpread: Number(process.env.SPORTS_ARB_MAX_SPREAD ?? 0.10),
    minLiquidity: Number(process.env.SPORTS_ARB_MIN_LIQUIDITY ?? 0),
    minAvailableShares: Number(process.env.SPORTS_ARB_MIN_AVAILABLE_SHARES ?? 1),
  };
}

async function discoverSlugs(): Promise<string[]> {
  const slugs = new Set<string>();
  for (const adapter of enabledDiscoveryAdapters()) {
    for (const tag of adapter.gammaTags) {
      const url = `${GAMMA_API}/events?${new URLSearchParams({ tag_slug: tag, active: "true", closed: "false", limit: String(DISCOVERY_LIMIT) })}`;
      try {
        const events = await fetchJson(url, FETCH_TIMEOUT_MS) as Array<{ slug?: string }>;
        for (const event of events) if (event.slug) slugs.add(event.slug);
      } catch (error) {
        console.warn(`[scanner] discovery failed tag=${tag}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const configured = (process.env.SPORTS_ARB_EVENT_SLUGS ?? "").split(",").map((slug) => slug.trim()).filter(Boolean);
  for (const slug of configured) slugs.add(slug);
  return [...slugs];
}

function shouldKeepShadow(pkg: SportsArbPackage, seenByGroup: Map<string, number>): boolean {
  if (pkg.pricing.packageCost < 1) return true;
  const key = `${pkg.shadowPurpose}:${pkg.strategy.comparisonGroup}`;
  const count = seenByGroup.get(key) ?? 0;
  if (count >= MAX_SHADOW_PROBES_PER_GROUP) return false;
  seenByGroup.set(key, count + 1);
  return true;
}

async function scanSlug(slug: string, config: ArbCoreConfig, foundAt: string): Promise<Candidate[]> {
  const result = await findStructuralCandidates(config, [slug], foundAt);
  for (const error of result.errors) console.warn(`[scanner] ${error}`);
  return result.candidates;
}

async function main() {
  ensureStateDirs();
  const config = arbConfig();
  const foundAt = new Date().toISOString();
  const slugs = await discoverSlugs();
  const candidates = (await mapLimit(slugs, EVENT_CONCURRENCY, (slug) => scanSlug(slug, config, foundAt))).flat();
  const allocator = allocatorConfigFromEnv();
  const live: SportsArbPackage[] = [];
  const shadows: SportsArbPackage[] = [];
  const shadowGroupCounts = new Map<string, number>();

  for (const candidate of candidates.sort((a, b) => a.packageCost - b.packageCost || b.availableSize - a.availableSize)) {
    const decision = evaluateSportsStrategy(candidate);
    const metadata = recordMarketMetadataSnapshot({
      eventSlug: candidate.eventSlug,
      eventTitle: candidate.eventTitle,
      marketIds: [candidate.broad.marketId, candidate.narrow.marketId],
      gammaEvent: { candidate },
    });
    const targetUsd = targetUsdForPackage({ pricing: { packageCost: candidate.packageCost } } as SportsArbPackage, allocator);
    const base = { candidate, decision, targetUsd, maxPackageUsd: allocator.maxPackageUsd, metadataSnapshotId: metadata.snapshotId };
    if (decision.liveEligible) {
      live.push(packageFromCandidate({ ...base, mode: "live" }));
    } else if (decision.shadowEligible) {
      const pkg = packageFromCandidate({ ...base, mode: "shadow" });
      if (shouldKeepShadow(pkg, shadowGroupCounts)) {
        shadows.push(pkg);
        appendShadowPackage(pkg);
      }
    }
  }

  writeShadowBucketSummary([...readShadowPackages(50_000), ...shadows]);
  ensureParent(outPath);
  writeFileSync(outPath, JSON.stringify({ generatedAt: foundAt, slugs, live, shadows }, null, 2) + "\n");
  writeJson(PATHS.health, {
    updatedAt: new Date().toISOString(),
    status: "ok",
    lastScanAt: new Date().toISOString(),
    clobAuth: "unknown",
    websocket: "unknown",
    openPackages: live.length,
    largeOrphanActive: false,
    killSwitchActive: false,
    notes: [`scanner live=${live.length} shadows=${shadows.length} slugs=${slugs.length}`],
  });
  console.log(`[scanner] live=${live.length} shadows=${shadows.length} slugs=${slugs.length} out=${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
