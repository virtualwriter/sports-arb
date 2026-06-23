import { fetchJson } from "./monotonic-arb-core.js";
import type { SportsArbPackage } from "./types.js";

type GammaMarketResolution = {
  id?: string;
  closed?: boolean;
  active?: boolean;
  outcome?: string;
  winningOutcome?: string;
  result?: string;
  resolutionStatus?: string;
  clobTokenIds?: string;
  outcomes?: string;
};

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function winningSide(market: GammaMarketResolution): "YES" | "NO" | null {
  const value = String(market.winningOutcome ?? market.outcome ?? market.result ?? "").toLowerCase();
  if (value === "yes" || value === "over") return "YES";
  if (value === "no" || value === "under") return "NO";
  return null;
}

export async function resolvePackageFromGamma(pkg: SportsArbPackage, gammaApi = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com"): Promise<SportsArbPackage> {
  const url = `${gammaApi}/events?slug=${encodeURIComponent(pkg.event.slug)}`;
  const events = await fetchJson(url, Number(process.env.SPORTS_ARB_RESOLUTION_TIMEOUT_MS ?? 12_000)) as Array<{ markets?: GammaMarketResolution[] }>;
  const markets = events[0]?.markets ?? [];
  const broad = markets.find((market) => String(market.id) === pkg.legs.broad.marketId);
  const narrow = markets.find((market) => String(market.id) === pkg.legs.narrow.marketId);
  if (!broad || !narrow || !broad.closed || !narrow.closed) return pkg;

  const broadWin = winningSide(broad);
  const narrowWin = winningSide(narrow);
  if (!broadWin || !narrowWin) {
    return {
      ...pkg,
      resolution: { status: "manual_review", payoutPerShare: 0, source: "gamma_resolution_missing_winner", notes: ["closed_market_without_winning_outcome"] },
    };
  }

  const payoutPerShare = (broadWin === pkg.legs.broad.side ? 1 : 0) + (narrowWin === pkg.legs.narrow.side ? 1 : 0);
  const pnlUsd = (payoutPerShare - pkg.pricing.packageCost) * pkg.sizing.intendedShares;
  const roiPct = pkg.pricing.packageCost > 0 ? ((payoutPerShare / pkg.pricing.packageCost) - 1) * 100 : 0;
  const tokenIds = [...parseArray(broad.clobTokenIds), ...parseArray(narrow.clobTokenIds)];
  return {
    ...pkg,
    status: "resolved",
    resolution: {
      status: "resolved",
      payoutPerShare,
      pnlUsd,
      roiPct,
      source: "gamma_polymarket_resolution",
      resolvedAt: new Date().toISOString(),
      winningTokenIds: tokenIds,
    },
  };
}
