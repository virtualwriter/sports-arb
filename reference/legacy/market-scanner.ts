/**
 * Multi-source market scanner for Gold, Bitcoin, HYPE, Amazon, Oil
 *
 * Data sources:
 *   1. Hyperliquid  — perps for BTC, HYPE + xyz DEX (AMZN, GOLD, CL, BRENTOIL)
 *   2. Polymarket   — prediction markets (price strikes, macro, outperformance)
 *   3. CBOE         — delayed options chains for IBIT, AMZN
 *
 * Usage:
 *   npx tsx scripts/market-scanner.ts           # full console display
 *   npx tsx scripts/market-scanner.ts --json    # machine-readable JSON
 *   npx tsx scripts/market-scanner.ts --snapshot # append daily row to CSVs
 */

import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { enrichStrikesFromClob } from "./polymarket-clob-book.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HLAssetCtx {
  coin: string;
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
  impactPxs: string[] | null;
}

interface HLBookLevel {
  px: string;
  sz: string;
  n: number;
}

interface HLBookResponse {
  coin: string;
  levels: [HLBookLevel[], HLBookLevel[]];
}

interface HLSpotToken {
  name: string;
  index: number;
  tokens: { name: string; szDecimals: number; weiDecimals: number; index: number }[];
}

interface PolymarketMarket {
  id: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  slug: string;
  outcomePrices: string;
  outcomes: string;
  volume: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  closed: boolean;
  active: boolean;
  bestBid: number;
  bestAsk: number;
  bestBidSize?: number;
  bestAskSize?: number;
  spread: number;
}

interface OptionQuote {
  contractSymbol?: string;
  root?: string;
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  expiration: string;
  type: "call" | "put";
}

