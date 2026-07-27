#!/usr/bin/env tsx
/**
 * Paper market-maker for Kalshi hourly temperature (CHI / LA, optional NYC).
 *
 * Strategy (Brett Harrison components + desk rules):
 *   1. Market data  — Kalshi WS books + METAR/SPECI + optional Synoptic/NWS/TWC
 *   2. Fair value   — start from last :51 METAR for the next hour; correct μ on
 *                     trusted reading changes (Synoptic if leading, else SPECI/NWS)
 *   3. Placement    — two-sided paper quotes around pYes; inventory skew;
 *                     widen in last 10m; pull in last 3m
 *   4. Connectivity — Kalshi WS (books); orders stay paper unless LIVE+post_only
 *   5. Offline      — JSONL quote/fair audit for later parameter fits
 *
 * Env:
 *   WEATHER_MM_CITIES           CHI,LAX (default)
 *   WEATHER_MM_SIGMA            default 0.7
 *   WEATHER_MM_BIAS             default 0
 *   WEATHER_MM_HALF_SPREAD      default 0.02
 *   WEATHER_MM_WIDEN_HALF       default 0.08
 *   WEATHER_MM_LAST_MIN         default 10
 *   WEATHER_MM_PULL_MIN         default 3
 *   WEATHER_MM_SIZE             default 10
 *   WEATHER_MM_USE_SYNOPTIC     1 to follow Synoptic when token present (default 1)
 *   WEATHER_MM_SYNOPTIC_LEAD    auto|on|off — require lead verdict (default auto)
 *   WEATHER_MM_OBS_MS           default 10000
 *   WEATHER_MM_QUOTE_MS         default 2000
 *   WEATHER_MM_LIVE             1 = post_only GTC (default 0 = paper only)
 *   SYNOPTIC_TOKEN              Synoptic Data API token
 *   KALSHI_API_KEY_ID / KALSHI_API_PRIVATE_KEY_PATH  required for WS
 *
 * Run: npm run weather:mm-paper
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import {
  bookQuotes,
  KalshiClient,
  subscribeOrderbook,
  type KalshiMarket,
  type KalshiWsMessage,
} from "./lib/kalshi-client.js";
import { KalshiBookStore } from "./lib/kalshi-ws-books.js";
import {
  decisiveMetarEt,
  etParts,
  minutesToClose,
  parseCityList,
  type WeatherCity,
} from "./lib/weather-cities.js";
import {
  correctFairOnReadingChange,
  fairFromReading,
  type FairValueState,
} from "./lib/weather-fair-value.js";
import {
  buildLadderQuotes,
  type StrikeQuote,
} from "./lib/weather-mm-quotes.js";
import {
  fetchMetars,
  fetchNwsLatest,
  fetchSynopticLatest,
  lastMetar51,
  metarEtHourMinute,
  synopticToken,
  twcKey,
  fetchTwc,
  type WeatherObs,
} from "./lib/weather-obs.js";

const CITIES = parseCityList(process.env.WEATHER_MM_CITIES);
const SIGMA = Math.max(0.05, Number(process.env.WEATHER_MM_SIGMA ?? 0.7));
const BIAS = Number(process.env.WEATHER_MM_BIAS ?? 0);
const HALF = Math.max(0.01, Number(process.env.WEATHER_MM_HALF_SPREAD ?? 0.02));
const WIDEN_HALF = Math.max(HALF, Number(process.env.WEATHER_MM_WIDEN_HALF ?? 0.08));
const LAST_MIN = Math.max(1, Number(process.env.WEATHER_MM_LAST_MIN ?? 10));
const PULL_MIN = Math.max(0, Number(process.env.WEATHER_MM_PULL_MIN ?? 3));
const SIZE = Math.max(1, Math.floor(Number(process.env.WEATHER_MM_SIZE ?? 10)));
const OBS_MS = Math.max(3_000, Number(process.env.WEATHER_MM_OBS_MS ?? 10_000));
const QUOTE_MS = Math.max(500, Number(process.env.WEATHER_MM_QUOTE_MS ?? 2_000));
const USE_SYN = !/^(0|false|no|off)$/i.test(process.env.WEATHER_MM_USE_SYNOPTIC ?? "1");
const SYN_LEAD_MODE = (process.env.WEATHER_MM_SYNOPTIC_LEAD ?? "auto").toLowerCase();
const LIVE = /^(1|true|yes)$/i.test(process.env.WEATHER_MM_LIVE ?? "");

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);

type Strike = { ticker: string; floor: number; subtitle: string; closeTime?: string };

type CityState = {
  city: WeatherCity;
  eventTicker: string;
  strikes: Strike[];
  fair: FairValueState | null;
  followSynoptic: boolean;
  metarSeen: Set<string>;
  lastQuoteSig: string;
  inventory: Record<string, number>;
};

const books = new KalshiBookStore();
const client = new KalshiClient();
const states = new Map<string, CityState>();
let socket: WebSocket | null = null;
let subId = 1;
let generation = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function log(msg: string): void {
  console.log(`[weather-mm ${new Date().toISOString()}] ${msg}`);
}

function audit(row: Record<string, unknown>): void {
  const dir = join(DATA_DIR, "weather");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { y, m, day } = etParts();
  const path = join(dir, `weather-mm-${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}.jsonl`);
  appendFileSync(path, `${JSON.stringify({ ...row, recv: new Date().toISOString() })}\n`);
}

function strikeOf(m: KalshiMarket): number | null {
  if (typeof m.floor_strike === "number") return m.floor_strike;
  if (typeof m.cap_strike === "number") return m.cap_strike;
  return null;
}

async function discoverCity(city: WeatherCity): Promise<CityState> {
  const { stamp, hour } = etParts();
  const candidates: string[] = [];
  for (let h = hour; h <= Math.min(23, hour + 2); h++) {
    candidates.push(`${city.eventPrefix}-${stamp}${String(h).padStart(2, "0")}`);
  }
  if (hour >= 22) {
    const tmr = new Date(Date.now() + 24 * 3600 * 1000);
    const tp = etParts(tmr);
    for (let h = 0; h <= 1; h++) {
      candidates.push(`${city.eventPrefix}-${tp.stamp}${String(h).padStart(2, "0")}`);
    }
  }

  let eventTicker = "";
  for (const et of candidates) {
    try {
      const { markets } = await client.listMarkets({ event_ticker: et, limit: 50 });
      const active = (markets ?? []).filter((m) => {
        const st = String(m.status ?? "");
        return st === "active" || st === "open";
      });
      if (active.length) {
        eventTicker = et;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!eventTicker) throw new Error(`No active ${city.series} event near ${stamp}${hour}`);

  const { markets } = await client.listMarkets({ event_ticker: eventTicker, limit: 50 });
  const strikes: Strike[] = [];
  for (const m of markets ?? []) {
    const floor = strikeOf(m);
    if (floor == null) continue;
    const r = m as KalshiMarket & { close_time?: string };
    strikes.push({
      ticker: m.ticker,
      floor,
      subtitle: String(m.yes_sub_title ?? m.subtitle ?? ""),
      closeTime: r.close_time,
    });
  }
  strikes.sort((a, b) => a.floor - b.floor);

  if (!strikes.length) throw new Error(`No strikes on ${eventTicker}`);

  const followSynoptic =
    USE_SYN &&
    Boolean(synopticToken()) &&
    (SYN_LEAD_MODE === "on" || SYN_LEAD_MODE === "auto");

  return {
    city,
    eventTicker,
    strikes,
    fair: null,
    followSynoptic,
    metarSeen: new Set(),
    lastQuoteSig: "",
    inventory: {},
  };
}

function connectWs(): void {
  const tickers = [...states.values()].flatMap((s) => s.strikes.map((x) => x.ticker));
  if (!tickers.length) return;
  const gen = ++generation;
  try {
    socket = client.openSocket();
  } catch (err) {
    log(`WS open failed: ${(err as Error).message}`);
    scheduleReconnect();
    return;
  }
  socket.on("open", () => {
    if (gen !== generation) return;
    log(`WS open — ${tickers.length} strikes`);
    // subscribe in chunks
    for (let i = 0; i < tickers.length; i += 40) {
      subscribeOrderbook(socket!, tickers.slice(i, i + 40), subId++);
    }
  });
  socket.on("message", (raw) => {
    if (gen !== generation) return;
    let msg: KalshiWsMessage;
    try {
      msg = JSON.parse(String(raw)) as KalshiWsMessage;
    } catch {
      return;
    }
    if (msg.type !== "orderbook_snapshot" && msg.type !== "orderbook_delta") return;
    const body = (msg as { msg: Record<string, unknown> }).msg;
    const ticker = String(body.market_ticker ?? "");
    if (!ticker) return;
    if (msg.type === "orderbook_snapshot") books.applySnapshot(ticker, body);
    else books.applyDelta(ticker, body);
  });
  socket.on("close", () => {
    if (gen !== generation) return;
    log("WS close");
    scheduleReconnect();
  });
  socket.on("error", (err) => log(`WS error: ${(err as Error).message}`));
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 3_000);
}

function applyReading(
  st: CityState,
  readingF: number,
  source: FairValueState["source"],
  extra?: Record<string, unknown>,
): void {
  if (!st.fair) {
    st.fair = fairFromReading({
      readingF,
      bias: BIAS,
      sigma: SIGMA,
      source,
      anchor51F: source === "metar51" ? readingF : null,
    });
    log(`${st.city.id} fair INIT μ=${st.fair.mu.toFixed(2)} src=${source}`);
    audit({ type: "fair_init", city: st.city.id, event: st.eventTicker, fair: st.fair, ...extra });
    return;
  }
  if (source === "metar51") {
    // New hour anchor — reset
    st.fair = fairFromReading({
      readingF,
      bias: BIAS,
      sigma: SIGMA,
      source,
      anchor51F: readingF,
    });
    log(`${st.city.id} fair ANCHOR :51 μ=${st.fair.mu.toFixed(2)}`);
    audit({ type: "fair_anchor51", city: st.city.id, event: st.eventTicker, fair: st.fair, ...extra });
    return;
  }
  const { state, changed } = correctFairOnReadingChange(st.fair, readingF, source, {
    bias: BIAS,
    sigma: SIGMA,
  });
  if (!changed) return;
  st.fair = state;
  log(`${st.city.id} fair CORRECT μ=${st.fair.mu.toFixed(2)} src=${source} (was reading ${extra?.prev ?? "?"})`);
  audit({ type: "fair_correct", city: st.city.id, event: st.eventTicker, fair: st.fair, ...extra });
}

async function bootstrapFair(st: CityState): Promise<void> {
  try {
    const metars = await fetchMetars(st.city.icao, 8);
    for (const m of metars) {
      if (m.raw) st.metarSeen.add(m.raw.slice(0, 64));
    }
    const anchor = lastMetar51(metars);
    if (anchor) {
      applyReading(st, anchor.tempF, "metar51", { raw: anchor.raw?.slice(0, 140) });
    } else if (metars.length) {
      const last = metars[metars.length - 1]!;
      applyReading(st, last.tempF, last.source === "speci" ? "speci" : "nws", {
        note: "no :51 in window — using latest METAR/SPECI",
        raw: last.raw?.slice(0, 140),
      });
    }
  } catch (err) {
    log(`${st.city.id} METAR bootstrap failed: ${(err as Error).message.slice(0, 120)}`);
    audit({ type: "error", tag: "metar_bootstrap", city: st.city.id, err: (err as Error).message.slice(0, 160) });
  }

  // Fallbacks when METAR is down or empty
  if (!st.fair) {
    try {
      const nws = await fetchNwsLatest(st.city.icao);
      if (nws) applyReading(st, nws.tempF, "nws", { note: "bootstrap fallback" });
    } catch (err) {
      log(`${st.city.id} NWS bootstrap failed: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // Optional immediate Synoptic correction if enabled
  if (st.followSynoptic) {
    try {
      const syn = await fetchSynopticLatest(st.city.icao, synopticToken()!);
      if (syn) applyReading(st, syn.tempF, "synoptic", { synObs: syn.obsTimeMs });
    } catch (err) {
      log(`${st.city.id} synoptic bootstrap: ${(err as Error).message.slice(0, 100)}`);
      st.followSynoptic = SYN_LEAD_MODE === "on"; // auto → disable on hard fail
    }
  }
}

async function pollObs(st: CityState): Promise<void> {
  const dec = decisiveMetarEt(st.eventTicker);
  try {
    const metars = await fetchMetars(st.city.icao, 3);
    for (const m of metars) {
      const key = (m.raw ?? "").slice(0, 64);
      if (!key || st.metarSeen.has(key)) continue;
      st.metarSeen.add(key);
      const et = metarEtHourMinute(m.raw ?? "", m.meta?.etHour != null ? undefined : m.obsTimeMs);
      const etHour = (m.meta?.etHour as number | null | undefined) ?? et?.hour;
      const etMinute = (m.meta?.etMinute as number | null | undefined) ?? et?.minute;
      const isDecisive51 = m.isMetar51 && etHour === dec.hour;
      audit({
        type: "obs_metar",
        city: st.city.id,
        event: st.eventTicker,
        tempF: m.tempF,
        source: m.source,
        is51: m.isMetar51,
        isDecisive51,
        etHour,
        etMinute,
        raw: m.raw?.slice(0, 160),
      });
      if (isDecisive51) {
        applyReading(st, m.tempF, "metar51", { raw: m.raw?.slice(0, 140), label: dec.label });
      } else if (m.source === "speci" || m.isMetar51) {
        // Mid-hour SPECI or non-decisive :51 — correct true price
        applyReading(st, m.tempF, "speci", { raw: m.raw?.slice(0, 140) });
      }
    }
  } catch (err) {
    audit({ type: "error", tag: "metar", city: st.city.id, err: (err as Error).message.slice(0, 160) });
  }

  if (st.followSynoptic && synopticToken()) {
    try {
      const syn = await fetchSynopticLatest(st.city.icao, synopticToken()!);
      if (syn) {
        audit({ type: "obs_synoptic", city: st.city.id, tempF: syn.tempF, obs: syn.obsTimeMs });
        applyReading(st, syn.tempF, "synoptic", { synObs: syn.obsTimeMs });
      }
    } catch (err) {
      audit({ type: "error", tag: "synoptic", city: st.city.id, err: (err as Error).message.slice(0, 160) });
    }
  } else {
    // Public mid-hour proxy when Synoptic off
    try {
      const nws = await fetchNwsLatest(st.city.icao);
      if (nws) {
        audit({ type: "obs_nws", city: st.city.id, tempF: nws.tempF, obs: nws.obsTimeMs });
        applyReading(st, nws.tempF, "nws", { nwsObs: nws.obsTimeMs });
      }
    } catch {
      /* optional */
    }
  }

  try {
    const twc = await fetchTwc(st.city.icao, twcKey());
    if (twc) {
      audit({ type: "obs_twc", city: st.city.id, tempF: twc.tempF, meta: twc.meta });
      // TWC is settlement-named but sticky mid-hour — log only, do not drive μ
    }
  } catch {
    /* optional */
  }
}

