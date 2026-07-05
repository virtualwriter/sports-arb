// Bridge: project the daemon's polymarket-live-packages.json ledger (and any
// archived snapshots) into the SportsArbPackage shape that the LLM learning /
// daily-report helpers expect.
//
// The daemon writes its own row schema (see LivePackage in
// polymarket-real-monotonic-executor.ts); this adapter is the thin translation
// so summarizeEvidence() can group resolved trades by comparisonGroup and
// compute win-rate/ROI without forking the daemon's ledger format.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "../paths.js";
import { readJson } from "../storage.js";
import { costBucket } from "../sports-strategy.js";
import type {
  MarketType,
  SportId,
  SportsArbLeg,
  SportsArbPackage,
} from "../types.js";

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";

type DaemonLeg = {
  role?: "broad_yes" | "narrow_no";
  instrumentId?: string;
  instrumentLabel?: string;
  entryPrice?: number;
  strike?: number;
  yesBid?: number;
  yesAsk?: number;
  yesAskSize?: number | null;
  startDate?: string | null;
  direction?: "above" | "below";
};

type DaemonRow = {
  id?: string;
  packageId?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  dryRun?: boolean;
  asset?: string;
  eventSlug?: string;
  direction?: "above" | "below";
  broadStrike?: number;
  narrowStrike?: number;
  intendedShares?: number;
  filledShares?: number;
  intendedCost?: number;
  actualCost?: number;
  guaranteedFloor?: number;
  jackpotPayout?: number;
  settlementWindow?: { startDate: string | null; endDate: string | null };
  tokenIds?: { broadYes?: string; narrowNo?: string };
  prices?: { broadYesAsk?: number; narrowNoAsk?: number; packageCost?: number };
  packageLegs?: DaemonLeg[];
  failureReason?: string;
  dataQualityArtifact?: boolean;
  exit?: { realizedPnl?: number; reason?: string };
  realizedExitPnl?: number;
  exitProceeds?: number;
  soldReason?: string;
  executionQuote?: {
    wsCost?: number;
    freshCost?: number;
    actualPairCost?: number | null;
    preflightFetchMs?: number;
    recordedAt?: string;
  };
};

type GammaMarket = {
  id?: string | number;
  closed?: boolean;
  resolvedBy?: string | null;
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
};

type GammaEvent = { markets?: GammaMarket[] };

const SPORTS_ASSETS = new Set<SportId>([
  "MLB", "SOCCER", "NBA", "WNBA", "NFL", "NCAAF", "TENNIS", "WOMENS_TENNIS", "COLLEGE_BASEBALL",
]);

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundSlippageCents(value: number): number {
  return Math.round(value * 10) / 10;
}

export function computeExecutionSlippage(row: {
  filledShares?: number;
  actualCost?: number;
  prices?: { packageCost?: number };
  executionQuote?: DaemonRow["executionQuote"];
}): {
  fillSlippageCents: number | null;
  preflightDriftCents: number | null;
  fillSlippageSource: "execution_quote" | "ledger_inferred" | null;
} {
  const shares = num(row.filledShares);
  const actualCost = num(row.actualCost);
  const quoted = num(row.prices?.packageCost);
  const eq = row.executionQuote;

  let fillSlippageCents: number | null = null;
  let fillSlippageSource: "execution_quote" | "ledger_inferred" | null = null;
  if (eq?.actualPairCost != null && Number.isFinite(eq.freshCost)) {
    fillSlippageCents = roundSlippageCents((eq.actualPairCost - eq.freshCost) * 100);
    fillSlippageSource = "execution_quote";
  } else if (shares > 0 && quoted > 0 && actualCost > 0) {
    fillSlippageCents = roundSlippageCents(((actualCost / shares) - quoted) * 100);
    fillSlippageSource = "ledger_inferred";
  }

  let preflightDriftCents: number | null = null;
  if (eq?.wsCost != null && eq.freshCost != null && Number.isFinite(eq.wsCost) && Number.isFinite(eq.freshCost)) {
    preflightDriftCents = roundSlippageCents((eq.freshCost - eq.wsCost) * 100);
  }

  return { fillSlippageCents, preflightDriftCents, fillSlippageSource };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readArchivedDaemonRows(): DaemonRow[] {
  const archiveDir = join(dirname(PATHS.daemonLivePackages), "archive");
  if (!existsSync(archiveDir)) return [];
  const rows: DaemonRow[] = [];
  for (const name of readdirSync(archiveDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(archiveDir, name), "utf8"));
      const records = Array.isArray(parsed) ? parsed : [];
      for (const record of records) {
        const packages = Array.isArray(record?.packages) ? record.packages : [];
        for (const pkg of packages) if (pkg && typeof pkg === "object") rows.push(pkg as DaemonRow);
      }
    } catch {
      // Archive corruption is non-fatal: the active ledger is authoritative.
    }
  }
  return rows;
}

