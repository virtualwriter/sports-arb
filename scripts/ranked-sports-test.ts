import {
  appendJsonArray,
  assertOrderResponse,
  clobClient,
  orderId,
  packageRecord,
  POLYMARKET_FUNDER_ADDRESS,
  postFakBuy,
  postFakSell,
  precisionSafeBuyShares,
  proxyCollateralProbe,
  readJsonArray,
  reconcileTokenBalance,
  roundShares,
  ORDERS_PATH,
  PACKAGES_PATH,
  writeJsonArray,
} from "./polymarket-real-monotonic-executor.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import WebSocket from "ws";

type Direction = "above" | "below";
type Book = { tokenId: string; bid: number; bidSize: number; ask: number; askSize: number; spread: number; minOrderSize: number };
type Quote = {
  eventSlug: string;
  eventTitle: string;
  marketId: string;
  ladderKey: string;
  question: string;
  description: string;
  resolutionSource: string;
  strike: number;
  direction: Direction;
  startDate: string | null;
  endDate: string | null;
  liquidity: number;
  yesTokenId: string;
  noTokenId: string;
  yesBook: Book;
  noBook: Book;
};
type Candidate = {
  foundAt: string;
  asset: string;
  eventSlug: string;
  eventTitle: string;
  packageId: string;
  direction: Direction;
  broad: Quote;
  narrow: Quote;
  packageCost: number;
  lockedEdge: number;
  availableSize: number;
  maxSpread: number;
  minLiquidity: number;
  jackpotPayoutPerShare: number;
  eligible: boolean;
  rejectionReasons: string[];
};

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_API = process.env.CLOB_API_URL ?? process.env.CLOB_URL ?? "https://clob.polymarket.com";
const USER_AGENT = "ranked-sports-test/1.0";
const MARKET_WS_URL = process.env.POLYMARKET_MARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const MIN_PACKAGE_COST = Number(process.env.RANKED_SPORTS_MIN_PACKAGE_COST ?? 0);
const MAX_PACKAGE_COST = Number(process.env.RANKED_SPORTS_MAX_PACKAGE_COST ?? 1.12);
const MAX_EXECUTIONS = Math.max(0, Number(process.env.RANKED_SPORTS_MAX_EXECUTIONS ?? 5));
const TEST_RESULTS_PATH = process.env.RANKED_SPORTS_TEST_RESULTS_PATH
  ?? join(dirname(PACKAGES_PATH), "ranked-sports-test-results.jsonl");
const MAX_PAIRED_SHARES = Number(process.env.ARB_DAEMON_SPORTS_MAX_PAIRED_SHARES ?? 10);
const MAX_SPREAD = Number(process.env.ARB_DAEMON_SPORTS_MAX_SPREAD ?? 0.04);
const MIN_MARKETABLE_BUY_USD = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_MARKETABLE_BUY_USD ?? 1);
const EVENT_CAP_USD = Number(process.env.RANKED_SPORTS_MAX_EVENT_USD ?? 12);
const MAX_PACKAGE_USD = Number(process.env.RANKED_SPORTS_MAX_PACKAGE_USD ?? EVENT_CAP_USD);
const BALANCE_HEADROOM_USD = Number(process.env.RANKED_SPORTS_BALANCE_HEADROOM_USD ?? 0.5);
const DISCOVERY_LIMIT = Number(process.env.RANKED_SPORTS_DISCOVERY_LIMIT ?? 500);
const MAX_DISCOVERED_EVENTS = Number(process.env.RANKED_SPORTS_MAX_EVENTS ?? 25);
const MAX_STRUCTURAL_CANDIDATES = Number(process.env.RANKED_SPORTS_MAX_STRUCTURAL_CANDIDATES ?? 300);
const ONLY_CONFIGURED_SLUGS = process.env.RANKED_SPORTS_ONLY_CONFIGURED === "1";
const ADJACENT_ONLY = process.env.RANKED_SPORTS_ADJACENT_ONLY !== "0";
const PACKAGE_SPECS = (process.env.RANKED_SPORTS_PACKAGE_SPECS ?? "").split(",").map((spec) => spec.trim()).filter(Boolean);
const SIZE_MODE = process.env.RANKED_SPORTS_SIZE_MODE ?? "min_valid";
const SORT_BY = process.env.RANKED_SPORTS_SORT_BY ?? "pair_cost";
const USE_WS_BOOKS = process.env.RANKED_SPORTS_BOOK_SOURCE !== "rest";
const WS_WARMUP_MS = Number(process.env.RANKED_SPORTS_WS_WARMUP_MS ?? 15_000);
const WS_REST_FALLBACK_LIMIT = Number(process.env.RANKED_SPORTS_WS_REST_FALLBACK_LIMIT ?? 60);
const DRY_RUN = process.env.RANKED_SPORTS_DRY_RUN === "1" || process.argv.includes("--dry-run");
const APPLY_EVENT_CAP = Number.isFinite(EVENT_CAP_USD) && EVENT_CAP_USD > 0;
const APPLY_PACKAGE_USD_CAP = Number.isFinite(MAX_PACKAGE_USD) && MAX_PACKAGE_USD > 0;
const APPLY_MIN_PACKAGE_COST = Number.isFinite(MIN_PACKAGE_COST) && MIN_PACKAGE_COST > 0;

type AttemptOutcome =
  | "preflight_rejected"
  | "sizing_failed"
  | "submit_rejected"
  | "no_fill"
  | "partial_orphan"
  | "clean_paired_fill";

type AttemptRecord = {
  runAt: string;
  bucket: string;
  eventSlug: string;
  eventTitle: string;
  packageId: string;
  packageLabel: string;
  gameStart: string;
  wsCost: number | null;
  freshCost: number | null;
  submittedBroadPrice: number | null;
  submittedNarrowPrice: number | null;
  filledBroadPrice: number | null;
  filledNarrowPrice: number | null;
  sharesRequested: number;
  sharesMatched: number;
  actualPairCost: number | null;
  inBucket: boolean | null;
  outcome: AttemptOutcome;
  preflightPassed: boolean;
  sizingPassed: boolean;
  bothLegsSubmitted: boolean;
  bothLegsFilled: boolean;
  submitLatencyMs: number | null;
  blocker: string;
};

function inCostBucket(cost: number): boolean {
  if (!(cost > 0)) return false;
  if (APPLY_MIN_PACKAGE_COST && cost + 1e-9 < MIN_PACKAGE_COST) return false;
  if (cost > MAX_PACKAGE_COST + 1e-9) return false;
  return true;
}

function bucketLabel(): string {
  const lo = APPLY_MIN_PACKAGE_COST ? MIN_PACKAGE_COST.toFixed(3) : "<min";
  return `${lo}-${MAX_PACKAGE_COST.toFixed(3)}`;
}

function packageLabel(candidate: Candidate): string {
  return `Over ${candidate.broad.strike} + Under ${candidate.narrow.strike}`;
}

