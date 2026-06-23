/**
 * Live Polymarket CLOB top-of-book fetch + entry snapshot helpers.
 * Gamma snapshots often omit bestBidSize/bestAskSize; monotonic arbs need CLOB depth.
 */

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

export type ClobBook = {
  tokenId: string;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  spread: number;
};

export type EntryBookLegSnapshot = {
  role: "broad_yes" | "narrow_no" | "pm_yes" | "pm_no";
  marketId: string;
  yesBid: number;
  yesAsk: number;
  yesBidSize: number | null;
  yesAskSize: number | null;
  noBid: number | null;
  noAsk: number | null;
  noBidSize: number | null;
  noAskSize: number | null;
  liquidity: number | null;
};

export type EntryBookSnapshot = {
  capturedAt: string;
  source: "clob_live";
  packageCost?: number;
  lockedEdgeCents?: number;
  minLegLiquidity?: number;
  packageAvailableSize?: number | null;
  legs: EntryBookLegSnapshot[];
};

type BookLevel = { price?: string; size?: string };

function parseNumber(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
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

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "polymarket-clob-book/1.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function fetchClobBook(tokenId: string): Promise<ClobBook> {
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
  };
}

export async function fetchMarketTokenIds(marketId: string): Promise<{ yesTokenId: string; noTokenId: string } | null> {
  const markets = await fetchJson(`${GAMMA_API}/markets/${marketId}`);
  const market = Array.isArray(markets) ? markets[0] : markets;
  if (!market) return null;
  let outcomes: string[] = [];
  let tokenIds: string[] = [];
  try { outcomes = JSON.parse(market.outcomes ?? "[]").map(String); } catch { /* ignore */ }
  try { tokenIds = JSON.parse(market.clobTokenIds ?? "[]").map(String); } catch { /* ignore */ }
  const yesIndex = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((o) => o.toLowerCase() === "no");
  if (yesIndex < 0 || noIndex < 0 || !tokenIds[yesIndex] || !tokenIds[noIndex]) return null;
  return { yesTokenId: tokenIds[yesIndex], noTokenId: tokenIds[noIndex] };
}

export async function fetchMarketYesNoBooks(marketId: string): Promise<{
  yes: ClobBook;
  no: ClobBook;
  liquidity: number;
} | null> {
  const tokens = await fetchMarketTokenIds(marketId);
  if (!tokens) return null;
  const [yes, no] = await Promise.all([
    fetchClobBook(tokens.yesTokenId),
    fetchClobBook(tokens.noTokenId),
  ]);
  const markets = await fetchJson(`${GAMMA_API}/markets/${marketId}`);
  const market = Array.isArray(markets) ? markets[0] : markets;
  const liquidity = parseNumber(market?.liquidityNum ?? market?.liquidity);
  return { yes, no, liquidity };
}

export function legSnapshotFromYesBook(
  role: EntryBookLegSnapshot["role"],
  marketId: string,
  yes: ClobBook,
  liquidity: number | null,
): EntryBookLegSnapshot {
  return {
    role,
    marketId,
    yesBid: yes.bid,
    yesAsk: yes.ask,
    yesBidSize: yes.bidSize > 0 ? yes.bidSize : null,
    yesAskSize: yes.askSize > 0 ? yes.askSize : null,
    noBid: yes.ask > 0 ? Number((1 - yes.ask).toFixed(4)) : null,
    noAsk: yes.bid > 0 ? Number((1 - yes.bid).toFixed(4)) : null,
    noBidSize: yes.askSize > 0 ? yes.askSize : null,
    noAskSize: yes.bidSize > 0 ? yes.bidSize : null,
    liquidity,
  };
}