function combineDaemonRows(active: DaemonRow[], archived: DaemonRow[]): DaemonRow[] {
  const byKey = new Map<string, DaemonRow>();
  const key = (row: DaemonRow) => String(row.id ?? `${row.packageId ?? ""}::${row.createdAt ?? ""}`);
  for (const row of archived) byKey.set(key(row), row);
  for (const row of active) byKey.set(key(row), row);
  return [...byKey.values()];
}

function classifyMarketType(row: DaemonRow): MarketType {
  const labels = (row.packageLegs ?? []).map((leg) => String(leg.instrumentLabel ?? "")).join(" ");
  if (/Team Total/i.test(labels)) return "team_total";
  if (/Spread:/i.test(labels)) return "spread";
  if (/1st Half|1H/i.test(labels)) return "game_total";
  if (/O\/U|Over\/Under/i.test(labels)) {
    const sport = String(row.asset ?? "").toUpperCase();
    return sport === "SOCCER" ? "match_total" : "game_total";
  }
  return "unknown";
}

function sportIdFor(row: DaemonRow): SportId {
  const asset = String(row.asset ?? "").toUpperCase();
  if (SPORTS_ASSETS.has(asset as SportId)) return asset as SportId;
  return "UNKNOWN";
}

function legFromDaemon(role: "broad_yes" | "narrow_no", row: DaemonRow): SportsArbLeg {
  const leg = (row.packageLegs ?? []).find((entry) => entry.role === role) ?? {};
  const marketId = (leg.instrumentId ?? "").split("::")[1] ?? "";
  const tokenId = role === "broad_yes" ? row.tokenIds?.broadYes ?? "" : row.tokenIds?.narrowNo ?? "";
  return {
    marketId,
    question: leg.instrumentLabel ?? "",
    tokenId,
    side: role === "broad_yes" ? "YES" : "NO",
    strike: num(leg.strike, role === "broad_yes" ? num(row.broadStrike) : num(row.narrowStrike)),
    ask: num(leg.yesAsk),
    bid: num(leg.yesBid),
    size: num(leg.yesAskSize),
    direction: (leg.direction ?? row.direction ?? "above") as "above" | "below",
  };
}

function marketTokenPrices(market: GammaMarket | undefined): Map<string, number> | null {
  if (!market) return null;
  const tokens = parseJsonArray(market.clobTokenIds).map(String);
  const prices = parseJsonArray(market.outcomePrices).map((price) => num(price, NaN));
  if (tokens.length === 0 || prices.length === 0) return null;
  const out = new Map<string, number>();
  for (let idx = 0; idx < tokens.length; idx += 1) {
    if (tokens[idx] && Number.isFinite(prices[idx])) out.set(tokens[idx], prices[idx]);
  }
  return out.size > 0 ? out : null;
}

function realizedResolution(row: DaemonRow, cost: number): { pnl: number; payoutPerShare: number; source: string } | null {
  const exitPnl = num(row.exit?.realizedPnl, NaN);
  if (Number.isFinite(exitPnl)) {
    return { pnl: exitPnl, payoutPerShare: cost + exitPnl, source: row.exit?.reason ?? "realized_exit" };
  }
  const directPnl = num(row.realizedExitPnl, NaN);
  if (Number.isFinite(directPnl)) {
    return { pnl: directPnl, payoutPerShare: cost + directPnl, source: row.soldReason ?? "realized_exit" };
  }
  const proceeds = num(row.exitProceeds, NaN);
  if (Number.isFinite(proceeds)) {
    return { pnl: proceeds - cost, payoutPerShare: proceeds, source: row.soldReason ?? "sold" };
  }
  return null;
}

