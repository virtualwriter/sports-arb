#!/usr/bin/env tsx
/**
 * Multi-city Kalshi hourly weather recorder (CHI / LA / NYC).
 *
 * Records WS books, METAR/SPECI, optional Synoptic, NWS, and TWC to JSONL.
 * Companion to weather-hourly-mm-paper.ts (quotes) and weather-synoptic-lead-test.ts.
 *
 * Env:
 *   WEATHER_MM_CITIES, WEATHER_KALSHI_DEPTH, WEATHER_KALSHI_* poll intervals
 *   SYNOPTIC_TOKEN, TWC_API_KEY, KALSHI_API_KEY_ID / KALSHI_API_PRIVATE_KEY_PATH
 *
 * Run: npm run weather:city-tracker
 */

import { existsSync, mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import {
  bookQuotes,
  KalshiClient,
  subscribeOrderbook,
  type KalshiMarket,
  type KalshiWsMessage,
} from "./lib/kalshi-client.js";
import { KalshiBookStore } from "./lib/kalshi-ws-books.js";
import { etParts, parseCityList, type WeatherCity } from "./lib/weather-cities.js";
import {
  fetchMetars,
  fetchNwsLatest,
  fetchSynopticLatest,
  fetchTwc,
  synopticToken,
  twcKey,
} from "./lib/weather-obs.js";

const CITIES = parseCityList(process.env.WEATHER_MM_CITIES);
const DEPTH = Math.max(1, Number(process.env.WEATHER_KALSHI_DEPTH ?? 10));
const TOB_HZ = Math.max(0, Number(process.env.WEATHER_KALSHI_TOB_HZ ?? 1));
const DISCOVER_MS = Math.max(30_000, Number(process.env.WEATHER_KALSHI_DISCOVER_MS ?? 120_000));
const METAR_MS = Math.max(5_000, Number(process.env.WEATHER_KALSHI_METAR_MS ?? 15_000));
const SYN_MS = Math.max(5_000, Number(process.env.WEATHER_KALSHI_SYNOPTIC_MS ?? 15_000));
const TWC_MS = Math.max(10_000, Number(process.env.WEATHER_KALSHI_TWC_MS ?? 30_000));
const LOOKAHEAD_H = Math.max(0, Number(process.env.WEATHER_KALSHI_LOOKAHEAD_H ?? 4));

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);

type Tracked = {
  ticker: string;
  eventTicker: string;
  city: string;
  series: string;
  strike: number | null;
};

function log(msg: string): void {
  console.log(`[weather-tracker ${new Date().toISOString()}] ${msg}`);
}

function dayFile(): string {
  const { y, m, day } = etParts();
  return join(
    DATA_DIR,
    "weather",
    `weather-kalshi-cities-${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}.jsonl`,
  );
}

class JsonlWriter {
  private stream: WriteStream | null = null;
  private path = "";
  write(row: Record<string, unknown>): void {
    const target = dayFile();
    if (this.path !== target || !this.stream) {
      if (this.stream) this.stream.end();
      const dir = dirname(target);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.path = target;
      this.stream = createWriteStream(target, { flags: "a" });
      log(`writing ${target}`);
    }
    this.stream!.write(`${JSON.stringify({ ...row, recv: new Date().toISOString() })}\n`);
  }
}

const out = new JsonlWriter();
const books = new KalshiBookStore();
const tracked = new Map<string, Tracked>();
const metarSeen = new Map<string, Set<string>>();
let socket: WebSocket | null = null;
let subId = 1;
let generation = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastBookEmit = new Map<string, string>();

function strikeOf(m: KalshiMarket): number | null {
  if (typeof m.floor_strike === "number") return m.floor_strike;
  if (typeof m.cap_strike === "number") return m.cap_strike;
  return null;
}

