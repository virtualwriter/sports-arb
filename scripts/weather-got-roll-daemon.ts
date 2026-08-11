#!/usr/bin/env tsx
/**
 * Follow GOT diurnal tapes and (optionally) place $STAKE YES on each city's
 * current GOT bin on Kalshi. Rolls on GOT bin changes.
 *
 * Shadow by default. Real money requires:
 *   WEATHER_GOT_ROLL_LIVE=1
 *   Kalshi API credentials in env
 *
 * Usage:
 *   npx tsx scripts/weather-got-roll-daemon.ts
 *   WEATHER_GOT_ROLL_LIVE=1 npx tsx scripts/weather-got-roll-daemon.ts
 */

import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { bookQuotes, KalshiClient } from "./lib/kalshi-client.js";
import {
  clearHeldIfDay,
  configureGotRollExec,
  executeGotRollPlan,
  getHeld,
  gotRollExecLabel,
  loadGotRollState,
  MAX_ASK,
  MIN_ASK,
  ROLL_WALK_SLIP,
  STAKE_USD,
  WEATHER_GOT_ROLL_LIVE,
} from "./lib/weather-got-roll-exec.js";
import {
  eventTickerFor,
  marketsFromKalshi,
  planGotRoll,
  yesAskLevelsFromBook,
  yesBidLevelsFromBook,
  type BookLevel,
  type GotBinMarket,
} from "./lib/weather-got-roll.js";

const BOOK_DEPTH = Math.max(5, Number(process.env.WEATHER_GOT_ROLL_BOOK_DEPTH ?? 20));

const ROOT = resolve(process.cwd());
const POLL_MS = Math.max(500, Number(process.env.WEATHER_GOT_ROLL_POLL_MS ?? 2000));
/** Refuse to trade city-days before this stamp (YYMONDD). Empty = no floor. */
const START_DAY = (process.env.WEATHER_GOT_ROLL_START_DAY ?? "").toUpperCase();

type CityCfg = {
  key: string;
  fileKey: string;
  series: string;
  localTz: string;
};

const CITIES: CityCfg[] = [
  { key: "chicago", fileKey: "chi", series: "KXHIGHCHI", localTz: "America/Chicago" },
  { key: "nyc", fileKey: "nyc", series: "KXHIGHNY", localTz: "America/New_York" },
  { key: "miami", fileKey: "miami", series: "KXHIGHMIA", localTz: "America/New_York" },
  { key: "austin", fileKey: "austin", series: "KXHIGHAUS", localTz: "America/Chicago" },
  { key: "la", fileKey: "la", series: "KXHIGHLAX", localTz: "America/Los_Angeles" },
];

