import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { ClobClient, type ApiKeyCreds, AssetType, Chain, OrderType, Side, SignatureTypeV2, type TickSize, isV2Order, orderToJsonV2 } from "@polymarket/clob-client-v2";
import { config } from "dotenv";
import { ethers } from "ethers";
import { VpnGuard } from "./lib/VpnGuard.js";
import { getPolygonProvider } from "./lib/polygon-rpc.js";
import {
  type ArbCoreConfig,
  type Candidate,
  type Direction,
  defaultEventSlugs,
  evaluatePair,
  fetchEvent,
  findCandidates,
  marketQuote,
  parseNumber,
  polymarketAssetForSlug,
} from "./lib/monotonic-arb-core.js";

// @polymarket/clob-client signs L2 requests via globalThis.crypto.subtle.
// Node < 19 (the VPS runs 18) does not expose globalThis.crypto by default,
// so polyfill it from node:crypto before any CLOB call.
if (!globalThis.crypto) (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });
config({ path: resolve(__dirname, "../../config.env") });

const ROOT = join(import.meta.dirname ?? ".", "..");
const DEFAULT_LIVE_STATE_DIR = join(ROOT, ".runtime");
const LIVE_STATE_DIR = process.env.SPORTS_ARB_STATE_DIR
  ?? process.env.POLYMARKET_TRADER_STATE_DIR
  ?? DEFAULT_LIVE_STATE_DIR;
const LIVE_PORTFOLIO_FILE = process.env.SPORTS_ARB_LIVE_PORTFOLIO
  ?? process.env.POLYMARKET_TRADER_LIVE_PORTFOLIO
  ?? join(LIVE_STATE_DIR, "portfolio-live.json");
const DATA_DIR = process.env.SPORTS_ARB_DATA_DIR ?? join(ROOT, "data");
const PACKAGES_PATH = join(DATA_DIR, "polymarket-live-packages.json");
const ORDERS_PATH = join(DATA_DIR, "polymarket-live-orders.json");

const HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const RELAYER_URL = process.env.POLYMARKET_RELAYER_URL ?? "https://relayer-v2.polymarket.com";
const CHAIN_ID = Chain.POLYGON;
// On-chain reads (pUSD balance/allowance, CTF token balances) go through the
// multi-RPC failover provider in scripts/lib/polygon-rpc.ts (POLYGON_RPC_URLS /
// RPC_URL env). This replaces the single flaky public endpoint that caused the
// two hourly 504 / 120s-timeout failures on the Japan host.
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const EXCHANGE_V2_ADDRESS = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2_ADDRESS = "0xe2222d279d744050d28e00520010520000310F59";
const RELAYER_API_KEY = process.env.RELAYER_API_KEY?.trim();
const RELAYER_API_KEY_ADDRESS = process.env.RELAYER_API_KEY_ADDRESS?.trim();
const RELAYER_TX_TYPE = (process.env.POLYMARKET_RELAYER_TX_TYPE ?? "PROXY").trim().toUpperCase();
const PROXY_WALLET_ADDRESS = process.env.POLYMARKET_PROXY_WALLET_ADDRESS?.trim();
const DEFAULT_SIGNATURE_TYPE = PROXY_WALLET_ADDRESS ? SignatureTypeV2.POLY_PROXY : SignatureTypeV2.EOA;
const POLYMARKET_SIGNATURE_TYPE = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? DEFAULT_SIGNATURE_TYPE) as SignatureTypeV2;
const POLYMARKET_FUNDER_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS?.trim()
  || (POLYMARKET_SIGNATURE_TYPE === SignatureTypeV2.POLY_PROXY ? PROXY_WALLET_ADDRESS : undefined);
const POLY_BUILDER_API_KEY = process.env.POLY_BUILDER_API_KEY?.trim();
const POLY_BUILDER_PASSPHRASE = process.env.POLY_BUILDER_PASSPHRASE?.trim();
const POLY_BUILDER_SECRET = process.env.POLY_BUILDER_SECRET?.trim();
const POLY_BUILDER_CODE = process.env.POLY_BUILDER_CODE?.trim();
const CLOB_API_OWNER = process.env.POLYMARKET_CLOB_API_KEY?.trim() || "BUILD_ONLY_NO_CLOB_API_KEY";

const ENABLED = process.env.ENABLE_MONOTONIC_ARB_REAL_PM === "1";
const HARD_DISABLED = process.env.DISABLE_REAL_PM_TRADING === "1";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.MONOTONIC_ARB_REAL_PM_DRY_RUN === "1" || !ENABLED || HARD_DISABLED;
const PROBE_ONLY = process.argv.includes("--probe-only");
const BUILD_ONLY = process.argv.includes("--build-only") || process.env.MONOTONIC_ARB_REAL_PM_BUILD_ONLY === "1";
const DEFAULT_PACKAGE_USD = Number(process.env.SPORTS_ARB_PACKAGE_USD ?? 20);
const MAX_PACKAGE_USD = Number(process.env.MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD ?? DEFAULT_PACKAGE_USD);
// Polymarket enforces a per-market minimum order size (default 5 shares). A
// 5-share arb at ~$1/share costs ~$5, which exceeds MAX_PACKAGE_USD ($1). This
// ceiling lets the per-package budget auto-expand just enough to satisfy the
// exchange minimum, while still hard-bounding spend. Defaults to whichever is
// larger: the configured per-package cap, or $6 (covers ~5 shares near $1).
const MAX_PACKAGE_USD_CEILING = Number(process.env.MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD_CEILING ?? MAX_PACKAGE_USD);
const MAX_DAILY_USD = Number(process.env.MONOTONIC_ARB_REAL_PM_MAX_DAILY_USD ?? process.env.SPORTS_ARB_MAX_DAILY_USD ?? 200);
const MAX_OPEN_PACKAGES = Number(process.env.MONOTONIC_ARB_REAL_PM_MAX_OPEN_PACKAGES ?? process.env.SPORTS_ARB_MAX_OPEN_PACKAGES ?? 50);
const MAX_PACKAGES_PER_RUN = Number(process.env.MONOTONIC_ARB_REAL_PM_MAX_PER_RUN ?? 1);
const MIN_EDGE = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_EDGE ?? 0.001);
const MIN_LIQUIDITY = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_LIQUIDITY ?? 10_000);
const MAX_SPREAD = Number(process.env.MONOTONIC_ARB_REAL_PM_MAX_SPREAD ?? 0.01);
const MIN_AVAILABLE_SHARES = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_AVAILABLE_SHARES ?? 10);
const MIN_ORDER_SHARES = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_ORDER_SHARES ?? 1);
// CLOB rejects marketable BUY orders below $1 notional, even if the share count
// clears the per-market min_order_size. Because a monotonic package submits two
// separate FAK BUY orders, each leg must independently clear this floor.
const MIN_MARKETABLE_BUY_USD = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_MARKETABLE_BUY_USD ?? 1);
const FILL_WAIT_MS = Number(process.env.MONOTONIC_ARB_REAL_PM_FILL_WAIT_MS ?? 3000);
const FETCH_TIMEOUT_MS = Number(process.env.MONOTONIC_ARB_REAL_PM_FETCH_TIMEOUT_MS ?? 12_000);
const MARKET_CONCURRENCY = Math.max(1, Number(process.env.MONOTONIC_ARB_REAL_PM_MARKET_CONCURRENCY ?? 4));
const EVENT_CONCURRENCY = Math.max(1, Number(process.env.MONOTONIC_ARB_REAL_PM_EVENT_CONCURRENCY ?? 2));
const EPSILON = 1e-9;
const CANDIDATE_SOURCE = process.env.MONOTONIC_ARB_REAL_PM_SOURCE ?? "portfolio";
const TARGET_PACKAGE_ID = process.env.MONOTONIC_ARB_REAL_PM_PACKAGE_ID?.trim();
const SOCKS_PROXY = process.env.SOCKS_PROXY || process.env.ALL_PROXY || undefined;
const SKIP_VPN = process.env.MONOTONIC_ARB_REAL_PM_SKIP_VPN === "1" || process.argv.includes("--skip-vpn");
const ALLOWED_ASSETS = new Set((process.env.MONOTONIC_ARB_REAL_PM_ASSETS ?? "BTC,ETH,GOLD,SOL,SILVER,SPY,NBA,SOCCER,MLB,FINANCE")
  .split(",")
  .map((asset) => asset.trim().toUpperCase())
  .filter(Boolean));

