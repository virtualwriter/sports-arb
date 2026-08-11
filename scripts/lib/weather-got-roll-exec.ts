/**
 * Live / shadow execution for GOT daily-high directional rolls.
 *
 * LIVE requires WEATHER_GOT_ROLL_LIVE=1.
 * Independent of KALSHI_SOFTBALL_LIVE / weather PM softballs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { KalshiClient } from "./kalshi-client.js";
import { killSwitchActive } from "./orphan-monitor.js";
import {
  type CityRollState,
  type GotBinMarket,
  type GotRollGuardOpts,
  type RollPlan,
  marketsFromKalshi,
  notionalUsd,
  planBuyWalkForProceeds,
  yesAskLevelsFromBook,
} from "./weather-got-roll.js";

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const ORDERS_PATH = join(DATA_DIR, "weather-got-roll-orders.jsonl");
const STATE_PATH = join(DATA_DIR, "weather-got-roll-state.json");

export const WEATHER_GOT_ROLL_LIVE = /^(1|true|yes)$/i.test(
  process.env.WEATHER_GOT_ROLL_LIVE ?? "",
);
export const STAKE_USD = Math.max(
  1,
  Number(process.env.WEATHER_GOT_ROLL_STAKE_USD ?? 20),
);
export const MAX_DAILY_USD = Math.max(
  STAKE_USD,
  Number(process.env.WEATHER_GOT_ROLL_MAX_DAILY_USD ?? 100),
);
export const MIN_ASK = Math.min(
  0.5,
  Math.max(0.01, Number(process.env.WEATHER_GOT_ROLL_MIN_ASK ?? 0.15)),
);
export const MAX_ASK = Math.min(
  0.99,
  Math.max(MIN_ASK, Number(process.env.WEATHER_GOT_ROLL_MAX_ASK ?? 0.95)),
);
const TIF = (process.env.WEATHER_GOT_ROLL_TIF ?? "immediate_or_cancel") as
  | "fill_or_kill"
  | "immediate_or_cancel";
/** Absolute $ walk past TOB on each roll leg. */
export const ROLL_WALK_SLIP = Math.max(
  0,
  Math.min(0.2, Number(process.env.WEATHER_GOT_ROLL_WALK_SLIP ?? 0.03)),
);
/** Absolute $ walk on opens (size to depth). */
export const OPEN_WALK_SLIP = Math.max(
  0,
  Math.min(0.2, Number(process.env.WEATHER_GOT_ROLL_OPEN_WALK_SLIP ?? ROLL_WALK_SLIP)),
);
/** Do not roll stubs below this mark (contracts × bid). */
export const MIN_ROLL_NOTIONAL_USD = Math.max(
  0,
  Number(process.env.WEATHER_GOT_ROLL_MIN_ROLL_NOTIONAL ?? 5),
);
/** Require sell fill ≥ this fraction of held before advancing to buy. */
export const MIN_SELL_FILL_FRAC = Math.min(
  1,
  Math.max(0, Number(process.env.WEATHER_GOT_ROLL_MIN_SELL_FILL_FRAC ?? 0.95)),
);
/** Skip rolls that would buy fewer than this × contracts sold (price cliff). */
export const MIN_BUY_TO_SELL_RATIO = Math.max(
  0,
  Number(process.env.WEATHER_GOT_ROLL_MIN_BUY_TO_SELL ?? 0.5),
);
/** Cap successful rolls per city-day. */
export const MAX_ROLLS_PER_CITY_DAY = Math.max(
  0,
  Math.floor(Number(process.env.WEATHER_GOT_ROLL_MAX_ROLLS_PER_DAY ?? 5)),
);
/** Consecutive GOT preds on same new bin before rolling. */
export const CONFIRM_TICKS = Math.max(
  1,
  Math.floor(Number(process.env.WEATHER_GOT_ROLL_CONFIRM_TICKS ?? 2)),
);