function emitQuotes(st: CityState): void {
  if (!st.fair) return;
  const close = st.strikes[0]?.closeTime;
  const mtc = minutesToClose(close);
  const quotes = buildLadderQuotes({
    strikes: st.strikes,
    fair: st.fair,
    inventoryByTicker: st.inventory,
    minutesToClose: mtc,
    params: {
      halfSpread: HALF,
      widenHalfSpread: WIDEN_HALF,
      lastMinutes: LAST_MIN,
      pullMinutes: PULL_MIN,
      size: SIZE,
    },
  });

  const sig = JSON.stringify(
    quotes.map((q) => [q.ticker, q.mode, q.yesBid, q.yesAsk, q.size]),
  );
  if (sig === st.lastQuoteSig) return;
  st.lastQuoteSig = sig;

  const mode = quotes[0]?.mode ?? "normal";
  const liveMids = quotes
    .slice(0, 5)
    .map((q) => {
      const book = books.getBook(q.ticker);
      const bq = book ? bookQuotes(book) : null;
      const label = `${Math.round(q.floor + 0.01)}°`;
      return `${label}:fair=${q.pYes.toFixed(2)} q=${q.yesBid?.toFixed(2) ?? "—"}/${q.yesAsk?.toFixed(2) ?? "—"} mkt=${bq ? `${bq.yesBid.toFixed(2)}/${bq.yesAsk.toFixed(2)}` : "—"}`;
    })
    .join("  ");

  log(
    `${st.city.id} ${st.eventTicker} mode=${mode} mtc=${mtc != null ? mtc.toFixed(1) : "?"}μ=${st.fair.mu.toFixed(2)}(${st.fair.source})  ${liveMids}`,
  );
  audit({
    type: "quotes",
    city: st.city.id,
    event: st.eventTicker,
    mode,
    minutesToClose: mtc,
    fair: st.fair,
    live: LIVE,
    quotes: quotes.map(slimQuote),
  });

  if (LIVE) {
    void placeLiveQuotes(st, quotes);
  }
}

