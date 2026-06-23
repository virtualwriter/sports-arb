// Standalone 5m Up/Down maker-guess test.
//
// This is intentionally not imported by the arb daemon or the 5m collector.
// Default mode is dry-run. Use --live only for a tiny, explicitly requested
// live experiment.
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import WebSocket from "ws";
import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import {
  assertOrderResponse,
  clobClient,
  orderId,
  POLYMARKET_FUNDER_ADDRESS,
  reconcileTokenBalance,
  roundShares,
} from "./polymarket-real-monotonic-executor.js";
import { cancelIndicatesMatched, InventoryLedger } from "./lib/updown/inventory-ledger.js";

config({ path: "config.env" });
config({ path: ".env" });

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });
config({ path: resolve(__dirname, "../../config.env") });

type GammaMarket = {
  id?: string | number;
  conditionId?: string;
  question?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  outcomes?: string;
  clobTokenIds?: string;
  endDate?: string | null;
};

type GammaEvent = {
  slug?: string;
  title?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string | null;
  markets?: GammaMarket[];
};

type BookLevel = { price?: string; size?: string };
type BookResponse = { bids?: BookLevel[]; asks?: BookLevel[]; min_order_size?: string };
type ParsedLevel = { price: number; size: number };
type Top = { bid: number; bidSize: number; ask: number; askSize: number; bids: ParsedLevel[]; asks: ParsedLevel[]; minOrderSize: number };
type TrackedMarket = {
  slug: string;
  title: string;
  marketId: string;
  conditionId: string;
  endDate: string | null;
  upTokenId: string;
  downTokenId: string;
};

const LOOP_LIVE = process.argv.includes("--loop-live") || process.env.UPDOWN_MAKER_GUESS_LOOP_LIVE === "1";
const LOOP_DRY_RUN = process.argv.includes("--loop-dry-run") || process.env.UPDOWN_MAKER_GUESS_LOOP_DRY_RUN === "1";
const LOOP_MODE = LOOP_LIVE || LOOP_DRY_RUN;
const LIVE = process.argv.includes("--live") || LOOP_LIVE || process.env.UPDOWN_MAKER_GUESS_LIVE === "1";
const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const USER_WS_URL = process.env.POLYMARKET_USER_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const MARKET_WS_URL = process.env.POLYMARKET_MARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const DATA_DIR = process.env.UPDOWN_MAKER_GUESS_DATA_DIR ?? "data";
const ATTEMPTS_PATH = process.env.UPDOWN_MAKER_GUESS_ATTEMPTS_PATH ?? join(DATA_DIR, "updown-5m-maker-guess-tests.jsonl");
const DISCOVERY_LIMIT = Number(process.env.UPDOWN_MAKER_GUESS_DISCOVERY_LIMIT ?? 100);
const FETCH_TIMEOUT_MS = Number(process.env.UPDOWN_MAKER_GUESS_FETCH_TIMEOUT_MS ?? 8_000);
const PRICE_OVERRIDE = process.env.UPDOWN_MAKER_GUESS_PRICE ?? argValue("--price") ?? "";
const TICK = Number(process.env.UPDOWN_MAKER_GUESS_TICK ?? 0.001);
const IMPROVE_BY = Number(process.env.UPDOWN_MAKER_GUESS_IMPROVE_BY ?? TICK);
const MAX_PAIR_COST = Number(process.env.UPDOWN_MAKER_GUESS_MAX_PAIR_COST ?? 0.999);
const COMPLEMENT_SAFETY_BUFFER = Number(process.env.UPDOWN_MAKER_GUESS_COMPLEMENT_SAFETY_BUFFER ?? 0.005);
// Post entries below the touch instead of improving the best bid. Session data
// showed 14/19 one-sided fills were instant (the book moved through the bid in
// the ~1s submit path), and the complement then sat a median 1.1c beyond reach.
// Bidding deeper both filters adverse instant fills and leaves completion
// headroom when a fill does happen.
const ENTRY_DEPTH = Number(process.env.UPDOWN_MAKER_GUESS_ENTRY_DEPTH ?? 0.02);
// Completion is a cheaper stop-loss than the nuclear dump: paying up to a 1c
// premium to flatten (pair sum 1.01 = -$0.10 on 10 shares) beats the observed
// average nuclear exit of about -$0.94. Entry gating still uses MAX_PAIR_COST;
// this only loosens the escape after a one-sided fill.
const MAX_COMPLETION_PAIR_COST = Number(process.env.UPDOWN_MAKER_GUESS_MAX_COMPLETION_PAIR_COST ?? 1.01);
const COMPLETION_MAKER_WAIT_MS = Number(process.env.UPDOWN_MAKER_GUESS_COMPLETION_MAKER_WAIT_MS ?? 2_000);
const COMPLETION_LADDER_TICKS = Number(process.env.UPDOWN_MAKER_GUESS_COMPLETION_LADDER_TICKS ?? 12);
const GAP_FAST_EXIT = Number(process.env.UPDOWN_MAKER_GUESS_GAP_FAST_EXIT ?? 0.03);
const MOMENTUM_CANCEL_MOVE = Number(process.env.UPDOWN_MAKER_GUESS_MOMENTUM_CANCEL_MOVE ?? 0.03);
const MOMENTUM_WINDOW_MS = Number(process.env.UPDOWN_MAKER_GUESS_MOMENTUM_WINDOW_MS ?? 500);
const HOLD_MS = Number(process.env.UPDOWN_MAKER_GUESS_HOLD_MS ?? argValue("--hold-ms") ?? 5_000);
const FILL_POLL_MS = Number(process.env.UPDOWN_MAKER_GUESS_FILL_POLL_MS ?? 250);
const COMPLETION_WINDOW_MS = Number(process.env.UPDOWN_MAKER_GUESS_COMPLETION_WINDOW_MS ?? 3_000);
const IMBALANCE_DUST_SHARES = Number(process.env.UPDOWN_MAKER_GUESS_DUST_SHARES ?? 0.01);
const COMPLEMENT_CROSS_BUFFER = Number(process.env.UPDOWN_MAKER_GUESS_COMPLEMENT_CROSS_BUFFER ?? 0.01);
const NUCLEAR_STOP_CENTS = Number(process.env.UPDOWN_MAKER_GUESS_NUCLEAR_STOP_CENTS ?? 0.01);
const NUCLEAR_EXIT_RETRIES = Number(process.env.UPDOWN_MAKER_GUESS_NUCLEAR_EXIT_RETRIES ?? 8);
// Residual sold by the nuclear stop counts as benign "dust" (e.g. FAK price-improvement
// overfill) when a profitable matched pair remains and the residual is small
// relative to the clip: at most max(NUCLEAR_DUST_MAX_SHARES, matched * fraction).
// An absolute 1-share cap misclassified 1.5-3.5 share overfills on 50-share
// clips as real nuclear exits, arming cooldowns that stalled sessions.
const NUCLEAR_DUST_MAX_SHARES = Number(process.env.UPDOWN_MAKER_GUESS_NUCLEAR_DUST_MAX_SHARES ?? 1);
const NUCLEAR_DUST_MAX_FRACTION = Number(process.env.UPDOWN_MAKER_GUESS_NUCLEAR_DUST_MAX_FRACTION ?? 0.10);
// When > 0, each loop attempt waits until BTC's 10-minute high/low range (in %)
// is below this threshold before entering.
const CALM_RANGE_PCT = Number(process.env.UPDOWN_MAKER_GUESS_CALM_RANGE_PCT ?? 0);
const CALM_RECHECK_MS = Number(process.env.UPDOWN_MAKER_GUESS_CALM_RECHECK_MS ?? 30_000);
// Refuse to post when short-term BTC momentum is running against the side we
// would post; one-sided fills in trending tape were the dominant loss driver.
// 0 disables the veto.
const TREND_VETO_PCT = Number(process.env.UPDOWN_MAKER_GUESS_TREND_VETO_PCT ?? 0.05);
const TREND_WINDOW_MS = Number(process.env.UPDOWN_MAKER_GUESS_TREND_WINDOW_MS ?? 180_000);
const TREND_POLL_MS = Number(process.env.UPDOWN_MAKER_GUESS_TREND_POLL_MS ?? 3_000);
// Pre-sign a deep FAK sell for the posted side the moment the entry posts, so
// a failed completion can flatten the naked leg in one HTTP round trip instead
// of paying book-fetch + sign latency while the bids collapse.
const PREARMED_EXIT = process.env.UPDOWN_MAKER_GUESS_PREARMED_EXIT !== "0";
// Deep floor: a FAK sell executes at the bids' own prices, so the floor only
// bounds the worst fill. 0.12 proved too shallow when a book collapsed 16c in
// seconds (the pre-armed order couldn't match and the fallback paid -15c);
// 0.25 keeps the instant exit alive through a full collapse at no extra cost
// in normal exits.
const PREARMED_EXIT_DEPTH = Number(process.env.UPDOWN_MAKER_GUESS_PREARMED_EXIT_DEPTH ?? 0.25);
// Fills can be shaved below the nominal size by rounding/fees; an oversized
// sell is rejected outright, so the pre-signed order is shaved by this much.
const PREARMED_EXIT_SHAVE_SHARES = Number(process.env.UPDOWN_MAKER_GUESS_PREARMED_EXIT_SHAVE_SHARES ?? 0.04);
// Markets that produced a real nuclear exit this session; never re-enter them.
const nuclearCooldownSlugs = new Set<string>();
const REACTIVE_DEPTH_LEVELS = Number(process.env.UPDOWN_MAKER_GUESS_REACTIVE_DEPTH_LEVELS ?? 3);
const USER_WS_READY_MS = Number(process.env.UPDOWN_MAKER_GUESS_USER_WS_READY_MS ?? 2_000);
const MARKET_WS_READY_MS = Number(process.env.UPDOWN_MAKER_GUESS_MARKET_WS_READY_MS ?? 2_000);
const MARKET_WS_CACHE_MAX_AGE_MS = Number(process.env.UPDOWN_MAKER_GUESS_MARKET_WS_CACHE_MAX_AGE_MS ?? 50);
const USE_MARKET_WS_CACHE = process.env.UPDOWN_MAKER_GUESS_USE_MARKET_WS_CACHE !== "0";
const LOOP_LOW_PROB_ONLY = process.env.UPDOWN_MAKER_GUESS_LOOP_LOW_PROB_ONLY !== "0";
const LOOP_ALWAYS_LOW_PROB_ONLY = process.env.UPDOWN_MAKER_GUESS_LOOP_ALWAYS_LOW_PROB_ONLY !== "0";
const LOOP_HIGH_PROB_MAKER_MAX_PRICE = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_HIGH_PROB_MAKER_MAX_PRICE ?? 0.6);
const LOOP_REFRESH_MS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_REFRESH_MS ?? 200);
const LOOP_MAX_MS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_MAX_MS ?? 5 * 60_000);
const LOOP_REPEAT_COUNT = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_REPEAT_COUNT ?? argValue("--loop-repeat") ?? 1);
const LOOP_REPEAT_PAUSE_MS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_REPEAT_PAUSE_MS ?? 1_000);
const LOOP_REPLACE_TICKS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_REPLACE_TICKS ?? 1);
const LOOP_MIN_SECONDS_TO_END = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_MIN_SECONDS_TO_END ?? 20);
const LOOP_MAX_IDLE_MS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_MAX_IDLE_MS ?? 0);
const LOOP_IMMEDIATE_FILL_WATCH_MS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_IMMEDIATE_FILL_WATCH_MS ?? 750);
const LOOP_IMMEDIATE_FILL_BALANCE_POLL_MS = Number(process.env.UPDOWN_MAKER_GUESS_LOOP_IMMEDIATE_FILL_BALANCE_POLL_MS ?? 150);
const USER_WS_AUDIT_LIMIT = Number(process.env.UPDOWN_MAKER_GUESS_USER_WS_AUDIT_LIMIT ?? 50);
const LOOP_LOW_PROB_POST_MODE = (process.env.UPDOWN_MAKER_GUESS_LOOP_LOW_PROB_POST_MODE ?? "batch").toLowerCase();
const POLY_BUILDER_CODE = process.env.POLY_BUILDER_CODE?.trim();
const MIN_MARKETABLE_BUY_USD = Number(process.env.UPDOWN_MAKER_GUESS_MIN_MARKETABLE_BUY_USD ?? 1);
const MAX_TEST_PAIR_NOTIONAL_USD = Number(process.env.UPDOWN_MAKER_GUESS_MAX_TEST_PAIR_NOTIONAL_USD ?? 20);
// When > 0, size entries up toward this pair notional instead of the minimum
// valid size. Still bounded by MAX_TEST_PAIR_NOTIONAL_USD.
const TARGET_PAIR_NOTIONAL_USD = Number(process.env.UPDOWN_MAKER_GUESS_TARGET_PAIR_NOTIONAL_USD ?? 0);
const MIN_SECONDS_TO_END = Number(process.env.UPDOWN_MAKER_GUESS_MIN_SECONDS_TO_END ?? 60);
const MAX_SECONDS_TO_END = Number(process.env.UPDOWN_MAKER_GUESS_MAX_SECONDS_TO_END ?? 4 * 60);
const TAGS = (process.env.UPDOWN_MAKER_GUESS_TAGS ?? "bitcoin,ethereum,solana,xrp,dogecoin,bnb,hyperliquid,crypto")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);
const TARGET_SLUG = argValue("--slug") ?? process.env.UPDOWN_MAKER_GUESS_SLUG ?? "";
const TARGET_CONTAINS = (argValue("--contains") ?? process.env.UPDOWN_MAKER_GUESS_CONTAINS ?? "bitcoin").toLowerCase();
const require = createRequire(import.meta.url);

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] ?? null;
}

function log(...args: unknown[]) {
  console.log(`[updown-maker-guess ${new Date().toISOString()}]`, ...args);
}