const allow = new Set(
  (process.env.WEATHER_GOT_ROLL_CITIES ?? "chicago,nyc,miami,austin,la")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

type CityRuntime = {
  cfg: CityCfg;
  day: string;
  offset: number;
  inode: number | null;
  markets: GotBinMarket[];
  marketsLoadedAt: number;
  lastBin: string | null;
};

function log(msg: string): void {
  console.log(`[weather-got-roll-daemon ${new Date().toISOString()}] ${msg}`);
}

function localDay(tz: string, now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "2-digit",
    month: "short",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const yy = parts.find((p) => p.type === "year")?.value ?? "26";
  const mon = (parts.find((p) => p.type === "month")?.value ?? "JAN").toUpperCase();
  const dd = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${yy}${mon}${dd.padStart(2, "0")}`;
}

function gotTapePath(fileKey: string, day: string): string {
  return join(ROOT, ".tmp", `${fileKey}-diurnal-got-${day.toLowerCase()}-monitor.jsonl`);
}

async function refreshMarkets(
  client: KalshiClient,
  rt: CityRuntime,
): Promise<void> {
  const eventTicker = eventTickerFor(rt.cfg.series, rt.day);
  const event = await client.getEvent(eventTicker, true);
  const markets = marketsFromKalshi(event?.markets ?? []);
  rt.markets = markets;
  rt.marketsLoadedAt = Date.now();
  log(`${rt.cfg.key} markets ${markets.length} for ${eventTicker}`);
}

async function handlePrediction(
  client: KalshiClient,
  rt: CityRuntime,
  row: Record<string, unknown>,
): Promise<void> {
  const bin = typeof row.bin === "string" ? row.bin : null;
  if (!bin) return;
  if (START_DAY && rt.day < START_DAY) {
    return;
  }
  clearHeldIfDay(rt.cfg.key, rt.day);
  if (Date.now() - rt.marketsLoadedAt > 5 * 60_000 || rt.markets.length === 0) {
    await refreshMarkets(client, rt);
  }
  const held = getHeld(rt.cfg.key);
  // Same bin we already acted on this process — still re-check held for restarts.
  if (rt.lastBin === bin && held?.bin === bin) return;

  const target = rt.markets.find((m) => m.label === bin);
  if (!target) {
    log(`${rt.cfg.key} skip bin=${bin} not in strip`);
    rt.lastBin = bin;
    return;
  }

  let yesAsk: number | null = null;
  let yesBid: number | null = null;
  let newYesAsk: number | null = null;
  let sellBidLevels: BookLevel[] | null = null;
  let buyAskLevels: BookLevel[] | null = null;

  if (!held || held.day !== rt.day || held.contracts <= 0) {
    const q = bookQuotes(await client.getOrderbook(target.ticker, 5));
    yesAsk = q.yesAsk > 0 ? q.yesAsk : null;
    yesBid = q.yesBid > 0 ? q.yesBid : null;
    const m = (await client.getEvent(eventTickerFor(rt.cfg.series, rt.day), true))
      ?.markets
      ?.find((x) => x.ticker === target.ticker);
    if (yesAsk == null && m?.yes_ask != null) yesAsk = Number(m.yes_ask);
    if (yesBid == null && m?.yes_bid != null) yesBid = Number(m.yes_bid);
  } else if (held.bin !== bin) {
    const sellBook = await client.getOrderbook(held.ticker, BOOK_DEPTH);
    const buyBook = await client.getOrderbook(target.ticker, BOOK_DEPTH);
    const sellQ = bookQuotes(sellBook);
    const buyQ = bookQuotes(buyBook);
    yesBid = sellQ.yesBid > 0 ? sellQ.yesBid : null;
    newYesAsk = buyQ.yesAsk > 0 ? buyQ.yesAsk : null;
    sellBidLevels = yesBidLevelsFromBook(sellBook);
    buyAskLevels = yesAskLevelsFromBook(buyBook);
    const event = await client.getEvent(eventTickerFor(rt.cfg.series, rt.day), true);
    const sellM = event?.markets?.find((x) => x.ticker === held.ticker);
    const buyM = event?.markets?.find((x) => x.ticker === target.ticker);
    if (yesBid == null && sellM?.yes_bid != null) yesBid = Number(sellM.yes_bid);
    if (newYesAsk == null && buyM?.yes_ask != null) newYesAsk = Number(buyM.yes_ask);
  } else {
    rt.lastBin = bin;
    return;
  }

  const plan = planGotRoll({
    bin,
    markets: rt.markets,
    held: getHeld(rt.cfg.key),
    day: rt.day,
    yesAsk,
    yesBid,
    newYesAsk,
    stakeUsd: STAKE_USD,
    minAsk: MIN_ASK,
    maxAsk: MAX_ASK,
    sellBidLevels,
    buyAskLevels,
    rollMaxSlip: ROLL_WALK_SLIP,
  });

  const result = await executeGotRollPlan({
    city: rt.cfg.key,
    day: rt.day,
    plan,
    gotRecv: typeof row.recv === "string" ? row.recv : undefined,
  });
  log(`${rt.cfg.key} bin=${bin} plan=${plan.action} result=${result}`);
  rt.lastBin = bin;
}

function readNewLines(path: string, offset: number): { lines: string[]; offset: number; inode: number } {
  const st = statSync(path);
  const inode = Number(st.ino ?? 0);
  const fd = openSync(path, "r");
  try {
    if (offset > st.size) offset = 0;
    const buf = Buffer.alloc(Math.max(0, st.size - offset));
    if (buf.length) readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    // If file doesn't end with newline, last line may be partial — keep prior offset for incomplete.
    const endsWithNl = text.endsWith("\n") || text.length === 0;
    let newOffset = offset + buf.length;
    if (!endsWithNl && lines.length) {
      const partial = lines.pop()!;
      newOffset -= Buffer.byteLength(partial, "utf8");
    }
    return { lines, offset: newOffset, inode };
  } finally {
    closeSync(fd);
  }
}

async function pollCity(
  client: KalshiClient,
  rt: CityRuntime,
  opts: { trade: boolean } = { trade: true },
): Promise<void> {
  const day = localDay(rt.cfg.localTz);
  if (day !== rt.day) {
    log(`${rt.cfg.key} day roll ${rt.day} -> ${day}`);
    rt.day = day;
    rt.offset = 0;
    rt.inode = null;
    rt.markets = [];
    rt.marketsLoadedAt = 0;
    rt.lastBin = null;
    clearHeldIfDay(rt.cfg.key, day);
  }
  const path = gotTapePath(rt.cfg.fileKey, rt.day);
  if (!existsSync(path)) return;
  const st = statSync(path);
  const inode = Number(st.ino ?? 0);
  if (rt.inode != null && inode !== rt.inode) {
    log(`${rt.cfg.key} got tape inode changed; resync`);
    rt.offset = 0;
  }
  if (st.size < rt.offset) {
    log(`${rt.cfg.key} got tape truncated; resync`);
    rt.offset = 0;
  }
  const { lines, offset, inode: ino } = readNewLines(path, rt.offset);
  rt.offset = offset;
  rt.inode = ino;
  if (!opts.trade) {
    // Seek-only: remember last bin so we don't re-fire history after catch-up.
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.type === "prediction" && typeof row.bin === "string") {
          rt.lastBin = row.bin;
        }
      } catch {
        /* ignore */
      }
    }
    return;
  }
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "prediction" || row.stream !== "diurnal_got") continue;
    if (typeof row.bin !== "string") continue;
    await handlePrediction(client, rt, row);
  }
}

async function main(): Promise<void> {
  const cities = CITIES.filter((c) => allow.has(c.key) || allow.has(c.fileKey));
  if (!cities.length) {
    throw new Error("no cities selected");
  }
  loadGotRollState();
  const client = new KalshiClient(
    WEATHER_GOT_ROLL_LIVE ? undefined : { unauthenticated: !process.env.KALSHI_API_KEY_ID },
  );
  configureGotRollExec({ client });
  log(`start ${gotRollExecLabel()} cities=${cities.map((c) => c.key).join(",")}`);
  log(`startDay=${START_DAY || "—"} pollMs=${POLL_MS} (no local-hour gate; first GOT pred of day)`);

  const runtimes: CityRuntime[] = cities.map((cfg) => ({
    cfg,
    day: localDay(cfg.localTz),
    offset: 0,
    inode: null,
    markets: [],
    marketsLoadedAt: 0,
    lastBin: null,
  }));

  // Seek to EOF on existing tapes (do not replay history into orders).
  for (const rt of runtimes) {
    try {
      await pollCity(client, rt, { trade: false });
      log(`${rt.cfg.key} seek EOF day=${rt.day} lastBin=${rt.lastBin ?? "—"}`);
    } catch (err) {
      log(`${rt.cfg.key} catch-up error: ${(err as Error).message}`);
    }
  }

  // If already flat but GOT has a current bin, open once (post-seek sync).
  for (const rt of runtimes) {
    if (!rt.lastBin || getHeld(rt.cfg.key)) continue;
    try {
      await handlePrediction(client, rt, {
        type: "prediction",
        stream: "diurnal_got",
        bin: rt.lastBin,
        recv: new Date().toISOString(),
      });
    } catch (err) {
      log(`${rt.cfg.key} sync-open error: ${(err as Error).message}`);
    }
  }

  for (;;) {
    for (const rt of runtimes) {
      try {
        await pollCity(client, rt, { trade: true });
      } catch (err) {
        log(`${rt.cfg.key} poll error: ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(`[weather-got-roll-daemon] fatal: ${err?.message ?? err}`);
  process.exit(1);
});
