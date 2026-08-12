/**
 * Live / shadow execution for early MLB next-line Kalshi over softballs.
 *
 * LIVE requires MLB_OVER_SOFTBALL_LIVE=1. Independent of weather KALSHI_SOFTBALL_LIVE.
 *
 * Shadow tighten (default on): multi_run_early with ask ≥ $0.90 from inn 5+
 * logs would-skip and does not live-fire (cheap_over_early unaffected).
 * Flip with MLB_OVER_SOFTBALL_MULTI_RUN_LATE_HIGH_MODE=enforce|off.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { KalshiClient } from "./kalshi-client.js";
import { killSwitchActive } from "./orphan-monitor.js";
import {
  isMultiRunLateHighAsk,
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

/** Clear visible book ≤ maxAsk (capped by maxContracts / maxUsd). Default on. */
const FILL_BOOK = !/^(0|false|no)$/i.test(process.env.MLB_OVER_SOFTBALL_FILL_BOOK ?? "1");

const MAX_CONTRACTS = Math.max(
  1,
  Number(process.env.MLB_OVER_SOFTBALL_MAX_CONTRACTS ?? (FILL_BOOK ? 1000 : 25)),
);
const MAX_USD = Math.max(
  1,
  Number(process.env.MLB_OVER_SOFTBALL_MAX_USD ?? (FILL_BOOK ? 100 : 25)),
);
const MAX_DAILY_USD = Math.max(
  1,
  Number(process.env.MLB_OVER_SOFTBALL_MAX_DAILY_USD ?? (FILL_BOOK ? 3000 : 200)),
);
/** Skip / don't walk above this YES ask — 0.90 avoids ~at-cost 93–94¢ chases. */
const MAX_ASK = Math.min(0.99, Math.max(0.05, Number(process.env.MLB_OVER_SOFTBALL_MAX_ASK ?? 0.9)));
/**
 * Don't walk more than this above TOB (default 2¢). Stops fill-book from
 * turning an 87¢ print into a ~90¢ VWAP with almost no edge.
 */
const MAX_WALK = Math.min(
  0.2,
  Math.max(0, Number(process.env.MLB_OVER_SOFTBALL_MAX_WALK ?? 0.02)),
);
/** Used only when FILL_BOOK=0. */
const TOB_SIZE_MULT = Math.max(1, Number(process.env.MLB_OVER_SOFTBALL_TOB_SIZE_MULT ?? 2));
const TIF = (process.env.MLB_OVER_SOFTBALL_TIF ?? "immediate_or_cancel") as
  | "fill_or_kill"
  | "immediate_or_cancel";

/** shadow (default) | enforce | off */
const LATE_HIGH_MODE = (
  process.env.MLB_OVER_SOFTBALL_MULTI_RUN_LATE_HIGH_MODE ?? "shadow"
).toLowerCase();
const LATE_HIGH_MIN_INN = Math.max(
  1,
  Number(process.env.MLB_OVER_SOFTBALL_MULTI_RUN_LATE_HIGH_MIN_INN ?? 5),
);
const LATE_HIGH_ASK = Math.min(
  0.99,
  Math.max(0.5, Number(process.env.MLB_OVER_SOFTBALL_MULTI_RUN_LATE_HIGH_ASK ?? 0.9)),
);

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
    + `fillBook=${FILL_BOOK ? 1 : 0} `
    + `maxContracts=${MAX_CONTRACTS} `
    + `maxUsd=${MAX_USD} `
    + `maxDailyUsd=${MAX_DAILY_USD} `
    + `maxAsk=${MAX_ASK} `
    + `maxWalk=${MAX_WALK} `
    + `tobMult=${TOB_SIZE_MULT} `
    + `tif=${TIF} `
    + `lateHigh=${LATE_HIGH_MODE}@inn≥${LATE_HIGH_MIN_INN}/ask≥${LATE_HIGH_ASK}`
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

function lateHighAskHit(c: MlbOverSoftballCandidate): boolean {
  if (LATE_HIGH_MODE === "off") return false;
  return isMultiRunLateHighAsk({
    cats: c.cats,
    inning: c.inning,
    ask: c.ask,
    minInning: LATE_HIGH_MIN_INN,
    askThreshold: LATE_HIGH_ASK,
  });
}

/**
 * Fire-and-forget. Always emits a shadow/signal row; places a Kalshi order
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
    fillBook: FILL_BOOK,
    maxWalkAboveTob: MAX_WALK,
  });
  const count = walk.count;
  const limitPrice = walk.limitPrice;
  const vwap = walk.vwap;
  const lateHigh = lateHighAskHit(c);
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
    fillBook: FILL_BOOK,
    maxWalkAboveTob: MAX_WALK,
    targetSize: walk.targetSize,
    levelsTaken: walk.levelsTaken,
    live: MLB_OVER_SOFTBALL_LIVE,
    lateHighAskGate: lateHigh
      ? {
        mode: LATE_HIGH_MODE,
        minInning: LATE_HIGH_MIN_INN,
        askThreshold: LATE_HIGH_ASK,
      }
      : null,
  };
  publish(base);

  if (!MLB_OVER_SOFTBALL_LIVE) {
    log(
      `shadow ${ctx.slug} over${c.line} tob=${c.ask.toFixed(2)}x${c.askSize.toFixed(0)} `
      + `→ walk x${count} limit=${limitPrice.toFixed(2)} vwap=${vwap.toFixed(3)} `
      + `fillBook=${FILL_BOOK ? 1 : 0} cats=${c.cats.join(",")}`
      + (lateHigh ? ` LATE_HIGH_WOULD_SKIP` : ""),
    );
    return "shadow";
  }

  if (lateHigh) {
    const reason =
      LATE_HIGH_MODE === "enforce"
        ? "multi_run_late_high_ask"
        : "shadow_multi_run_late_high_ask";
    log(
      `skip ${reason} ${ctx.slug} inn${c.inning} over${c.line} @${c.ask.toFixed(2)} `
      + `(mode=${LATE_HIGH_MODE})`,
    );
    publish({
      ...base,
      kind: "mlb_over_softball_skip",
      reason,
      wouldHaveContracts: count,
      wouldHaveLimit: limitPrice,
      wouldHaveVwap: vwap,
      wouldHaveNotional: count * limitPrice,
    });
    return "skipped";
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
    + `(≈$${notionalCap.toFixed(2)}) tif=${tif} fillBook=${FILL_BOOK ? 1 : 0} `
    + `cats=${c.cats.join(",")}`,
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
