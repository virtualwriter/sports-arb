import { config } from "dotenv";
import WebSocket from "ws";

config({ path: "config.env" });
config({ path: ".env" });

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

type BookLevel = { price?: string | number; size?: string | number };
type BookResponse = { bids?: BookLevel[]; asks?: BookLevel[]; min_order_size?: string | number };
type ParsedLevel = { price: number; size: number };
type PriceLevels = { bids: Map<number, number>; asks: Map<number, number>; minOrderSize: number; updatedAtMs: number };
type Top = { bid: number; bidSize: number; ask: number; askSize: number; bids: ParsedLevel[]; asks: ParsedLevel[]; minOrderSize: number; updatedAtMs: number };

type TrackedMarket = {
  slug: string;
  title: string;
  conditionId: string;
  endDate: string | null;
  upTokenId: string;
  downTokenId: string;
};

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const MARKET_WS_URL = process.env.POLYMARKET_MARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const FETCH_TIMEOUT_MS = Number(process.env.UPDOWN_MARKET_WS_TEST_FETCH_TIMEOUT_MS ?? 8_000);
const TEST_MS = Number(process.env.UPDOWN_MARKET_WS_TEST_MS ?? 60_000);
const MAX_SECONDS_TO_END = Number(process.env.UPDOWN_MARKET_WS_TEST_MAX_SECONDS_TO_END ?? 300);
const MIN_SECONDS_TO_END = Number(process.env.UPDOWN_MARKET_WS_TEST_MIN_SECONDS_TO_END ?? 10);
const MAX_PAIR_COST = Number(process.env.UPDOWN_MARKET_WS_TEST_MAX_PAIR_COST ?? 0.999);
const PING_MS = Number(process.env.UPDOWN_MARKET_WS_TEST_PING_MS ?? 10_000);

const books = new Map<string, PriceLevels>();
let lastQuoteAtMs = 0;
let wsMessages = 0;
let bookSnapshots = 0;
let priceChangeMessages = 0;
let quoteEvents = 0;
let opportunities = 0;
let bestAskSum = Number.POSITIVE_INFINITY;
let maxQuoteGapMs = 0;
let connectedAtMs = 0;
let firstQuoteAtMs = 0;
let firstWsQuoteAtMs = 0;
let lastLoggedQuoteAtMs = 0;

function log(...args: unknown[]) {
  console.log(`[updown-market-ws-test ${new Date().toISOString()}]`, ...args);
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
      headers: { Accept: "application/json", "User-Agent": "updown-5m-market-ws-test/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function secondsToEnd(endDate: string | null): number | null {
  if (!endDate) return null;
  const ms = Date.parse(endDate);
  return Number.isFinite(ms) ? (ms - Date.now()) / 1000 : null;
}

function isUpDown5mSlug(slug: string): boolean {
  return /^[a-z0-9-]+-updown-5m-\d+$/.test(slug);
}

function trackedMarketFromEvent(event: GammaEvent): TrackedMarket | null {
  const slug = event.slug ?? "";
  if (!slug || !isUpDown5mSlug(slug) || event.closed || event.active === false) return null;
  if (!slug.includes("btc-updown-5m")) return null;
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
    conditionId: market.conditionId ?? "",
    endDate,
    upTokenId: tokenIds[upIndex],
    downTokenId: tokenIds[downIndex],
  };
}

async function discoverBtcMarket(): Promise<TrackedMarket | null> {
  const seen = new Map<string, TrackedMarket>();
  for (const tag of ["bitcoin", "crypto"]) {
    const events = await fetchJson<GammaEvent[]>(`${GAMMA_API}/events?${new URLSearchParams({
      active: "true",
      closed: "false",
      limit: "100",
      tag_slug: tag,
    })}`);
    for (const event of Array.isArray(events) ? events : []) {
      const tracked = trackedMarketFromEvent(event);
      if (tracked) seen.set(tracked.slug, tracked);
    }
  }
  return [...seen.values()].sort((a, b) => (secondsToEnd(a.endDate) ?? 0) - (secondsToEnd(b.endDate) ?? 0))[0] ?? null;
}

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

function toLevels(rows: unknown): ParsedLevel[] {
  return (Array.isArray(rows) ? rows : [])
    .map((level: any) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
}

function applySnapshot(tokenId: string, bids: ParsedLevel[], asks: ParsedLevel[], minOrderSize?: number) {
  const current = books.get(tokenId);
  const book = emptyLevels(minOrderSize ?? current?.minOrderSize ?? 5);
  for (const level of bids) book.bids.set(level.price, level.size);
  for (const level of asks) book.asks.set(level.price, level.size);
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
  const book = getCachedBook(tokenId);
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
    updatedAtMs: book.updatedAtMs,
  };
}

