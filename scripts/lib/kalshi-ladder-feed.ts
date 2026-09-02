/**
 * Sport-neutral Kalshi strike-ladder orderbook feed.
 *
 * Streams top-of-book (and optional depth) for a set of tickers keyed by
 * strike, emitting a row whenever a side's top changes. Discovery — working
 * out which event and which rungs belong to a given game — is deliberately
 * left to the caller, because that is the only genuinely sport-specific part.
 *
 * `kalshi-mlb-ws-feed.ts` still carries its own copy of this logic. It is the
 * live trading path and was not worth destabilising to save the duplication;
 * migrate it here once football has run a full season's slate.
 */

import WebSocket from "ws";
import {
  bookQuotes,
  KalshiClient,
  subscribeOrderbook,
  type KalshiOrderbook,
  type KalshiOrderbookLevel,
  type KalshiWsMessage,
} from "./kalshi-client.js";
import { KalshiBookStore } from "./kalshi-ws-books.js";

const DEFAULT_DEPTH = 5;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_DEPTH_EMIT_MS = 5_000;
const OPEN_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 1_000;

type Quotes = ReturnType<typeof bookQuotes>;
export type KalshiSide = "yes" | "no";

export type KalshiLadderRow = {
  kind: "kalshi_ladder";
  market: string;
  klass: string;
  side: KalshiSide;
  line: number;
  ticker: string;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  depthYes?: Array<[number, number]>;
  depthNo?: Array<[number, number]>;
};

type SideTop = {
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
};

function positiveOrNull(value: number): number | null {
  return value > 0 ? value : null;
}

export function sideTop(quotes: Quotes, side: KalshiSide): SideTop {
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

export function topOfBookChanged(previous: SideTop | undefined, next: SideTop): boolean {
  return previous === undefined
    || previous.bestBid !== next.bestBid
    || previous.bestAsk !== next.bestAsk
    || previous.bestBidSize !== next.bestBidSize
    || previous.bestAskSize !== next.bestAskSize;
}

function topLevels(levels: KalshiOrderbookLevel[], depth: number): Array<[number, number]> {
  return levels
    .filter(([price, size]) => price > 0 && size > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, depth)
    .map(([price, size]) => [price, size]);
}

export class KalshiLadderFeed {
  public readonly eventTicker: string;
  public readonly rungs: Map<number, string>;

  private readonly klass: string;
  private readonly marketPrefix: string;
  private readonly onTick: (row: KalshiLadderRow) => void;
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

  constructor(opts: {
    eventTicker: string;
    rungs: Map<number, string>;
    onTick: (row: KalshiLadderRow) => void;
    onReconnect?: (reason: string) => void;
    klass?: string;
    marketPrefix?: string;
    depth?: number;
    staleMs?: number;
  }) {
    this.eventTicker = opts.eventTicker;
    this.rungs = new Map(opts.rungs);
    this.klass = opts.klass ?? "total";
    this.marketPrefix = opts.marketPrefix ?? "total";
    this.onTick = opts.onTick;
    this.onReconnect = opts.onReconnect;
    this.depth = Math.max(0, Math.floor(opts.depth ?? Number(process.env.PLR_KALSHI_DEPTH ?? DEFAULT_DEPTH)));
    this.staleMs = Math.max(1_000, opts.staleMs ?? Number(process.env.PLR_KALSHI_STALE_MS ?? DEFAULT_STALE_MS));
    this.tickerToStrike = new Map([...this.rungs].map(([strike, ticker]) => [ticker, strike]));
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!process.env.KALSHI_API_KEY_ID || !process.env.KALSHI_API_PRIVATE_KEY_PATH) {
      throw new Error("Kalshi ladder feed requires KALSHI_API_KEY_ID and KALSHI_API_PRIVATE_KEY_PATH");
    }
    if (!this.rungs.size) throw new Error(`Cannot start Kalshi feed for ${this.eventTicker}: no rungs`);
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
    if (!this.client) throw new Error("Kalshi ladder feed missing client");
    const generation = ++this.generation;
    const socket = this.client.openSocket();
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`Kalshi WebSocket open timed out after ${OPEN_TIMEOUT_MS}ms`));
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
  ): KalshiLadderRow {
    return {
      kind: "kalshi_ladder",
      market: `${this.marketPrefix}_${strike}`,
      klass: this.klass,
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