function appendAttempt(record: AttemptRecord) {
  mkdirSync(dirname(TEST_RESULTS_PATH), { recursive: true });
  appendFileSync(TEST_RESULTS_PATH, `${JSON.stringify(record)}\n`);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

function decimalParts(value: number): { intValue: number; scale: number } {
  const normalized = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const [whole, fractional = ""] = normalized.split(".");
  return {
    intValue: Number(`${whole}${fractional}`),
    scale: 10 ** fractional.length,
  };
}

function marketBuyShareStep(price: number): number {
  if (!(price > 0)) return Number.POSITIVE_INFINITY;
  const { intValue, scale } = decimalParts(price);
  // CLOB market buys require taker shares <= 5 decimals and maker dollars <= 2 decimals.
  const denominator = scale * 1_000;
  return denominator / gcd(intValue, denominator);
}

function pairedMarketBuyShareStep(firstPrice: number, secondPrice: number): number {
  const firstStep = marketBuyShareStep(firstPrice);
  const secondStep = marketBuyShareStep(secondPrice);
  if (!Number.isFinite(firstStep) || !Number.isFinite(secondStep)) return Number.POSITIVE_INFINITY;
  return lcm(firstStep, secondStep) / 100_000;
}

function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || !(step > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil((value / step) - 1e-9) * step;
}

function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(step) || !(step > 0)) return 0;
  return Math.floor((value / step) + 1e-9) * step;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bestLevel(levels: any[], side: "bid" | "ask"): { price: number; size: number } {
  const rows = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0);
  if (!rows.length) return { price: 0, size: 0 };
  return rows.reduce((best, level) => side === "bid"
    ? level.price > best.price ? level : best
    : level.price < best.price ? level : best);
}

const bookCache = new Map<string, Book>();
type PriceLevels = { bids: Map<number, number>; asks: Map<number, number> };
const wsBooks = new Map<string, PriceLevels>();

function emptyLevels(): PriceLevels {
  return { bids: new Map(), asks: new Map() };
}

function levelsFor(tokenId: string): PriceLevels {
  let levels = wsBooks.get(tokenId);
  if (!levels) {
    levels = emptyLevels();
    wsBooks.set(tokenId, levels);
  }
  return levels;
}

function setSide(levels: Map<number, number>, price: number, size: number) {
  if (!Number.isFinite(price) || !Number.isFinite(size)) return;
  if (size <= 0) levels.delete(price);
  else levels.set(price, size);
}

function applySnapshot(tokenId: string, bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>) {
  const levels = levelsFor(tokenId);
  levels.bids.clear();
  levels.asks.clear();
  for (const bid of bids) setSide(levels.bids, bid.price, bid.size);
  for (const ask of asks) setSide(levels.asks, ask.price, ask.size);
}

function applyLevelChange(tokenId: string, side: string, price: number, size: number) {
  const levels = levelsFor(tokenId);
  const normalized = side.toLowerCase();
  if (normalized.includes("buy") || normalized.includes("bid")) setSide(levels.bids, price, size);
  if (normalized.includes("sell") || normalized.includes("ask")) setSide(levels.asks, price, size);
}

function topOfWsBook(tokenId: string): Book {
  const levels = levelsFor(tokenId);
  let bid = 0;
  let bidSize = 0;
  for (const [price, size] of levels.bids) {
    if (price > bid) {
      bid = price;
      bidSize = size;
    }
  }
  let ask = Number.POSITIVE_INFINITY;
  let askSize = 0;
  for (const [price, size] of levels.asks) {
    if (price < ask) {
      ask = price;
      askSize = size;
    }
  }
  if (!Number.isFinite(ask)) ask = 0;
  return {
    tokenId,
    bid,
    bidSize,
    ask,
    askSize,
    spread: bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 0,
    minOrderSize: 5,
  };
}

function parseBookRows(rows: any): Array<{ price: number; size: number }> {
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.size));
}

function handleWsMessage(raw: WebSocket.RawData) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages = Array.isArray(data) ? data : [data];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;
    if (eventType === "book" || (msg.asset_id && (msg.bids || msg.asks || msg.buys || msg.sells))) {
      const tokenId = msg.asset_id;
      if (tokenId) applySnapshot(tokenId, parseBookRows(msg.bids ?? msg.buys), parseBookRows(msg.asks ?? msg.sells));
      continue;
    }
    for (const change of msg.price_changes ?? msg.changes ?? []) {
      const tokenId = change.asset_id ?? msg.asset_id;
      if (tokenId) applyLevelChange(tokenId, String(change.side ?? ""), Number(change.price), Number(change.size));
    }
  }
}

async function warmWsBooks(tokens: string[]): Promise<void> {
  const unique = [...new Set(tokens)].filter(Boolean);
  if (!unique.length) return;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(MARKET_WS_URL);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(finish, WS_WARMUP_MS);
    ws.on("open", () => {
      ws.send(JSON.stringify({ assets_ids: unique, type: "market" }));
    });
    ws.on("message", (raw) => handleWsMessage(raw));
    ws.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    ws.on("close", finish);
  });
}

async function fetchBook(tokenId: string): Promise<Book> {
  const cached = bookCache.get(tokenId);
  if (cached) return cached;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) await sleep(1_500 * attempt);
      else await sleep(Number(process.env.RANKED_SPORTS_BOOK_DELAY_MS ?? 125));
      const book = await fetchJson(`${CLOB_API}/book?${new URLSearchParams({ token_id: tokenId })}`);
      const bid = bestLevel(book.bids, "bid");
      const ask = bestLevel(book.asks, "ask");
      const parsed = {
        tokenId,
        bid: bid.price,
        bidSize: bid.size,
        ask: ask.price,
        askSize: ask.size,
        spread: bid.price > 0 && ask.price > 0 ? Math.max(0, ask.price - bid.price) : 0,
        minOrderSize: Math.max(5, parseNumber(book.min_order_size)),
      };
      bookCache.set(tokenId, parsed);
      return parsed;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function fetchBookOld(tokenId: string): Promise<Book> {
  const book = await fetchJson(`${CLOB_API}/book?${new URLSearchParams({ token_id: tokenId })}`);
  const bid = bestLevel(book.bids, "bid");
  const ask = bestLevel(book.asks, "ask");
  return {
    tokenId,
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    spread: bid.price > 0 && ask.price > 0 ? Math.max(0, ask.price - bid.price) : 0,
    minOrderSize: Math.max(5, parseNumber(book.min_order_size)),
  };
}

function sportKind(slug: string): "MLB" | "NBA" | "SOCCER" | null {
  if (slug.startsWith("mlb-")) return "MLB";
  if (slug.startsWith("nba-")) return "NBA";
  if (slug.startsWith("fifwc-") || slug.startsWith("mls-") || slug.includes("soccer") || slug.includes("fifa") || slug.includes("uefa")) return "SOCCER";
  return null;
}

