import { ethers } from "ethers";

// Ported from virtualwriter/impressionism web/scripts/lib/polygon-env.ts.
// Public Polygon RPCs from Polygon docs / provider docs. Free-tier/community
// endpoints; they may rate-limit or disappear, so we always failover across the
// whole list in a stable order (env overrides first, then this pool).
export const DEFAULT_PUBLIC_POLYGON_RPCS = [
  "https://polygon.drpc.org",
  "https://tenderly.rpc.polygon.community",
  "https://polygon.publicnode.com",
  "https://polygon-public.nodies.app/",
  "https://1rpc.io/matic",
  "https://polygon.api.onfinality.io/public",
  "https://poly.api.pocket.network",
  "https://polygon-mainnet.gateway.tatum.io/",
];

const POLYGON_CHAIN_ID = 137;
const POLYGON_NETWORK = { chainId: POLYGON_CHAIN_ID, name: "polygon" } as const;
const DEFAULT_PER_TRY_TIMEOUT_MS = 5_000;

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseRpcList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the ordered list of Polygon RPC URLs. Env overrides come first (so an
 * operator can pin a paid/dedicated endpoint), then the public pool. Mirrors the
 * env var names used by the impressionism repo: POLYGON_RPC_URLS (csv/space/nl),
 * POLYGON_RPC_URL, INFURA_POLYGON_API_KEY, ALCHEMY_POLYGON_API_KEY. RPC_URL is
 * still honored for backward compatibility with existing deployments.
 */
export function resolvePolygonRpcUrls(): string[] {
  const urls: string[] = [];

  urls.push(...parseRpcList(process.env.POLYGON_RPC_URLS));

  const full = process.env.POLYGON_RPC_URL?.trim();
  if (full) urls.push(full);

  const legacy = process.env.RPC_URL?.trim();
  if (legacy) urls.push(legacy);

  const infura = process.env.INFURA_POLYGON_API_KEY?.trim();
  if (infura) urls.push(`https://polygon-mainnet.infura.io/v3/${infura}`);

  const alchemy = process.env.ALCHEMY_POLYGON_API_KEY?.trim();
  if (alchemy) urls.push(`https://polygon-mainnet.g.alchemy.com/v2/${alchemy}`);

  urls.push(...DEFAULT_PUBLIC_POLYGON_RPCS);
  return uniqueNonEmpty(urls);
}

/**
 * Build an ethers v5 FallbackProvider over the resolved RPC list. quorum=1 with
 * ascending priority means we try the highest-priority (env-first) endpoint, and
 * fall over to the next when one stalls or errors. Each provider is pinned to the
 * Polygon network so no per-call eth_chainId/net_version autodetect happens, and
 * carries an explicit per-attempt timeout so a hung public node cannot block for
 * the ethers default of two minutes.
 */
export function createPolygonProvider(perTryTimeoutMs = DEFAULT_PER_TRY_TIMEOUT_MS): ethers.providers.FallbackProvider {
  const urls = resolvePolygonRpcUrls();
  if (urls.length === 0) {
    throw new Error("No Polygon RPC URLs resolved (set POLYGON_RPC_URLS/POLYGON_RPC_URL or rely on the public pool)");
  }
  const configs = urls.map((url, index) => ({
    provider: new ethers.providers.StaticJsonRpcProvider({ url, timeout: perTryTimeoutMs }, POLYGON_NETWORK),
    priority: index + 1,
    stallTimeout: perTryTimeoutMs,
    weight: 1,
  }));
  // quorum = 1: first successful response wins, in stable priority order.
  return new ethers.providers.FallbackProvider(configs, 1);
}

let sharedProvider: ethers.providers.FallbackProvider | null = null;

/** Lazily-created shared failover provider, reused across calls. */
export function getPolygonProvider(): ethers.providers.FallbackProvider {
  if (!sharedProvider) sharedProvider = createPolygonProvider();
  return sharedProvider;
}
