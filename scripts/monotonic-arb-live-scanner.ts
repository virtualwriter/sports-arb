import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const DATA_DIR = join(ROOT, "data");
const CANDIDATES_PATH = join(DATA_DIR, "monotonic-arb-live-candidates.json");
const BLOCKED_SIGNALS_PATH = join(DATA_DIR, "blocked-signals.json");
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

const DEFAULT_MIN_EDGE = Number(process.env.MONOTONIC_ARB_LIVE_MIN_EDGE ?? 0.001);
const DEFAULT_MIN_LIQUIDITY = Number(process.env.MONOTONIC_ARB_LIVE_MIN_LIQUIDITY ?? 10_000);
const DEFAULT_MAX_SPREAD = Number(process.env.MONOTONIC_ARB_LIVE_MAX_SPREAD ?? 0.01);
const DEFAULT_MIN_SIZE = Number(process.env.MONOTONIC_ARB_LIVE_MIN_SIZE ?? 5);
const DEFAULT_MAX_MARKETS_PER_EVENT = Number(process.env.MONOTONIC_ARB_LIVE_MAX_MARKETS_PER_EVENT ?? 40);
const TRADE_SIZE = 1;

type Direction = "above" | "below";
type Side = "yes" | "no";

type GammaMarket = {
  id?: string;
  question?: string;
  description?: string;
  resolutionSource?: string;
  groupItemTitle?: string;
  outcomePrices?: string;
  outcomes?: string;
  clobTokenIds?: string;
  volume?: string | number;
  liquidity?: string | number;
  liquidityNum?: number;
  startDate?: string | null;
  createdAt?: string | null;
  endDate?: string | null;
  active?: boolean;
  closed?: boolean;
};

type GammaEvent = {
  slug?: string;
  title?: string;
  startDate?: string | null;
  createdAt?: string | null;
  markets?: GammaMarket[];
};

type BookLevel = {
  price?: string;
  size?: string;
};

type Book = {
  tokenId: string;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  spread: number;
  timestamp?: string;
  hash?: string;
};

type MarketQuote = {
  eventSlug: string;
  eventTitle: string;
  marketId: string;
  question: string;
  description: string;
  resolutionSource: string;
  strike: number;
  direction: Direction;
  startDate: string | null;
  endDate: string | null;
  liquidity: number;
  volume: number;
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
  broadMarketId: string;
  narrowMarketId: string;
  broadStartDate: string | null;
  narrowStartDate: string | null;
  broadStrike: number;
  narrowStrike: number;
  broadYesAsk: number;
  broadYesAskSize: number;
  narrowNoAsk: number;
  narrowNoAskSize: number;
  packageCost: number;
  lockedEdge: number;
  lockedEdgeCents: number;
  availableSize: number;
  minLiquidity: number;
  maxSpread: number;
  resolutionSource: string;
  expiryDate: string | null;
  eligible: boolean;
  rejectionReasons: string[];
  questions: {
    broad: string;
    narrow: string;
  };
};

type JsonObject = Record<string, any>;

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

const DRY_RUN = process.argv.includes("--dry-run");
const NO_SHADOW = process.argv.includes("--no-shadow");
const MIN_EDGE = Number(argValue("--min-edge") ?? DEFAULT_MIN_EDGE);
const MIN_LIQUIDITY = Number(argValue("--min-liquidity") ?? DEFAULT_MIN_LIQUIDITY);
const MAX_SPREAD = Number(argValue("--max-spread") ?? DEFAULT_MAX_SPREAD);
const MIN_SIZE = Number(argValue("--min-size") ?? DEFAULT_MIN_SIZE);

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function monthSlug(date: Date): string {
  return date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
}

function currentMonthTouchEventSlugs(now = new Date()): string[] {
  const months = [addMonths(now, 0), addMonths(now, 1)];
  return months.flatMap((date) => {
    const month = monthSlug(date);
    const year = date.getUTCFullYear();
    return [
      `what-price-will-bitcoin-hit-in-${month}-${year}`,
      `what-price-will-ethereum-hit-in-${month}-${year}`,
      `what-price-will-solana-hit-in-${month}-${year}`,
      `what-price-will-xauusd-hit-in-${month}-${year}`,
      `what-price-will-amzn-hit-in-${month}-${year}`,
      `what-price-will-spx-hit-in-${month}-${year}`,
      `what-price-will-cl-hit-in-${month}-${year}`,
      `what-price-will-wti-hit-in-${month}-${year}`,
    ];
  });
}

