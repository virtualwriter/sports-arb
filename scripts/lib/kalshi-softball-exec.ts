/**
 * Live Kalshi softball execution for weather packages detected by the WS scanner.
 *
 * Gates (shared with shadow tagging): net≥2¢, size≥10, cost∈[0.85,0.99], minLegAsk≥1¢.
 * Live requires KALSHI_SOFTBALL_LIVE=1. Default domain allowlist = weather only.
 *
 * Book side convention (Kalshi YES book):
 *   bid @ yesAsk  = buy YES
 *   ask @ 1-noAsk = buy NO
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { KalshiClient } from "./kalshi-client.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const ORDERS_PATH = join(DATA_DIR, "kalshi-softball-orders.jsonl");

export const KALSHI_SOFTBALL_LIVE = /^(1|true|yes)$/i.test(
  process.env.KALSHI_SOFTBALL_LIVE ?? "",
);
const MAX_CONTRACTS = Math.max(1, Number(process.env.KALSHI_SOFTBALL_MAX_CONTRACTS ?? 25));
const MAX_PACKAGE_USD = Math.max(1, Number(process.env.KALSHI_SOFTBALL_MAX_PACKAGE_USD ?? 50));
const MAX_DAILY_USD = Math.max(1, Number(process.env.KALSHI_SOFTBALL_MAX_DAILY_USD ?? 250));
const COOLDOWN_MS = Math.max(0, Number(process.env.KALSHI_SOFTBALL_COOLDOWN_MS ?? 120_000));
const DOMAIN_ALLOW = new Set(
  (process.env.KALSHI_SOFTBALL_DOMAIN ?? "weather")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const TIF = (process.env.KALSHI_SOFTBALL_TIF ?? "fill_or_kill") as
  | "fill_or_kill"
  | "immediate_or_cancel";

type LegPlan = {
  ticker: string;
  outcome: "yes" | "no";
  bookSide: "bid" | "ask";
  yesPrice: number;
  cost: number;
};

export type KalshiSoftballRow = {
  packageId: string;
  packageKind: string;
  domain?: string;
  venue?: string;
  packageCost: number;
  netLockedEdge: number;
  availableSize: number;
  minLegAsk?: number;
  softball?: boolean;
  broad?: { ticker?: string; yesAsk?: number; noAsk?: number; yesAskSize?: number; noAskSize?: number };
  narrow?: { ticker?: string; yesAsk?: number; noAsk?: number; yesAskSize?: number; noAskSize?: number };
  legs?: Array<{ ticker?: string; yesAsk?: number; yesAskSize?: number; noAsk?: number; noAskSize?: number }>;
  [key: string]: unknown;
};

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
  console.log(`[kalshi-softball-exec ${new Date().toISOString()}] ${msg}`);
}

function buildLegs(row: KalshiSoftballRow): LegPlan[] | null {
  const kind = row.packageKind;
  if (kind === "middle") {
    const broad = row.broad;
    const narrow = row.narrow;
    if (!broad?.ticker || !(Number(broad.yesAsk) > 0)) return null;
    if (!narrow?.ticker || !(Number(narrow.noAsk) > 0)) return null;
    const yesAsk = Number(broad.yesAsk);
    const noAsk = Number(narrow.noAsk);
    return [
      { ticker: broad.ticker, outcome: "yes", bookSide: "bid", yesPrice: yesAsk, cost: yesAsk },
      {
        ticker: narrow.ticker,
        outcome: "no",
        bookSide: "ask",
        yesPrice: Math.max(0.01, Number((1 - noAsk).toFixed(4))),
        cost: noAsk,
      },
    ];
  }
  if (kind === "bin-no-pair") {
    const a = row.broad;
    const b = row.narrow;
    if (!a?.ticker || !(Number(a.noAsk) > 0)) return null;
    if (!b?.ticker || !(Number(b.noAsk) > 0)) return null;
    const noA = Number(a.noAsk);
    const noB = Number(b.noAsk);
    return [
      {
        ticker: a.ticker,
        outcome: "no",
        bookSide: "ask",
        yesPrice: Math.max(0.01, Number((1 - noA).toFixed(4))),
        cost: noA,
      },
      {
        ticker: b.ticker,
        outcome: "no",
        bookSide: "ask",
        yesPrice: Math.max(0.01, Number((1 - noB).toFixed(4))),
        cost: noB,
      },
    ];
  }
  if (kind === "yes-basket") {
    const legs = row.legs ?? [];
    if (legs.length === 0) return null;
    const out: LegPlan[] = [];
    for (const leg of legs) {
      if (!leg.ticker || !(Number(leg.yesAsk) > 0)) return null;
      const yesAsk = Number(leg.yesAsk);
      out.push({
        ticker: leg.ticker,
        outcome: "yes",
        bookSide: "bid",
        yesPrice: yesAsk,
        cost: yesAsk,
      });
    }
    return out;
  }
  return null;
}

function sizeContracts(row: KalshiSoftballRow): number {
  const bySize = Math.floor(Number(row.availableSize) || 0);
  const byCap = MAX_CONTRACTS;
  const byUsd = row.packageCost > 0 ? Math.floor(MAX_PACKAGE_USD / row.packageCost) : 0;
  return Math.max(0, Math.min(bySize, byCap, byUsd));
}

export function kalshiSoftballExecLabel(): string {
  return (
    `live=${KALSHI_SOFTBALL_LIVE ? 1 : 0} `
    + `domain=${[...DOMAIN_ALLOW].join("|") || "*"} `
    + `maxContracts=${MAX_CONTRACTS} `
    + `maxPkgUsd=${MAX_PACKAGE_USD} `
    + `maxDailyUsd=${MAX_DAILY_USD} `
    + `tif=${TIF}`
  );
}

/**
 * Fire-and-forget safe entrypoint. No-ops unless LIVE + weather softball.
 * Serialized so two softballs can't race the daily spend counter.
 */