/** Price path at submit: WS snapshot → REST preflight → actual FAK fills. */
export type ExecutionQuote = {
  wsCost: number;
  freshCost: number;
  actualPairCost: number | null;
  preflightFetchMs?: number;
  recordedAt: string;
};

type LivePackage = {
  id: string;
  packageId: string;
  status: "quoted" | "leg1_submitted" | "leg1_filled" | "leg2_submitted" | "package_complete" | "unwind_required" | "dry_run";
  createdAt: string;
  updatedAt: string;
  dryRun: boolean;
  walletAddress: string;
  asset: string;
  eventSlug: string;
  direction: Direction;
  broadStrike: number;
  narrowStrike: number;
  intendedShares: number;
  filledShares: number;
  intendedCost: number;
  actualCost: number;
  guaranteedFloor: number;
  lockedFloorProfit: number;
  jackpotPayout: number;
  settlementWindow: { startDate: string | null; endDate: string | null };
  legOrderIds: { broadYes?: string; narrowNo?: string };
  latency?: Record<string, unknown>;
  tokenIds: { broadYes: string; narrowNo: string };
  prices: { broadYesAsk: number; narrowNoAsk: number; packageCost: number };
  executionQuote?: ExecutionQuote;
  packageLegs: Array<{
    role: "broad_yes" | "narrow_no";
    instrumentType: "pm_yes" | "pm_no";
    instrumentId: string;
    instrumentLabel: string;
    entryPrice: number;
    strike: number;
    direction: Direction;
    yesBid: number;
    yesAsk: number;
    yesBidSize?: number | null;
    yesAskSize?: number | null;
    startDate?: string | null;
  }>;
  failureReason?: string;
};
type LiveOrder = {
  packageId: string;
  createdAt: string;
  role: "broad_yes" | "narrow_no" | "completion" | "unwind";
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  orderType: string;
  response: unknown;
};
type PortfolioPosition = {
  id?: string;
  openedAt?: string;
  asset?: string;
  signalType?: string;
  instrumentType?: string;
  instrumentId?: string;
  instrumentLabel?: string;
  packageLegs?: Array<{
    role?: string;
    instrumentType?: string;
    instrumentId?: string;
    instrumentLabel?: string;
    strike?: number;
    direction?: Direction;
    startDate?: string | null;
  }>;
};
type Portfolio = {
  positions?: PortfolioPosition[];
};

// Build the shared core config from this script's env-derived gates so the
// hourly executor and the daemon evaluate candidates identically.
const arbConfig: ArbCoreConfig = {
  host: HOST,
  gammaApi: GAMMA_API,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
  marketConcurrency: MARKET_CONCURRENCY,
  eventConcurrency: EVENT_CONCURRENCY,
  allowedAssets: ALLOWED_ASSETS,
  minEdge: MIN_EDGE,
  maxSpread: MAX_SPREAD,
  minLiquidity: MIN_LIQUIDITY,
  minAvailableShares: MIN_AVAILABLE_SHARES,
};

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function writeJsonArray<T>(path: string, rows: T[]) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
}

function appendJsonArray<T>(path: string, rows: T[]) {
  writeJsonArray(path, [...readJsonArray<T>(path), ...rows]);
}

function eventSlugs(): string[] {
  const override = process.env.MONOTONIC_ARB_REAL_PM_EVENT_SLUGS;
  const base = override
    ? override.split(",").map((slug) => slug.trim()).filter(Boolean)
    : defaultEventSlugs();
  const extra = [
    process.env.MONOTONIC_ARB_REAL_PM_EXTRA_EVENT_SLUGS ?? "",
    process.env.MONOTONIC_ARB_REAL_PM_SOCCER_EVENT_SLUGS ?? "",
    process.env.MONOTONIC_ARB_REAL_PM_MLB_EVENT_SLUGS ?? "",
  ].join(",").split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  return [...base, ...extra].filter((slug, idx, slugs) => slugs.indexOf(slug) === idx);
}

function marketIdFromInstrumentId(instrumentId: string | undefined): string | null {
  if (!instrumentId) return null;
  const parts = instrumentId.split("::");
  return parts.length >= 2 ? parts[1] : null;
}

function slugFromInstrumentId(instrumentId: string | undefined): string | null {
  if (!instrumentId) return null;
  const parts = instrumentId.split("::");
  return parts[0] || null;
}

async function candidateFromPortfolioPosition(position: PortfolioPosition, foundAt: string): Promise<Candidate | null> {
  if (position.signalType !== "MONOTONIC_ARB" || position.instrumentType !== "pm_package") return null;
  if (!position.instrumentId || !Array.isArray(position.packageLegs)) return null;
  const slug = slugFromInstrumentId(position.instrumentId);
  if (!slug) return null;
  const broadLeg = position.packageLegs.find((leg) => leg.role === "broad_yes");
  const narrowLeg = position.packageLegs.find((leg) => leg.role === "narrow_no");
  const broadMarketId = marketIdFromInstrumentId(broadLeg?.instrumentId);
  const narrowMarketId = marketIdFromInstrumentId(narrowLeg?.instrumentId);
  if (!broadMarketId || !narrowMarketId) return null;

  const event = await fetchEvent(arbConfig, slug);
  if (!event?.slug) return null;
  const asset = (position.asset ?? polymarketAssetForSlug(event.slug) ?? "").toUpperCase();
  if (!asset) return null;
  const markets = event.markets ?? [];
  const broadMarket = markets.find((market) => String(market.id ?? "") === broadMarketId);
  const narrowMarket = markets.find((market) => String(market.id ?? "") === narrowMarketId);
  if (!broadMarket || !narrowMarket) return null;
  const [broad, narrow] = await Promise.all([
    marketQuote(arbConfig, event, broadMarket),
    marketQuote(arbConfig, event, narrowMarket),
  ]);
  if (!broad || !narrow) return null;
  if (broad.direction !== narrow.direction) return null;
  const expectedBroadStrike = typeof broadLeg?.strike === "number" ? broadLeg.strike : broad.strike;
  const expectedNarrowStrike = typeof narrowLeg?.strike === "number" ? narrowLeg.strike : narrow.strike;
  if (Math.abs(broad.strike - expectedBroadStrike) > EPSILON || Math.abs(narrow.strike - expectedNarrowStrike) > EPSILON) return null;
  return evaluatePair(arbConfig, asset, broad, narrow, foundAt);
}

