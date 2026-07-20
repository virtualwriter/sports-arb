import WebSocket from "ws";
import {
  bookQuotes,
  KalshiClient,
  subscribeOrderbook,
  type KalshiMarket,
  type KalshiOrderbook,
  type KalshiOrderbookLevel,
  type KalshiWsMessage,
} from "./kalshi-client.js";
import { KalshiBookStore } from "./kalshi-ws-books.js";

const GAME_SERIES = process.env.KALSHI_MLB_GAME_SERIES ?? "KXMLBGAME";
const TOTAL_PREFIX = process.env.KALSHI_MLB_TOTAL_PREFIX ?? "KXMLBTOTAL";
const SPREAD_PREFIX = process.env.KALSHI_MLB_SPREAD_PREFIX ?? "KXMLBSPREAD";
const DEFAULT_DEPTH = 5;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_DEPTH_EMIT_MS = 5_000;
const OPEN_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 1_000;

type Quotes = ReturnType<typeof bookQuotes>;
type KalshiSide = "yes" | "no";

export type KalshiMlbLadderRow = {
  kind: "kalshi_ladder";
  market: string;
  klass: "total" | "spread";
  side: KalshiSide;
  line: number;
  ticker: string;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  depthYes?: Array<[number, number]>;
  depthNo?: Array<[number, number]>;
  /** Spread only: Polymarket-style team slug (e.g. philadelphia-phillies). */
  teamKey?: string;
};

export type KalshiMlbSpreadRung = {
  ticker: string;
  teamAbbr: string;
  teamKey: string;
  /** Positive "wins by over X.5" strike from Kalshi. */
  strike: number;
};

type SideTop = {
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
};

export function topOfBookChanged(previous: SideTop | undefined, next: SideTop): boolean {
  return previous === undefined
    || previous.bestBid !== next.bestBid
    || previous.bestAsk !== next.bestAsk
    || previous.bestBidSize !== next.bestBidSize
    || previous.bestAskSize !== next.bestAskSize;
}

function positiveOrNull(value: number): number | null {
  return value > 0 ? value : null;
}

function sideTop(quotes: Quotes, side: KalshiSide): SideTop {
  if (side === "yes") {
    return {
      bestBid: positiveOrNull(quotes.yesBid),
      bestAsk: positiveOrNull(quotes.yesAsk),
      bestBidSize: quotes.yesBid > 0 ? positiveOrNull(quotes.yesBidSize) : null,
      bestAskSize: quotes.yesAsk > 0 ? positiveOrNull(quotes.yesAskSize) : null,
    };
  }
  return {
    bestBid: positiveOrNull(quotes.noBid),
    bestAsk: positiveOrNull(quotes.noAsk),
    bestBidSize: quotes.noBid > 0 ? positiveOrNull(quotes.noBidSize) : null,
    bestAskSize: quotes.noAsk > 0 ? positiveOrNull(quotes.noAskSize) : null,
  };
}

function topLevels(levels: KalshiOrderbookLevel[], depth: number): Array<[number, number]> {
  return levels
    .filter(([price, size]) => price > 0 && size > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, depth)
    .map(([price, size]) => [price, size]);
}

function marketStrike(market: KalshiMarket): number | null {
  if (typeof market.floor_strike === "number" && Number.isFinite(market.floor_strike)) {
    return market.floor_strike;
  }
  if (typeof market.cap_strike === "number" && Number.isFinite(market.cap_strike)) {
    return market.cap_strike;
  }
  const suffix = market.ticker.match(/-(\d+(?:\.\d+)?)$/);
  if (suffix) {
    const strike = Number(suffix[1]);
    if (Number.isFinite(strike)) return strike;
  }
  const text = `${market.yes_sub_title ?? ""} ${market.subtitle ?? ""} ${market.title ?? ""}`;
  const match = text.match(/(?:over|o\/u|total|runs?)\D*(\d+(?:\.\d+)?)/i);
  const strike = match ? Number(match[1]) : NaN;
  return Number.isFinite(strike) ? strike : null;
}