function gammaResolution(row: DaemonRow, cost: number, shares: number, event: GammaEvent | null | undefined): { pnl: number; payoutPerShare: number; source: string; winningTokenIds: string[] } | null {
  if (!event) return null;
  const markets = new Map<string, GammaMarket>();
  for (const market of event.markets ?? []) {
    if (market.id != null) markets.set(String(market.id), market);
  }
  const legs = row.packageLegs ?? [];
  if (legs.length === 0) return null;
  let payoutPerShare = 0;
  let allResolved = true;
  const winningTokenIds: string[] = [];
  for (const leg of legs) {
    const marketId = (leg.instrumentId ?? "").split("::")[1];
    const tokenId = leg.role === "broad_yes"
      ? row.tokenIds?.broadYes
      : leg.role === "narrow_no" ? row.tokenIds?.narrowNo : undefined;
    if (!marketId || !tokenId) return null;
    const market = markets.get(marketId);
    const tokenPrices = marketTokenPrices(market);
    const tokenPrice = tokenPrices?.get(tokenId);
    if (tokenPrice == null) return null;
    payoutPerShare += tokenPrice;
    const closed = Boolean(market?.closed || market?.resolvedBy);
    const settled = [...(tokenPrices?.values() ?? [])].some((price) => price >= 0.99);
    if (!(closed && settled)) allResolved = false;
    if (tokenPrice >= 0.99) winningTokenIds.push(tokenId);
  }
  if (!allResolved) return null;
  const proceeds = shares * payoutPerShare;
  return { pnl: proceeds - cost, payoutPerShare, source: "gamma_resolution", winningTokenIds };
}

async function fetchGammaEvent(slug: string): Promise<GammaEvent | null> {
  if (!slug) return null;
  try {
    const response = await fetch(`${GAMMA_API}/events?${new URLSearchParams({ slug })}`, {
      headers: { Accept: "application/json", "User-Agent": "sports-arb-llm-bridge/1.0" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Array.isArray(data) && data.length > 0 ? data[0] as GammaEvent : null;
  } catch {
    return null;
  }
}

async function fetchEventMap(rows: DaemonRow[]): Promise<Map<string, GammaEvent | null>> {
  const slugs = [...new Set(rows.map((row) => String(row.eventSlug ?? "")).filter(Boolean))];
  const events = new Map<string, GammaEvent | null>();
  // Modest concurrency: 6 in flight is friendly to Gamma and finishes the
  // ~50-200 unique slugs we'll see in a day's ledger in a few seconds.
  const limit = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < slugs.length) {
      const idx = cursor++;
      events.set(slugs[idx], await fetchGammaEvent(slugs[idx]));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, slugs.length) }, worker));
  return events;
}

function mapStatus(row: DaemonRow, resolved: boolean): SportsArbPackage["status"] {
  if (resolved) return "resolved";
  const status = String(row.status ?? "");
  if (/orphan|unwind/i.test(status) || /orphan|unwind|naked/i.test(String(row.failureReason ?? ""))) return "orphan";
  if (status === "package_complete") return "paired";
  if (status === "leg1_filled") return "leg1_filled";
  if (status === "leg1_submitted" || status === "leg2_submitted") return "submitting";
  if (status === "quoted") return "preflight_passed";
  if (status === "dry_run") return "cancelled";
  return "candidate";
}

