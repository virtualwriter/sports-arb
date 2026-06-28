// One-shot price comparison: Polymarket vs Kalshi for the active FIFA U-20
// World Cup quarterfinal games. For each strike that's listed on both venues,
// pull the best YES bid/ask from each side and compute the two-leg package
// cost for a few common monotonic-middle pairs (e.g. 2.5/3.5, 2.5/4.5, 3.5/5.5).

import { KalshiClient, bookQuotes } from "./lib/kalshi-client.js";

const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB = "https://clob.polymarket.com";

// 7 active QF games. Polymarket uses `fifwc-<a>-<b>-YYYY-MM-DD-more-markets`;
// Kalshi uses `KXWCGAME-YYMMMDDAAABBB`.
const GAMES: Array<{ label: string; polySlug: string; kalshiStamp: string }> = [
  { label: "RSA vs CAN (Sun)", polySlug: "fifwc-rsa-can-2026-06-28-more-markets", kalshiStamp: "26JUN28RSACAN" },
  { label: "BRA vs JPN (Mon)", polySlug: "fifwc-bra-jpn-2026-06-29-more-markets", kalshiStamp: "26JUN29BRAJPN" },
  { label: "GER vs PAR (Mon)", polySlug: "fifwc-ger-par-2026-06-29-more-markets", kalshiStamp: "26JUN29GERPAR" },
  { label: "NLD vs MAR (Mon)", polySlug: "fifwc-nld-mar-2026-06-29-more-markets", kalshiStamp: "26JUN29NEDMAR" },
  { label: "CIV vs NOR (Tue)", polySlug: "fifwc-civ-nor-2026-06-30-more-markets", kalshiStamp: "26JUN30CIVNOR" },
  { label: "FRA vs SWE (Tue)", polySlug: "fifwc-fra-swe-2026-06-30-more-markets", kalshiStamp: "26JUN30FRASWE" },
  { label: "MEX vs ECU (Tue)", polySlug: "fifwc-mex-ecu-2026-06-30-more-markets", kalshiStamp: "26JUN30MEXECU" },
];

type Quote = { yesBid: number; yesAsk: number; noBid: number; noAsk: number; yesAskSize: number; noAskSize: number };

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { headers: { "user-agent": "sports-arb/0.1" } });
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  return (await resp.json()) as T;
}

function pickBest(levels: any[], side: "bid" | "ask"): { price: number; size: number } {
  const parsed = (levels ?? [])
    .map((l: any) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && l.size > 0);
  if (parsed.length === 0) return { price: 0, size: 0 };
  return parsed.reduce((best, l) => (side === "bid" ? (l.price > best.price ? l : best) : (l.price < best.price ? l : best)));
}

async function getPolymarketTotals(slug: string, verbose: boolean): Promise<Record<number, Quote>> {
  const events = await fetchJson<any[]>(`${POLYMARKET_GAMMA}/events?slug=${encodeURIComponent(slug)}`);
  const event = events?.[0];
  if (!event) { if (verbose) console.log(`  [poly] event not found for slug=${slug}`); return {}; }
  const out: Record<number, Quote> = {};
  for (const m of event.markets ?? []) {
    const q = m.question ?? "";
    const match = q.match(/O\/U\s+(\d+(?:\.5)?)/i);
    if (!match) continue;
    const strike = Number(match[1]);
    if (!Number.isFinite(strike)) continue;
    let tokens: any[] = [];
    try { tokens = JSON.parse(m.clobTokenIds ?? m.clob_token_ids ?? "[]"); } catch { tokens = []; }
    const yesTokenId = tokens[0];
    const noTokenId = tokens[1];
    if (!yesTokenId || !noTokenId) continue;
    try {
      const [yesBook, noBook] = await Promise.all([
        fetchJson<any>(`${POLYMARKET_CLOB}/book?token_id=${yesTokenId}`),
        fetchJson<any>(`${POLYMARKET_CLOB}/book?token_id=${noTokenId}`),
      ]);
      const yesBid = pickBest(yesBook.bids, "bid");
      const yesAsk = pickBest(yesBook.asks, "ask");
      const noBid = pickBest(noBook.bids, "bid");
      const noAsk = pickBest(noBook.asks, "ask");
      out[strike] = {
        yesBid: yesBid.price,
        yesAsk: yesAsk.price,
        noBid: noBid.price,
        noAsk: noAsk.price,
        yesAskSize: yesAsk.size,
        noAskSize: noAsk.size,
      };
    } catch (e: any) {
      if (verbose) console.log(`  [poly] book fetch failed for strike=${strike}: ${e?.message?.slice(0,100)}`);
    }
  }
  return out;
}