export function gotRollGuards(): GotRollGuardOpts {
  return {
    minRollNotionalUsd: MIN_ROLL_NOTIONAL_USD,
    minSellFillFrac: MIN_SELL_FILL_FRAC,
    minBuyToSellRatio: MIN_BUY_TO_SELL_RATIO,
    maxRollsPerCityDay: MAX_ROLLS_PER_CITY_DAY,
  };
}

type StateFile = {
  spentDayKey?: string;
  spentTodayUsd?: number;
  cities?: Record<string, CityRollState>;
};

let client: KalshiClient | null = null;
let spentTodayUsd = 0;
let spentDayKey = "";
const cityState = new Map<string, CityRollState>();
let busy = false;

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureParent(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function log(msg: string): void {
  console.log(`[weather-got-roll ${new Date().toISOString()}] ${msg}`);
}

function appendOrder(row: Record<string, unknown>): void {
  ensureParent(ORDERS_PATH);
  appendFileSync(ORDERS_PATH, `${JSON.stringify(row)}\n`);
}

function persistState(): void {
  ensureParent(STATE_PATH);
  const body: StateFile = {
    spentDayKey,
    spentTodayUsd,
    cities: Object.fromEntries(cityState.entries()),
  };
  writeFileSync(STATE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

export function loadGotRollState(): void {
  if (!existsSync(STATE_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as StateFile;
    spentDayKey = raw.spentDayKey ?? "";
    spentTodayUsd = Number(raw.spentTodayUsd ?? 0) || 0;
    cityState.clear();
    for (const [k, v] of Object.entries(raw.cities ?? {})) {
      if (v?.bin && v?.ticker && v.contracts > 0) cityState.set(k, v);
    }
    log(
      `loaded state cities=${cityState.size} spentTodayUsd=${spentTodayUsd.toFixed(2)} day=${spentDayKey}`,
    );
  } catch (err) {
    log(`state load error: ${(err as Error).message}`);
  }
}

export function configureGotRollExec(opts: { client?: KalshiClient | null }): void {
  if (opts.client !== undefined) client = opts.client;
}

export function gotRollExecLabel(): string {
  return (
    `live=${WEATHER_GOT_ROLL_LIVE ? 1 : 0} `
    + `stakeUsd=${STAKE_USD} `
    + `maxDailyUsd=${MAX_DAILY_USD} `
    + `minAsk=${MIN_ASK} `
    + `maxAsk=${MAX_ASK} `
    + `rollWalkSlip=${ROLL_WALK_SLIP} `
    + `openWalkSlip=${OPEN_WALK_SLIP} `
    + `minRollNotional=${MIN_ROLL_NOTIONAL_USD} `
    + `minSellFill=${MIN_SELL_FILL_FRAC} `
    + `minBuyToSell=${MIN_BUY_TO_SELL_RATIO} `
    + `maxRolls/day=${MAX_ROLLS_PER_CITY_DAY} `
    + `confirmTicks=${CONFIRM_TICKS} `
    + `tif=${TIF}`
  );
}

export function getHeld(city: string): CityRollState | null {
  return cityState.get(city) ?? null;
}

export function setHeld(city: string, held: CityRollState | null): void {
  if (!held || held.contracts <= 0) cityState.delete(city);
  else cityState.set(city, held);
  persistState();
}

export function clearHeldIfDay(city: string, day: string): void {
  const h = cityState.get(city);
  if (h && h.day !== day) {
    cityState.delete(city);
    persistState();
  }
}

function refreshSpendDay(): void {
  const dk = dayKey();
  if (dk !== spentDayKey) {
    spentDayKey = dk;
    spentTodayUsd = 0;
  }
}

async function place(
  side: "bid" | "ask",
  ticker: string,
  count: number,
  price: number,
): Promise<{ fillCount: number; resp: unknown; rttMs: number }> {
  if (!client) throw new Error("no_client");
  const started = Date.now();
  const resp = await client.createOrderV2({
    ticker,
    side,
    count,
    price: Number(price.toFixed(4)),
    time_in_force: TIF,
    client_order_id: randomUUID(),
  });
  const rttMs = Date.now() - started;
  const fillCount = Number((resp as { fill_count?: string }).fill_count ?? 0);
  return { fillCount, resp, rttMs };
}

function avgFillPrice(resp: unknown, fallback: number): number {
  const raw = (resp as { average_fill_price?: string })?.average_fill_price;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Sync city state from Kalshi portfolio so orphans are visible to the roller.
 * Picks the largest YES position for each city's event day.
 */
export async function reconcileGotRollFromKalshi(opts: {
  cities: Array<{ key: string; series: string; day: string }>;
}): Promise<void> {
  if (!client) {
    log("reconcile skip: no_client");
    return;
  }
  try {
    const resp = await client.get<{
      market_positions?: Array<{
        ticker?: string;
        position_fp?: string | number;
        position?: string | number;
      }>;
    }>("/portfolio/positions?limit=200");
    const positions = resp.market_positions ?? [];
    for (const city of opts.cities) {
      const prefix = `${city.series}-${city.day.toUpperCase()}`;
      const matches = positions
        .map((p) => ({
          ticker: String(p.ticker ?? ""),
          pos: Number(p.position_fp ?? p.position ?? 0),
        }))
        .filter((p) => p.ticker.startsWith(prefix) && p.pos > 0)
        .sort((a, b) => b.pos - a.pos);
      if (!matches.length) {
        const held = cityState.get(city.key);
        if (held && held.day === city.day) {
          log(`reconcile ${city.key}: flat on Kalshi; clearing local held`);
          cityState.delete(city.key);
        }
        continue;
      }
      const best = matches[0]!;
      let markets: GotBinMarket[] = [];
      try {
        const event = await client.getEvent(`${city.series}-${city.day.toUpperCase()}`, true);
        markets = marketsFromKalshi(event?.markets ?? []);
      } catch {
        /* keep empty */
      }
      const mkt = markets.find((m) => m.ticker === best.ticker);
      const prev = cityState.get(city.key);
      const bin = mkt?.label
        ?? (prev?.ticker === best.ticker ? prev.bin : best.ticker.split("-").pop() ?? "unknown");
      const next: CityRollState = {
        day: city.day,
        bin,
        ticker: best.ticker,
        contracts: Number(best.pos.toFixed(2)),
        avgEntry: prev?.ticker === best.ticker ? prev.avgEntry : 0,
        openedAt: prev?.openedAt ?? new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        rollsToday: prev?.day === city.day ? (prev.rollsToday ?? 0) : 0,
      };
      cityState.set(city.key, next);
      log(
        `reconcile ${city.key}: ${next.contracts}×${next.bin} (${next.ticker})`
        + (matches.length > 1 ? ` (+${matches.length - 1} other pos)` : ""),
      );
    }
    persistState();
  } catch (err) {
    log(`reconcile error: ${(err as Error).message}`);
  }
}

export async function executeGotRollPlan(opts: {
  city: string;
  day: string;
  plan: RollPlan;
  gotRecv?: string;
}): Promise<"shadow" | "fired" | "skipped"> {
  const { city, day, plan } = opts;
  const base = {
    kind: "weather_got_roll_signal" as const,
    observedAt: new Date().toISOString(),
    city,
    day,
    gotRecv: opts.gotRecv,
    plan,
    live: WEATHER_GOT_ROLL_LIVE,
  };
  appendOrder(base);

  if (plan.action === "skip") {
    return "skipped";
  }

  if (!WEATHER_GOT_ROLL_LIVE) {
    log(`shadow ${city} ${plan.action} ${JSON.stringify(plan)}`);
    // Do not persist shadow holds — enabling LIVE later must still be able to open.
    return "shadow";
  }

  if (killSwitchActive()) {
    appendOrder({ ...base, kind: "weather_got_roll_skip", reason: "kill_switch" });
    return "skipped";
  }
  if (!client) {
    appendOrder({ ...base, kind: "weather_got_roll_skip", reason: "no_client" });
    return "skipped";
  }
  if (busy) {
    appendOrder({ ...base, kind: "weather_got_roll_skip", reason: "busy" });
    return "skipped";
  }

  busy = true;
  try {
    refreshSpendDay();
    if (plan.action === "open") {
      const notional = notionalUsd(plan.contracts, plan.limit);
      if (spentTodayUsd + notional > MAX_DAILY_USD) {
        appendOrder({
          ...base,
          kind: "weather_got_roll_skip",
          reason: "daily_cap",
          spentTodayUsd,
          notional,
        });
        return "skipped";
      }
      log(
        `!!! LIVE OPEN ${city} ${plan.bin} ${plan.ticker} x${plan.contracts} @${plan.limit.toFixed(2)} (≈$${notional.toFixed(2)})`,
      );
      const { fillCount, resp, rttMs } = await place(
        "bid",
        plan.ticker,
        plan.contracts,
        plan.limit,
      );
      const avg = avgFillPrice(resp, plan.limit);
      if (fillCount > 0) {
        spentTodayUsd += fillCount * avg;
        cityState.set(city, {
          day,
          bin: plan.bin,
          ticker: plan.ticker,
          contracts: fillCount,
          avgEntry: avg,
          openedAt: new Date().toISOString(),
          lastActionAt: new Date().toISOString(),
          rollsToday: 0,
        });
        persistState();
      }
      appendOrder({
        ...base,
        kind: "weather_got_roll_order",
        side: "bid",
        ticker: plan.ticker,
        count: plan.contracts,
        price: plan.limit,
        fillCount,
        avgFill: avg,
        resp,
        rttMs,
        spentTodayUsd,
      });
      return fillCount > 0 ? "fired" : "skipped";
    }

    // roll — IOC with walked limits (plan.sellLimit/buyLimit may be past TOB).
    const walkNote = plan.walk
      ? ` walk≤${plan.walk.maxSlip} sellTob=${plan.walk.sellTob}→${plan.sellLimit} buyTob=${plan.walk.buyTob}→${plan.buyLimit}`
      : "";
    log(
      `!!! LIVE ROLL ${city} ${plan.fromBin}→${plan.toBin} `
      + `sell x${plan.sellContracts}@${plan.sellLimit.toFixed(2)} `
      + `buy x${plan.buyContracts}@${plan.buyLimit.toFixed(2)}${walkNote}`,
    );
    const prev = cityState.get(city);
    const sell = await place("ask", plan.fromTicker, plan.sellContracts, plan.sellLimit);
    const sellAvg = avgFillPrice(sell.resp, plan.sellLimit);
    appendOrder({
      ...base,
      kind: "weather_got_roll_order",
      leg: "sell",
      side: "ask",
      ticker: plan.fromTicker,
      count: plan.sellContracts,
      price: plan.sellLimit,
      fillCount: sell.fillCount,
      avgFill: sellAvg,
      resp: sell.resp,
      rttMs: sell.rttMs,
    });
    if (sell.fillCount <= 0) {
      appendOrder({ ...base, kind: "weather_got_roll_skip", reason: "sell_unfilled" });
      return "skipped";
    }

    // Orphan guard: do not advance to a new bin on a partial sell.
    if (
      MIN_SELL_FILL_FRAC > 0
      && sell.fillCount + 1e-9 < plan.sellContracts * MIN_SELL_FILL_FRAC
    ) {
      const remaining = Number((plan.sellContracts - sell.fillCount).toFixed(2));
      if (remaining > 0 && prev) {
        cityState.set(city, {
          ...prev,
          contracts: remaining,
          lastActionAt: new Date().toISOString(),
        });
      } else if (remaining <= 0) {
        cityState.delete(city);
      }
      persistState();
      appendOrder({
        ...base,
        kind: "weather_got_roll_skip",
        reason: "sell_partial_orphan_guard",
        fillCount: sell.fillCount,
        want: plan.sellContracts,
        remaining,
      });
      log(
        `orphan guard ${city}: sold ${sell.fillCount}/${plan.sellContracts}; `
        + `staying on ${plan.fromBin} with ${remaining}`,
      );
      return "skipped";
    }

    // Size buy from actual sell proceeds; re-walk ask ladder when slip enabled.
    const proceeds = sell.fillCount * sellAvg;
    let buyCount = Math.floor(proceeds / plan.buyLimit);
    let buyLimit = plan.buyLimit;
    let buyWalkMeta: Record<string, unknown> | undefined;
    if (ROLL_WALK_SLIP > 0 && client) {
      try {
        const buyLevels = yesAskLevelsFromBook(
          await client.getOrderbook(plan.toTicker, 20),
        );
        const buyWalk = planBuyWalkForProceeds({
          proceedsUsd: proceeds,
          askLevels: buyLevels,
          maxSlip: ROLL_WALK_SLIP,
          minAsk: MIN_ASK,
          maxAsk: MAX_ASK,
        });
        if (buyWalk.contracts >= 1) {
          buyCount = buyWalk.contracts;
          buyLimit = buyWalk.limit;
          buyWalkMeta = {
            tob: buyWalk.tob,
            vwap: buyWalk.vwap,
            levelsTaken: buyWalk.levelsTaken,
          };
        }
      } catch (err) {
        log(`buy walk refresh failed ${city}: ${(err as Error).message}`);
      }
    }

    // Cliff guard at execution time (after actual sell).
    if (
      MIN_BUY_TO_SELL_RATIO > 0
      && buyCount + 1e-9 < sell.fillCount * MIN_BUY_TO_SELL_RATIO
    ) {
      // Sold fully — flat rather than buying a cliff stub.
      cityState.delete(city);
      persistState();
      appendOrder({
        ...base,
        kind: "weather_got_roll_skip",
        reason: "roll_cliff_after_sell",
        sellFill: sell.fillCount,
        buyCount,
      });
      log(
        `cliff guard ${city}: buy ${buyCount} < ${MIN_BUY_TO_SELL_RATIO}× sold ${sell.fillCount}; flat`,
      );
      return "skipped";
    }

    if (buyCount < 1) {
      cityState.delete(city);
      persistState();
      appendOrder({ ...base, kind: "weather_got_roll_skip", reason: "buy_size_zero_after_sell" });
      return "skipped";
    }
    const buy = await place("bid", plan.toTicker, buyCount, buyLimit);
    const buyAvg = avgFillPrice(buy.resp, buyLimit);
    appendOrder({
      ...base,
      kind: "weather_got_roll_order",
      leg: "buy",
      side: "bid",
      ticker: plan.toTicker,
      count: buyCount,
      price: buyLimit,
      fillCount: buy.fillCount,
      avgFill: buyAvg,
      buyWalk: buyWalkMeta,
      resp: buy.resp,
      rttMs: buy.rttMs,
      spentTodayUsd,
    });
    if (buy.fillCount > 0) {
      cityState.set(city, {
        day,
        bin: plan.toBin,
        ticker: plan.toTicker,
        contracts: buy.fillCount,
        avgEntry: buyAvg,
        openedAt: prev?.openedAt ?? new Date().toISOString(),
        lastActionAt: new Date().toISOString(),
        rollsToday: (prev?.day === day ? (prev.rollsToday ?? 0) : 0) + 1,
      });
    } else {
      // Sold but failed to rebuy — flat.
      cityState.delete(city);
    }
    persistState();
    return buy.fillCount > 0 ? "fired" : "skipped";
  } catch (err) {
    appendOrder({
      ...base,
      kind: "weather_got_roll_order_error",
      error: (err as Error).message.slice(0, 400),
    });
    log(`exec error ${city}: ${(err as Error).message}`);
    return "skipped";
  } finally {
    busy = false;
  }
}

/** Test helper */
export function resetGotRollExecForTests(): void {
  spentTodayUsd = 0;
  spentDayKey = "";
  cityState.clear();
  busy = false;
  client = null;
}