function toSportsArbPackage(row: DaemonRow, event: GammaEvent | null | undefined): SportsArbPackage | null {
  if (row.dataQualityArtifact) return null;
  const sportId = sportIdFor(row);
  if (sportId === "UNKNOWN") return null;
  const shares = num(row.filledShares);
  const cost = num(row.actualCost);
  const isOrphan = /orphan|unwind/i.test(String(row.status ?? "")) || /orphan|unwind|naked/i.test(String(row.failureReason ?? ""));
  if (cost <= 0 || (shares <= 0 && !isOrphan)) return null;

  const packageCost = num(row.prices?.packageCost, shares > 0 ? cost / shares : 0);
  const slippage = computeExecutionSlippage(row);
  const marketType = classifyMarketType(row);
  const lineFamily = `${num(row.broadStrike)}-${num(row.narrowStrike)}`;
  const middleWidth = Math.abs(num(row.narrowStrike) - num(row.broadStrike));
  const bucket = costBucket(packageCost);
  const comparisonGroup = `${sportId}:${marketType}:${lineFamily}:${bucket}`;

  const realized = realizedResolution(row, cost);
  const gamma = realized ? null : gammaResolution(row, cost, shares, event);
  const resolution = realized ?? gamma;

  const packageId = String(row.packageId ?? row.id ?? `${row.eventSlug ?? "unknown"}::${row.createdAt ?? ""}`);
  const status = mapStatus(row, Boolean(resolution));

  const pkg: SportsArbPackage = {
    packageId,
    idempotencyKey: String(row.id ?? packageId),
    status,
    mode: "live",
    sport: { sportId, adapterVersion: "daemon-bridge-v1" },
    event: {
      slug: String(row.eventSlug ?? ""),
      title: String(row.eventSlug ?? ""),
      startTime: row.settlementWindow?.startDate ?? null,
      endTime: row.settlementWindow?.endDate ?? null,
    },
    strategy: {
      marketType,
      lineFamily,
      middleWidth,
      costBucket: bucket,
      comparisonGroup,
    },
    legs: {
      broad: legFromDaemon("broad_yes", row),
      narrow: legFromDaemon("narrow_no", row),
    },
    pricing: {
      packageCost,
      lockedEdge: 1 - packageCost,
      availableShares: num(row.intendedShares),
      maxSpread: 0,
      minLiquidity: 0,
      executionQuote: row.executionQuote || slippage.fillSlippageCents != null || slippage.preflightDriftCents != null
        ? {
            wsCost: num(row.executionQuote?.wsCost, packageCost),
            freshCost: num(row.executionQuote?.freshCost, packageCost),
            actualPairCost: row.executionQuote?.actualPairCost ?? (shares > 0 ? cost / shares : null),
            preflightFetchMs: row.executionQuote?.preflightFetchMs,
            fillSlippageCents: slippage.fillSlippageCents,
            preflightDriftCents: slippage.preflightDriftCents,
          }
        : slippage.fillSlippageSource === "ledger_inferred"
          ? {
              wsCost: packageCost,
              freshCost: packageCost,
              actualPairCost: shares > 0 ? cost / shares : null,
              fillSlippageCents: slippage.fillSlippageCents,
              preflightDriftCents: null,
            }
          : undefined,
    },
    sizing: {
      targetUsd: num(row.intendedCost, packageCost * num(row.intendedShares)),
      intendedShares: num(row.intendedShares),
      maxPackageUsd: num(row.intendedCost, 20),
    },
    lifecycleMs: {},
    timestamps: {
      created: row.createdAt,
      updated: row.updatedAt,
    },
    metadataSnapshotId: "daemon-bridge",
    // sourceCandidate is required by the type but unused by the learning helpers.
    // We attach a minimal stub so JSON consumers can still serialize the row.
    sourceCandidate: undefined as unknown as SportsArbPackage["sourceCandidate"],
  };

  if (resolution) {
    const roiPct = cost > 0 ? (resolution.pnl / cost) * 100 : 0;
    pkg.resolution = {
      status: "resolved",
      payoutPerShare: resolution.payoutPerShare / Math.max(shares, 1),
      pnlUsd: resolution.pnl,
      roiPct,
      source: resolution.source,
      resolvedAt: row.updatedAt,
      winningTokenIds: "winningTokenIds" in resolution ? (resolution.winningTokenIds as string[]) : undefined,
    };
  }
  return pkg;
}

export function loadDaemonSportsArbPackagesSync(): SportsArbPackage[] {
  const active = readJson<DaemonRow[]>(PATHS.daemonLivePackages, []);
  const archived = readArchivedDaemonRows();
  const rows = combineDaemonRows(active, archived);
  return rows
    .map((row) => toSportsArbPackage(row, null))
    .filter((pkg): pkg is SportsArbPackage => pkg !== null);
}

export async function loadDaemonSportsArbPackages(): Promise<SportsArbPackage[]> {
  const active = readJson<DaemonRow[]>(PATHS.daemonLivePackages, []);
  const archived = readArchivedDaemonRows();
  const rows = combineDaemonRows(active, archived);
  const eventMap = await fetchEventMap(rows);
  return rows
    .map((row) => toSportsArbPackage(row, eventMap.get(String(row.eventSlug ?? ""))))
    .filter((pkg): pkg is SportsArbPackage => pkg !== null);
}
