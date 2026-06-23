import { join } from "node:path";
import { config } from "dotenv";
import WebSocket from "ws";

// Experimental Japan-only collector. Do not deploy this on the USA VPS hourly
// trader path without explicit operator approval. Live mode remains opt-in via
// UPDOWN_COLLECTOR_LIVE=1 and non-atomic execution requires
// UPDOWN_COLLECTOR_ALLOW_NON_ATOMIC_LIVE=1.
import {
  POLYMARKET_FUNDER_ADDRESS,
  assertOrderResponse,
  clobClient,
  orderId,
  postFakBuyBatch,
  postFakSell,
  reconcileTokenBalance,
  roundShares,
} from "./polymarket-real-monotonic-executor.js";
import { appendJsonl, writeJson } from "./lib/updown/persistence.js";

config({ path: "config.env" });
config({ path: ".env" });

type GammaMarket = {
  id?: string;
  question?: string;
  outcomes?: string;
  clobTokenIds?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
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
type BookResponse = {
  bids?: BookLevel[];
  asks?: BookLevel[];
  min_order_size?: string | number;
};

type TrackedMarket = {
  slug: string;
  title: string;
  marketId: string;
  endDate: string | null;
  upTokenId: string;
  downTokenId: string;
};

type Top = {
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  minOrderSize: number;
  updatedAtMs?: number;
};

type PriceLevels = {
  bids: Map<number, number>;
  asks: Map<number, number>;
  minOrderSize: number;
  updatedAtMs: number;
};

type LiveAttempt = {
  id: string;
  slug: string;
  title: string;
  marketId: string;
  observedAt?: string;
  createdAt: string;
  updatedAt: string;
  detectionLagMs?: number;
  refreshLatencyMs?: number;
  status: "skipped" | "submitted" | "matched" | "imbalance_flattened" | "imbalance_stranded" | "error";
  reason?: string;
  intendedShares: number;
  upPrice: number;
  downPrice: number;
  askSum: number;
  before?: { up: number; down: number };
  after?: { up: number; down: number };
  filled?: { up: number; down: number; matched: number; imbalance: number; imbalanceSide: "up" | "down" | null };
  orderIds?: { up?: string; down?: string };
  responses?: { up?: unknown; down?: unknown };
  emergencyFlatten?: {
    side: "up" | "down";
    tokenId: string;
    bid: number;
    attemptedShares: number;
    soldShares: number;
    response?: unknown;
    status: "sold" | "stranded" | "error";
    realizedEstimate: number;
  };
};

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const MARKET_WS_URL = process.env.POLYMARKET_MARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const DATA_DIR = process.env.UPDOWN_COLLECTOR_DATA_DIR ?? "data";
const OBS_PATH = process.env.UPDOWN_COLLECTOR_OBS_PATH ?? join(DATA_DIR, "updown-5m-book-observations.jsonl");
const OPP_PATH = process.env.UPDOWN_COLLECTOR_OPP_PATH ?? join(DATA_DIR, "updown-5m-book-opportunities.jsonl");
const SUMMARY_PATH = process.env.UPDOWN_COLLECTOR_SUMMARY_PATH ?? join(DATA_DIR, "updown-5m-book-summary.json");
const LIVE_ATTEMPTS_PATH = process.env.UPDOWN_COLLECTOR_LIVE_ATTEMPTS_PATH ?? join(DATA_DIR, "updown-5m-live-attempts.jsonl");
const POLL_MS = Number(process.env.UPDOWN_COLLECTOR_POLL_MS ?? 1_000);
const DISCOVERY_MS = Number(process.env.UPDOWN_COLLECTOR_DISCOVERY_MS ?? 30_000);
const FETCH_TIMEOUT_MS = Number(process.env.UPDOWN_COLLECTOR_FETCH_TIMEOUT_MS ?? 8_000);
const OPPORTUNITY_MAX_COST = Number(process.env.UPDOWN_COLLECTOR_OPPORTUNITY_MAX_COST ?? 0.999);
const MIN_SHARED_ASK_SIZE = Number(process.env.UPDOWN_COLLECTOR_MIN_SHARED_ASK_SIZE ?? 5);
const MIN_MARKETABLE_BUY_USD = Number(process.env.UPDOWN_COLLECTOR_MIN_MARKETABLE_BUY_USD ?? 1);
const DISCOVERY_LIMIT = Number(process.env.UPDOWN_COLLECTOR_DISCOVERY_LIMIT ?? 100);
const MAX_SECONDS_TO_END = Number(process.env.UPDOWN_COLLECTOR_MAX_SECONDS_TO_END ?? 15 * 60);
const USE_WS_CACHE = process.env.UPDOWN_COLLECTOR_USE_WS_CACHE !== "0";
const CACHE_MAX_AGE_MS = Number(process.env.UPDOWN_COLLECTOR_CACHE_MAX_AGE_MS ?? 500);
const PING_MS = Number(process.env.UPDOWN_COLLECTOR_WS_PING_MS ?? 10_000);
const RECONNECT_BASE_MS = Number(process.env.UPDOWN_COLLECTOR_WS_RECONNECT_BASE_MS ?? 1_000);
const RECONNECT_MAX_MS = Number(process.env.UPDOWN_COLLECTOR_WS_RECONNECT_MAX_MS ?? 30_000);
const LIVE = process.env.UPDOWN_COLLECTOR_LIVE === "1";
const ALLOW_NON_ATOMIC_LIVE = process.env.UPDOWN_COLLECTOR_ALLOW_NON_ATOMIC_LIVE === "1";
const FILL_WAIT_MS = Number(process.env.UPDOWN_COLLECTOR_FILL_WAIT_MS ?? 2_500);
const IMBALANCE_DUST_SHARES = Number(process.env.UPDOWN_COLLECTOR_IMBALANCE_DUST_SHARES ?? 0.01);
const OPPORTUNITY_LOG_THROTTLE_MS = Number(process.env.UPDOWN_COLLECTOR_OPPORTUNITY_LOG_THROTTLE_MS ?? 1_000);
const WRITE_ALL_OBSERVATIONS = process.env.UPDOWN_COLLECTOR_WRITE_ALL === "1";

// Polymarket CLOB batch submission is not an atomic basket fill. Only enable
// this when the operator explicitly accepts one-sided fill/flatten risk.
const LIVE_EXECUTION_SUPPORTED = ALLOW_NON_ATOMIC_LIVE;

function log(...args: unknown[]) {
  console.log(`[updown-collector ${new Date().toISOString()}]`, ...args);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attemptId(slug: string) {
  return `UPDOWN-${Date.now()}-${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

function persistAttempt(attempt: LiveAttempt) {
  appendJsonl(LIVE_ATTEMPTS_PATH, attempt);
}

function responseError(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const row = response as any;
  return String(row.errorMsg ?? row.error ?? "").trim();
}

function responseNumber(response: unknown, key: string): number {
  if (!response || typeof response !== "object") return 0;
  const parsed = Number((response as any)[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenShort(tokenId: string) {
  return `${tokenId.slice(0, 10)}...`;
}

let liveClient: Awaited<ReturnType<typeof clobClient>> | null = null;

async function getLiveClient() {
  if (!LIVE) return null;
  if (!liveClient) liveClient = await clobClient();
  return liveClient;
}

function reconcileAddress() {
  const signerAddress = liveClient?.signer.address;
  return POLYMARKET_FUNDER_ADDRESS ?? signerAddress;
}

const books = new Map<string, PriceLevels>();
const tokenToMarkets = new Map<string, Set<string>>();
let marketWs: WebSocket | null = null;
let subscribedTokenKey = "";
let shuttingDown = false;
let wsConnected = false;

function emptyLevels(minOrderSize = 5): PriceLevels {
  return { bids: new Map(), asks: new Map(), minOrderSize, updatedAtMs: 0 };
}

function getCachedBook(tokenId: string): PriceLevels {
  let book = books.get(tokenId);
  if (!book) {
    book = emptyLevels();
    books.set(tokenId, book);
  }
  return book;
}

function applySnapshot(tokenId: string, bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>, minOrderSize?: number) {
  const current = books.get(tokenId);
  const book = emptyLevels(minOrderSize ?? current?.minOrderSize ?? 5);
  for (const level of bids) if (level.price > 0 && level.size > 0) book.bids.set(level.price, level.size);
  for (const level of asks) if (level.price > 0 && level.size > 0) book.asks.set(level.price, level.size);
  book.updatedAtMs = Date.now();
  books.set(tokenId, book);
}

function applyLevelChange(tokenId: string, side: string, price: number, size: number) {
  if (!(price > 0)) return;
  const book = getCachedBook(tokenId);
  const lower = side.toLowerCase();
  const levels = lower === "buy" || lower === "bid" || lower === "bids" ? book.bids : book.asks;
  if (size > 0) levels.set(price, size);
  else levels.delete(price);
  book.updatedAtMs = Date.now();
}

function topFromCachedBook(tokenId: string): Top {
  const book = books.get(tokenId);
  if (!book) return { bid: 0, bidSize: 0, ask: 0, askSize: 0, minOrderSize: 5, updatedAtMs: 0 };
  let bid = 0;
  let bidSize = 0;
  for (const [price, size] of book.bids) {
    if (price > bid) {
      bid = price;
      bidSize = size;
    }
  }
  let ask = Number.POSITIVE_INFINITY;
  let askSize = 0;
  for (const [price, size] of book.asks) {
    if (price < ask) {
      ask = price;
      askSize = size;
    }
  }
  if (!Number.isFinite(ask)) ask = 0;
  return { bid, bidSize, ask, askSize, minOrderSize: book.minOrderSize || 5, updatedAtMs: book.updatedAtMs };
}

function cacheAgeMs(top: Top): number {
  return top.updatedAtMs ? Date.now() - top.updatedAtMs : Number.POSITIVE_INFINITY;
}

function requiredExecutableShares(up: Top, down: Top): number {
  const upNotional = up.ask > 0 ? Math.ceil(MIN_MARKETABLE_BUY_USD / up.ask) : Number.POSITIVE_INFINITY;
  const downNotional = down.ask > 0 ? Math.ceil(MIN_MARKETABLE_BUY_USD / down.ask) : Number.POSITIVE_INFINITY;
  return Math.max(
    MIN_SHARED_ASK_SIZE,
    up.minOrderSize,
    down.minOrderSize,
    upNotional,
    downNotional,
  );
}

function executableShares(sharedAskSize: number): number {
  // Integer shares avoid CLOB market-buy precision failures where maker amount
  // must round cleanly to cents. Price improvement can still overfill shares.
  return Math.floor(sharedAskSize);
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "polymarket-updown-collector/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
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

function topLevel(levels: BookLevel[] | undefined, side: "bid" | "ask"): { price: number; size: number } {
  const parsed = (levels ?? [])
    .map((level) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  if (!parsed.length) return { price: 0, size: 0 };
  return parsed.reduce((best, level) => side === "bid"
    ? (level.price > best.price ? level : best)
    : (level.price < best.price ? level : best));
}

function topFromBook(book: BookResponse): Top {
  const bid = topLevel(book.bids, "bid");
  const ask = topLevel(book.asks, "ask");
  const minOrderSize = parseNumber(book.min_order_size) || 5;
  return {
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    minOrderSize,
  };
}

function isUpDown5mSlug(slug: string): boolean {
  return /^[a-z0-9-]+-updown-5m-\d+$/.test(slug);
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
  if (endDate) {
    const endMs = Date.parse(endDate);
    if (Number.isFinite(endMs)) {
      const secondsToEnd = (endMs - Date.now()) / 1000;
      if (secondsToEnd <= 0 || secondsToEnd > MAX_SECONDS_TO_END) return null;
    }
  }
  return {
    slug,
    title: event.title ?? market.question ?? slug,
    marketId: String(market.id ?? ""),
    endDate,
    upTokenId: tokenIds[upIndex],
    downTokenId: tokenIds[downIndex],
  };
}

async function discoverMarkets(): Promise<TrackedMarket[]> {
  const bySlug = new Map<string, TrackedMarket>();
  const tagSlugs = (process.env.UPDOWN_COLLECTOR_TAGS ?? "crypto,bitcoin,ethereum,solana,xrp,dogecoin,bnb,hyperliquid")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  for (const tag of tagSlugs) {
    for (let offset = 0; offset < DISCOVERY_LIMIT; offset += 100) {
      const url = `${GAMMA_API}/events?${new URLSearchParams({
        active: "true",
        closed: "false",
        limit: "100",
        offset: String(offset),
        tag_slug: tag,
      })}`;
      let events: GammaEvent[] = [];
      try {
        events = await fetchJson<GammaEvent[]>(url);
      } catch (err: any) {
        log(`discovery tag=${tag} offset=${offset} failed: ${err?.message ?? String(err)}`);
        break;
      }
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        const tracked = trackedMarketFromEvent(event);
        if (tracked) bySlug.set(tracked.slug, tracked);
      }
      if (events.length < 100) break;
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function fetchTop(tokenId: string): Promise<Top> {
  const book = await fetchJson<BookResponse>(`${CLOB_HOST}/book?${new URLSearchParams({ token_id: tokenId })}`);
  return topFromBook(book);
}

async function seedBook(tokenId: string) {
  const raw = await fetchJson<BookResponse>(`${CLOB_HOST}/book?${new URLSearchParams({ token_id: tokenId })}`);
  const bids = (raw.bids ?? []).map((level) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  const asks = (raw.asks ?? []).map((level) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  applySnapshot(tokenId, bids, asks, parseNumber(raw.min_order_size) || 5);
}

function secondsToEnd(endDate: string | null): number | null {
  if (!endDate) return null;
  const endMs = Date.parse(endDate);
  return Number.isFinite(endMs) ? Math.round((endMs - Date.now()) / 1000) : null;
}

async function observe(market: TrackedMarket) {
  const startedMs = Date.now();
  const observedAt = new Date().toISOString();
  const [up, down] = await Promise.all([fetchTop(market.upTokenId), fetchTop(market.downTokenId)]);
  const fetchedAt = new Date().toISOString();
  if (!(up.ask > 0) || !(down.ask > 0)) return;
  const askSum = up.ask + down.ask;
  const sharedAskSize = Math.min(up.askSize, down.askSize);
  const requiredSize = requiredExecutableShares(up, down);
  const row = {
    observedAt,
    fetchedAt,
    observeLatencyMs: Date.now() - startedMs,
    slug: market.slug,
    title: market.title,
    marketId: market.marketId,
    endDate: market.endDate,
    secondsToEnd: secondsToEnd(market.endDate),
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
    up,
    down,
    askSum,
    bidSum: up.bid + down.bid,
    sharedAskSize,
    requiredSize,
    executableApprox: askSum <= OPPORTUNITY_MAX_COST && sharedAskSize >= requiredSize,
    grossEdgePerShare: 1 - askSum,
    grossEdgeAtTop: Math.max(0, 1 - askSum) * Math.min(sharedAskSize, requiredSize),
  };
  if (WRITE_ALL_OBSERVATIONS) appendJsonl(OBS_PATH, row);
  if (row.executableApprox || askSum < 1) appendJsonl(OPP_PATH, row);
  return row;
}

function observeCached(market: TrackedMarket, source: "ws" | "seed" | "cache") {
  const observedAt = new Date().toISOString();
  const up = topFromCachedBook(market.upTokenId);
  const down = topFromCachedBook(market.downTokenId);
  if (!(up.ask > 0) || !(down.ask > 0)) return;
  const maxCacheAgeMs = Math.max(cacheAgeMs(up), cacheAgeMs(down));
  if (maxCacheAgeMs > CACHE_MAX_AGE_MS) return;
  const askSum = up.ask + down.ask;
  const sharedAskSize = Math.min(up.askSize, down.askSize);
  const requiredSize = requiredExecutableShares(up, down);
  const row = {
    observedAt,
    fetchedAt: observedAt,
    observeLatencyMs: 0,
    source,
    wsConnected,
    maxCacheAgeMs,
    slug: market.slug,
    title: market.title,
    marketId: market.marketId,
    endDate: market.endDate,
    secondsToEnd: secondsToEnd(market.endDate),
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
    up,
    down,
    askSum,
    bidSum: up.bid + down.bid,
    sharedAskSize,
    requiredSize,
    executableApprox: askSum <= OPPORTUNITY_MAX_COST && sharedAskSize >= requiredSize,
    grossEdgePerShare: 1 - askSum,
    grossEdgeAtTop: Math.max(0, 1 - askSum) * Math.min(sharedAskSize, requiredSize),
  };
  if (WRITE_ALL_OBSERVATIONS) appendJsonl(OBS_PATH, row);
  if (row.executableApprox || askSum < 1) appendJsonl(OPP_PATH, row);
  return row;
}

const slugInFlight = new Set<string>();
const tokenInFlight = new Set<string>();
const lastOpportunityLogAt = new Map<string, number>();

async function refreshedExecutable(market: TrackedMarket): Promise<{ up: Top; down: Top; askSum: number; sharedAskSize: number; shares: number; reason?: string }> {
  const [up, down] = USE_WS_CACHE && wsConnected
    ? [topFromCachedBook(market.upTokenId), topFromCachedBook(market.downTokenId)]
    : await Promise.all([fetchTop(market.upTokenId), fetchTop(market.downTokenId)]);
  const maxAge = Math.max(cacheAgeMs(up), cacheAgeMs(down));
  const askSum = up.ask + down.ask;
  const sharedAskSize = Math.min(up.askSize, down.askSize);
  const requiredSize = requiredExecutableShares(up, down);
  const shares = executableShares(sharedAskSize);
  if (USE_WS_CACHE && wsConnected && maxAge > CACHE_MAX_AGE_MS) return { up, down, askSum, sharedAskSize, shares: 0, reason: `stale_cache ageMs=${Math.round(maxAge)}` };
  if (!(up.ask > 0) || !(down.ask > 0)) return { up, down, askSum, sharedAskSize, shares: 0, reason: "missing_ask" };
  if (askSum > OPPORTUNITY_MAX_COST) return { up, down, askSum, sharedAskSize, shares: 0, reason: `edge_gone askSum=${askSum.toFixed(4)}` };
  if (shares < requiredSize) return { up, down, askSum, sharedAskSize, shares, reason: `size_below_required shared=${sharedAskSize} required=${requiredSize}` };
  return { up, down, askSum, sharedAskSize, shares };
}

async function emergencyFlatten(
  attempt: LiveAttempt,
  side: "up" | "down",
  tokenId: string,
  fillPrice: number,
  shares: number,
): Promise<NonNullable<LiveAttempt["emergencyFlatten"]>> {
  const client = await getLiveClient();
  if (!client) throw new Error("live client unavailable");
  const top = await fetchTop(tokenId);
  const bid = top.bid;
  if (!(bid > 0)) {
    return {
      side,
      tokenId,
      bid,
      attemptedShares: shares,
      soldShares: 0,
      status: "stranded",
      realizedEstimate: 0,
    };
  }

  const address = reconcileAddress();
  if (!address) throw new Error("missing reconcile address");
  const before = await reconcileTokenBalance(address, tokenId);
  let response: unknown;
  let status: "sold" | "stranded" | "error" = "error";
  try {
    response = await postFakSell(client.client, tokenId, bid, shares);
    assertOrderResponse(response, "updown_emergency_flatten");
  } catch (err: any) {
    response = { error: err?.message ?? String(err) };
  }
  await sleep(FILL_WAIT_MS);
  const after = await reconcileTokenBalance(address, tokenId);
  const reconciledSold = roundShares(before - after);
  const responseSold = responseNumber(response, "makingAmount");
  const soldShares = roundShares(Math.max(reconciledSold, responseSold));
  const residual = roundShares(shares - soldShares);
  if (soldShares > 0 && residual < IMBALANCE_DUST_SHARES) status = "sold";
  else if (soldShares > 0 || !responseError(response)) status = "stranded";
  const realizedEstimate = soldShares * (bid - fillPrice);
  log(`LIVE ${attempt.id} emergency_flatten side=${side} token=${tokenShort(tokenId)} bid=${bid.toFixed(4)} sold=${soldShares} residual=${residual} realized=${realizedEstimate.toFixed(4)}`);
  return {
    side,
    tokenId,
    bid,
    attemptedShares: shares,
    soldShares,
    response,
    status,
    realizedEstimate,
  };
}

async function executeLive(market: TrackedMarket, observation: { observedAt?: string; askSum: number }) {
  if (!LIVE) return;
  if (!LIVE_EXECUTION_SUPPORTED) {
    const createdAt = new Date().toISOString();
    const observedMs = observation.observedAt ? Date.parse(observation.observedAt) : NaN;
    persistAttempt({
      id: attemptId(market.slug),
      slug: market.slug,
      title: market.title,
      marketId: market.marketId,
      observedAt: observation.observedAt,
      createdAt,
      updatedAt: createdAt,
      detectionLagMs: Number.isFinite(observedMs) ? Date.parse(createdAt) - observedMs : undefined,
      status: "skipped",
      reason: "non_atomic_clob_execution_disabled",
      intendedShares: 0,
      upPrice: 0,
      downPrice: 0,
      askSum: observation.askSum,
    });
    return;
  }
  if (slugInFlight.has(market.slug) || tokenInFlight.has(market.upTokenId) || tokenInFlight.has(market.downTokenId)) return;
  slugInFlight.add(market.slug);
  tokenInFlight.add(market.upTokenId);
  tokenInFlight.add(market.downTokenId);
  const createdAt = new Date().toISOString();
  const observedMs = observation.observedAt ? Date.parse(observation.observedAt) : NaN;
  let attempt: LiveAttempt | null = null;
  try {
    const client = await getLiveClient();
    if (!client) throw new Error("live client unavailable");
    const address = reconcileAddress();
    if (!address) throw new Error("missing reconcile address");

    const refreshStartedMs = Date.now();
    const refreshed = await refreshedExecutable(market);
    const refreshLatencyMs = Date.now() - refreshStartedMs;
    attempt = {
      id: attemptId(market.slug),
      slug: market.slug,
      title: market.title,
      marketId: market.marketId,
      observedAt: observation.observedAt,
      createdAt,
      updatedAt: createdAt,
      detectionLagMs: Number.isFinite(observedMs) ? Date.parse(createdAt) - observedMs : undefined,
      refreshLatencyMs,
      status: refreshed.reason ? "skipped" : "submitted",
      reason: refreshed.reason,
      intendedShares: refreshed.shares,
      upPrice: refreshed.up.ask,
      downPrice: refreshed.down.ask,
      askSum: refreshed.askSum,
    };
    if (refreshed.reason) {
      persistAttempt(attempt);
      log(`LIVE skip ${market.slug}: ${refreshed.reason} observedAskSum=${observation.askSum.toFixed(4)} detectionLagMs=${attempt.detectionLagMs ?? "n/a"} refreshLatencyMs=${refreshLatencyMs}`);
      return;
    }

    const [upBefore, downBefore] = await Promise.all([
      reconcileTokenBalance(address, market.upTokenId),
      reconcileTokenBalance(address, market.downTokenId),
    ]);
    attempt.before = { up: upBefore, down: downBefore };
    log(`LIVE submit ${attempt.id} ${market.slug} shares=${refreshed.shares} up=${refreshed.up.ask.toFixed(4)} down=${refreshed.down.ask.toFixed(4)} askSum=${refreshed.askSum.toFixed(4)}`);

    let responses: unknown[] = [];
    try {
      responses = await postFakBuyBatch(client.client, [
        { tokenId: market.upTokenId, price: refreshed.up.ask, shares: refreshed.shares },
        { tokenId: market.downTokenId, price: refreshed.down.ask, shares: refreshed.shares },
      ]);
      assertOrderResponse(responses[0], "updown_up");
      assertOrderResponse(responses[1], "updown_down");
    } catch (err: any) {
      if (!responses.length) responses = [{ error: err?.message ?? String(err) }, { error: err?.message ?? String(err) }];
      attempt.reason = err?.message ?? String(err);
    }
    attempt.responses = { up: responses[0], down: responses[1] };
    attempt.orderIds = { up: orderId(responses[0]), down: orderId(responses[1]) };

    await sleep(FILL_WAIT_MS);
    const [upAfter, downAfter] = await Promise.all([
      reconcileTokenBalance(address, market.upTokenId),
      reconcileTokenBalance(address, market.downTokenId),
    ]);
    attempt.after = { up: upAfter, down: downAfter };
    const upFilled = roundShares(upAfter - upBefore);
    const downFilled = roundShares(downAfter - downBefore);
    const matched = roundShares(Math.min(upFilled, downFilled));
    const imbalance = roundShares(Math.abs(upFilled - downFilled));
    const imbalanceSide: "up" | "down" | null = upFilled > downFilled ? "up" : downFilled > upFilled ? "down" : null;
    attempt.filled = { up: upFilled, down: downFilled, matched, imbalance, imbalanceSide };

    if (matched > 0 && imbalance < IMBALANCE_DUST_SHARES) {
      attempt.status = "matched";
    } else if (imbalanceSide && imbalance >= IMBALANCE_DUST_SHARES) {
      const tokenId = imbalanceSide === "up" ? market.upTokenId : market.downTokenId;
      const fillPrice = imbalanceSide === "up" ? refreshed.up.ask : refreshed.down.ask;
      const flatten = await emergencyFlatten(attempt, imbalanceSide, tokenId, fillPrice, imbalance);
      attempt.emergencyFlatten = flatten;
      attempt.status = flatten.status === "sold" ? "imbalance_flattened" : "imbalance_stranded";
    } else {
      attempt.status = matched > 0 ? "matched" : "error";
      if (!attempt.reason) attempt.reason = "no_fill";
    }
    attempt.updatedAt = new Date().toISOString();
    persistAttempt(attempt);
    log(`LIVE result ${attempt.id} status=${attempt.status} upFilled=${upFilled} downFilled=${downFilled} matched=${matched} imbalance=${imbalance}`);
  } catch (err: any) {
    const now = new Date().toISOString();
    const failed: LiveAttempt = attempt ?? {
      id: attemptId(market.slug),
      slug: market.slug,
      title: market.title,
      marketId: market.marketId,
      createdAt,
      updatedAt: now,
      status: "error",
      intendedShares: 0,
      upPrice: 0,
      downPrice: 0,
      askSum: observation.askSum,
    };
    failed.status = "error";
    failed.reason = err?.message ?? String(err);
    failed.updatedAt = now;
    persistAttempt(failed);
    log(`LIVE error ${market.slug}: ${failed.reason}`);
  } finally {
    slugInFlight.delete(market.slug);
    tokenInFlight.delete(market.upTokenId);
    tokenInFlight.delete(market.downTokenId);
  }
}

function activeMarketForSlug(slug: string): TrackedMarket | undefined {
  const market = markets.find((candidate) => candidate.slug === slug);
  if (!market) return undefined;
  const end = secondsToEnd(market.endDate);
  return end === null || end > 0 ? market : undefined;
}

function evaluateMarket(market: TrackedMarket, source: "ws" | "seed" | "cache") {
  const row = observeCached(market, source);
  if (!row) return;
  observations += 1;
  if (row.askSum < bestAskSum) {
    bestAskSum = row.askSum;
    best = row;
  }
  if (row.executableApprox) {
    opportunities += 1;
    const now = Date.now();
    const last = lastOpportunityLogAt.get(market.slug) ?? 0;
    if (now - last >= OPPORTUNITY_LOG_THROTTLE_MS) {
      lastOpportunityLogAt.set(market.slug, now);
      log(`OPPORTUNITY ${market.slug} askSum=${row.askSum.toFixed(4)} size=${row.sharedAskSize.toFixed(2)} edge=${(row.grossEdgePerShare * 100).toFixed(2)}c source=${source} cacheAgeMs=${Math.round(row.maxCacheAgeMs)}`);
      void executeLive(market, row);
    }
  }
}

function evaluateToken(tokenId: string, source: "ws" | "seed" | "cache") {
  const slugs = tokenToMarkets.get(tokenId);
  if (!slugs) return;
  for (const slug of slugs) {
    const market = activeMarketForSlug(slug);
    if (market) evaluateMarket(market, source);
  }
}

function handleMarketMessage(raw: WebSocket.RawData) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages: any[] = Array.isArray(data) ? data : [data];
  const touched = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;
    if (eventType === "book" || (msg.asset_id && (msg.bids || msg.asks || msg.buys || msg.sells))) {
      const tokenId = String(msg.asset_id ?? "");
      if (!tokenId) continue;
      const toLevels = (rows: any) => (Array.isArray(rows) ? rows : [])
        .map((level: any) => ({ price: Number(level.price), size: Number(level.size) }))
        .filter((level: any) => Number.isFinite(level.price) && Number.isFinite(level.size));
      applySnapshot(tokenId, toLevels(msg.bids ?? msg.buys), toLevels(msg.asks ?? msg.sells));
      touched.add(tokenId);
      continue;
    }
    const changes: any[] = msg.price_changes ?? msg.changes ?? [];
    for (const change of changes) {
      const tokenId = String(change.asset_id ?? msg.asset_id ?? "");
      if (!tokenId) continue;
      applyLevelChange(tokenId, String(change.side ?? ""), Number(change.price), Number(change.size));
      touched.add(tokenId);
    }
  }
  for (const tokenId of touched) evaluateToken(tokenId, "ws");
}

async function seedBooks(tokens: string[]) {
  await Promise.all(tokens.map(async (tokenId) => {
    try {
      await seedBook(tokenId);
      evaluateToken(tokenId, "seed");
    } catch (err: any) {
      log(`seed ${tokenShort(tokenId)} failed: ${err?.message ?? String(err)}`);
    }
  }));
}

function watchedTokens(): string[] {
  const tokens = new Set<string>();
  for (const market of markets) {
    const end = secondsToEnd(market.endDate);
    if (end !== null && end <= 0) continue;
    tokens.add(market.upTokenId);
    tokens.add(market.downTokenId);
  }
  return [...tokens].sort();
}

function rebuildTokenIndex() {
  tokenToMarkets.clear();
  for (const market of markets) {
    for (const tokenId of [market.upTokenId, market.downTokenId]) {
      let set = tokenToMarkets.get(tokenId);
      if (!set) {
        set = new Set();
        tokenToMarkets.set(tokenId, set);
      }
      set.add(market.slug);
    }
  }
}

function connectMarketWs(attempt = 0) {
  if (shuttingDown || !USE_WS_CACHE) return;
  const tokens = watchedTokens();
  if (!tokens.length) return;
  const tokenKey = tokens.join(",");
  subscribedTokenKey = tokenKey;
  const ws = new WebSocket(MARKET_WS_URL);
  marketWs = ws;
  let ping: ReturnType<typeof setInterval> | undefined;
  let healthy = false;
  ws.on("open", () => {
    healthy = true;
    wsConnected = true;
    log(`market WS connected; subscribing ${tokens.length} updown tokens`);
    ws.send(JSON.stringify({ assets_ids: tokens, type: "market" }));
    ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, PING_MS);
    void seedBooks(tokens);
  });
  ws.on("message", (raw) => handleMarketMessage(raw));
  ws.on("error", (err) => log(`market WS error: ${err.message}`));
  ws.on("close", () => {
    if (ping) clearInterval(ping);
    if (marketWs !== ws) return;
    marketWs = null;
    wsConnected = false;
    if (shuttingDown) return;
    const nextAttempt = healthy ? 0 : attempt + 1;
    const delay = healthy ? RECONNECT_BASE_MS : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    log(`market WS closed; reconnecting in ${delay}ms`);
    setTimeout(() => connectMarketWs(nextAttempt), delay);
  });
}

function refreshMarketWsSubscription() {
  if (!USE_WS_CACHE) return;
  const tokens = watchedTokens();
  const tokenKey = tokens.join(",");
  if (!tokens.length) return;
  if (marketWs && subscribedTokenKey === tokenKey && marketWs.readyState === WebSocket.OPEN) return;
  if (marketWs) {
    try { marketWs.close(); } catch { /* ignore */ }
  }
  connectMarketWs(0);
}

let markets: TrackedMarket[] = [];
let lastDiscoveryAt = 0;
let observations = 0;
let opportunities = 0;
let bestAskSum = Number.POSITIVE_INFINITY;
let best: unknown = null;
let tickInFlight = false;

async function refreshDiscovery(force = false) {
  if (!force && Date.now() - lastDiscoveryAt < DISCOVERY_MS) return;
  markets = await discoverMarkets();
  rebuildTokenIndex();
  lastDiscoveryAt = Date.now();
  log(`discovered ${markets.length} active updown-5m markets`);
  refreshMarketWsSubscription();
}

async function tick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await refreshDiscovery();
    const active = markets.filter((market) => {
      const end = secondsToEnd(market.endDate);
      return end === null || end > 0;
    });
    if (USE_WS_CACHE) {
      for (const market of active) evaluateMarket(market, "cache");
      writeJson(SUMMARY_PATH, {
        updatedAt: new Date().toISOString(),
        marketCount: active.length,
        observations,
        opportunities,
        bestAskSum: Number.isFinite(bestAskSum) ? bestAskSum : null,
        best,
        config: {
          pollMs: POLL_MS,
          discoveryMs: DISCOVERY_MS,
          opportunityMaxCost: OPPORTUNITY_MAX_COST,
          minSharedAskSize: MIN_SHARED_ASK_SIZE,
          writeAllObservations: WRITE_ALL_OBSERVATIONS,
          live: LIVE,
          allowNonAtomicLive: ALLOW_NON_ATOMIC_LIVE,
          liveExecutionSupported: LIVE_EXECUTION_SUPPORTED,
          minMarketableBuyUsd: MIN_MARKETABLE_BUY_USD,
          fillWaitMs: FILL_WAIT_MS,
          imbalanceDustShares: IMBALANCE_DUST_SHARES,
          useWsCache: USE_WS_CACHE,
          cacheMaxAgeMs: CACHE_MAX_AGE_MS,
          wsConnected,
        },
      });
      return;
    }
    await Promise.all(active.map(async (market) => {
      try {
        const row = await observe(market);
        if (!row) return;
        observations += 1;
        if (row.askSum < bestAskSum) {
          bestAskSum = row.askSum;
          best = row;
        }
        if (row.executableApprox) {
          opportunities += 1;
          log(`OPPORTUNITY ${market.slug} askSum=${row.askSum.toFixed(4)} size=${row.sharedAskSize.toFixed(2)} edge=${(row.grossEdgePerShare * 100).toFixed(2)}c observeLatencyMs=${row.observeLatencyMs}`);
          void executeLive(market, row);
        }
      } catch (err: any) {
        log(`observe ${market.slug} failed: ${err?.message ?? String(err)}`);
      }
    }));
    writeJson(SUMMARY_PATH, {
      updatedAt: new Date().toISOString(),
      marketCount: active.length,
      observations,
      opportunities,
      bestAskSum: Number.isFinite(bestAskSum) ? bestAskSum : null,
      best,
      config: {
        pollMs: POLL_MS,
        discoveryMs: DISCOVERY_MS,
        opportunityMaxCost: OPPORTUNITY_MAX_COST,
        minSharedAskSize: MIN_SHARED_ASK_SIZE,
        writeAllObservations: WRITE_ALL_OBSERVATIONS,
        live: LIVE,
        allowNonAtomicLive: ALLOW_NON_ATOMIC_LIVE,
        liveExecutionSupported: LIVE_EXECUTION_SUPPORTED,
        minMarketableBuyUsd: MIN_MARKETABLE_BUY_USD,
        fillWaitMs: FILL_WAIT_MS,
        imbalanceDustShares: IMBALANCE_DUST_SHARES,
        useWsCache: USE_WS_CACHE,
        cacheMaxAgeMs: CACHE_MAX_AGE_MS,
        wsConnected,
      },
    });
  } finally {
    tickInFlight = false;
  }
}

async function main() {
  log(`starting pollMs=${POLL_MS} opportunityMaxCost=${OPPORTUNITY_MAX_COST} minSize=${MIN_SHARED_ASK_SIZE} minBuyUsd=${MIN_MARKETABLE_BUY_USD} live=${LIVE ? "1" : "0"} allowNonAtomicLive=${ALLOW_NON_ATOMIC_LIVE ? "1" : "0"} liveExecutionSupported=${LIVE_EXECUTION_SUPPORTED ? "1" : "0"} wsCache=${USE_WS_CACHE ? "1" : "0"}`);
  if (LIVE) await getLiveClient();
  await refreshDiscovery(true);
  await tick();
  setInterval(() => { void tick(); }, POLL_MS);
}

process.on("SIGINT", () => {
  shuttingDown = true;
  try { marketWs?.close(); } catch { /* ignore */ }
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  try { marketWs?.close(); } catch { /* ignore */ }
  process.exit(0);
});

void main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exit(1);
});
