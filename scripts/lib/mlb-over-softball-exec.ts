/**
 * Live / shadow execution for early MLB next-line Kalshi over softballs.
 *
 * LIVE requires MLB_OVER_SOFTBALL_LIVE=1. Independent of weather KALSHI_SOFTBALL_LIVE.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { KalshiClient } from "./kalshi-client.js";
import { killSwitchActive } from "./orphan-monitor.js";
import {
  planAskWalk,
  type MlbOverSoftballCandidate,
} from "./mlb-over-softball.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const ORDERS_PATH = join(DATA_DIR, "mlb-over-softball-orders.jsonl");

export const MLB_OVER_SOFTBALL_LIVE = /^(1|true|yes)$/i.test(
  process.env.MLB_OVER_SOFTBALL_LIVE ?? "",
);
const MAX_CONTRACTS = Math.max(1, Number(process.env.MLB_OVER_SOFTBALL_MAX_CONTRACTS ?? 25));
const MAX_USD = Math.max(1, Number(process.env.MLB_OVER_SOFTBALL_MAX_USD ?? 25));
const MAX_DAILY_USD = Math.max(1, Number(process.env.MLB_OVER_SOFTBALL_MAX_DAILY_USD ?? 200));
const MAX_ASK = Math.min(0.99, Math.max(0.05, Number(process.env.MLB_OVER_SOFTBALL_MAX_ASK ?? 0.94)));
/** Walk the ask until at least tobMult × TOB size (within maxAsk / caps). */
const TOB_SIZE_MULT = Math.max(1, Number(process.env.MLB_OVER_SOFTBALL_TOB_SIZE_MULT ?? 2));
const TIF = (process.env.MLB_OVER_SOFTBALL_TIF ?? "immediate_or_cancel") as
  | "fill_or_kill"
  | "immediate_or_cancel";

export type MlbOverSoftballFireCtx = {
  slug: string;
  t0: number;
  scoreAway: number;
  scoreHome: number;
  source: string;
  candidate: MlbOverSoftballCandidate;
};

type EmitFn = (row: Record<string, unknown>) => void;

let spentTodayUsd = 0;
let spentDayKey = "";
const firedKeys = new Set<string>();
let inFlight = false;
let client: KalshiClient | null = null;
let emitHook: EmitFn | null = null;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function appendOrder(row: Record<string, unknown>): void {
  ensureParent(ORDERS_PATH);
  appendFileSync(ORDERS_PATH, `${JSON.stringify(row)}\n`);
}

function log(msg: string): void {
  console.log(`[mlb-over-softball-exec ${new Date().toISOString()}] ${msg}`);
}

function dedupeKey(ctx: MlbOverSoftballFireCtx): string {
  return `${ctx.slug}|${ctx.scoreAway}-${ctx.scoreHome}`;
}

export function mlbOverSoftballExecLabel(): string {
  return (
    `live=${MLB_OVER_SOFTBALL_LIVE ? 1 : 0} `
    + `maxContracts=${MAX_CONTRACTS} `
    + `maxUsd=${MAX_USD} `
    + `maxDailyUsd=${MAX_DAILY_USD} `
    + `maxAsk=${MAX_ASK} `
    + `tobMult=${TOB_SIZE_MULT} `
    + `tif=${TIF}`
  );
}

export function configureMlbOverSoftballExec(opts: {
  client?: KalshiClient | null;
  emit?: EmitFn | null;
}): void {
  if (opts.client !== undefined) client = opts.client;
  if (opts.emit !== undefined) emitHook = opts.emit;
}

function publish(row: Record<string, unknown>): void {
  appendOrder(row);
  emitHook?.(row);
}

/**
 * Fire-and-forget. Always emits a shadow/signal row; places a Kalshi FOK bid
 * only when LIVE=1 and gates pass.
 */
export function enqueueMlbOverSoftball(ctx: MlbOverSoftballFireCtx): void {
  void (async () => {
    if (inFlight) {
      log(`skip busy ${dedupeKey(ctx)}`);
      return;
    }
    inFlight = true;
    try {
      await executeMlbOverSoftball(ctx);
    } catch (err) {
      log(`exec error: ${(err as Error).message}`);
      publish({
        kind: "mlb_over_softball_error",
        observedAt: new Date().toISOString(),
        slug: ctx.slug,
        t0: ctx.t0,
        error: (err as Error).message.slice(0, 400),
      });
    } finally {
      inFlight = false;
    }
  })();
}