function parsePackageId(packageId: string): { slug: string; broadMarketId: string; narrowMarketId: string } | null {
  const match = packageId.match(/^(.+)::YES-([^+]+)\+NO-(.+)$/);
  if (!match) return null;
  return { slug: match[1], broadMarketId: match[2], narrowMarketId: match[3] };
}

async function candidateFromPackageId(packageId: string, foundAt: string): Promise<Candidate | null> {
  const parsed = parsePackageId(packageId);
  if (!parsed) throw new Error(`invalid package id format: ${packageId}`);
  const event = await fetchEvent(arbConfig, parsed.slug);
  if (!event?.slug) return null;
  const asset = (polymarketAssetForSlug(event.slug) ?? "").toUpperCase();
  if (!asset) return null;
  const markets = event.markets ?? [];
  const broadMarket = markets.find((market) => String(market.id ?? "") === parsed.broadMarketId);
  const narrowMarket = markets.find((market) => String(market.id ?? "") === parsed.narrowMarketId);
  if (!broadMarket || !narrowMarket) return null;
  const [broad, narrow] = await Promise.all([
    marketQuote(arbConfig, event, broadMarket),
    marketQuote(arbConfig, event, narrowMarket),
  ]);
  if (!broad || !narrow) return null;
  if (broad.direction !== narrow.direction) return null;
  return evaluatePair(arbConfig, asset, broad, narrow, foundAt);
}

function readPortfolio(): Portfolio {
  if (existsSync(LIVE_PORTFOLIO_FILE)) return JSON.parse(readFileSync(LIVE_PORTFOLIO_FILE, "utf-8")) as Portfolio;
  const tracked = join(DATA_DIR, "portfolio.json");
  if (existsSync(tracked)) return JSON.parse(readFileSync(tracked, "utf-8")) as Portfolio;
  return { positions: [] };
}

async function portfolioCandidates(foundAt: string, alreadyOpen: Set<string>): Promise<{ candidates: Candidate[]; errors: string[] }> {
  const portfolio = readPortfolio();
  const positions = (portfolio.positions ?? [])
    .filter((position) =>
      position.signalType === "MONOTONIC_ARB" &&
      position.instrumentType === "pm_package" &&
      !!position.instrumentId &&
      !alreadyOpen.has(position.instrumentId)
    );
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  for (const position of positions) {
    try {
      const candidate = await candidateFromPortfolioPosition(position, foundAt);
      if (candidate) candidates.push(candidate);
      else errors.push(`${position.instrumentId}: unable_to_requote_portfolio_package`);
    } catch (error: any) {
      errors.push(`${position.instrumentId}: ${error?.message ?? String(error)}`);
    }
  }
  return { candidates, errors };
}

async function scanCandidates(foundAt: string): Promise<{ candidates: Candidate[]; errors: string[] }> {
  return findCandidates(arbConfig, eventSlugs(), foundAt);
}

async function clobClient(): Promise<{ signer: ethers.Wallet; client: ClobClient; creds: ApiKeyCreds }> {
  const signer = signerFromEnv();
  const clientOptions = {
    host: HOST,
    chain: CHAIN_ID,
    signer,
    signatureType: POLYMARKET_SIGNATURE_TYPE,
    funderAddress: POLYMARKET_FUNDER_ADDRESS,
    useServerTime: true,
  };
  const l1 = new ClobClient(clientOptions);
  const creds = await l1.createOrDeriveApiKey() as ApiKeyCreds;
  return { signer, client: new ClobClient({ ...clientOptions, creds, throwOnError: true }), creds };
}

function signerFromEnv(): ethers.Wallet {
  const privateKey = process.env.PRIVATE_KEY?.trim();
  if (privateKey) return new ethers.Wallet(privateKey);

  const mnemonic = process.env.HYPERLIQUID_MNEMONIC?.trim();
  if (mnemonic) return ethers.Wallet.fromMnemonic(mnemonic);

  throw new Error("Missing PRIVATE_KEY or HYPERLIQUID_MNEMONIC");
}

function hasWalletSecret(): boolean {
  return !!process.env.PRIVATE_KEY?.trim() || !!process.env.HYPERLIQUID_MNEMONIC?.trim();
}

function hasRelayerApiKey(): boolean {
  return !!RELAYER_API_KEY && !!RELAYER_API_KEY_ADDRESS;
}

function hasBuilderApiKey(): boolean {
  return !!POLY_BUILDER_API_KEY && !!POLY_BUILDER_PASSPHRASE && !!POLY_BUILDER_SECRET;
}

function assertAddress(value: string | undefined, label: string): string {
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed Ethereum address`);
  }
  return value;
}

async function relayerNonce(address: string, txType: string): Promise<string> {
  const url = `${RELAYER_URL.replace(/\/$/, "")}/nonce?${new URLSearchParams({ address, type: txType })}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Relayer nonce probe failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const payload = await response.json();
  return String(payload?.nonce ?? "");
}

async function relayerProbe(): Promise<{ address: string; proxyWallet: string; txType: string; nonce: string; recentTransactions: number }> {
  const address = assertAddress(RELAYER_API_KEY_ADDRESS, "RELAYER_API_KEY_ADDRESS");
  const proxyWallet = assertAddress(PROXY_WALLET_ADDRESS, "POLYMARKET_PROXY_WALLET_ADDRESS");
  if (RELAYER_TX_TYPE !== "PROXY" && RELAYER_TX_TYPE !== "SAFE") {
    throw new Error(`POLYMARKET_RELAYER_TX_TYPE must be PROXY or SAFE, got ${RELAYER_TX_TYPE}`);
  }
  if (!RELAYER_API_KEY) throw new Error("Missing RELAYER_API_KEY");
  const [nonce, response] = await Promise.all([
    relayerNonce(address, RELAYER_TX_TYPE),
    fetch(`${RELAYER_URL.replace(/\/$/, "")}/transactions`, {
    headers: {
      Accept: "application/json",
      RELAYER_API_KEY,
      RELAYER_API_KEY_ADDRESS: address,
    },
    }),
  ]);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Relayer probe failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const transactions = await response.json();
  return {
    address,
    proxyWallet,
    txType: RELAYER_TX_TYPE,
    nonce,
    recentTransactions: Array.isArray(transactions) ? transactions.length : 0,
  };
}