async function getKalshiTotals(stamp: string, c: KalshiClient): Promise<Record<number, Quote>> {
  const ev = await c.getEvent(`KXWCTOTAL-${stamp}`, true);
  if (!ev) return {};
  const out: Record<number, Quote> = {};
  for (const m of ev.markets ?? []) {
    const strike = typeof m.floor_strike === "number" ? m.floor_strike : null;
    if (strike === null) continue;
    try {
      const book = await c.getOrderbook(m.ticker, 10);
      const q = bookQuotes(book);
      out[strike] = {
        yesBid: q.yesBid,
        yesAsk: q.yesAsk,
        noBid: q.noBid,
        noAsk: q.noAsk,
        yesAskSize: q.yesAskSize,
        noAskSize: q.noAskSize,
      };
    } catch (e) { /* skip */ }
  }
  return out;
}

function fmt(n: number): string {
  return n > 0 ? `$${n.toFixed(3)}` : "  -  ";
}

async function compareGame(game: { label: string; polySlug: string; kalshiStamp: string }, kc: KalshiClient): Promise<void> {
  const [poly, kal] = await Promise.all([
    getPolymarketTotals(game.polySlug, true),
    getKalshiTotals(game.kalshiStamp, kc),
  ]);

  console.log(`\n========== ${game.label} ==========`);
  const allStrikes = [...new Set([...Object.keys(poly), ...Object.keys(kal)])].map(Number).sort((a, b) => a - b);
  if (!allStrikes.length) { console.log("  no overlapping strikes found"); return; }

  console.log("Strike  |  Polymarket YES bid/ask     |  Kalshi YES bid/ask         |  Δ ask");
  console.log("------- | --------------------------- | --------------------------- | -------");
  for (const s of allStrikes) {
    const p = poly[s];
    const k = kal[s];
    const pBid = p ? fmt(p.yesBid) : "  -  ";
    const pAsk = p ? fmt(p.yesAsk) : "  -  ";
    const kBid = k ? fmt(k.yesBid) : "  -  ";
    const kAsk = k ? fmt(k.yesAsk) : "  -  ";
    const delta = (p && k && p.yesAsk > 0 && k.yesAsk > 0) ? ((k.yesAsk - p.yesAsk) * 100).toFixed(1) + "c" : "  -  ";
    console.log(`  ${s.toFixed(1)}   |  ${pBid} / ${pAsk}           |  ${kBid} / ${kAsk}           |  ${delta}`);
  }

  // Two-leg middle costs: same shapes the daemon trades on Polymarket
  console.log("\nTwo-leg middle costs (broad/narrow):");
  console.log("  pair      |  Polymarket cost  |  Kalshi cost  |  winner");
  console.log("  --------- | ----------------- | ------------- | --------");
  const pairs: Array<[number, number]> = [[2.5, 4.5], [2.5, 5.5], [3.5, 5.5], [3.5, 6.5], [2.5, 6.5]];
  for (const [a, b] of pairs) {
    const pCost = (poly[a]?.yesAsk ?? 0) + (poly[b]?.noAsk ?? 0);
    const kCost = (kal[a]?.yesAsk ?? 0) + (kal[b]?.noAsk ?? 0);
    const pOk = poly[a]?.yesAsk > 0 && poly[b]?.noAsk > 0;
    const kOk = kal[a]?.yesAsk > 0 && kal[b]?.noAsk > 0;
    const winner = pOk && kOk ? (kCost < pCost ? "KALSHI" : pCost < kCost ? "POLY  " : "tie") : !kOk ? "POLY (no kalshi)" : "KALSHI (no poly)";
    console.log(`  ${a}/${b}   |  ${pOk ? fmt(pCost) : "       N/A       "}        |  ${kOk ? fmt(kCost) : "    N/A   "}     |  ${winner}`);
  }
}

async function main() {
  const kc = new KalshiClient();
  for (const game of GAMES) {
    try {
      await compareGame(game, kc);
    } catch (e: any) {
      console.log(`\n========== ${game.label} ==========`);
      console.log(`  ERROR: ${e?.message ?? e}`);
    }
  }
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