function installHttpKeepAlive() {
  if (process.env.UPDOWN_MAKER_GUESS_HTTP_KEEP_ALIVE === "0") return;
  try {
    const undici = require("undici") as any;
    if (typeof undici?.setGlobalDispatcher !== "function" || typeof undici?.Agent !== "function") return;
    undici.setGlobalDispatcher(new undici.Agent({
      connections: Number(process.env.UPDOWN_MAKER_GUESS_HTTP_CONNECTIONS ?? 16),
      keepAliveTimeout: Number(process.env.UPDOWN_MAKER_GUESS_HTTP_KEEP_ALIVE_TIMEOUT_MS ?? 30_000),
      keepAliveMaxTimeout: Number(process.env.UPDOWN_MAKER_GUESS_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS ?? 120_000),
    }));
    log("HTTP keep-alive dispatcher installed");
  } catch (err: any) {
    log(`HTTP keep-alive dispatcher unavailable: ${err?.message ?? String(err)}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendJsonl(path: string, row: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type ClobBundle = Awaited<ReturnType<typeof clobClient>>;
type Clob = ClobBundle["client"];
type FillSignal = { tokenId: string; status: string; receivedAt: string; raw: any };
type PriceLevels = { bids: Map<number, number>; asks: Map<number, number>; minOrderSize: number; updatedAtMs: number };

const tickSizeCache = new Map<string, Promise<TickSize>>();
const fillSignals: FillSignal[] = [];
const fillWaiters = new Map<string, Set<() => void>>();
const marketBookCache = new Map<string, PriceLevels>();
const userWsAudit: any[] = [];
let activeUserWsTokenIds = new Set<string>();

async function tickSize(client: Clob, tokenId: string): Promise<TickSize> {
  let cached = tickSizeCache.get(tokenId);
  if (!cached) {
    cached = client.getTickSize(tokenId) as Promise<TickSize>;
    tickSizeCache.set(tokenId, cached);
  }
  return cached;
}

async function signedBuy(client: Clob, tokenId: string, price: number, shares: number) {
  return client.createOrder(
    { tokenID: tokenId, price, size: Number(shares.toFixed(6)), side: Side.BUY, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize: await tickSize(client, tokenId), negRisk: false },
  );
}

async function signedSell(client: Clob, tokenId: string, price: number, shares: number) {
  return client.createOrder(
    { tokenID: tokenId, price, size: Number(shares.toFixed(6)), side: Side.SELL, ...(POLY_BUILDER_CODE ? { builderCode: POLY_BUILDER_CODE } : {}) },
    { tickSize: await tickSize(client, tokenId), negRisk: false },
  );
}

async function postLimitBuyCached(client: Clob, tokenId: string, price: number, shares: number): Promise<any> {
  return client.postOrder(await signedBuy(client, tokenId, price, shares), OrderType.GTC);
}

async function postFakBuyCached(client: Clob, tokenId: string, price: number, shares: number): Promise<any> {
  return client.postOrder(await signedBuy(client, tokenId, price, shares), OrderType.FAK);
}

async function postFakSellCached(client: Clob, tokenId: string, price: number, shares: number): Promise<any> {
  return client.postOrder(await signedSell(client, tokenId, price, shares), OrderType.FAK);
}

type PostLimitBuyPairResult = {
  responses: any[];
  latency: {
    signOrdersMs: number;
    postOrdersMs: number;
    submitPairMs: number;
    postMode: "batch" | "single" | "fallback_parallel";
    fallbackReason?: string;
  };
};

type PreparedLimitBuy = {
  legs: Array<{ tokenId: string; price: number; shares: number }>;
  signed: Array<{ order: Awaited<ReturnType<typeof signedBuy>>; orderType: OrderType }>;
  signOrdersMs: number;
  startedMs: number;
};

async function prepareLimitBuy(client: Clob, legs: Array<{ tokenId: string; price: number; shares: number }>): Promise<PreparedLimitBuy> {
  const startedMs = Date.now();
  const signStartedMs = Date.now();
  const signed = await Promise.all(legs.map(async (leg) => ({
    order: await signedBuy(client, leg.tokenId, leg.price, leg.shares),
    orderType: OrderType.GTC,
  })));
  return {
    legs,
    signed,
    signOrdersMs: Date.now() - signStartedMs,
    startedMs,
  };
}

async function postPreparedLimitBuy(client: Clob, prepared: PreparedLimitBuy, postMode: "batch" | "single" = "batch"): Promise<PostLimitBuyPairResult> {
  const postStartedMs = Date.now();
  if (postMode === "single" && prepared.signed.length === 1) {
    const response = await client.postOrder(prepared.signed[0].order, prepared.signed[0].orderType);
    return {
      responses: [response],
      latency: {
        signOrdersMs: prepared.signOrdersMs,
        postOrdersMs: Date.now() - postStartedMs,
        submitPairMs: Date.now() - prepared.startedMs,
        postMode: "single",
      },
    };
  }
  try {
    const response = await client.postOrders(prepared.signed);
    return {
      responses: Array.isArray(response) ? response : [response],
      latency: {
        signOrdersMs: prepared.signOrdersMs,
        postOrdersMs: Date.now() - postStartedMs,
        submitPairMs: Date.now() - prepared.startedMs,
        postMode: "batch",
      },
    };
  } catch (err: any) {
    const fallbackReason = err?.message ?? String(err);
    log(`batch GTC post failed; falling back to parallel postOrder: ${fallbackReason}`);
    const fallbackStartedMs = Date.now();
    const responses = await Promise.all(prepared.signed.map((signed) => client.postOrder(signed.order, signed.orderType)));
    return {
      responses,
      latency: {
        signOrdersMs: prepared.signOrdersMs,
        postOrdersMs: Date.now() - fallbackStartedMs,
        submitPairMs: Date.now() - prepared.startedMs,
        postMode: "fallback_parallel",
        fallbackReason,
      },
    };
  }
}

async function postLimitBuyPair(client: Clob, legs: Array<{ tokenId: string; price: number; shares: number }>): Promise<PostLimitBuyPairResult> {
  return postPreparedLimitBuy(client, await prepareLimitBuy(client, legs), "batch");
}

function responseStatus(response: unknown): string {
  return String((response as any)?.status ?? "").toLowerCase();
}

function cancellableOrderEntries(orderIds: { up?: string; down?: string }, responses: { up?: unknown; down?: unknown }) {
  return [
    { side: "up", orderID: orderIds.up, status: responseStatus(responses.up) },
    { side: "down", orderID: orderIds.down, status: responseStatus(responses.down) },
  ].filter((row) => isString(row.orderID) && row.status === "live");
}

function skippedCancelEntries(orderIds: { up?: string; down?: string }, responses: { up?: unknown; down?: unknown }) {
  return [
    { side: "up", orderID: orderIds.up, status: responseStatus(responses.up) || "unknown" },
    { side: "down", orderID: orderIds.down, status: responseStatus(responses.down) || "unknown" },
  ].filter((row) => isString(row.orderID) && row.status !== "live");
}

function signalFill(tokenId: string, raw: any) {
  const status = String(raw?.status ?? "").toUpperCase();
  fillSignals.push({ tokenId, status, receivedAt: new Date().toISOString(), raw });
  const waiters = fillWaiters.get(tokenId);
  if (!waiters) return;
  for (const resolveFn of waiters) resolveFn();
  waiters.clear();
}

function pushUserWsAudit(row: any) {
  userWsAudit.push({ receivedAt: new Date().toISOString(), ...row });
  while (userWsAudit.length > USER_WS_AUDIT_LIMIT) userWsAudit.shift();
}

function waitForAnyFill(tokenIds: string[], timeoutMs: number): Promise<FillSignal | null> {
  const existing = fillSignals.find((signal) => tokenIds.includes(signal.tokenId));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveFn) => {
    const done = () => {
      clearTimeout(timer);
      for (const tokenId of tokenIds) fillWaiters.get(tokenId)?.delete(done);
      const signal = fillSignals.find((row) => tokenIds.includes(row.tokenId)) ?? null;
      resolveFn(signal);
    };
    const timer = setTimeout(done, timeoutMs);
    for (const tokenId of tokenIds) {
      let waiters = fillWaiters.get(tokenId);
      if (!waiters) {
        waiters = new Set();
        fillWaiters.set(tokenId, waiters);
      }
      waiters.add(done);
    }
  });
}

function collectStringsForKeys(value: unknown, keyPattern: RegExp, out = new Set<string>(), depth = 0): Set<string> {
  if (!value || depth > 5) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStringsForKeys(item, keyPattern, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key)) {
      if (typeof child === "string" && child.length > 0) out.add(child);
      else if (typeof child === "number" && Number.isFinite(child)) out.add(String(child));
    }
    collectStringsForKeys(child, keyPattern, out, depth + 1);
  }
  return out;
}

function signalOrderIds(signal: FillSignal): string[] {
  return [...collectStringsForKeys(signal.raw, /(^|_)(order|orderid|order_id|maker_order|taker_order|id)$/i)]
    .filter((id) => id.startsWith("0x") || id.length > 12);
}

function directString(raw: any, keys: string[]): string {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizedWsTokenId(raw: any): string {
  const direct = directString(raw, ["asset_id", "assetId", "token_id", "tokenID", "tokenId"]);
  if (direct) return direct;
  const nested = collectStringsForKeys(raw, /(asset|token).*id/i);
  return [...nested].find((value) => activeUserWsTokenIds.has(value)) ?? "";
}

function numberFromKeys(raw: any, keys: string[]): number {
  for (const key of keys) {
    const value = raw?.[key];
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function signalPrice(signal: FillSignal): number {
  return numberFromKeys(signal.raw, ["price", "match_price", "matched_price", "execution_price", "fill_price"]);
}

function signalShares(signal: FillSignal): number {
  return numberFromKeys(signal.raw, ["size", "matched_size", "matchedSize", "shares", "amount", "takingAmount"]);
}

function fillLikeStatus(status: string): boolean {
  const normalized = status.toUpperCase();
  return !normalized
    || normalized === "MATCHED"
    || normalized === "CONFIRMED"
    || normalized === "FILLED"
    || normalized === "PARTIALLY_FILLED"
    || normalized === "PARTIAL";
}

function fillLikeSignal(signal: FillSignal): boolean {
  if (!fillLikeStatus(signal.status)) return false;
  if (signal.status) return true;
  const eventType = String(signal.raw?.event_type ?? signal.raw?.type ?? "");
  return /trade|fill|match/i.test(eventType);
}

function ownFillMatches(signal: FillSignal, tokenIds: string[], orderIds: string[], postedAtMs?: number): boolean {
  if (!tokenIds.includes(signal.tokenId)) return false;
  if (postedAtMs && Date.parse(signal.receivedAt) + 1_000 < postedAtMs) return false;
  const orderIdSet = new Set(orderIds.filter(Boolean));
  if (signalOrderIds(signal).some((id) => orderIdSet.has(id))) return true;
  return fillLikeSignal(signal) && signalShares(signal) > 0 && signalPrice(signal) > 0;
}

function waitForOwnFill(tokenIds: string[], orderIds: string[], timeoutMs: number, postedAtMs?: number): Promise<FillSignal | null> {
  const matches = (signal: FillSignal) => ownFillMatches(signal, tokenIds, orderIds, postedAtMs);
  const existing = fillSignals.find(matches);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveFn) => {
    const done = () => {
      clearTimeout(timer);
      for (const tokenId of tokenIds) fillWaiters.get(tokenId)?.delete(done);
      resolveFn(fillSignals.find(matches) ?? null);
    };
    const timer = setTimeout(done, timeoutMs);
    for (const tokenId of tokenIds) {
      let waiters = fillWaiters.get(tokenId);
      if (!waiters) {
        waiters = new Set();
        fillWaiters.set(tokenId, waiters);
      }
      waiters.add(done);
    }
  });
}

function findOwnFill(tokenIds: string[], orderIds: string[], postedAtMs?: number): FillSignal | null {
  return fillSignals.find((signal) => ownFillMatches(signal, tokenIds, orderIds, postedAtMs)) ?? null;
}

function handleUserMessage(raw: WebSocket.RawData) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages: any[] = Array.isArray(data) ? data : [data];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;
    const tokenId = normalizedWsTokenId(msg);
    const status = String(msg.status ?? "").toUpperCase();
    const orderIds = [...collectStringsForKeys(msg, /(^|_)(order|orderid|order_id|maker_order|taker_order|id)$/i)]
      .filter((id) => id.startsWith("0x") || id.length > 12);
    const eventLooksRelevant = !eventType
      || /trade|order|fill|match/i.test(String(eventType))
      || tokenId
      || orderIds.length > 0;
    if (!eventLooksRelevant) continue;
    pushUserWsAudit({
      eventType,
      status,
      tokenId,
      orderIds,
      price: numberFromKeys(msg, ["price", "match_price", "matched_price", "execution_price", "fill_price"]),
      size: numberFromKeys(msg, ["size", "matched_size", "matchedSize", "shares", "amount", "takingAmount"]),
      raw: msg,
    });
    if (tokenId && fillLikeSignal({ tokenId, status, receivedAt: new Date().toISOString(), raw: msg })) {
      signalFill(tokenId, msg);
    }
  }
}

async function connectUserWs(clob: ClobBundle, conditionId: string, tokenIds: string[] = []): Promise<WebSocket | null> {
  if (!conditionId) return null;
  activeUserWsTokenIds = new Set(tokenIds);
  const ws = new WebSocket(USER_WS_URL);
  return new Promise((resolveFn) => {
    let settled = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    const settle = (value: WebSocket | null) => {
      if (settled) return;
      settled = true;
      resolveFn(value);
    };
    const timer = setTimeout(() => {
      log(`user WS not ready after ${USER_WS_READY_MS}ms; continuing with balance fallback`);
      settle(ws.readyState === WebSocket.OPEN ? ws : null);
    }, USER_WS_READY_MS);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        auth: { apiKey: clob.creds.key, secret: clob.creds.secret, passphrase: clob.creds.passphrase },
        markets: [conditionId],
        type: "user",
      }));
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
      clearTimeout(timer);
      log(`user WS connected for ${conditionId}`);
      settle(ws);
    });
    ws.on("message", (msg) => handleUserMessage(msg));
    ws.on("error", (err) => log(`user WS error: ${err.message}`));
    ws.on("close", () => {
      if (ping) clearInterval(ping);
    });
  });
}

function handleMarketMessage(raw: WebSocket.RawData, tokenIds: Set<string>) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages: any[] = Array.isArray(data) ? data : [data];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;
    if (eventType === "book" || (msg.asset_id && (msg.bids || msg.asks || msg.buys || msg.sells))) {
      const tokenId = String(msg.asset_id ?? "");
      if (!tokenIds.has(tokenId)) continue;
      applyMarketSnapshot(tokenId, rawLevels(msg.bids ?? msg.buys), rawLevels(msg.asks ?? msg.sells));
      continue;
    }
    const changes: any[] = msg.price_changes ?? msg.changes ?? [];
    for (const change of changes) {
      const tokenId = String(change.asset_id ?? msg.asset_id ?? "");
      if (!tokenIds.has(tokenId)) continue;
      applyMarketLevelChange(tokenId, String(change.side ?? ""), parseNumber(change.price), parseNumber(change.size));
    }
  }
}

async function connectMarketWs(market: TrackedMarket): Promise<WebSocket | null> {
  if (!USE_MARKET_WS_CACHE) return null;
  const tokens = [market.upTokenId, market.downTokenId];
  await Promise.all(tokens.map((tokenId) => seedMarketBook(tokenId)));
  const tokenIds = new Set(tokens);
  const ws = new WebSocket(MARKET_WS_URL);
  return new Promise((resolveFn) => {
    let settled = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    const settle = (value: WebSocket | null) => {
      if (settled) return;
      settled = true;
      resolveFn(value);
    };
    const timer = setTimeout(() => {
      log(`market WS not ready after ${MARKET_WS_READY_MS}ms; continuing with REST fallback`);
      settle(ws.readyState === WebSocket.OPEN ? ws : null);
    }, MARKET_WS_READY_MS);
    ws.on("open", () => {
      ws.send(JSON.stringify({ assets_ids: tokens, type: "market" }));
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
      clearTimeout(timer);
      log(`market WS connected for ${market.slug}`);
      settle(ws);
    });
    ws.on("message", (msg) => handleMarketMessage(msg, tokenIds));
    ws.on("error", (err) => log(`market WS error: ${err.message}`));
    ws.on("close", () => {
      if (ping) clearInterval(ping);
    });
  });
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

function parseNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "updown-5m-maker-guess-test/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function parsedLevels(levels: BookLevel[] | undefined, side: "bid" | "ask", limit = 3): ParsedLevel[] {
  return (levels ?? [])
    .map((level) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price)
    .slice(0, limit);
}

function topLevel(levels: BookLevel[] | undefined, side: "bid" | "ask"): ParsedLevel {
  const parsed = parsedLevels(levels, side, 1);
  if (!parsed.length) return { price: 0, size: 0 };
  return parsed[0];
}

function topFromBook(book: BookResponse): Top {
  const bids = parsedLevels(book.bids, "bid", 3);
  const asks = parsedLevels(book.asks, "ask", 3);
  const bid = topLevel(book.bids, "bid");
  const ask = topLevel(book.asks, "ask");
  return {
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    bids,
    asks,
    minOrderSize: parseNumber(book.min_order_size) || 5,
  };
}

function emptyLevels(minOrderSize = 5): PriceLevels {
  return { bids: new Map(), asks: new Map(), minOrderSize, updatedAtMs: 0 };
}

function getCachedBook(tokenId: string): PriceLevels {
  let book = marketBookCache.get(tokenId);
  if (!book) {
    book = emptyLevels();
    marketBookCache.set(tokenId, book);
  }
  return book;
}

function rawLevels(rows: unknown): ParsedLevel[] {
  return (Array.isArray(rows) ? rows : [])
    .map((level: any) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
}

function applyMarketSnapshot(tokenId: string, bids: ParsedLevel[], asks: ParsedLevel[], minOrderSize?: number) {
  const current = marketBookCache.get(tokenId);
  const book = emptyLevels(minOrderSize ?? current?.minOrderSize ?? 5);
  for (const level of bids) book.bids.set(level.price, level.size);
  for (const level of asks) book.asks.set(level.price, level.size);
  book.updatedAtMs = Date.now();
  marketBookCache.set(tokenId, book);
}

function applyMarketLevelChange(tokenId: string, side: string, price: number, size: number) {
  if (!(price > 0)) return;
  const book = getCachedBook(tokenId);
  const lower = side.toLowerCase();
  const levels = lower === "buy" || lower === "bid" || lower === "bids" ? book.bids : book.asks;
  if (size > 0) levels.set(price, size);
  else levels.delete(price);
  book.updatedAtMs = Date.now();
}

function topFromCachedBook(tokenId: string): Top | null {
  const book = marketBookCache.get(tokenId);
  if (!book || !book.updatedAtMs) return null;
  const bids = [...book.bids.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  const asks = [...book.asks.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  return {
    bid: bids[0]?.price ?? 0,
    bidSize: bids[0]?.size ?? 0,
    ask: asks[0]?.price ?? 0,
    askSize: asks[0]?.size ?? 0,
    bids,
    asks,
    minOrderSize: book.minOrderSize,
  };
}

function cacheAgeMs(tokenId: string): number {
  const book = marketBookCache.get(tokenId);
  return book?.updatedAtMs ? Date.now() - book.updatedAtMs : Number.POSITIVE_INFINITY;
}

const midSampleHistory = new Map<string, Array<{ ts: number; mid: number }>>();

function sampleMid(tokenId: string) {
  const top = topFromCachedBook(tokenId);
  if (!top || !(top.bid > 0) || !(top.ask > 0)) return;
  const rows = midSampleHistory.get(tokenId) ?? [];
  rows.push({ ts: Date.now(), mid: (top.bid + top.ask) / 2 });
  const cutoff = Date.now() - Math.max(MOMENTUM_WINDOW_MS * 4, 2_000);
  while (rows.length && rows[0].ts < cutoff) rows.shift();
  midSampleHistory.set(tokenId, rows);
}

function recentMids(tokenId: string): Array<{ ts: number; mid: number }> {
  const cutoff = Date.now() - MOMENTUM_WINDOW_MS;
  return (midSampleHistory.get(tokenId) ?? []).filter((row) => row.ts >= cutoff);
}

// How far the mid has fallen toward a resting bid within the momentum window.
function midDropCents(tokenId: string): number {
  const rows = recentMids(tokenId);
  if (rows.length < 2) return 0;
  const current = rows[rows.length - 1].mid;
  return Math.max(0, Math.max(...rows.map((row) => row.mid)) - current);
}

// Total mid range within the window; used to hold off new posts in fast markets.
function midRangeCents(tokenId: string): number {
  const rows = recentMids(tokenId);
  if (rows.length < 2) return 0;
  const mids = rows.map((row) => row.mid);
  return Math.max(...mids) - Math.min(...mids);
}

async function seedMarketBook(tokenId: string) {
  const raw = await fetchJson<BookResponse>(`${CLOB_HOST}/book?${new URLSearchParams({ token_id: tokenId })}`);
  applyMarketSnapshot(tokenId, rawLevels(raw.bids), rawLevels(raw.asks), parseNumber(raw.min_order_size) || 5);
}

async function fetchTop(tokenId: string): Promise<Top> {
  if (USE_MARKET_WS_CACHE) {
    const cached = topFromCachedBook(tokenId);
    if (cached && cacheAgeMs(tokenId) <= MARKET_WS_CACHE_MAX_AGE_MS) return cached;
  }
  return topFromBook(await fetchJson<BookResponse>(`${CLOB_HOST}/book?${new URLSearchParams({ token_id: tokenId })}`));
}

async function fetchEntryTop(tokenId: string): Promise<Top> {
  if (USE_MARKET_WS_CACHE) {
    const cached = topFromCachedBook(tokenId);
    const age = cacheAgeMs(tokenId);
    if (cached && age <= MARKET_WS_CACHE_MAX_AGE_MS) return cached;
    throw new Error(`market_ws_cache_stale token=${tokenId.slice(0, 10)} ageMs=${Math.round(age)}`);
  }
  return fetchTop(tokenId);
}

async function fetchComplementTop(tokenId: string): Promise<Top> {
  if (USE_MARKET_WS_CACHE) return fetchEntryTop(tokenId);
  return fetchTop(tokenId);
}

const UPDOWN_INTERVAL = (process.env.UPDOWN_MAKER_GUESS_INTERVAL ?? "5m").toLowerCase();
const UPDOWN_SLUG_RE = new RegExp(`^[a-z0-9-]+-updown-${UPDOWN_INTERVAL}-\\d+$`);

function isUpDown5mSlug(slug: string): boolean {
  return UPDOWN_SLUG_RE.test(slug);
}

function secondsToEnd(endDate: string | null): number | null {
  if (!endDate) return null;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) ? (ms - Date.now()) / 1000 : null;
}

function trackedMarketFromEvent(event: GammaEvent): TrackedMarket | null {
  const slug = event.slug ?? "";
  if (!slug || !isUpDown5mSlug(slug) || event.closed || event.active === false) return null;
  const market = (event.markets ?? []).find((candidate) => {
    if (candidate.closed || candidate.active === false || candidate.acceptingOrders === false) return false;
    const outcomes = parseJsonArray(candidate.outcomes).map(String);
    return outcomes.includes("Up") && outcomes.includes("Down");
  });
  if (!market) return null;
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const upIndex = outcomes.findIndex((outcome) => outcome === "Up");
  const downIndex = outcomes.findIndex((outcome) => outcome === "Down");
  if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) return null;
  const endDate = market.endDate ?? event.endDate ?? null;
  const seconds = secondsToEnd(endDate);
  if (seconds !== null && (seconds < MIN_SECONDS_TO_END || seconds > MAX_SECONDS_TO_END)) return null;
  return {
    slug,
    title: event.title ?? market.question ?? slug,
    marketId: String(market.id ?? ""),
    conditionId: market.conditionId ?? "",
    endDate,
    upTokenId: tokenIds[upIndex],
    downTokenId: tokenIds[downIndex],
  };
}

async function discoverMarkets(): Promise<TrackedMarket[]> {
  const bySlug = new Map<string, TrackedMarket>();
  for (const tag of TAGS) {
    for (let offset = 0; offset < DISCOVERY_LIMIT; offset += 100) {
      const url = `${GAMMA_API}/events?${new URLSearchParams({
        active: "true",
        closed: "false",
        limit: "100",
        offset: String(offset),
        tag_slug: tag,
      })}`;
      const events = await fetchJson<GammaEvent[]>(url).catch((err) => {
        log(`discovery tag=${tag} offset=${offset} failed: ${err?.message ?? String(err)}`);
        return [];
      });
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        const tracked = trackedMarketFromEvent(event);
        if (tracked) bySlug.set(tracked.slug, tracked);
      }
      if (events.length < 100) break;
    }
  }
  return [...bySlug.values()].sort((a, b) => {
    const aEnd = secondsToEnd(a.endDate) ?? Number.POSITIVE_INFINITY;
    const bEnd = secondsToEnd(b.endDate) ?? Number.POSITIVE_INFINITY;
    return aEnd - bEnd;
  });
}

// Assets the loop runner may trade, in slug-prefix form (e.g. "btc,eth").
const LOOP_ASSETS = (process.env.UPDOWN_MAKER_GUESS_LOOP_ASSETS ?? "btc")
  .toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
let loopAssetRotation = 0;

// Assets whose own 10m spot range is currently below the calm gate. Updated by
// calmAssetsNow(); discovery only deploys into calm assets.
const calmAssets = new Set<string>(LOOP_ASSETS);

async function calmAssetsNow(): Promise<Map<string, number | null>> {
  const ranges = new Map<string, number | null>();
  await Promise.all(LOOP_ASSETS.map(async (asset) => {
    ranges.set(asset, await assetRangePct(asset));
  }));
  calmAssets.clear();
  for (const [asset, range] of ranges) {
    if (range != null && range < CALM_RANGE_PCT) calmAssets.add(asset);
  }
  return ranges;
}

async function discoverLoopMarket(): Promise<TrackedMarket | null> {
  const markets = await discoverMarkets();
  // Re-scan each asset's own range at every discovery so the runner deploys
  // into whichever market is calm right now, not whichever was calm at the
  // start of the session.
  if (CALM_RANGE_PCT > 0) await calmAssetsNow();
  const candidates = LOOP_ASSETS
    .filter((asset) => CALM_RANGE_PCT <= 0 || calmAssets.has(asset))
    .map((asset) => markets.find((market) => market.slug.startsWith(`${asset}-updown-${UPDOWN_INTERVAL}-`)))
    .filter((market): market is TrackedMarket => Boolean(market));
  if (!candidates.length) return null;
  const available = candidates.filter((market) => !nuclearCooldownSlugs.has(market.slug));
  if (!available.length) {
    throw new Error(`market_in_nuclear_cooldown ${candidates.map((market) => market.slug).join(",")}`);
  }
  // Rotate the starting asset so a multi-asset config samples all books
  // instead of always camping on the first one.
  loopAssetRotation += 1;
  return available[loopAssetRotation % available.length];
}

function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-7;
}

function clobBuyAmountValid(price: number, shares: number): boolean {
  return hasAtMostDecimals(price * shares, 2) && hasAtMostDecimals(shares, 5);
}

function floorToTick(value: number): number {
  return Math.floor((value + 1e-12) / TICK) * TICK;
}

function normalizePrice(value: number): number {
  return Number(floorToTick(value).toFixed(4));
}

function maxSafePairCost(): number {
  return MAX_PAIR_COST - COMPLEMENT_SAFETY_BUFFER;
}

function maxCompletionPairCost(): number {
  return Math.max(maxSafePairCost(), MAX_COMPLETION_PAIR_COST);
}

function dynamicBid(top: Top, label: string): number {
  if (PRICE_OVERRIDE) {
    const price = Number(PRICE_OVERRIDE);
    if (!(price > 0 && price < 1)) throw new Error(`invalid --price ${PRICE_OVERRIDE}`);
    return normalizePrice(price);
  }
  if (!(top.bid > 0) || !(top.ask > 0)) {
    throw new Error(`${label} missing live bid/ask bid=${top.bid} ask=${top.ask}`);
  }
  const improvedBid = top.bid + IMPROVE_BY;
  const makerCap = top.ask - TICK;
  const bid = normalizePrice(Math.max(TICK, Math.min(improvedBid, makerCap) - ENTRY_DEPTH));
  if (!(bid > 0) || bid + 1e-12 >= top.ask) {
    throw new Error(`${label} no safe maker bid bid=${top.bid} ask=${top.ask} computed=${bid}`);
  }
  return bid;
}

function complementCrossBlock(upPrice: number, downPrice: number, upTop: Top, downTop: Top): string | null {
  const maxCrossable = 1 - COMPLEMENT_CROSS_BUFFER;
  if (upTop.bid > 0 && downPrice + upTop.bid > maxCrossable + 1e-12) {
    return `down_bid_crossable down=${downPrice.toFixed(4)} + upBestBid=${upTop.bid.toFixed(4)} > ${(maxCrossable).toFixed(4)}`;
  }
  if (downTop.bid > 0 && upPrice + downTop.bid > maxCrossable + 1e-12) {
    return `up_bid_crossable up=${upPrice.toFixed(4)} + downBestBid=${downTop.bid.toFixed(4)} > ${(maxCrossable).toFixed(4)}`;
  }
  return null;
}

function minValidShares(price: number, minOrderSize: number): number {
  const minNotionalShares = price > 0
    ? Math.ceil((MIN_MARKETABLE_BUY_USD / price) * 100) / 100
    : Number.POSITIVE_INFINITY;
  const start = Math.ceil(Math.max(minOrderSize, minNotionalShares) * 100) / 100;
  for (let units = Math.round(start * 100); units <= 100_000; units += 1) {
    const shares = units / 100;
    if (clobBuyAmountValid(price, shares)) return shares;
  }
  throw new Error(`no cent-valid size found for price=${price}`);
}

function planShares(
  upPrice: number,
  downPrice: number,
  pairCost: number,
  minShares: number,
): number {
  if (!(TARGET_PAIR_NOTIONAL_USD > 0)) return minShares;
  const budget = Math.min(TARGET_PAIR_NOTIONAL_USD, MAX_TEST_PAIR_NOTIONAL_USD);
  let shares = Math.floor((budget / pairCost) * 100) / 100;
  // Walk down to the largest cent-valid size for both legs.
  while (shares > minShares) {
    if (clobBuyAmountValid(upPrice, shares) && clobBuyAmountValid(downPrice, shares)) return shares;
    shares = Math.round((shares - 0.01) * 100) / 100;
  }
  return minShares;
}

type QuotePlan = {
  upTop: Top;
  downTop: Top;
  upPrice: number;
  downPrice: number;
  pairCost: number;
  shares: number;
  notional: { up: number; down: number; total: number };
  theoreticalPairEdge: number;
};
type LoopSide = "up" | "down";
type LoopEntryLeg = { side: LoopSide; tokenId: string; price: number; shares: number };
type LoopEntryPlan = {
  mode: "pair" | "low_prob_only";
  legs: LoopEntryLeg[];
  skippedHighProbSide?: LoopSide;
  highProbPrice?: number;
  lowProbSide?: LoopSide;
  lowProbPrice?: number;
  threshold: number;
  alwaysLowProbOnly: boolean;
};

function loopEntryPlan(market: TrackedMarket, quote: QuotePlan): LoopEntryPlan {
  const upLeg: LoopEntryLeg = { side: "up", tokenId: market.upTokenId, price: quote.upPrice, shares: quote.shares };
  const downLeg: LoopEntryLeg = { side: "down", tokenId: market.downTokenId, price: quote.downPrice, shares: quote.shares };
  const upIsHigh = quote.upPrice >= quote.downPrice;
  const highSide: LoopSide = upIsHigh ? "up" : "down";
  const lowSide: LoopSide = upIsHigh ? "down" : "up";
  const highPrice = upIsHigh ? quote.upPrice : quote.downPrice;
  const lowPrice = upIsHigh ? quote.downPrice : quote.upPrice;
  if (LOOP_LOW_PROB_ONLY && (LOOP_ALWAYS_LOW_PROB_ONLY || highPrice >= LOOP_HIGH_PROB_MAKER_MAX_PRICE)) {
    return {
      mode: "low_prob_only",
      legs: [lowSide === "up" ? upLeg : downLeg],
      skippedHighProbSide: highSide,
      highProbPrice: highPrice,
      lowProbSide: lowSide,
      lowProbPrice: lowPrice,
      threshold: LOOP_HIGH_PROB_MAKER_MAX_PRICE,
      alwaysLowProbOnly: LOOP_ALWAYS_LOW_PROB_ONLY,
    };
  }
  return {
    mode: "pair",
    legs: [upLeg, downLeg],
    threshold: LOOP_HIGH_PROB_MAKER_MAX_PRICE,
    alwaysLowProbOnly: LOOP_ALWAYS_LOW_PROB_ONLY,
  };
}

async function quotePlanForMarket(market: TrackedMarket): Promise<QuotePlan> {
  const [upTop, downTop] = await Promise.all([
    fetchEntryTop(market.upTokenId),
    fetchEntryTop(market.downTokenId),
  ]);
  const upPrice = dynamicBid(upTop, "up_loop");
  const downPrice = dynamicBid(downTop, "down_loop");
  const pairCost = upPrice + downPrice;
  const maxPairCost = maxSafePairCost();
  if (pairCost >= maxPairCost) {
    throw new Error(`loop_edge_gone sum=${pairCost.toFixed(4)} >= ${maxPairCost.toFixed(4)} buffer=${COMPLEMENT_SAFETY_BUFFER.toFixed(4)}`);
  }
  const crossBlock = complementCrossBlock(upPrice, downPrice, upTop, downTop);
  if (crossBlock) throw new Error(`loop_cross_block ${crossBlock}`);
  const minShares = Math.max(
    minValidShares(upPrice, upTop.minOrderSize),
    minValidShares(downPrice, downTop.minOrderSize),
  );
  const shares = planShares(upPrice, downPrice, pairCost, minShares);
  const total = shares * pairCost;
  if (total > MAX_TEST_PAIR_NOTIONAL_USD + 1e-12) {
    throw new Error(`loop_minPairNotional=$${total.toFixed(2)} > maxTest=$${MAX_TEST_PAIR_NOTIONAL_USD.toFixed(2)}`);
  }
  return {
    upTop,
    downTop,
    upPrice,
    downPrice,
    pairCost,
    shares,
    notional: {
      up: Number((upPrice * shares).toFixed(4)),
      down: Number((downPrice * shares).toFixed(4)),
      total: Number(total.toFixed(4)),
    },
    theoreticalPairEdge: Number(((1 - pairCost) * shares).toFixed(4)),
  };
}

function quoteChanged(a: QuotePlan, b: QuotePlan): boolean {
  const threshold = TICK * LOOP_REPLACE_TICKS;
  return Math.abs(a.upPrice - b.upPrice) >= threshold - 1e-12
    || Math.abs(a.downPrice - b.downPrice) >= threshold - 1e-12
    || Math.abs(a.shares - b.shares) >= 0.01;
}

function averageBuyPrice(response: unknown, fallbackPrice: number): number {
  const row = response as any;
  const cost = Number(row?.makingAmount);
  const shares = Number(row?.takingAmount);
  if (Number.isFinite(cost) && cost > 0 && Number.isFinite(shares) && shares > 0) {
    return cost / shares;
  }
  const price = Number(row?.price);
  if (Number.isFinite(price) && price > 0) return price;
  return fallbackPrice;
}

function responseBuyShares(response: unknown): number {
  const shares = Number((response as any)?.takingAmount);
  return Number.isFinite(shares) && shares > 0 ? shares : 0;
}

function matchedResponseFill(
  market: TrackedMarket,
  orderIds: { up?: string; down?: string },
  responses: { up?: unknown; down?: unknown },
): FillSignal | null {
  const candidates: Array<{ side: "up" | "down"; tokenId: string; orderID?: string; response?: unknown }> = [
    { side: "up", tokenId: market.upTokenId, orderID: orderIds.up, response: responses.up },
    { side: "down", tokenId: market.downTokenId, orderID: orderIds.down, response: responses.down },
  ];
  for (const candidate of candidates) {
    const shares = responseBuyShares(candidate.response);
    if (responseStatus(candidate.response) !== "matched" || shares <= 0) continue;
    const price = averageBuyPrice(candidate.response, 0);
    return {
      tokenId: candidate.tokenId,
      status: "MATCHED_RESPONSE",
      receivedAt: new Date().toISOString(),
      raw: {
        ...(candidate.response as any),
        asset_id: candidate.tokenId,
        order_id: candidate.orderID,
        status: "MATCHED",
        size: String(shares),
        price: String(price || 0),
      },
    };
  }
  return null;
}

function responseFilled(responses: { up?: unknown; down?: unknown }) {
  return {
    up: responseStatus(responses.up) === "matched" ? responseBuyShares(responses.up) : 0,
    down: responseStatus(responses.down) === "matched" ? responseBuyShares(responses.down) : 0,
  };
}

function applyCompletionFill(
  market: TrackedMarket,
  completion: any,
  filled: { up: number; down: number },
) {
  const bought = Number(completion?.bought);
  if (!(Number.isFinite(bought) && bought > 0)) return filled;
  if (completion?.complementSide === "up") {
    return { ...filled, up: Math.max(filled.up, bought) };
  }
  if (completion?.complementSide === "down") {
    return { ...filled, down: Math.max(filled.down, bought) };
  }
  return filled;
}

function fillSignalDetails(signal: FillSignal | null, market: TrackedMarket, orderIds?: { up?: string; down?: string }): null | {
  sideFilled: "up" | "down";
  complementSide: "up" | "down";
  complementToken: string;
  fillPrice: number;
  shares: number;
} {
  if (!signal) return null;
  const tokenId = String(signal.tokenId);
  const ids = signalOrderIds(signal);
  const sideFilled = orderIds?.up && ids.includes(orderIds.up)
    ? "up"
    : orderIds?.down && ids.includes(orderIds.down)
      ? "down"
      : tokenId === market.upTokenId
        ? "up"
        : tokenId === market.downTokenId
          ? "down"
          : null;
  if (!sideFilled) return null;
  const fillPrice = signalPrice(signal);
  const shares = signalShares(signal);
  if (!(fillPrice > 0) || !(shares > 0)) return null;
  const complementSide = sideFilled === "up" ? "down" : "up";
  return {
    sideFilled,
    complementSide,
    complementToken: complementSide === "up" ? market.upTokenId : market.downTokenId,
    fillPrice,
    shares,
  };
}

function averageSellPrice(response: unknown, fallbackPrice: number): number {
  const row = response as any;
  const shares = Number(row?.makingAmount);
  const proceeds = Number(row?.takingAmount);
  if (Number.isFinite(proceeds) && proceeds > 0 && Number.isFinite(shares) && shares > 0) {
    return proceeds / shares;
  }
  return fallbackPrice;
}

function aggressiveSafeComplementPrice(top: Top, maxComplementPrice: number): { price: number; reason: string; levels: ParsedLevel[] } {
  const safeMax = normalizePrice(maxComplementPrice);
  const levels = top.asks.slice(0, Math.max(1, REACTIVE_DEPTH_LEVELS));
  const safeLevels = levels.filter((level) => level.price <= safeMax + 1e-12);
  if (safeLevels.length) {
    return {
      price: safeLevels[safeLevels.length - 1].price,
      reason: `top_${safeLevels.length}_safe_level`,
      levels,
    };
  }
  if (top.ask > 0 && top.ask <= safeMax + 1e-12) {
    return { price: top.ask, reason: "best_ask_safe", levels };
  }
  return { price: 0, reason: "no_safe_ask_level", levels };
}

async function cancelOrderTimed(client: Awaited<ReturnType<typeof clobClient>>["client"], orderID: string) {
  const startedMs = Date.now();
  let ok = false;
  let error = "";
  let notCanceled: any = null;
  try {
    const resp: any = await client.cancelOrder({ orderID });
    ok = true;
    if (resp?.not_canceled && Object.keys(resp.not_canceled).length > 0) {
      notCanceled = resp.not_canceled;
    }
  } catch (err: any) {
    error = err?.message ?? String(err);
  }
  return { orderID, ok, error, notCanceled, elapsedMs: Date.now() - startedMs };
}

async function currentFilled(address: string, market: TrackedMarket, before: { up: number; down: number }) {
  const [up, down] = await Promise.all([
    reconcileTokenBalance(address, market.upTokenId),
    reconcileTokenBalance(address, market.downTokenId),
  ]);
  return {
    balances: { up, down },
    filled: {
      up: roundShares(up - before.up),
      down: roundShares(down - before.down),
    },
  };
}

async function waitForSettledFilled(
  address: string,
  market: TrackedMarket,
  before: { up: number; down: number },
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await currentFilled(address, market, before);
  let lastKey = JSON.stringify(latest.filled);
  let stableCount = 0;
  while (Date.now() < deadline) {
    await sleep(300);
    latest = await currentFilled(address, market, before);
    const key = JSON.stringify(latest.filled);
    if (key === lastKey) {
      stableCount += 1;
      const anyFill = latest.filled.up > 0 || latest.filled.down > 0;
      if (anyFill && stableCount >= 2) return latest;
    } else {
      stableCount = 0;
      lastKey = key;
    }
  }
  return latest;
}

async function tryCompleteImbalance(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  address: string,
  market: TrackedMarket,
  sideFilled: "up" | "down",
  fillPrice: number,
  shares: number,
  ledger: InventoryLedger | null = null,
) {
  const complementSide = sideFilled === "up" ? "down" : "up";
  const complementToken = complementSide === "up" ? market.upTokenId : market.downTokenId;
  const maxComplementPrice = maxCompletionPairCost() - fillPrice;
  const attempts: any[] = [];
  const deadline = Date.now() + COMPLETION_WINDOW_MS;
  let totalBought = 0;
  let totalCost = 0;

  while (Date.now() < deadline && totalBought + IMBALANCE_DUST_SHARES < shares) {
    let top: Top;
    try {
      top = await fetchComplementTop(complementToken);
    } catch (err: any) {
      attempts.push({
        at: new Date().toISOString(),
        complementSide,
        maxComplementPrice,
        remaining: roundShares(shares - totalBought),
        action: "skip",
        reason: err?.message ?? String(err),
      });
      await sleep(FILL_POLL_MS);
      continue;
    }
    const remaining = roundShares(shares - totalBought);
    const pick = aggressiveSafeComplementPrice(top, maxComplementPrice);
    const attempt: any = {
      at: new Date().toISOString(),
      complementSide,
      ask: top.ask,
      askSize: top.askSize,
      topAskLevels: pick.levels,
      pickedComplementPrice: pick.price,
      pickReason: pick.reason,
      maxComplementPrice,
      remaining,
      action: "skip",
    };
    if (pick.price > 0 && top.askSize >= Math.min(remaining, 1)) {
      const startedMs = Date.now();
      let response: unknown;
      try {
        response = await postFakBuyCached(client, complementToken, pick.price, remaining);
        assertOrderResponse(response, "maker_guess_completion");
        attempt.action = "fak_buy";
        ledger?.trackTakerResult({
          orderId: orderId(response),
          tokenId: complementToken,
          side: complementSide,
          role: "completion",
          requestedShares: remaining,
          boughtShares: responseBuyShares(response),
        });
      } catch (err: any) {
        response = { error: err?.message ?? String(err) };
        attempt.action = "error";
        ledger?.trackFailedPost({
          tokenId: complementToken,
          side: complementSide,
          role: "completion",
          requestedShares: remaining,
          error: String((response as any).error),
        });
      }
      // FAK responses settle immediately and are authoritative; the balance
      // feed lags and double-counted fills across retries.
      const bought = responseBuyShares(response);
      const buyPrice = averageBuyPrice(response, pick.price);
      totalBought = roundShares(totalBought + bought);
      totalCost += bought * buyPrice;
      Object.assign(attempt, {
        response,
        elapsedMs: Date.now() - startedMs,
        bought,
        buyPrice,
        totalBought,
      });
      attempts.push(attempt);
      if (bought <= 0) await sleep(FILL_POLL_MS);
      continue;
    }
    attempts.push(attempt);
    await sleep(FILL_POLL_MS);
  }

  return {
    complementSide,
    maxComplementPrice,
    windowMs: COMPLETION_WINDOW_MS,
    bought: totalBought,
    averagePrice: totalBought > 0 ? totalCost / totalBought : 0,
    attempts,
  };
}

type ComplementLadder = {
  tokenId: string;
  shares: number;
  ready: Array<{ price: number; order: any }>;
};

// Pre-sign complement FAK buys across a tick grid the moment the entry posts,
// so a fill can be completed within one HTTP round trip instead of paying the
// book-fetch + sign latency (~750ms) while profitable asks disappear.
function buildComplementLadder(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  market: TrackedMarket,
  entryPlan: LoopEntryPlan,
  shares: number,
): ComplementLadder | null {
  if (entryPlan.mode !== "low_prob_only" || entryPlan.legs.length !== 1) return null;
  const leg = entryPlan.legs[0];
  const complementToken = leg.tokenId === market.upTokenId ? market.downTokenId : market.upTokenId;
  const base = normalizePrice(maxSafePairCost() - leg.price);
  const ladder: ComplementLadder = { tokenId: complementToken, shares, ready: [] };
  for (let i = 0; i <= COMPLETION_LADDER_TICKS; i += 1) {
    const price = normalizePrice(base + i * TICK);
    if (!(price >= TICK) || price > 1 - TICK + 1e-9) continue;
    void signedBuy(client, complementToken, price, shares)
      .then((order) => { ladder.ready.push({ price, order }); })
      .catch(() => {});
  }
  return ladder;
}

type ExitLadder = {
  tokenId: string;
  shares: number;
  ready: Array<{ price: number; order: any }>;
};

// Mirror of buildComplementLadder for the abort path: pre-sign one aggressive
// FAK sell on the posted side at entry time. A limit sell at a deep floor
// sweeps every bid above it, so a single pre-signed order replaces a whole
// price ladder and the naked-leg exit fires without book-fetch or signing
// latency.
function buildExitLadder(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  market: TrackedMarket,
  entryPlan: LoopEntryPlan,
  shares: number,
): ExitLadder | null {
  if (!PREARMED_EXIT) return null;
  if (entryPlan.mode !== "low_prob_only" || entryPlan.legs.length !== 1) return null;
  const leg = entryPlan.legs[0];
  const sellShares = Math.floor((shares - PREARMED_EXIT_SHAVE_SHARES) * 100) / 100;
  if (!(sellShares > 0)) return null;
  const floorPrice = normalizePrice(Math.max(TICK, leg.price - PREARMED_EXIT_DEPTH));
  const ladder: ExitLadder = { tokenId: leg.tokenId, shares: sellShares, ready: [] };
  void signedSell(client, leg.tokenId, floorPrice, sellShares)
    .then((order) => { ladder.ready.push({ price: floorPrice, order }); })
    .catch(() => {});
  return ladder;
}

// Authoritative fill check straight from the CLOB; the data-api balance can
// lag trades by many seconds and must not be used for fast-path decisions.
async function orderMatchedShares(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  orderID: string,
): Promise<number> {
  if (!orderID) return 0;
  try {
    const order: any = await client.getOrder(orderID);
    const matched = Number(order?.size_matched ?? order?.sizeMatched);
    return Number.isFinite(matched) && matched > 0 ? matched : 0;
  } catch {
    return 0;
  }
}

// Last-resort fill source: executed trades. Unlike getOrder (archived once
// fully matched) and cancelOrder (can return ok while a match lands
// concurrently), the trades ledger records every execution. Sums shares per
// order id, whether we were maker or taker.
async function tradesFillSweepByIds(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  market: TrackedMarket,
  ids: Iterable<string>,
  sinceMs: number,
): Promise<Map<string, number>> {
  const filled = new Map<string, number>();
  for (const id of ids) filled.set(id, 0);
  if (!filled.size) return filled;
  const addFill = (id: unknown, shares: number) => {
    if (typeof id !== "string" || !filled.has(id)) return;
    if (Number.isFinite(shares) && shares > 0) filled.set(id, filled.get(id)! + shares);
  };
  try {
    const after = String(Math.max(0, Math.floor(sinceMs / 1000) - 10));
    const trades: any[] = await client.getTrades({ market: market.conditionId, after }, true);
    for (const trade of trades ?? []) {
      addFill(trade?.taker_order_id, Number(trade?.size));
      for (const makerOrder of trade?.maker_orders ?? []) {
        addFill(makerOrder?.order_id, Number(makerOrder?.matched_amount));
      }
    }
  } catch (err: any) {
    log(`loop trades sweep error: ${err?.message ?? String(err)}`);
  }
  for (const [id, shares] of filled) filled.set(id, roundShares(shares));
  return filled;
}

async function tradesFillSweep(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  market: TrackedMarket,
  orderIds: { up?: string; down?: string },
  sinceMs: number,
): Promise<{ up: number; down: number }> {
  const ids = [orderIds.up, orderIds.down].filter(isString);
  const byId = await tradesFillSweepByIds(client, market, ids, sinceMs);
  return {
    up: orderIds.up ? byId.get(orderIds.up) ?? 0 : 0,
    down: orderIds.down ? byId.get(orderIds.down) ?? 0 : 0,
  };
}

async function tryReactiveCompletion(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  address: string,
  market: TrackedMarket,
  signal: FillSignal | null,
  orderIds: { up?: string; down?: string },
  postedPrices: { up: number; down: number } | null = null,
  ladder: ComplementLadder | null = null,
  ledger: InventoryLedger | null = null,
) {
  const details = fillSignalDetails(signal, market, orderIds);
  const startedMs = Date.now();
  if (!details) {
    return { action: "skip", reason: "no_fill_signal_details", elapsedMs: 0 };
  }
  const maxComplementPrice = maxCompletionPairCost() - details.fillPrice;
  const postedPrice = postedPrices ? (details.sideFilled === "up" ? postedPrices.up : postedPrices.down) : 0;
  const gapThrough = postedPrice > 0 ? Math.max(0, postedPrice - details.fillPrice) : 0;
  // A fill far through our posted price means a directional collapse: skip the
  // patient maker stage and exit fast instead of bleeding on the naked leg.
  const fastExit = GAP_FAST_EXIT > 0 && gapThrough >= GAP_FAST_EXIT - 1e-9;
  const base: any = {
    action: "skip",
    startedAt: new Date(startedMs).toISOString(),
    sideFilled: details.sideFilled,
    complementSide: details.complementSide,
    fillPrice: details.fillPrice,
    shares: details.shares,
    maxComplementPrice,
    postedPrice,
    gapThrough: Number(gapThrough.toFixed(4)),
    fastExit,
  };
  let boughtShares = 0;
  let boughtCost = 0;
  const addBuy = (shares: number, price: number) => {
    if (shares > 0 && price > 0) {
      boughtShares += shares;
      boughtCost += shares * price;
    }
  };
  const done = (extra: any) => {
    const bought = roundShares(boughtShares);
    return {
      ...base,
      ...extra,
      ...(bought > 0 ? { action: "fak_buy", bought, buyPrice: boughtCost / boughtShares } : {}),
      elapsedMs: Date.now() - startedMs,
    };
  };
  let remainingShares = details.shares;

  // Stage 1: instantly fire a pre-signed FAK at the best profitable price.
  // No book fetch and no signing on this path; if a profitable ask is still
  // displayed (round #5 had UP at 0.69 for a 0.97 pair), this captures it.
  if (ladder && ladder.tokenId === details.complementToken
    && details.shares + IMBALANCE_DUST_SHARES >= ladder.shares && ladder.ready.length) {
    const profitCap = maxSafePairCost() - details.fillPrice;
    const rung = ladder.ready
      .filter((row) => row.price <= profitCap + 1e-9)
      .sort((a, b) => b.price - a.price)[0];
    if (rung) {
      const presigned: any = { firedPrice: rung.price, profitCap: normalizePrice(profitCap), atMs: Date.now() - startedMs };
      base.presigned = presigned;
      try {
        const response = await client.postOrder(rung.order, OrderType.FAK);
        assertOrderResponse(response, "maker_guess_presigned_completion");
        const bought = Math.min(responseBuyShares(response), remainingShares);
        ledger?.trackTakerResult({
          orderId: orderId(response),
          tokenId: details.complementToken,
          side: details.complementSide,
          role: "completion",
          requestedShares: ladder.shares,
          boughtShares: bought,
        });
        presigned.bought = bought;
        presigned.buyPrice = averageBuyPrice(response, rung.price);
        addBuy(bought, presigned.buyPrice);
        remainingShares = roundShares(Math.max(0, remainingShares - bought));
      } catch (err: any) {
        presigned.error = err?.message ?? String(err);
        ledger?.trackFailedPost({
          tokenId: details.complementToken,
          side: details.complementSide,
          role: "completion",
          requestedShares: ladder.shares,
          error: presigned.error,
        });
      }
      presigned.elapsedMs = Date.now() - startedMs;
      if (remainingShares < IMBALANCE_DUST_SHARES) {
        return done({ completionMode: "presigned_taker" });
      }
    }
  }

  let top: Top;
  try {
    top = await fetchComplementTop(details.complementToken);
  } catch (err: any) {
    return done({ reason: err?.message ?? String(err) });
  }
  base.complementAsk = top.ask;
  base.complementAskSize = top.askSize;

  // Stage 2 (skipped on fast exit): an immediate FAK pays the displayed spread
  // and at best breaks even (observed pairs land at 1.00-1.01). If the
  // displayed ask is not profitable, rest a maker bid at the profitable price
  // briefly and only fall back to the capped taker buy if it does not fill.
  let makerBought = 0;
  const profitablePairCap = maxSafePairCost() - details.fillPrice;
  const profitComplementPrice = normalizePrice(Math.min(profitablePairCap, top.ask - TICK));
  if (!fastExit && COMPLETION_MAKER_WAIT_MS > 0 && profitComplementPrice >= TICK && top.ask - 1e-9 > profitablePairCap) {
    const makerPrice = profitComplementPrice;
    const makerStartedMs = Date.now();
    const makerStage: any = { price: makerPrice, waitMs: COMPLETION_MAKER_WAIT_MS };
    base.makerStage = makerStage;
    try {
      const response = await postLimitBuyCached(client, details.complementToken, makerPrice, remainingShares);
      assertOrderResponse(response, "maker_guess_completion_maker_bid");
      makerStage.response = response;
      const orderID = String((response as any)?.orderID ?? "");
      ledger?.trackPost({
        orderId: orderID,
        tokenId: details.complementToken,
        side: details.complementSide,
        role: "completion",
        requestedShares: remainingShares,
        status: responseStatus(response),
      });
      makerBought = responseBuyShares(response);
      while (makerBought + 1e-9 < remainingShares && Date.now() - makerStartedMs < COMPLETION_MAKER_WAIT_MS) {
        await sleep(250);
        makerBought = Math.max(makerBought, await orderMatchedShares(client, orderID));
      }
      if (orderID && makerBought + 1e-9 < remainingShares) {
        makerStage.cancel = await cancelOrderTimed(client, orderID);
        ledger?.recordCancelResult(orderID, makerStage.cancel);
        // Fills that landed during the cancel race still stand; re-read the
        // order itself, never the lagging balance API.
        makerBought = Math.max(makerBought, await orderMatchedShares(client, orderID));
        // A fully matched order is archived and getOrder reads back nothing,
        // so the cancel rejection is the only reliable full-fill signal left.
        // Without this floor the ETH session read a matching completion bid
        // as zero and nuked the paired leg as naked.
        if (cancelIndicatesMatched(makerStage.cancel)) {
          makerBought = remainingShares;
          makerStage.cancelMatchedFloor = true;
        }
      }
      ledger?.recordMatched(orderID, Math.min(makerBought, remainingShares), "completion_maker_stage");
    } catch (err: any) {
      makerStage.error = err?.message ?? String(err);
      ledger?.trackFailedPost({
        tokenId: details.complementToken,
        side: details.complementSide,
        role: "completion",
        requestedShares: remainingShares,
        error: makerStage.error,
      });
    }
    makerBought = Math.min(makerBought, remainingShares);
    makerStage.bought = makerBought;
    makerStage.elapsedMs = Date.now() - makerStartedMs;
    addBuy(makerBought, makerPrice);
    remainingShares = roundShares(Math.max(0, remainingShares - makerBought));
    if (remainingShares < IMBALANCE_DUST_SHARES) {
      return done({ completionMode: "maker" });
    }
    try {
      top = await fetchComplementTop(details.complementToken);
      base.complementAsk = top.ask;
      base.complementAskSize = top.askSize;
    } catch {
      // keep the pre-wait book if the refresh fails
    }
  }

  // Stage 3: capped taker fallback (bounded loss up to maxCompletionPairCost).
  const pick = aggressiveSafeComplementPrice(top, maxComplementPrice);
  base.topAskLevels = pick.levels;
  base.pickedComplementPrice = pick.price;
  base.pickReason = pick.reason;
  if (!(pick.price > 0) || top.askSize < Math.min(remainingShares, 1)) {
    return done({ reason: "unsafe_or_missing_complement", completionMode: boughtShares > 0 ? "partial" : undefined });
  }
  try {
    const response = await postFakBuyCached(client, details.complementToken, pick.price, remainingShares);
    assertOrderResponse(response, "maker_guess_reactive_completion");
    ledger?.trackTakerResult({
      orderId: orderId(response),
      tokenId: details.complementToken,
      side: details.complementSide,
      role: "completion",
      requestedShares: remainingShares,
      boughtShares: responseBuyShares(response),
    });
    addBuy(responseBuyShares(response), averageBuyPrice(response, pick.price));
    return done({
      response,
      completionMode: boughtShares > responseBuyShares(response) ? "mixed" : "taker",
    });
  } catch (err: any) {
    ledger?.trackFailedPost({
      tokenId: details.complementToken,
      side: details.complementSide,
      role: "completion",
      requestedShares: remainingShares,
      error: err?.message ?? String(err),
    });
    return done({
      action: boughtShares > 0 ? undefined : "error",
      response: { error: err?.message ?? String(err) },
      completionMode: boughtShares > 0 ? "partial" : undefined,
    });
  }
}

async function flatten(client: Awaited<ReturnType<typeof clobClient>>["client"], address: string, tokenId: string, fillPrice: number, shares: number) {
  const top = await fetchTop(tokenId);
  if (!(top.bid > 0)) {
    return { status: "stranded", bid: top.bid, soldShares: 0, realizedEstimate: 0, response: { error: "no bid" } };
  }
  const before = await reconcileTokenBalance(address, tokenId);
  let response: unknown;
  try {
    response = await postFakSellCached(client, tokenId, top.bid, shares);
    assertOrderResponse(response, "updown_maker_guess_flatten");
  } catch (err: any) {
    response = { error: err?.message ?? String(err) };
  }
  await sleep(2_500);
  const after = await reconcileTokenBalance(address, tokenId);
  const soldShares = Math.min(shares, roundShares(before - after));
  const sellPrice = averageSellPrice(response, top.bid);
  return {
    status: soldShares > 0 ? "sold" : "stranded",
    bid: top.bid,
    sellPrice,
    soldShares,
    realizedEstimate: soldShares * (sellPrice - fillPrice),
    response,
  };
}

async function nuclearStopExit(
  client: Awaited<ReturnType<typeof clobClient>>["client"],
  address: string,
  tokenId: string,
  fillPrice: number,
  shares: number,
  prearmed: ExitLadder | null = null,
) {
  const stopBid = normalizePrice(fillPrice - NUCLEAR_STOP_CENTS);
  const attempts: any[] = [];
  let totalSold = 0;
  let totalProceeds = 0;
  let prearmedFilled = false;

  // Fire the pre-signed deep FAK sell before anything else: no book fetch, no
  // signing, no balance reconcile in the hot path while bids are collapsing.
  // Only valid when the whole posted size is naked; a partially-paired leg
  // must not sell shares that belong to a matched pair.
  if (prearmed && prearmed.tokenId === tokenId && prearmed.ready.length > 0
      && prearmed.shares <= shares + IMBALANCE_DUST_SHARES) {
    const entry = prearmed.ready[0];
    const startedMs = Date.now();
    const attempt: any = {
      at: new Date().toISOString(),
      action: "prearmed_fak_sell",
      price: entry.price,
      requested: prearmed.shares,
      stopBid,
    };
    let response: unknown;
    try {
      response = await client.postOrder(entry.order, OrderType.FAK);
      assertOrderResponse(response, "updown_maker_guess_prearmed_exit");
    } catch (err: any) {
      response = { error: err?.message ?? String(err) };
      attempt.action = "prearmed_error";
    }
    const responseSold = Number((response as any)?.makingAmount);
    const sold = Number.isFinite(responseSold) && responseSold > 0 ? Math.min(prearmed.shares, responseSold) : 0;
    const sellPrice = averageSellPrice(response, entry.price);
    totalSold = roundShares(totalSold + sold);
    totalProceeds += sold * sellPrice;
    prearmedFilled = totalSold + IMBALANCE_DUST_SHARES >= prearmed.shares;
    Object.assign(attempt, { response, elapsedMs: Date.now() - startedMs, sold, sellPrice, totalSold });
    attempts.push(attempt);
  }

  const before = await reconcileTokenBalance(address, tokenId);
  const preSold = totalSold;
  // Fills can be shaved by rounding/fees, so the wallet may hold slightly less
  // than the nominal imbalance; an oversized FAK sell is rejected outright and
  // would strand the whole leg.
  let target = shares;
  if (before > IMBALANCE_DUST_SHARES && preSold + before < target) {
    target = roundShares(preSold + Math.floor(before * 100) / 100);
  }
  // The pre-armed order is intentionally signed slightly under size; once it
  // fills, the leftover sliver is below the exchange minimum and not worth
  // burning retries on.
  const doneTolerance = prearmedFilled
    ? Math.max(IMBALANCE_DUST_SHARES, PREARMED_EXIT_SHAVE_SHARES + IMBALANCE_DUST_SHARES)
    : IMBALANCE_DUST_SHARES;

  for (let idx = 0; idx < NUCLEAR_EXIT_RETRIES && totalSold + doneTolerance < target; idx += 1) {
    const remaining = roundShares(target - totalSold);
    const top = await fetchTop(tokenId);
    const attempt: any = {
      at: new Date().toISOString(),
      bid: top.bid,
      bidSize: top.bidSize,
      stopBid,
      remaining,
      withinStop: top.bid >= stopBid - 1e-12,
      action: "wait",
    };
    if (top.bid > 0) {
      const startedMs = Date.now();
      let response: unknown;
      try {
        response = await postFakSellCached(client, tokenId, top.bid, remaining);
        assertOrderResponse(response, "updown_maker_guess_nuclear_stop");
        attempt.action = "fak_sell";
      } catch (err: any) {
        response = { error: err?.message ?? String(err) };
        attempt.action = "error";
        // The exchange reports the true available balance on oversized sells;
        // clamp the target so retries can actually fill.
        const balMatch = /balance is not enough -> balance: (\d+)/.exec(String((response as any).error ?? ""));
        if (balMatch) {
          const avail = Math.floor((Number(balMatch[1]) / 1e6) * 100) / 100;
          if (avail >= 0 && totalSold + avail < target) {
            target = roundShares(totalSold + avail);
            attempt.clampedTargetTo = target;
          }
        }
      }
      await sleep(250);
      const after = await reconcileTokenBalance(address, tokenId);
      const balanceSold = Math.max(0, roundShares(before - after - (totalSold - preSold)));
      const responseSold = Number((response as any)?.makingAmount);
      const sold = Number.isFinite(responseSold) && responseSold > 0 ? Math.min(remaining, responseSold) : Math.min(remaining, balanceSold);
      const sellPrice = averageSellPrice(response, top.bid);
      totalSold = roundShares(totalSold + sold);
      totalProceeds += sold * sellPrice;
      Object.assign(attempt, {
        response,
        elapsedMs: Date.now() - startedMs,
        sold,
        responseSold,
        balanceSold,
        sellPrice,
        totalSold,
      });
    }
    attempts.push(attempt);
    if (totalSold + doneTolerance >= target) break;
    await sleep(FILL_POLL_MS);
  }

  return {
    stopBid,
    stopCents: NUCLEAR_STOP_CENTS,
    soldShares: totalSold,
    averagePrice: totalSold > 0 ? totalProceeds / totalSold : 0,
    realizedEstimate: totalSold > 0 ? totalProceeds - totalSold * fillPrice : 0,
    prearmedUsed: attempts.some((row) => row.action === "prearmed_fak_sell"),
    status: totalSold + doneTolerance >= target ? "sold" : "stranded",
    attempts,
  };
}

type LoopPair = {
  market: TrackedMarket;
  quote: QuotePlan;
  orderIds: { up?: string; down?: string };
  responses: { up: unknown; down: unknown };
  before: { up: number; down: number };
  postedAt: string;
  postedAtMs: number;
  attempt: any;
  ladder: ComplementLadder | null;
  exitLadder: ExitLadder | null;
  ledger: InventoryLedger;
};

function balanceFillSignal(pair: LoopPair, filled: { up: number; down: number }): FillSignal | null {
  const side: "up" | "down" | null = filled.up > IMBALANCE_DUST_SHARES
    ? "up"
    : filled.down > IMBALANCE_DUST_SHARES
      ? "down"
      : null;
  if (!side) return null;
  const size = side === "up" ? filled.up : filled.down;
  const price = side === "up" ? pair.quote.upPrice : pair.quote.downPrice;
  return {
    tokenId: side === "up" ? pair.market.upTokenId : pair.market.downTokenId,
    status: "BALANCE_DELTA",
    receivedAt: new Date().toISOString(),
    raw: {
      event_type: "balance_delta",
      asset_id: side === "up" ? pair.market.upTokenId : pair.market.downTokenId,
      order_id: side === "up" ? pair.orderIds.up : pair.orderIds.down,
      status: "CONFIRMED",
      side,
      size: String(size),
      price: String(price),
    },
  };
}

async function waitForImmediateLoopFill(address: string, pair: LoopPair) {
  const tokenIds = [pair.market.upTokenId, pair.market.downTokenId];
  const orderIds = [pair.orderIds.up, pair.orderIds.down].filter(isString);
  const startedMs = Date.now();
  const deadline = startedMs + LOOP_IMMEDIATE_FILL_WATCH_MS;
  let balancePolls = 0;
  let latestFilled: { up: number; down: number } | undefined;

  while (Date.now() < deadline) {
    const signal = findOwnFill(tokenIds, orderIds, pair.postedAtMs)
      ?? matchedResponseFill(pair.market, pair.orderIds, pair.responses);
    if (signal) {
      return { signal, source: signal.status === "MATCHED_RESPONSE" ? "submit_response" : "user_ws", elapsedMs: Date.now() - startedMs, balancePolls };
    }
    await sleep(LOOP_IMMEDIATE_FILL_BALANCE_POLL_MS);
    const latest = await currentFilled(address, pair.market, pair.before);
    balancePolls += 1;
    latestFilled = latest.filled;
    const balanceSignal = balanceFillSignal(pair, latest.filled);
    if (balanceSignal) {
      return { signal: balanceSignal, source: "balance_delta", elapsedMs: Date.now() - startedMs, balancePolls, filled: latest.filled };
    }
  }

  const signal = findOwnFill(tokenIds, orderIds, pair.postedAtMs)
    ?? matchedResponseFill(pair.market, pair.orderIds, pair.responses);
  return { signal, source: signal ? "late_signal" : "none", elapsedMs: Date.now() - startedMs, balancePolls, filled: latestFilled };
}

async function cancelLoopPair(client: Clob, pair: LoopPair): Promise<any[]> {
  const cancellable = cancellableOrderEntries(pair.orderIds, pair.responses);
  pair.attempt.skippedCancels = skippedCancelEntries(pair.orderIds, pair.responses);
  return Promise.all(
    cancellable.map((row) => cancelOrderTimed(client, row.orderID!)),
  );
}

function loopPreparedPostMode(entryPlan: LoopEntryPlan): "batch" | "single" {
  if (entryPlan.mode === "low_prob_only" && entryPlan.legs.length === 1 && LOOP_LOW_PROB_POST_MODE === "single") return "single";
  return "batch";
}

async function postLoopPair(
  client: Clob,
  market: TrackedMarket,
  quote: QuotePlan,
  before: { up: number; down: number },
): Promise<LoopPair> {
  fillSignals.length = 0;
  userWsAudit.length = 0;
  const entryPlan = loopEntryPlan(market, quote);
  // The trend feed tracks BTC spot, so the veto only applies to BTC markets.
  if (market.slug.startsWith("btc-")) {
    for (const leg of entryPlan.legs) {
      const veto = trendVetoReason(leg.side);
      if (veto) throw new Error(`loop_trend_veto ${veto}`);
    }
  }
  const prepared = await prepareLimitBuy(client, entryPlan.legs);
  const preparedPostMode = loopPreparedPostMode(entryPlan);
  const postResult = await postPreparedLimitBuy(client, prepared, preparedPostMode);
  const upResp = entryPlan.legs.find((leg) => leg.side === "up")
    ? postResult.responses[entryPlan.legs.findIndex((leg) => leg.side === "up")]
    : undefined;
  const downResp = entryPlan.legs.find((leg) => leg.side === "down")
    ? postResult.responses[entryPlan.legs.findIndex((leg) => leg.side === "down")]
    : undefined;
  const orderIds = { up: orderId(upResp), down: orderId(downResp) };
  const attempt: any = {
    id: `UPDOWN-MAKER-LOOP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    mode: "LOOP_LIVE",
    market,
    pricingMode: PRICE_OVERRIDE ? "fixed" : "dynamic_book",
    prices: { up: quote.upPrice, down: quote.downPrice, pairCost: quote.pairCost },
    shares: quote.shares,
    notional: quote.notional,
    postedNotional: {
      up: entryPlan.legs.some((leg) => leg.side === "up") ? quote.notional.up : 0,
      down: entryPlan.legs.some((leg) => leg.side === "down") ? quote.notional.down : 0,
      total: Number(entryPlan.legs.reduce((sum, leg) => sum + leg.price * leg.shares, 0).toFixed(4)),
    },
    theoreticalPairEdge: quote.theoreticalPairEdge,
    entryPlan,
    preparedPostMode,
    secondsToEnd: secondsToEnd(market.endDate),
    beforeBook: { up: quote.upTop, down: quote.downTop },
    before,
    responses: { up: upResp, down: downResp },
    orderIds,
    latency: {
      preSubmitBalanceMs: 0,
      balanceMode: "market_start_baseline",
      ...postResult.latency,
      totalSubmitPathMs: postResult.latency.submitPairMs,
    },
  };
  try {
    if (upResp) assertOrderResponse(upResp, "loop_maker_guess_up");
    if (downResp) assertOrderResponse(downResp, "loop_maker_guess_down");
  } catch (err: any) {
    attempt.submitError = err?.message ?? String(err);
    attempt.skippedSubmitCleanupCancels = skippedCancelEntries(orderIds, attempt.responses);
    attempt.submitCleanup = await Promise.all(
      cancellableOrderEntries(orderIds, attempt.responses)
        .map((row) => cancelOrderTimed(client, row.orderID!)),
    );
    attempt.userWsAudit = userWsAudit.slice();
    appendJsonl(ATTEMPTS_PATH, attempt);
    throw err;
  }
  const postedSides = entryPlan.legs.map((leg) => `${leg.side}=${leg.price.toFixed(4)}`).join(" ");
  log(`loop posted ${market.slug} mode=${entryPlan.mode} postMode=${preparedPostMode} ${postedSides} pairSum=${quote.pairCost.toFixed(4)} shares=${quote.shares.toFixed(2)} ids=${orderIds.up ?? "?"}/${orderIds.down ?? "?"}`);
  const ledger = new InventoryLedger();
  for (const leg of entryPlan.legs) {
    const legOrderId = leg.side === "up" ? orderIds.up : orderIds.down;
    if (!legOrderId) continue;
    ledger.trackPost({
      orderId: legOrderId,
      tokenId: leg.tokenId,
      side: leg.side,
      role: "entry",
      requestedShares: leg.shares,
      status: responseStatus(leg.side === "up" ? upResp : downResp),
    });
  }
  return {
    market,
    quote,
    orderIds,
    responses: { up: upResp, down: downResp },
    before,
    postedAt: attempt.createdAt,
    postedAtMs: Date.now(),
    attempt,
    ladder: buildComplementLadder(client, market, entryPlan, quote.shares),
    exitLadder: buildExitLadder(client, market, entryPlan, quote.shares),
    ledger,
  };
}

// Resolve every ledger order whose outcome is still unknown before any
// naked-leg decision. getOrder size_matched and the trades ledger are the
// audit truth (never the lagging balance feed); orders that still cannot be
// confirmed after the polls close at their confirmed floor so the decision
// cannot deadlock, with the evidence kept on the attempt row.
async function auditLedgerOrders(
  client: Clob,
  market: TrackedMarket,
  ledger: InventoryLedger,
  sinceMs: number,
): Promise<any> {
  const startedMs = Date.now();
  const audited = new Set<string>();
  for (let poll = 0; poll < 3 && ledger.hasNonTerminalOrders(); poll += 1) {
    if (poll > 0) await sleep(400);
    // Synthetic ids (failed posts that never returned an order id) cannot be
    // looked up; only real exchange ids are pollable.
    const realIds = ledger.nonTerminalOrders()
      .map((order) => order.orderId)
      .filter((id) => id.startsWith("0x") || id.length > 12);
    if (!realIds.length) break;
    for (const id of realIds) audited.add(id);
    const sweepPromise = tradesFillSweepByIds(client, market, realIds, sinceMs);
    await Promise.all(realIds.map(async (id) => {
      ledger.recordOrderLookup(id, await orderMatchedShares(client, id), `audit_get_order_${poll}`);
    }));
    for (const [id, shares] of await sweepPromise) {
      ledger.recordOrderLookup(id, shares, `audit_trades_sweep_${poll}`);
    }
  }
  const forcedClosed = ledger.nonTerminalOrders().map((order) => order.orderId);
  for (const orderID of forcedClosed) {
    ledger.resolveNoFurtherFill(orderID, "audit_exhausted_no_fill_evidence");
  }
  if (forcedClosed.length) {
    log(`loop ledger audit closed ${forcedClosed.join(",")} at confirmed floors (no fill evidence)`);
  }
  return {
    elapsedMs: Date.now() - startedMs,
    audited: [...audited],
    forcedClosed,
    filled: ledger.confirmedFilled(),
  };
}

async function finalizeLoopPair(
  client: Clob,
  address: string,
  pair: LoopPair,
  firstFill: FillSignal | null,
  userWs: WebSocket | null,
): Promise<"REAL_ARB_FILL" | "NUCLEAR_EXIT" | "NUCLEAR_EXIT_DUST" | "NO_FILL" | "UNACCEPTABLE"> {
  const attempt = pair.attempt;
  attempt.userWsAudit = userWsAudit.slice();
  const responseFill = responseFilled(pair.responses);
  attempt.responseFilled = responseFill;
  const effectiveFirstFill = firstFill ?? matchedResponseFill(pair.market, pair.orderIds, pair.responses);
  attempt.firstFillSignal = effectiveFirstFill;
  if (effectiveFirstFill) {
    const reactiveStartedMs = Date.now();
    const reactiveCompletion: any = await tryReactiveCompletion(
      client,
      address,
      pair.market,
      effectiveFirstFill,
      pair.orderIds,
      { up: pair.quote.upPrice, down: pair.quote.downPrice },
      pair.ladder,
      pair.ledger,
    );
    attempt.reactiveCompletion = reactiveCompletion;
    attempt.latency.reactiveCompletionMs = Date.now() - reactiveStartedMs;
    if (reactiveCompletion.action === "fak_buy") {
      const price = typeof reactiveCompletion.buyPrice === "number" ? reactiveCompletion.buyPrice.toFixed(4) : reactiveCompletion.complementAsk;
      log(`loop reactive completion ${reactiveCompletion.complementSide} bought=${reactiveCompletion.bought ?? "?"} price=${price}`);
    }
  }

  const cancelStartedMs = Date.now();
  attempt.cancels = await cancelLoopPair(client, pair);
  attempt.latency.cancelAllMs = Date.now() - cancelStartedMs;
  for (const cancelRow of (attempt.cancels ?? []) as any[]) {
    if (cancelRow?.orderID) pair.ledger.recordCancelResult(cancelRow.orderID, cancelRow);
  }

  // Authoritative reconcile. After the cancels above, each posted order's
  // size_matched is final, and completion purchases are known exactly from
  // their own order responses. The data-api balance feed lags trades by many
  // seconds in BOTH directions and must never drive trade decisions: it has
  // produced phantom imbalances that double-bought completions and nuked real
  // legs out of matched pairs.
  const rcFill: any = attempt.reactiveCompletion;
  const rcBought = {
    up: rcFill?.complementSide === "up" && rcFill?.bought > 0 ? rcFill.bought : 0,
    down: rcFill?.complementSide === "down" && rcFill?.bought > 0 ? rcFill.bought : 0,
  };
  const signalDetails = effectiveFirstFill ? fillSignalDetails(effectiveFirstFill, pair.market, pair.orderIds) : null;
  const signalFloor = { up: 0, down: 0 };
  if (signalDetails) {
    signalFloor[signalDetails.sideFilled] = Math.min(signalDetails.shares, pair.quote.shares);
  }
  // A fully matched order is archived and getOrder can return nothing for it,
  // so the cancel rejection ("matched orders can't be canceled") is the only
  // reliable signal that the whole posted size filled. Floor with it.
  const cancelMatchedFloor = { up: 0, down: 0 };
  for (const cancelRow of (attempt.cancels ?? []) as any[]) {
    if (!cancelIndicatesMatched(cancelRow)) continue;
    if (cancelRow.orderID && cancelRow.orderID === pair.orderIds.up) cancelMatchedFloor.up = pair.quote.shares;
    if (cancelRow.orderID && cancelRow.orderID === pair.orderIds.down) cancelMatchedFloor.down = pair.quote.shares;
  }
  if (cancelMatchedFloor.up > 0 || cancelMatchedFloor.down > 0) {
    log(`loop cancel rejected as matched: up=${cancelMatchedFloor.up} down=${cancelMatchedFloor.down}`);
  }
  let [upOrderFill, downOrderFill] = await Promise.all([
    pair.orderIds.up ? orderMatchedShares(client, pair.orderIds.up) : Promise.resolve(0),
    pair.orderIds.down ? orderMatchedShares(client, pair.orderIds.down) : Promise.resolve(0),
  ]);
  upOrderFill = Math.max(upOrderFill, cancelMatchedFloor.up);
  downOrderFill = Math.max(downOrderFill, cancelMatchedFloor.down);
  // Cancel-race guard: a posted order can fill milliseconds before the cancel
  // lands, and both getOrder (archived once fully matched) and the cancel
  // response (can ok while a match lands concurrently) have missed real fills.
  // If everything looks like a no-fill, verify against the trades ledger
  // before trusting it; a missed fill here strands a naked leg into expiry.
  if (
    upOrderFill <= 0 && downOrderFill <= 0
    && responseFill.up <= 0 && responseFill.down <= 0
    && signalFloor.up <= 0 && signalFloor.down <= 0
    && (pair.orderIds.up || pair.orderIds.down)
  ) {
    for (let poll = 0; poll < 3 && upOrderFill <= 0 && downOrderFill <= 0; poll += 1) {
      if (poll > 0) await sleep(400);
      const [upStatus, downStatus, swept] = await Promise.all([
        pair.orderIds.up ? orderMatchedShares(client, pair.orderIds.up) : Promise.resolve(0),
        pair.orderIds.down ? orderMatchedShares(client, pair.orderIds.down) : Promise.resolve(0),
        tradesFillSweep(client, pair.market, pair.orderIds, pair.postedAtMs),
      ]);
      upOrderFill = Math.max(upStatus, swept.up);
      downOrderFill = Math.max(downStatus, swept.down);
    }
    if (upOrderFill > 0 || downOrderFill > 0) {
      log(`loop cancel-race fill detected up=${upOrderFill} down=${downOrderFill}`);
    }
  }
  const postedFill = {
    up: Math.max(upOrderFill, responseFill.up, signalFloor.up),
    down: Math.max(downOrderFill, responseFill.down, signalFloor.down),
  };
  attempt.orderReconcile = { upOrderFill, downOrderFill, responseFill, signalFloor, rcBought };
  if (pair.orderIds.up) pair.ledger.recordMatched(pair.orderIds.up, postedFill.up, "finalize_reconcile");
  if (pair.orderIds.down) pair.ledger.recordMatched(pair.orderIds.down, postedFill.down, "finalize_reconcile");
  let upFilled = roundShares(postedFill.up + rcBought.up);
  let downFilled = roundShares(postedFill.down + rcBought.down);
  let imbalance = roundShares(Math.abs(upFilled - downFilled));

  // Never act on a leg as naked while any complement-side order's outcome is
  // unknown: the imbalance may already be paired (the ETH session nuked a
  // paired leg because a matching completion bid read back as zero while its
  // follow-up FAK failed on balance). Audits unresolved orders to a terminal
  // state first, folds confirmed fills into the position, and only then
  // allows completion buys or the nuclear stop.
  const confirmNakedLeg = async (): Promise<boolean> => {
    if (pair.ledger.hasNonTerminalOrders()) {
      const audit = await auditLedgerOrders(client, pair.market, pair.ledger, pair.postedAtMs);
      attempt.ledgerAudits = [...(attempt.ledgerAudits ?? []), audit];
      upFilled = roundShares(Math.max(upFilled, audit.filled.up));
      downFilled = roundShares(Math.max(downFilled, audit.filled.down));
      imbalance = roundShares(Math.abs(upFilled - downFilled));
      // Fills the audit rescued must reach the recorded position and the
      // locked-profit estimate, or a saved pair would classify UNACCEPTABLE.
      if (attempt.filled) {
        const matched = Math.min(upFilled, downFilled);
        Object.assign(attempt.filled, {
          up: upFilled,
          down: downFilled,
          matched,
          imbalance,
          imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
        });
        if (matched > 0) {
          // Sides rescued by the audit have no recorded fill price; fall back
          // to the quote like the exit paths do.
          const actualPairCost = (attempt.filled.actualFillPrices.up || pair.quote.upPrice)
            + (attempt.filled.actualFillPrices.down || pair.quote.downPrice);
          attempt.actualMatchedPair = {
            pairCost: actualPairCost,
            lockedProfitEstimate: matched * (1 - actualPairCost),
          };
        }
      }
    }
    if (imbalance < IMBALANCE_DUST_SHARES) return false;
    const decision = pair.ledger.nakedDecision(IMBALANCE_DUST_SHARES);
    if (decision.state === "completion_in_flight") {
      attempt.completionInFlightBlock = decision;
      log(`loop refusing naked-leg action: completion in flight (${decision.blockedBy.join(",")})`);
      return false;
    }
    return true;
  };
  const actualFillPrices = {
    up: upFilled > 0 ? averageBuyPrice(pair.responses.up, pair.quote.upPrice) : 0,
    down: downFilled > 0 ? averageBuyPrice(pair.responses.down, pair.quote.downPrice) : 0,
  };
  // A reactive-completion buy is the real fill for the complement side. Without
  // this, the unposted leg falls back to the stale quote price and overstates
  // the locked profit (e.g. reported pair 0.941 when it actually cost 1.01).
  {
    const rc: any = attempt.reactiveCompletion;
    if (rc?.action === "fak_buy" && rc.bought > 0 && typeof rc.buyPrice === "number" && rc.buyPrice > 0) {
      const side = rc.complementSide as "up" | "down";
      const postedShares = postedFill[side];
      const postedPrice = postedShares > 0 ? averageBuyPrice(pair.responses[side], pair.quote[side === "up" ? "upPrice" : "downPrice"]) : 0;
      const totalShares = postedShares + rc.bought;
      const blended = totalShares > 0 ? ((postedShares * postedPrice) + (rc.bought * rc.buyPrice)) / totalShares : rc.buyPrice;
      actualFillPrices[side] = blended;
    }
  }
  // Balance snapshot kept for diagnostics only; never used for decisions.
  let latest = await currentFilled(address, pair.market, pair.before);
  attempt.after = latest.balances;
  attempt.filled = {
    up: upFilled,
    down: downFilled,
    matched: Math.min(upFilled, downFilled),
    imbalance,
    imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
    actualFillPrices,
  };
  if (attempt.filled.matched > 0) {
    const actualPairCost = actualFillPrices.up + actualFillPrices.down;
    attempt.actualMatchedPair = {
      pairCost: actualPairCost,
      lockedProfitEstimate: attempt.filled.matched * (1 - actualPairCost),
    };
  }

  const nakedNeedsAction = imbalance >= IMBALANCE_DUST_SHARES ? await confirmNakedLeg() : false;
  if (nakedNeedsAction && attempt.reactiveCompletion?.fastExit) {
    log(`loop gap-through fast exit: skipping completion window, going straight to nuclear`);
  }
  if (nakedNeedsAction && !attempt.reactiveCompletion?.fastExit) {
    const side = upFilled > downFilled ? "up" : "down";
    const tokenId = side === "up" ? pair.market.upTokenId : pair.market.downTokenId;
    const fillPrice = side === "up" ? (actualFillPrices.up || pair.quote.upPrice) : (actualFillPrices.down || pair.quote.downPrice);
    const completion = await tryCompleteImbalance(client, address, pair.market, side, fillPrice, imbalance, pair.ledger);
    attempt.completion = completion;
    latest = await currentFilled(address, pair.market, pair.before);
    // Completion buys are separate orders; add their confirmed fills instead of
    // re-deriving the position from the lagging balance feed.
    const completionBought = Number(completion?.bought) > 0 ? Number(completion.bought) : 0;
    if (completion?.complementSide === "up") upFilled = roundShares(upFilled + completionBought);
    if (completion?.complementSide === "down") downFilled = roundShares(downFilled + completionBought);
    imbalance = roundShares(Math.abs(upFilled - downFilled));
    if (completion?.bought > 0 && completion?.averagePrice > 0) {
      if (completion.complementSide === "up") actualFillPrices.up = completion.averagePrice;
      if (completion.complementSide === "down") actualFillPrices.down = completion.averagePrice;
    }
    attempt.afterCompletion = latest.balances;
    attempt.filledAfterCompletion = {
      up: upFilled,
      down: downFilled,
      matched: Math.min(upFilled, downFilled),
      imbalance,
      imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
    };
    const matchedAfterCompletion = Math.min(upFilled, downFilled);
    // Record the locked profit on the matched portion even when overfill dust
    // remains; the residual is accounted for separately by the nuclear stop.
    if (matchedAfterCompletion > 0) {
      const actualPairCost = actualFillPrices.up + actualFillPrices.down;
      attempt.actualMatchedPair = {
        pairCost: actualPairCost,
        lockedProfitEstimate: matchedAfterCompletion * (1 - actualPairCost),
      };
    }
  }

  // Re-confirm before the stop: completion FAK errors above may have left new
  // unresolved orders whose fills would make this sale break a matched pair.
  if (nakedNeedsAction && imbalance >= IMBALANCE_DUST_SHARES && await confirmNakedLeg()) {
    const side = upFilled > downFilled ? "up" : "down";
    const tokenId = side === "up" ? pair.market.upTokenId : pair.market.downTokenId;
    const fillPrice = side === "up" ? (actualFillPrices.up || pair.quote.upPrice) : (actualFillPrices.down || pair.quote.downPrice);
    log(`loop imbalance ${side}=${imbalance}; exiting naked side`);
    attempt.nuclearStop = {
      side,
      tokenId,
      fillPrice,
      attemptedShares: imbalance,
      ...(await nuclearStopExit(client, address, tokenId, fillPrice, imbalance, pair.exitLadder)),
    };
    latest = await waitForSettledFilled(address, pair.market, pair.before, 6_000);
    upFilled = latest.filled.up;
    downFilled = latest.filled.down;
    imbalance = roundShares(Math.abs(upFilled - downFilled));
    attempt.afterNuclearStop = latest.balances;
    attempt.filledAfterNuclearStop = {
      up: upFilled,
      down: downFilled,
      matched: Math.min(upFilled, downFilled),
      imbalance,
      imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
    };
  }

  const openOrders = await client.getOpenOrders() as any[];
  attempt.finalOpenOrders = openOrders.filter((o: any) => (
    o.market === pair.market.conditionId
    || o.asset_id === pair.market.upTokenId
    || o.asset_id === pair.market.downTokenId
  ));
  attempt.userWsAudit = userWsAudit.slice();
  attempt.inventoryLedger = pair.ledger.snapshot();
  const finalMatched = Math.min(upFilled, downFilled);
  log(`loop result filled up=${upFilled} down=${downFilled} matched=${finalMatched} imbalance=${imbalance}`);
  const classification = classifyLoopOutcome(attempt, finalMatched, imbalance);
  attempt.classification = classification;
  appendJsonl(ATTEMPTS_PATH, attempt);
  if (classification === "NUCLEAR_EXIT") {
    // A real nuclear exit means this market is trending; re-entering it
    // re-samples the same adverse regime.
    nuclearCooldownSlugs.add(pair.market.slug);
    log(`loop nuclear cooldown armed for ${pair.market.slug}`);
  }
  return classification;
}

function classifyLoopOutcome(
  attempt: any,
  finalMatched: number,
  imbalance: number,
): "REAL_ARB_FILL" | "NUCLEAR_EXIT" | "NUCLEAR_EXIT_DUST" | "NO_FILL" | "UNACCEPTABLE" {
  const lockedProfit = attempt.actualMatchedPair?.lockedProfitEstimate ?? 0;
  if (attempt.nuclearStop?.status === "sold") {
    // Benign dust: a profitable matched pair is intact, nothing meaningful is left
    // naked, and the residual the stop sold was small (FAK overfill, not a naked leg).
    const dustSold = Number(attempt.nuclearStop?.attemptedShares ?? 0);
    // The post-stop balance read can lag the stop's sale; credit shares the
    // stop confirmed sold when judging the residual.
    const soldByStop = Number(attempt.nuclearStop?.soldShares ?? 0);
    const residual = Math.max(0, imbalance - soldByStop);
    const cleanArbAttached = finalMatched > 0 && residual < IMBALANCE_DUST_SHARES && lockedProfit > 0;
    const dustCap = Math.max(NUCLEAR_DUST_MAX_SHARES, finalMatched * NUCLEAR_DUST_MAX_FRACTION);
    if (cleanArbAttached && dustSold <= dustCap) {
      return "NUCLEAR_EXIT_DUST";
    }
    return "NUCLEAR_EXIT";
  }
  if (finalMatched < IMBALANCE_DUST_SHARES && imbalance < IMBALANCE_DUST_SHARES) return "NO_FILL";
  if (finalMatched > 0 && imbalance < IMBALANCE_DUST_SHARES && lockedProfit > 0) {
    return "REAL_ARB_FILL";
  }
  return "UNACCEPTABLE";
}

async function loopLiveMain(existingClob?: ClobBundle, installSignalHandlers = true, runLabel = "") {
  const clob = existingClob ?? await clobClient();
  const client = clob.client;
  const address = POLYMARKET_FUNDER_ADDRESS ?? clob.signer.address;
  const startedMs = Date.now();
  let idleStartedMs = Date.now();
  let market: TrackedMarket | null = null;
  let userWs: WebSocket | null = null;
  let marketWs: WebSocket | null = null;
  let activePair: LoopPair | null = null;
  let marketBaseline: { up: number; down: number } | null = null;

  const shutdown = async () => {
    if (activePair) {
      try { await cancelLoopPair(client, activePair); }
      catch (err: any) { log(`loop shutdown cancel warning: ${err?.message ?? String(err)}`); }
    }
    userWs?.close();
    marketWs?.close();
  };
  if (installSignalHandlers) {
    process.once("SIGINT", () => { shutdown().finally(() => process.exit(130)); });
    process.once("SIGTERM", () => { shutdown().finally(() => process.exit(143)); });
  }

  log(`${LOOP_LIVE ? "loop-live" : "loop-dry-run"}${runLabel ? ` ${runLabel}` : ""} starting assets=${LOOP_ASSETS.join(",")} refreshMs=${LOOP_REFRESH_MS} maxMs=${LOOP_MAX_MS} maxNotional=$${MAX_TEST_PAIR_NOTIONAL_USD} maxPairCost=${maxSafePairCost().toFixed(4)} safetyBuffer=${COMPLEMENT_SAFETY_BUFFER.toFixed(4)} entryDepth=${ENTRY_DEPTH.toFixed(3)} maxCompletionPairCost=${maxCompletionPairCost().toFixed(4)} ladderTicks=${COMPLETION_LADDER_TICKS} gapFastExit=${GAP_FAST_EXIT.toFixed(3)} momentumCancel=${MOMENTUM_CANCEL_MOVE.toFixed(3)}@${MOMENTUM_WINDOW_MS}ms trendVeto=${TREND_VETO_PCT > 0 ? `${TREND_VETO_PCT.toFixed(3)}%@${Math.round(TREND_WINDOW_MS / 1000)}s` : "off"} prearmedExit=${PREARMED_EXIT ? `depth=${PREARMED_EXIT_DEPTH.toFixed(3)}` : "off"}`);
  startTrendPoller();

  while (Date.now() - startedMs < LOOP_MAX_MS) {
    if (LOOP_MAX_IDLE_MS > 0 && Date.now() - idleStartedMs > LOOP_MAX_IDLE_MS) {
      log(`loop idle timeout ${LOOP_MAX_IDLE_MS}ms`);
      break;
    }
    if (!market || (secondsToEnd(market.endDate) ?? 0) < LOOP_MIN_SECONDS_TO_END) {
      if (activePair) {
        await cancelLoopPair(client, activePair);
        activePair = null;
      }
      userWs?.close();
      userWs = null;
      marketWs?.close();
      marketWs = null;
      marketBaseline = null;
      market = await discoverLoopMarket();
      if (!market) {
        // With the calm gate active a null here usually means no asset is
        // calm; recheck on the gate cadence instead of hammering discovery.
        await sleep(CALM_RANGE_PCT > 0 ? Math.min(CALM_RECHECK_MS, 10_000) : LOOP_REFRESH_MS);
        continue;
      }
      marketWs = await connectMarketWs(market);
      userWs = await connectUserWs(clob, market.conditionId, [market.upTokenId, market.downTokenId]);
      await Promise.all([tickSize(client, market.upTokenId), tickSize(client, market.downTokenId)]);
      const baselineStartedMs = Date.now();
      const [baselineUp, baselineDown] = await Promise.all([
        reconcileTokenBalance(address, market.upTokenId),
        reconcileTokenBalance(address, market.downTokenId),
      ]);
      marketBaseline = { up: baselineUp, down: baselineDown };
      if (baselineUp >= IMBALANCE_DUST_SHARES || baselineDown >= IMBALANCE_DUST_SHARES) {
        throw new Error(`pre_existing_5m_position up=${baselineUp} down=${baselineDown}`);
      }
      log(`loop tracking ${market.slug} secondsToEnd=${secondsToEnd(market.endDate)?.toFixed(1) ?? "?"} marketWs=${marketWs?.readyState === WebSocket.OPEN} cacheAges=${Math.round(cacheAgeMs(market.upTokenId))}/${Math.round(cacheAgeMs(market.downTokenId))}ms baselineMs=${Date.now() - baselineStartedMs}`);
    }

    sampleMid(market.upTokenId);
    sampleMid(market.downTokenId);

    const firstFill = activePair
      ? findOwnFill([market.upTokenId, market.downTokenId], [activePair.orderIds.up, activePair.orderIds.down].filter(isString), activePair.postedAtMs)
        ?? matchedResponseFill(market, activePair.orderIds, activePair.responses)
      : null;
    if (activePair && firstFill) {
      const classification = await finalizeLoopPair(client, address, activePair, firstFill, userWs);
      log(`loop terminal classification=${classification}`);
      userWs?.close();
      marketWs?.close();
      return;
    }

    // Momentum kill-switch: if the mid is collapsing toward a resting bid,
    // cancel before the sweep reaches us instead of waiting for quoteChanged.
    if (activePair && MOMENTUM_CANCEL_MOVE > 0) {
      const postedTokens = [
        activePair.orderIds.up ? market.upTokenId : null,
        activePair.orderIds.down ? market.downTokenId : null,
      ].filter(isString);
      const drop = postedTokens.length ? Math.max(...postedTokens.map((tokenId) => midDropCents(tokenId))) : 0;
      if (drop >= MOMENTUM_CANCEL_MOVE - 1e-9) {
        activePair.attempt.momentumCancel = { drop: Number(drop.toFixed(4)), at: new Date().toISOString() };
        log(`loop momentum cancel drop=${drop.toFixed(3)} window=${MOMENTUM_WINDOW_MS}ms`);
        const fillNow = findOwnFill([market.upTokenId, market.downTokenId], [activePair.orderIds.up, activePair.orderIds.down].filter(isString), activePair.postedAtMs)
          ?? matchedResponseFill(market, activePair.orderIds, activePair.responses);
        const classification = await finalizeLoopPair(client, address, activePair, fillNow, userWs);
        if (classification !== "NO_FILL") {
          log(`loop terminal classification=${classification}`);
          userWs?.close();
          marketWs?.close();
          return;
        }
        activePair = null;
        await sleep(LOOP_REFRESH_MS);
        continue;
      }
    }

    let quote: QuotePlan;
    try {
      quote = await quotePlanForMarket(market);
    } catch (err: any) {
      if (activePair) {
        const firstFill = findOwnFill([market.upTokenId, market.downTokenId], [activePair.orderIds.up, activePair.orderIds.down].filter(isString), activePair.postedAtMs)
          ?? matchedResponseFill(market, activePair.orderIds, activePair.responses);
        const classification = await finalizeLoopPair(client, address, activePair, firstFill, userWs);
        if (classification !== "NO_FILL") {
          log(`loop terminal classification=${classification}`);
          userWs?.close();
          marketWs?.close();
          return;
        }
        activePair = null;
      }
      log(`loop skip ${market.slug}: ${err?.message ?? String(err)}`);
      await sleep(LOOP_REFRESH_MS);
      continue;
    }

    if (!activePair) {
      if (!LOOP_LIVE) {
        const plan = loopEntryPlan(market, quote);
        const postedSides = plan.legs.map((leg) => `${leg.side}=${leg.price.toFixed(4)}`).join(" ");
        log(`loop dry quote ${market.slug} mode=${plan.mode} ${postedSides} pairSum=${quote.pairCost.toFixed(4)} shares=${quote.shares.toFixed(2)}`);
        await sleep(LOOP_REFRESH_MS);
        continue;
      }
      if (MOMENTUM_CANCEL_MOVE > 0 && midRangeCents(market.upTokenId) >= MOMENTUM_CANCEL_MOVE - 1e-9) {
        // Market is moving too fast to rest a bid safely; wait for it to calm.
        await sleep(LOOP_REFRESH_MS);
        continue;
      }
      try {
        activePair = await postLoopPair(client, market, quote, marketBaseline ?? { up: 0, down: 0 });
        idleStartedMs = Date.now();
        const immediate = await waitForImmediateLoopFill(address, activePair);
        activePair.attempt.immediateFillWatch = immediate;
        if (immediate.signal) {
          const classification = await finalizeLoopPair(client, address, activePair, immediate.signal, userWs);
          log(`loop terminal classification=${classification}`);
          userWs?.close();
          marketWs?.close();
          return;
        }
      } catch (err: any) {
        log(`loop post skipped: ${err?.message ?? String(err)}`);
        await sleep(LOOP_REFRESH_MS);
      }
      continue;
    }

    if (quoteChanged(activePair.quote, quote)) {
      const firstFill = findOwnFill([market.upTokenId, market.downTokenId], [activePair.orderIds.up, activePair.orderIds.down].filter(isString), activePair.postedAtMs)
        ?? matchedResponseFill(market, activePair.orderIds, activePair.responses);
      const classification = await finalizeLoopPair(client, address, activePair, firstFill, userWs);
      if (classification !== "NO_FILL") {
        log(`loop terminal classification=${classification}`);
        userWs?.close();
        marketWs?.close();
        return;
      }
      activePair = null;
      if (!LOOP_LIVE) {
        await sleep(LOOP_REFRESH_MS);
        continue;
      }
      if (MOMENTUM_CANCEL_MOVE > 0 && midRangeCents(market.upTokenId) >= MOMENTUM_CANCEL_MOVE - 1e-9) {
        await sleep(LOOP_REFRESH_MS);
        continue;
      }
      try {
        activePair = await postLoopPair(client, market, quote, marketBaseline ?? { up: 0, down: 0 });
        idleStartedMs = Date.now();
        const immediate = await waitForImmediateLoopFill(address, activePair);
        activePair.attempt.immediateFillWatch = immediate;
        if (immediate.signal) {
          const classification = await finalizeLoopPair(client, address, activePair, immediate.signal, userWs);
          log(`loop terminal classification=${classification}`);
          userWs?.close();
          marketWs?.close();
          return;
        }
      } catch (err: any) {
        log(`loop replace skipped: ${err?.message ?? String(err)}`);
        await sleep(LOOP_REFRESH_MS);
      }
      continue;
    }

    await sleep(LOOP_REFRESH_MS);
  }

  await shutdown();
  log("loop-live ended without terminal fill");
}

const btcTrendSamples: Array<{ ts: number; px: number }> = [];
let trendPollerStarted = false;

// Coinbase measured fastest from the japan VPS (~85ms vs ~340ms for
// Hyperliquid) and is already proven for the calm gate; Hyperliquid is the
// fallback feed.
async function fetchBtcSpot(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      headers: { "User-Agent": "updown-maker-guess/1.0" },
    });
    if (res.ok) {
      const body = await res.json() as { data?: { amount?: string } };
      const px = Number(body?.data?.amount);
      if (px > 0) return px;
    }
  } catch {}
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (res.ok) {
      const mids = await res.json() as Record<string, string>;
      const px = Number(mids?.BTC);
      if (px > 0) return px;
    }
  } catch {}
  return null;
}