interface OptionsSnapshot {
  symbol: string;
  underlyingPrice: number;
  chains: OptionQuote[];
  source: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const HL_API = "https://api.hyperliquid.xyz/info";
const GAMMA_API = "https://gamma-api.polymarket.com";

const HL_PERP_COINS = ["BTC", "ETH", "HYPE", "SOL"];
const HL_BUILDER_COINS: { dex: string; coin: string; label: string }[] = [
  { dex: "xyz", coin: "xyz:AMZN", label: "AMZN" },
  { dex: "xyz", coin: "xyz:AAPL", label: "AAPL" },
  { dex: "xyz", coin: "xyz:AMD", label: "AMD" },
  { dex: "xyz", coin: "xyz:ARM", label: "ARM" },
  { dex: "xyz", coin: "xyz:BABA", label: "BABA" },
  { dex: "xyz", coin: "xyz:BIRD", label: "BIRD" },
  { dex: "xyz", coin: "xyz:BX", label: "BX" },
  { dex: "xyz", coin: "xyz:CBRS", label: "CBRS" },
  { dex: "xyz", coin: "xyz:COIN", label: "COIN" },
  { dex: "xyz", coin: "xyz:COST", label: "COST" },
  { dex: "xyz", coin: "xyz:CRCL", label: "CRCL" },
  { dex: "xyz", coin: "xyz:DKNG", label: "DKNG" },
  { dex: "xyz", coin: "xyz:EBAY", label: "EBAY" },
  { dex: "xyz", coin: "xyz:GME", label: "GME" },
  { dex: "xyz", coin: "xyz:GOOGL", label: "GOOGL" },
  { dex: "xyz", coin: "xyz:HIMS", label: "HIMS" },
  { dex: "xyz", coin: "xyz:HOOD", label: "HOOD" },
  { dex: "xyz", coin: "xyz:INTC", label: "INTC" },
  { dex: "xyz", coin: "xyz:LITE", label: "LITE" },
  { dex: "xyz", coin: "xyz:LLY", label: "LLY" },
  { dex: "xyz", coin: "xyz:META", label: "META" },
  { dex: "xyz", coin: "xyz:MRVL", label: "MRVL" },
  { dex: "xyz", coin: "xyz:MSFT", label: "MSFT" },
  { dex: "xyz", coin: "xyz:MSTR", label: "MSTR" },
  { dex: "xyz", coin: "xyz:MU", label: "MU" },
  { dex: "xyz", coin: "xyz:NFLX", label: "NFLX" },
  { dex: "xyz", coin: "xyz:NVDA", label: "NVDA" },
  { dex: "xyz", coin: "xyz:ORCL", label: "ORCL" },
  { dex: "xyz", coin: "xyz:PLTR", label: "PLTR" },
  { dex: "xyz", coin: "xyz:RIVN", label: "RIVN" },
  { dex: "xyz", coin: "xyz:RKLB", label: "RKLB" },
  { dex: "xyz", coin: "xyz:SKHX", label: "SKHX" },
  { dex: "xyz", coin: "xyz:SNDK", label: "SNDK" },
  { dex: "xyz", coin: "xyz:TSLA", label: "TSLA" },
  { dex: "xyz", coin: "xyz:TSM", label: "TSM" },
  { dex: "xyz", coin: "xyz:ZM", label: "ZM" },
  { dex: "xyz", coin: "xyz:GOLD", label: "GOLD (GC)" },
  { dex: "xyz", coin: "xyz:CL", label: "OIL (CL)" },
  { dex: "xyz", coin: "xyz:BRENTOIL", label: "BRENT OIL" },
  { dex: "xyz", coin: "xyz:SILVER", label: "SILVER" },
];
const OPTIONS_SYMBOLS = ["IBIT", "AMZN", "GLD", "USO", "ETHA", "SPY", "PURR"];
const CME_GREEKS_API_BASE = process.env.CME_GREEKS_API_BASE ?? "https://markets.api.cmegroup.com/greeks/v1";
const CME_TOKEN_URL = process.env.CME_TOKEN_URL ?? "https://auth.cmegroup.com/as/token.oauth2";
const CME_OPTIONS_QUERY_PARAM = process.env.CME_OPTIONS_QUERY_PARAM ?? "undlyProductCodes";
const CME_OPTIONS_CONFIG = [
  { snapshotKey: "CME_BTC", undlyProductCode: process.env.CME_BTC_UNDLY_PRODUCT_CODE ?? "BTC", label: "CME BTC futures options" },
  { snapshotKey: "CME_GC", undlyProductCode: process.env.CME_GOLD_UNDLY_PRODUCT_CODE ?? "GC", label: "CME GC futures options" },
  { snapshotKey: "CME_CL", undlyProductCode: process.env.CME_OIL_UNDLY_PRODUCT_CODE ?? "CL", label: "CME CL futures options" },
  { snapshotKey: "CME_ES", undlyProductCode: process.env.CME_ES_UNDLY_PRODUCT_CODE ?? "ES", label: "CME E-mini S&P 500 futures options" },
  { snapshotKey: "CME_ETH", undlyProductCode: process.env.CME_ETH_UNDLY_PRODUCT_CODE ?? "ETH", label: "CME ETH futures options" },
];
const TRADINGVIEW_OPTIONS_ENABLED = process.env.TRADINGVIEW_OPTIONS_ENABLED === "1" || process.env.TRADINGVIEW_OPTIONS_ENABLED === "true";

function monthSlug(date: Date): string {
  return date.toLocaleString("en-US", { month: "long", timeZone: "UTC" }).toLowerCase();
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
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

const POLYMARKET_EVENT_SLUGS = [
  "what-price-will-bitcoin-hit-before-2027",
  "what-price-will-bitcoin-hit-in-may-2026",
  "what-price-will-ethereum-hit-before-2027",
  "what-price-will-solana-hit-before-2027",
  "what-price-will-hyperliquid-hit-before-2027",
  "what-will-gold-gc-hit-by-end-of-december",
  "what-price-will-xauusd-hit-in-may-2026",
  "what-price-will-xauusd-hit-in-april-2026",
  "what-price-will-amzn-hit-in-may-2026",
  "gc-hit-jun-2026",
  "gc-settle-jun-2026",
  "gc-over-under-jun-2026",
  "spx-hit-jun-2026",
  "spx-hit-dec-2026",
  "si-hit-jun-2026",
  "cl-hit-jun-2026",
  "cl-over-under-jun-2026",
  "cl-settle-jun-2026",
  ...currentMonthTouchEventSlugs(),
].filter((slug, idx, arr) => arr.indexOf(slug) === idx);
const POLYMARKET_SEARCH_KEYWORDS = ["amazon stock", "AMZN", "ethereum", "S&P 500", "SPX"];

const JSON_OUTPUT = process.argv.includes("--json");
const SNAPSHOT_MODE = process.argv.includes("--snapshot");
const DATA_DIR = join(import.meta.dirname ?? ".", "..", "data");

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson(url: string, body?: unknown): Promise<any> {
  const opts: RequestInit = {
    headers: { "Content-Type": "application/json" },
  };
  if (body) {
    opts.method = "POST";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(4)}%`;
}

function divider(title: string) {
  if (JSON_OUTPUT || SNAPSHOT_MODE) return;
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

function warn(msg: string) {
  if (!JSON_OUTPUT && !SNAPSHOT_MODE) console.log(`  ⚠  ${msg}`);
}

// ─── 1. Hyperliquid ─────────────────────────────────────────────────────────

async function fetchHyperliquid() {
  divider("HYPERLIQUID — Perpetual Futures");

  const [metaAndCtx, spotMetaAndCtx] = await Promise.all([
    fetchJson(HL_API, { type: "metaAndAssetCtxs" }),
    fetchJson(HL_API, { type: "spotMetaAndAssetCtxs" }).catch(() => null),
  ]);

  const universe: { name: string; szDecimals: number }[] = metaAndCtx[0].universe;
  const assetCtxs: any[] = metaAndCtx[1];

  const results: Record<string, any> = {};

  for (const coin of HL_PERP_COINS) {
    const idx = universe.findIndex((u) => u.name === coin);
    if (idx === -1) {
      warn(`${coin} perp not found on Hyperliquid`);
      continue;
    }

    const ctx = assetCtxs[idx];
    const markPx = parseFloat(ctx.markPx);
    const oraclePx = parseFloat(ctx.oraclePx);
    const funding = parseFloat(ctx.funding);
    const openInterest = parseFloat(ctx.openInterest);
    const dayVol = parseFloat(ctx.dayNtlVlm);
    const premium = parseFloat(ctx.premium ?? "0");

    let book: HLBookResponse | null = null;
    try {
      book = await fetchJson(HL_API, { type: "l2Book", coin });
    } catch {}

    const bestBid = book ? parseFloat(book.levels[0][0]?.px ?? "0") : 0;
    const bestAsk = book ? parseFloat(book.levels[1][0]?.px ?? "0") : 0;
    const bidDepth5 = book
      ? book.levels[0].slice(0, 5).reduce((s, l) => s + parseFloat(l.sz) * parseFloat(l.px), 0)
      : 0;
    const askDepth5 = book
      ? book.levels[1].slice(0, 5).reduce((s, l) => s + parseFloat(l.sz) * parseFloat(l.px), 0)
      : 0;

    const annualizedFunding = funding * 24 * 365;

    results[coin] = {
      markPx,
      oraclePx,
      funding8h: funding,
      fundingAnnualized: annualizedFunding,
      premium,
      openInterest,
      openInterestUsd: openInterest * markPx,
      dayVolume: dayVol,
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      bidDepth5Usd: bidDepth5,
      askDepth5Usd: askDepth5,
    };

    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      console.log(`\n  ┌─ ${coin}-PERP ─────────────────────────────────`);
      console.log(`  │  Mark Price:      $${fmt(markPx, coin === "BTC" ? 2 : 4)}`);
      console.log(`  │  Oracle Price:    $${fmt(oraclePx, coin === "BTC" ? 2 : 4)}`);
      console.log(`  │  Funding (8h):    ${pct(funding)}  (${annualizedFunding > 0 ? "longs pay" : "shorts pay"})`);
      console.log(`  │  Annualized:      ${pct(annualizedFunding)}`);
      console.log(`  │  Open Interest:   ${fmt(openInterest, 0)} contracts (${fmtUsd(openInterest * markPx)})`);
      console.log(`  │  24h Volume:      ${fmtUsd(dayVol)}`);
      console.log(`  │  Best Bid/Ask:    $${fmt(bestBid, 4)} / $${fmt(bestAsk, 4)}  (spread: $${fmt(bestAsk - bestBid, 4)})`);
      console.log(`  │  Book Depth (5):  Bids ${fmtUsd(bidDepth5)} | Asks ${fmtUsd(askDepth5)}`);
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // Builder DEX perps (equities, gold, oil on xyz)
  const builderDexes = [...new Set(HL_BUILDER_COINS.map((c) => c.dex))];
  for (const dex of builderDexes) {
    try {
      const dexMeta = await fetchJson(HL_API, { type: "metaAndAssetCtxs", dex });
      const dexUniverse: { name: string; szDecimals: number }[] = dexMeta[0].universe;
      const dexCtxs: any[] = dexMeta[1];

      for (const target of HL_BUILDER_COINS.filter((c) => c.dex === dex)) {
        const idx = dexUniverse.findIndex((u) => u.name === target.coin);
        if (idx === -1) {
          warn(`${target.coin} not found on ${dex}`);
          continue;
        }

        const ctx = dexCtxs[idx];
        const markPx = parseFloat(ctx.markPx);
        const oraclePx = parseFloat(ctx.oraclePx);
        const funding = parseFloat(ctx.funding);
        const openInterest = parseFloat(ctx.openInterest);
        const dayVol = parseFloat(ctx.dayNtlVlm);

        let book: HLBookResponse | null = null;
        try {
          book = await fetchJson(HL_API, { type: "l2Book", coin: target.coin });
        } catch {}

        const bestBid = book ? parseFloat(book.levels[0][0]?.px ?? "0") : 0;
        const bestAsk = book ? parseFloat(book.levels[1][0]?.px ?? "0") : 0;
        const annualizedFunding = funding * 24 * 365;

        results[target.label] = {
          markPx,
          oraclePx,
          funding8h: funding,
          fundingAnnualized: annualizedFunding,
          openInterest,
          openInterestUsd: openInterest * markPx,
          dayVolume: dayVol,
          bestBid,
          bestAsk,
          spread: bestAsk - bestBid,
          source: `${dex} DEX`,
        };

        if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
          const decimals = markPx > 1000 ? 2 : markPx > 1 ? 2 : 4;
          console.log(`\n  ┌─ ${target.coin} (${target.label}) ───────────────────────`);
          console.log(`  │  Mark Price:      $${fmt(markPx, decimals)}`);
          console.log(`  │  Oracle Price:    $${fmt(oraclePx, decimals)}`);
          console.log(`  │  Funding (8h):    ${pct(funding)}  (${annualizedFunding > 0 ? "longs pay" : "shorts pay"})`);
          console.log(`  │  Annualized:      ${pct(annualizedFunding)}`);
          console.log(`  │  Open Interest:   ${fmt(openInterest, 0)} contracts (${fmtUsd(openInterest * markPx)})`);
          console.log(`  │  24h Volume:      ${fmtUsd(dayVol)}`);
          console.log(`  │  Best Bid/Ask:    $${fmt(bestBid, decimals)} / $${fmt(bestAsk, decimals)}  (spread: $${fmt(bestAsk - bestBid, decimals)})`);
          console.log(`  │  Source:          Hyperliquid ${dex} DEX`);
          console.log(`  └────────────────────────────────────────────`);
        }
      }
    } catch (e: any) {
      warn(`Failed to fetch ${dex} DEX data: ${e.message}`);
    }
  }

  // Spot data for HYPE if available
  if (spotMetaAndCtx) {
    const spotUniverse = spotMetaAndCtx[0].universe as HLSpotToken[];
    const spotCtxs = spotMetaAndCtx[1] as any[];
    const idx = spotUniverse.findIndex((u) => u.tokens.some((t) => t.name === "HYPE"));
    if (idx !== -1 && spotCtxs[idx]) {
      const ctx = spotCtxs[idx];
      const midPx = ctx.midPx ? parseFloat(ctx.midPx) : null;
      const dayVol = ctx.dayNtlVlm ? parseFloat(ctx.dayNtlVlm) : 0;
      if (midPx && !JSON_OUTPUT) {
        console.log(`\n  ┌─ HYPE SPOT ──────────────────────────────`);
        console.log(`  │  Mid Price:      $${fmt(midPx, 4)}`);
        console.log(`  │  24h Volume:     ${fmtUsd(dayVol)}`);
        console.log(`  └────────────────────────────────────────────`);
      }
      if (midPx) {
        results["HYPE_SPOT"] = { midPx, dayVolume: dayVol };
      }
    }
  }

  return results;
}

// ─── 2. Polymarket ──────────────────────────────────────────────────────────

interface PriceStrike {
  marketId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  strike: number;
  direction: "above" | "below";
  yesPrice: number;
  volume: number;
  bestBid: number;
  bestAsk: number;
  bestBidSize?: number;
  bestAskSize?: number;
  spread: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  startDate: string | null;
  endDate: string | null;
}

interface PolymarketEvent {
  title: string;
  slug: string;
  strikes: PriceStrike[];
  totalVolume: number;
}

function parseStrike(question: string): { strike: number; direction: "above" | "below" } | null {
  // "reach $150,000" / "hit (HIGH) $6,000" / "settle over $90"
  const highMatch = question.match(/(?:reach|hit\s*\(HIGH\)|settle\s+over|settle\s+at\s*>\s*)\s*\$?([\d,]+)/i);
  // "dip to $55,000" / "hit (LOW) $40" / "settle under" / "below"
  const lowMatch = question.match(/(?:dip\s+to|hit\s*\(LOW\)|settle\s+under|below)\s*\$?([\d,]+)/i);
  const hitHighSuffix = question.match(/hit\s+\$?([\d,]+)\s*\(HIGH\)/i);
  const hitLowSuffix = question.match(/hit\s+\$?([\d,]+)\s*\(LOW\)/i);
  // "settle at >$84"
  const settleAbove = question.match(/settle\s+at\s*>\s*\$?([\d,]+)/i);
  // "settle at $63-$70" (range bucket — use midpoint)
  const rangeMatch = question.match(/settle\s+at\s+\$?([\d,]+)\s*-\s*\$?([\d,]+)/i);
  // "settle at <$42" or "settle at >$84"
  const settleLt = question.match(/settle\s+at\s*<\s*\$?([\d,]+)/i);
  const settleGt = question.match(/settle\s+at\s*>\s*\$?([\d,]+)/i);

  if (highMatch) return { strike: parseFloat(highMatch[1].replace(/,/g, "")), direction: "above" };
  if (lowMatch) return { strike: parseFloat(lowMatch[1].replace(/,/g, "")), direction: "below" };
  if (hitHighSuffix) return { strike: parseFloat(hitHighSuffix[1].replace(/,/g, "")), direction: "above" };
  if (hitLowSuffix) return { strike: parseFloat(hitLowSuffix[1].replace(/,/g, "")), direction: "below" };
  if (settleAbove) return { strike: parseFloat(settleAbove[1].replace(/,/g, "")), direction: "above" };
  if (settleGt) return { strike: parseFloat(settleGt[1].replace(/,/g, "")), direction: "above" };
  if (settleLt) return { strike: parseFloat(settleLt[1].replace(/,/g, "")), direction: "below" };
  if (rangeMatch) {
    const lo = parseFloat(rangeMatch[1].replace(/,/g, ""));
    const hi = parseFloat(rangeMatch[2].replace(/,/g, ""));
    return { strike: (lo + hi) / 2, direction: "above" };
  }

  // Generic fallback patterns
  const reachMatch = question.match(/reach\s+\$?([\d,]+)/i);
  const aboveMatch = question.match(/above\s+\$?([\d,]+)/i);
  const belowMatch = question.match(/below\s+\$?([\d,]+)/i);
  const dropMatch = question.match(/drop.*?\$?([\d,]+)/i);
  const overMatch = question.match(/over\s+\$?([\d,]+)/i);

  if (reachMatch) return { strike: parseFloat(reachMatch[1].replace(/,/g, "")), direction: "above" };
  if (aboveMatch) return { strike: parseFloat(aboveMatch[1].replace(/,/g, "")), direction: "above" };
  if (overMatch) return { strike: parseFloat(overMatch[1].replace(/,/g, "")), direction: "above" };
  if (belowMatch) return { strike: parseFloat(belowMatch[1].replace(/,/g, "")), direction: "below" };
  if (dropMatch) return { strike: parseFloat(dropMatch[1].replace(/,/g, "")), direction: "below" };
  return null;
}

async function fetchPolymarket() {
  divider("POLYMARKET — Prediction Markets");

  const events: PolymarketEvent[] = [];

  // Direct lookup of known event slugs first
  for (const slug of POLYMARKET_EVENT_SLUGS) {
    try {
      const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
      const data = await fetchJson(url);
      if (!Array.isArray(data)) continue;

      for (const event of data) {
        const title = event.title || "";
        const eSlug = event.slug || "";
        const markets = event.markets || [];
        const strikes: PriceStrike[] = [];
        let totalVolume = 0;

        for (const m of markets) {
          const parsed = parseStrike(m.question || "");
          if (!parsed) continue;
          let prices: number[] = [];
          try { prices = JSON.parse(m.outcomePrices || "[]").map(Number); } catch {}
          const vol = parseFloat(m.volume || "0");
          totalVolume += vol;
          strikes.push({
            marketId: m.id || "",
            question: m.question,
            description: m.description,
            resolutionSource: m.resolutionSource,
            strike: parsed.strike,
            direction: parsed.direction,
            yesPrice: prices[0] ?? 0,
            volume: vol,
            bestBid: Number(m.bestBid ?? 0),
            bestAsk: Number(m.bestAsk ?? 0),
            bestBidSize: Number(m.bestBidSize ?? 0) || undefined,
            bestAskSize: Number(m.bestAskSize ?? 0) || undefined,
            spread: Number(m.spread ?? 0),
            liquidity: parseFloat(m.liquidity || "0"),
            active: !!m.active,
            closed: !!m.closed,
            startDate: m.startDate || m.createdAt || event.startDate || event.createdAt || null,
            endDate: m.endDate || null,
          });
        }

        strikes.sort((a, b) => b.strike - a.strike);
        if (strikes.length > 0 && !events.find((e) => e.slug === eSlug)) {
          events.push({ title, slug: eSlug, strikes, totalVolume });
        }
      }
    } catch (e: any) {
      warn(`Polymarket slug lookup "${slug}" failed: ${e.message}`);
    }
  }

  // Also paginate to find keyword-matched events
  for (let offset = 0; offset <= 1000; offset += 100) {
    try {
      const url = `${GAMMA_API}/events?closed=false&limit=100&offset=${offset}`;
      const data = await fetchJson(url);
      if (!Array.isArray(data) || data.length === 0) break;

      for (const event of data) {
        const title = event.title || "";
        const slug = event.slug || "";

        const isTarget =
          POLYMARKET_EVENT_SLUGS.includes(slug) ||
          POLYMARKET_SEARCH_KEYWORDS.some((kw) => title.toLowerCase().includes(kw.toLowerCase()));

        if (!isTarget) continue;

        const markets = event.markets || [];
        const strikes: PriceStrike[] = [];
        let totalVolume = 0;

        for (const m of markets) {
          const parsed = parseStrike(m.question || "");
          if (!parsed) continue;

          let prices: number[] = [];
          try {
            prices = JSON.parse(m.outcomePrices || "[]").map(Number);
          } catch {}

          const vol = parseFloat(m.volume || "0");
          totalVolume += vol;

          strikes.push({
            marketId: m.id || "",
            question: m.question,
            description: m.description,
            resolutionSource: m.resolutionSource,
            strike: parsed.strike,
            direction: parsed.direction,
            yesPrice: prices[0] ?? 0,
            volume: vol,
            bestBid: Number(m.bestBid ?? 0),
            bestAsk: Number(m.bestAsk ?? 0),
            bestBidSize: Number(m.bestBidSize ?? 0) || undefined,
            bestAskSize: Number(m.bestAskSize ?? 0) || undefined,
            spread: Number(m.spread ?? 0),
            liquidity: parseFloat(m.liquidity || "0"),
            active: !!m.active,
            closed: !!m.closed,
            startDate: m.startDate || m.createdAt || event.startDate || event.createdAt || null,
            endDate: m.endDate || null,
          });
        }

        strikes.sort((a, b) => b.strike - a.strike);

        if (strikes.length > 0 && !events.find((e) => e.slug === slug)) {
          events.push({ title, slug, strikes, totalVolume });
        }
      }
    } catch (e: any) {
      warn(`Polymarket events fetch failed (offset ${offset}): ${e.message}`);
    }
  }

  if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
    if (events.length === 0) {
      console.log("  No price prediction events found.");
    }
    for (const ev of events) {
      console.log(`\n  ┌─ ${ev.title}  (Total Vol: ${fmtUsd(ev.totalVolume)})`);
      console.log(`  │  https://polymarket.com/event/${ev.slug}`);
      console.log(`  │`);
      console.log(`  │  ${"Strike".padEnd(12)} ${"Dir".padEnd(7)} ${"YES".padStart(7)} ${"Implied".padStart(8)}  Distribution`);
      console.log(`  │  ${"─".repeat(60)}`);
      for (const s of ev.strikes) {
        const prob = s.yesPrice * 100;
        const bar = "█".repeat(Math.round(prob / 2));
        console.log(
          `  │  ${("$" + fmt(s.strike, 0)).padEnd(12)} ${s.direction.padEnd(7)} ${(s.yesPrice.toFixed(3)).padStart(7)} ${(prob.toFixed(1) + "%").padStart(8)}  ${bar}`
        );
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  await Promise.all(events.map((event) => enrichStrikesFromClob(event.strikes)));
  return events;
}

// ─── 3. Options Data ────────────────────────────────────────────────────────

function parseCboeSymbol(sym: string): { expiration: string; type: "call" | "put"; strike: number } | null {
  // Format: AMZN260402C00125000 → AMZN, 26-04-02, Call, $125.00
  // The symbol is: ROOT + YYMMDD + C/P + 8-digit strike (strike * 1000)
  const match = sym.match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, dateStr, cpFlag, strikeStr] = match;
  const yy = dateStr.slice(0, 2);
  const mm = dateStr.slice(2, 4);
  const dd = dateStr.slice(4, 6);
  return {
    expiration: `20${yy}-${mm}-${dd}`,
    type: cpFlag === "P" ? "put" : "call",
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

async function fetchCboeOptions(symbol: string): Promise<OptionsSnapshot | null> {
  try {
    const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`;
    const data = await fetchJson(url);

    const underlying = data?.data?.current_price ?? data?.data?.close ?? 0;
    const options: any[] = data?.data?.options ?? [];

    const chains: OptionQuote[] = [];
    for (const opt of options) {
      const optSym: string = opt.option ?? "";
      const parsed = parseCboeSymbol(optSym);
      if (!parsed) continue;

      const bid = opt.bid ?? 0;
      const ask = opt.ask ?? 0;
      const vol = opt.volume ?? 0;
      const oi = opt.open_interest ?? 0;
      const iv = opt.iv ?? 0;

      chains.push({
        strike: parsed.strike,
        bid,
        ask,
        mid: (bid + ask) / 2,
        volume: vol,
        openInterest: oi,
        impliedVolatility: iv,
        expiration: parsed.expiration,
        type: parsed.type,
      });
    }

    return { symbol, underlyingPrice: underlying, chains, source: "CBOE delayed" };
  } catch {
    return null;
  }
}

function parseCmeNumber(value: any): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCmeIv(record: any): number {
  const bid = parseCmeNumber(record.impliedVolBid ?? record.ivBid);
  const ask = parseCmeNumber(record.impliedVolAsk ?? record.ivAsk);
  let iv = parseCmeNumber(record.impliedVol ?? record.impliedVolatility ?? record.iv ?? record.volatility);
  if (!iv && bid > 0 && ask > 0) iv = (bid + ask) / 2;
  if (iv > 3) return iv / 100;
  return iv;
}

function cmeOptionType(record: any): "call" | "put" | null {
  const raw = String(record.putCallInd ?? record.putCall ?? record.callPut ?? record.optionType ?? record.cp ?? "").toUpperCase();
  if (raw.startsWith("C")) return "call";
  if (raw.startsWith("P")) return "put";
  return null;
}

function cmeExpiration(record: any): string {
  const raw = record.expirationDate ?? record.expiryDate ?? record.expiration ?? record.maturityDate ?? record.lastTradeDate;
  if (raw) {
    const parsed = new Date(String(raw));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    const compact = String(raw).match(/^(20\d{2})(\d{2})(\d{2})/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  const dte = parseCmeNumber(record.daysToExpiration ?? record.dte);
  if (dte > 0) {
    const dt = new Date(Date.now() + dte * 86400_000);
    return dt.toISOString().slice(0, 10);
  }
  return "";
}

function collectCmeRecords(value: any, out: any[] = []): any[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCmeRecords(item, out);
  } else if (value && typeof value === "object") {
    if (
      value.impliedVol !== undefined ||
      value.impliedVolatility !== undefined ||
      value.impliedVolBid !== undefined ||
      value.impliedVolAsk !== undefined
    ) {
      out.push(value);
    }
    for (const child of Object.values(value)) collectCmeRecords(child, out);
  }
  return out;
}

async function fetchCmeBearerToken(): Promise<string | null> {
  if (process.env.CME_API_BEARER_TOKEN) return process.env.CME_API_BEARER_TOKEN;
  const clientId = process.env.CME_API_CLIENT_ID;
  const clientSecret = process.env.CME_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (process.env.CME_API_SCOPE) body.set("scope", process.env.CME_API_SCOPE);
  const res = await fetch(CME_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "User-Agent": "polymarket-trader/1.0",
    },
    body,
  });
  if (!res.ok) throw new Error(`CME token request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.access_token ?? null;
}

async function fetchCmeOptionsAnalytics(): Promise<Record<string, OptionsSnapshot>> {
  const token = await fetchCmeBearerToken();
  if (!token) {
    warn("CME options disabled: set CME_API_BEARER_TOKEN or CME_API_CLIENT_ID/CME_API_CLIENT_SECRET");
    return {};
  }

  const snapshots: Record<string, OptionsSnapshot> = {};
  for (const cfg of CME_OPTIONS_CONFIG) {
    const url = `${CME_GREEKS_API_BASE.replace(/\/$/, "")}/latest?${CME_OPTIONS_QUERY_PARAM}=${encodeURIComponent(cfg.undlyProductCode)}`;
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "User-Agent": "polymarket-trader/1.0",
        },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      const records = collectCmeRecords(data);
      const chains: OptionQuote[] = [];
      let underlyingPrice = 0;

      for (const record of records) {
        const type = cmeOptionType(record);
        const strike = parseCmeNumber(record.strikePx ?? record.strikePrice ?? record.strike);
        const iv = parseCmeIv(record);
        const expiration = cmeExpiration(record);
        if (!type || strike <= 0 || iv <= 0 || !expiration) continue;
        if (!underlyingPrice) {
          underlyingPrice = parseCmeNumber(
            record.undlyPx ?? record.underlyingPrice ?? record.underlyingPx ?? record.futurePrice ?? record.futuresPrice ?? record.undlySettlePx
          );
        }
        const bid = parseCmeNumber(record.bid ?? record.optionBid ?? record.premiumBid);
        const ask = parseCmeNumber(record.ask ?? record.optionAsk ?? record.premiumAsk);
        chains.push({
          strike,
          bid,
          ask,
          mid: bid && ask ? (bid + ask) / 2 : 0,
          volume: parseCmeNumber(record.volume ?? record.tradeVolume),
          openInterest: parseCmeNumber(record.openInterest ?? record.oi),
          impliedVolatility: iv,
          expiration,
          type,
        });
      }

      if (underlyingPrice > 0 && chains.length > 0) {
        snapshots[cfg.snapshotKey] = {
          symbol: cfg.snapshotKey,
          underlyingPrice,
          chains,
          source: `${cfg.label} - CME Options Analytics`,
        };
      } else {
        warn(`${cfg.label}: CME returned no usable options analytics`);
      }
    } catch (e: any) {
      warn(`${cfg.label}: ${e.message}`);
    }
  }
  return snapshots;
}

async function fetchTradingViewFuturesOptions(): Promise<Record<string, OptionsSnapshot>> {
  if (!TRADINGVIEW_OPTIONS_ENABLED) return {};
  if (!process.env.TRADINGVIEW_COOKIE) {
    warn("TradingView futures options disabled: TRADINGVIEW_COOKIE is not set");
    return {};
  }

  try {
    const stdout = execFileSync("python3", ["scripts/tradingview_futures_options.py"], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf-8",
      timeout: Number(process.env.TRADINGVIEW_OPTIONS_COLLECTOR_TIMEOUT_MS ?? 120_000),
      maxBuffer: Number(process.env.OPTIONS_COLLECTOR_MAX_BUFFER_BYTES ?? 50 * 1024 * 1024),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const snapshots = JSON.parse(stdout) as Record<string, OptionsSnapshot>;
    const usable = Object.fromEntries(
      Object.entries(snapshots).filter(([, snapshot]) => snapshot?.chains?.length > 0),
    );
    for (const [key, snapshot] of Object.entries(usable)) {
      warn(`${key}: loaded ${snapshot.chains.length} futures options from TradingView`);
    }
    return usable;
  } catch (e: any) {
    const message = e.stderr ? String(e.stderr).trim().slice(0, 800) : e.message;
    warn(`TradingView futures options disabled/unavailable: ${message}`);
    return {};
  }
}

async function fetchOptions() {
  divider("OPTIONS — IBIT / AMZN");

  const results: Record<string, OptionsSnapshot> = {};

  for (const symbol of OPTIONS_SYMBOLS) {
    let snapshot = await fetchCboeOptions(symbol);

    if (!snapshot || snapshot.chains.length === 0) {
      warn(`No CBOE options data found for ${symbol}`);
      continue;
    }

    results[symbol] = snapshot;

    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      const calls = snapshot.chains.filter((c) => c.type === "call");
      const puts = snapshot.chains.filter((c) => c.type === "put");

      const nearestExp = [...new Set(snapshot.chains.map((c) => c.expiration))]
        .filter(Boolean)
        .sort()[0];
      const nearCalls = calls
        .filter((c) => c.expiration === nearestExp)
        .sort((a, b) => a.strike - b.strike);
      const nearPuts = puts
        .filter((c) => c.expiration === nearestExp)
        .sort((a, b) => a.strike - b.strike);

      const totalCallOI = calls.reduce((s, c) => s + c.openInterest, 0);
      const totalPutOI = puts.reduce((s, c) => s + c.openInterest, 0);
      const totalCallVol = calls.reduce((s, c) => s + c.volume, 0);
      const totalPutVol = puts.reduce((s, c) => s + c.volume, 0);
      const pcRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : 0;

      const atmCalls = nearCalls.filter(
        (c) => Math.abs(c.strike - snapshot!.underlyingPrice) / snapshot!.underlyingPrice < 0.05
      );
      const avgAtmIV =
        atmCalls.length > 0
          ? atmCalls.reduce((s, c) => s + c.impliedVolatility, 0) / atmCalls.length
          : 0;

      console.log(`\n  ┌─ ${symbol} OPTIONS (${snapshot.source}) ──────────────`);
      console.log(`  │  Underlying:     $${fmt(snapshot.underlyingPrice)}`);
      console.log(`  │  Nearest Exp:    ${nearestExp || "N/A"}`);
      console.log(`  │  Total Chains:   ${snapshot.chains.length} (${calls.length} calls, ${puts.length} puts)`);
      console.log(`  │  Call OI / Vol:  ${fmt(totalCallOI, 0)} / ${fmt(totalCallVol, 0)}`);
      console.log(`  │  Put  OI / Vol:  ${fmt(totalPutOI, 0)} / ${fmt(totalPutVol, 0)}`);
      console.log(`  │  Put/Call Ratio: ${fmt(pcRatio, 3)}`);
      if (avgAtmIV > 0) {
        console.log(`  │  ATM IV (avg):   ${(avgAtmIV * 100).toFixed(1)}%`);
      }

      // Show nearest-expiry ATM strikes
      const atm = snapshot.underlyingPrice;
      const nearby = nearCalls
        .filter((c) => c.strike >= atm * 0.9 && c.strike <= atm * 1.1)
        .slice(0, 8);
      if (nearby.length > 0) {
        console.log(`  │`);
        console.log(`  │  Near-ATM Calls (${nearestExp}):`);
        console.log(`  │  ${"Strike".padEnd(10)} ${"Bid".padStart(8)} ${"Ask".padStart(8)} ${"IV".padStart(8)} ${"OI".padStart(10)}`);
        for (const c of nearby) {
          const marker = Math.abs(c.strike - atm) / atm < 0.01 ? " ◄ ATM" : "";
          console.log(
            `  │  ${("$" + fmt(c.strike)).padEnd(10)} ${("$" + fmt(c.bid)).padStart(8)} ${("$" + fmt(c.ask)).padStart(8)} ${c.impliedVolatility > 0 ? (c.impliedVolatility * 100).toFixed(1) + "%" : "N/A".padStart(4)}${fmt(c.openInterest, 0).padStart(10)}${marker}`
          );
        }
      }

      // Max pain calculation
      const allStrikes = [...new Set(snapshot.chains.filter(c => c.expiration === nearestExp).map((c) => c.strike))].sort(
        (a, b) => a - b
      );
      let maxPainStrike = 0;
      let minPain = Infinity;
      for (const testStrike of allStrikes) {
        let pain = 0;
        for (const c of nearCalls.filter((c) => c.expiration === nearestExp)) {
          if (testStrike > c.strike) pain += (testStrike - c.strike) * c.openInterest;
        }
        for (const p of nearPuts.filter((c) => c.expiration === nearestExp)) {
          if (testStrike < p.strike) pain += (p.strike - testStrike) * p.openInterest;
        }
        if (pain < minPain) {
          minPain = pain;
          maxPainStrike = testStrike;
        }
      }
      if (maxPainStrike > 0) {
        console.log(`  │`);
        console.log(`  │  Max Pain:       $${fmt(maxPainStrike)}  (${((maxPainStrike / atm - 1) * 100).toFixed(1)}% from spot)`);
      }

      console.log(`  └────────────────────────────────────────────`);
    }
  }

  Object.assign(results, await fetchTradingViewFuturesOptions());
  Object.assign(results, await fetchCmeOptionsAnalytics());

  return results;
}

// ─── 4. Implied Valuations & Discrepancies ──────────────────────────────────

interface AssetValuation {
  name: string;
  spot: number;
  spotSource: string;
  optionsForward: number | null;
  optionsForwardExpiry: string;
  pmImpliedEV: number | null;
  pmEvMethod: string;
  ivOptions30d: number | null;
  ivOptions90d: number | null;
  ivPolymarket: number | null;
  hlFundingAnn: number | null;
  putCallRatio: number | null;
  discrepancies: string[];
}

function getIVForTenor(
  chains: OptionQuote[],
  underlying: number,
  targetDays: number,
): { iv: number; expiry: string } | null {
  const now = new Date();
  const grouped = new Map<string, OptionQuote[]>();
  for (const c of chains) {
    if (!c.expiration) continue;
    const arr = grouped.get(c.expiration) ?? [];
    arr.push(c);
    grouped.set(c.expiration, arr);
  }

  let bestExp = "";
  let bestDiff = Infinity;
  for (const exp of grouped.keys()) {
    const dte = (new Date(exp).getTime() - now.getTime()) / 86400000;
    if (dte < 2) continue;
    const diff = Math.abs(dte - targetDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestExp = exp;
    }
  }
  if (!bestExp) return null;

  const expChains = grouped.get(bestExp)!;
  const atmCalls = expChains.filter(
    (c) =>
      c.type === "call" &&
      c.impliedVolatility > 0 &&
      c.impliedVolatility < 5 &&
      Math.abs(c.strike - underlying) / underlying < 0.05,
  );
  if (atmCalls.length === 0) return null;
  const liquidAtmCalls = atmCalls.filter((c) => c.bid > 0 && c.ask > 0);
  const ivSample = liquidAtmCalls.length >= 3 ? liquidAtmCalls : atmCalls;
  const iv = ivSample.reduce((s, c) => s + c.impliedVolatility, 0) / ivSample.length;
  return { iv, expiry: bestExp };
}

function computeForwardFromOptions(
  chains: OptionQuote[],
  underlying: number,
  expiry: string,
): number | null {
  const expChains = chains.filter((c) => c.expiration === expiry);
  const strikes = [...new Set(expChains.map((c) => c.strike))].sort((a, b) => a - b);
  const atmStrike = strikes.reduce(
    (best, s) => (Math.abs(s - underlying) < Math.abs(best - underlying) ? s : best),
    strikes[0] ?? 0,
  );
  if (!atmStrike) return null;

  const call = expChains.find((c) => c.type === "call" && c.strike === atmStrike && c.mid > 0);
  const put = expChains.find((c) => c.type === "put" && c.strike === atmStrike && c.mid > 0);
  if (!call || !put) return null;

  // Put-call parity: Forward = Strike + Call_mid - Put_mid
  return atmStrike + call.mid - put.mid;
}

function pmImpliedEVFromTouches(
  strikes: PriceStrike[],
  spot: number,
): { ev: number; medianMax: number; medianMin: number; impliedVol: number } {
  // Include resolved (P=1.0) strikes as boundaries, exclude P=0
  const above = strikes
    .filter((s) => s.direction === "above" && s.yesPrice > 0)
    .sort((a, b) => a.strike - b.strike);
  const below = strikes
    .filter((s) => s.direction === "below" && s.yesPrice > 0)
    .sort((a, b) => b.strike - a.strike);

  // For EV integration, only use forward-looking (P < 1) strikes
  const aboveLive = above.filter((s) => s.yesPrice < 1);
  const belowLive = below.filter((s) => s.yesPrice < 1);

  // Expected maximum: E[max] = spot + ∫ P(max > x) dx (trapezoidal on above strikes)
  let expectedMax = spot;
  for (let i = 0; i < aboveLive.length; i++) {
    const lo = i === 0 ? spot : aboveLive[i - 1].strike;
    const hi = aboveLive[i].strike;
    const pLo = i === 0 ? 1.0 : aboveLive[i - 1].yesPrice;
    const pHi = aboveLive[i].yesPrice;
    expectedMax += ((pLo + pHi) / 2) * (hi - lo);
  }

  // Expected minimum: E[min] = spot - ∫ P(min < x) dx
  let expectedMin = spot;
  for (let i = 0; i < belowLive.length; i++) {
    const hi = i === 0 ? spot : belowLive[i - 1].strike;
    const lo = belowLive[i].strike;
    const pHi = i === 0 ? 1.0 : belowLive[i - 1].yesPrice;
    const pLo = belowLive[i].yesPrice;
    expectedMin -= ((pHi + pLo) / 2) * (hi - lo);
  }

  // Median max: interpolate where P(touch above) crosses 50%
  // Use ALL strikes (including resolved) for proper boundary detection
  let medianMax = spot;
  const aboveIdx = above.findIndex((s) => s.yesPrice < 0.5);
  if (aboveIdx > 0) {
    const hi = above[aboveIdx - 1];
    const lo = above[aboveIdx];
    const frac = (0.5 - lo.yesPrice) / (hi.yesPrice - lo.yesPrice);
    medianMax = lo.strike + frac * (hi.strike - lo.strike);
  } else if (aboveIdx === 0) {
    // First above strike already < 50%; median is between spot and that strike
    const s = above[0];
    medianMax = spot + (s.strike - spot) * (0.5 / Math.max(0.01, s.yesPrice));
    medianMax = Math.min(medianMax, s.strike);
  } else if (above.length > 0) {
    medianMax = above[above.length - 1].strike;
  }

  // Median min: interpolate where P(touch below) crosses 50%
  let medianMin = spot;
  const belowIdx = below.findIndex((s) => s.yesPrice < 0.5);
  if (belowIdx > 0) {
    const hi = below[belowIdx - 1];
    const lo = below[belowIdx];
    const frac = (0.5 - lo.yesPrice) / (hi.yesPrice - lo.yesPrice);
    medianMin = hi.strike - frac * (hi.strike - lo.strike);
  } else if (belowIdx === 0) {
    // First below strike already < 50%; median is between spot and that strike
    const s = below[0];
    medianMin = spot - (spot - s.strike) * (0.5 / Math.max(0.01, s.yesPrice));
    medianMin = Math.max(medianMin, s.strike);
  } else if (below.length > 0) {
    medianMin = below[below.length - 1].strike;
  }

  // Implied EV: spot adjusted by the asymmetry between upside/downside touch mass
  const upside = expectedMax - spot;
  const downside = spot - expectedMin;
  const ev = spot + (upside - downside) * 0.35;

  // Implied annual vol from the market's actual remaining term.
  const rangeRatio = Math.max(0.01, (medianMax - medianMin) / spot);
  const T = yearsToExpiry(strikes);
  const impliedVol = rangeRatio / (Math.sqrt(T) * 1.6);

  return { ev, medianMax, medianMin, impliedVol };
}

function yearsToExpiry(strikes: PriceStrike[]): number {
  const now = Date.now();
  const expiries = strikes
    .map((s) => (s.endDate ? new Date(s.endDate).getTime() : NaN))
    .filter((t) => Number.isFinite(t) && t > now);
  if (expiries.length === 0) return 0.75;

  const expiry = Math.max(...expiries);
  const days = Math.max(1, (expiry - now) / 86400000);
  return days / 365;
}

function pmImpliedEVFromSettlement(
  strikes: PriceStrike[],
): number | null {
  // Settlement markets have BUCKET probabilities (not cumulative).
  // Each strike's yesPrice = P(settle in that bucket).
  // Above strikes are sorted desc: the highest is the top bucket (e.g., ">$84"),
  // followed by range buckets whose lower bounds decrease.
  const above = strikes
    .filter((s) => s.direction === "above" && s.yesPrice > 0)
    .sort((a, b) => b.strike - a.strike);
  const below = strikes
    .filter((s) => s.direction === "below" && s.yesPrice > 0)
    .sort((a, b) => a.strike - b.strike);

  if (above.length < 2) return null;

  let ev = 0;
  for (let i = 0; i < above.length; i++) {
    let midpoint: number;
    if (i === 0) {
      // Top bucket: ">$X". Estimate midpoint as strike * 1.08
      midpoint = above[i].strike * 1.08;
    } else {
      // Range bucket between this strike and the one above it
      midpoint = (above[i].strike + above[i - 1].strike) / 2;
    }
    ev += midpoint * above[i].yesPrice;
  }

  for (const s of below) {
    ev += s.strike * 0.9 * s.yesPrice;
  }

  return ev > 0 ? ev : null;
}

function impliedValuations(
  hl: Record<string, any>,
  pm: PolymarketEvent[],
  opts: Record<string, OptionsSnapshot>,
) {
  if (JSON_OUTPUT) return;

  divider("IMPLIED VALUATIONS & VOLATILITY");

  const valuations: AssetValuation[] = [];

  // ── BITCOIN ──
  {
    const spot = hl.BTC?.markPx ?? 0;
    const disc: string[] = [];
    const iv30 = opts.IBIT ? getIVForTenor(opts.IBIT.chains, opts.IBIT.underlyingPrice, 30) : null;
    const iv90 = opts.IBIT ? getIVForTenor(opts.IBIT.chains, opts.IBIT.underlyingPrice, 90) : null;

    let optFwd: number | null = null;
    let optFwdExpiry = "";
    if (opts.IBIT && iv90) {
      const ibitFwd = computeForwardFromOptions(opts.IBIT.chains, opts.IBIT.underlyingPrice, iv90.expiry);
      if (ibitFwd) {
        const ratio = spot / opts.IBIT.underlyingPrice;
        optFwd = ibitFwd * ratio;
        optFwdExpiry = iv90.expiry;
      }
    }

    const btcEvent = pm.find((e) => e.slug.includes("bitcoin"));
    let pmEV: number | null = null;
    let pmVol: number | null = null;
    let medMax = 0, medMin = 0;
    let pmMethod = "";
    if (btcEvent) {
      const result = pmImpliedEVFromTouches(btcEvent.strikes, spot);
      pmEV = result.ev;
      pmVol = result.impliedVol;
      medMax = result.medianMax;
      medMin = result.medianMin;
      pmMethod = "touch-probability weighted";
    }

    const funding = hl.BTC?.fundingAnnualized ?? 0;

    // Discrepancies
    if (optFwd && pmEV && Math.abs(optFwd - pmEV) / spot > 0.05) {
      const optDir = optFwd > spot ? "bullish" : "bearish";
      const pmDir = pmEV > spot ? "bullish" : "bearish";
      if (optDir !== pmDir) {
        disc.push(`OPTIONS vs POLYMARKET: Options imply ${optDir} ($${fmt(optFwd, 0)}), Polymarket imply ${pmDir} ($${fmt(pmEV, 0)})`);
      }
    }
    if (iv90 && pmVol && Math.abs(iv90.iv - pmVol) / iv90.iv > 0.25) {
      const higher = iv90.iv > pmVol ? "Options" : "Polymarket";
      const lower = iv90.iv > pmVol ? "Polymarket" : "Options";
      disc.push(`VOL MISMATCH: ${higher} IV (${(Math.max(iv90.iv, pmVol) * 100).toFixed(0)}%) >> ${lower} IV (${(Math.min(iv90.iv, pmVol) * 100).toFixed(0)}%) → ${higher} tails may be OVERPRICED`);
    }
    if (funding < -0.05 && pmEV && pmEV > spot * 1.02) {
      disc.push(`FUNDING vs PM: HL shorts pay (${(funding * 100).toFixed(1)}% ann) but PM is bullish → PM upside may be CHEAP`);
    } else if (funding > 0.1 && pmEV && pmEV < spot * 0.98) {
      disc.push(`FUNDING vs PM: HL longs pay (${(funding * 100).toFixed(1)}% ann) but PM is bearish → PM downside may be CHEAP`);
    }

    if (!JSON_OUTPUT && spot > 0) {
      console.log(`\n  ┌─ BITCOIN (BTC) ─────────────────────────────`);
      console.log(`  │  Spot:             $${fmt(spot, 0)}  (HL perp)`);
      if (opts.IBIT) console.log(`  │  IBIT Spot:        $${fmt(opts.IBIT.underlyingPrice)}  (→ BTC ≈ $${fmt(spot, 0)})`);
      console.log(`  │`);
      console.log(`  │  ── Options-Implied ──`);
      if (iv30) console.log(`  │  30d IV:           ${(iv30.iv * 100).toFixed(1)}%  (exp ${iv30.expiry})`);
      if (iv90) console.log(`  │  90d IV:           ${(iv90.iv * 100).toFixed(1)}%  (exp ${iv90.expiry})`);
      if (optFwd) console.log(`  │  Forward (90d):    $${fmt(optFwd, 0)}  (${((optFwd / spot - 1) * 100).toFixed(1)}% from spot)`);
      console.log(`  │`);
      console.log(`  │  ── Polymarket-Implied ──`);
      if (pmEV) console.log(`  │  Implied EV:       $${fmt(pmEV, 0)}  (${((pmEV / spot - 1) * 100).toFixed(1)}% from spot) [${pmMethod}]`);
      if (medMax) console.log(`  │  Median Max Touch: $${fmt(medMax, 0)}  (50% chance BTC reaches this high)`);
      if (medMin) console.log(`  │  Median Min Touch: $${fmt(medMin, 0)}  (50% chance BTC drops this low)`);
      if (pmVol) console.log(`  │  PM Implied Vol:   ${(pmVol * 100).toFixed(1)}% ann`);
      console.log(`  │`);
      console.log(`  │  ── Directional ──`);
      console.log(`  │  HL Funding (ann):  ${(funding * 100).toFixed(2)}%  ${funding < -0.03 ? "(shorts pay → bearish crowding)" : funding > 0.1 ? "(longs pay → bullish crowding)" : "(neutral)"}`);
      if (opts.IBIT) {
        const pc = opts.IBIT.chains.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0) /
          Math.max(1, opts.IBIT.chains.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0));
        console.log(`  │  IBIT P/C Ratio:   ${pc.toFixed(3)}  ${pc > 1.2 ? "(put-heavy → hedging/bearish)" : pc < 0.6 ? "(call-heavy → bullish)" : "(balanced)"}`);
      }
      if (disc.length > 0) {
        console.log(`  │`);
        console.log(`  │  ── DISCREPANCIES ──`);
        for (const d of disc) console.log(`  │  ⚡ ${d}`);
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // ── HYPE ──
  {
    const spot = hl.HYPE?.markPx ?? 0;
    const disc: string[] = [];
    const hypeEvent = pm.find((e) => e.slug.includes("hyperliquid"));
    const funding = hl.HYPE?.fundingAnnualized ?? 0;

    let pmEV: number | null = null;
    let pmVol: number | null = null;
    let medMax = 0, medMin = 0;
    if (hypeEvent && spot > 0) {
      const result = pmImpliedEVFromTouches(hypeEvent.strikes, spot);
      pmEV = result.ev;
      pmVol = result.impliedVol;
      medMax = result.medianMax;
      medMin = result.medianMin;
    }

    if (funding < -0.05 && pmEV && pmEV > spot * 1.05) {
      disc.push(`FUNDING vs PM: Shorts crowded (${(funding * 100).toFixed(1)}% ann) but PM bullish EV ($${fmt(pmEV!, 0)}) → SHORT SQUEEZE potential`);
    }

    if (!JSON_OUTPUT && spot > 0) {
      console.log(`\n  ┌─ HYPERLIQUID (HYPE) ────────────────────────`);
      console.log(`  │  Spot:             $${fmt(spot, 4)}  (HL perp)`);
      console.log(`  │  No options market (crypto-only perp)`);
      console.log(`  │`);
      console.log(`  │  ── Polymarket-Implied ──`);
      if (pmEV) console.log(`  │  Implied EV:       $${fmt(pmEV, 2)}  (${((pmEV / spot - 1) * 100).toFixed(1)}% from spot)`);
      if (medMax) console.log(`  │  Median Max Touch: $${fmt(medMax, 1)}  (50% chance HYPE reaches this)`);
      if (medMin) console.log(`  │  Median Min Touch: $${fmt(medMin, 1)}  (50% chance HYPE drops to this)`);
      if (pmVol) console.log(`  │  PM Implied Vol:   ${(pmVol * 100).toFixed(1)}% ann`);
      console.log(`  │`);
      console.log(`  │  ── Directional ──`);
      console.log(`  │  HL Funding (ann):  ${(funding * 100).toFixed(2)}%  ${funding < -0.05 ? "(shorts pay → bearish crowding)" : funding > 0.15 ? "(longs pay → bullish crowding)" : "(neutral)"}`);
      console.log(`  │  HL OI:             ${fmtUsd(hl.HYPE?.openInterestUsd ?? 0)}`);
      if (disc.length > 0) {
        console.log(`  │`);
        console.log(`  │  ── DISCREPANCIES ──`);
        for (const d of disc) console.log(`  │  ⚡ ${d}`);
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // ── GOLD ──
  {
    const goldPerp = hl["GOLD (GC)"];
    const hlSpot = goldPerp?.markPx ?? 0;
    const disc: string[] = [];

    const goldHitJun = pm.find((e) => e.slug === "gc-hit-jun-2026");
    const goldSettleJun = pm.find((e) => e.slug === "gc-settle-jun-2026");
    const goldHitDec = pm.find((e) => e.slug.includes("gold-gc") && e.slug.includes("december"));
    const goldEvent = goldHitJun ?? goldHitDec;
    let pmEV: number | null = null;
    let pmSettleEV: number | null = null;
    let pmVol: number | null = null;
    let goldMedMax = 0;
    let goldMedMin = 0;
    const funding = goldPerp?.fundingAnnualized ?? 0;

    if (goldSettleJun) {
      pmSettleEV = pmImpliedEVFromSettlement(goldSettleJun.strikes);
    }

    if (goldEvent && hlSpot > 0) {
      const result = pmImpliedEVFromTouches(goldEvent.strikes, hlSpot);
      pmEV = pmSettleEV ?? result.ev;
      pmVol = result.impliedVol;
      goldMedMax = result.medianMax;
      goldMedMin = result.medianMin;
    }

    if (funding > 0.05 && pmEV && pmEV > hlSpot * 1.1) {
      disc.push(`FUNDING CONFIRMS PM: Longs pay ${(funding * 100).toFixed(1)}% ann + PM bullish EV → consensus upside`);
    }

    if (!JSON_OUTPUT && hlSpot > 0) {
      console.log(`\n  ┌─ GOLD (GC) ────────────────────────────────`);
      if (hlSpot) console.log(`  │  GC Perp:          $${fmt(hlSpot, 0)}  (HL xyz DEX)`);
      console.log(`  │`);
      console.log(`  │  ── Options-Implied ──`);
      console.log(`  │  Gold options:     skipped until a real CME GC options source is configured`);
      console.log(`  │`);
      console.log(`  │  ── Polymarket-Implied ──${goldHitJun ? "" : "  (Dec market — upside only)"}`);
      if (pmSettleEV) console.log(`  │  Settlement EV:    $${fmt(pmSettleEV, 0)}  (Jun 2026, ${((pmSettleEV / hlSpot - 1) * 100).toFixed(1)}% from spot)`);
      else if (pmEV) console.log(`  │  Implied EV:       $${fmt(pmEV, 0)}  (${((pmEV / hlSpot - 1) * 100).toFixed(1)}% from spot)`);
      if (goldMedMax) console.log(`  │  Median Max Touch: $${fmt(goldMedMax, 0)}  (50% chance GC reaches this by ${goldHitJun ? "Jun" : "Dec"})`);
      if (goldMedMin && goldMedMin < hlSpot * 0.99) console.log(`  │  Median Min Touch: $${fmt(goldMedMin, 0)}  (50% chance GC drops to this)`);
      if (pmVol) console.log(`  │  PM Implied Vol:   ${(pmVol * 100).toFixed(1)}% ann${goldHitJun ? "" : "  (upside only, likely understated)"}`);
      console.log(`  │`);
      console.log(`  │  ── Directional ──`);
      if (hlSpot) console.log(`  │  HL Funding (ann):  ${(funding * 100).toFixed(2)}%  ${funding > 0.05 ? "(longs pay → bullish crowding)" : "(neutral)"}`);
      if (disc.length > 0) {
        console.log(`  │`);
        console.log(`  │  ── DISCREPANCIES ──`);
        for (const d of disc) console.log(`  │  ⚡ ${d}`);
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // ── AMAZON ──
  {
    const amznPerp = hl["AMZN"];
    const hlSpot = amznPerp?.markPx ?? 0;
    const optSpot = opts.AMZN?.underlyingPrice ?? 0;
    const disc: string[] = [];

    const iv30 = opts.AMZN ? getIVForTenor(opts.AMZN.chains, optSpot, 30) : null;
    const iv90 = opts.AMZN ? getIVForTenor(opts.AMZN.chains, optSpot, 90) : null;

    let optFwd: number | null = null;
    let optFwdExpiry = "";
    if (opts.AMZN && iv90) {
      optFwd = computeForwardFromOptions(opts.AMZN.chains, optSpot, iv90.expiry);
      optFwdExpiry = iv90.expiry;
    }

    const funding = amznPerp?.fundingAnnualized ?? 0;

    if (hlSpot > 0 && optSpot > 0) {
      const basis = ((hlSpot / optSpot) - 1) * 100;
      if (Math.abs(basis) > 0.3) {
        disc.push(`HL vs CBOE BASIS: Perp $${fmt(hlSpot)} vs stock $${fmt(optSpot)} (${basis > 0 ? "+" : ""}${basis.toFixed(2)}% basis) → ${basis < -0.5 ? "PERP DISCOUNT (short crowding)" : basis > 0.5 ? "PERP PREMIUM" : "minor"}`);
      }
    }
    if (funding < -0.1 && optSpot > 0) {
      const pcr = opts.AMZN
        ? opts.AMZN.chains.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0) /
          Math.max(1, opts.AMZN.chains.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0))
        : 0;
      if (pcr < 0.8) {
        disc.push(`FUNDING vs OPTIONS: HL shorts crowded (${(funding * 100).toFixed(1)}% ann) but options P/C ${pcr.toFixed(2)} is not bearish → POTENTIAL DIVERGENCE`);
      }
    }

    if (!JSON_OUTPUT && (hlSpot > 0 || optSpot > 0)) {
      console.log(`\n  ┌─ AMAZON (AMZN) ─────────────────────────────`);
      if (hlSpot) console.log(`  │  HL Perp:          $${fmt(hlSpot)}  (xyz DEX)`);
      if (optSpot) console.log(`  │  Stock:            $${fmt(optSpot)}  (CBOE)`);
      console.log(`  │`);
      console.log(`  │  ── Options-Implied ──`);
      if (iv30) console.log(`  │  30d IV:           ${(iv30.iv * 100).toFixed(1)}%  (exp ${iv30.expiry})`);
      if (iv90) console.log(`  │  90d IV:           ${(iv90.iv * 100).toFixed(1)}%  (exp ${iv90.expiry})`);
      if (optFwd) console.log(`  │  Forward (90d):    $${fmt(optFwd)}  (${((optFwd / optSpot - 1) * 100).toFixed(1)}% from spot)`);
      console.log(`  │`);
      console.log(`  │  ── Directional ──`);
      if (hlSpot) console.log(`  │  HL Funding (ann):  ${(funding * 100).toFixed(2)}%  ${funding < -0.1 ? "(shorts pay → bearish crowding)" : funding > 0.1 ? "(longs pay → bullish)" : "(neutral)"}`);
      if (opts.AMZN) {
        const pc = opts.AMZN.chains.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0) /
          Math.max(1, opts.AMZN.chains.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0));
        console.log(`  │  AMZN P/C Ratio:   ${pc.toFixed(3)}  ${pc > 1.2 ? "(put-heavy → hedging)" : pc < 0.6 ? "(call-heavy → bullish)" : "(balanced)"}`);
      }
      if (disc.length > 0) {
        console.log(`  │`);
        console.log(`  │  ── DISCREPANCIES ──`);
        for (const d of disc) console.log(`  │  ⚡ ${d}`);
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // ── OIL (CL / Brent) ──
  {
    const wtiPerp = hl["OIL (CL)"];
    const brentPerp = hl["BRENT OIL"];
    const wtiSpot = wtiPerp?.markPx ?? 0;
    const brentSpot = brentPerp?.markPx ?? 0;
    const disc: string[] = [];

    const optFwd: number | null = null;

    const clSettle = pm.find((e) => e.slug === "cl-settle-jun-2026");
    const clHit = pm.find((e) => e.slug === "cl-hit-jun-2026");
    const clOverUnder = pm.find((e) => e.slug === "cl-over-under-jun-2026");

    let pmSettleEV: number | null = null;
    if (clSettle) {
      pmSettleEV = pmImpliedEVFromSettlement(clSettle.strikes);
    }

    let pmVol: number | null = null;
    if (clHit) {
      const result = pmImpliedEVFromTouches(clHit.strikes, wtiSpot);
      pmVol = result.impliedVol;
    }

    const funding = wtiPerp?.fundingAnnualized ?? 0;

    // Brent-WTI spread
    const spread = brentSpot - wtiSpot;
    if (spread > 15) {
      disc.push(`BRENT-WTI SPREAD: $${fmt(spread, 1)} (historically wide, >$15 signals geopolitical premium)`);
    }

    // HL funding vs Polymarket direction
    if (funding < -0.15 && pmSettleEV && wtiSpot && pmSettleEV > wtiSpot * 1.02) {
      disc.push(`FUNDING vs PM BUCKETS: HL CL shorts crowded (${(funding * 100).toFixed(1)}% ann) while PM settlement bucket-forward is $${fmt(pmSettleEV, 0)} above WTI spot; monitor bucket-forward drift, not spot reversion to PM EV`);
    }

    // Options forward vs PM settle EV
    if (optFwd && pmSettleEV && Math.abs(optFwd - pmSettleEV) / wtiSpot > 0.05) {
      disc.push(`OPTIONS vs PM BUCKETS: Options forward $${fmt(optFwd, 1)} vs PM settlement bucket-forward $${fmt(pmSettleEV, 0)} → ${Math.abs(optFwd - pmSettleEV).toFixed(1)} drift gap`);
    }

    if (!JSON_OUTPUT && (brentSpot > 0 || wtiSpot > 0)) {
      console.log(`\n  ┌─ OIL (CL / Brent) ─────────────────────────`);
      if (wtiSpot) console.log(`  │  WTI CL Perp:      $${fmt(wtiSpot)}  (HL xyz DEX; CME chart cross-check)`);
      if (brentSpot) console.log(`  │  Brent Perp:       $${fmt(brentSpot)}  (HL xyz DEX)`);
      if (brentSpot && wtiSpot) console.log(`  │  Brent-WTI Spread: $${fmt(spread, 1)}`);
      console.log(`  │`);
      console.log(`  │  ── Options-Implied ──`);
      console.log(`  │  Crude options:    skipped until a real CME crude options source is configured`);
      if (optFwd) console.log(`  │  Forward (90d):    $${fmt(optFwd, 1)}  (${((optFwd / wtiSpot - 1) * 100).toFixed(1)}% from WTI spot)`);
      console.log(`  │`);
      console.log(`  │  ── Polymarket-Implied ──`);
      if (pmSettleEV) console.log(`  │  Settlement EV:    $${fmt(pmSettleEV, 1)}  (Jun 2026, ${((pmSettleEV / wtiSpot - 1) * 100).toFixed(1)}% from WTI spot)`);
      if (pmVol) console.log(`  │  PM Implied Vol:   ${(pmVol * 100).toFixed(1)}% ann`);
      console.log(`  │`);
      console.log(`  │  ── Directional ──`);
      if (wtiSpot) console.log(`  │  HL CL Funding:    ${(funding * 100).toFixed(2)}%  ${funding < -0.15 ? "(SHORTS PAY — heavy crowding)" : funding < -0.05 ? "(shorts pay)" : "(neutral)"}`);
      if (disc.length > 0) {
        console.log(`  │`);
        console.log(`  │  ── DISCREPANCIES ──`);
        for (const d of disc) console.log(`  │  ⚡ ${d}`);
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // ── SUMMARY TABLE ──
  if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
    console.log(`\n  ┌─ SUMMARY ────────────────────────────────────`);
    console.log(`  │  ${"Asset".padEnd(10)} ${"Spot".padStart(10)} ${"Opt Fwd".padStart(10)} ${"PM EV".padStart(10)} ${"Opt IV".padStart(8)} ${"PM IV".padStart(8)} ${"HL Fund".padStart(8)}`);
    console.log(`  │  ${"─".repeat(66)}`);

    const rows: [string, number, number | null, number | null, number | null, number | null, number | null][] = [];

    // BTC
    const btcSpot = hl.BTC?.markPx ?? 0;
    const btcIv90 = opts.IBIT ? getIVForTenor(opts.IBIT.chains, opts.IBIT.underlyingPrice, 90) : null;
    const btcEvent = pm.find((e) => e.slug.includes("bitcoin"));
    const btcPmResult = btcEvent && btcSpot > 0 ? pmImpliedEVFromTouches(btcEvent.strikes, btcSpot) : null;
    let btcFwd: number | null = null;
    if (opts.IBIT && btcIv90) {
      const ibitFwd = computeForwardFromOptions(opts.IBIT.chains, opts.IBIT.underlyingPrice, btcIv90.expiry);
      if (ibitFwd) btcFwd = ibitFwd * (btcSpot / opts.IBIT.underlyingPrice);
    }
    rows.push(["BTC", btcSpot, btcFwd, btcPmResult?.ev ?? null, btcIv90?.iv ?? null, btcPmResult?.impliedVol ?? null, hl.BTC?.fundingAnnualized ?? null]);

    // HYPE
    const hypeSpot = hl.HYPE?.markPx ?? 0;
    const hypeEvent = pm.find((e) => e.slug.includes("hyperliquid"));
    const hypePmResult = hypeEvent && hypeSpot > 0 ? pmImpliedEVFromTouches(hypeEvent.strikes, hypeSpot) : null;
    rows.push(["HYPE", hypeSpot, null, hypePmResult?.ev ?? null, null, hypePmResult?.impliedVol ?? null, hl.HYPE?.fundingAnnualized ?? null]);

    // GOLD
    const goldSpot = hl["GOLD (GC)"]?.markPx ?? 0;
    const goldHitEv = pm.find((e) => e.slug === "gc-hit-jun-2026") ?? pm.find((e) => e.slug.includes("gold-gc"));
    const goldSettleEv = pm.find((e) => e.slug === "gc-settle-jun-2026");
    const goldPmResult = goldHitEv && goldSpot > 0 ? pmImpliedEVFromTouches(goldHitEv.strikes, goldSpot) : null;
    const goldPmSettleEV = goldSettleEv ? pmImpliedEVFromSettlement(goldSettleEv.strikes) : null;
    rows.push(["GOLD", goldSpot, null, goldPmSettleEV ?? goldPmResult?.ev ?? null, null, goldPmResult?.impliedVol ?? null, hl["GOLD (GC)"]?.fundingAnnualized ?? null]);

    // AMZN
    const amznSpot = opts.AMZN?.underlyingPrice ?? hl["AMZN"]?.markPx ?? 0;
    const amznIv90 = opts.AMZN ? getIVForTenor(opts.AMZN.chains, amznSpot, 90) : null;
    let amznFwd: number | null = null;
    if (opts.AMZN && amznIv90) amznFwd = computeForwardFromOptions(opts.AMZN.chains, amznSpot, amznIv90.expiry);
    rows.push(["AMZN", amznSpot, amznFwd, null, amznIv90?.iv ?? null, null, hl["AMZN"]?.fundingAnnualized ?? null]);

    // OIL. Do not use CBOE symbol CL here: that endpoint is Colgate-Palmolive stock.
    const clSpot = hl["OIL (CL)"]?.markPx ?? 0;
    const clFwd: number | null = null;
    const clSettleEv = pm.find((e) => e.slug === "cl-settle-jun-2026");
    const clPmEV = clSettleEv ? pmImpliedEVFromSettlement(clSettleEv.strikes) : null;
    const clHitEv = pm.find((e) => e.slug === "cl-hit-jun-2026");
    const clPmVol = clHitEv && clSpot > 0 ? pmImpliedEVFromTouches(clHitEv.strikes, clSpot).impliedVol : null;
    rows.push(["OIL(WTI)", clSpot, clFwd, clPmEV, null, clPmVol, hl["OIL (CL)"]?.fundingAnnualized ?? null]);

    for (const [name, spot, fwd, pmEv, optIv, pmIv, fund] of rows) {
      const fmtVal = (v: number | null, d = 0) => v ? `$${fmt(v, d)}` : "N/A";
      const fmtPct = (v: number | null) => v ? `${(v * 100).toFixed(0)}%` : "N/A";
      console.log(
        `  │  ${name.padEnd(10)} ${fmtVal(spot, spot > 1000 ? 0 : 2).padStart(10)} ${fmtVal(fwd, fwd && fwd > 1000 ? 0 : 2).padStart(10)} ${fmtVal(pmEv, pmEv && pmEv > 1000 ? 0 : 2).padStart(10)} ${fmtPct(optIv).padStart(8)} ${fmtPct(pmIv).padStart(8)} ${fund !== null ? (fund * 100).toFixed(1) + "%" : "N/A".padStart(4)}`.padEnd(75),
      );
    }
    console.log(`  └────────────────────────────────────────────`);
  }
}

// ─── 5. Cross-Source Analysis ───────────────────────────────────────────────

function crossAnalysis(
  hl: Record<string, any>,
  pm: PolymarketEvent[],
  opts: Record<string, OptionsSnapshot>
) {
  divider("CROSS-SOURCE SIGNALS");

  const btcEvent = pm.find((e) => e.slug.includes("bitcoin"));
  const hypeEvent = pm.find((e) => e.slug.includes("hyperliquid"));

  // BTC: HL funding + IBIT options IV + Polymarket implied distribution
  if (hl.BTC) {
    const funding = hl.BTC.fundingAnnualized;
    const btcSpot = hl.BTC.markPx;

    const ibitAtmIV =
      opts.IBIT?.chains
        .filter(
          (c) =>
            c.type === "call" &&
            Math.abs(c.strike - opts.IBIT!.underlyingPrice) / opts.IBIT!.underlyingPrice < 0.05 &&
            c.impliedVolatility > 0
        )
        .reduce((s, c, _, a) => s + c.impliedVolatility / a.length, 0) ?? 0;

    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      console.log(`\n  ┌─ BITCOIN Cross-Source ────────────────────────`);
      console.log(`  │  HL BTC Spot:       $${fmt(btcSpot)}`);
      console.log(`  │  HL Funding (ann):  ${pct(funding)}  ${funding > 0.15 ? "← HIGH (longs crowded)" : funding < -0.05 ? "← NEGATIVE (shorts crowded)" : "← neutral"}`);
      console.log(`  │  HL 24h Volume:     ${fmtUsd(hl.BTC.dayVolume)}`);
      console.log(`  │  HL OI:             ${fmtUsd(hl.BTC.openInterestUsd)}`);
      if (opts.IBIT) {
        console.log(`  │  IBIT Spot:         $${fmt(opts.IBIT.underlyingPrice)}`);
        if (ibitAtmIV > 0) {
          console.log(`  │  IBIT ATM IV:       ${(ibitAtmIV * 100).toFixed(1)}%  ${ibitAtmIV > 0.6 ? "← HIGH, pricing big move" : ibitAtmIV < 0.3 ? "← LOW, market complacent" : ""}`);
        }
      }
      if (btcEvent) {
        const nearStrikes = btcEvent.strikes
          .filter((s) => s.strike >= btcSpot * 0.8 && s.strike <= btcSpot * 3)
          .slice(0, 6);
        if (nearStrikes.length > 0) {
          console.log(`  │`);
          console.log(`  │  Polymarket implied distribution (2026):`);
          for (const s of nearStrikes) {
            const prob = s.yesPrice * 100;
            console.log(
              `  │    BTC ${s.direction === "above" ? ">" : "<"} $${fmt(s.strike, 0).padEnd(8)} ${prob.toFixed(1).padStart(5)}% YES  ${"█".repeat(Math.round(prob / 2))}`
            );
          }
        }
      }

      // Signal synthesis
      console.log(`  │`);
      if (funding > 0.15 && ibitAtmIV > 0.5) {
        console.log(`  │  SIGNAL: High funding + high IV = crowded longs priced into options`);
        console.log(`  │          Polymarket upside tails may be OVERPRICED`);
      } else if (funding < -0.05 && ibitAtmIV < 0.35) {
        console.log(`  │  SIGNAL: Negative funding + low IV = complacent + shorts crowded`);
        console.log(`  │          Polymarket upside tails may be UNDERPRICED`);
      } else {
        console.log(`  │  SIGNAL: No strong cross-source divergence`);
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // HYPE: HL funding/OI + Polymarket price distribution
  if (hl.HYPE) {
    const funding = hl.HYPE.fundingAnnualized;
    const hypeSpot = hl.HYPE.markPx;

    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      console.log(`\n  ┌─ HYPE Cross-Source ──────────────────────────`);
      console.log(`  │  HL HYPE Spot:      $${fmt(hypeSpot, 4)}`);
      console.log(`  │  HL Funding (ann):  ${pct(funding)}  ${funding > 0.3 ? "← HIGH (longs crowded)" : funding < -0.1 ? "← NEGATIVE (shorts crowded)" : "← neutral"}`);
      console.log(`  │  HL OI:             ${fmtUsd(hl.HYPE.openInterestUsd)}`);
      console.log(`  │  HL 24h Volume:     ${fmtUsd(hl.HYPE.dayVolume)}`);

      if (hypeEvent) {
        console.log(`  │`);
        console.log(`  │  Polymarket implied distribution (2026):`);
        for (const s of hypeEvent.strikes) {
          const prob = s.yesPrice * 100;
          console.log(
            `  │    HYPE ${s.direction === "above" ? ">" : "<"} $${fmt(s.strike, 0).padEnd(5)} ${prob.toFixed(1).padStart(5)}% YES  ${"█".repeat(Math.round(prob / 2))}`
          );
        }

        // Compare HL spot to Polymarket distribution
        const aboveSpot = hypeEvent.strikes.filter(
          (s) => s.direction === "above" && s.strike > hypeSpot
        );
        const nearestAbove = aboveSpot[aboveSpot.length - 1];
        if (nearestAbove) {
          console.log(`  │`);
          console.log(
            `  │  Nearest above-spot strike: $${fmt(nearestAbove.strike, 0)} → ${(nearestAbove.yesPrice * 100).toFixed(1)}% YES`
          );
          if (funding > 0.3 && nearestAbove.yesPrice > 0.5) {
            console.log(`  │  SIGNAL: High funding + high Polymarket prob → crowded trade, fade upside`);
          } else if (funding < -0.1 && nearestAbove.yesPrice < 0.3) {
            console.log(`  │  SIGNAL: Negative funding + low Polymarket prob → contrarian buy on upside tails`);
          }
        }
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // Gold: xyz:GOLD perp + Polymarket GC strikes. GLD is not used as an options proxy.
  const goldEventJun = pm.find((e) => e.slug === "gc-hit-jun-2026");
  const goldEventDec = pm.find((e) => e.slug.includes("gold-gc") && e.slug.includes("december"));
  const goldEvent = goldEventJun ?? goldEventDec;
  const goldPerp = hl["GOLD (GC)"];
  if (goldEvent || goldPerp) {
    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      console.log(`\n  ┌─ GOLD Cross-Source ───────────────────────────`);
      if (goldPerp) {
        console.log(`  │  HL Gold Perp:     $${fmt(goldPerp.markPx)} (xyz DEX)`);
        console.log(`  │  HL Funding (ann): ${pct(goldPerp.fundingAnnualized)}  ${goldPerp.fundingAnnualized > 0.1 ? "← longs pay" : goldPerp.fundingAnnualized < -0.05 ? "← shorts pay" : ""}`);
        console.log(`  │  HL OI:            ${fmtUsd(goldPerp.openInterestUsd)}`);
        console.log(`  │  HL 24h Volume:    ${fmtUsd(goldPerp.dayVolume)}`);
      }
      console.log(`  │  Gold options:     skipped; GLD proxy disabled until CME GC options source is configured`);
      if (goldEvent) {
        console.log(`  │`);
        console.log(`  │  Polymarket Gold (GC) strikes (${goldEventJun ? "Jun" : "Dec"} 2026):`);
        for (const s of goldEvent.strikes) {
          const prob = s.yesPrice * 100;
          console.log(
            `  │    GC ${s.direction === "above" ? ">" : "<"} $${fmt(s.strike, 0).padEnd(8)} ${prob.toFixed(1).padStart(5)}% YES  ${"█".repeat(Math.round(prob / 2))}`
          );
        }
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // Amazon: xyz:AMZN perp + AMZN options
  const amznPerp = hl["AMZN"];
  if (opts.AMZN || amznPerp) {
    const nearest = [...new Set(opts.AMZN.chains.map((c) => c.expiration))].filter(Boolean).sort()[0];
    const nearChains = opts.AMZN.chains.filter((c) => c.expiration === nearest);
    const putVol = nearChains.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0);
    const callVol = nearChains.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0);
    const pcRatio = callVol > 0 ? putVol / callVol : 0;

    const atmCalls = nearChains.filter(
      (c) =>
        c.type === "call" &&
        Math.abs(c.strike - opts.AMZN.underlyingPrice) / opts.AMZN.underlyingPrice < 0.03 &&
        c.impliedVolatility > 0
    );
    const atmIV = atmCalls.length > 0
      ? atmCalls.reduce((s, c) => s + c.impliedVolatility, 0) / atmCalls.length
      : 0;

    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      console.log(`\n  ┌─ AMAZON / AMZN Cross-Source ─────────────────`);
      if (amznPerp) {
        console.log(`  │  HL AMZN Perp:     $${fmt(amznPerp.markPx)} (xyz DEX)`);
        console.log(`  │  HL Funding (ann): ${pct(amznPerp.fundingAnnualized)}  ${amznPerp.fundingAnnualized < -0.1 ? "← SHORTS PAY — bearish crowding" : amznPerp.fundingAnnualized > 0.1 ? "← LONGS PAY" : ""}`);
        console.log(`  │  HL OI:            ${fmtUsd(amznPerp.openInterestUsd)}`);
        console.log(`  │  HL 24h Volume:    ${fmtUsd(amznPerp.dayVolume)}`);
      }
      if (opts.AMZN) {
        console.log(`  │  AMZN Options:     $${fmt(opts.AMZN.underlyingPrice)}`);
        console.log(`  │  Nearest Exp:      ${nearest}`);
        console.log(`  │  Put/Call Ratio:   ${fmt(pcRatio, 3)}  ${pcRatio > 1.5 ? "← heavy put buying" : pcRatio < 0.5 ? "← call-heavy" : "← balanced"}`);
        if (atmIV > 0) {
          console.log(`  │  ATM IV:           ${(atmIV * 100).toFixed(1)}%`);
        }
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }

  // Oil: xyz:CL perp + Polymarket CL strikes. Do not use CBOE symbol CL; it is Colgate stock.
  const oilPerp = hl["OIL (CL)"];
  const clEvents = pm.filter((e) => e.slug.includes("cl-"));
  if (clEvents.length > 0 || oilPerp) {
    if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
      console.log(`\n  ┌─ OIL Cross-Source ───────────────────────────`);
      if (oilPerp) {
        console.log(`  │  HL CL Perp:       $${fmt(oilPerp.markPx)} (xyz DEX; CME chart cross-check)`);
        console.log(`  │  HL Funding (ann): ${pct(oilPerp.fundingAnnualized)}  ${oilPerp.fundingAnnualized < -0.1 ? "← SHORTS PAY" : oilPerp.fundingAnnualized > 0.1 ? "← LONGS PAY" : ""}`);
        console.log(`  │  HL OI:            ${fmtUsd(oilPerp.openInterestUsd)}`);
        console.log(`  │  HL 24h Volume:    ${fmtUsd(oilPerp.dayVolume)}`);
      }
      console.log(`  │  Crude options:    skipped; CBOE CL was Colgate, not WTI crude`);

      if (clEvents.length > 0) {
        for (const ev of clEvents) {
          const liveStrikes = ev.strikes.filter((s) => s.yesPrice > 0 && s.yesPrice < 1);
          if (liveStrikes.length === 0) continue;
          console.log(`  │`);
          console.log(`  │  Polymarket: ${ev.title}`);
          for (const s of liveStrikes.slice(0, 12)) {
            const prob = s.yesPrice * 100;
            console.log(
              `  │    CL ${s.direction === "above" ? ">" : "<"} $${fmt(s.strike, 0).padEnd(5)} ${prob.toFixed(1).padStart(5)}% YES  ${"█".repeat(Math.round(prob / 2))}`
            );
          }
        }
      }
      console.log(`  └────────────────────────────────────────────`);
    }
  }
}

// ─── 5. Bitcoin Outperformance ───────────────────────────────────────────────

interface SimpleMarket {
  question: string;
  yesPrice: number;
  volume: number;
  closed: boolean;
}

interface CategoryEvent {
  title: string;
  slug: string;
  markets: SimpleMarket[];
  totalVolume: number;
}

interface MacroScore {
  fed: { score: number; expectedCuts: number; pAtLeastOneCut: number; medianFirstCut: string; signal: string };
  iran: { score: number; pDealByYE: number; pCeasefire: number | null; pNuclearTest: number; signal: string };
  oil: { score: number; pSettleAboveCurrent: number; pSpike120: number; brentWtiSpread: number; signal: string };
  composite: number;
  label: string;
}

function computeMacroScore(
  macro: CategoryEvent[],
  pm: any[],
  hl: Record<string, any>,
  opts: Record<string, OptionsSnapshot>,
): MacroScore {
  // ── Fed Score (0-100, 100 = very dovish/bullish) ──
  const fedCuts = macro.find((e) => e.slug === "how-many-fed-rate-cuts-in-2026");
  const fedTiming = macro.find((e) => e.slug === "fed-rate-cut-by-629");

  let expectedCuts = 0;
  let pZeroCuts = 0;
  if (fedCuts) {
    const live = fedCuts.markets.filter((m) => !m.closed);
    for (const m of live) {
      const q = m.question.toLowerCase();
      const noMatch = q.match(/no fed rate cut/i);
      const numMatch = q.match(/(\d+)\s+fed rate cut/i);
      const morMatch = q.match(/(\d+) or more/i);
      if (noMatch) {
        pZeroCuts = m.yesPrice;
      } else if (morMatch) {
        expectedCuts += parseInt(morMatch[1]) * m.yesPrice;
      } else if (numMatch) {
        expectedCuts += parseInt(numMatch[1]) * m.yesPrice;
      }
    }
  }
  const pAtLeastOneCut = 1 - pZeroCuts;

  let medianFirstCut = "None";
  if (fedTiming) {
    const sorted = fedTiming.markets
      .filter((m) => !m.closed)
      .map((m) => {
        const monthMatch = m.question.match(/by (\w+ \d{4})/i);
        return { month: monthMatch?.[1] ?? m.question, p: m.yesPrice };
      })
      .sort((a, b) => a.p - b.p);
    const median = sorted.find((s) => s.p >= 0.5);
    medianFirstCut = median?.month ?? sorted[sorted.length - 1]?.month ?? "Unknown";
  }

  // Score: base is P(≥1 cut), adjusted for timing
  const pCutBySept = fedTiming?.markets.find((m) => /september/i.test(m.question))?.yesPrice ?? 0;
  let fedScore = pAtLeastOneCut * 80;
  if (pCutBySept > 0.5) fedScore += 10;
  else if (pCutBySept < 0.3) fedScore -= 10;
  if (expectedCuts >= 2) fedScore += 10;
  else if (expectedCuts < 1) fedScore -= 5;
  fedScore = Math.max(0, Math.min(100, fedScore));

  const fedSignal =
    fedScore >= 70 ? "DOVISH" : fedScore >= 50 ? "MODERATELY HAWKISH" : fedScore >= 30 ? "HAWKISH" : "VERY HAWKISH";

  // ── Iran Score (0-100, 100 = peace/bullish) ──
  const iranDealYE = macro.find((e) => e.slug === "us-iran-nuclear-deal-before-2027");
  const iranNuke = macro.find((e) => e.slug === "iran-nuclear-test-before-2027");
  const iranCeasefire = macro.find((e) => e.slug === "us-x-iran-ceasefire-by");

  const pDealByYE = iranDealYE?.markets[0]?.yesPrice ?? 0;
  const pNuclearTest = iranNuke?.markets[0]?.yesPrice ?? 0;
  const ceasefirePrices = iranCeasefire?.markets
    .map((m) => m.yesPrice)
    .filter((p) => Number.isFinite(p) && p >= 0 && p <= 1) ?? [];
  const pCeasefire = ceasefirePrices.length > 0 ? Math.max(...ceasefirePrices) : null;
  const peaceAgreementInput = pCeasefire ?? pDealByYE;

  let iranScore = ((pDealByYE + peaceAgreementInput) / 2) * 100;
  iranScore -= pNuclearTest * 60;
  iranScore = Math.max(0, Math.min(100, iranScore));

  const iranSignal =
    iranScore >= 60 ? "PEACE LIKELY" : iranScore >= 40 ? "UNCERTAIN" : iranScore >= 20 ? "SKEPTICAL" : "ESCALATION RISK";

  // ── Oil Score (0-100, 100 = declining oil/bullish) ──
  const clSettle = pm.find(
    (ev: any) => ev.slug === "cl-settle-jun-2026" || ev.title?.toLowerCase().includes("settle at in june"),
  );
  const clHit = pm.find(
    (ev: any) => ev.slug === "cl-hit-jun-2026" || ev.title?.toLowerCase().includes("hit__ by end of june"),
  );

  let pSettleAboveCurrent = 0.5;
  if (clSettle) {
    const strikes = (clSettle.strikes ?? clSettle.markets ?? []) as any[];
    const highStrikes = strikes.filter(
      (s: any) => (s.direction === "above" || s.dir === "above") && (s.strike ?? s.price ?? 0) >= 80,
    );
    if (highStrikes.length > 0) {
      pSettleAboveCurrent = Math.max(...highStrikes.map((s: any) => s.yesPrice ?? s.yes ?? 0));
    }
  }

  let pSpike120 = 0;
  if (clHit) {
    const strikes = (clHit.strikes ?? clHit.markets ?? []) as any[];
    const s120 = strikes.find(
      (s: any) => Math.abs((s.strike ?? s.price ?? 0) - 120) < 0.01 && (s.direction === "above" || s.dir === "above"),
    );
    if (s120) pSpike120 = s120.yesPrice ?? s120.yes ?? 0;
  }

  const wtiSpot = hl["OIL (CL)"]?.markPx ?? 0;
  const brentPerp = hl["BRENT OIL"]?.markPx ?? 0;
  const brentWtiSpread = brentPerp && wtiSpot ? brentPerp - wtiSpot : 0;

  // P(settle below current) as base, spike and spread as penalties
  let oilScore = (1 - pSettleAboveCurrent) * 100;
  oilScore -= pSpike120 * 20;
  oilScore -= Math.max(0, (brentWtiSpread - 5) / 25) * 10;
  oilScore = Math.max(0, Math.min(100, oilScore));

  const oilSignal =
    oilScore >= 60 ? "DECLINING" : oilScore >= 40 ? "STABLE" : oilScore >= 20 ? "ELEVATED" : "SPIKE RISK";

  // ── Composite (Fed 40%, Oil 40%, Iran 20%) ──
  const composite = Math.round(fedScore * 0.4 + oilScore * 0.4 + iranScore * 0.2);
  const label =
    composite >= 80
      ? "VERY BULLISH"
      : composite >= 60
        ? "BULLISH"
        : composite >= 45
          ? "NEUTRAL"
          : composite >= 30
            ? "BEARISH"
            : "VERY BEARISH";

  return {
    fed: { score: Math.round(fedScore), expectedCuts, pAtLeastOneCut, medianFirstCut, signal: fedSignal },
    iran: { score: Math.round(iranScore), pDealByYE, pCeasefire, pNuclearTest, signal: iranSignal },
    oil: { score: Math.round(oilScore), pSettleAboveCurrent, pSpike120, brentWtiSpread, signal: oilSignal },
    composite,
    label,
  };
}

function displayMacroScore(ms: MacroScore) {
  const gauge = (score: number) => {
    const filled = Math.round(score / 5);
    const empty = 20 - filled;
    const color = score >= 60 ? "▓" : score >= 40 ? "▒" : "░";
    return color.repeat(filled) + "·".repeat(empty);
  };

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  MACRO SCORE`);
  console.log(`${"═".repeat(70)}`);
  console.log();
  console.log(`  ┌─ COMPOSITE:  ${ms.composite}/100  [${ms.label}]`);
  console.log(`  │  ${gauge(ms.composite)}  ${ms.composite}`);
  console.log(`  │`);
  console.log(`  │  FED POLICY      ${gauge(ms.fed.score)}  ${ms.fed.score}/100  ${ms.fed.signal}`);
  console.log(`  │    P(≥1 cut):     ${(ms.fed.pAtLeastOneCut * 100).toFixed(1)}%`);
  console.log(`  │    Expected cuts: ${ms.fed.expectedCuts.toFixed(1)}`);
  console.log(`  │    Median 1st:    ${ms.fed.medianFirstCut}`);
  console.log(`  │`);
  console.log(`  │  IRAN / PEACE    ${gauge(ms.iran.score)}  ${ms.iran.score}/100  ${ms.iran.signal}`);
  console.log(`  │    P(deal 2026):  ${(ms.iran.pDealByYE * 100).toFixed(1)}%`);
  console.log(`  │    P(nuke test):  ${(ms.iran.pNuclearTest * 100).toFixed(1)}%`);
  console.log(`  │`);
  console.log(`  │  OIL             ${gauge(ms.oil.score)}  ${ms.oil.score}/100  ${ms.oil.signal}`);
  console.log(`  │    P(CL>$84 Jun): ${(ms.oil.pSettleAboveCurrent * 100).toFixed(1)}%`);
  console.log(`  │    P(CL>$120):    ${(ms.oil.pSpike120 * 100).toFixed(1)}%`);
  console.log(`  │    Brent-WTI:     $${ms.oil.brentWtiSpread.toFixed(1)} spread`);
  console.log(`  │`);
  console.log(`  │  Weights: Fed 40% · Oil 40% · Iran 20%`);
  console.log(`  │  Iran: Deal ${(ms.iran.pDealByYE * 100).toFixed(1)}% | Ceasefire ${ms.iran.pCeasefire === null ? "n/a" : `${(ms.iran.pCeasefire * 100).toFixed(1)}%`} | Nuke test ${(ms.iran.pNuclearTest * 100).toFixed(1)}%`);
  console.log(`  │  Scale: 80+ Very Bullish │ 60-80 Bullish │ 45-60 Neutral │ 30-45 Bearish │ <30 Very Bearish`);
  console.log(`  └────────────────────────────────────────────`);
}

const BITCOIN_OUTPERFORMANCE_SLUGS = [
  "what-will-bitcoin-outperform-in-april",
  "will-bitcoin-outperform-gold-in-2026",
  "bitcoin-vs-gold-vs-sp-500-in-2026",
];

const MACRO_SLUGS = [
  "how-many-fed-rate-cuts-in-2026",
  "fed-rate-cut-by-629",
  "what-will-the-fed-rate-be-at-the-end-of-2026",
  "us-iran-nuclear-deal-by-june-30",
  "us-iran-nuclear-deal-before-2027",
  "iran-nuclear-test-before-2027",
  "us-x-iran-ceasefire-by",
];

const GPU_SLUGS: string[] = [
  "what-will-gpu-rental-prices-h100-hit-by-april-30-967",
];

async function fetchCategoryEvents(slugs: string[]): Promise<CategoryEvent[]> {
  const events: CategoryEvent[] = [];
  for (const slug of slugs) {
    try {
      const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
      const data = await fetchJson(url);
      if (!Array.isArray(data)) continue;
      for (const event of data) {
        const markets: SimpleMarket[] = (event.markets || []).map((m: any) => {
          let prices: number[] = [];
          try { prices = JSON.parse(m.outcomePrices || "[]").map(Number); } catch {}
          return {
            question: m.question || "",
            yesPrice: prices[0] ?? 0,
            volume: parseFloat(m.volume || "0"),
            closed: !!m.closed,
          };
        });
        const totalVolume = markets.reduce((s, m) => s + m.volume, 0);
        events.push({ title: event.title, slug: event.slug, markets, totalVolume });
      }
    } catch {}
  }
  return events;
}

function displayCategorySection(title: string, events: CategoryEvent[]) {
  divider(title);
  if (events.length === 0) {
    console.log("  No markets found for this category.");
    return;
  }
  for (const ev of events) {
    const liveMarkets = ev.markets.filter((m) => !m.closed && m.yesPrice > 0 && m.yesPrice < 1);
    if (liveMarkets.length === 0) continue;
    console.log(`\n  ┌─ ${ev.title}  (Vol: ${fmtUsd(ev.totalVolume)})`);
    console.log(`  │  https://polymarket.com/event/${ev.slug}`);
    for (const m of liveMarkets.sort((a, b) => b.yesPrice - a.yesPrice)) {
      const prob = m.yesPrice * 100;
      const bar = "█".repeat(Math.round(prob / 2));
      console.log(`  │  ${prob.toFixed(1).padStart(5)}%  ${bar.padEnd(30)} ${m.question.slice(0, 55)}`);
    }
    console.log(`  └────────────────────────────────────────────`);
  }
}

// ─── Snapshot (daily CSV append) ─────────────────────────────────────────────

const VALUATION_CSV = "daily-valuations.csv";
const MACRO_CSV = "daily-macro.csv";
const INSTRUMENT_SNAPSHOTS_JSONL = "instrument-snapshots.jsonl";

interface InstrumentSnapshotContract {
  marketId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  strike: number;
  direction: "above" | "below";
  yesPrice: number;
  volume: number;
  bestBid: number;
  bestAsk: number;
  bestBidSize?: number;
  bestAskSize?: number;
  spread: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  startDate: string | null;
  endDate: string | null;
}

interface InstrumentSnapshotEvent {
  asset: string;
  slug: string;
  title: string;
  totalVolume: number;
  contracts: InstrumentSnapshotContract[];
}

interface InstrumentSnapshotFile {
  timestamp: string;
  spots: Record<string, number | null>;
  hyperliquid: Record<string, {
    markPx: number | null;
    fundingAnnualized: number | null;
    openInterestUsd: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
    spread?: number | null;
  }>;
  polymarket: InstrumentSnapshotEvent[];
  options: Record<string, OptionsSnapshot>;
}

const VALUATION_HEADERS = [
  "date",
  "btc_spot", "btc_opt_fwd_90d", "btc_pm_ev", "btc_opt_iv_30d", "btc_opt_iv_90d",
  "btc_opt_iv_term_spread",
  "btc_pm_iv", "btc_hl_funding_ann", "btc_hl_oi", "btc_med_max", "btc_med_min", "btc_ibit_pc_ratio",
  "hype_spot", "hype_pm_ev", "hype_pm_iv", "hype_hl_funding_ann", "hype_hl_oi",
  "hype_med_max", "hype_med_min",
  "gold_gc_spot", "gold_gld_spot", "gold_opt_fwd_90d", "gold_pm_settle_ev",
  "gold_opt_iv_30d", "gold_opt_iv_90d", "gold_pm_iv", "gold_hl_funding_ann",
  "gold_med_max", "gold_med_min", "gold_gld_pc_ratio",
  "amzn_stock", "amzn_hl_perp", "amzn_opt_fwd_90d", "amzn_opt_iv_30d", "amzn_opt_iv_90d",
  "amzn_hl_funding_ann", "amzn_hl_basis_pct", "amzn_pc_ratio",
  "oil_wti_spot", "oil_brent_spot", "oil_brent_wti_spread", "oil_opt_fwd_90d",
  "oil_pm_settle_ev", "oil_opt_iv_30d", "oil_opt_iv_90d", "oil_pm_iv",
  "oil_hl_funding_ann", "oil_cl_pc_ratio",
  // Vestigial trailing columns kept for on-disk schema alignment; no current
  // writer populates them, no current reader consumes them.
  "oil_cme_yf_spot", "gold_cme_yf_spot", "btc_cme_yf_spot",
  // SPX index level (SPY ETF x10), silver, ETH and SOL spot — used for
  // monotonic-arb settlement (each MONOTONIC_ARB_ASSET needs a spot column).
  "spy_spot", "silver_spot", "eth_spot", "sol_spot",
];

const MACRO_HEADERS = [
  "date",
  "macro_composite", "macro_label",
  "fed_score", "fed_signal", "fed_p_at_least_one_cut", "fed_expected_cuts", "fed_median_first_cut",
  "iran_score", "iran_signal", "iran_p_deal_ye", "iran_p_ceasefire", "iran_p_nuke_test",
  "oil_macro_score", "oil_signal", "oil_p_settle_above_current", "oil_p_spike_120", "oil_brent_wti_spread",
  "btc_outperform_sp500", "btc_outperform_gold", "btc_outperform_nvda", "btc_outperform_silver",
  "gpu_h100_hit_275", "gpu_h100_hit_300",
];

function csvVal(v: number | string | null | undefined): string {
  if (v === null || v === undefined || (typeof v === "number" && isNaN(v))) return "";
  if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
  return String(v);
}

function appendCsvRow(filename: string, headers: string[], row: Record<string, any>) {
  const filepath = join(DATA_DIR, filename);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(filepath)) {
    writeFileSync(filepath, headers.join(",") + "\n");
  }

  // Skip if this timestamp's row already exists
  const existing = readFileSync(filepath, "utf-8");
  const ts = row.date ?? new Date().toISOString().slice(0, 13);
  const lines = existing.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine.startsWith(`"${ts}"`) || lastLine.startsWith(ts)) {
    lines[lines.length - 1] = headers.map((h) => csvVal(row[h] ?? null)).join(",");
    writeFileSync(filepath, lines.join("\n") + "\n");
    return;
  }

  const values = headers.map((h) => csvVal(row[h] ?? null));
  appendFileSync(filepath, values.join(",") + "\n");
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
  if (slug.includes("amazon")) return "AMZN";
  return null;
}

function appendInstrumentSnapshot(snapshot: InstrumentSnapshotFile) {
  const filepath = join(DATA_DIR, INSTRUMENT_SNAPSHOTS_JSONL);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify(snapshot);
  if (!existsSync(filepath)) {
    writeFileSync(filepath, line + "\n");
    return;
  }

  appendFileSync(filepath, line + "\n");
}

function pcRatioFromChains(chains: OptionQuote[]): number | null {
  const putVol = chains.filter((c) => c.type === "put").reduce((s, c) => s + c.volume, 0);
  const callVol = chains.filter((c) => c.type === "call").reduce((s, c) => s + c.volume, 0);
  if (putVol + callVol > 0) return callVol > 0 ? putVol / callVol : null;

  const putOi = chains.filter((c) => c.type === "put").reduce((s, c) => s + c.openInterest, 0);
  const callOi = chains.filter((c) => c.type === "call").reduce((s, c) => s + c.openInterest, 0);
  if (putOi + callOi > 0) return callOi > 0 ? putOi / callOi : null;

  return null;
}

function writeSnapshot(
  hl: Record<string, any>,
  pm: PolymarketEvent[],
  opts: Record<string, OptionsSnapshot>,
  macro: CategoryEvent[],
  btcOutperform: CategoryEvent[],
  gpu: CategoryEvent[],
) {
  const today = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH for 4-hourly dedup

  // ── Valuations row ──
  const btcSpot = hl.BTC?.markPx ?? null;
  const btcOptions = opts.CME_BTC ?? opts.IBIT ?? null;
  const btcIv30 = btcOptions ? getIVForTenor(btcOptions.chains, btcOptions.underlyingPrice, 30) : null;
  const btcIv90 = btcOptions ? getIVForTenor(btcOptions.chains, btcOptions.underlyingPrice, 90) : null;
  let btcFwd: number | null = null;
  if (btcOptions && btcIv90) {
    const f = computeForwardFromOptions(btcOptions.chains, btcOptions.underlyingPrice, btcIv90.expiry);
    if (f && btcSpot) btcFwd = btcOptions.symbol === "IBIT" ? f * (btcSpot / btcOptions.underlyingPrice) : f;
  }
  const btcEvent = pm.find((e) => e.slug.includes("bitcoin"));
  const btcPm = btcEvent && btcSpot ? pmImpliedEVFromTouches(btcEvent.strikes, btcSpot) : null;

  const hypeSpot = hl.HYPE?.markPx ?? null;
  const hypeEvent = pm.find((e) => e.slug.includes("hyperliquid"));
  const hypePm = hypeEvent && hypeSpot ? pmImpliedEVFromTouches(hypeEvent.strikes, hypeSpot) : null;

  const goldGcSpot = hl["GOLD (GC)"]?.markPx ?? null;
  const goldOptions = opts.CME_GC ?? null;
  const goldPcOptions = opts.GLD ?? null;
  const goldIv30 = goldOptions ? getIVForTenor(goldOptions.chains, goldOptions.underlyingPrice, 30) : null;
  const goldIv90 = goldOptions ? getIVForTenor(goldOptions.chains, goldOptions.underlyingPrice, 90) : null;
  let goldFwd: number | null = null;
  if (goldOptions && goldIv90) goldFwd = computeForwardFromOptions(goldOptions.chains, goldOptions.underlyingPrice, goldIv90.expiry);
  const goldSettleJun = pm.find((e) => e.slug === "gc-settle-jun-2026");
  const goldHitJun = pm.find((e) => e.slug === "gc-hit-jun-2026");
  const goldHitEv = goldHitJun ?? pm.find((e) => e.slug.includes("gold-gc"));
  const goldSettleEV = goldSettleJun ? pmImpliedEVFromSettlement(goldSettleJun.strikes) : null;
  const goldPm = goldHitEv && goldGcSpot ? pmImpliedEVFromTouches(goldHitEv.strikes, goldGcSpot) : null;

  const amznStock = opts.AMZN?.underlyingPrice ?? null;
  const amznHlPerp = hl["AMZN"]?.markPx ?? null;
  const amznIv30 = opts.AMZN ? getIVForTenor(opts.AMZN.chains, opts.AMZN.underlyingPrice, 30) : null;
  const amznIv90 = opts.AMZN ? getIVForTenor(opts.AMZN.chains, opts.AMZN.underlyingPrice, 90) : null;
  let amznFwd: number | null = null;
  if (opts.AMZN && amznIv90) amznFwd = computeForwardFromOptions(opts.AMZN.chains, amznStock!, amznIv90.expiry);
  const amznBasis = amznHlPerp && amznStock ? ((amznHlPerp / amznStock) - 1) * 100 : null;
  const ethSpot = hl.ETH?.markPx ?? null;
  const spySpot = opts.SPY?.underlyingPrice ? opts.SPY.underlyingPrice * 10 : null;
  const silverSpot = hl["SILVER"]?.markPx ?? null;
  const solSpot = hl["SOL"]?.markPx ?? null;

  // OIL must use a crude reference. CBOE symbol CL is Colgate-Palmolive stock, not crude.
  const oilWti = hl["OIL (CL)"]?.markPx ?? null;
  const oilBrent = hl["BRENT OIL"]?.markPx ?? null;
  const oilSpread = oilBrent && oilWti ? oilBrent - oilWti : null;
  const oilOptions = opts.CME_CL ?? null;
  const oilPcOptions = opts.USO ?? null;
  const oilIv30 = oilOptions ? getIVForTenor(oilOptions.chains, oilOptions.underlyingPrice, 30) : null;
  const oilIv90 = oilOptions ? getIVForTenor(oilOptions.chains, oilOptions.underlyingPrice, 90) : null;
  let oilFwd: number | null = null;
  if (oilOptions && oilIv90) oilFwd = computeForwardFromOptions(oilOptions.chains, oilOptions.underlyingPrice, oilIv90.expiry);
  const clSettle = pm.find((e) => e.slug === "cl-settle-jun-2026");
  const clHit = pm.find((e) => e.slug === "cl-hit-jun-2026");
  const oilSettleEV = clSettle ? pmImpliedEVFromSettlement(clSettle.strikes) : null;
  const oilPm = clHit && oilWti ? pmImpliedEVFromTouches(clHit.strikes, oilWti) : null;

  const r = (v: number | null | undefined, d = 2) => v != null ? Number(v.toFixed(d)) : null;

  appendCsvRow(VALUATION_CSV, VALUATION_HEADERS, {
    date: today,
    btc_spot: r(btcSpot, 0), btc_opt_fwd_90d: r(btcFwd, 0), btc_pm_ev: r(btcPm?.ev, 0),
    btc_opt_iv_30d: r(btcIv30?.iv ? btcIv30.iv * 100 : null, 1),
    btc_opt_iv_90d: r(btcIv90?.iv ? btcIv90.iv * 100 : null, 1),
    btc_opt_iv_term_spread: r(
      btcIv30?.iv && btcIv90?.iv ? (btcIv30.iv * 100) - (btcIv90.iv * 100) : null,
      2,
    ),
    btc_pm_iv: r(btcPm?.impliedVol ? btcPm.impliedVol * 100 : null, 1),
    btc_hl_funding_ann: r(hl.BTC?.fundingAnnualized ? hl.BTC.fundingAnnualized * 100 : null, 2),
    btc_hl_oi: r(hl.BTC?.openInterestUsd, 0),
    btc_med_max: r(btcPm?.medianMax, 0), btc_med_min: r(btcPm?.medianMin, 0),
    btc_ibit_pc_ratio: r(opts.IBIT ? pcRatioFromChains(opts.IBIT.chains) : null, 3),
    hype_spot: r(hypeSpot, 4), hype_pm_ev: r(hypePm?.ev, 2),
    hype_pm_iv: r(hypePm?.impliedVol ? hypePm.impliedVol * 100 : null, 1),
    hype_hl_funding_ann: r(hl.HYPE?.fundingAnnualized ? hl.HYPE.fundingAnnualized * 100 : null, 2),
    hype_hl_oi: r(hl.HYPE?.openInterestUsd, 0),
    hype_med_max: r(hypePm?.medianMax, 1), hype_med_min: r(hypePm?.medianMin, 1),
    gold_gc_spot: r(goldGcSpot, 0), gold_gld_spot: null,
    gold_opt_fwd_90d: r(goldFwd, 0), gold_pm_settle_ev: r(goldSettleEV, 0),
    gold_opt_iv_30d: r(goldIv30?.iv ? goldIv30.iv * 100 : null, 1),
    gold_opt_iv_90d: r(goldIv90?.iv ? goldIv90.iv * 100 : null, 1),
    gold_pm_iv: r(goldPm?.impliedVol ? goldPm.impliedVol * 100 : null, 1),
    gold_hl_funding_ann: r(hl["GOLD (GC)"]?.fundingAnnualized ? hl["GOLD (GC)"].fundingAnnualized * 100 : null, 2),
    gold_med_max: r(goldPm?.medianMax, 0), gold_med_min: r(goldPm?.medianMin, 0),
    gold_gld_pc_ratio: r(goldPcOptions ? pcRatioFromChains(goldPcOptions.chains) : null, 3),
    amzn_stock: r(amznStock, 2), amzn_hl_perp: r(amznHlPerp, 2),
    amzn_opt_fwd_90d: r(amznFwd, 2),
    amzn_opt_iv_30d: r(amznIv30?.iv ? amznIv30.iv * 100 : null, 1),
    amzn_opt_iv_90d: r(amznIv90?.iv ? amznIv90.iv * 100 : null, 1),
    amzn_hl_funding_ann: r(hl["AMZN"]?.fundingAnnualized ? hl["AMZN"].fundingAnnualized * 100 : null, 2),
    amzn_hl_basis_pct: r(amznBasis, 2),
    amzn_pc_ratio: r(opts.AMZN ? pcRatioFromChains(opts.AMZN.chains) : null, 3),
    oil_wti_spot: r(oilWti, 2), oil_brent_spot: r(oilBrent, 2),
    oil_brent_wti_spread: r(oilSpread, 1),
    oil_opt_fwd_90d: r(oilFwd, 1), oil_pm_settle_ev: r(oilSettleEV, 1),
    oil_opt_iv_30d: r(oilIv30?.iv ? oilIv30.iv * 100 : null, 1),
    oil_opt_iv_90d: r(oilIv90?.iv ? oilIv90.iv * 100 : null, 1),
    oil_pm_iv: r(oilPm?.impliedVol ? oilPm.impliedVol * 100 : null, 1),
    oil_hl_funding_ann: r(hl["OIL (CL)"]?.fundingAnnualized ? hl["OIL (CL)"].fundingAnnualized * 100 : null, 2),
    oil_cl_pc_ratio: r(oilPcOptions ? pcRatioFromChains(oilPcOptions.chains) : null, 3),
    spy_spot: r(spySpot, 2), silver_spot: r(silverSpot, 4),
    eth_spot: r(ethSpot, 2), sol_spot: r(solSpot, 4),
  });

  // ── Macro row ──
  const ms = computeMacroScore(macro, pm, hl, opts);

  const findOutperformP = (events: CategoryEvent[], keyword: string): number | null => {
    for (const ev of events) {
      const m = ev.markets.find((m) => m.question.toLowerCase().includes(keyword) && !m.closed);
      if (m) return r(m.yesPrice * 100, 1);
    }
    return null;
  };

  const findGpuP = (events: CategoryEvent[], strike: string): number | null => {
    for (const ev of events) {
      const m = ev.markets.find((m) => m.question.includes(strike) && !m.closed);
      if (m) return r(m.yesPrice * 100, 1);
    }
    return null;
  };

  appendCsvRow(MACRO_CSV, MACRO_HEADERS, {
    date: today,
    macro_composite: ms.composite, macro_label: ms.label,
    fed_score: ms.fed.score, fed_signal: ms.fed.signal,
    fed_p_at_least_one_cut: r(ms.fed.pAtLeastOneCut * 100, 1),
    fed_expected_cuts: r(ms.fed.expectedCuts, 1),
    fed_median_first_cut: ms.fed.medianFirstCut,
    iran_score: ms.iran.score, iran_signal: ms.iran.signal,
    iran_p_deal_ye: r(ms.iran.pDealByYE * 100, 1),
    iran_p_ceasefire: ms.iran.pCeasefire === null ? null : r(ms.iran.pCeasefire * 100, 1),
    iran_p_nuke_test: r(ms.iran.pNuclearTest * 100, 1),
    oil_macro_score: ms.oil.score, oil_signal: ms.oil.signal,
    oil_p_settle_above_current: r(ms.oil.pSettleAboveCurrent * 100, 1),
    oil_p_spike_120: r(ms.oil.pSpike120 * 100, 1),
    oil_brent_wti_spread: r(ms.oil.brentWtiSpread, 1),
    btc_outperform_sp500: findOutperformP(btcOutperform, "s&p 500"),
    btc_outperform_gold: findOutperformP(btcOutperform, "gold"),
    btc_outperform_nvda: findOutperformP(btcOutperform, "nvidia"),
    btc_outperform_silver: findOutperformP(btcOutperform, "silver"),
    gpu_h100_hit_275: findGpuP(gpu, "$2.75"),
    gpu_h100_hit_300: findGpuP(gpu, "$3.00"),
  });

  const hyperliquidSnapshot: Record<string, {
    markPx: number | null;
    fundingAnnualized: number | null;
    openInterestUsd: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
  }> = {};
  for (const [asset, quote] of Object.entries(hl)) {
    if (asset === "GOLD (GC)" || asset === "OIL (CL)" || asset === "BRENT OIL") continue;
    hyperliquidSnapshot[asset] = {
      markPx: r(quote?.markPx ?? null, 6),
      fundingAnnualized: r(quote?.fundingAnnualized ?? null, 6),
      openInterestUsd: r(quote?.openInterestUsd ?? null, 2),
      bestBid: r(quote?.bestBid ?? null, 6),
      bestAsk: r(quote?.bestAsk ?? null, 6),
      spread: r(quote?.spread ?? null, 6),
    };
  }
  hyperliquidSnapshot.GOLD = {
    markPx: r(hl["GOLD (GC)"]?.markPx ?? null, 6),
    fundingAnnualized: r(hl["GOLD (GC)"]?.fundingAnnualized ?? null, 6),
    openInterestUsd: r(hl["GOLD (GC)"]?.openInterestUsd ?? null, 2),
    bestBid: r(hl["GOLD (GC)"]?.bestBid ?? null, 6),
    bestAsk: r(hl["GOLD (GC)"]?.bestAsk ?? null, 6),
    spread: r(hl["GOLD (GC)"]?.spread ?? null, 6),
  };
  hyperliquidSnapshot.OIL = {
    markPx: r(hl["OIL (CL)"]?.markPx ?? null, 6),
    fundingAnnualized: r(hl["OIL (CL)"]?.fundingAnnualized ?? null, 6),
    openInterestUsd: r(hl["OIL (CL)"]?.openInterestUsd ?? null, 2),
    bestBid: r(hl["OIL (CL)"]?.bestBid ?? null, 6),
    bestAsk: r(hl["OIL (CL)"]?.bestAsk ?? null, 6),
    spread: r(hl["OIL (CL)"]?.spread ?? null, 6),
  };

  appendInstrumentSnapshot({
    timestamp: today,
    spots: {
      BTC: r(btcSpot, 6),
      ETH: r(ethSpot, 6),
      HYPE: r(hypeSpot, 6),
      GOLD: r(goldGcSpot, 6),
      AMZN: r(amznStock, 6),
      SPY: r(spySpot, 6),
      SILVER: r(silverSpot, 6),
      SOL: r(solSpot, 6),
      OIL: r(oilWti, 6),
    },
    hyperliquid: hyperliquidSnapshot,
    polymarket: pm
      .map((event): InstrumentSnapshotEvent | null => {
        const asset = polymarketAssetForSlug(event.slug);
        if (!asset) return null;
        return {
          asset,
          slug: event.slug,
          title: event.title,
          totalVolume: event.totalVolume,
          contracts: event.strikes.map((s) => ({
            marketId: s.marketId,
            question: s.question,
            description: s.description,
            resolutionSource: s.resolutionSource,
            strike: s.strike,
            direction: s.direction,
            yesPrice: s.yesPrice,
            volume: s.volume,
            bestBid: s.bestBid,
            bestAsk: s.bestAsk,
            bestBidSize: s.bestBidSize,
            bestAskSize: s.bestAskSize,
            spread: s.spread,
            liquidity: s.liquidity,
            active: s.active,
            closed: s.closed,
            startDate: s.startDate,
            endDate: s.endDate,
          })),
        } satisfies InstrumentSnapshotEvent;
      })
      .filter((event): event is InstrumentSnapshotEvent => event !== null),
    options: Object.fromEntries(
      Object.entries(opts).map(([symbol, snapshot]) => [
        symbol,
        {
          symbol: snapshot.symbol,
          underlyingPrice: r(snapshot.underlyingPrice, 6) ?? 0,
          source: snapshot.source,
          chains: snapshot.chains.map((chain) => ({
            contractSymbol: chain.contractSymbol,
            root: chain.root,
            strike: r(chain.strike, 6) ?? 0,
            bid: r(chain.bid, 6) ?? 0,
            ask: r(chain.ask, 6) ?? 0,
            mid: r(chain.mid, 6) ?? 0,
            volume: Math.round(chain.volume),
            openInterest: Math.round(chain.openInterest),
            impliedVolatility: r(chain.impliedVolatility, 8) ?? 0,
            expiration: chain.expiration,
            type: chain.type,
          })),
        } satisfies OptionsSnapshot,
      ]),
    ),
  });

  const valPath = join(DATA_DIR, VALUATION_CSV);
  const macPath = join(DATA_DIR, MACRO_CSV);
  console.log(`\n  Snapshot saved for ${today}`);
  console.log(`    ${valPath}`);
  console.log(`    ${macPath}\n`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
    console.log(`\n  Market Scanner — ${new Date().toISOString()}`);
    console.log(`  Assets: Bitcoin, HYPE, Gold, Amazon, Oil (Brent + WTI)`);
    console.log(`  Sources: Hyperliquid (native + xyz DEX), Polymarket, CBOE Options`);
  }

  const [hl, pm, opts, btcOutperform, macro, gpu] = await Promise.all([
    fetchHyperliquid().catch((e) => {
      warn(`Hyperliquid failed: ${e.message}`);
      return {} as Record<string, any>;
    }),
    fetchPolymarket().catch((e) => {
      warn(`Polymarket failed: ${e.message}`);
      return [] as any[];
    }),
    fetchOptions().catch((e) => {
      warn(`Options failed: ${e.message}`);
      return {} as Record<string, OptionsSnapshot>;
    }),
    fetchCategoryEvents(BITCOIN_OUTPERFORMANCE_SLUGS).catch(() => [] as CategoryEvent[]),
    fetchCategoryEvents(MACRO_SLUGS).catch(() => [] as CategoryEvent[]),
    fetchCategoryEvents(GPU_SLUGS).catch(() => [] as CategoryEvent[]),
  ]);

  if (SNAPSHOT_MODE) {
    writeSnapshot(hl, pm, opts, macro, btcOutperform, gpu);
    return;
  }

  crossAnalysis(hl, pm, opts);
  impliedValuations(hl, pm, opts);

  if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
    displayCategorySection("BITCOIN OUTPERFORMANCE", btcOutperform);

    // Macro: Fed + Iran + Oil (oil already in cross-source, show Fed + Iran here)
    const fedEvents = macro.filter((e) => e.slug.includes("fed"));
    const iranEvents = macro.filter((e) => e.slug.includes("iran"));
    divider("MACRO — Fed / Iran / Oil");
    if (fedEvents.length > 0) {
      for (const ev of fedEvents) {
        const live = ev.markets.filter((m) => !m.closed && m.yesPrice > 0 && m.yesPrice < 1);
        if (live.length === 0) continue;
        console.log(`\n  ┌─ ${ev.title}  (Vol: ${fmtUsd(ev.totalVolume)})`);
        console.log(`  │  https://polymarket.com/event/${ev.slug}`);
        for (const m of live.sort((a, b) => b.yesPrice - a.yesPrice).slice(0, 8)) {
          const prob = m.yesPrice * 100;
          const bar = "█".repeat(Math.round(prob / 2));
          console.log(`  │  ${prob.toFixed(1).padStart(5)}%  ${bar.padEnd(25)} ${m.question.slice(0, 58)}`);
        }
        console.log(`  └────────────────────────────────────────────`);
      }
    }
    if (iranEvents.length > 0) {
      for (const ev of iranEvents) {
        const live = ev.markets.filter((m) => !m.closed && m.yesPrice > 0 && m.yesPrice < 1);
        if (live.length === 0) continue;
        console.log(`\n  ┌─ ${ev.title}  (Vol: ${fmtUsd(ev.totalVolume)})`);
        for (const m of live) {
          const prob = m.yesPrice * 100;
          const bar = "█".repeat(Math.round(prob / 2));
          console.log(`  │  ${prob.toFixed(1).padStart(5)}%  ${bar.padEnd(25)} ${m.question.slice(0, 58)}`);
        }
        console.log(`  └────────────────────────────────────────────`);
      }
    }
    console.log(`\n  ┌─ Oil macro → see OIL Cross-Source section above`);
    console.log(`  └────────────────────────────────────────────`);

    const macroScore = computeMacroScore(macro, pm, hl, opts);
    displayMacroScore(macroScore);

    if (gpu.length > 0) {
      displayCategorySection("GPU RENTAL COST", gpu);
    } else {
      divider("GPU RENTAL COST");
      console.log("  No GPU rental cost markets found on Polymarket.");
      console.log("  (Will auto-populate when markets are created)");
    }
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ hyperliquid: hl, polymarket: pm, options: opts }, null, 2));
  }

  if (!JSON_OUTPUT && !SNAPSHOT_MODE) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`  Scan complete. Run with --json for machine-readable output.`);
    console.log(`${"─".repeat(70)}\n`);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
