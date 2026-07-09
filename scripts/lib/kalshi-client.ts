// Kalshi REST + WebSocket client.
//
// Kalshi recommended base URLs (per docs "API Environments and Endpoints"):
//   Production REST: https://external-api.kalshi.com/trade-api/v2
//   Production WS:   wss://external-api-ws.kalshi.com/trade-api/ws/v2
//   Demo REST:       https://external-api.demo.kalshi.co/trade-api/v2
//   Demo WS:         wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2
//
// Request signing convention (per docs): the signed path is the full request
// path from the API root WITHOUT query parameters, i.e. for
//   GET https://external-api.kalshi.com/trade-api/v2/markets?limit=10
// sign:
//   GET /trade-api/v2/markets
//
// We only need read-only endpoints for Phase 1+2 (shadow screener):
//   GET /events?series_ticker=...&status=open
//   GET /markets?event_ticker=...&status=open  (or /markets/{ticker})
//   GET /markets/{ticker}/orderbook
//
// WS subscriptions (Phase 2 streaming):
//   { "id": <n>, "cmd": "subscribe",
//     "params": { "channels": ["orderbook_delta"], "market_tickers": [...] } }

import WebSocket from "ws";
import { readCredentialsFromEnv, signRequest, type KalshiCredentials } from "./kalshi-auth.js";

const PROD_REST = process.env.KALSHI_REST_BASE ?? "https://external-api.kalshi.com/trade-api/v2";
const DEMO_REST = process.env.KALSHI_DEMO_REST_BASE ?? "https://external-api.demo.kalshi.co/trade-api/v2";
// Read-only endpoints (series/events/markets/orderbooks) are served without
// authentication from the public elections host. Used when no API key is
// configured so shadow scanners can run credential-free.
const PUBLIC_REST = process.env.KALSHI_PUBLIC_REST_BASE ?? "https://api.elections.kalshi.com/trade-api/v2";
const PROD_WS = process.env.KALSHI_WS_BASE ?? "wss://external-api-ws.kalshi.com/trade-api/ws/v2";
const DEMO_WS = process.env.KALSHI_DEMO_WS_BASE ?? "wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2";

export type KalshiEnv = "production" | "demo";

export type KalshiClientConfig = {
  env?: KalshiEnv;
  credentials?: KalshiCredentials;
  fetchTimeoutMs?: number;
  userAgent?: string;
};

export type KalshiEvent = {
  event_ticker: string;
  series_ticker: string;
  sub_title?: string;
  title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  yes_sub_title?: string;
  no_sub_title?: string;
  expected_expiration_time?: string;
  status?: string;
  markets?: KalshiMarket[];
};

export type KalshiMarket = {
  ticker: string;
  event_ticker: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  open_time?: string;
  close_time?: string;
  expiration_time?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  previous_yes_bid?: number;
  previous_yes_ask?: number;
  volume?: number;
  volume_24h?: number;
  liquidity?: number;
  open_interest?: number;
  notional_value?: number;
  risk_limit_cents?: number;
  strike_type?: string;
  cap_strike?: number;
  floor_strike?: number;
  rules_primary?: string;
  rules_secondary?: string;
  response_price_units?: string;
};

export type KalshiOrderbookLevel = [price: number, size: number];

// Kalshi returns the orderbook as a `orderbook_fp` object whose `yes_dollars`
// and `no_dollars` arrays each list resting *bids* on that side as
// [price_string, size_string] pairs. Prices are dollar strings ("0.46") and
// sizes are contract counts ("1057"). There is no separate ask list because in
// a Kalshi book a YES ask is equivalent to a NO bid at (1 - price): if anyone
// is bidding $0.51 for NO, they are effectively offering YES at $0.49.
//
// Convention after parsing:
//   yesBids[i] = [price, size]  best bid is MAX price
//   noBids[i]  = [price, size]  best bid is MAX price
//   bestYesBid = max(yesBids.price)
//   bestYesAsk = 1 - max(noBids.price)  (cost to BUY YES)
//   bestNoBid  = max(noBids.price)
//   bestNoAsk  = 1 - max(yesBids.price) (cost to BUY NO)
export type KalshiOrderbook = {
  yesBids: KalshiOrderbookLevel[];
  noBids: KalshiOrderbookLevel[];
};