const TEAM_ALIASES: Record<string, string> = {
  ARI: "AZ",
  CHW: "CWS",
  KCR: "KC",
  OAK: "ATH",
  SDP: "SD",
  SFG: "SF",
  TBR: "TB",
  WSN: "WSH",
};

function normalizeTeam(team: string): string {
  const upper = team.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return TEAM_ALIASES[upper] ?? upper;
}

function parseTarget(opts: { pmSlug?: string; date?: string }): {
  datePrefix: string;
  teams: string[];
  gameNumber?: string;
} {
  const slug = (opts.pmSlug ?? "").toLowerCase();
  const slugDate = slug.match(/(\d{4})-(\d{2})-(\d{2})/);
  const date = opts.date ?? (slugDate ? `${slugDate[1]}-${slugDate[2]}-${slugDate[3]}` : "");
  const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    throw new Error("Kalshi MLB discovery requires date=YYYY-MM-DD or a dated Polymarket slug");
  }
  const month = Number(dateMatch[2]);
  const monthName = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][month - 1];
  if (!monthName) throw new Error(`Invalid Kalshi MLB discovery date: ${date}`);

  const withoutDate = slug
    .replace(/^mlb-/, "")
    .replace(/-\d{4}-\d{2}-\d{2}(?:-game-?(\d+)|-g(\d+))?$/, "");
  const gameMatch = slug.match(/(?:game-?|g)(\d+)$/i);
  const teams = withoutDate
    .split(/[-_/@]+/)
    .map(normalizeTeam)
    .filter(Boolean);
  if (teams.length === 1 && teams[0].length < 4) {
    throw new Error(`Could not parse two MLB team abbreviations from ${opts.pmSlug}`);
  }
  if (teams.length > 2) {
    throw new Error(`Could not parse MLB team abbreviations from ${opts.pmSlug}`);
  }
  return {
    datePrefix: `${dateMatch[1].slice(2)}${monthName}${dateMatch[3]}`,
    teams,
    gameNumber: gameMatch?.[1],
  };
}

function stampMatches(stamp: string, target: ReturnType<typeof parseTarget>): boolean {
  if (!stamp.startsWith(target.datePrefix) || stamp.length <= target.datePrefix.length + 4) return false;
  let matchup = stamp.slice(target.datePrefix.length + 4);
  const game = matchup.match(/G(\d+)$/i)?.[1];
  matchup = matchup.replace(/G\d+$/i, "");
  if (target.gameNumber && game !== target.gameNumber) return false;
  if (!target.teams.length) return true;
  const wanted = target.teams.map(normalizeTeam).join("");
  const normalizedMatchup = Object.entries(TEAM_ALIASES).reduce(
    (value, [from, to]) => value.replace(from, to),
    matchup.toUpperCase(),
  );
  return normalizedMatchup === wanted;
}

async function eventRungs(client: KalshiClient, eventTicker: string): Promise<Map<number, string>> {
  const event = await client.getEvent(eventTicker, true);
  if (!event) throw new Error(`Kalshi MLB totals event not found: ${eventTicker}`);
  let markets = event.markets ?? [];
  if (!markets.length) {
    markets = (await client.listMarkets({ event_ticker: eventTicker, limit: 200 })).markets ?? [];
  }
  const rungs = new Map<number, string>();
  for (const market of markets) {
    const strike = marketStrike(market);
    if (strike !== null && market.ticker) rungs.set(strike, market.ticker);
  }
  if (!rungs.size) throw new Error(`No total rungs found for Kalshi event ${eventTicker}`);
  return new Map([...rungs.entries()].sort((a, b) => a[0] - b[0]));
}