function slimQuote(q: StrikeQuote): Record<string, unknown> {
  return {
    tk: q.ticker,
    floor: q.floor,
    pYes: Number(q.pYes.toFixed(4)),
    mid: Number(q.mid.toFixed(4)),
    bid: q.yesBid,
    ask: q.yesAsk,
    size: q.size,
    mode: q.mode,
    reason: q.reason,
  };
}

async function placeLiveQuotes(st: CityState, quotes: StrikeQuote[]): Promise<void> {
  // Conservative: only post_only on non-pull modes; cancel semantics left to exchange TIF replace.
  for (const q of quotes) {
    if (q.mode === "pull" || q.yesBid == null || q.yesAsk == null) continue;
    for (const side of [
      { side: "bid" as const, price: q.yesBid },
      { side: "ask" as const, price: q.yesAsk },
    ]) {
      try {
        const resp = await client.createOrderV2({
          ticker: q.ticker,
          side: side.side,
          count: q.size,
          price: side.price,
          time_in_force: "good_till_canceled",
          post_only: true,
        });
        audit({
          type: "live_order",
          city: st.city.id,
          ticker: q.ticker,
          side: side.side,
          price: side.price,
          size: q.size,
          resp,
        });
      } catch (err) {
        audit({
          type: "live_order_error",
          city: st.city.id,
          ticker: q.ticker,
          side: side.side,
          err: (err as Error).message.slice(0, 200),
        });
      }
    }
  }
}