function parseOrderbookSide(raw: unknown): KalshiOrderbookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: KalshiOrderbookLevel[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const price = Number(entry[0]);
    const size = Number(entry[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    out.push([price, size]);
  }
  return out;
}

export function parseOrderbookResponse(resp: unknown): KalshiOrderbook {
  const r = (resp as any)?.orderbook_fp ?? (resp as any)?.orderbook ?? resp;
  return {
    yesBids: parseOrderbookSide((r as any)?.yes_dollars ?? (r as any)?.yes),
    noBids: parseOrderbookSide((r as any)?.no_dollars ?? (r as any)?.no),
  };
}

export function bookQuotes(book: KalshiOrderbook): {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  yesBidSize: number;
  yesAskSize: number;
  noBidSize: number;
  noAskSize: number;
} {
  let bestYesBid = 0, bestYesBidSize = 0;
  for (const [p, s] of book.yesBids) if (p > bestYesBid) { bestYesBid = p; bestYesBidSize = s; }
  let bestNoBid = 0, bestNoBidSize = 0;
  for (const [p, s] of book.noBids) if (p > bestNoBid) { bestNoBid = p; bestNoBidSize = s; }
  const yesAsk = bestNoBid > 0 ? 1 - bestNoBid : 0;
  const noAsk = bestYesBid > 0 ? 1 - bestYesBid : 0;
  return {
    yesBid: bestYesBid,
    yesAsk,
    noBid: bestNoBid,
    noAsk,
    yesBidSize: bestYesBidSize,
    yesAskSize: bestNoBidSize,
    noBidSize: bestNoBidSize,
    noAskSize: bestYesBidSize,
  };
}

export class KalshiClient {
  private readonly creds: KalshiCredentials | null;
  private readonly restBase: string;
  private readonly wsBase: string;
  private readonly timeoutMs: number;
  private readonly ua: string;
  // Simple token-bucket-ish rate limiter: enforce a minimum gap between
  // outgoing REST requests across the whole client. Kalshi's public read tier
  // is roughly 10 rps; we default to ~6 rps (160ms gap) to leave headroom for
  // bursts.
  private readonly minRequestSpacingMs: number;
  private nextAllowedMs = 0;
  private requestChain: Promise<void> = Promise.resolve();

  constructor(config: KalshiClientConfig & { unauthenticated?: boolean } = {}) {
    const wantUnauthenticated = config.unauthenticated
      ?? (!config.credentials && !process.env.KALSHI_API_KEY_ID);
    this.creds = wantUnauthenticated ? null : (config.credentials ?? readCredentialsFromEnv());
    const env: KalshiEnv = config.env ?? ((process.env.KALSHI_ENV as KalshiEnv) ?? "production");
    this.restBase = this.creds === null
      ? PUBLIC_REST
      : (env === "demo" ? DEMO_REST : PROD_REST);
    this.wsBase = env === "demo" ? DEMO_WS : PROD_WS;
    this.timeoutMs = config.fetchTimeoutMs ?? 15_000;
    this.ua = config.userAgent ?? "sports-arb-kalshi-screener/0.1";
    this.minRequestSpacingMs = Number(process.env.KALSHI_MIN_REQUEST_SPACING_MS ?? 160);
  }

  private async waitForSlot(): Promise<void> {
    // Serialize the spacing check by chaining onto a single promise so that
    // concurrent callers each get a fresh "next allowed" timestamp.
    const slot = this.requestChain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.nextAllowedMs - now);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextAllowedMs = Date.now() + this.minRequestSpacingMs;
    });
    this.requestChain = slot.catch(() => undefined);
    await slot;
  }

  get wsUrl(): string {
    return this.wsBase;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    // Per Kalshi docs ("Request Signing"): sign the full request path from the
    // API root WITHOUT query parameters. So for
    //   GET /trade-api/v2/markets?limit=10
    // sign the message "<timestamp_ms>GET/trade-api/v2/markets".
    await this.waitForSlot();
    let headers: Record<string, string> = {};
    if (this.creds) {
      const signingPath = `/trade-api/v2${path.split("?")[0]}`;
      headers = signRequest(this.creds, method, signingPath).headers;
    }
    const url = `${this.restBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          ...headers,
          accept: "application/json",
          "user-agent": this.ua,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (resp.status === 429 && attempt < 4) {
        // Exponential backoff on rate-limit: 500ms, 1s, 2s, 4s.
        const backoff = 500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        return this.request<T>(method, path, body, attempt + 1);
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Kalshi ${method} ${path} failed: ${resp.status} ${resp.statusText} ${text.slice(0, 500)}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Discovery endpoints ----

  async listEvents(params: {
    series_ticker?: string;
    status?: "open" | "closed" | "settled" | "unopened";
    with_nested_markets?: boolean;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ events: KalshiEvent[]; cursor?: string }> {
    const qs = new URLSearchParams();
    if (params.series_ticker) qs.set("series_ticker", params.series_ticker);
    if (params.status) qs.set("status", params.status);
    if (params.with_nested_markets) qs.set("with_nested_markets", "true");
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    return this.get<{ events: KalshiEvent[]; cursor?: string }>(`/events?${qs.toString()}`);
  }

  async listMarkets(params: {
    event_ticker?: string;
    series_ticker?: string;
    status?: "open" | "closed" | "settled" | "unopened";
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
    const qs = new URLSearchParams();
    if (params.event_ticker) qs.set("event_ticker", params.event_ticker);
    if (params.series_ticker) qs.set("series_ticker", params.series_ticker);
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    return this.get<{ markets: KalshiMarket[]; cursor?: string }>(`/markets?${qs.toString()}`);
  }

  async getOrderbook(ticker: string, depth: number = 10): Promise<KalshiOrderbook> {
    const qs = new URLSearchParams({ depth: String(depth) });
    const raw = await this.get<unknown>(`/markets/${encodeURIComponent(ticker)}/orderbook?${qs.toString()}`);
    return parseOrderbookResponse(raw);
  }

  async getEvent(eventTicker: string, withNestedMarkets = true): Promise<KalshiEvent | null> {
    const qs = new URLSearchParams();
    if (withNestedMarkets) qs.set("with_nested_markets", "true");
    try {
      const resp = await this.get<{ event?: KalshiEvent }>(`/events/${encodeURIComponent(eventTicker)}?${qs.toString()}`);
      return resp.event ?? null;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes("404") || msg.includes("not_found")) return null;
      throw err;
    }
  }

  // ---- WebSocket helpers ----

  buildWsHeaders(): Record<string, string> {
    // Kalshi WS auth uses the same RSA signature scheme. Sign the full
    // ws path from the API root: GET /trade-api/ws/v2
    if (!this.creds) throw new Error("Kalshi WS requires credentials (KALSHI_API_KEY_ID / KALSHI_API_PRIVATE_KEY_PATH)");
    const { headers } = signRequest(this.creds, "GET", "/trade-api/ws/v2");
    return headers;
  }

  openSocket(): WebSocket {
    return new WebSocket(this.wsBase, {
      headers: this.buildWsHeaders(),
    });
  }
}

export type OrderbookSnapshotMsg = {
  type: "orderbook_snapshot";
  msg: {
    market_ticker: string;
    yes: KalshiOrderbookLevel[];
    no: KalshiOrderbookLevel[];
  };
};

export type OrderbookDeltaMsg = {
  type: "orderbook_delta";
  msg: {
    market_ticker: string;
    price: number;
    delta: number;
    side: "yes" | "no";
  };
};

export type KalshiWsMessage =
  | OrderbookSnapshotMsg
  | OrderbookDeltaMsg
  | { type: string; msg?: Record<string, unknown> };

export function subscribeOrderbook(
  socket: WebSocket,
  marketTickers: string[],
  id = 1,
): void {
  socket.send(
    JSON.stringify({
      id,
      cmd: "subscribe",
      params: {
        channels: ["orderbook_delta"],
        market_tickers: marketTickers,
      },
    }),
  );
}