export async function buildPackageEntryBookSnapshot(
  broadMarketId: string,
  narrowMarketId: string,
  packageCost: number,
  lockedEdge: number,
): Promise<EntryBookSnapshot> {
  const [broadBooks, narrowBooks] = await Promise.all([
    fetchMarketYesNoBooks(broadMarketId),
    fetchMarketYesNoBooks(narrowMarketId),
  ]);
  const broadLeg = broadBooks
    ? legSnapshotFromYesBook("broad_yes", broadMarketId, broadBooks.yes, broadBooks.liquidity)
    : {
      role: "broad_yes" as const,
      marketId: broadMarketId,
      yesBid: 0,
      yesAsk: 0,
      yesBidSize: null,
      yesAskSize: null,
      noBid: null,
      noAsk: null,
      noBidSize: null,
      noAskSize: null,
      liquidity: null,
    };
  const narrowLeg = narrowBooks
    ? legSnapshotFromYesBook("narrow_no", narrowMarketId, narrowBooks.yes, narrowBooks.liquidity)
    : {
      role: "narrow_no" as const,
      marketId: narrowMarketId,
      yesBid: 0,
      yesAsk: 0,
      yesBidSize: null,
      yesAskSize: null,
      noBid: null,
      noAsk: null,
      noBidSize: null,
      noAskSize: null,
      liquidity: null,
    };
  const packageAvailableSize = broadLeg.yesAskSize !== null && narrowLeg.noAskSize !== null
    ? Math.min(broadLeg.yesAskSize, narrowLeg.noAskSize)
    : null;
  const minLegLiquidity = Math.min(
    broadLeg.liquidity ?? 0,
    narrowLeg.liquidity ?? 0,
  );
  return {
    capturedAt: new Date().toISOString(),
    source: "clob_live",
    packageCost,
    lockedEdgeCents: lockedEdge * 100,
    minLegLiquidity,
    packageAvailableSize,
    legs: [broadLeg, narrowLeg],
  };
}

export async function applyEntryBookToPackageLegs(
  packageLegs: Array<{
    role: "broad_yes" | "narrow_no";
    instrumentId: string;
    yesBid: number;
    yesAsk: number;
    yesBidSize?: number | null;
    yesAskSize?: number | null;
  }>,
): Promise<EntryBookSnapshot | null> {
  const broad = packageLegs.find((l) => l.role === "broad_yes");
  const narrow = packageLegs.find((l) => l.role === "narrow_no");
  if (!broad || !narrow) return null;
  const broadMarketId = broad.instrumentId.split("::")[1];
  const narrowMarketId = narrow.instrumentId.split("::")[1];
  if (!broadMarketId || !narrowMarketId) return null;
  const packageCost = broad.yesAsk + (1 - narrow.yesBid);
  const lockedEdge = 1 - packageCost;
  const snapshot = await buildPackageEntryBookSnapshot(broadMarketId, narrowMarketId, packageCost, lockedEdge);
  for (const leg of packageLegs) {
    const snap = snapshot.legs.find((s) => s.role === leg.role);
    if (!snap) continue;
    leg.yesBid = snap.yesBid;
    leg.yesAsk = snap.yesAsk;
    leg.yesBidSize = snap.yesBidSize;
    leg.yesAskSize = snap.yesAskSize;
  }
  return snapshot;
}

/** Enrich scanner strike rows when Gamma omitted top-of-book sizes. */
export async function enrichStrikesFromClob<T extends {
  marketId: string;
  bestBid: number;
  bestAsk: number;
  bestBidSize?: number;
  bestAskSize?: number;
  spread: number;
  liquidity: number;
}>(strikes: T[], concurrency = 6): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < strikes.length) {
      const i = index++;
      const strike = strikes[i];
      if (strike.bestBidSize && strike.bestAskSize) continue;
      if (!strike.marketId || strike.bestAsk <= 0) continue;
      try {
        const books = await fetchMarketYesNoBooks(strike.marketId);
        if (!books) continue;
        strike.bestBid = books.yes.bid;
        strike.bestAsk = books.yes.ask;
        strike.bestBidSize = books.yes.bidSize || undefined;
        strike.bestAskSize = books.yes.askSize || undefined;
        strike.spread = books.yes.spread;
        if (!strike.liquidity && books.liquidity > 0) strike.liquidity = books.liquidity;
      } catch {
        // Keep Gamma quotes if CLOB fetch fails.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, strikes.length) }, () => worker()));
}