async function gameStamps(client: KalshiClient): Promise<string[]> {
  const stamps: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await client.listEvents({
      series_ticker: GAME_SERIES,
      status: "open",
      limit: 200,
      cursor,
    });
    for (const event of response.events ?? []) {
      if (event.event_ticker.startsWith(`${GAME_SERIES}-`)) {
        stamps.push(event.event_ticker.slice(GAME_SERIES.length + 1));
      }
    }
    cursor = response.cursor;
    if (!cursor) break;
  }
  return [...new Set(stamps)];
}

function credentialError(): Error {
  return new Error(
    "Kalshi MLB WebSocket feed requires KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY_PATH",
  );
}

function teamKeyFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** `mlb-nym-phi-2026-07-18` → { away: "NYM", home: "PHI" }. */
export function slugTeamAbbrs(pmSlug: string): { away: string; home: string } | null {
  const m = pmSlug.toLowerCase().match(/^mlb-([a-z0-9]+)-([a-z0-9]+)-\d{4}-\d{2}-\d{2}/);
  if (!m) return null;
  return { away: normalizeTeam(m[1]!), home: normalizeTeam(m[2]!) };
}

export function teamKeysFromEventTitle(eventTitle: string): { away: string; home: string } | null {
  const m = eventTitle.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*:.*)?$/i);
  if (!m) return null;
  return { away: teamKeyFromName(m[1]!.trim()), home: teamKeyFromName(m[2]!.trim()) };
}

/** Stamp from `KXMLBTOTAL-26JUL181605NYMPHI` or bare stamp. */
export function kalshiStampFromEventTicker(eventTicker: string): string | null {
  const t = eventTicker.toUpperCase();
  for (const prefix of [TOTAL_PREFIX, SPREAD_PREFIX, GAME_SERIES]) {
    if (t.startsWith(`${prefix}-`)) return t.slice(prefix.length + 1);
  }
  if (/^\d{2}[A-Z]{3}\d{2}/.test(t)) return t;
  return null;
}

function spreadTeamAbbrFromTicker(ticker: string): string | null {
  const m = ticker.toUpperCase().match(/-([A-Z]{2,3})\d+$/);
  return m ? normalizeTeam(m[1]!) : null;
}

async function spreadRungsForEvent(
  client: KalshiClient,
  eventTicker: string,
  pmSlug: string,
  eventTitle: string,
): Promise<KalshiMlbSpreadRung[]> {
  const event = await client.getEvent(eventTicker, true);
  if (!event) throw new Error(`Kalshi MLB spread event not found: ${eventTicker}`);
  let markets = event.markets ?? [];
  if (!markets.length) {
    markets = (await client.listMarkets({ event_ticker: eventTicker, limit: 200 })).markets ?? [];
  }
  const abbrs = slugTeamAbbrs(pmSlug);
  const keys = teamKeysFromEventTitle(eventTitle)
    ?? teamKeysFromEventTitle(String(event.title ?? ""));
  if (!abbrs || !keys) {
    throw new Error(`Cannot map Kalshi spread teams for ${pmSlug} / ${eventTitle}`);
  }
  const out: KalshiMlbSpreadRung[] = [];
  for (const market of markets) {
    if (!market.ticker) continue;
    const abbr = spreadTeamAbbrFromTicker(market.ticker);
    const strike = marketStrike(market);
    if (!abbr || strike === null) continue;
    let teamKey: string | null = null;
    if (abbr === abbrs.away) teamKey = keys.away;
    else if (abbr === abbrs.home) teamKey = keys.home;
    if (!teamKey) continue;
    out.push({ ticker: market.ticker, teamAbbr: abbr, teamKey, strike });
  }
  if (!out.length) throw new Error(`No spread rungs found for Kalshi event ${eventTicker}`);
  out.sort((a, b) => a.teamKey.localeCompare(b.teamKey) || a.strike - b.strike);
  return out;
}

export class KalshiMlbTotalsFeed {
  public readonly eventTicker: string;
  public readonly rungs: Map<number, string>;

