// Shared monotonic-arb candidate discovery + evaluation.
//
// Extracted from polymarket-real-monotonic-executor.ts so the hourly executor
// and the always-on websocket daemon evaluate identical gates and build their
// watchlists the same way. Everything here is config-driven (no env reads, no
// module-level gate constants) so callers own their own thresholds.

export type Direction = "above" | "below";
export type BookLevel = { price?: string; size?: string };

export type GammaMarket = {
  id?: string;
  question?: string;
  description?: string;
  resolutionSource?: string;
  groupItemTitle?: string;
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
  acceptingOrders?: boolean;
};

export type GammaEvent = {
  slug?: string;
  title?: string;
  startDate?: string | null;
  createdAt?: string | null;
  closed?: boolean;
  active?: boolean;
  markets?: GammaMarket[];
};

export type Book = {
  tokenId: string;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  spread: number;
  // Per-market minimum order size returned by GET /book (Polymarket default 5).
  // Each leg is a separate order in its own market, so each must independently
  // clear its market's minimum.
  minOrderSize: number;
};

export type MarketQuote = {
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

export type Candidate = {
  foundAt: string;
  asset: string;
  eventSlug: string;
  eventTitle: string;
  packageId: string;
  direction: Direction;
  broad: MarketQuote;
  narrow: MarketQuote;
  packageCost: number;
  lockedEdge: number;
  availableSize: number;
  maxSpread: number;
  minLiquidity: number;
  jackpotPayoutPerShare: number;
  eligible: boolean;
  rejectionReasons: string[];
};

export interface ArbCoreConfig {
  /** CLOB host for /book reads, e.g. https://clob.polymarket.com */
  host: string;
  /** Gamma API base, e.g. https://gamma-api.polymarket.com */
  gammaApi: string;
  fetchTimeoutMs: number;
  marketConcurrency: number;
  eventConcurrency: number;
  allowedAssets: Set<string>;
  minEdge: number;
  maxSpread: number;
  minLiquidity: number;
  minAvailableShares: number;
}

export const EPSILON = 1e-9;

export function parseNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type ParsedMarket = {
  strike: number;
  direction: Direction;
  ladderKey: string;
  yesIndex: number;
  noIndex: number;
};

export function parseStrike(question: string, groupItemTitle = ""): { strike: number; direction: Direction } | null {
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

function normalizedOutcomeIndexes(outcomes: string[]): { yesIndex: number; noIndex: number } | null {
  const normalized = outcomes.map((outcome) => outcome.trim().toLowerCase());
  const yesIndex = normalized.findIndex((outcome) => outcome === "yes" || outcome === "over");
  const noIndex = normalized.findIndex((outcome) => outcome === "no" || outcome === "under");
  return yesIndex >= 0 && noIndex >= 0 ? { yesIndex, noIndex } : null;
}

function sportsSlugKind(eventSlug: string): "nba" | "mlb" | "soccer" | "tennis" | "womens-tennis" | "ufc" | null {
  if (eventSlug.startsWith("nba-")) return "nba";
  if (eventSlug.startsWith("mlb-")) return "mlb";
  if (eventSlug.startsWith("ufc-")) return "ufc";
  // ITF events are mixed-gender; Polymarket doesn't tag them men/women so we
  // group them with men's tennis for ladder/strategy purposes (shadow only).
  if (eventSlug.startsWith("atp-") || eventSlug.startsWith("itf-") || eventSlug.includes("tennis")) return "tennis";
  if (eventSlug.startsWith("wta-")) return "womens-tennis";
  // uel-* = Europa League, col-* = Europa Conference League game slugs.
  if (eventSlug.startsWith("fifwc-")
    || eventSlug.startsWith("mls-")
    || eventSlug.startsWith("uel-")
    || eventSlug.startsWith("col-")
    || eventSlug.includes("soccer")
    || eventSlug.includes("world-cup")
    || eventSlug.includes("fifa")
    || eventSlug.includes("uefa")) return "soccer";
  return null;
}

function parseSportsMarket(eventSlug: string, question: string, outcomes: string[]): ParsedMarket | null {
  const sport = sportsSlugKind(eventSlug);
  if (!sport) return null;
  const outcomeIndexes = normalizedOutcomeIndexes(outcomes);
  const slugKey = `${sport}:${eventSlug}`;

  const totalScopeKey = (scope: string | undefined) => {
    const normalized = (scope ?? "").trim().toLowerCase();
    if (!normalized) return "full-game";
    if (normalized === "1h" || normalized === "1st half" || normalized === "first half") return "first-half";
    if (normalized === "2h" || normalized === "2nd half" || normalized === "second half") return "second-half";
    return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  };
  const teamKey = (team: string) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // UFC fight totals: "O/U 2.5 Rounds" (no "<A> vs. <B>:" prefix; one fight per event slug).
  const ufcRoundsTotal = question.match(/^O\/U\s+([0-9]+(?:\.5)?)\s+Rounds$/i);
  if (sport === "ufc") {
    if (!ufcRoundsTotal || !outcomeIndexes) return null;
    return {
      strike: parseNumber(ufcRoundsTotal[1]),
      direction: "above",
      ladderKey: `sports:${slugKey}:total:rounds`,
      ...outcomeIndexes,
    };
  }

  const fullGameTotal = question.match(/^.+?\s+vs\.?\s+.+?:\s*O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (fullGameTotal && outcomeIndexes) {
    return {
      strike: parseNumber(fullGameTotal[1]),
      direction: "above",
      ladderKey: `sports:${slugKey}:total:full-game`,
      ...outcomeIndexes,
    };
  }

  const tennisMatchTotal = question.match(/^.+?\s+vs\.?\s+.+?:\s*Match\s+O\/U\s+([0-9]+(?:\.5)?)$/i);
  if ((sport === "tennis" || sport === "womens-tennis") && tennisMatchTotal && outcomeIndexes) {
    return {
      strike: parseNumber(tennisMatchTotal[1]),
      direction: "above",
      ladderKey: `sports:${slugKey}:total:match`,
      ...outcomeIndexes,
    };
  }

  if ((sport === "tennis" || sport === "womens-tennis") && /\bSet\s+\d+\s+Games\s+O\/U\s+[0-9]/i.test(question)) {
    return null;
  }

  const scopedTotal = question.match(/^.+?\s+vs\.?\s+.+?:\s*(1H|1st Half|First Half|2H|2nd Half|Second Half)\s+O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (scopedTotal && outcomeIndexes) {
    return {
      strike: parseNumber(scopedTotal[2]),
      direction: "above",
      ladderKey: `sports:${slugKey}:total:${totalScopeKey(scopedTotal[1])}`,
      ...outcomeIndexes,
    };
  }

  const teamTotal = question.match(/^(.+?)\s+vs\.?\s+(.+?):\s*(.+?)\s+(?:(1H|1st Half|First Half|2H|2nd Half|Second Half)\s+)?O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (teamTotal && outcomeIndexes) {
    return {
      strike: parseNumber(teamTotal[5]),
      direction: "above",
      ladderKey: `sports:${slugKey}:team-total:${totalScopeKey(teamTotal[4])}:${teamKey(teamTotal[3])}`,
      ...outcomeIndexes,
    };
  }

  const spread = question.match(/^(1H\s+)?Spread:\s+(.+?)\s+\(-?([0-9]+(?:\.5)?)\)$/i);
  if (spread) {
    const normalized = outcomes.map((outcome) => outcome.trim().toLowerCase());
    const team = spread[2].trim();
    const yesIndex = normalized.findIndex((outcome) => outcome === team.toLowerCase());
    const noIndex = normalized.findIndex((_, index) => index !== yesIndex);
    if (yesIndex >= 0 && noIndex >= 0) {
      return {
        strike: parseNumber(spread[3]),
        direction: "above",
        ladderKey: `sports:${slugKey}:spread:${spread[1] ? "first-half" : "full-game"}:${teamKey(team)}`,
        yesIndex,
        noIndex,
      };
    }
  }

  const prop = question.match(/^(.+?):\s*(Points|Rebounds|Assists)\s+O\/U\s+([0-9]+(?:\.5)?)$/i);
  if (prop && outcomeIndexes) {
    const player = prop[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const stat = prop[2].toLowerCase();
    return {
      strike: parseNumber(prop[3]),
      direction: "above",
      ladderKey: `sports:nba:nyk-sas:prop:${player}:${stat}`,
      ...outcomeIndexes,
    };
  }

  return null;
}

function parseMarket(eventSlug: string, question: string, groupItemTitle: string, outcomes: string[]): ParsedMarket | null {
  const sports = parseSportsMarket(eventSlug, question, outcomes);
  if (sports) return sports;
  // Sports events must never fall through to the generic strike parser:
  // unrelated per-team markets ("run scored in the first inning?: <team>")
  // parse to identical strikes on a shared ladderKey, producing false
  // "monotonic" pairs across different questions (observed on
  // mlb-atl-cws-2026-06-11 at packageCost 0.72 — not an arb).
  if (sportsSlugKind(eventSlug)) return null;

  const parsed = parseStrike(question, groupItemTitle);
  const indexes = normalizedOutcomeIndexes(outcomes);
  if (!parsed || !indexes) return null;
  return {
    ...parsed,
    ladderKey: `${eventSlug}:${parsed.direction}`,
    ...indexes,
  };
}

export function polymarketAssetForSlug(slug: string): string | null {
  if (slug.startsWith("nba-")) return "NBA";
  if (slug.startsWith("mlb-")) return "MLB";
  if (slug.startsWith("atp-") || slug.startsWith("itf-") || slug.includes("tennis")) return "TENNIS";
  if (slug.startsWith("wta-")) return "WOMENS_TENNIS";
  if (slug.startsWith("ufc-")) return "UFC";
  if (sportsSlugKind(slug) === "soccer") return "SOCCER";
  if (slug.includes("spacex-ipo-closing-market-cap-above")) return "FINANCE";
  if (slug.includes("bitcoin")) return "BTC";
  if (slug.includes("ethereum")) return "ETH";
  if (slug.includes("solana")) return "SOL";
  if (slug.includes("hyperliquid")) return "HYPE";
  if (slug.startsWith("gc-") || slug.includes("gold-gc") || slug.includes("xauusd")) return "GOLD";
  if (slug.startsWith("spx-") || slug.includes("s-p-500") || slug.includes("sp-500")) return "SPY";
  if (slug.startsWith("si-") || slug.includes("silver") || slug.includes("xagusd")) return "SILVER";
  if (slug.startsWith("cl-") || slug.includes("wti") || slug.includes("crude-oil")) return "OIL";
  if (slug.includes("amazon") || slug.includes("amzn")) return "AMZN";
  if (slug.includes("-xrp-")) return "XRP";
  if (slug.includes("dogecoin") || slug.includes("-doge-")) return "DOGE";
  if (slug.includes("-bnb-")) return "BNB";
  if (slug.startsWith("ng-") || slug.includes("-ng-") || slug.includes("natural-gas")) return "NATGAS";
  // Generic ladder families ("what price will <ticker> hit ...", "will <ticker>
  // hit week of ..."): derive the asset from the ticker so newly listed ladders
  // are tradable without a code change per asset.
  const generic = slug.match(/^what-price-will-([a-z0-9]+)-hit/) ?? slug.match(/^will-([a-z0-9]+)-hit-(?:week|by)/);
  if (generic) return generic[1].toUpperCase();
  return null;
}

export function isNestedLadderEvent(slug: string, title = ""): boolean {
  if (sportsSlugKind(slug)) return true;
  const haystack = `${slug} ${title}`.toLowerCase();
  if (haystack.includes("settle") || haystack.includes("final trading day") || haystack.includes("over-under")) return false;
  if (haystack.includes("range") || /\$\d+(?:\.\d+)?\s*-\s*\$?\d+(?:\.\d+)?/.test(haystack)) return false;
  return haystack.includes("hit") || haystack.includes("reach") || haystack.includes("dip") || haystack.includes("above");
}

function resolutionTemplate(quote: MarketQuote): string {
  return quote.description
    .toLowerCase()
    .replace(/\$?\d[\d,]*(?:\.\d+)?/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

function resolutionMatches(a: MarketQuote, b: MarketQuote): boolean {
  const aSource = a.resolutionSource.trim().toLowerCase();
  const bSource = b.resolutionSource.trim().toLowerCase();
  if (aSource && bSource && aSource !== bSource) return false;
  const aTemplate = resolutionTemplate(a);
  const bTemplate = resolutionTemplate(b);
  return !aTemplate || !bTemplate || aTemplate === bTemplate;
}

export function bestLevel(levels: BookLevel[] | undefined, side: "bid" | "ask"): { price: number; size: number } {
  const parsed = (levels ?? [])
    .map((level) => ({ price: parseNumber(level.price), size: parseNumber(level.size) }))
    .filter((level) => level.price > 0 && level.size > 0);
  if (parsed.length === 0) return { price: 0, size: 0 };
  return parsed.reduce((best, level) => side === "bid"
    ? (level.price > best.price ? level : best)
    : (level.price < best.price ? level : best));
}

export async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "polymarket-real-monotonic-executor/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${res.statusText}`);
    return res.json();
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error(`${url} -> timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const DEFAULT_MIN_ORDER_SIZE = 5;

export function parseMinOrderSize(value: unknown): number {
  const parsed = parseNumber(value);
  return parsed > 0 ? parsed : DEFAULT_MIN_ORDER_SIZE;
}

function emptyBook(tokenId: string): Book {
  return {
    tokenId,
    bid: 0,
    bidSize: 0,
    ask: 0,
    askSize: 0,
    spread: 0,
    minOrderSize: DEFAULT_MIN_ORDER_SIZE,
  };
}

export async function fetchBook(config: ArbCoreConfig, tokenId: string): Promise<Book> {
  const book = await fetchJson(`${config.host}/book?${new URLSearchParams({ token_id: tokenId })}`, config.fetchTimeoutMs);
  const bid = bestLevel(book.bids, "bid");
  const ask = bestLevel(book.asks, "ask");
  return {
    tokenId,
    bid: bid.price,
    bidSize: bid.size,
    ask: ask.price,
    askSize: ask.size,
    spread: bid.price > 0 && ask.price > 0 ? Math.max(0, ask.price - bid.price) : 0,
    minOrderSize: parseMinOrderSize(book.min_order_size),
  };
}

export function structuralMarketQuote(event: GammaEvent, market: GammaMarket): MarketQuote | null {
  const eventSlug = event.slug ?? "";
  const marketId = String(market.id ?? "");
  const question = market.question ?? "";
  if (!eventSlug || !marketId || !question || market.closed || market.active === false || market.acceptingOrders === false) return null;
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const parsed = parseMarket(eventSlug, question, market.groupItemTitle ?? "", outcomes);
  if (!parsed) return null;
  const { yesIndex, noIndex } = parsed;
  if (yesIndex < 0 || noIndex < 0 || !tokenIds[yesIndex] || !tokenIds[noIndex]) return null;
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
    endDate: market.endDate ?? null,
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    yesTokenId: tokenIds[yesIndex],
    noTokenId: tokenIds[noIndex],
    yesBook: emptyBook(tokenIds[yesIndex]),
    noBook: emptyBook(tokenIds[noIndex]),
  };
}

export async function marketQuote(config: ArbCoreConfig, event: GammaEvent, market: GammaMarket): Promise<MarketQuote | null> {
  const eventSlug = event.slug ?? "";
  const marketId = String(market.id ?? "");
  const question = market.question ?? "";
  if (!eventSlug || !marketId || !question || market.closed || market.active === false || market.acceptingOrders === false) return null;
  const outcomes = parseJsonArray(market.outcomes).map(String);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const parsed = parseMarket(eventSlug, question, market.groupItemTitle ?? "", outcomes);
  if (!parsed) return null;
  const { yesIndex, noIndex } = parsed;
  if (yesIndex < 0 || noIndex < 0 || !tokenIds[yesIndex] || !tokenIds[noIndex]) return null;
  const [yesBook, noBook] = await Promise.all([fetchBook(config, tokenIds[yesIndex]), fetchBook(config, tokenIds[noIndex])]);
  if (yesBook.bid <= 0 || yesBook.ask <= 0 || noBook.bid <= 0 || noBook.ask <= 0) return null;
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
    endDate: market.endDate ?? null,
    liquidity: parseNumber(market.liquidityNum ?? market.liquidity),
    yesTokenId: tokenIds[yesIndex],
    noTokenId: tokenIds[noIndex],
    yesBook,
    noBook,
  };
}

export function evaluatePair(config: ArbCoreConfig, asset: string, broad: MarketQuote, narrow: MarketQuote, foundAt: string): Candidate {
  const packageCost = broad.yesBook.ask + narrow.noBook.ask;
  const lockedEdge = 1 - packageCost;
  // Match the paper/live-sim monotonic arb gate: both underlying YES markets
  // must be tight. The executed NO leg is the complement of the narrow YES,
  // and its own CLOB bid/ask spread can look artificially wide even when the
  // narrow YES bid that creates the NO ask is tight and deep.
  const maxSpread = Math.max(broad.yesBook.spread, narrow.yesBook.spread);
  const minLiquidity = Math.min(broad.liquidity, narrow.liquidity);
  const availableSize = Math.min(broad.yesBook.askSize, narrow.noBook.askSize);
  const rejectionReasons: string[] = [];
  if (!config.allowedAssets.has("ALL") && !config.allowedAssets.has(asset)) rejectionReasons.push("asset_not_allowlisted");
  if (broad.ladderKey !== narrow.ladderKey) rejectionReasons.push("ladder_mismatch");
  if (broad.endDate && narrow.endDate && broad.endDate !== narrow.endDate) rejectionReasons.push("expiry_mismatch");
  if (!resolutionMatches(broad, narrow)) rejectionReasons.push("resolution_mismatch");
  if (lockedEdge + EPSILON < config.minEdge) rejectionReasons.push("edge_below_threshold");
  if (maxSpread - EPSILON > config.maxSpread) rejectionReasons.push("wide_spread");
  if (minLiquidity + EPSILON < config.minLiquidity) rejectionReasons.push("low_liquidity");
  if (availableSize + EPSILON < config.minAvailableShares) rejectionReasons.push("insufficient_top_of_book_size");
  return {
    foundAt,
    asset,
    eventSlug: broad.eventSlug,
    eventTitle: broad.eventTitle,
    packageId: `${broad.eventSlug}::YES-${broad.marketId}+NO-${narrow.marketId}`,
    direction: broad.direction,
    broad,
    narrow,
    packageCost,
    lockedEdge,
    availableSize,
    maxSpread,
    minLiquidity,
    jackpotPayoutPerShare: broad.marketId === narrow.marketId ? 1 : 2,
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

export async function fetchEvent(config: ArbCoreConfig, slug: string): Promise<GammaEvent | null> {
  const events = await fetchJson(`${config.gammaApi}/events?slug=${encodeURIComponent(slug)}`, config.fetchTimeoutMs);
  return Array.isArray(events) && events.length > 0 ? events[0] as GammaEvent : null;
}

export async function scanEvent(config: ArbCoreConfig, slug: string, foundAt: string): Promise<Candidate[]> {
  const event = await fetchEvent(config, slug);
  if (!event?.slug) return [];
  if (event.closed || event.active === false) return [];
  const asset = polymarketAssetForSlug(event.slug);
  if (!asset || !isNestedLadderEvent(event.slug, event.title ?? "")) return [];
  const quotes = (await mapLimit(event.markets ?? [], config.marketConcurrency, (market) => marketQuote(config, event, market)))
    .filter((quote): quote is MarketQuote => quote !== null);
  const candidates: Candidate[] = [];
  for (const direction of ["above", "below"] as const) {
    const ladderKeys = [...new Set(quotes.filter((quote) => quote.direction === direction).map((quote) => quote.ladderKey))];
    for (const ladderKey of ladderKeys) {
      const directional = quotes
        .filter((quote) => quote.direction === direction && quote.ladderKey === ladderKey)
        .sort((a, b) => a.strike - b.strike);
      for (let i = 0; i < directional.length; i++) {
        for (let j = i + 1; j < directional.length; j++) {
          const lower = directional[i];
          const higher = directional[j];
          const broad = direction === "above" ? lower : higher;
          const narrow = direction === "above" ? higher : lower;
          const candidate = evaluatePair(config, asset, broad, narrow, foundAt);
          // Return every structurally-valid ladder pair to callers. The always-on
          // websocket daemon needs to subscribe before an edge exists, then apply
          // the live arb gate on each book delta. Hourly callers can still filter
          // to `candidate.eligible` at execution time.
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

export async function scanEventStructural(config: ArbCoreConfig, slug: string, foundAt: string): Promise<Candidate[]> {
  const event = await fetchEvent(config, slug);
  if (!event?.slug) return [];
  if (event.closed || event.active === false) return [];
  const asset = polymarketAssetForSlug(event.slug);
  if (!asset || !isNestedLadderEvent(event.slug, event.title ?? "")) return [];
  const quotes = (event.markets ?? [])
    .map((market) => structuralMarketQuote(event, market))
    .filter((quote): quote is MarketQuote => quote !== null);
  const candidates: Candidate[] = [];
  for (const direction of ["above", "below"] as const) {
    const ladderKeys = [...new Set(quotes.filter((quote) => quote.direction === direction).map((quote) => quote.ladderKey))];
    for (const ladderKey of ladderKeys) {
      const directional = quotes
        .filter((quote) => quote.direction === direction && quote.ladderKey === ladderKey)
        .sort((a, b) => a.strike - b.strike);
      for (let i = 0; i < directional.length; i++) {
        for (let j = i + 1; j < directional.length; j++) {
          const lower = directional[i];
          const higher = directional[j];
          const broad = direction === "above" ? lower : higher;
          const narrow = direction === "above" ? higher : lower;
          candidates.push(evaluatePair(config, asset, broad, narrow, foundAt));
        }
      }
    }
  }
  return candidates;
}

/**
 * Discover monotonic-arb candidates across the given event slugs. Mirrors the
 * old executor `scanCandidates()` exactly (concurrency, per-slug error capture).
 */
export async function findCandidates(
  config: ArbCoreConfig,
  slugs: string[],
  foundAt: string,
): Promise<{ candidates: Candidate[]; errors: string[] }> {
  const scans = await mapLimit(slugs, config.eventConcurrency, async (slug) => {
    try {
      return { slug, candidates: await scanEvent(config, slug, foundAt), error: null as string | null };
    } catch (error: any) {
      return { slug, candidates: [] as Candidate[], error: error?.message ?? String(error) };
    }
  });
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  for (const scan of scans) {
    candidates.push(...scan.candidates);
    if (scan.error) errors.push(`${scan.slug}: ${scan.error}`);
  }
  return { candidates, errors };
}

export async function findStructuralCandidates(
  config: ArbCoreConfig,
  slugs: string[],
  foundAt: string,
): Promise<{ candidates: Candidate[]; errors: string[] }> {
  const scans = await mapLimit(slugs, config.eventConcurrency, async (slug) => {
    try {
      return { slug, candidates: await scanEventStructural(config, slug, foundAt), error: null as string | null };
    } catch (error: any) {
      return { slug, candidates: [] as Candidate[], error: error?.message ?? String(error) };
    }
  });
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  for (const scan of scans) {
    candidates.push(...scan.candidates);
    if (scan.error) errors.push(`${scan.slug}: ${scan.error}`);
  }
  return { candidates, errors };
}

export function defaultEventSlugs(now = new Date()): string[] {
  const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
  const year = now.getUTCFullYear();
  return [
    "what-price-will-bitcoin-hit-before-2027",
    "what-price-will-ethereum-hit-before-2027",
    "what-price-will-solana-hit-before-2027",
    "what-price-will-hyperliquid-hit-before-2027",
    "what-will-gold-gc-hit-by-end-of-december",
    "gc-hit-jun-2026",
    "spx-hit-jun-2026",
    "spx-hit-dec-2026",
    "si-hit-jun-2026",
    "spacex-ipo-closing-market-cap-above",
    "nba-nyk-sas-2026-06-05",
    `what-price-will-bitcoin-hit-in-${month}-${year}`,
    `what-price-will-ethereum-hit-in-${month}-${year}`,
    `what-price-will-solana-hit-in-${month}-${year}`,
    `what-price-will-xauusd-hit-in-${month}-${year}`,
  ].filter((slug, idx, arr) => arr.indexOf(slug) === idx);
}