async function main(): Promise<void> {
  if (!CITIES.length) throw new Error("No WEATHER_MM_CITIES");
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  log(
    `start cities=${CITIES.map((c) => c.id).join(",")} live=${LIVE ? "ON" : "paper"}` +
      ` synoptic=${USE_SYN && synopticToken() ? "token" : "off"}` +
      ` last=${LAST_MIN}m pull=${PULL_MIN}m half=${HALF}/${WIDEN_HALF}`,
  );
  audit({
    type: "milestone",
    msg: "START",
    cities: CITIES.map((c) => c.id),
    live: LIVE,
    synoptic: Boolean(synopticToken()) && USE_SYN,
    params: { SIGMA, BIAS, HALF, WIDEN_HALF, LAST_MIN, PULL_MIN, SIZE },
  });

  for (const city of CITIES) {
    const st = await discoverCity(city);
    states.set(city.id, st);
    const dec = decisiveMetarEt(st.eventTicker);
    log(
      `${city.id}: event=${st.eventTicker} strikes=${st.strikes.length}` +
        ` decisive=${dec.label} followSynoptic=${st.followSynoptic}`,
    );
    await bootstrapFair(st);
  }

  connectWs();

  for (const st of states.values()) {
    void pollObs(st);
  }

  setInterval(() => {
    for (const st of states.values()) void pollObs(st);
  }, OBS_MS);

  setInterval(() => {
    for (const st of states.values()) emitQuotes(st);
  }, QUOTE_MS);

  setInterval(() => {
    audit({
      type: "heartbeat",
      ws: socket?.readyState === WebSocket.OPEN ? "open" : "down",
      cities: [...states.values()].map((s) => ({
        id: s.city.id,
        event: s.eventTicker,
        mu: s.fair?.mu ?? null,
        src: s.fair?.source ?? null,
        followSyn: s.followSynoptic,
      })),
    });
  }, 30_000);

  process.on("SIGTERM", () => {
    audit({ type: "milestone", msg: "SIGTERM" });
    process.exit(0);
  });
  process.on("SIGINT", () => {
    audit({ type: "milestone", msg: "SIGINT" });
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