  private readonly onTick: (row: KalshiMlbLadderRow) => void;
  private readonly onReconnect?: (reason: string) => void;
  private readonly depth: number;
  private readonly staleMs: number;
  private readonly tickerToStrike: Map<string, number>;
  private readonly lastEmitted = new Map<string, SideTop>();
  private client: KalshiClient | null = null;
  private books = new KalshiBookStore();
  private socket: WebSocket | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private depthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private subscriptionId = 1;
  private lastWsUpdate = 0;
  private started = false;
  private stopping = false;
  private reconnecting = false;

  static async discover(opts: {
    eventTicker?: string;
    pmSlug?: string;
    date?: string;
  }): Promise<{ eventTicker: string; rungs: Map<number, string> }> {
    const client = new KalshiClient({ unauthenticated: true });
    if (opts.eventTicker) {
      const eventTicker = opts.eventTicker.toUpperCase();
      if (!eventTicker.startsWith(`${TOTAL_PREFIX}-`)) {
        throw new Error(`Expected a ${TOTAL_PREFIX} event ticker, received ${opts.eventTicker}`);
      }
      return { eventTicker, rungs: await eventRungs(client, eventTicker) };
    }
    if (!opts.pmSlug) {
      throw new Error("Kalshi MLB discovery requires eventTicker or pmSlug");
    }
    const target = parseTarget(opts);
    const matches = (await gameStamps(client)).filter((stamp) => stampMatches(stamp, target));
    if (!matches.length) {
      throw new Error(`No open Kalshi MLB game matched ${opts.pmSlug} on ${opts.date ?? target.datePrefix}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple Kalshi MLB games matched ${opts.pmSlug}: ${matches.join(", ")}`);
    }
    const eventTicker = `${TOTAL_PREFIX}-${matches[0]}`;
    try {
      return { eventTicker, rungs: await eventRungs(client, eventTicker) };
    } catch (err) {
      throw new Error(
        `${String(err)} (game stamp matched ${GAME_SERIES}-${matches[0]}; `
        + `${TOTAL_PREFIX} markets often list closer to first pitch — retry discover)`,
      );
    }
  }