const DEFAULT_EVENT_SLUGS = [
  "what-price-will-bitcoin-hit-before-2027",
  "what-price-will-ethereum-hit-before-2027",
  "what-price-will-solana-hit-before-2027",
  "what-price-will-hyperliquid-hit-before-2027",
  "what-will-gold-gc-hit-by-end-of-december",
  "gc-hit-jun-2026",
  "spx-hit-jun-2026",
  "spx-hit-dec-2026",
  "si-hit-jun-2026",
  "cl-hit-jun-2026",
  ...currentMonthTouchEventSlugs(),
].filter((slug, index, slugs) => slugs.indexOf(slug) === index);

function eventSlugs(): string[] {
  const override = process.env.MONOTONIC_ARB_LIVE_EVENT_SLUGS;
  if (!override) return DEFAULT_EVENT_SLUGS;
  return override.split(",").map((slug) => slug.trim()).filter(Boolean);
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "monotonic-arb-live-scanner/1.0" } });
  if (!response.ok) throw new Error(`${url} -> ${response.status} ${response.statusText}`);
  return response.json();
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

function parseStrike(question: string, groupItemTitle = ""): { strike: number; direction: Direction } | null {
  const text = `${groupItemTitle} ${question}`;
  const value = text.match(/\$?\s*([0-9][0-9,]*(?:\.\d+)?)/);
  if (!value) return null;
  const strike = parseNumber(value[1]);
  if (!strike) return null;
  const lower = text.toLowerCase();
  const down = lower.includes("↓") || lower.includes(" low") || lower.includes("(low)") || lower.includes(" dip") || lower.includes("below");
  const up = lower.includes("↑") || lower.includes(" high") || lower.includes("(high)") || lower.includes(" hit") || lower.includes("reach") || lower.includes("above");
  if (down && !up) return { strike, direction: "below" };
  if (groupItemTitle.includes("↓") || lower.includes("(low)") || lower.includes(" dip")) return { strike, direction: "below" };
  return { strike, direction: "above" };
}

function polymarketAssetForSlug(slug: string): string | null {
  if (slug.includes("bitcoin")) return "BTC";
  if (slug.includes("ethereum")) return "ETH";
  if (slug.includes("solana")) return "SOL";
  if (slug.includes("hyperliquid")) return "HYPE";
  if (slug.startsWith("gc-") || slug.includes("gold-gc") || slug.includes("xauusd")) return "GOLD";
  if (slug.startsWith("spx-") || slug.includes("s-p-500") || slug.includes("sp-500")) return "SPY";
  if (slug.startsWith("cl-") || slug.includes("wti") || slug.includes("crude-oil")) return "OIL";
  if (slug.startsWith("si-") || slug.includes("silver") || slug.includes("xagusd")) return "SILVER";
  if (slug.includes("amazon") || slug.includes("amzn")) return "AMZN";
  return null;
}

function isNestedLadderEvent(slug: string, title = ""): boolean {
  const haystack = `${slug} ${title}`.toLowerCase();
  if (haystack.includes("settle") || haystack.includes("final trading day") || haystack.includes("over-under")) return false;
  if (haystack.includes("range") || /\$\d+(?:\.\d+)?\s*-\s*\$?\d+(?:\.\d+)?/.test(haystack)) return false;
  return haystack.includes("hit") || haystack.includes("reach") || haystack.includes("dip");
}

function normalizedResolutionSource(market: MarketQuote): string {
  return market.resolutionSource.trim().toLowerCase();
}