function parseClobUnits(value: unknown): number {
  const raw = String(value ?? "0");
  if (/^\d+$/.test(raw)) return Number(raw) / 1_000_000;
  return parseNumber(raw);
}

function parseCollateralAllowance(collateral: any): number {
  if (collateral?.allowance !== undefined) return parseClobUnits(collateral.allowance);
  const allowances = collateral?.allowances;
  if (!allowances || typeof allowances !== "object") return 0;
  const parsed = Object.values(allowances).map(parseClobUnits).filter((value) => Number.isFinite(value));
  return parsed.length ? Math.min(...parsed) : 0;
}

async function accountProbe(client: ClobClient, address: string) {
  const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const openOrders = await client.getOpenOrders();
  return {
    walletAddress: address,
    collateralBalance: parseClobUnits((collateral as any).balance),
    collateralAllowance: parseCollateralAllowance(collateral),
    rawCollateral: collateral,
    openOrderCount: Array.isArray(openOrders) ? openOrders.length : 0,
  };
}

async function proxyCollateralProbe(address: string): Promise<{
  address: string;
  collateralBalance: number;
  exchangeV2Allowance: number;
  negRiskExchangeV2Allowance: number;
}> {
  const provider = getPolygonProvider();
  const erc20 = new ethers.Contract(PUSD_ADDRESS, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
  ], provider);
  const [balance, exchangeAllowance, negRiskAllowance] = await Promise.all([
    erc20.balanceOf(address),
    erc20.allowance(address, EXCHANGE_V2_ADDRESS),
    erc20.allowance(address, NEG_RISK_EXCHANGE_V2_ADDRESS),
  ]);
  return {
    address,
    collateralBalance: parseFloat(ethers.utils.formatUnits(balance, 6)),
    exchangeV2Allowance: parseFloat(ethers.utils.formatUnits(exchangeAllowance, 6)),
    negRiskExchangeV2Allowance: parseFloat(ethers.utils.formatUnits(negRiskAllowance, 6)),
  };
}

function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function spentToday(rows: LivePackage[]): number {
  const key = todayKey();
  return rows
    .filter((row) => row.createdAt.slice(0, 10) === key && !row.dryRun && row.status !== "unwind_required")
    .reduce((sum, row) => sum + (row.actualCost || row.intendedCost || 0), 0);
}

function openPackageCount(rows: LivePackage[]): number {
  return rows.filter((row) => ["quoted", "leg1_submitted", "leg1_filled", "leg2_submitted", "package_complete"].includes(row.status)).length;
}

// Each leg is a distinct order in its own market, so the package must buy at
// least the larger of the two markets' minimum order sizes (Polymarket default
// 5 shares), and never fewer than our own MIN_ORDER_SHARES floor.
function requiredMinShares(candidate: Candidate): number {
  const broadNotionalShares = candidate.broad.yesBook.ask > 0
    ? Math.ceil((MIN_MARKETABLE_BUY_USD / candidate.broad.yesBook.ask) * 100) / 100
    : Number.POSITIVE_INFINITY;
  const narrowNotionalShares = candidate.narrow.noBook.ask > 0
    ? Math.ceil((MIN_MARKETABLE_BUY_USD / candidate.narrow.noBook.ask) * 100) / 100
    : Number.POSITIVE_INFINITY;
  return Math.max(
    MIN_ORDER_SHARES,
    candidate.broad.yesBook.minOrderSize,
    candidate.narrow.noBook.minOrderSize,
    broadNotionalShares,
    narrowNotionalShares,
  );
}

function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-7;
}

/** Marketable BUY: maker (USDC) ≤2dp, taker (shares) ≤4dp. */
function clobBuyAmountValid(price: number, shares: number): boolean {
  return hasAtMostDecimals(price * shares, 2) && hasAtMostDecimals(shares, 4);
}

function clobBuyAmountsValid(candidate: Candidate, shares: number): boolean {
  // For marketable BUY orders the CLOB accepts USDC maker amounts only to cents.
  // Both arb legs are separate FAK BUYs, so both leg notionals must be cent-exact.
  return clobBuyAmountValid(candidate.broad.yesBook.ask, shares)
    && clobBuyAmountValid(candidate.narrow.noBook.ask, shares);
}

/**
 * Largest share size in [minShares, maxShares] (centi-share steps) whose
 * marketable BUY amounts satisfy CLOB decimal rules at `price`.
 * Used for hedges/completions after a first-leg fill that may not be
 * precision-safe at the complement ask (e.g. 6.1 @ 0.93 → $5.673).
 */
function precisionSafeBuyShares(price: number, minShares: number, maxShares: number): number | null {
  if (!(price > 0)) return null;
  const start = Math.ceil((minShares - EPSILON) * 100) / 100;
  const end = Math.floor((maxShares + EPSILON) * 100) / 100;
  if (end + EPSILON < start) return null;
  for (let units = Math.round(end * 100); units >= Math.round(start * 100); units -= 1) {
    const shares = units / 100;
    if (clobBuyAmountValid(price, shares)) return shares;
  }
  return null;
}

function precisionSafeShares(candidate: Candidate, minShares: number, maxShares: number): number | null {
  const start = Math.ceil((minShares - EPSILON) * 100) / 100;
  const end = Math.floor((maxShares + EPSILON) * 100) / 100;
  for (let units = Math.round(end * 100); units >= Math.round(start * 100); units -= 1) {
    const shares = units / 100;
    if (clobBuyAmountsValid(candidate, shares)) return shares;
  }
  return null;
}

function sizeForCandidate(candidate: Candidate, packageRows: LivePackage[], spendableUsd = Number.POSITIVE_INFINITY): { shares: number; cost: number; reason?: string } {
  const remainingDailyUsd = Math.max(0, MAX_DAILY_USD - spentToday(packageRows));
  if (remainingDailyUsd <= 0) return { shares: 0, cost: 0, reason: "daily_cap_exhausted" };

  const minShares = requiredMinShares(candidate);
  // The touch must have enough depth to fill the exchange-minimum order.
  if (candidate.availableSize + EPSILON < minShares) {
    return { shares: candidate.availableSize, cost: candidate.availableSize * candidate.packageCost, reason: `touch_below_exchange_min_${minShares}` };
  }

  // Auto-expand the per-package budget up to the ceiling so a 5-share arb fits,
  // but never beyond the ceiling or the remaining daily budget.
  const neededUsd = minShares * candidate.packageCost;
  const perPackageUsd = Math.min(MAX_PACKAGE_USD_CEILING, Math.max(MAX_PACKAGE_USD, neededUsd));
  const maxUsd = Math.min(perPackageUsd, remainingDailyUsd, spendableUsd);
  if (maxUsd + EPSILON < neededUsd) {
    return { shares: 0, cost: 0, reason: `budget_below_exchange_min cap=$${maxUsd.toFixed(2)} needs=$${neededUsd.toFixed(2)}` };
  }

  const maxShares = Math.floor(Math.min(candidate.availableSize, maxUsd / candidate.packageCost) * 100) / 100;
  let shares = precisionSafeShares(candidate, minShares, maxShares) ?? 0;
  // Guard against floating-point shaving the affordable size just under the min
  // when the budget was sized exactly to cover it.
  if (shares + 1e-6 >= minShares && shares < minShares) shares = minShares;
  const cost = shares * candidate.packageCost;
  if (shares + EPSILON < minShares) return { shares, cost, reason: `shares_below_min_order_${minShares}` };
  if (!clobBuyAmountsValid(candidate, shares)) return { shares, cost, reason: "clob_amount_precision_unavailable" };
  return { shares, cost };
}

