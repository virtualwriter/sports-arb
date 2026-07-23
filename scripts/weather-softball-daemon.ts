#!/usr/bin/env tsx
/**
 * Polymarket daily-temperature YES-basket softball daemon.
 *
 * Fires immediately when a full-ladder YES basket clears the softball gates
 * (no time-on-book wait):
 *   netLockedEdge ≥ 2¢, availableSize ≥ 10, packageCost ∈ [0.85, 0.99]
 *
 * Shadow by default. Live requires WEATHER_SOFTBALL_LIVE=1 AND the shared
 * ENABLE_MONOTONIC_ARB_REAL_PM / hard-disable guards from the PM executor.
 *
 * Run:  npm run weather:softball
 * Unit: deploy/weather-softball-daemon.service
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "dotenv";
import {
  bestLevel,
  fetchJson,
  parseJsonArray,
  type BookLevel,
} from "./lib/monotonic-arb-core.js";
import {
  isSoftball,
  softballGateLabel,
  SOFTBALL_MAX_COST,
} from "./lib/softball-gates.js";
import {
  clobClient,
  ENABLED,
  HARD_DISABLED,
  MAX_DAILY_USD,
  MAX_PACKAGE_USD,
  postFakBuyBatch,
  precisionSafeBuyShares,
} from "./polymarket-real-monotonic-executor.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: "/etc/sports-arb.env" });

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const AUDIT_PATH = join(DATA_DIR, "weather-softball-audit.jsonl");
const ORDERS_PATH = join(DATA_DIR, "weather-softball-orders.jsonl");

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
const POLL_MS = Number(process.env.WEATHER_SOFTBALL_POLL_MS ?? 15_000);
const DISCOVER_MS = Number(process.env.WEATHER_SOFTBALL_DISCOVER_MS ?? 120_000);
const PAGES = Number(process.env.WEATHER_SOFTBALL_PAGES ?? 3);
const COOLDOWN_MS = Number(process.env.WEATHER_SOFTBALL_COOLDOWN_MS ?? 120_000);
const LIVE = /^(1|true|yes)$/i.test(process.env.WEATHER_SOFTBALL_LIVE ?? "");
const VERIFY_MARGIN = Number(process.env.WEATHER_SOFTBALL_VERIFY_MARGIN ?? 0.03);
const MIN_ORDER_SHARES = Number(process.env.WEATHER_SOFTBALL_MIN_ORDER_SHARES ?? 5);
let spentTodayUsd = 0;

type PmBin = {
  question: string;
  binLo: number;
  binHi: number;
  yesTokenId: string;
  bestBid: number;
  bestAsk: number;
};

type PmTempEvent = {
  slug: string;
  title: string;
  city: string;
  bins: PmBin[];
  binsTotal: number;
};

function log(msg: string): void {
  console.log(`[weather-softball ${new Date().toISOString()}] ${msg}`);
}

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function emit(path: string, row: Record<string, unknown>): void {
  ensureParent(path);
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

function parsePmTempBin(question: string): { binLo: number; binHi: number } | null {
  const between = question.match(/between\s+(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/i);
  if (between) return { binLo: Number(between[1]), binHi: Number(between[2]) };
  const below = question.match(/be\s+(-?\d+(?:\.\d+)?)\s*°?\s*[FC]?\s*or\s+(?:below|lower)/i);
  if (below) return { binLo: -Infinity, binHi: Number(below[1]) };
  const above = question.match(/be\s+(-?\d+(?:\.\d+)?)\s*°?\s*[FC]?\s*or\s+(?:higher|above)/i);
  if (above) return { binLo: Number(above[1]), binHi: Infinity };
  const exact = question.match(/be\s+(-?\d+(?:\.\d+)?)\s*°\s*[FC]\s+on/i);
  if (exact) return { binLo: Number(exact[1]), binHi: Number(exact[1]) };
  return null;
}

async function discoverPmTempEvents(): Promise<PmTempEvent[]> {
  const out: PmTempEvent[] = [];
  for (let page = 0; page < PAGES; page++) {
    const url = `${GAMMA_API}/events?tag_slug=weather&closed=false&order=startDate&ascending=false&limit=100&offset=${page * 100}`;
    const events = (await fetchJson(url, 10_000)) as Array<Record<string, unknown>>;
    if (!Array.isArray(events) || events.length === 0) break;
    for (const ev of events) {
      const slug = String(ev.slug ?? "");
      const m = slug.match(/^highest-temperature-in-(.+?)-on-/);
      if (!m) continue;
      const bins: PmBin[] = [];
      let binsTotal = 0;
      for (const mk of (ev.markets as Array<Record<string, unknown>> | undefined) ?? []) {
        const question = String(mk.question ?? "");
        const parsed = parsePmTempBin(question);
        if (!parsed) continue;
        binsTotal += 1;
        if (mk.closed || mk.active === false || mk.acceptingOrders === false) continue;
        const outcomes = parseJsonArray(mk.outcomes).map((o) => String(o).toLowerCase());
        const tokens = parseJsonArray(mk.clobTokenIds).map(String);
        const yesIdx = outcomes.indexOf("yes");
        if (yesIdx < 0 || !tokens[yesIdx]) continue;
        bins.push({
          question,
          ...parsed,
          yesTokenId: tokens[yesIdx],
          bestBid: Number(mk.bestBid ?? 0),
          bestAsk: Number(mk.bestAsk ?? 0),
        });
      }
      if (bins.length < 3) continue;
      bins.sort((a, b) => a.binLo - b.binLo);
      out.push({ slug, title: String(ev.title ?? slug), city: m[1], bins, binsTotal });
    }
    if (events.length < 100) break;
  }
  return out;
}

async function bookAsk(tokenId: string): Promise<{ ask: number; askSize: number }> {
  const book = (await fetchJson(
    `${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`,
    10_000,
  )) as { asks?: BookLevel[] };
  const best = bestLevel(book.asks, "ask");
  return { ask: best.price, askSize: best.size };
}

type SoftballHit = {
  packageId: string;
  eventSlug: string;
  eventTitle: string;
  city: string;
  packageCost: number;
  netLockedEdge: number;
  availableSize: number;
  minLegAsk: number;
  legs: Array<{ tokenId: string; yesAsk: number; yesAskSize: number; binLo: number; binHi: number }>;
};

async function scanEvent(ev: PmTempEvent): Promise<SoftballHit | null> {
  if (ev.bins.length !== ev.binsTotal) return null;
  const est = ev.bins.reduce((sum, bin) => sum + (bin.bestAsk > 0 ? bin.bestAsk : 1), 0);
  if (est > SOFTBALL_MAX_COST + VERIFY_MARGIN) return null;

  const legs = await Promise.all(ev.bins.map(async (bin) => {
    const book = await bookAsk(bin.yesTokenId);
    return {
      tokenId: bin.yesTokenId,
      yesAsk: book.ask,
      yesAskSize: book.askSize,
      binLo: bin.binLo,
      binHi: bin.binHi,
    };
  }));
  if (!legs.every((l) => l.yesAsk > 0)) return null;

  const packageCost = legs.reduce((sum, l) => sum + l.yesAsk, 0);
  const availableSize = Math.min(...legs.map((l) => l.yesAskSize));
  const minLegAsk = Math.min(...legs.map((l) => l.yesAsk));
  const netLockedEdge = 1 - packageCost;
  // Dust gate: every leg ask must be ≥ 1¢ (SOFTBALL_MIN_LEG_ASK). Far-OTM
  // 0.1¢ bins are not softballs — skip rather than hacking limit prices.
  if (!isSoftball({ packageCost, netLockedEdge, availableSize, minLegAsk })) return null;

  return {
    packageId: `pm::${ev.slug}::YES-BASKET`,
    eventSlug: ev.slug,
    eventTitle: ev.title,
    city: ev.city,
    packageCost,
    netLockedEdge,
    availableSize,
    minLegAsk,
    legs,
  };
}

async function maybeFire(hit: SoftballHit): Promise<"fired" | "skipped"> {
  const usdCapShares = MAX_PACKAGE_USD > 0 && hit.packageCost > 0
    ? MAX_PACKAGE_USD / hit.packageCost
    : hit.availableSize;
  const shares = Math.min(hit.availableSize, usdCapShares);
  const notional = shares * hit.packageCost;
  const observedAt = new Date().toISOString();
  const liveMode = LIVE && ENABLED && !HARD_DISABLED;
  const base = {
    observedAt,
    venue: "polymarket",
    packageKind: "yes-basket",
    softball: true,
    ...hit,
    shares,
    notional,
    mode: liveMode ? "live" : "shadow",
  };
  emit(AUDIT_PATH, base);
  log(
    `!!! SOFTBALL FIRE ${hit.eventSlug} cost=${hit.packageCost.toFixed(3)} `
    + `net=${(hit.netLockedEdge * 100).toFixed(2)}c size=${hit.availableSize.toFixed(1)} `
    + `minLegAsk=${(hit.minLegAsk * 100).toFixed(1)}c shares=${shares.toFixed(2)} `
    + `notional=$${notional.toFixed(2)} mode=${base.mode}`,
  );

  if (!liveMode) return "fired";
  if (shares + 1e-9 < MIN_ORDER_SHARES) {
    log(`skip live: shares ${shares.toFixed(2)} < market min ${MIN_ORDER_SHARES}`);
    return "skipped";
  }
  if (spentTodayUsd + notional > MAX_DAILY_USD) {
    log(`skip live: daily cap (spent=${spentTodayUsd.toFixed(2)} + ${notional.toFixed(2)} > ${MAX_DAILY_USD})`);
    return "skipped";
  }

  const { client } = await clobClient();
  let sized: number | null = null;
  for (
    let trial = Math.floor(shares * 100) / 100;
    trial + 1e-9 >= MIN_ORDER_SHARES;
    trial = Math.round((trial - 0.01) * 100) / 100
  ) {
    const ok = hit.legs.every((leg) => {
      const safe = precisionSafeBuyShares(leg.yesAsk, MIN_ORDER_SHARES, trial);
      return !!safe && safe > 0;
    });
    if (ok) {
      sized = trial;
      break;
    }
  }
  if (sized == null) {
    log(`skip live: no precision-safe share size in [${MIN_ORDER_SHARES}, ${shares}]`);
    return "skipped";
  }

  const batch: Array<{ tokenId: string; price: number; shares: number }> = [];
  for (const leg of hit.legs) {
    const safe = precisionSafeBuyShares(leg.yesAsk, MIN_ORDER_SHARES, sized);
    if (!(safe && safe > 0)) {
      log(`skip live: precision-safe shares unavailable @ ask=${leg.yesAsk}`);
      return "skipped";
    }
    batch.push({ tokenId: leg.tokenId, price: leg.yesAsk, shares: safe });
  }
  const matchedShares = Math.min(...batch.map((l) => l.shares));
  for (const leg of batch) leg.shares = matchedShares;

  try {
    const responses = await postFakBuyBatch(client, batch);
    const liveNotional = matchedShares * hit.packageCost;
    spentTodayUsd += liveNotional;
    emit(ORDERS_PATH, {
      observedAt,
      packageId: hit.packageId,
      eventSlug: hit.eventSlug,
      packageCost: hit.packageCost,
      shares: matchedShares,
      notional: liveNotional,
      legs: batch,
      responses,
    });
    log(`live submitted ${batch.length} FAK YES legs x${matchedShares} for ${hit.packageId}`);
    return "fired";
  } catch (err) {
    log(`live submit failed: ${(err as Error).message}`);
    emit(ORDERS_PATH, {
      observedAt,
      packageId: hit.packageId,
      eventSlug: hit.eventSlug,
      error: (err as Error).message,
      legs: batch,
    });
    return "skipped";
  }
}

async function main(): Promise<void> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  log(`start gates=${softballGateLabel()} pollMs=${POLL_MS} live=${LIVE && ENABLED && !HARD_DISABLED ? 1 : 0} (LIVE=${LIVE ? 1 : 0} ENABLED=${ENABLED ? 1 : 0} HARD_DISABLED=${HARD_DISABLED ? 1 : 0})`);

  let events: PmTempEvent[] = [];
  let lastDiscover = 0;
  const lastFire = new Map<string, number>();
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    try {
      if (Date.now() - lastDiscover >= DISCOVER_MS || events.length === 0) {
        lastDiscover = Date.now();
        events = await discoverPmTempEvents();
        log(`discover ${events.length} temperature events`);
      }
      let fires = 0;
      for (const ev of events) {
        if (stopping) break;
        try {
          const hit = await scanEvent(ev);
          if (!hit) continue;
          const prev = lastFire.get(hit.packageId) ?? 0;
          if (Date.now() - prev < COOLDOWN_MS) continue;
          const result = await maybeFire(hit);
          if (result === "fired") {
            lastFire.set(hit.packageId, Date.now());
            fires += 1;
          } else {
            // Brief backoff on skip/error so we retry next cycles.
            lastFire.set(hit.packageId, Date.now() - COOLDOWN_MS + 15_000);
          }
        } catch (err) {
          log(`scan ${ev.slug} failed: ${(err as Error).message}`);
        }
      }
      if (fires === 0) log(`cycle events=${events.length} softballs=0`);
    } catch (err) {
      log(`cycle failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(`[weather-softball] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