  constructor(opts: {
    eventTicker: string;
    rungs: Map<number, string>;
    onTick: (row: KalshiMlbLadderRow) => void;
    onReconnect?: (reason: string) => void;
    depth?: number;
  }) {
    this.eventTicker = opts.eventTicker;
    this.rungs = new Map(opts.rungs);
    this.onTick = opts.onTick;
    this.onReconnect = opts.onReconnect;
    this.depth = Math.max(0, Math.floor(opts.depth ?? Number(process.env.PLR_KALSHI_DEPTH ?? DEFAULT_DEPTH)));
    this.staleMs = Math.max(1_000, Number(process.env.PLR_KALSHI_STALE_MS ?? DEFAULT_STALE_MS));
    this.tickerToStrike = new Map([...this.rungs].map(([strike, ticker]) => [ticker, strike]));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_API_PRIVATE_KEY_PATH) {
      throw credentialError();
    }
    if (!this.rungs.size) throw new Error(`Cannot start Kalshi MLB feed for ${this.eventTicker}: no rungs`);
    this.started = true;
    this.stopping = false;
    this.client = new KalshiClient();
    try {
      await this.connect();
    } catch (error) {
      this.stop();
      throw error;
    }
    const checkEveryMs = Math.max(500, Math.min(5_000, Math.floor(this.staleMs / 3)));
    this.staleTimer = setInterval(() => {
      if (!this.stopping && Date.now() - this.lastWsUpdate >= this.staleMs) {
        this.requestReconnect("stale");
      }
    }, checkEveryMs);
    if (this.depth > 0) {
      const intervalMs = Math.max(
        1_000,
        Number(process.env.PLR_KALSHI_DEPTH_EMIT_MS ?? DEFAULT_DEPTH_EMIT_MS),
      );
      this.depthTimer = setInterval(() => this.emitAll(true), intervalMs);
    }
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.generation += 1;
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.depthTimer) clearInterval(this.depthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.staleTimer = null;
    this.depthTimer = null;
    this.reconnectTimer = null;
    this.reconnecting = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  }

  getQuotes(): Map<number, Quotes> {
    const out = new Map<number, Quotes>();
    for (const [strike, ticker] of this.rungs) {
      const book = this.books.getBook(ticker);
      if (book) out.set(strike, bookQuotes(book));
    }
    return out;
  }

  private async connect(): Promise<void> {
    if (!this.client) throw credentialError();
    const generation = ++this.generation;
    const socket = this.client.openSocket();
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Kalshi MLB WebSocket open timed out after ${OPEN_TIMEOUT_MS}ms`));
      }, OPEN_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    if (this.stopping || generation !== this.generation) {
      socket.close();
      return;
    }
    this.books = new KalshiBookStore();
    this.lastWsUpdate = Date.now();
    subscribeOrderbook(socket, [...this.rungs.values()], this.subscriptionId++);
    socket.on("message", (raw) => this.onMessage(generation, raw));
    socket.on("close", () => {
      if (!this.stopping && generation === this.generation) this.requestReconnect("socket_closed");
    });
    socket.on("error", () => {
      if (!this.stopping && generation === this.generation) this.requestReconnect("socket_error");
    });
  }

  private onMessage(generation: number, raw: WebSocket.RawData): void {
    if (this.stopping || generation !== this.generation) return;
    let message: KalshiWsMessage;
    try {
      message = JSON.parse(String(raw)) as KalshiWsMessage;
    } catch {
      return;
    }
    if (message.type !== "orderbook_snapshot" && message.type !== "orderbook_delta") return;
    const body = (message as { msg?: Record<string, unknown> }).msg ?? {};
    const ticker = String(body.market_ticker ?? "");
    if (!this.tickerToStrike.has(ticker)) return;
    this.lastWsUpdate = Date.now();
    if (message.type === "orderbook_snapshot") this.books.applySnapshot(ticker, body);
    else this.books.applyDelta(ticker, body);
    this.emitTicker(ticker, false);
  }

  private emitAll(force: boolean): void {
    for (const ticker of this.rungs.values()) this.emitTicker(ticker, force);
  }

  private emitTicker(ticker: string, force: boolean): void {
    const strike = this.tickerToStrike.get(ticker);
    const book = this.books.getBook(ticker);
    if (strike === undefined || !book) return;
    const quotes = bookQuotes(book);
    for (const side of ["yes", "no"] as const) {
      const top = sideTop(quotes, side);
      const key = `${ticker}:${side}`;
      if (!force && !topOfBookChanged(this.lastEmitted.get(key), top)) continue;
      this.lastEmitted.set(key, top);
      this.onTick(this.row(strike, ticker, side, top, book));
    }
  }

  private row(
    strike: number,
    ticker: string,
    side: KalshiSide,
    top: SideTop,
    book: KalshiOrderbook,
  ): KalshiMlbLadderRow {
    return {
      kind: "kalshi_ladder",
      market: `total_${strike}`,
      klass: "total",
      side,
      line: strike,
      ticker,
      ...top,
      ...(this.depth > 0
        ? {
            depthYes: topLevels(book.yesBids, this.depth),
            depthNo: topLevels(book.noBids, this.depth),
          }
        : {}),
    };
  }

  private requestReconnect(reason: string): void {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    this.onReconnect?.(reason);
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Ignore close errors before reconnect.
    }
    const attempt = async () => {
      if (this.stopping) return;
      try {
        await this.connect();
        this.reconnecting = false;
      } catch {
        if (!this.stopping) this.reconnectTimer = setTimeout(attempt, RECONNECT_DELAY_MS);
      }
    };
    this.reconnectTimer = setTimeout(attempt, RECONNECT_DELAY_MS);
  }
}

/**
 * Kalshi full-game spread ladder WS feed.
 * Emits market keys matching PM paper TOB: `spread_{teamKey}_{-strike}`.
 */
export class KalshiMlbSpreadsFeed {
  public readonly eventTicker: string;
  public readonly rungs: KalshiMlbSpreadRung[];

  private readonly onTick: (row: KalshiMlbLadderRow) => void;
  private readonly onReconnect?: (reason: string) => void;
  private readonly depth: number;
  private readonly staleMs: number;
  private readonly byTicker: Map<string, KalshiMlbSpreadRung>;
  private readonly lastEmitted = new Map<string, SideTop>();
  private client: KalshiClient | null = null;
  private books = new KalshiBookStore();
  private socket: WebSocket | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private depthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private subscriptionId = 1;
  private lastWsUpdate = 0;
  private started = false;
  private stopping = false;
  private reconnecting = false;

  static async discover(opts: {
    eventTicker?: string;
    totalsEventTicker?: string;
    pmSlug: string;
    eventTitle: string;
    date?: string;
  }): Promise<{ eventTicker: string; rungs: KalshiMlbSpreadRung[] }> {
    const client = new KalshiClient({ unauthenticated: true });
    let eventTicker = opts.eventTicker?.toUpperCase() ?? "";
    if (!eventTicker && opts.totalsEventTicker) {
      const stamp = kalshiStampFromEventTicker(opts.totalsEventTicker);
      if (stamp) eventTicker = `${SPREAD_PREFIX}-${stamp}`;
    }
    if (!eventTicker) {
      const target = parseTarget({ pmSlug: opts.pmSlug, date: opts.date });
      const matches = (await gameStamps(client)).filter((stamp) => stampMatches(stamp, target));
      if (!matches.length) {
        throw new Error(`No open Kalshi MLB game matched ${opts.pmSlug} for spreads`);
      }
      if (matches.length > 1) {
        throw new Error(`Multiple Kalshi MLB games matched ${opts.pmSlug}: ${matches.join(", ")}`);
      }
      eventTicker = `${SPREAD_PREFIX}-${matches[0]}`;
    }
    if (!eventTicker.startsWith(`${SPREAD_PREFIX}-`)) {
      throw new Error(`Expected a ${SPREAD_PREFIX} event ticker, received ${eventTicker}`);
    }
    const rungs = await spreadRungsForEvent(client, eventTicker, opts.pmSlug, opts.eventTitle);
    return { eventTicker, rungs };
  }

  constructor(opts: {
    eventTicker: string;
    rungs: KalshiMlbSpreadRung[];
    onTick: (row: KalshiMlbLadderRow) => void;
    onReconnect?: (reason: string) => void;
    depth?: number;
  }) {
    this.eventTicker = opts.eventTicker;
    this.rungs = [...opts.rungs];
    this.onTick = opts.onTick;
    this.onReconnect = opts.onReconnect;
    this.depth = Math.max(0, Math.floor(opts.depth ?? Number(process.env.PLR_KALSHI_DEPTH ?? DEFAULT_DEPTH)));
    this.staleMs = Math.max(1_000, Number(process.env.PLR_KALSHI_STALE_MS ?? DEFAULT_STALE_MS));
    this.byTicker = new Map(this.rungs.map((r) => [r.ticker, r]));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_API_PRIVATE_KEY_PATH) {
      throw credentialError();
    }
    if (!this.rungs.length) throw new Error(`Cannot start Kalshi spread feed for ${this.eventTicker}: no rungs`);
    this.started = true;
    this.stopping = false;
    this.client = new KalshiClient();
    try {
      await this.connect();
    } catch (error) {
      this.stop();
      throw error;
    }
    const checkEveryMs = Math.max(500, Math.min(5_000, Math.floor(this.staleMs / 3)));
    this.staleTimer = setInterval(() => {
      if (!this.stopping && Date.now() - this.lastWsUpdate >= this.staleMs) {
        this.requestReconnect("stale");
      }
    }, checkEveryMs);
    if (this.depth > 0) {
      const intervalMs = Math.max(
        1_000,
        Number(process.env.PLR_KALSHI_DEPTH_EMIT_MS ?? DEFAULT_DEPTH_EMIT_MS),
      );
      this.depthTimer = setInterval(() => this.emitAll(true), intervalMs);
    }
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    this.generation += 1;
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.depthTimer) clearInterval(this.depthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.staleTimer = null;
    this.depthTimer = null;
    this.reconnectTimer = null;
    this.reconnecting = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
  }

  private async connect(): Promise<void> {
    if (!this.client) throw credentialError();
    const generation = ++this.generation;
    const socket = this.client.openSocket();
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Kalshi MLB spread WebSocket open timed out after ${OPEN_TIMEOUT_MS}ms`));
      }, OPEN_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    if (this.stopping || generation !== this.generation) {
      socket.close();
      return;
    }
    this.books = new KalshiBookStore();
    this.lastWsUpdate = Date.now();
    subscribeOrderbook(socket, this.rungs.map((r) => r.ticker), this.subscriptionId++);
    socket.on("message", (raw) => this.onMessage(generation, raw));
    socket.on("close", () => {
      if (!this.stopping && generation === this.generation) this.requestReconnect("socket_closed");
    });
    socket.on("error", () => {
      if (!this.stopping && generation === this.generation) this.requestReconnect("socket_error");
    });
  }

  private onMessage(generation: number, raw: WebSocket.RawData): void {
    if (this.stopping || generation !== this.generation) return;
    let message: KalshiWsMessage;
    try {
      message = JSON.parse(String(raw)) as KalshiWsMessage;
    } catch {
      return;
    }
    if (message.type !== "orderbook_snapshot" && message.type !== "orderbook_delta") return;
    const body = (message as { msg?: Record<string, unknown> }).msg ?? {};
    const ticker = String(body.market_ticker ?? "");
    if (!this.byTicker.has(ticker)) return;
    this.lastWsUpdate = Date.now();
    if (message.type === "orderbook_snapshot") this.books.applySnapshot(ticker, body);
    else this.books.applyDelta(ticker, body);
    this.emitTicker(ticker, false);
  }

  private emitAll(force: boolean): void {
    for (const r of this.rungs) this.emitTicker(r.ticker, force);
  }

  private emitTicker(ticker: string, force: boolean): void {
    const meta = this.byTicker.get(ticker);
    const book = this.books.getBook(ticker);
    if (!meta || !book) return;
    const quotes = bookQuotes(book);
    for (const side of ["yes", "no"] as const) {
      const top = sideTop(quotes, side);
      const key = `${ticker}:${side}`;
      if (!force && !topOfBookChanged(this.lastEmitted.get(key), top)) continue;
      this.lastEmitted.set(key, top);
      const line = -Math.abs(meta.strike);
      this.onTick({
        kind: "kalshi_ladder",
        market: `spread_${meta.teamKey}_${line}`,
        klass: "spread",
        side,
        line,
        ticker,
        teamKey: meta.teamKey,
        ...top,
        ...(this.depth > 0
          ? {
              depthYes: topLevels(book.yesBids, this.depth),
              depthNo: topLevels(book.noBids, this.depth),
            }
          : {}),
      });
    }
  }

  private requestReconnect(reason: string): void {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    this.onReconnect?.(reason);
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    const attempt = async () => {
      if (this.stopping) return;
      try {
        await this.connect();
        this.reconnecting = false;
      } catch {
        if (!this.stopping) this.reconnectTimer = setTimeout(attempt, RECONNECT_DELAY_MS);
      }
    };
    this.reconnectTimer = setTimeout(attempt, RECONNECT_DELAY_MS);
  }
}