function orderId(response: any): string | undefined {
  return response?.orderID ?? response?.orderId ?? response?.id ?? response?.order_id;
}

function assertOrderResponse(response: any, role: string) {
  const errorMsg = String(response?.errorMsg ?? response?.error ?? "").trim();
  if (response?.success === false || errorMsg) {
    throw new Error(`${role} order rejected: ${errorMsg || JSON.stringify(response).slice(0, 500)}`);
  }
  const status = String(response?.status ?? "").toUpperCase();
  if (status && ["FAILED", "REJECTED", "CANCELLED", "CANCELED"].includes(status)) {
    throw new Error(`${role} order status ${status}: ${JSON.stringify(response).slice(0, 500)}`);
  }
  if (!orderId(response)) {
    throw new Error(`${role} order missing order id: ${JSON.stringify(response).slice(0, 500)}`);
  }
}

function roundShares(value: number): number {
  return Math.floor(Math.max(0, value) * 1_000_000) / 1_000_000;
}

async function postFakBuy(client: ClobClient, tokenId: string, price: number, shares: number): Promise<any> {
  // Last-line defense: never submit a marketable BUY the CLOB will reject for
  // maker/taker decimal rules (seen live as narrow_no size=0 / "invalid amounts").
  const safeShares = precisionSafeBuyShares(price, 0, shares);
  if (!safeShares || safeShares <= 0) {
    throw new Error(
      `clob_amount_precision_unavailable price=${price} shares=${shares} (maker≤2dp taker≤4dp)`,
    );
  }
  const tickSize = await client.getTickSize(tokenId) as TickSize;
  const signedOrder = await client.createOrder(
    { tokenID: tokenId, price, size: Number(safeShares.toFixed(4)), side: Side.BUY, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize, negRisk: false },
  );
  return client.postOrder(signedOrder, OrderType.FAK);
}