async function discover(client: KalshiClient): Promise<void> {
  const { stamp, hour } = etParts();
  const next = new Map<string, Tracked>();
  for (const city of CITIES) {
    for (let h = Math.max(0, hour - 1); h <= Math.min(23, hour + LOOKAHEAD_H); h++) {
      const et = `${city.eventPrefix}-${stamp}${String(h).padStart(2, "0")}`;
      try {
        const { markets } = await client.listMarkets({ event_ticker: et, limit: 50 });
        for (const m of markets ?? []) {
          next.set(m.ticker, {
            ticker: m.ticker,
            eventTicker: et,
            city: city.id,
            series: city.series,
            strike: strikeOf(m),
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  tracked.clear();
  for (const [k, v] of next) tracked.set(k, v);
  out.write({ type: "discover", n: tracked.size, cities: CITIES.map((c) => c.id) });
  log(`discover n=${tracked.size}`);
  connectWs(client);
}

function connectWs(client: KalshiClient): void {
  const tickers = [...tracked.keys()];
  if (!tickers.length) return;
  const gen = ++generation;
  try {
    if (socket) {
      try {
        socket.close();
      } catch {
        /* */
      }
    }
    socket = client.openSocket();
  } catch (err) {
    log(`WS fail: ${(err as Error).message}`);
    scheduleReconnect(client);
    return;
  }
  socket.on("open", () => {
    if (gen !== generation) return;
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
    emitBook(ticker, msg.type === "orderbook_snapshot" ? "snapshot" : "delta");
  });
  socket.on("close", () => {
    if (gen !== generation) return;
    scheduleReconnect(client);
  });
  socket.on("error", (err) => log(`WS error: ${(err as Error).message}`));
}

function scheduleReconnect(client: KalshiClient): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs(client);
  }, 3_000);
}

function emitBook(ticker: string, reason: string): void {
  const book = books.getBook(ticker);
  if (!book) return;
  const q = bookQuotes(book);
  const meta = tracked.get(ticker);
  if (reason === "hz") {
    const key = JSON.stringify([q.yesBid, q.yesAsk, q.yesBidSize, q.yesAskSize]);
    if (lastBookEmit.get(ticker) === key) return;
    lastBookEmit.set(ticker, key);
  }
  out.write({
    type: "book",
    reason,
    tk: ticker,
    city: meta?.city ?? null,
    event: meta?.eventTicker ?? null,
    series: meta?.series ?? null,
    strike: meta?.strike ?? null,
    yesBid: q.yesBid,
    yesAsk: q.yesAsk,
    yesBidSz: q.yesBidSize,
    yesAskSz: q.yesAskSize,
    depthYes: book.yesBids.slice(0, DEPTH),
    depthNo: book.noBids.slice(0, DEPTH),
  });
}

async function pollCityObs(city: WeatherCity): Promise<void> {
  let seen = metarSeen.get(city.id);
  if (!seen) {
    seen = new Set();
    metarSeen.set(city.id, seen);
  }
  try {
    const metars = await fetchMetars(city.icao, 3);
    for (const m of metars) {
      const key = (m.raw ?? "").slice(0, 64);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.write({
        type: "metar",
        city: city.id,
        icao: city.icao,
        tempF: m.tempF,
        source: m.source,
        is51: m.isMetar51,
        obsTimeMs: m.obsTimeMs,
        receiptMs: m.recvMs,
        raw: m.raw,
        meta: m.meta,
      });
    }
  } catch (err) {
    out.write({ type: "error", tag: "metar", city: city.id, err: (err as Error).message.slice(0, 160) });
  }

  const token = synopticToken();
  if (token) {
    try {
      const s = await fetchSynopticLatest(city.icao, token);
      if (s) {
        out.write({
          type: "synoptic",
          city: city.id,
          icao: city.icao,
          tempF: s.tempF,
          obsTimeMs: s.obsTimeMs,
        });
      }
    } catch (err) {
      out.write({ type: "error", tag: "synoptic", city: city.id, err: (err as Error).message.slice(0, 160) });
    }
  }

  try {
    const n = await fetchNwsLatest(city.icao);
    if (n) {
      out.write({ type: "nws", city: city.id, icao: city.icao, tempF: n.tempF, obsTimeMs: n.obsTimeMs });
    }
  } catch {
    /* */
  }

  try {
    const t = await fetchTwc(city.icao, twcKey());
    if (t) {
      out.write({ type: "twc", city: city.id, icao: city.icao, tempF: t.tempF, meta: t.meta });
    }
  } catch {
    /* */
  }
}

async function main(): Promise<void> {
  if (!CITIES.length) throw new Error("No cities");
  const client = new KalshiClient();
  out.write({ type: "milestone", msg: "START", cities: CITIES.map((c) => c.id) });
  log(`start ${CITIES.map((c) => `${c.id}:${c.icao}`).join(", ")}`);
  await discover(client);
  for (const c of CITIES) await pollCityObs(c);

  setInterval(() => void discover(client), DISCOVER_MS);
  setInterval(() => {
    for (const c of CITIES) void pollCityObs(c);
  }, METAR_MS);
  if (synopticToken()) {
    setInterval(() => {
      for (const c of CITIES) void pollCityObs(c);
    }, SYN_MS);
  }
  setInterval(() => {
    /* TWC cadence covered in pollCityObs; keep separate light heartbeat */
  }, TWC_MS);
  if (TOB_HZ > 0) {
    setInterval(() => {
      for (const tk of tracked.keys()) emitBook(tk, "hz");
    }, Math.round(1000 / TOB_HZ));
  }
  setInterval(() => {
    out.write({
      type: "heartbeat",
      nTracked: tracked.size,
      ws: socket?.readyState === WebSocket.OPEN ? "open" : "down",
    });
  }, 30_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