// Backfill the trend window from 1m candles so the veto is armed from the
// very first post instead of standing down for the first minute of a run.
async function seedTrendHistory() {
  try {
    const res = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60", {
      headers: { "User-Agent": "updown-maker-guess/1.0" },
    });
    const rows = await res.json() as number[][];
    if (!Array.isArray(rows)) return;
    const recent = rows.slice(0, Math.ceil(TREND_WINDOW_MS / 60_000) + 1).reverse();
    for (const candle of recent) {
      const ts = Math.min((Number(candle[0]) + 60) * 1000, Date.now());
      const close = Number(candle[4]);
      if (close > 0 && ts > Date.now() - TREND_WINDOW_MS - 30_000) {
        btcTrendSamples.push({ ts, px: close });
      }
    }
  } catch {}
}

function startTrendPoller() {
  if (trendPollerStarted || !(TREND_VETO_PCT > 0)) return;
  trendPollerStarted = true;
  const poll = async () => {
    const px = await fetchBtcSpot();
    if (px != null) {
      btcTrendSamples.push({ ts: Date.now(), px });
      const cutoff = Date.now() - TREND_WINDOW_MS - 30_000;
      while (btcTrendSamples.length && btcTrendSamples[0].ts < cutoff) btcTrendSamples.shift();
    }
  };
  // Samples must stay time-ordered, so the candle seed completes before the
  // first live poll lands.
  void seedTrendHistory().then(() => poll());
  const timer = setInterval(() => { void poll(); }, TREND_POLL_MS);
  timer.unref?.();
}