export async function executeMlbOverSoftball(
  ctx: MlbOverSoftballFireCtx,
): Promise<"shadow" | "fired" | "skipped"> {
  const { candidate: c } = ctx;
  const key = dedupeKey(ctx);
  if (firedKeys.has(key)) {
    log(`skip dedupe ${key}`);
    return "skipped";
  }
  firedKeys.add(key);

  const walk = planAskWalk({
    tobAsk: c.ask,
    tobSize: c.askSize,
    askLevels: c.askLevels,
    maxAsk: MAX_ASK,
    maxContracts: MAX_CONTRACTS,
    maxUsd: MAX_USD,
    tobMult: TOB_SIZE_MULT,
  });
  const count = walk.count;
  const limitPrice = walk.limitPrice;
  const vwap = walk.vwap;
  const base = {
    kind: "mlb_over_softball_signal" as const,
    observedAt: new Date().toISOString(),
    slug: ctx.slug,
    t0: ctx.t0,
    source: ctx.source,
    scoreAway: ctx.scoreAway,
    scoreHome: ctx.scoreHome,
    curTotal: c.curTotal,
    inning: c.inning,
    runsDelta: c.runsDelta,
    line: c.line,
    ask: c.ask,
    askSize: c.askSize,
    ticker: c.ticker,
    cats: c.cats,
    contracts: count,
    limitPrice,
    vwap,
    tobMult: TOB_SIZE_MULT,
    targetSize: walk.targetSize,
    levelsTaken: walk.levelsTaken,
    live: MLB_OVER_SOFTBALL_LIVE,
  };
  publish(base);

  if (!MLB_OVER_SOFTBALL_LIVE) {
    log(
      `shadow ${ctx.slug} over${c.line} tob=${c.ask.toFixed(2)}x${c.askSize.toFixed(0)} `
      + `→ walk x${count} limit=${limitPrice.toFixed(2)} vwap=${vwap.toFixed(3)} `
      + `cats=${c.cats.join(",")}`,
    );
    return "shadow";
  }

  if (killSwitchActive()) {
    log(`skip kill switch ${key}`);
    publish({ ...base, kind: "mlb_over_softball_skip", reason: "kill_switch" });
    return "skipped";
  }
  if (c.ask > MAX_ASK) {
    publish({ ...base, kind: "mlb_over_softball_skip", reason: "ask_above_max" });
    return "skipped";
  }
  if (count < 1) {
    publish({ ...base, kind: "mlb_over_softball_skip", reason: "size_zero" });
    return "skipped";
  }
  if (!client) {
    log(`LIVE but no KalshiClient — staying shadow for ${key}`);
    publish({ ...base, kind: "mlb_over_softball_skip", reason: "no_client" });
    return "skipped";
  }

  const dk = dayKey();
  if (dk !== spentDayKey) {
    spentDayKey = dk;
    spentTodayUsd = 0;
  }
  // Budget against worst-case (full fill at limit).
  const notionalCap = count * limitPrice;
  if (spentTodayUsd + notionalCap > MAX_DAILY_USD) {
    publish({
      ...base,
      kind: "mlb_over_softball_skip",
      reason: "daily_cap",
      spentTodayUsd,
      notional: notionalCap,
    });
    return "skipped";
  }

  // IOC when walking above TOB so partial deeper fills still stick; FOK only if
  // env forces it and we're not walking.
  const walking = limitPrice > c.ask + 1e-9 || count > Math.floor(c.askSize) + 1e-9;
  const tif = walking && TIF === "fill_or_kill" ? "immediate_or_cancel" : TIF;

  const clientOrderId = randomUUID();
  const payload = {
    ticker: c.ticker,
    side: "bid" as const,
    count,
    price: Number(limitPrice.toFixed(4)),
    time_in_force: tif,
    client_order_id: clientOrderId,
  };
  log(
    `!!! LIVE FIRE ${ctx.slug} over${c.line} tob=${c.ask.toFixed(2)}x${Math.floor(c.askSize)} `
    + `→ x${count} limit=${limitPrice.toFixed(2)} vwap≈${vwap.toFixed(3)} `
    + `(≈$${notionalCap.toFixed(2)}) tif=${tif} cats=${c.cats.join(",")}`,
  );
  const started = Date.now();
  try {
    const resp = await client.createOrderV2(payload);
    const rttMs = Date.now() - started;
    const fillCount = Number((resp as { fill_count?: string }).fill_count ?? 0);
    // Charge daily spend at planned VWAP (conservative vs TOB).
    if (fillCount > 0) spentTodayUsd += fillCount * vwap;
    publish({
      ...base,
      kind: "mlb_over_softball_order",
      ...payload,
      resp,
      fillCount,
      rttMs,
      spentTodayUsd,
    });
    return "fired";
  } catch (err) {
    const rttMs = Date.now() - started;
    publish({
      ...base,
      kind: "mlb_over_softball_order_error",
      ...payload,
      rttMs,
      error: (err as Error).message.slice(0, 400),
    });
    return "skipped";
  }
}

/** Test helper — reset process-local gates. */
export function resetMlbOverSoftballExecForTests(): void {
  spentTodayUsd = 0;
  spentDayKey = "";
  firedKeys.clear();
  inFlight = false;
  client = null;
  emitHook = null;
}
