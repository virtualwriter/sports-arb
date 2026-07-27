#!/usr/bin/env tsx
/**
 * Polymarket daily-temperature softball daemon.
 *
 * Fires immediately when a package clears the softball gates (no time-on-book wait):
 *   - YES basket across the full ladder, or
 *   - bin NO/NO pair (at most one bin wins → cost < 1 is locked)
 *
 * Gates: netLockedEdge ≥ 2¢, availableSize ≥ 10, packageCost ∈ [0.85, 0.99],
 * minLegAsk ≥ 1¢.
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
  enqueuePmSoftball,
  pmSoftballExecLabel,
  type PmSoftballRow,
} from "./lib/pm-softball-exec.js";
import { ENABLED, HARD_DISABLED } from "./polymarket-real-monotonic-executor.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: "/etc/sports-arb.env" });

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const AUDIT_PATH = join(DATA_DIR, "weather-softball-audit.jsonl");

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
const POLL_MS = Number(process.env.WEATHER_SOFTBALL_POLL_MS ?? 15_000);
const DISCOVER_MS = Number(process.env.WEATHER_SOFTBALL_DISCOVER_MS ?? 120_000);
const PAGES = Number(process.env.WEATHER_SOFTBALL_PAGES ?? 3);
const LIVE = /^(1|true|yes)$/i.test(process.env.WEATHER_SOFTBALL_LIVE ?? "");
const VERIFY_MARGIN = Number(process.env.WEATHER_SOFTBALL_VERIFY_MARGIN ?? 0.03);

type PmBin = {
  question: string;
  binLo: number;
  binHi: number;
  yesTokenId: string;
  noTokenId: string;
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
        const noIdx = outcomes.indexOf("no");
        if (yesIdx < 0 || noIdx < 0 || !tokens[yesIdx] || !tokens[noIdx]) continue;
        bins.push({
          question,
          ...parsed,
          yesTokenId: tokens[yesIdx],
          noTokenId: tokens[noIdx],
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

async function scanYesBasket(ev: PmTempEvent): Promise<PmSoftballRow | null> {
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
  if (!isSoftball({ packageCost, netLockedEdge, availableSize, minLegAsk })) return null;

  return {
    packageId: `pm::${ev.slug}::YES-BASKET`,
    packageKind: "yes-basket",
    venue: "polymarket",
    domain: "weather",
    eventSlug: ev.slug,
    packageCost,
    netLockedEdge,
    availableSize,
    minLegAsk,
    softball: true,
    legs,
  };
}

async function scanBinNoPairs(ev: PmTempEvent): Promise<PmSoftballRow[]> {
  const hits: PmSoftballRow[] = [];
  for (let i = 0; i < ev.bins.length; i++) {
    for (let j = i + 1; j < ev.bins.length; j++) {
      const a = ev.bins[i];
      const b = ev.bins[j];
      const estCost = (1 - a.bestBid) + (1 - b.bestBid);
      if (!(estCost > 0) || estCost > SOFTBALL_MAX_COST + VERIFY_MARGIN) continue;
      const [noA, noB] = await Promise.all([bookAsk(a.noTokenId), bookAsk(b.noTokenId)]);
      if (!(noA.ask > 0) || !(noB.ask > 0)) continue;
      const packageCost = noA.ask + noB.ask;
      const availableSize = Math.min(noA.askSize, noB.askSize);
      const minLegAsk = Math.min(noA.ask, noB.ask);
      const netLockedEdge = 1 - packageCost;
      if (!isSoftball({ packageCost, netLockedEdge, availableSize, minLegAsk })) continue;
      hits.push({
        packageId: `pm::${ev.slug}::NO-${a.noTokenId.slice(0, 12)}+NO-${b.noTokenId.slice(0, 12)}`,
        packageKind: "bin-no-pair",
        venue: "polymarket",
        domain: "weather",
        eventSlug: ev.slug,
        packageCost,
        netLockedEdge,
        availableSize,
        minLegAsk,
        softball: true,
        broad: { tokenId: a.noTokenId, noAsk: noA.ask, noAskSize: noA.askSize },
        narrow: { tokenId: b.noTokenId, noAsk: noB.ask, noAskSize: noB.askSize },
      });
    }
  }
  return hits;
}

async function main(): Promise<void> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  log(
    `start gates=${softballGateLabel()} pollMs=${POLL_MS} `
    + `live=${LIVE && ENABLED && !HARD_DISABLED ? 1 : 0} `
    + `exec=${pmSoftballExecLabel()}`,
  );

  let events: PmTempEvent[] = [];
  let lastDiscover = 0;
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
          const hits: PmSoftballRow[] = [];
          const basket = await scanYesBasket(ev);
          if (basket) hits.push(basket);
          hits.push(...await scanBinNoPairs(ev));
          for (const hit of hits) {
            emit(AUDIT_PATH, { observedAt: new Date().toISOString(), ...hit, mode: LIVE ? "live" : "shadow" });
            log(
              `!!! SOFTBALL FIRE ${hit.packageKind} ${hit.eventSlug} `
              + `cost=${hit.packageCost.toFixed(3)} net=${(hit.netLockedEdge * 100).toFixed(2)}c `
              + `size=${hit.availableSize.toFixed(1)} minLegAsk=${((hit.minLegAsk ?? 0) * 100).toFixed(1)}c`,
            );
            enqueuePmSoftball(hit);
            fires += 1;
          }
        } catch (err) {
          log(`scan ${ev.slug} failed: ${(err as Error).message}`);
        }
      }
      if (fires === 0) log(`cycle events=${events.length} softballs=0`);
      else log(`cycle events=${events.length} softballs=${fires}`);
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