// Signed BTC return (%) over the trend window. Null while the feed is stale or
// history is too short (< 1/3 window) to call a trend; the veto then stands
// down rather than blocking entries on missing data.
function btcTrendPct(): number | null {
  if (btcTrendSamples.length < 2) return null;
  const latest = btcTrendSamples[btcTrendSamples.length - 1];
  if (Date.now() - latest.ts > TREND_POLL_MS * 5) return null;
  const cutoff = latest.ts - TREND_WINDOW_MS;
  const past = btcTrendSamples.find((row) => row.ts >= cutoff) ?? btcTrendSamples[0];
  if (!(past.px > 0) || latest.ts - past.ts < TREND_WINDOW_MS / 3) return null;
  return ((latest.px - past.px) / past.px) * 100;
}

function trendVetoReason(side: "up" | "down"): string | null {
  if (!(TREND_VETO_PCT > 0)) return null;
  const trend = btcTrendPct();
  if (trend == null) return null;
  if (side === "up" && trend <= -TREND_VETO_PCT) return `btc_${trend.toFixed(3)}pct_against_up`;
  if (side === "down" && trend >= TREND_VETO_PCT) return `btc_+${trend.toFixed(3)}pct_against_down`;
  return null;
}

// 10-minute high/low range (%) for an asset's spot, from Coinbase 1m candles.
async function assetRangePct(asset: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.exchange.coinbase.com/products/${asset.toUpperCase()}-USD/candles?granularity=60`, {
      headers: { "User-Agent": "updown-maker-guess/1.0" },
    });
    const rows = await res.json() as number[][];
    const recent = Array.isArray(rows) ? rows.slice(0, 10) : [];
    if (!recent.length) return null;
    const hi = Math.max(...recent.map((c) => c[2]));
    const lo = Math.min(...recent.map((c) => c[1]));
    if (!(hi > 0) || !(lo > 0)) return null;
    return ((hi - lo) / lo) * 100;
  } catch {
    return null;
  }
}

async function loopRepeatMain() {
  startTrendPoller();
  const repeatCount = Math.max(1, Math.floor(LOOP_REPEAT_COUNT));
  if (repeatCount <= 1 && CALM_RANGE_PCT <= 0) {
    await loopLiveMain();
    return;
  }
  const clob = await clobClient();
  log(`loop hot runner starting repeatCount=${repeatCount} pauseMs=${LOOP_REPEAT_PAUSE_MS} calmRangePct=${CALM_RANGE_PCT > 0 ? CALM_RANGE_PCT : "off"}`);
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  for (let idx = 0; idx < repeatCount && !stopping; idx += 1) {
    if (CALM_RANGE_PCT > 0) {
      const ranges = await calmAssetsNow();
      const summary = [...ranges.entries()]
        .map(([asset, range]) => `${asset}=${range == null ? "?" : range.toFixed(3)}%`)
        .join(" ");
      if (calmAssets.size === 0) {
        log(`loop calm gate: no asset below ${CALM_RANGE_PCT}% (${summary}); waiting ${CALM_RECHECK_MS}ms`);
        idx -= 1;
        await sleep(CALM_RECHECK_MS);
        continue;
      }
      log(`loop calm gate ok: ${[...calmAssets].join(",")} below ${CALM_RANGE_PCT}% (${summary})`);
    }
    log(`loop hot runner attempt ${idx + 1}/${repeatCount}`);
    try {
      await loopLiveMain(clob, false, `[${idx + 1}/${repeatCount}]`);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      log(`loop hot runner attempt error: ${message}`);
      // A matched pair from the previous run blocks the same market until it
      // resolves, and a nuclear-cooldown market just needs the next window;
      // wait these out without consuming an attempt.
      if ((message.includes("pre_existing_5m_position") || message.includes("market_in_nuclear_cooldown")) && !stopping) {
        idx -= 1;
        await sleep(15_000);
        continue;
      }
    }
    if (idx + 1 < repeatCount && !stopping) await sleep(LOOP_REPEAT_PAUSE_MS);
  }
  log("loop hot runner ended");
}

async function main() {
  const markets = await discoverMarkets();
  const candidateMarkets = TARGET_SLUG
    ? markets.filter((row) => row.slug === TARGET_SLUG)
    : markets.filter((row) => !TARGET_CONTAINS || row.slug.includes(TARGET_CONTAINS));
  if (!candidateMarkets.length) {
    throw new Error(`no active 5m market found targetSlug=${TARGET_SLUG || "none"} contains=${TARGET_CONTAINS}`);
  }

  let selected: { market: TrackedMarket; upTop: Top; downTop: Top; upPrice: number; downPrice: number; pairCost: number } | null = null;
  const skips: string[] = [];
  for (const candidateMarket of candidateMarkets) {
    try {
      const [candidateUpTop, candidateDownTop] = await Promise.all([
        fetchTop(candidateMarket.upTokenId),
        fetchTop(candidateMarket.downTokenId),
      ]);
      const candidateUpPrice = dynamicBid(candidateUpTop, "up");
      const candidateDownPrice = dynamicBid(candidateDownTop, "down");
      const candidatePairCost = candidateUpPrice + candidateDownPrice;
      const maxPairCost = maxSafePairCost();
      if (candidatePairCost >= maxPairCost) {
        skips.push(`${candidateMarket.slug}: sum=${candidatePairCost.toFixed(4)} >= ${maxPairCost.toFixed(4)} buffer=${COMPLEMENT_SAFETY_BUFFER.toFixed(4)}`);
        continue;
      }
      const crossBlock = complementCrossBlock(candidateUpPrice, candidateDownPrice, candidateUpTop, candidateDownTop);
      if (crossBlock) {
        skips.push(`${candidateMarket.slug}: ${crossBlock}`);
        continue;
      }
      const candidateShares = Math.max(
        minValidShares(candidateUpPrice, candidateUpTop.minOrderSize),
        minValidShares(candidateDownPrice, candidateDownTop.minOrderSize),
      );
      const candidateNotional = candidateShares * candidatePairCost;
      if (candidateNotional > MAX_TEST_PAIR_NOTIONAL_USD + 1e-12) {
        skips.push(`${candidateMarket.slug}: minPairNotional=$${candidateNotional.toFixed(2)} > maxTest=$${MAX_TEST_PAIR_NOTIONAL_USD.toFixed(2)}`);
        continue;
      }
      selected = {
        market: candidateMarket,
        upTop: candidateUpTop,
        downTop: candidateDownTop,
        upPrice: candidateUpPrice,
        downPrice: candidateDownPrice,
        pairCost: candidatePairCost,
      };
      break;
    } catch (err: any) {
      skips.push(`${candidateMarket.slug}: ${err?.message ?? String(err)}`);
    }
  }
  if (!selected) {
    throw new Error(`no safe maker-guess market found: ${skips.slice(0, 5).join(" | ")}`);
  }
  let { market, upTop, downTop, upPrice, downPrice, pairCost } = selected;
  let shares = planShares(upPrice, downPrice, pairCost, Math.max(
    minValidShares(upPrice, upTop.minOrderSize),
    minValidShares(downPrice, downTop.minOrderSize),
  ));
  const attempt: any = {
    id: `UPDOWN-MAKER-GUESS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    mode: LIVE ? "LIVE" : "DRY_RUN",
    market,
    pricingMode: PRICE_OVERRIDE ? "fixed" : "dynamic_book",
    prices: { up: upPrice, down: downPrice, pairCost },
    shares,
    notional: {
      up: Number((upPrice * shares).toFixed(4)),
      down: Number((downPrice * shares).toFixed(4)),
      total: Number((pairCost * shares).toFixed(4)),
    },
    theoreticalPairEdge: Number(((1 - pairCost) * shares).toFixed(4)),
    secondsToEnd: secondsToEnd(market.endDate),
    beforeBook: { up: upTop, down: downTop },
  };
  log(`${attempt.mode} ${market.slug} bid up=${upPrice.toFixed(4)} down=${downPrice.toFixed(4)} sum=${pairCost.toFixed(4)} x ${shares.toFixed(2)} shares holdMs=${HOLD_MS}`);
  log(`notional up=$${attempt.notional.up.toFixed(2)} down=$${attempt.notional.down.toFixed(2)} total=$${attempt.notional.total.toFixed(2)} theoretical pair edge=$${attempt.theoreticalPairEdge.toFixed(4)}`);

  if (!LIVE) {
    appendJsonl(ATTEMPTS_PATH, attempt);
    log(`dry-run only. Re-run with --live to place/cancel the minimum-size GTC test.`);
    return;
  }

  const clob = await clobClient();
  const address = POLYMARKET_FUNDER_ADDRESS ?? clob.signer.address;
  attempt.walletAddress = address;
  const userWs = await connectUserWs(clob, market.conditionId, [market.upTokenId, market.downTokenId]);
  attempt.userWs = { connected: userWs?.readyState === WebSocket.OPEN, conditionId: market.conditionId };
  const tickWarmStartedMs = Date.now();
  await Promise.all([tickSize(clob.client, market.upTokenId), tickSize(clob.client, market.downTokenId)]);
  attempt.tickWarmMs = Date.now() - tickWarmStartedMs;
  const [beforeUp, beforeDown] = await Promise.all([
    reconcileTokenBalance(address, market.upTokenId),
    reconcileTokenBalance(address, market.downTokenId),
  ]);
  attempt.before = { up: beforeUp, down: beforeDown };
  if (beforeUp >= IMBALANCE_DUST_SHARES || beforeDown >= IMBALANCE_DUST_SHARES) {
    attempt.preExistingPositionBlock = {
      up: beforeUp,
      down: beforeDown,
      matched: Math.min(beforeUp, beforeDown),
      imbalance: Math.abs(beforeUp - beforeDown),
    };
    appendJsonl(ATTEMPTS_PATH, attempt);
    userWs?.close();
    throw new Error(`pre_existing_5m_position up=${beforeUp} down=${beforeDown}`);
  }

  const [preSubmitUpTop, preSubmitDownTop] = await Promise.all([
    fetchTop(market.upTokenId),
    fetchTop(market.downTokenId),
  ]);
  const preSubmitUpPrice = dynamicBid(preSubmitUpTop, "up_pre_submit");
  const preSubmitDownPrice = dynamicBid(preSubmitDownTop, "down_pre_submit");
  const preSubmitPairCost = preSubmitUpPrice + preSubmitDownPrice;
  const preSubmitCrossBlock = complementCrossBlock(preSubmitUpPrice, preSubmitDownPrice, preSubmitUpTop, preSubmitDownTop);
  const preSubmitMaxPairCost = maxSafePairCost();
  if (preSubmitPairCost >= preSubmitMaxPairCost) {
    throw new Error(`pre_submit_edge_gone sum=${preSubmitPairCost.toFixed(4)} >= ${preSubmitMaxPairCost.toFixed(4)} buffer=${COMPLEMENT_SAFETY_BUFFER.toFixed(4)}`);
  }
  if (preSubmitCrossBlock) {
    throw new Error(`pre_submit_cross_block ${preSubmitCrossBlock}`);
  }
  const preSubmitShares = planShares(preSubmitUpPrice, preSubmitDownPrice, preSubmitPairCost, Math.max(
    minValidShares(preSubmitUpPrice, preSubmitUpTop.minOrderSize),
    minValidShares(preSubmitDownPrice, preSubmitDownTop.minOrderSize),
  ));
  const preSubmitNotional = preSubmitShares * preSubmitPairCost;
  if (preSubmitNotional > MAX_TEST_PAIR_NOTIONAL_USD + 1e-12) {
    throw new Error(`pre_submit_minPairNotional=$${preSubmitNotional.toFixed(2)} > maxTest=$${MAX_TEST_PAIR_NOTIONAL_USD.toFixed(2)}`);
  }
  attempt.initialSelection = {
    prices: attempt.prices,
    shares: attempt.shares,
    notional: attempt.notional,
    beforeBook: attempt.beforeBook,
  };
  upTop = preSubmitUpTop;
  downTop = preSubmitDownTop;
  upPrice = preSubmitUpPrice;
  downPrice = preSubmitDownPrice;
  pairCost = preSubmitPairCost;
  shares = preSubmitShares;
  attempt.beforeBook = { up: upTop, down: downTop };
  attempt.prices = { up: upPrice, down: downPrice, pairCost };
  attempt.shares = shares;
  attempt.notional = {
    up: Number((upPrice * shares).toFixed(4)),
    down: Number((downPrice * shares).toFixed(4)),
    total: Number((pairCost * shares).toFixed(4)),
  };
  attempt.theoreticalPairEdge = Number(((1 - pairCost) * shares).toFixed(4));
  log(`pre-submit ${market.slug} bid up=${upPrice.toFixed(4)} down=${downPrice.toFixed(4)} sum=${pairCost.toFixed(4)} x ${shares.toFixed(2)} shares`);

  fillSignals.length = 0;
  userWsAudit.length = 0;
  const postResult = await postLimitBuyPair(clob.client, [
    { tokenId: market.upTokenId, price: upPrice, shares },
    { tokenId: market.downTokenId, price: downPrice, shares },
  ]);
  const [upResp, downResp] = postResult.responses;
  attempt.latency = postResult.latency;
  attempt.responses = { up: upResp, down: downResp };
  attempt.orderIds = { up: orderId(upResp), down: orderId(downResp) };
  attempt.postedAtMs = Date.now();
  try {
    assertOrderResponse(upResp, "maker_guess_up");
    assertOrderResponse(downResp, "maker_guess_down");
  } catch (err: any) {
    attempt.submitError = err?.message ?? String(err);
    attempt.skippedSubmitCleanupCancels = skippedCancelEntries(attempt.orderIds, attempt.responses);
    attempt.submitCleanup = await Promise.all(
      cancellableOrderEntries(attempt.orderIds, attempt.responses)
        .map((row) => cancelOrderTimed(clob.client, row.orderID!)),
    );
    attempt.userWsAudit = userWsAudit.slice();
    appendJsonl(ATTEMPTS_PATH, attempt);
    userWs?.close();
    throw err;
  }
  log(`posted orderIds up=${attempt.orderIds.up ?? "?"} down=${attempt.orderIds.down ?? "?"}`);

  const fillWaitStartedMs = Date.now();
  const firstFill = await waitForOwnFill(
    [market.upTokenId, market.downTokenId],
    [attempt.orderIds.up, attempt.orderIds.down].filter(Boolean),
    HOLD_MS,
    attempt.postedAtMs,
  );
  attempt.firstFillSignal = firstFill;
  attempt.latency.firstFillWaitMs = Date.now() - fillWaitStartedMs;
  if (firstFill) {
    const reactiveStartedMs = Date.now();
    const reactiveCompletion: any = await tryReactiveCompletion(clob.client, address, market, firstFill, attempt.orderIds, { up: upPrice, down: downPrice }, null);
    attempt.reactiveCompletion = reactiveCompletion;
    attempt.latency.reactiveCompletionMs = Date.now() - reactiveStartedMs;
    if (reactiveCompletion.action === "fak_buy") {
      const price = typeof reactiveCompletion.buyPrice === "number" ? reactiveCompletion.buyPrice.toFixed(4) : reactiveCompletion.complementAsk;
      log(`reactive completion ${reactiveCompletion.complementSide} bought=${reactiveCompletion.bought ?? "?"} price=${price}`);
    } else {
      log(`reactive completion skipped action=${reactiveCompletion.action} reason=${reactiveCompletion.reason ?? "none"} ask=${reactiveCompletion.complementAsk ?? "?"} max=${reactiveCompletion.maxComplementPrice ?? "?"}`);
    }
  }
  let latest = await currentFilled(address, market, { up: beforeUp, down: beforeDown });
  const matchedNow = Math.min(latest.filled.up, latest.filled.down);
  const imbalanceNow = roundShares(Math.abs(latest.filled.up - latest.filled.down));
  attempt.fillCheck = {
    at: new Date().toISOString(),
    filled: latest.filled,
    matched: matchedNow,
    imbalance: imbalanceNow,
    signalCount: fillSignals.length,
  };
  if (imbalanceNow >= IMBALANCE_DUST_SHARES) {
    log(`detected one-sided fill up=${latest.filled.up} down=${latest.filled.down}; cancelling and attempting completion`);
  }

  const cancelStartedMs = Date.now();
  attempt.skippedCancels = skippedCancelEntries(attempt.orderIds, attempt.responses);
  const cancelResults = await Promise.all(
    cancellableOrderEntries(attempt.orderIds, attempt.responses)
      .map((row) => cancelOrderTimed(clob.client, row.orderID!)),
  );
  attempt.cancels = cancelResults;
  attempt.latency.cancelAllMs = Date.now() - cancelStartedMs;
  for (const result of cancelResults) {
    log(`${result.ok ? "cancelled" : "cancel warning"} ${result.orderID}${result.error ? `: ${result.error}` : ""}`);
  }

  latest = await waitForSettledFilled(
    address,
    market,
    { up: beforeUp, down: beforeDown },
    firstFill ? 6_000 : 1_000,
  );
  let upFilled = latest.filled.up;
  let downFilled = latest.filled.down;
  const matched = Math.min(upFilled, downFilled);
  let imbalance = roundShares(Math.abs(upFilled - downFilled));
  const actualFillPrices = {
    up: upFilled > 0 ? averageBuyPrice(upResp, upPrice) : 0,
    down: downFilled > 0 ? averageBuyPrice(downResp, downPrice) : 0,
  };
  attempt.after = latest.balances;
  attempt.filled = {
    up: upFilled,
    down: downFilled,
    matched,
    imbalance,
    imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
    actualFillPrices,
  };
  if (matched > 0) {
    const actualPairCost = actualFillPrices.up + actualFillPrices.down;
    attempt.actualMatchedPair = {
      pairCost: actualPairCost,
      lockedProfitEstimate: matched * (1 - actualPairCost),
    };
  }

  if (imbalance >= IMBALANCE_DUST_SHARES) {
    const side = upFilled > downFilled ? "up" : "down";
    const tokenId = side === "up" ? market.upTokenId : market.downTokenId;
    const fillPrice = side === "up" ? actualFillPrices.up : actualFillPrices.down;
    const completion = await tryCompleteImbalance(clob.client, address, market, side, fillPrice, imbalance);
    attempt.completion = completion;
    latest = await currentFilled(address, market, { up: beforeUp, down: beforeDown });
    upFilled = latest.filled.up;
    downFilled = latest.filled.down;
    imbalance = roundShares(Math.abs(upFilled - downFilled));
    attempt.afterCompletion = latest.balances;
    attempt.filledAfterCompletion = {
      up: upFilled,
      down: downFilled,
      matched: Math.min(upFilled, downFilled),
      imbalance,
      imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
    };
  }

  if (imbalance >= IMBALANCE_DUST_SHARES) {
    const side = upFilled > downFilled ? "up" : "down";
    const tokenId = side === "up" ? market.upTokenId : market.downTokenId;
    const fillPrice = side === "up" ? (actualFillPrices.up || upPrice) : (actualFillPrices.down || downPrice);
    log(`imbalance ${side}=${imbalance}; arming nuclear stop at ${(fillPrice - NUCLEAR_STOP_CENTS).toFixed(4)}`);
    attempt.nuclearStop = {
      side,
      tokenId,
      fillPrice,
      attemptedShares: imbalance,
      ...(await nuclearStopExit(clob.client, address, tokenId, fillPrice, imbalance)),
    };
    latest = await currentFilled(address, market, { up: beforeUp, down: beforeDown });
    upFilled = latest.filled.up;
    downFilled = latest.filled.down;
    imbalance = roundShares(Math.abs(upFilled - downFilled));
    attempt.afterNuclearStop = latest.balances;
    attempt.filledAfterNuclearStop = {
      up: upFilled,
      down: downFilled,
      matched: Math.min(upFilled, downFilled),
      imbalance,
      imbalanceSide: upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null,
    };
  }

  attempt.userWsAudit = userWsAudit.slice();
  appendJsonl(ATTEMPTS_PATH, attempt);
  const finalMatched = Math.min(upFilled, downFilled);
  log(`result filled up=${upFilled} down=${downFilled} matched=${finalMatched} imbalance=${imbalance}`);
  if (finalMatched > 0) log(`matched pair theoretical floor profit=${(finalMatched * (1 - pairCost)).toFixed(4)}`);
  userWs?.close();
}

installHttpKeepAlive();

(LOOP_MODE ? loopRepeatMain() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