export function enqueueKalshiSoftball(
  client: KalshiClient,
  row: KalshiSoftballRow,
): void {
  if (!row.softball) return;
  if (!KALSHI_SOFTBALL_LIVE) {
    log(`shadow skip ${row.packageKind} ${row.packageId}`);
    return;
  }
  const domain = String(row.domain ?? "").toLowerCase();
  if (DOMAIN_ALLOW.size > 0 && !DOMAIN_ALLOW.has(domain)) {
    log(`skip domain=${domain} id=${row.packageId}`);
    return;
  }
  if (row.venue && row.venue !== "kalshi") return;

  void (async () => {
    if (inFlight) {
      log(`skip busy id=${row.packageId}`);
      return;
    }
    inFlight = true;
    try {
      await executeKalshiSoftball(client, row);
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

export async function executeKalshiSoftball(
  client: KalshiClient,
  row: KalshiSoftballRow,
): Promise<"fired" | "skipped"> {
  const now = Date.now();
  const prev = lastFire.get(row.packageId) ?? 0;
  if (now - prev < COOLDOWN_MS) {
    log(`skip cooldown id=${row.packageId}`);
    return "skipped";
  }

  const legs = buildLegs(row);
  if (!legs) {
    log(`skip unbuildable kind=${row.packageKind} id=${row.packageId}`);
    return "skipped";
  }

  const count = sizeContracts(row);
  if (count < 1) {
    log(`skip size=0 id=${row.packageId}`);
    return "skipped";
  }

  const dk = dayKey();
  if (dk !== spentDayKey) {
    spentDayKey = dk;
    spentTodayUsd = 0;
  }
  const notional = count * row.packageCost;
  if (spentTodayUsd + notional > MAX_DAILY_USD) {
    log(
      `skip daily cap spent=${spentTodayUsd.toFixed(2)} + ${notional.toFixed(2)} > ${MAX_DAILY_USD}`,
    );
    return "skipped";
  }

  lastFire.set(row.packageId, now);
  const observedAt = new Date().toISOString();
  log(
    `!!! LIVE FIRE ${row.packageKind} contracts=${count} cost=${row.packageCost.toFixed(3)} `
    + `net=${(row.netLockedEdge * 100).toFixed(2)}c notional≈$${notional.toFixed(2)} `
    + `id=${row.packageId}`,
  );

  const results: Array<Record<string, unknown>> = [];
  // Parallel FOK/IOC: each leg independent; we log asymmetric fills.
  const settled = await Promise.allSettled(
    legs.map(async (leg) => {
      const clientOrderId = randomUUID();
      const payload = {
        ticker: leg.ticker,
        side: leg.bookSide,
        count,
        price: Number(leg.yesPrice.toFixed(4)),
        time_in_force: TIF,
        client_order_id: clientOrderId,
      };
      try {
        const resp = await client.createOrderV2(payload);
        const fillCount = Number((resp as { fill_count?: string }).fill_count ?? 0);
        results.push({
          type: "order",
          outcome: leg.outcome,
          ...payload,
          resp,
          fillCount,
        });
        return { leg, resp, fillCount, ok: true as const };
      } catch (err) {
        results.push({
          type: "order_error",
          outcome: leg.outcome,
          ...payload,
          error: (err as Error).message.slice(0, 400),
        });
        return { leg, error: (err as Error).message, ok: false as const };
      }
    }),
  );

  const fills = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
  const fillCounts = fills.map((f) => (f && f.ok ? f.fillCount : 0));
  const minFill = fillCounts.length ? Math.min(...fillCounts) : 0;
  const maxFill = fillCounts.length ? Math.max(...fillCounts) : 0;

  if (minFill > 0) {
    spentTodayUsd += minFill * row.packageCost;
  }

  // Asymmetric fill: try to flatten the excess at market via IOC unwind.
  if (maxFill > minFill) {
    for (const f of fills) {
      if (!f || !f.ok) continue;
      const excess = f.fillCount - minFill;
      if (excess <= 0) continue;
      const unwindSide = f.leg.bookSide === "bid" ? "ask" : "bid";
      // Cross aggressively: sell YES near 0.01 / buy YES near 0.99.
      const unwindPrice = unwindSide === "ask" ? 0.01 : 0.99;
      try {
        const resp = await client.createOrderV2({
          ticker: f.leg.ticker,
          side: unwindSide,
          count: excess,
          price: unwindPrice,
          time_in_force: "immediate_or_cancel",
          client_order_id: randomUUID(),
        });
        results.push({
          type: "unwind",
          ticker: f.leg.ticker,
          side: unwindSide,
          count: excess,
          price: unwindPrice,
          resp,
        });
        log(`unwind excess=${excess} ${f.leg.ticker} ${unwindSide}@${unwindPrice}`);
      } catch (err) {
        results.push({
          type: "unwind_error",
          ticker: f.leg.ticker,
          count: excess,
          error: (err as Error).message.slice(0, 300),
        });
        log(`unwind failed ${f.leg.ticker}: ${(err as Error).message}`);
      }
    }
  }

  emitOrder({
    observedAt,
    type: "softball_attempt",
    packageId: row.packageId,
    packageKind: row.packageKind,
    domain: row.domain,
    packageCost: row.packageCost,
    netLockedEdge: row.netLockedEdge,
    contractsRequested: count,
    fillCounts,
    matchedContracts: minFill,
    notionalMatched: minFill * row.packageCost,
    spentTodayUsd,
    results,
  });

  log(
    `done id=${row.packageId} fills=[${fillCounts.join(",")}] matched=${minFill} `
    + `spentToday=$${spentTodayUsd.toFixed(2)}`,
  );
  return minFill > 0 ? "fired" : "skipped";
}