function parseSportsMarket(eventSlug: string, question: string, outcomes: string[]) {
  const sport = sportKind(eventSlug);
  if (!sport) return null;
  const normalized = outcomes.map((outcome) => outcome.trim().toLowerCase());
  const outcomeIndexes = () => {
    const yesIndex = normalized.findIndex((outcome) => outcome === "yes" || outcome === "over");
    const noIndex = normalized.findIndex((outcome) => outcome === "no" || outcome === "under");
    return yesIndex >= 0 && noIndex >= 0 ? { yesIndex, noIndex } : null;
  };
  const teamKey = (team: string) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const scopeKey = (scope?: string) => {
    const s = (scope ?? "").trim().toLowerCase();
    if (!s) return "full-game";
    if (["1h", "1st half", "first half"].includes(s)) return "first-half";
    if (["2h", "2nd half", "second half"].includes(s)) return "second-half";
    return teamKey(s);
  };
  const slugKey = `${sport.toLowerCase()}:${eventSlug}`;
  let m = question.match(/^.+?\s+vs\.?\s+.+?:\s*O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (m) {
    const idx = outcomeIndexes();
    if (idx) return { strike: parseNumber(m[1]), direction: "above" as const, ladderKey: `sports:${slugKey}:total:full-game`, ...idx };
  }
  m = question.match(/^.+?\s+vs\.?\s+.+?:\s*(1H|1st Half|First Half|2H|2nd Half|Second Half)\s+O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (m) {
    const idx = outcomeIndexes();
    if (idx) return { strike: parseNumber(m[2]), direction: "above" as const, ladderKey: `sports:${slugKey}:total:${scopeKey(m[1])}`, ...idx };
  }
  m = question.match(/^(.+?)\s+vs\.?\s+(.+?):\s*(.+?)\s+(?:(1H|1st Half|First Half|2H|2nd Half|Second Half)\s+)?O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (m) {
    const idx = outcomeIndexes();
    if (idx) return { strike: parseNumber(m[5]), direction: "above" as const, ladderKey: `sports:${slugKey}:team-total:${scopeKey(m[4])}:${teamKey(m[3])}`, ...idx };
  }
  m = question.match(/^(1H\s+)?Spread:\s+(.+?)\s+\(-?([0-9]+(?:\.5)?)\)$/i);
  if (m) {
    const team = m[2].trim();
    const yesIndex = normalized.findIndex((outcome) => outcome === team.toLowerCase());
    const noIndex = normalized.findIndex((_, index) => index !== yesIndex);
    if (yesIndex >= 0 && noIndex >= 0) {
      return { strike: parseNumber(m[3]), direction: "above" as const, ladderKey: `sports:${slugKey}:spread:${m[1] ? "first-half" : "full-game"}:${teamKey(team)}`, yesIndex, noIndex };
    }
  }
  return null;
}

async function quote(event: any, market: any): Promise<Quote | null> {
  const eventSlug = event.slug ?? "";
  const marketId = String(market.id ?? "");
  const question = String(market.question ?? "");
  if (!eventSlug || !marketId || !question || market.closed || market.active === false || market.acceptingOrders === false) return null;
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const parsed = parseSportsMarket(eventSlug, question, outcomes);
  if (!parsed || !tokenIds[parsed.yesIndex] || !tokenIds[parsed.noIndex]) return null;
  const [yesBook, noBook] = await Promise.all([fetchBook(tokenIds[parsed.yesIndex]), fetchBook(tokenIds[parsed.noIndex])]);
  if (!(yesBook.ask > 0) || !(noBook.ask > 0)) return null;
  return {
    eventSlug,
    eventTitle: event.title ?? eventSlug,
    marketId,
    ladderKey: parsed.ladderKey,
    question,
    description: market.description ?? "",
    resolutionSource: market.resolutionSource ?? "",
    strike: parsed.strike,
    direction: parsed.direction,
    startDate: market.startDate ?? market.createdAt ?? event.startDate ?? event.createdAt ?? null,
    endDate: market.endDate ?? event.endDate ?? null,
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    yesTokenId: tokenIds[parsed.yesIndex],
    noTokenId: tokenIds[parsed.noIndex],
    yesBook,
    noBook,
  };
}

function emptyBook(tokenId: string): Book {
  return { tokenId, bid: 0, bidSize: 0, ask: 0, askSize: 0, spread: 0, minOrderSize: 5 };
}

function structuralQuote(event: any, market: any): Quote | null {
  const eventSlug = event.slug ?? "";
  const marketId = String(market.id ?? "");
  const question = String(market.question ?? "");
  if (!eventSlug || !marketId || !question || market.closed || market.active === false || market.acceptingOrders === false) return null;
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const parsed = parseSportsMarket(eventSlug, question, outcomes);
  if (!parsed || !tokenIds[parsed.yesIndex] || !tokenIds[parsed.noIndex]) return null;
  return {
    eventSlug,
    eventTitle: event.title ?? eventSlug,
    marketId,
    ladderKey: parsed.ladderKey,
    question,
    description: market.description ?? "",
    resolutionSource: market.resolutionSource ?? "",
    strike: parsed.strike,
    direction: parsed.direction,
    startDate: market.startDate ?? market.createdAt ?? event.startDate ?? event.createdAt ?? null,
    endDate: market.endDate ?? event.endDate ?? null,
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    yesTokenId: tokenIds[parsed.yesIndex],
    noTokenId: tokenIds[parsed.noIndex],
    yesBook: emptyBook(tokenIds[parsed.yesIndex]),
    noBook: emptyBook(tokenIds[parsed.noIndex]),
  };
}

async function discoverSlugs(): Promise<string[]> {
  const configured = [
    process.env.MONOTONIC_ARB_REAL_PM_EVENT_SLUGS ?? "",
    process.env.MONOTONIC_ARB_REAL_PM_EXTRA_EVENT_SLUGS ?? "",
    process.env.MONOTONIC_ARB_REAL_PM_SOCCER_EVENT_SLUGS ?? "",
    process.env.MONOTONIC_ARB_REAL_PM_MLB_EVENT_SLUGS ?? "",
  ].join(",").split(",").map((slug) => slug.trim()).filter(Boolean);
  const tags = ["mlb", "baseball", "nba", "basketball", "soccer", "fifa", "world-cup"];
  const slugs = new Set(configured);
  if (ONLY_CONFIGURED_SLUGS) return [...slugs];
  let discovered = 0;
  for (const tag of tags) {
    if (discovered >= MAX_DISCOVERED_EVENTS) break;
    const pageLimit = String(Math.max(1, Math.min(100, DISCOVERY_LIMIT)));
    for (let offset = 0; offset < DISCOVERY_LIMIT && discovered < MAX_DISCOVERED_EVENTS; offset += Number(pageLimit)) {
      const url = `${GAMMA_API}/events?${new URLSearchParams({ active: "true", closed: "false", tag_slug: tag, limit: pageLimit, offset: String(offset), order: "volume24hr", ascending: "false" })}`;
      let events: any[] = [];
      try {
        events = await fetchJson(url);
      } catch {
        break;
      }
      for (const event of Array.isArray(events) ? events : []) {
        if (event?.slug && sportKind(event.slug) && event.closed !== true && event.active !== false && !slugs.has(event.slug)) {
          slugs.add(event.slug);
          discovered += 1;
          if (discovered >= MAX_DISCOVERED_EVENTS) break;
        }
      }
      if (!Array.isArray(events) || events.length < Number(pageLimit)) break;
    }
  }
  return [...slugs];
}

async function scan(): Promise<Candidate[]> {
  if (PACKAGE_SPECS.length) return scanPackageSpecs();
  const foundAt = new Date().toISOString();
  const out: Candidate[] = [];
  for (const slug of await discoverSlugs()) {
    let events: any[] = [];
    try {
      events = await fetchJson(`${GAMMA_API}/events?${new URLSearchParams({ slug })}`);
    } catch (err: any) {
      console.log(`scan_error slug=${slug} ${err?.message ?? String(err)}`);
      continue;
    }
    const event = events[0];
    if (!event?.slug || event.closed || event.active === false) continue;
    const asset = sportKind(event.slug);
    if (!asset) continue;
    const quotes = (event.markets ?? []).map((market: any) => structuralQuote(event, market)).filter((q: Quote | null): q is Quote => q !== null);
    for (const ladderKey of [...new Set(quotes.map((q: Quote) => q.ladderKey))]) {
      const ladder = quotes.filter((q: Quote) => q.ladderKey === ladderKey).sort((a: Quote, b: Quote) => a.strike - b.strike);
      for (let i = 0; i < ladder.length; i += 1) {
        const jLimit = ADJACENT_ONLY ? Math.min(ladder.length, i + 2) : ladder.length;
        for (let j = i + 1; j < jLimit; j += 1) {
          const broad = ladder[i];
          const narrow = ladder[j];
          if (!USE_WS_BOOKS) {
            try {
              broad.yesBook = await fetchBook(broad.yesTokenId);
              narrow.yesBook = await fetchBook(narrow.yesTokenId);
              narrow.noBook = await fetchBook(narrow.noTokenId);
            } catch (err: any) {
              if (String(err?.message ?? err).includes("429")) console.log(`book_rate_limited package=${event.slug}::YES-${broad.marketId}+NO-${narrow.marketId}`);
              continue;
            }
          }
          const packageCost = broad.yesBook.ask + narrow.noBook.ask;
          const maxSpread = Math.max(broad.yesBook.spread, narrow.yesBook.spread);
          const availableSize = Math.min(broad.yesBook.askSize, narrow.noBook.askSize, MAX_PAIRED_SHARES);
          const minShares = requiredSharesForBooks(broad.yesBook, narrow.noBook);
          const minPackageUsd = minShares * packageCost;
          const rejectionReasons = [
            APPLY_MIN_PACKAGE_COST && packageCost + 1e-9 < MIN_PACKAGE_COST ? "cost_below_min" : "",
            packageCost > MAX_PACKAGE_COST + 1e-9 ? "cost_above_cap" : "",
            maxSpread > MAX_SPREAD + 1e-9 ? "wide_spread" : "",
            availableSize + 1e-9 < minShares ? `size_below_min_${minShares}` : "",
            APPLY_PACKAGE_USD_CAP && minPackageUsd > MAX_PACKAGE_USD + 1e-9 ? `min_package_usd_above_cap_${minPackageUsd.toFixed(2)}` : "",
          ].filter(Boolean);
          out.push(recomputeCandidate({
            foundAt,
            asset,
            eventSlug: event.slug,
            eventTitle: event.title ?? event.slug,
            packageId: `${event.slug}::YES-${broad.marketId}+NO-${narrow.marketId}`,
            direction: "above",
            broad,
            narrow,
            packageCost,
            lockedEdge: 1 - packageCost,
            availableSize,
            maxSpread,
            minLiquidity: Math.min(broad.liquidity, narrow.liquidity),
            jackpotPayoutPerShare: 2,
            eligible: rejectionReasons.length === 0,
            rejectionReasons,
          }));
          if (out.length >= MAX_STRUCTURAL_CANDIDATES) return out;
        }
      }
    }
  }
  return out;
}

function recomputeCandidate(candidate: Candidate): Candidate {
  const packageCost = candidate.broad.yesBook.ask + candidate.narrow.noBook.ask;
  const maxSpread = Math.max(candidate.broad.yesBook.spread, candidate.narrow.yesBook.spread);
  const availableSize = Math.min(candidate.broad.yesBook.askSize, candidate.narrow.noBook.askSize, MAX_PAIRED_SHARES);
  const minShares = requiredShares(candidate);
  const minPackageUsd = minShares * packageCost;
  const rejectionReasons = [
    !(candidate.broad.yesBook.ask > 0 && candidate.narrow.noBook.ask > 0) ? "missing_book" : "",
    APPLY_MIN_PACKAGE_COST && packageCost + 1e-9 < MIN_PACKAGE_COST ? "cost_below_min" : "",
    packageCost > MAX_PACKAGE_COST + 1e-9 ? "cost_above_cap" : "",
    maxSpread > MAX_SPREAD + 1e-9 ? "wide_spread" : "",
    availableSize + 1e-9 < minShares ? `size_below_min_${minShares}` : "",
    APPLY_PACKAGE_USD_CAP && minPackageUsd > MAX_PACKAGE_USD + 1e-9 ? `min_package_usd_above_cap_${minPackageUsd.toFixed(2)}` : "",
  ].filter(Boolean);
  return {
    ...candidate,
    packageCost,
    lockedEdge: 1 - packageCost,
    availableSize,
    maxSpread,
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

async function hydrateCandidatesFromWs(candidates: Candidate[]): Promise<Candidate[]> {
  const tokens = candidates.flatMap((candidate) => [
    candidate.broad.yesTokenId,
    candidate.narrow.yesTokenId,
    candidate.narrow.noTokenId,
  ]);
  console.log(`WS_WARMUP tokens=${new Set(tokens).size} candidates=${candidates.length} ms=${WS_WARMUP_MS}`);
  await warmWsBooks(tokens);
  return candidates.map((candidate) => recomputeCandidate({
    ...candidate,
    broad: { ...candidate.broad, yesBook: topOfWsBook(candidate.broad.yesTokenId) },
    narrow: {
      ...candidate.narrow,
      yesBook: topOfWsBook(candidate.narrow.yesTokenId),
      noBook: topOfWsBook(candidate.narrow.noTokenId),
    },
  }));
}

function missingExecutableBook(candidate: Candidate): boolean {
  return !(candidate.broad.yesBook.ask > 0 && candidate.narrow.noBook.ask > 0);
}

async function restFallbackMissingBooks(candidates: Candidate[]): Promise<Candidate[]> {
  if (!USE_WS_BOOKS || !(WS_REST_FALLBACK_LIMIT > 0)) return candidates;
  const missing = candidates.filter(missingExecutableBook).slice(0, WS_REST_FALLBACK_LIMIT);
  if (!missing.length) return candidates;
  const refreshed = new Map<string, Candidate>();
  let errors = 0;
  for (const candidate of missing) {
    try {
      refreshed.set(candidate.packageId, await refreshCandidateRest(candidate));
    } catch (err: any) {
      errors += 1;
      if (String(err?.message ?? err).includes("429")) console.log(`ws_rest_fallback_rate_limited package=${candidate.packageId}`);
    }
  }
  const merged = candidates.map((candidate) => refreshed.get(candidate.packageId) ?? candidate);
  const refreshedCandidates = Array.from(refreshed.values());
  const recovered = refreshedCandidates.filter((candidate) => !missingExecutableBook(candidate)).length;
  const eligible = refreshedCandidates.filter((candidate) => candidate.eligible).length;
  console.log(`WS_REST_FALLBACK checked=${missing.length} refreshed=${refreshed.size} recoveredBooks=${recovered} eligible=${eligible} errors=${errors}`);
  return merged;
}

async function refreshCandidateRest(candidate: Candidate): Promise<Candidate> {
  bookCache.delete(candidate.broad.yesTokenId);
  bookCache.delete(candidate.narrow.yesTokenId);
  bookCache.delete(candidate.narrow.noTokenId);
  const broadYesBook = await fetchBook(candidate.broad.yesTokenId);
  const narrowYesBook = await fetchBook(candidate.narrow.yesTokenId);
  const narrowNoBook = await fetchBook(candidate.narrow.noTokenId);
  return recomputeCandidate({
    ...candidate,
    broad: { ...candidate.broad, yesBook: broadYesBook },
    narrow: { ...candidate.narrow, yesBook: narrowYesBook, noBook: narrowNoBook },
  });
}

async function scanPackageSpecs(): Promise<Candidate[]> {
  const foundAt = new Date().toISOString();
  const out: Candidate[] = [];
  for (const spec of PACKAGE_SPECS) {
    const [eventSlug, broadMarketSlug, narrowMarketSlug] = spec.split("|").map((part) => part.trim());
    if (!eventSlug || !broadMarketSlug || !narrowMarketSlug) {
      console.log(`bad_package_spec ${spec}`);
      continue;
    }
    const events = await fetchJson(`${GAMMA_API}/events?${new URLSearchParams({ slug: eventSlug })}`);
    const event = events[0];
    if (!event?.slug || event.closed || event.active === false) continue;
    const asset = sportKind(event.slug);
    if (!asset) continue;
    const broadMarket = (event.markets ?? []).find((market: any) => market.slug === broadMarketSlug);
    const narrowMarket = (event.markets ?? []).find((market: any) => market.slug === narrowMarketSlug);
    if (!broadMarket || !narrowMarket) {
      console.log(`missing_market_spec ${spec}`);
      continue;
    }
    const broad = structuralQuote(event, broadMarket);
    const narrow = structuralQuote(event, narrowMarket);
    if (!broad || !narrow || broad.ladderKey !== narrow.ladderKey) {
      console.log(`invalid_structural_spec ${spec}`);
      continue;
    }
    if (!USE_WS_BOOKS) {
      try {
        broad.yesBook = await fetchBook(broad.yesTokenId);
        narrow.yesBook = await fetchBook(narrow.yesTokenId);
        narrow.noBook = await fetchBook(narrow.noTokenId);
      } catch (err: any) {
        console.log(`book_error_spec ${spec} ${err?.message ?? String(err)}`);
        continue;
      }
    }
    out.push(recomputeCandidate({
      foundAt,
      asset,
      eventSlug: event.slug,
      eventTitle: event.title ?? event.slug,
      packageId: `${event.slug}::YES-${broad.marketId}+NO-${narrow.marketId}`,
      direction: "above",
      broad,
      narrow,
      packageCost: 0,
      lockedEdge: 0,
      availableSize: 0,
      maxSpread: 0,
      minLiquidity: Math.min(broad.liquidity, narrow.liquidity),
      jackpotPayoutPerShare: 2,
      eligible: false,
      rejectionReasons: [],
    }));
  }
  return out;
}

function requiredSharesForBooks(broadYesBook: Book, narrowNoBook: Book): number {
  if (!(broadYesBook.ask > 0 && narrowNoBook.ask > 0)) return Number.POSITIVE_INFINITY;
  const rawMinShares = Math.max(
    broadYesBook.minOrderSize,
    narrowNoBook.minOrderSize,
    MIN_MARKETABLE_BUY_USD / broadYesBook.ask,
    MIN_MARKETABLE_BUY_USD / narrowNoBook.ask,
  );
  return ceilToStep(rawMinShares, pairedMarketBuyShareStep(broadYesBook.ask, narrowNoBook.ask));
}

function requiredShares(candidate: Candidate): number {
  return requiredSharesForBooks(candidate.broad.yesBook, candidate.narrow.noBook);
}

function sizedShares(candidate: Candidate, remainingUsd: number): { shares: number; cost: number; reason?: string } {
  if (!(candidate.packageCost > 0)) return { shares: 0, cost: 0, reason: "missing_or_zero_package_cost" };
  const minShares = requiredShares(candidate);
  const packageBudget = APPLY_PACKAGE_USD_CAP ? Math.min(remainingUsd, MAX_PACKAGE_USD) : remainingUsd;
  const shareStep = pairedMarketBuyShareStep(candidate.broad.yesBook.ask, candidate.narrow.noBook.ask);
  const maxShares = floorToStep(Math.min(candidate.availableSize, packageBudget / candidate.packageCost, MAX_PAIRED_SHARES), shareStep);
  if (maxShares + 1e-9 < minShares) return { shares: maxShares, cost: maxShares * candidate.packageCost, reason: `budget_or_depth_below_min_${minShares}` };
  if (SIZE_MODE === "min_valid") {
    return { shares: minShares, cost: minShares * candidate.packageCost };
  }
  return { shares: maxShares, cost: maxShares * candidate.packageCost };
}

function candidateMinUsd(candidate: Candidate): number {
  if (missingExecutableBook(candidate)) return Number.POSITIVE_INFINITY;
  return requiredShares(candidate) * candidate.packageCost;
}

function candidateSortCost(candidate: Candidate): number {
  return missingExecutableBook(candidate) ? Number.POSITIVE_INFINITY : candidate.packageCost;
}

function candidateGameStartMs(candidate: Candidate): number {
  const value = candidate.broad.endDate ?? candidate.narrow.endDate ?? candidate.broad.startDate ?? candidate.narrow.startDate;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function candidateGameStartLabel(candidate: Candidate): string {
  const ms = candidateGameStartMs(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown";
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (SORT_BY === "min_usd") {
    return candidateMinUsd(a) - candidateMinUsd(b)
      || candidateSortCost(a) - candidateSortCost(b)
      || candidateGameStartMs(a) - candidateGameStartMs(b)
      || b.availableSize - a.availableSize
      || a.maxSpread - b.maxSpread;
  }
  return candidateSortCost(a) - candidateSortCost(b)
    || candidateGameStartMs(a) - candidateGameStartMs(b)
    || b.availableSize - a.availableSize
    || a.maxSpread - b.maxSpread;
}

function responseBuyShares(response: any): number {
  const shares = Number(response?.takingAmount);
  return Number.isFinite(shares) && shares > 0 ? shares : 0;
}

function averageBuyPrice(response: any, fallbackPrice: number): number {
  const cost = Number(response?.makingAmount);
  const shares = Number(response?.takingAmount);
  if (Number.isFinite(cost) && cost > 0 && Number.isFinite(shares) && shares > 0) return cost / shares;
  const price = Number(response?.price);
  return Number.isFinite(price) && price > 0 ? price : fallbackPrice;
}

async function waitForBalance(tokenId: string, address: string, minShares: number): Promise<number> {
  const started = Date.now();
  let latest = await reconcileTokenBalance(address, tokenId);
  while (latest + 1e-9 < minShares && Date.now() - started < 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    latest = await reconcileTokenBalance(address, tokenId);
  }
  return latest;
}

function persist(record: any, orders: any[]) {
  const rows = readJsonArray<any>(PACKAGES_PATH).filter((row) => row.id !== record.id);
  writeJsonArray(PACKAGES_PATH, [...rows, record]);
  if (orders.length) appendJsonArray(ORDERS_PATH, orders);
}

async function executeCheapFirst(client: any, walletAddress: string, candidate: Candidate, shares: number, wsCost: number | null) {
  const runAt = new Date().toISOString();
  const submitStartedAt = Date.now();
  const record = packageRecord(candidate as any, walletAddress, shares, false);
  const broadLeg = { role: "broad_yes" as const, tokenId: candidate.broad.yesTokenId, price: candidate.broad.yesBook.ask };
  const narrowLeg = { role: "narrow_no" as const, tokenId: candidate.narrow.noTokenId, price: candidate.narrow.noBook.ask };
  const first = broadLeg.price <= narrowLeg.price ? broadLeg : narrowLeg;
  const second = first.role === "broad_yes" ? narrowLeg : broadLeg;
  const submittedAt = new Date().toISOString();
  const orders: any[] = [];
  const errors: string[] = [];
  let bothLegsSubmitted = false;

  console.log(`EXEC ${candidate.packageId} wsCost=${wsCost?.toFixed(4) ?? "na"} freshCost=${candidate.packageCost.toFixed(4)} first=${first.role}@${first.price.toFixed(4)} second=${second.role}@${second.price.toFixed(4)} shares=${shares.toFixed(2)}`);
  record.status = "leg1_submitted";
  record.failureReason = `ranked_sports_cheap_first_intent first=${first.role} second=${second.role}`;
  record.updatedAt = new Date().toISOString();
  persist(record, []);

  let firstResp: any;
  try {
    firstResp = await postFakBuy(client, first.tokenId, first.price, shares);
    assertOrderResponse(firstResp, first.role);
    record.legOrderIds[first.role === "broad_yes" ? "broadYes" : "narrowNo"] = orderId(firstResp);
  } catch (err: any) {
    firstResp = { error: err?.message ?? String(err) };
    errors.push(`${first.role}:${err?.message ?? String(err)}`);
  }
  const firstFilled = roundShares(responseBuyShares(firstResp));
  let broadFilled = first.role === "broad_yes" ? firstFilled : 0;
  let narrowFilled = first.role === "narrow_no" ? firstFilled : 0;
  orders.push({ packageId: record.packageId, createdAt: submittedAt, role: first.role, tokenId: first.tokenId, side: "BUY", price: first.price, size: firstFilled, orderType: "FAK", response: firstResp });

  record.status = "leg2_submitted";
  record.updatedAt = new Date().toISOString();
  let secondResp: any | undefined;
  const secondMin = Math.max(1, second.role === "narrow_no" ? candidate.narrow.noBook.minOrderSize : candidate.broad.yesBook.minOrderSize);
  const hedgeShares = firstFilled > 0 ? precisionSafeBuyShares(second.price, secondMin, firstFilled) : null;
  if (firstFilled > 0 && hedgeShares && hedgeShares * second.price + 1e-9 >= MIN_MARKETABLE_BUY_USD) {
    bothLegsSubmitted = true;
    try {
      secondResp = await postFakBuy(client, second.tokenId, second.price, hedgeShares);
      assertOrderResponse(secondResp, second.role);
      record.legOrderIds[second.role === "broad_yes" ? "broadYes" : "narrowNo"] = orderId(secondResp);
    } catch (err: any) {
      secondResp = { error: err?.message ?? String(err) };
      errors.push(`${second.role}:${err?.message ?? String(err)}`);
    }
    const secondFilled = roundShares(responseBuyShares(secondResp));
    if (second.role === "broad_yes") broadFilled = secondFilled;
    else narrowFilled = secondFilled;
    orders.push({ packageId: record.packageId, createdAt: new Date().toISOString(), role: second.role, tokenId: second.tokenId, side: "BUY", price: second.price, size: secondFilled, orderType: "FAK", response: secondResp });
  } else if (firstFilled > 0) {
    errors.push(
      !hedgeShares
        ? `${second.role}:skipped clob_amount_precision_unavailable fill=${firstFilled} price=${second.price}`
        : `${second.role}:skipped complement notional below minimum`,
    );
  }

  const matched = roundShares(Math.min(broadFilled, narrowFilled));
  const nakedRole = broadFilled > narrowFilled ? "broad_yes" : narrowFilled > broadFilled ? "narrow_no" : null;
  const nakedShares = roundShares(Math.abs(broadFilled - narrowFilled));
  const broadPrice = first.role === "broad_yes" ? averageBuyPrice(firstResp, broadLeg.price) : averageBuyPrice(secondResp, broadLeg.price);
  const narrowPrice = first.role === "narrow_no" ? averageBuyPrice(firstResp, narrowLeg.price) : averageBuyPrice(secondResp, narrowLeg.price);
  record.filledShares = matched;
  record.actualCost = broadFilled * broadPrice + narrowFilled * narrowPrice;
  record.guaranteedFloor = matched;
  record.lockedFloorProfit = matched * candidate.lockedEdge;
  record.jackpotPayout = matched * candidate.jackpotPayoutPerShare;
  record.status = matched > 0 ? "package_complete" : "unwind_required";
  record.failureReason = errors.length || nakedRole
    ? `ranked_sports_cheap_first matched=${matched} naked_${nakedRole ?? "none"}=${nakedShares}${errors.length ? ` errors=${errors.join("; ")}` : ""}`
    : undefined;
  record.updatedAt = new Date().toISOString();
  persist(record, orders);

  if (nakedRole && nakedShares >= 0.01) {
    const tokenId = nakedRole === "broad_yes" ? candidate.broad.yesTokenId : candidate.narrow.noTokenId;
    const fillPrice = nakedRole === "broad_yes" ? broadPrice : narrowPrice;
    const book = await fetchBook(tokenId);
    const balance = await waitForBalance(tokenId, walletAddress, Math.min(nakedShares, 1));
    const sellShares = roundShares(Math.min(nakedShares, balance));
    if (book.bid > 0 && sellShares >= 0.01) {
      console.log(`UNWIND ${record.packageId} ${nakedRole} shares=${sellShares} bid=${book.bid.toFixed(4)} fill=${fillPrice.toFixed(4)}`);
      let sellResp: any;
      try {
        sellResp = await postFakSell(client, tokenId, book.bid, sellShares);
        assertOrderResponse(sellResp, "unwind");
      } catch (err: any) {
        sellResp = { error: err?.message ?? String(err) };
      }
      appendJsonArray(ORDERS_PATH, [{ packageId: record.packageId, createdAt: new Date().toISOString(), role: "unwind", tokenId, side: "SELL", price: book.bid, size: sellShares, orderType: "FAK", response: sellResp }]);
    } else {
      console.log(`UNWIND_SKIPPED ${record.packageId} ${nakedRole} shares=${nakedShares} bid=${book.bid} balance=${balance}`);
    }
  }
  const submitLatencyMs = Date.now() - submitStartedAt;
  const actualPairCost = matched > 0 ? record.actualCost / matched : null;
  const bothLegsFilled = matched > 0 && nakedShares < 0.01;
  let outcome: AttemptOutcome = "no_fill";
  if (errors.length && firstFilled <= 0) outcome = "submit_rejected";
  else if (matched <= 0) outcome = "no_fill";
  else if (nakedShares >= 0.01) outcome = "partial_orphan";
  else outcome = "clean_paired_fill";
  console.log(`RESULT ${record.packageId} status=${record.status} matched=${matched.toFixed(2)} broad=${broadFilled.toFixed(2)} narrow=${narrowFilled.toFixed(2)} actualCost=${record.actualCost.toFixed(4)} actualPairCost=${actualPairCost?.toFixed(4) ?? "na"} naked=${nakedShares.toFixed(2)} latencyMs=${submitLatencyMs}`);
  const attempt: AttemptRecord = {
    runAt,
    bucket: bucketLabel(),
    eventSlug: candidate.eventSlug,
    eventTitle: candidate.eventTitle,
    packageId: candidate.packageId,
    packageLabel: packageLabel(candidate),
    gameStart: candidateGameStartLabel(candidate),
    wsCost,
    freshCost: candidate.packageCost,
    submittedBroadPrice: broadLeg.price,
    submittedNarrowPrice: narrowLeg.price,
    filledBroadPrice: broadFilled > 0 ? broadPrice : null,
    filledNarrowPrice: narrowFilled > 0 ? narrowPrice : null,
    sharesRequested: shares,
    sharesMatched: matched,
    actualPairCost,
    inBucket: actualPairCost == null ? null : inCostBucket(actualPairCost),
    outcome,
    preflightPassed: true,
    sizingPassed: true,
    bothLegsSubmitted,
    bothLegsFilled,
    submitLatencyMs,
    blocker: errors.join("; ") || record.failureReason || "",
  };
  appendAttempt(attempt);
  return { record, attempt };
}

async function main() {
  const runAt = new Date().toISOString();
  const probe = await proxyCollateralProbe(POLYMARKET_FUNDER_ADDRESS!);
  if (!probe) throw new Error("missing funder probe");
  const balanceBudget = Math.max(0, probe.collateralBalance - BALANCE_HEADROOM_USD);
  const alreadyOpen = new Set(readJsonArray<any>(PACKAGES_PATH)
    .filter((row) => ["quoted", "leg1_submitted", "leg1_filled", "leg2_submitted", "package_complete"].includes(row.status))
    .map((row) => row.packageId));
  const scannedCandidates = await scan();
  const wsHydrated = USE_WS_BOOKS
    ? await restFallbackMissingBooks(await hydrateCandidatesFromWs(scannedCandidates))
    : scannedCandidates;
  const wsCostByPackage = new Map(wsHydrated.map((candidate) => [candidate.packageId, candidate.packageCost]));
  const observedInBucket = wsHydrated.filter((candidate) => inCostBucket(candidate.packageCost));
  const freshCandidates: Candidate[] = [];
  for (const candidate of wsHydrated) {
    if (!inCostBucket(wsCostByPackage.get(candidate.packageId) ?? candidate.packageCost)) continue;
    try {
      freshCandidates.push(await refreshCandidateRest(candidate));
    } catch (err: any) {
      console.log(`FRESH_PREFLIGHT_ERROR ${candidate.packageId} ${err?.message ?? String(err)}`);
    }
  }
  for (const candidate of freshCandidates
    .slice()
    .sort(compareCandidates)
    .slice(0, 15)) {
    const open = alreadyOpen.has(candidate.packageId) ? " open=1" : "";
    const wsCost = wsCostByPackage.get(candidate.packageId);
    console.log(`SEEN ${candidate.asset} ${candidate.eventSlug} start=${candidateGameStartLabel(candidate)} YES ${candidate.broad.strike} + NO ${candidate.narrow.strike} wsCost=${wsCost?.toFixed(4) ?? "na"} freshCost=${candidate.packageCost.toFixed(4)} spread=${candidate.maxSpread.toFixed(4)} size=${candidate.availableSize.toFixed(2)} eligible=${candidate.eligible}${open}${candidate.rejectionReasons.length ? ` reasons=${candidate.rejectionReasons.join(",")}` : ""} package=${candidate.packageId}`);
  }
  const candidates = freshCandidates
    .filter((candidate) => candidate.eligible && inCostBucket(candidate.packageCost) && !alreadyOpen.has(candidate.packageId))
    .sort(compareCandidates);

  const selected: Array<{ candidate: Candidate; shares: number; cost: number; wsCost: number | null }> = [];
  const eventSpend = new Map<string, number>();
  let remaining = balanceBudget;
  for (const candidate of candidates) {
    if (APPLY_EVENT_CAP && (eventSpend.get(candidate.eventSlug) ?? 0) >= EVENT_CAP_USD - 1e-9) continue;
    const eventRemaining = APPLY_EVENT_CAP ? Math.max(0, EVENT_CAP_USD - (eventSpend.get(candidate.eventSlug) ?? 0)) : remaining;
    const sized = sizedShares(candidate, Math.min(remaining, eventRemaining));
    if (sized.reason) continue;
    selected.push({
      candidate,
      shares: sized.shares,
      cost: sized.cost,
      wsCost: wsCostByPackage.get(candidate.packageId) ?? null,
    });
    remaining -= sized.cost;
    eventSpend.set(candidate.eventSlug, (eventSpend.get(candidate.eventSlug) ?? 0) + sized.cost);
    if (remaining < 2) break;
    if (MAX_EXECUTIONS > 0 && selected.length >= MAX_EXECUTIONS) break;
  }

  console.log(`RANKED_SCAN scanned=${scannedCandidates.length} wsInBucket=${observedInBucket.length} freshInBucket=${freshCandidates.length} freshEligible=${candidates.length} selected=${selected.length} pUSD=${probe.collateralBalance.toFixed(4)} budget=${balanceBudget.toFixed(4)} remainingAfterPlan=${remaining.toFixed(4)} minPackageCost=${APPLY_MIN_PACKAGE_COST ? MIN_PACKAGE_COST : "none"} maxPackageCost=${MAX_PACKAGE_COST} maxPackageUsd=${APPLY_PACKAGE_USD_CAP ? MAX_PACKAGE_USD : "none"} sizeMode=${SIZE_MODE} maxShares=${MAX_PAIRED_SHARES} maxEventUsd=${APPLY_EVENT_CAP ? EVENT_CAP_USD : "none"} maxExecutions=${MAX_EXECUTIONS || "none"} bookSource=${USE_WS_BOOKS ? "websocket+rest_preflight" : "rest"} dryRun=${DRY_RUN}`);
  for (const [idx, row] of selected.entries()) {
    console.log(`PLAN ${idx + 1} ${row.candidate.asset} ${row.candidate.eventSlug} start=${candidateGameStartLabel(row.candidate)} YES ${row.candidate.broad.strike} + NO ${row.candidate.narrow.strike} wsCost=${row.wsCost?.toFixed(4) ?? "na"} freshCost=${row.candidate.packageCost.toFixed(4)} shares=${row.shares.toFixed(2)} usd=${row.cost.toFixed(4)} spread=${row.candidate.maxSpread.toFixed(4)} edge=${(row.candidate.lockedEdge * 100).toFixed(2)}c package=${row.candidate.packageId}`);
  }

  const attempts: AttemptRecord[] = [];
  if (DRY_RUN) {
    for (const row of selected) {
      attempts.push({
        runAt,
        bucket: bucketLabel(),
        eventSlug: row.candidate.eventSlug,
        eventTitle: row.candidate.eventTitle,
        packageId: row.candidate.packageId,
        packageLabel: packageLabel(row.candidate),
        gameStart: candidateGameStartLabel(row.candidate),
        wsCost: row.wsCost,
        freshCost: row.candidate.packageCost,
        submittedBroadPrice: null,
        submittedNarrowPrice: null,
        filledBroadPrice: null,
        filledNarrowPrice: null,
        sharesRequested: row.shares,
        sharesMatched: 0,
        actualPairCost: null,
        inBucket: inCostBucket(row.candidate.packageCost),
        outcome: "preflight_rejected",
        preflightPassed: true,
        sizingPassed: true,
        bothLegsSubmitted: false,
        bothLegsFilled: false,
        submitLatencyMs: null,
        blocker: "dry_run",
      });
    }
    printTestSummary(runAt, observedInBucket.length, selected.length, attempts);
    return;
  }

  const { client } = await clobClient();
  let executionCount = 0;
  for (const row of selected) {
    if (MAX_EXECUTIONS > 0 && executionCount >= MAX_EXECUTIONS) break;
    executionCount += 1;
    const preflightStartedAt = Date.now();
    let fresh: Candidate;
    try {
      fresh = await refreshCandidateRest(row.candidate);
    } catch (err: any) {
      const attempt: AttemptRecord = {
        runAt,
        bucket: bucketLabel(),
        eventSlug: row.candidate.eventSlug,
        eventTitle: row.candidate.eventTitle,
        packageId: row.candidate.packageId,
        packageLabel: packageLabel(row.candidate),
        gameStart: candidateGameStartLabel(row.candidate),
        wsCost: row.wsCost,
        freshCost: null,
        submittedBroadPrice: null,
        submittedNarrowPrice: null,
        filledBroadPrice: null,
        filledNarrowPrice: null,
        sharesRequested: row.shares,
        sharesMatched: 0,
        actualPairCost: null,
        inBucket: null,
        outcome: "preflight_rejected",
        preflightPassed: false,
        sizingPassed: false,
        bothLegsSubmitted: false,
        bothLegsFilled: false,
        submitLatencyMs: Date.now() - preflightStartedAt,
        blocker: err?.message ?? String(err),
      };
      appendAttempt(attempt);
      attempts.push(attempt);
      console.log(`SKIP_PREFLIGHT ${row.candidate.packageId} fetchError=${attempt.blocker}`);
      continue;
    }
    const freshSized = sizedShares(fresh, row.cost + 0.01);
    const preflightOk = fresh.eligible && inCostBucket(fresh.packageCost) && !freshSized.reason;
    if (!preflightOk) {
      const attempt: AttemptRecord = {
        runAt,
        bucket: bucketLabel(),
        eventSlug: fresh.eventSlug,
        eventTitle: fresh.eventTitle,
        packageId: fresh.packageId,
        packageLabel: packageLabel(fresh),
        gameStart: candidateGameStartLabel(fresh),
        wsCost: row.wsCost,
        freshCost: fresh.packageCost,
        submittedBroadPrice: fresh.broad.yesBook.ask,
        submittedNarrowPrice: fresh.narrow.noBook.ask,
        filledBroadPrice: null,
        filledNarrowPrice: null,
        sharesRequested: row.shares,
        sharesMatched: 0,
        actualPairCost: null,
        inBucket: inCostBucket(fresh.packageCost),
        outcome: freshSized.reason ? "sizing_failed" : "preflight_rejected",
        preflightPassed: fresh.eligible && inCostBucket(fresh.packageCost),
        sizingPassed: !freshSized.reason,
        bothLegsSubmitted: false,
        bothLegsFilled: false,
        submitLatencyMs: Date.now() - preflightStartedAt,
        blocker: fresh.rejectionReasons.join(",") || freshSized.reason || "preflight_gate",
      };
      appendAttempt(attempt);
      attempts.push(attempt);
      console.log(`SKIP_PREFLIGHT ${fresh.packageId} wsCost=${row.wsCost?.toFixed(4) ?? "na"} freshCost=${fresh.packageCost.toFixed(4)} eligible=${fresh.eligible} reason=${attempt.blocker}`);
      continue;
    }
    const { attempt } = await executeCheapFirst(client, probe.address, fresh, Math.min(row.shares, freshSized.shares), row.wsCost);
    attempts.push(attempt);
  }
  printTestSummary(runAt, observedInBucket.length, attempts.length, attempts);
}

function printTestSummary(runAt: string, observedInBucket: number, attempted: number, attempts: AttemptRecord[]) {
  const wsCosts = attempts.map((row) => row.wsCost).filter((value): value is number => value != null);
  const freshCosts = attempts.map((row) => row.freshCost).filter((value): value is number => value != null);
  const actualCosts = attempts.map((row) => row.actualPairCost).filter((value): value is number => value != null);
  const latencies = attempts.map((row) => row.submitLatencyMs).filter((value): value is number => value != null);
  const summary = {
    runAt,
    bucket: bucketLabel(),
    observedInBucket,
    attempted,
    cleanPairedFills: attempts.filter((row) => row.outcome === "clean_paired_fill").length,
    noFills: attempts.filter((row) => row.outcome === "no_fill").length,
    partialOrphans: attempts.filter((row) => row.outcome === "partial_orphan").length,
    preflightRejected: attempts.filter((row) => row.outcome === "preflight_rejected").length,
    sizingFailed: attempts.filter((row) => row.outcome === "sizing_failed").length,
    submitRejected: attempts.filter((row) => row.outcome === "submit_rejected").length,
    medianWsCost: median(wsCosts),
    medianFreshCost: median(freshCosts),
    medianActualPairCost: median(actualCosts),
    medianSubmitLatencyMs: median(latencies),
    inBucketActual: attempts.filter((row) => row.inBucket === true).length,
  };
  console.log(`TEST_SUMMARY ${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
