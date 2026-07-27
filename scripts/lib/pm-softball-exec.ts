/**
 * Live Polymarket weather softball execution.
 *
 * Supports:
 *   - bin-no-pair: buy both NO tokens (FAK)
 *   - yes-basket: buy every YES token (FAK)
 *
 * Live requires WEATHER_SOFTBALL_LIVE=1 (or PM_SOFTBALL_LIVE=1) AND the shared
 * ENABLE_MONOTONIC_ARB_REAL_PM / hard-disable guards.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  clobClient,
  ENABLED,
  HARD_DISABLED,
  MAX_DAILY_USD,
  MAX_PACKAGE_USD,
  postFakBuyBatch,
  precisionSafeBuyShares,
} from "../polymarket-real-monotonic-executor.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const ORDERS_PATH = join(DATA_DIR, "weather-softball-orders.jsonl");

const LIVE = /^(1|true|yes)$/i.test(
  process.env.PM_SOFTBALL_LIVE
    ?? process.env.WEATHER_SOFTBALL_LIVE
    ?? "",
);
const COOLDOWN_MS = Math.max(0, Number(process.env.WEATHER_SOFTBALL_COOLDOWN_MS ?? 120_000));
const MIN_ORDER_SHARES = Number(process.env.WEATHER_SOFTBALL_MIN_ORDER_SHARES ?? 5);

export type PmSoftballRow = {
  packageId: string;
  packageKind: string;
  venue?: string;
  domain?: string;
  packageCost: number;
  netLockedEdge: number;
  availableSize: number;
  minLegAsk?: number;
  softball?: boolean;
  eventSlug?: string;
  broad?: { tokenId?: string; noAsk?: number; noAskSize?: number; yesAsk?: number; yesAskSize?: number };
  narrow?: { tokenId?: string; noAsk?: number; noAskSize?: number; yesAsk?: number; yesAskSize?: number };
  legs?: Array<{ tokenId?: string; yesAsk?: number; yesAskSize?: number; noAsk?: number; noAskSize?: number }>;
  [key: string]: unknown;
};

type Leg = { tokenId: string; price: number; askSize: number };

let spentTodayUsd = 0;
let spentDayKey = "";
const lastFire = new Map<string, number>();
let inFlight = false;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function emitOrder(row: Record<string, unknown>): void {
  ensureParent(ORDERS_PATH);
  appendFileSync(ORDERS_PATH, `${JSON.stringify(row)}\n`);
}

function log(msg: string): void {
  console.log(`[pm-softball-exec ${new Date().toISOString()}] ${msg}`);
}

function buildLegs(row: PmSoftballRow): Leg[] | null {
  const kind = row.packageKind;
  if (kind === "bin-no-pair") {
    const a = row.broad;
    const b = row.narrow;
    if (!a?.tokenId || !(Number(a.noAsk) > 0)) return null;
    if (!b?.tokenId || !(Number(b.noAsk) > 0)) return null;
    return [
      { tokenId: a.tokenId, price: Number(a.noAsk), askSize: Number(a.noAskSize ?? 0) },
      { tokenId: b.tokenId, price: Number(b.noAsk), askSize: Number(b.noAskSize ?? 0) },
    ];
  }
  if (kind === "yes-basket") {
    const legs = row.legs ?? [];
    if (legs.length === 0) return null;
    const out: Leg[] = [];
    for (const leg of legs) {
      if (!leg.tokenId || !(Number(leg.yesAsk) > 0)) return null;
      out.push({
        tokenId: leg.tokenId,
        price: Number(leg.yesAsk),
        askSize: Number(leg.yesAskSize ?? 0),
      });
    }
    return out;
  }
  return null;
}

export function pmSoftballExecLabel(): string {
  const liveMode = LIVE && ENABLED && !HARD_DISABLED;
  return (
    `live=${liveMode ? 1 : 0} `
    + `(LIVE=${LIVE ? 1 : 0} ENABLED=${ENABLED ? 1 : 0} HARD_DISABLED=${HARD_DISABLED ? 1 : 0}) `
    + `maxPkgUsd=${MAX_PACKAGE_USD} maxDailyUsd=${MAX_DAILY_USD}`
  );
}

export function enqueuePmSoftball(row: PmSoftballRow): void {
  if (!row.softball) return;
  if (row.venue && row.venue !== "polymarket") return;
  const liveMode = LIVE && ENABLED && !HARD_DISABLED;
  if (!liveMode) {
    log(`shadow skip ${row.packageKind} ${row.packageId}`);
    return;
  }
  void (async () => {
    if (inFlight) {
      log(`skip busy id=${row.packageId}`);
      return;
    }
    inFlight = true;
    try {
      await executePmSoftball(row);
    } catch (err) {
      log(`exec error: ${(err as Error).message}`);
      emitOrder({
        observedAt: new Date().toISOString(),
        type: "exec_error",
        packageId: row.packageId,
        error: (err as Error).message,
      });
    } finally {
      inFlight = false;
    }
  })();
}

function recentlyOrdered(packageId: string, nowMs: number): boolean {
  try {
    if (!existsSync(ORDERS_PATH)) return false;
    const lines = readFileSync(ORDERS_PATH, "utf8").trim().split("\n").slice(-80);
    for (const line of lines) {
      if (!line.includes(packageId)) continue;
      try {
        const r = JSON.parse(line) as { packageId?: string; observedAt?: string };
        if (r.packageId !== packageId || !r.observedAt) continue;
        if (nowMs - Date.parse(r.observedAt) < COOLDOWN_MS) return true;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return false;
}

export async function executePmSoftball(row: PmSoftballRow): Promise<"fired" | "skipped"> {
  const now = Date.now();
  const prev = lastFire.get(row.packageId) ?? 0;
  if (now - prev < COOLDOWN_MS || recentlyOrdered(row.packageId, now)) {
    log(`skip cooldown id=${row.packageId}`);
    return "skipped";
  }

  const legs = buildLegs(row);
  if (!legs) {
    log(`skip unbuildable kind=${row.packageKind} id=${row.packageId}`);
    return "skipped";
  }

  const bySize = Math.min(
    Number(row.availableSize) || 0,
    ...legs.map((l) => (l.askSize > 0 ? l.askSize : Number(row.availableSize) || 0)),
  );
  const usdCapShares = MAX_PACKAGE_USD > 0 && row.packageCost > 0
    ? MAX_PACKAGE_USD / row.packageCost
    : bySize;
  let shares = Math.min(bySize, usdCapShares);
  if (!(shares > 0)) {
    log(`skip size=0 id=${row.packageId}`);
    return "skipped";
  }

  const dk = dayKey();
  if (dk !== spentDayKey) {
    spentDayKey = dk;
    spentTodayUsd = 0;
  }
  const notional = shares * row.packageCost;
  if (spentTodayUsd + notional > MAX_DAILY_USD) {
    log(
      `skip daily cap spent=${spentTodayUsd.toFixed(2)} + ${notional.toFixed(2)} > ${MAX_DAILY_USD}`,
    );
    return "skipped";
  }

  lastFire.set(row.packageId, now);
  const observedAt = new Date().toISOString();
  log(
    `!!! LIVE FIRE ${row.packageKind} shares≈${shares.toFixed(2)} cost=${row.packageCost.toFixed(3)} `
    + `net=${(row.netLockedEdge * 100).toFixed(2)}c notional≈$${notional.toFixed(2)} `
    + `id=${row.packageId}`,
  );

  let sized: number | null = null;
  for (
    let trial = Math.floor(shares * 100) / 100;
    trial + 1e-9 >= MIN_ORDER_SHARES;
    trial = Math.round((trial - 0.01) * 100) / 100
  ) {
    const ok = legs.every((leg) => {
      const safe = precisionSafeBuyShares(leg.price, MIN_ORDER_SHARES, trial);
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
  for (const leg of legs) {
    const safe = precisionSafeBuyShares(leg.price, MIN_ORDER_SHARES, sized);
    if (!(safe && safe > 0)) {
      log(`skip live: precision-safe shares unavailable @ ask=${leg.price}`);
      return "skipped";
    }
    batch.push({ tokenId: leg.tokenId, price: leg.price, shares: safe });
  }
  const matchedShares = Math.min(...batch.map((l) => l.shares));
  for (const leg of batch) leg.shares = matchedShares;

  try {
    const { client } = await clobClient();
    const responses = await postFakBuyBatch(client, batch);
    const liveNotional = matchedShares * row.packageCost;
    spentTodayUsd += liveNotional;
    emitOrder({
      observedAt,
      type: "softball_attempt",
      venue: "polymarket",
      packageId: row.packageId,
      packageKind: row.packageKind,
      eventSlug: row.eventSlug,
      packageCost: row.packageCost,
      netLockedEdge: row.netLockedEdge,
      shares: matchedShares,
      notional: liveNotional,
      spentTodayUsd,
      legs: batch,
      responses,
    });
    log(
      `live submitted ${batch.length} FAK legs x${matchedShares} for ${row.packageId} `
      + `spentToday=$${spentTodayUsd.toFixed(2)}`,
    );
    return "fired";
  } catch (err) {
    log(`live submit failed: ${(err as Error).message}`);
    emitOrder({
      observedAt,
      type: "order_error",
      venue: "polymarket",
      packageId: row.packageId,
      packageKind: row.packageKind,
      error: (err as Error).message,
      legs: batch,
    });
    return "skipped";
  }
}
