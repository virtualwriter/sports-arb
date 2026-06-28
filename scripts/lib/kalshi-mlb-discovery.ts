// Kalshi MLB market discovery + monotonic candidate construction.
//
// Kalshi groups markets under "events" (one event per real-world game), each
// containing multiple "markets" (one market per strike for totals/spreads).
// Tickers in Kalshi follow a structured form roughly like:
//
//   KXMLBGAME-25JUN26ARIBOS         (game-winner event)
//   KXMLBGAME-25JUN26ARIBOS-BOS      (yes side = team)
//   KXMLB-25JUN26ARIBOSTOT-T7.5      (total markets, strike 7.5)
//   KXMLB-25JUN26ARIBOSSPR-BOS-1.5   (spread markets, BOS by 1.5)
//
// The exact ticker conventions need empirical verification against the live
// API. We keep the parsing flexible: it pulls strike + market type from the
// human-readable `title` / `subtitle` first, falling back to ticker pattern
// matching only when text fields are missing.
//
// What we emit: a `KalshiCandidate` per pair of (broad, narrow) markets that
// form a valid two-leg middle within the same event. The shape mirrors the
// Polymarket `Candidate` so the existing strategy gates (sports-strategy.ts)
// can score it unchanged in the shadow path.

import type { KalshiMarket } from "./kalshi-client.js";

export type KalshiParsedMarket = {
  ticker: string;
  eventTicker: string;
  marketType: "total" | "spread" | "team_total" | "other";
  side: "over" | "under" | "team_a" | "team_b" | "unknown";
  team?: string;
  strike?: number;
  // Centicent prices from the API (Kalshi returns prices in cents 0-99; we
  // normalize to dollars 0-1 for parity with monotonic-arb-core).
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  liquidity: number;
  openTime?: string;
  closeTime?: string;
  raw: KalshiMarket;
};

function dollar(cents: number | undefined): number {
  if (cents === undefined || cents === null || !Number.isFinite(cents)) return 0;
  // Kalshi prices are in cents (0-100 integer). Convert to dollars (0-1).
  // If a price is already < 2 we assume it's already in dollars.
  return cents > 2 ? cents / 100 : cents;
}