async function seedBook(tokenId: string) {
  const raw = await fetchJson<BookResponse>(`${CLOB_HOST}/book?${new URLSearchParams({ token_id: tokenId })}`);
  applySnapshot(tokenId, toLevels(raw.bids), toLevels(raw.asks), parseNumber(raw.min_order_size) || 5);
}

function quoteFromCache(market: TrackedMarket, source: string) {
  const up = topFromCachedBook(market.upTokenId);
  const down = topFromCachedBook(market.downTokenId);
  if (!(up.ask > 0) || !(down.ask > 0)) return;

  const now = Date.now();
  if (!firstQuoteAtMs) firstQuoteAtMs = now;
  if (source === "ws" && !firstWsQuoteAtMs) firstWsQuoteAtMs = now;
  if (lastQuoteAtMs) maxQuoteGapMs = Math.max(maxQuoteGapMs, now - lastQuoteAtMs);
  lastQuoteAtMs = now;
  quoteEvents += 1;

  const askSum = up.ask + down.ask;
  if (askSum < bestAskSum) bestAskSum = askSum;
  if (askSum < MAX_PAIR_COST) opportunities += 1;

  if (source !== "ws" || now - lastLoggedQuoteAtMs >= 1_000 || askSum < MAX_PAIR_COST) {
    lastLoggedQuoteAtMs = now;
    log(
      `quote source=${source} askSum=${askSum.toFixed(4)} bidSum=${(up.bid + down.bid).toFixed(4)}`,
      `up=${up.bid.toFixed(3)}/${up.ask.toFixed(3)}`,
      `down=${down.bid.toFixed(3)}/${down.ask.toFixed(3)}`,
      `ageMs=${Math.max(now - up.updatedAtMs, now - down.updatedAtMs)}`,
    );
  }
}

function handleMarketMessage(raw: WebSocket.RawData, market: TrackedMarket) {
  wsMessages += 1;
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages: any[] = Array.isArray(data) ? data : [data];
  let touched = false;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;
    if (eventType === "book" || (msg.asset_id && (msg.bids || msg.asks || msg.buys || msg.sells))) {
      const tokenId = String(msg.asset_id ?? "");
      if (tokenId !== market.upTokenId && tokenId !== market.downTokenId) continue;
      applySnapshot(tokenId, toLevels(msg.bids ?? msg.buys), toLevels(msg.asks ?? msg.sells));
      bookSnapshots += 1;
      touched = true;
      continue;
    }
    const changes: any[] = msg.price_changes ?? msg.changes ?? [];
    for (const change of changes) {
      const tokenId = String(change.asset_id ?? msg.asset_id ?? "");
      if (tokenId !== market.upTokenId && tokenId !== market.downTokenId) continue;
      applyLevelChange(tokenId, String(change.side ?? ""), parseNumber(change.price), parseNumber(change.size));
      priceChangeMessages += 1;
      touched = true;
    }
  }
  if (touched) quoteFromCache(market, "ws");
}

async function main() {
  const market = await discoverBtcMarket();
  if (!market) throw new Error("no active BTC 5m market found");
  log(`tracking ${market.slug} secondsToEnd=${secondsToEnd(market.endDate)?.toFixed(1) ?? "?"}`);

  await Promise.all([seedBook(market.upTokenId), seedBook(market.downTokenId)]);
  quoteFromCache(market, "seed");

  const ws = new WebSocket(MARKET_WS_URL);
  let ping: ReturnType<typeof setInterval> | undefined;
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TEST_MS);
    ws.on("open", () => {
      connectedAtMs = Date.now();
      log("market WS connected; subscribing BTC up/down tokens");
      ws.send(JSON.stringify({ assets_ids: [market.upTokenId, market.downTokenId], type: "market" }));
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_MS);
    });
    ws.on("message", (raw) => handleMarketMessage(raw, market));
    ws.on("error", (err) => log(`market WS error: ${err.message}`));
    ws.on("close", () => {
      if (ping) clearInterval(ping);
    });
    setTimeout(() => clearTimeout(timer), TEST_MS + 1_000);
  });

  await done;
  if (ping) clearInterval(ping);
  ws.close();
  log("summary", JSON.stringify({
    testMs: TEST_MS,
    connected: connectedAtMs > 0,
    firstWsQuoteDelayMs: connectedAtMs && firstWsQuoteAtMs ? firstWsQuoteAtMs - connectedAtMs : null,
    wsMessages,
    bookSnapshots,
    priceChangeMessages,
    quoteEvents,
    quotesPerSecond: Number((quoteEvents / (TEST_MS / 1000)).toFixed(2)),
    maxQuoteGapMs,
    bestAskSum: Number.isFinite(bestAskSum) ? Number(bestAskSum.toFixed(4)) : null,
    opportunities,
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