async function postFakBuyBatch(
  client: ClobClient,
  legs: Array<{ tokenId: string; price: number; shares: number }>,
): Promise<any[]> {
  const signed = await Promise.all(legs.map(async (leg) => {
    const safeShares = precisionSafeBuyShares(leg.price, 0, leg.shares);
    if (!safeShares || safeShares <= 0) {
      throw new Error(
        `clob_amount_precision_unavailable price=${leg.price} shares=${leg.shares} (maker≤2dp taker≤4dp)`,
      );
    }
    const tickSize = await client.getTickSize(leg.tokenId) as TickSize;
    const order = await client.createOrder(
      { tokenID: leg.tokenId, price: leg.price, size: Number(safeShares.toFixed(4)), side: Side.BUY, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
      { tickSize, negRisk: false },
    );
    return { order, orderType: OrderType.FAK };
  }));
  const response = await client.postOrders(signed);
  return Array.isArray(response) ? response : [response];
}

async function postLimitBuy(client: ClobClient, tokenId: string, price: number, shares: number): Promise<any> {
  const tickSize = await client.getTickSize(tokenId) as TickSize;
  const signedOrder = await client.createOrder(
    { tokenID: tokenId, price, size: Number(shares.toFixed(6)), side: Side.BUY, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize, negRisk: false },
  );
  return client.postOrder(signedOrder, OrderType.GTC);
}

async function postLimitSell(client: ClobClient, tokenId: string, price: number, shares: number): Promise<any> {
  const tickSize = await client.getTickSize(tokenId) as TickSize;
  const signedOrder = await client.createOrder(
    { tokenID: tokenId, price, size: Number(shares.toFixed(6)), side: Side.SELL, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize, negRisk: false },
  );
  return client.postOrder(signedOrder, OrderType.GTC);
}

// FAK sell to flatten a position (used by the daemon to unwind a naked leg).
// Crosses the spread at `price` (caller passes best bid) so the orphan exits
// immediately rather than resting on the book.
async function postFakSell(client: ClobClient, tokenId: string, price: number, shares: number): Promise<any> {
  const tickSize = await client.getTickSize(tokenId) as TickSize;
  const signedOrder = await client.createOrder(
    { tokenID: tokenId, price, size: Number(shares.toFixed(6)), side: Side.SELL, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize, negRisk: false },
  );
  return client.postOrder(signedOrder, OrderType.FAK);
}

function redactedOrderPayload(payload: any): any {
  if (!payload?.order) return payload;
  return {
    ...payload,
    owner: payload.owner ? "<clob-api-key-redacted>" : payload.owner,
    order: {
      ...payload.order,
      signature: payload.order.signature ? "<signature-redacted>" : payload.order.signature,
    },
  };
}

async function buildFakBuyPayload(
  client: ClobClient,
  role: "broad_yes" | "narrow_no",
  tokenId: string,
  price: number,
  shares: number,
): Promise<any> {
  const tickSize = await client.getTickSize(tokenId) as TickSize;
  const signedOrder = await client.createOrder(
    { tokenID: tokenId, price, size: Number(shares.toFixed(6)), side: Side.BUY, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize, negRisk: false },
  );
  if (!isV2Order(signedOrder)) {
    throw new Error(`${role} build-only expected CLOB V2 signed order`);
  }
  if (Number(signedOrder.makerAmount) <= 0 || Number(signedOrder.takerAmount) <= 0) {
    throw new Error(`${role} build-only produced zero-sized order: makerAmount=${signedOrder.makerAmount} takerAmount=${signedOrder.takerAmount}`);
  }
  return {
    role,
    tickSize,
    tokenId,
    price,
    shares: Number(shares.toFixed(6)),
    usdAmount: Number((shares * price).toFixed(6)),
    payload: redactedOrderPayload(orderToJsonV2(signedOrder, CLOB_API_OWNER, OrderType.FAK)),
  };
}

async function buildOnlyCandidate(
  client: ClobClient | null,
  signer: ethers.Wallet | null,
  candidate: Candidate,
  shares: number,
): Promise<void> {
  const leg1Usd = shares * candidate.broad.yesBook.ask;
  const leg2Usd = shares * candidate.narrow.noBook.ask;
  console.log(`Build-only: ${candidate.asset} ${candidate.eventSlug} ${candidate.direction} YES ${candidate.broad.strike} + NO ${candidate.narrow.strike}`);
  console.log(`  entry=${candidate.packageCost.toFixed(4)} edge=${(candidate.lockedEdge * 100).toFixed(2)}c shares=${shares.toFixed(2)} cost=$${(leg1Usd + leg2Usd).toFixed(4)}`);
  console.log(`  clobSignatureType=${POLYMARKET_SIGNATURE_TYPE} funder=${POLYMARKET_FUNDER_ADDRESS ?? "unset"} builderCode=${POLY_BUILDER_CODE ? "set" : "unset"}`);

  if (!client || !signer) {
    console.log("  unsignedPlanOnly=true reason=missing PRIVATE_KEY/HYPERLIQUID_MNEMONIC; CLOB PROXY order signing still requires the owner signer.");
    console.log(JSON.stringify({
      relayerTxType: RELAYER_TX_TYPE,
      signerAddress: RELAYER_API_KEY_ADDRESS ?? null,
      proxyWallet: PROXY_WALLET_ADDRESS ?? null,
      clobSignatureType: POLYMARKET_SIGNATURE_TYPE,
      funderAddress: POLYMARKET_FUNDER_ADDRESS ?? null,
      orderType: "FAK",
      orders: [
        { role: "broad_yes", tokenId: candidate.broad.yesTokenId, side: "BUY", price: candidate.broad.yesBook.ask, usdAmount: Number(leg1Usd.toFixed(6)) },
        { role: "narrow_no", tokenId: candidate.narrow.noTokenId, side: "BUY", price: candidate.narrow.noBook.ask, usdAmount: Number(leg2Usd.toFixed(6)) },
      ],
    }, null, 2));
    return;
  }

  const [broadYes, narrowNo] = await Promise.all([
    buildFakBuyPayload(client, "broad_yes", candidate.broad.yesTokenId, candidate.broad.yesBook.ask, shares),
    buildFakBuyPayload(client, "narrow_no", candidate.narrow.noTokenId, candidate.narrow.noBook.ask, shares),
  ]);
  console.log("  signedPayloadsBuilt=true submit=false");
  console.log(JSON.stringify({ orders: [broadYes, narrowNo] }, null, 2));
}

async function reconcileTokenBalance(address: string, tokenId: string): Promise<number> {
  const provider = getPolygonProvider();
  const ctf = new ethers.Contract(CTF_ADDRESS, ["function balanceOf(address,uint256) view returns (uint256)"], provider);
  const raw = await ctf.balanceOf(address, tokenId);
  return parseFloat(ethers.utils.formatUnits(raw, 6));
}

async function reconcilePackage(address: string, candidate: Candidate): Promise<{ broadYesBalance: number; narrowNoBalance: number; matchedShares: number }> {
  const [broadYesBalance, narrowNoBalance] = await Promise.all([
    reconcileTokenBalance(address, candidate.broad.yesTokenId),
    reconcileTokenBalance(address, candidate.narrow.noTokenId),
  ]);
  return { broadYesBalance, narrowNoBalance, matchedShares: Math.min(broadYesBalance, narrowNoBalance) };
}

function packageRecord(candidate: Candidate, walletAddress: string, shares: number, dryRun: boolean): LivePackage {
  const now = new Date().toISOString();
  const intendedCost = shares * candidate.packageCost;
  return {
    id: `PMARB-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    packageId: candidate.packageId,
    status: dryRun ? "dry_run" : "quoted",
    createdAt: now,
    updatedAt: now,
    dryRun,
    walletAddress,
    asset: candidate.asset,
    eventSlug: candidate.eventSlug,
    direction: candidate.direction,
    broadStrike: candidate.broad.strike,
    narrowStrike: candidate.narrow.strike,
    intendedShares: shares,
    filledShares: 0,
    intendedCost,
    actualCost: 0,
    guaranteedFloor: shares,
    lockedFloorProfit: shares * candidate.lockedEdge,
    jackpotPayout: shares * candidate.jackpotPayoutPerShare,
    settlementWindow: { startDate: candidate.broad.startDate ?? candidate.narrow.startDate, endDate: candidate.broad.endDate ?? candidate.narrow.endDate },
    legOrderIds: {},
    latency: {},
    tokenIds: { broadYes: candidate.broad.yesTokenId, narrowNo: candidate.narrow.noTokenId },
    prices: { broadYesAsk: candidate.broad.yesBook.ask, narrowNoAsk: candidate.narrow.noBook.ask, packageCost: candidate.packageCost },
    packageLegs: [
      {
        role: "broad_yes",
        instrumentType: "pm_yes",
        instrumentId: `${candidate.eventSlug}::${candidate.broad.marketId}`,
        instrumentLabel: `${candidate.eventSlug} - YES - ${candidate.broad.question}`,
        entryPrice: candidate.broad.yesBook.ask,
        strike: candidate.broad.strike,
        direction: candidate.direction,
        yesBid: candidate.broad.yesBook.bid,
        yesAsk: candidate.broad.yesBook.ask,
        yesBidSize: candidate.broad.yesBook.bidSize,
        yesAskSize: candidate.broad.yesBook.askSize,
        startDate: candidate.broad.startDate,
      },
      {
        role: "narrow_no",
        instrumentType: "pm_no",
        instrumentId: `${candidate.eventSlug}::${candidate.narrow.marketId}`,
        instrumentLabel: `${candidate.eventSlug} - NO - ${candidate.narrow.question}`,
        entryPrice: candidate.narrow.noBook.ask,
        strike: candidate.narrow.strike,
        direction: candidate.direction,
        yesBid: candidate.narrow.yesBook.bid,
        yesAsk: candidate.narrow.yesBook.ask,
        yesBidSize: candidate.narrow.yesBook.bidSize,
        yesAskSize: candidate.narrow.yesBook.askSize,
        startDate: candidate.narrow.startDate,
      },
    ],
  };
}

async function executeCandidate(client: ClobClient, walletAddress: string, candidate: Candidate, shares: number, packageRows: LivePackage[]) {
  const record = packageRecord(candidate, walletAddress, shares, DRY_RUN);
  const orders: LiveOrder[] = [];
  const leg1Usd = shares * candidate.broad.yesBook.ask;
  const leg2Usd = shares * candidate.narrow.noBook.ask;

  console.log(`Candidate: ${candidate.asset} ${candidate.eventSlug} ${candidate.direction} YES ${candidate.broad.strike} + NO ${candidate.narrow.strike}`);
  console.log(`  entry=${candidate.packageCost.toFixed(4)} edge=${(candidate.lockedEdge * 100).toFixed(2)}c shares=${shares.toFixed(2)} cost=$${(leg1Usd + leg2Usd).toFixed(4)}`);
  console.log(`  settlement=${record.settlementWindow.startDate} -> ${record.settlementWindow.endDate}`);

  if (DRY_RUN) {
    console.log("Dry run: not posting real orders.");
    return { record, orders };
  }

  try {
    record.status = "leg1_submitted";
    record.updatedAt = new Date().toISOString();
    appendJsonArray(PACKAGES_PATH, [record]);

    const leg1Before = await reconcileTokenBalance(walletAddress, candidate.broad.yesTokenId);
    const leg1 = await postFakBuy(client, candidate.broad.yesTokenId, candidate.broad.yesBook.ask, shares);
    assertOrderResponse(leg1, "broad_yes");
    record.legOrderIds.broadYes = orderId(leg1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, FILL_WAIT_MS));
    const leg1After = await reconcileTokenBalance(walletAddress, candidate.broad.yesTokenId);
    const leg1Filled = roundShares(leg1After - leg1Before);
    orders.push({ packageId: record.packageId, createdAt: new Date().toISOString(), role: "broad_yes", tokenId: candidate.broad.yesTokenId, side: "BUY", price: candidate.broad.yesBook.ask, size: leg1Filled, orderType: "FAK", response: leg1 });
    record.status = "leg1_filled";
    record.updatedAt = new Date().toISOString();
    // leg2 buys leg1Filled shares; it must clear the narrow-NO market's minimum
    // or the exchange will reject it. Bail (and flag for unwind) if leg1 filled
    // too little to place a valid second leg.
    const leg2Min = Math.max(MIN_ORDER_SHARES, candidate.narrow.noBook.minOrderSize);
    if (leg1Filled < leg2Min) {
      record.status = "unwind_required";
      record.failureReason = `leg1_fill_below_min broad_yes=${leg1Filled} leg2Min=${leg2Min} intended=${shares}`;
      const rows = packageRows.filter((row) => row.id !== record.id);
      writeJsonArray(PACKAGES_PATH, [...rows, record]);
      appendJsonArray(ORDERS_PATH, orders);
      return { record, orders };
    }

    const leg2TargetShares = leg1Filled;
    const leg2Before = await reconcileTokenBalance(walletAddress, candidate.narrow.noTokenId);
    const leg2 = await postFakBuy(client, candidate.narrow.noTokenId, candidate.narrow.noBook.ask, leg2TargetShares);
    assertOrderResponse(leg2, "narrow_no");
    record.legOrderIds.narrowNo = orderId(leg2);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, FILL_WAIT_MS));
    const leg2After = await reconcileTokenBalance(walletAddress, candidate.narrow.noTokenId);
    const leg2Filled = roundShares(leg2After - leg2Before);
    orders.push({ packageId: record.packageId, createdAt: new Date().toISOString(), role: "narrow_no", tokenId: candidate.narrow.noTokenId, side: "BUY", price: candidate.narrow.noBook.ask, size: leg2Filled, orderType: "FAK", response: leg2 });
    record.status = "leg2_submitted";
    record.updatedAt = new Date().toISOString();

    const recon = await reconcilePackage(walletAddress, candidate);
    const matchedThisRun = roundShares(Math.min(leg1Filled, leg2Filled));
    record.filledShares = matchedThisRun;
    record.actualCost = (leg1Filled * candidate.broad.yesBook.ask) + (leg2Filled * candidate.narrow.noBook.ask);
    record.guaranteedFloor = matchedThisRun;
    record.lockedFloorProfit = matchedThisRun * candidate.lockedEdge;
    record.jackpotPayout = matchedThisRun * candidate.jackpotPayoutPerShare;
    record.status = matchedThisRun >= MIN_ORDER_SHARES && leg2Filled >= leg1Filled * 0.99 ? "package_complete" : "unwind_required";
    if (record.status === "unwind_required") {
      record.failureReason = `partial_package_mismatch leg1=${leg1Filled} leg2=${leg2Filled} matched_this_run=${matchedThisRun} wallet_broad_yes=${recon.broadYesBalance} wallet_narrow_no=${recon.narrowNoBalance} intended=${shares}`;
    }
    record.updatedAt = new Date().toISOString();
    const rows = packageRows.filter((row) => row.id !== record.id);
    writeJsonArray(PACKAGES_PATH, [...rows, record]);
    appendJsonArray(ORDERS_PATH, orders);
    return { record, orders };
  } catch (error: any) {
    record.status = "unwind_required";
    record.failureReason = error?.message ?? String(error);
    record.updatedAt = new Date().toISOString();
    const rows = readJsonArray<LivePackage>(PACKAGES_PATH).filter((row) => row.id !== record.id);
    writeJsonArray(PACKAGES_PATH, [...rows, record]);
    appendJsonArray(ORDERS_PATH, orders);
    throw error;
  }
}

async function main() {
  // Route every real Polymarket order through the VPN guard. activateProxy()
  // patches the Node global agent, so the CLOB client's internal axios calls
  // (API-key derivation, order posting, reconciliation) all exit via the
  // SOCKS5 proxy. This lives entirely in the executor — the scanner and
  // trading engine are untouched.
  const vpnGuard = new VpnGuard({
    socksProxy: SOCKS_PROXY,
    skipChecks: DRY_RUN || SKIP_VPN,
    onVpnDrop: (reason) => {
      console.error(`\n[VPN] *** VPN DROPPED *** ${reason}`);
      console.error(`[VPN] Halting real PM executor immediately — no further orders.`);
      process.exit(1);
    },
  });
  vpnGuard.activateProxy();
  if (!DRY_RUN) {
    try {
      await vpnGuard.verifyLocation();
    } catch (err: any) {
      console.error(`\n[VPN] *** BLOCKED *** ${err.message}`);
      console.error(`[VPN] Cannot place real Polymarket orders without VPN to an allowed country.`);
      process.exit(1);
    }
    vpnGuard.startMonitoring();
  }
  console.log(`VPN: ${DRY_RUN || SKIP_VPN ? "SKIPPED" : SOCKS_PROXY ? "SOCKS5 proxy" : "system VPN"}`);

  try {
    await runExecutor();
  } finally {
    vpnGuard.stopMonitoring();
  }
}

async function runExecutor() {
  const hasSignerSecret = hasWalletSecret();
  const relayerConfigured = hasRelayerApiKey();
  const builderConfigured = hasBuilderApiKey();
  let signer: ethers.Wallet | null = null;
  let client: ClobClient | null = null;
  let probe: Awaited<ReturnType<typeof accountProbe>> | null = null;
  if (hasSignerSecret) {
    const created = await clobClient();
    signer = created.signer;
    client = created.client;
    probe = await accountProbe(client, signer.address);
    console.log(`Wallet: ${probe.walletAddress}`);
    console.log(`Collateral balance=${probe.collateralBalance} allowance=${probe.collateralAllowance} openOrders=${probe.openOrderCount}`);
  } else {
    if (!DRY_RUN && !relayerConfigured) throw new Error("Missing PRIVATE_KEY/HYPERLIQUID_MNEMONIC or RELAYER_API_KEY/RELAYER_API_KEY_ADDRESS");
    console.log(`Wallet: unavailable (${relayerConfigured ? "relayer credentials configured" : "no PRIVATE_KEY or HYPERLIQUID_MNEMONIC set"})`);
  }
  console.log(`Mode: ${DRY_RUN ? "DRY_RUN" : "REAL"} enabled=${ENABLED} hardDisabled=${HARD_DISABLED}`);
  console.log(`Real PM gates: maxPackage=$${MAX_PACKAGE_USD} maxDaily=$${MAX_DAILY_USD} maxPerRun=${MAX_PACKAGES_PER_RUN} minEdge=${(MIN_EDGE * 100).toFixed(2)}c minTouchShares=${MIN_AVAILABLE_SHARES}`);
  console.log(`Auth: wallet=${hasSignerSecret ? "set" : "missing"} relayer=${relayerConfigured ? "set" : "missing"} builder=${builderConfigured ? "set" : "missing"} builderCode=${POLY_BUILDER_CODE ? "set" : "missing"}`);

  if (relayerConfigured) {
    const relayer = await relayerProbe();
    console.log(`Relayer probe: type=${relayer.txType} signer=${relayer.address} proxyWallet=${relayer.proxyWallet} nonce=${relayer.nonce} recentTransactions=${relayer.recentTransactions}`);
  }
  const funderAddress = POLYMARKET_FUNDER_ADDRESS ?? signer?.address;
  const proxyProbe = funderAddress ? await proxyCollateralProbe(funderAddress) : null;
  if (proxyProbe) {
    console.log(`Funder collateral: address=${proxyProbe.address} pUSD=${proxyProbe.collateralBalance.toFixed(6)} exchangeV2Allowance=${proxyProbe.exchangeV2Allowance.toFixed(2)} negRiskExchangeV2Allowance=${proxyProbe.negRiskExchangeV2Allowance.toFixed(2)}`);
  }

  if (PROBE_ONLY) return;

  if (BUILD_ONLY) {
    console.log("Build-only mode: constructing CLOB order plans/payloads only; no CLOB postOrder and no relayer /submit.");
  }

  if (!DRY_RUN && (!client || !signer || !probe)) throw new Error("Real mode requires initialized wallet/client");
  if (!DRY_RUN) {
    if (!proxyProbe || proxyProbe.collateralBalance < MAX_PACKAGE_USD) {
      console.log(`Skip: funder pUSD balance $${(proxyProbe?.collateralBalance ?? 0).toFixed(6)} is below package budget $${MAX_PACKAGE_USD}; waiting for open positions to resolve.`);
      return;
    }
    if (proxyProbe.exchangeV2Allowance < MAX_PACKAGE_USD) throw new Error(`Insufficient funder Exchange V2 allowance for cap $${MAX_PACKAGE_USD}`);
  }

  const packageRows = readJsonArray<LivePackage>(PACKAGES_PATH);
  if (openPackageCount(packageRows) >= MAX_OPEN_PACKAGES) throw new Error(`Open real PM package cap reached (${MAX_OPEN_PACKAGES})`);
  const portfolioPackageIds = new Set((readPortfolio().positions ?? [])
    .filter((position) => position.signalType === "MONOTONIC_ARB" && position.instrumentType === "pm_package")
    .map((position) => position.instrumentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0));
  const alreadyOpen = new Set(packageRows
    .filter((row) => ["quoted", "leg1_submitted", "leg1_filled", "leg2_submitted", "package_complete"].includes(row.status))
    .map((row) => row.packageId));
  for (const packageId of portfolioPackageIds) alreadyOpen.add(packageId);

  const foundAt = new Date().toISOString();
  const { candidates, errors } = TARGET_PACKAGE_ID
    ? {
      candidates: [await candidateFromPackageId(TARGET_PACKAGE_ID, foundAt)].filter((candidate): candidate is Candidate => candidate !== null),
      errors: [] as string[],
    }
    : CANDIDATE_SOURCE === "scan"
      ? await scanCandidates(foundAt)
      : await portfolioCandidates(foundAt, alreadyOpen);
  const eligible = candidates
    .filter((candidate) => (BUILD_ONLY && TARGET_PACKAGE_ID
      ? true
      : candidate.eligible && !alreadyOpen.has(candidate.packageId)))
    .sort((a, b) => b.lockedEdge - a.lockedEdge)
    .slice(0, MAX_PACKAGES_PER_RUN);
  console.log(`Candidate source=${TARGET_PACKAGE_ID ? "package_id" : CANDIDATE_SOURCE}; candidates=${candidates.length}; eligibleNew=${eligible.length}`);
  for (const error of errors.slice(0, 5)) console.log(`Scan error: ${error}`);
  for (const candidate of candidates
    .filter((row) => row.lockedEdge > 0)
    .sort((a, b) => b.lockedEdge - a.lockedEdge)
    .slice(0, 5)) {
    console.log(`Positive edge: ${candidate.asset} ${candidate.eventSlug} YES ${candidate.broad.strike} + NO ${candidate.narrow.strike} edge=${(candidate.lockedEdge * 100).toFixed(2)}c size=${candidate.availableSize.toFixed(2)} eligible=${candidate.eligible}${candidate.rejectionReasons.length ? ` reasons=${candidate.rejectionReasons.join(",")}` : ""}`);
  }

  for (const candidate of eligible) {
    const sized = sizeForCandidate(candidate, packageRows);
    if (sized.reason) {
      console.log(`Skip ${candidate.packageId}: ${sized.reason} shares=${sized.shares.toFixed(2)} cost=$${sized.cost.toFixed(4)}`);
      continue;
    }
    if (BUILD_ONLY) {
      if (!candidate.eligible) {
        console.log(`Build-only target has rejection reasons: ${candidate.rejectionReasons.join(",") || "none"}`);
      }
      await buildOnlyCandidate(client, signer, candidate, sized.shares);
      continue;
    }
    const result = await executeCandidate(client!, signer?.address ?? "DRY_RUN_NO_WALLET", candidate, sized.shares, packageRows);
    console.log(`Package ${result.record.packageId} status=${result.record.status} filled=${result.record.filledShares.toFixed(2)} intended=${result.record.intendedShares.toFixed(2)}`);
  }
}

// Reusable surface for the always-on websocket daemon
// (scripts/polymarket-arb-daemon.ts). The daemon imports these proven helpers
// so order signing, sizing, ledgering, and on-chain reconciliation stay a single
// source of truth shared with this hourly executor.
export {
  arbConfig,
  clobClient,
  signerFromEnv,
  postFakBuy,
  postFakBuyBatch,
  postLimitBuy,
  postLimitSell,
  postFakSell,
  clobBuyAmountValid,
  precisionSafeBuyShares,
  sizeForCandidate,
  reconcilePackage,
  reconcileTokenBalance,
  packageRecord,
  accountProbe,
  proxyCollateralProbe,
  assertOrderResponse,
  orderId,
  roundShares,
  readJsonArray,
  writeJsonArray,
  appendJsonArray,
  spentToday,
  openPackageCount,
  eventSlugs,
  scanCandidates,
  PACKAGES_PATH,
  ORDERS_PATH,
  MAX_PACKAGE_USD,
  MAX_DAILY_USD,
  MAX_OPEN_PACKAGES,
  MIN_EDGE,
  MAX_SPREAD,
  MIN_LIQUIDITY,
  MIN_AVAILABLE_SHARES,
  MIN_ORDER_SHARES,
  MIN_MARKETABLE_BUY_USD,
  FILL_WAIT_MS,
  ENABLED,
  HARD_DISABLED,
  POLYMARKET_FUNDER_ADDRESS,
  SOCKS_PROXY,
  SKIP_VPN,
};
export type { LivePackage, LiveOrder };

// Only auto-run the hourly executor when invoked directly (tsx
// scripts/polymarket-real-monotonic-executor.ts). When imported by the daemon
// this guard prevents main() from firing on module load.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