function normalizedResolutionTemplate(market: MarketQuote): string {
  return market.description
    .toLowerCase()
    .replace(/\$?\d[\d,]*(?:\.\d+)?/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

function resolutionMatches(broad: MarketQuote, narrow: MarketQuote): boolean {
  const broadSource = normalizedResolutionSource(broad);
  const narrowSource = normalizedResolutionSource(narrow);
  if (broadSource && narrowSource && broadSource !== narrowSource) return false;

  const broadTemplate = normalizedResolutionTemplate(broad);
  const narrowTemplate = normalizedResolutionTemplate(narrow);
  if (broadTemplate && narrowTemplate && broadTemplate !== narrowTemplate) return false;

  return true;
}

function bestLevel(levels: BookLevel[] | undefined, side: "bid" | "ask"): { price: number; size: number } {
  const parsed = (levels ?? [])
    .map((level) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  if (parsed.length === 0) return { price: 0, size: 0 };
  return parsed.reduce((best, level) => side === "bid"
    ? (level.price > best.price ? level : best)
    : (level.price < best.price ? level : best));
}

async function fetchBook(tokenId: string): Promise<Book> {
  const url = `${CLOB_BOOK_URL}?${new URLSearchParams({ token_id: tokenId })}`;
  const book = await fetchJson(url);
  const bid = bestLevel(book.bids, "bid");
  const ask = bestLevel(book.asks, "ask");
  return {
    tokenId,
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    spread: bid.price > 0 && ask.price > 0 ? Math.max(0, ask.price - bid.price) : 0,
    timestamp: book.timestamp,
    hash: book.hash,
  };
}

async function fetchEvent(slug: string): Promise<GammaEvent | null> {
  const events = await fetchJson(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`);
  return Array.isArray(events) && events.length > 0 ? events[0] : null;
}

async function marketQuote(event: GammaEvent, market: GammaMarket): Promise<MarketQuote | null> {
  const eventSlug = event.slug ?? "";
  const marketId = String(market.id ?? "");
  const question = market.question ?? "";
  if (!eventSlug || !marketId || !question || market.closed || market.active === false) return null;

  const parsed = parseStrike(question, market.groupItemTitle ?? "");
  if (!parsed) return null;

  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");
  if (yesIndex < 0 || noIndex < 0 || !tokenIds[yesIndex] || !tokenIds[noIndex]) return null;

  const [yesBook, noBook] = await Promise.all([fetchBook(tokenIds[yesIndex]), fetchBook(tokenIds[noIndex])]);
  if (yesBook.bid <= 0 || yesBook.ask <= 0 || noBook.bid <= 0 || noBook.ask <= 0) return null;

  return {
    eventSlug,
    eventTitle: event.title ?? eventSlug,
    marketId,
    question,
    description: market.description ?? "",
    resolutionSource: market.resolutionSource ?? "",
    strike: parsed.strike,
    direction: parsed.direction,
    startDate: market.startDate ?? market.createdAt ?? event.startDate ?? event.createdAt ?? null,
    endDate: market.endDate ?? null,
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    volume: parseNumber(market.volume),
    yesTokenId: tokenIds[yesIndex],
    noTokenId: tokenIds[noIndex],
    yesBook,
    noBook,
  };
}

function evaluatePair(asset: string, broad: MarketQuote, narrow: MarketQuote, foundAt: string): Candidate {
  const packageCost = broad.yesBook.ask + narrow.noBook.ask;
  const lockedEdge = 1 - packageCost;
  const maxSpread = Math.max(broad.yesBook.spread, narrow.noBook.spread);
  const minLiquidity = Math.min(broad.liquidity, narrow.liquidity);
  const availableSize = Math.min(broad.yesBook.askSize, narrow.noBook.askSize);
  const rejectionReasons: string[] = [];

  if (broad.endDate && narrow.endDate && broad.endDate !== narrow.endDate) rejectionReasons.push("expiry_mismatch");
  if (!resolutionMatches(broad, narrow)) rejectionReasons.push("resolution_mismatch");
  if (lockedEdge < MIN_EDGE) rejectionReasons.push("edge_below_threshold");
  if (maxSpread > MAX_SPREAD) rejectionReasons.push("wide_spread");
  if (minLiquidity < MIN_LIQUIDITY) rejectionReasons.push("low_liquidity");
  if (availableSize < MIN_SIZE) rejectionReasons.push("insufficient_top_of_book_size");

  return {
    foundAt,
    asset,
    eventSlug: broad.eventSlug,
    eventTitle: broad.eventTitle,
    packageId: `${broad.eventSlug}::YES-${broad.marketId}+NO-${narrow.marketId}`,
    direction: broad.direction,
    broadMarketId: broad.marketId,
    narrowMarketId: narrow.marketId,
    broadStartDate: broad.startDate,
    narrowStartDate: narrow.startDate,
    broadStrike: broad.strike,
    narrowStrike: narrow.strike,
    broadYesAsk: broad.yesBook.ask,
    broadYesAskSize: broad.yesBook.askSize,
    narrowNoAsk: narrow.noBook.ask,
    narrowNoAskSize: narrow.noBook.askSize,
    packageCost,
    lockedEdge,
    lockedEdgeCents: lockedEdge * 100,
    availableSize,
    minLiquidity,
    maxSpread,
    resolutionSource: broad.resolutionSource,
    expiryDate: broad.endDate || narrow.endDate,
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
    questions: {
      broad: broad.question,
      narrow: narrow.question,
    },
  };
}

async function scanEvent(slug: string, foundAt: string): Promise<Candidate[]> {
  const event = await fetchEvent(slug);
  if (!event?.slug) return [];
  const asset = polymarketAssetForSlug(event.slug);
  if (!asset || !isNestedLadderEvent(event.slug, event.title ?? "")) return [];

  const markets = (event.markets ?? []).slice(0, DEFAULT_MAX_MARKETS_PER_EVENT);
  const quotes = (await Promise.all(markets.map((market) => marketQuote(event, market))))
    .filter((quote): quote is MarketQuote => quote !== null);
  const candidates: Candidate[] = [];

  for (const direction of ["above", "below"] as const) {
    const directional = quotes
      .filter((quote) => quote.direction === direction)
      .sort((a, b) => a.strike - b.strike);
    for (let i = 0; i < directional.length; i++) {
      for (let j = i + 1; j < directional.length; j++) {
        const lower = directional[i];
        const higher = directional[j];
        const broad = direction === "above" ? lower : higher;
        const narrow = direction === "above" ? higher : lower;
        const candidate = evaluatePair(asset, broad, narrow, foundAt);
        if (candidate.lockedEdge > 0 || candidate.eligible) candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function readJsonArray(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8")) as JsonObject[];
}

function candidateToShadow(candidate: Candidate): JsonObject {
  const now = candidate.foundAt;
  const thesis = `[MONOTONIC ARB SHADOW] Live CLOB scanner: buy YES on broader ${candidate.direction} strike ${candidate.broadStrike} @ ${candidate.broadYesAsk.toFixed(4)} and buy NO on narrower ${candidate.direction} strike ${candidate.narrowStrike} @ ${candidate.narrowNoAsk.toFixed(4)}. Locked edge ${(candidate.lockedEdge * 100).toFixed(2)}c per paired share; available size ${candidate.availableSize.toFixed(2)} shares; min liquidity ${candidate.minLiquidity.toFixed(0)}.`;
  return {
    id: `MA-LIVE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: "open",
    blockedAt: now,
    blockedReason: "monotonic_arb_shadow",
    signalType: "MONOTONIC_ARB",
    entrySource: "live_clob_scanner",
    asset: candidate.asset,
    venue: "polymarket",
    direction: "long",
    confidence: Number(Math.min(1, candidate.lockedEdge / 0.01).toFixed(4)),
    thesis,
    marketQuality: {
      yesBid: Number((1 - candidate.narrowNoAsk).toFixed(4)),
      yesAsk: Number(candidate.broadYesAsk.toFixed(4)),
      yesSpread: Number(candidate.maxSpread.toFixed(4)),
      liquidity: Number(candidate.minLiquidity.toFixed(2)),
      availableSize: Number(candidate.availableSize.toFixed(2)),
      flags: [],
    },
    learningParamsSnapshot: {
      macroMomentum24hThresholdPts: 4,
      contrarianTrendMarginPct: 0.5,
      positiveMomentum24hPct: 1.5,
      llmTradeExpiryDays: 14,
      momentumLongExpiryDays: 21,
      signalRisk: {},
    },
    position: {
      id: `MA-LIVE-POS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      openedAt: now,
      asset: candidate.asset,
      venue: "polymarket",
      direction: "long",
      entryPrice: candidate.packageCost,
      currentPrice: candidate.packageCost,
      size: TRADE_SIZE,
      leverage: 1,
      signalType: "MONOTONIC_ARB",
      hypothesisId: null,
      thesis,
      targetPct: null,
      stopPct: 100,
      expiryDate: candidate.expiryDate ?? new Date(Date.now() + 30 * 86400000).toISOString(),
      instrumentType: "pm_package",
      instrumentId: candidate.packageId,
      instrumentLabel: `${candidate.eventSlug} — monotonic arb package — YES ${candidate.broadStrike} / NO ${candidate.narrowStrike}`,
      packageLegs: [
        {
          role: "broad_yes",
          instrumentType: "pm_yes",
          instrumentId: `${candidate.eventSlug}::${candidate.broadMarketId}`,
          instrumentLabel: `${candidate.eventSlug} — YES — ${candidate.questions.broad}`,
          entryPrice: candidate.broadYesAsk,
          strike: candidate.broadStrike,
          direction: candidate.direction,
          yesAsk: candidate.broadYesAsk,
          yesAskSize: candidate.broadYesAskSize,
          startDate: candidate.broadStartDate,
        },
        {
          role: "narrow_no",
          instrumentType: "pm_no",
          instrumentId: `${candidate.eventSlug}::${candidate.narrowMarketId}`,
          instrumentLabel: `${candidate.eventSlug} — NO — ${candidate.questions.narrow}`,
          entryPrice: candidate.narrowNoAsk,
          strike: candidate.narrowStrike,
          direction: candidate.direction,
          noAsk: candidate.narrowNoAsk,
          noAskSize: candidate.narrowNoAskSize,
          startDate: candidate.narrowStartDate,
        },
      ],
    },
    liveClobSnapshot: candidate,
  };
}

function appendEligibleShadows(candidates: Candidate[]): number {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (eligible.length === 0) return 0;
  const shadows = readJsonArray(BLOCKED_SIGNALS_PATH);
  const openPackageIds = new Set(shadows
    .filter((shadow) => shadow.status === "open" && shadow.signalType === "MONOTONIC_ARB")
    .map((shadow) => shadow.position?.instrumentId)
    .filter(Boolean));
  const newShadows = eligible
    .filter((candidate) => !openPackageIds.has(candidate.packageId))
    .map(candidateToShadow);
  if (newShadows.length === 0) return 0;
  writeFileSync(BLOCKED_SIGNALS_PATH, JSON.stringify([...shadows, ...newShadows], null, 2) + "\n");
  return newShadows.length;
}

async function main() {
  const foundAt = new Date().toISOString();
  const results = await Promise.allSettled(eventSlugs().map((slug) => scanEvent(slug, foundAt)));
  const candidates = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const payload = {
    generatedAt: foundAt,
    dryRun: DRY_RUN,
    thresholds: {
      minEdge: MIN_EDGE,
      minLiquidity: MIN_LIQUIDITY,
      maxSpread: MAX_SPREAD,
      minSize: MIN_SIZE,
    },
    candidateCount: candidates.length,
    eligibleCount: eligible.length,
    candidates: candidates
      .sort((a, b) => b.lockedEdge - a.lockedEdge)
      .slice(0, 100),
    errors: results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason?.message ?? result.reason)),
  };

  let appended = 0;
  if (!DRY_RUN) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(CANDIDATES_PATH, JSON.stringify(payload, null, 2) + "\n");
    if (!NO_SHADOW) appended = appendEligibleShadows(candidates);
  }

  console.log(`Scanned ${eventSlugs().length} events; ${candidates.length} positive-edge candidates; ${eligible.length} eligible.`);
  console.log(`Thresholds: edge>=${(MIN_EDGE * 100).toFixed(2)}c liquidity>=${MIN_LIQUIDITY} spread<=${MAX_SPREAD} size>=${MIN_SIZE}`);
  if (DRY_RUN) console.log("Dry run: did not write candidate file or shadow ledger.");
  else console.log(`Wrote ${CANDIDATES_PATH}; appended ${appended} shadow(s).`);
  for (const candidate of eligible.slice(0, 10)) {
    console.log(`  ${candidate.asset} ${candidate.packageId} edge=${candidate.lockedEdgeCents.toFixed(2)}c size=${candidate.availableSize.toFixed(2)} liq=${candidate.minLiquidity.toFixed(0)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