function parseStrike(text: string): number | null {
  // Match patterns like "Over 7.5", "Under 8.5", "by 1.5+", "more than 9", etc.
  const m = text.match(/(\d+(?:\.5)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function classifyTotalSide(text: string): "over" | "under" | "unknown" {
  const lower = text.toLowerCase();
  if (lower.includes("over") || lower.includes("more than") || lower.includes("+")) return "over";
  if (lower.includes("under") || lower.includes("fewer than") || lower.includes("less than")) return "under";
  return "unknown";
}

function isTotalMarket(market: KalshiMarket): boolean {
  const text = `${market.ticker} ${market.title ?? ""} ${market.subtitle ?? ""} ${market.yes_sub_title ?? ""}`.toLowerCase();
  return /total|o\/u|over|under|runs scored/i.test(text) && !/spread|win by/i.test(text);
}

function isSpreadMarket(market: KalshiMarket): boolean {
  const text = `${market.ticker} ${market.title ?? ""} ${market.subtitle ?? ""} ${market.yes_sub_title ?? ""}`.toLowerCase();
  return /spread|win by|cover|handicap/i.test(text);
}

export function parseKalshiMarket(market: KalshiMarket): KalshiParsedMarket {
  const yesSub = market.yes_sub_title ?? "";
  const subtitle = market.subtitle ?? "";
  const title = market.title ?? "";
  const allText = `${title} ${subtitle} ${yesSub}`;

  let marketType: KalshiParsedMarket["marketType"] = "other";
  let side: KalshiParsedMarket["side"] = "unknown";
  let strike: number | null = null;

  if (isTotalMarket(market)) {
    marketType = "total";
    side = classifyTotalSide(yesSub || subtitle || title);
    // Prefer cap_strike/floor_strike if Kalshi provides them on the market object
    if (typeof market.cap_strike === "number") strike = market.cap_strike;
    else strike = parseStrike(yesSub || subtitle || title);
  } else if (isSpreadMarket(market)) {
    marketType = "spread";
    strike = parseStrike(yesSub || subtitle || title);
    // Spread side identification requires team name extraction; mark unknown
    // for now and rely on event-level pairing logic.
    side = "team_a";
  }

  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    marketType,
    side,
    strike: strike ?? undefined,
    yesBid: dollar(market.yes_bid),
    yesAsk: dollar(market.yes_ask),
    noBid: dollar(market.no_bid),
    noAsk: dollar(market.no_ask),
    liquidity: Number(market.liquidity ?? market.open_interest ?? 0),
    openTime: market.open_time,
    closeTime: market.close_time,
    raw: market,
  };
}

export type KalshiTotalsLadder = {
  eventTicker: string;
  strikes: { strike: number; over: KalshiParsedMarket; under?: KalshiParsedMarket }[];
};

export function buildTotalsLadder(markets: KalshiParsedMarket[]): KalshiTotalsLadder | null {
  const totals = markets.filter((m) => m.marketType === "total" && typeof m.strike === "number");
  if (!totals.length) return null;
  const eventTicker = totals[0].eventTicker;

  // Kalshi typically lists totals as a single market per strike with binary
  // YES=Over / NO=Under. So we collapse by strike.
  const byStrike = new Map<number, KalshiParsedMarket>();
  for (const m of totals) {
    if (m.strike === undefined) continue;
    const existing = byStrike.get(m.strike);
    if (!existing || (m.liquidity > existing.liquidity)) {
      byStrike.set(m.strike, m);
    }
  }

  return {
    eventTicker,
    strikes: [...byStrike.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([strike, over]) => ({ strike, over })),
  };
}

// A Kalshi monotonic-middle two-leg candidate.
//
// Convention (matches Polymarket monotonic):
//   direction = "above": buy YES on the broad (lower-strike Over) leg AND
//               buy NO on the narrow (higher-strike Over) leg. We win if the
//               game total lands strictly between broadStrike and narrowStrike.
//   direction = "below": mirror for unders. Not used for MLB totals.
//
// packageCost = broad.yesAsk + narrow.noAsk
// guaranteed floor = $1.00 per share (one of the two legs always pays $1)
// jackpot = $2.00 per share if the middle hits
export type KalshiCandidate = {
  foundAt: string;
  eventTicker: string;
  marketType: "total" | "spread";
  packageId: string;
  direction: "above" | "below";
  broad: KalshiParsedMarket;
  narrow: KalshiParsedMarket;
  broadStrike: number;
  narrowStrike: number;
  packageCost: number;
  lockedEdge: number;
  availableSize: number;
  jackpotPayoutPerShare: number;
};

export function buildTotalsCandidates(ladder: KalshiTotalsLadder, options: { maxWidth?: number } = {}): KalshiCandidate[] {
  const maxWidth = options.maxWidth ?? 4;
  const out: KalshiCandidate[] = [];
  const strikes = ladder.strikes;
  const now = new Date().toISOString();

  for (let i = 0; i < strikes.length; i++) {
    for (let j = i + 1; j < strikes.length; j++) {
      const broad = strikes[i].over;
      const narrow = strikes[j].over;
      const width = narrow.strike! - broad.strike!;
      if (width <= 0 || width > maxWidth) continue;

      // Direction "above": buy YES on broad (cheaper, lower strike Over) and
      // buy NO on narrow (cheaper, higher strike Over = "not over the bigger
      // number" = under-or-equal).
      const yesAsk = broad.yesAsk;
      const noAsk = narrow.noAsk;
      if (!(yesAsk > 0) || !(noAsk > 0)) continue;
      const packageCost = yesAsk + noAsk;
      const lockedEdge = 1 - packageCost; // negative if cost > $1.00 (carry cost)
      const availableSize = Math.min(broad.liquidity, narrow.liquidity);

      out.push({
        foundAt: now,
        eventTicker: ladder.eventTicker,
        marketType: "total",
        packageId: `kalshi::${ladder.eventTicker}::YES-${broad.ticker}+NO-${narrow.ticker}`,
        direction: "above",
        broad,
        narrow,
        broadStrike: broad.strike!,
        narrowStrike: narrow.strike!,
        packageCost,
        lockedEdge,
        availableSize,
        jackpotPayoutPerShare: 2,
      });
    }
  }
  return out;
}
