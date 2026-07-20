// Shared feed clients + cross-venue match discovery for the latency test harness.
// All feeds are headless (no Playwright browser-context calls); Sofascore uses a
// raw CDP tab over Chrome :9222 to clear Cloudflare, everything else is plain
// fetch / ws. One process, so Date.now() is the common clock.

import WebSocket from "ws";

export const RS = String.fromCharCode(0x1e); // SignalR record separator

// ---------------------------------------------------------------------------
// Name normalization for cross-venue matching
// ---------------------------------------------------------------------------
export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Tokens (len>=4) from a player name, accent-stripped, dropping (COUNTRY) codes/initials. */
export function playerTokens(name: string): string[] {
  return stripAccents(String(name))
    .replace(/\([A-Za-z]{2,4}\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z\s./-]/g, " ")
    .split(/[\s/.\-]+/)
    .filter((t) => t.length >= 4);
}

/** Two player names refer to the same person if any name token (len>=4) overlaps. */
export function sameSide(a: string, b: string): boolean {
  const A = new Set(playerTokens(a));
  if (!A.size) return false;
  for (const t of playerTokens(b)) if (A.has(t)) return true;
  return false;
}

/** Order-invariant match of two "player pairs" by token overlap on both sides. */
export function samePairNames(a: [string, string], b: [string, string]): boolean {
  return (
    (sameSide(a[0], b[0]) && sameSide(a[1], b[1])) ||
    (sameSide(a[0], b[1]) && sameSide(a[1], b[0]))
  );
}

/** Split an "A vs B" / "A - B" title into two side strings. */
export function vsSides(title: string): [string, string] | null {
  const parts = String(title)
    .replace(/^[^:]*:\s*/, "")
    .split(/\s+vs\.?\s+|\s+v\s+|\s+-\s+|\s+@\s+/i);
  if (parts.length < 2) return null;
  return [parts[0].trim(), parts[parts.length - 1].trim()];
}

/** Extract lowercase surnames from a display name, dropping (COUNTRY) codes and initials. */
export function surnames(name: string): string[] {
  const cleaned = stripAccents(String(name))
    .replace(/\([A-Za-z]{2,4}\)/g, " ") // (ARG)
    .replace(/[^A-Za-z\s.\-/]/g, " ")
    .toLowerCase();
  // Split doubles/teams on / and take a surname from each side.
  const sides = cleaned.split("/");
  const out: string[] = [];
  for (const side of sides) {
    const toks = side
      .replace(/\b[a-z]\./g, " ") // strip "n." initials
      .split(/\s+/)
      .map((t) => t.replace(/\.$/, ""))
      .filter((t) => t.length >= 3);
    if (!toks.length) continue;
    // longest token is usually the surname
    toks.sort((a, b) => b.length - a.length);
    out.push(toks[0]);
  }
  return out;
}

/** Extract one surname per side of an "A vs B" / "A - B" style string. */
export function pairSurnamesVs(text: string): string[] {
  const sides = String(text)
    .replace(/^[^:]*:\s*/, "") // drop "Tournament: "
    .split(/\s+vs\.?\s+|\s+v\s+|\s+-\s+|\s+@\s+/i);
  const out: string[] = [];
  for (const side of sides) {
    const s = surnames(side);
    if (s.length) out.push(s[0]);
  }
  return out;
}

function surnameMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const n = Math.min(5, a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/** Do two player-name pairs describe the same match? Order-invariant. */
export function samePair(p1: string[], p2: string[]): boolean {
  if (p1.length < 2 || p2.length < 2) return false;
  const [a1, b1] = p1;
  const [a2, b2] = p2;
  return (
    (surnameMatch(a1, a2) && surnameMatch(b1, b2)) ||
    (surnameMatch(a1, b2) && surnameMatch(b1, a2))
  );
}

// ---------------------------------------------------------------------------
// Tennis score fingerprint (order-invariant, tiebreak-aware)
// ---------------------------------------------------------------------------
export function setFingerprint(score: string): string {
  return String(score)
    .toLowerCase()
    .replace(/\s+/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^(\d+)-(\d+)(?:\((\d+)-(\d+)\))?/);
      if (!m) return s;
      const a = Number(m[1]);
      const b = Number(m[2]);
      const games = a <= b ? `${a}-${b}` : `${b}-${a}`;
      if (m[3] != null && m[4] != null) {
        const ta = Number(m[3]);
        const tb = Number(m[4]);
        return games + (a <= b ? `(${ta}-${tb})` : `(${tb}-${ta})`);
      }
      return games;
    })
    .join("|");
}

/** Compare on the first N completed sets so in-progress last set doesn't break binding. */
export function fpPrefixMatch(fpA: string, fpB: string, sets = 2): boolean {
  if (!fpA || !fpB) return false;
  const a = fpA.split("|").slice(0, sets).join("|");
  const b = fpB.split("|").slice(0, sets).join("|");
  return a.length > 0 && a === b;
}

// ---------------------------------------------------------------------------
// Raw CDP tab driver (Sofascore Cloudflare bypass) over Chrome :9222
// ---------------------------------------------------------------------------
export class CdpTab {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private tabId = "";
  constructor(private cdpHttp = process.env.CDP_HTTP ?? "http://127.0.0.1:9222") {}

  async open(url = "about:blank"): Promise<void> {
    const put = await fetch(`${this.cdpHttp}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const target =
      put ??
      (await fetch(`${this.cdpHttp}/json/new?${encodeURIComponent(url)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null));
    if (!target?.webSocketDebuggerUrl) throw new Error("CdpTab: no ws url");
    this.tabId = target.id;
    this.ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("error", () => {});
    this.ws.on("message", (buf) => {
      let m: any;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.id != null && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      }
    });
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  private send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, 8000);
      this.pending.set(id, (v) => {
        clearTimeout(to);
        resolve(v);
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(to);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  async fetchJson(url: string, settleMs = 200): Promise<any> {
    await this.send("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, settleMs));
    const res = await this.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    const text = res?.result?.result?.value ?? "";
    return JSON.parse(text);
  }

  async close(): Promise<void> {
    await fetch(`${this.cdpHttp}/json/close/${this.tabId}`).catch(() => {});
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Flashscore feed
// ---------------------------------------------------------------------------
const FS_SIGN = process.env.FS_SIGN ?? "SW9D1eZo";

export async function fsFetch(sport: number): Promise<string> {
  const url = `https://global.flashscore.ninja/2/x/feed/f_${sport}_0_-4_en_1`;
  const res = await fetch(url, {
    headers: {
      "x-fsign": FS_SIGN,
      referer: "https://www.flashscore.com/",
      "user-agent": "Mozilla/5.0",
    },
  });
  return res.text();
}

export function fsParseBlocks(feed: string): Array<Record<string, string>> {
  return feed.split("~").map((block) => {
    const rec: Record<string, string> = {};
    for (const pair of block.split("¬")) {
      const idx = pair.indexOf("÷");
      if (idx > 0) rec[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    return rec;
  });
}

const FS_SET_HOME = ["BA", "BC", "BE", "BG", "BI"];
const FS_SET_AWAY = ["BB", "BD", "BF", "BH", "BJ"];
const FS_TB_HOME = ["DA", "DC", "DE", "DG", "DI"];
const FS_TB_AWAY = ["DB", "DD", "DF", "DH", "DJ"];

export function fsTennisScore(rec: Record<string, string>): string {
  const parts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const h = rec[FS_SET_HOME[i]];
    const a = rec[FS_SET_AWAY[i]];
    if (h == null && a == null) continue;
    let piece = `${h ?? 0}-${a ?? 0}`;
    const th = rec[FS_TB_HOME[i]];
    const ta = rec[FS_TB_AWAY[i]];
    if (th != null || ta != null) piece += `(${th ?? 0}-${ta ?? 0})`;
    parts.push(piece);
  }
  return parts.join(", ");
}

/** Soccer / basketball simple aggregate score from Flashscore record. */
export function fsGoalScore(rec: Record<string, string>): string {
  const h = rec.AG ?? rec.WA;
  const a = rec.AH ?? rec.WB;
  if (h == null && a == null) return "";
  return `${h ?? 0}-${a ?? 0}`;
}

export interface FsMatch {
  id: string;
  home: string;
  away: string;
  stage: string; // AB (2 = in-play)
  status: string; // AC
  rec: Record<string, string>;
}

export function fsLiveMatches(feed: string): FsMatch[] {
  const out: FsMatch[] = [];
  for (const rec of fsParseBlocks(feed)) {
    if (!rec.AA || !rec.AE) continue;
    out.push({
      id: rec.AA,
      home: rec.AE,
      away: rec.AF ?? "",
      stage: rec.AB ?? "",
      status: rec.AC ?? "",
      rec,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// bwin — cds-api discovery + cds-push SignalR client
// ---------------------------------------------------------------------------
export const BWIN_ACCESS_ID =
  process.env.BWIN_ACCESS_ID ?? "NTZiMjk3OGMtNjU5Mi00NjA5LWI2MWItZmU4MDRhN2QxZmEz";

export interface BwinFixture {
  id: string;
  name: string;
  players: string[];
}

export async function bwinLiveFixtures(sportId: number): Promise<BwinFixture[]> {
  const url =
    `https://www.bwin.com/cds-api/bettingoffer/fixtures?x-bwin-accessId=${BWIN_ACCESS_ID}` +
    `&lang=en&country=US&userCountry=US&state=Live&sportIds=${sportId}&skip=0&take=80`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://sports.bwin.com/" },
  });
  if (!res.ok) return [];
  const data: any = await res.json().catch(() => ({}));
  const out: BwinFixture[] = [];
  for (const f of data.fixtures ?? []) {
    const players = (f.participants ?? []).map((p: any) => p?.name?.value ?? "");
    out.push({ id: String(f.id), name: f?.name?.value ?? "", players });
  }
  return out;
}

/**
 * Subscribe to a bwin fixture's live market pushes over the cds-push SignalR WS.
 * Invokes onUpdate(payload) for each OptionMarketUpdate/Delete for the fixture.
 */
const BWIN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function bwinBareId(id: string): string {
  return id.replace(/^\d+:/, "");
}

export class BwinPushClient {
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  // Maps any observed fixture id (incl. in-play switch ids) back to a subscribed id.
  private alias = new Map<string, string>();
  constructor(
    private fixtureIds: string[],
    private onUpdate: (fixtureId: string, payload: any, messageType: string) => void,
    private onLog: (msg: string) => void = () => {},
    private onClose: () => void = () => {},
  ) {
    for (const id of fixtureIds) this.alias.set(bwinBareId(id), id);
  }

  connect(): void {
    const url =
      `wss://cds-push.bwin.com/ws-1-0?lang=en&country=US` +
      `&x-bwin-accessId=${BWIN_ACCESS_ID}&appUpdates=false`;
    const ws = new WebSocket(url, {
      headers: { Origin: "https://sports.bwin.com", "User-Agent": BWIN_UA },
    });
    this.ws = ws;
    ws.on("open", () => {
      ws.send(`{"protocol":"json","version":1}` + RS);
      setTimeout(() => {
        // Subscribe both v1 (numeric) and v2 (sport:id composite) topic forms.
        const topics: string[] = [];
        for (const id of this.fixtureIds) {
          const bare = bwinBareId(id);
          topics.push(`v1|en|${bare}|grd`, `v2|en|${id}_1_any|grd`, `v1|en|${bare}|dtl`);
        }
        ws.send(
          JSON.stringify({
            arguments: [{ topics }],
            invocationId: "0",
            target: "Subscribe",
            type: 1,
          }) + RS,
        );
        this.onLog(`bwin subscribed ${this.fixtureIds.length} fixtures (${topics.length} topics)`);
      }, 300);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(`{"type":6}` + RS);
      }, 15000);
    });
    ws.on("message", (buf) => {
      const raw = buf.toString();
      for (const part of raw.split(RS)) {
        if (!part) continue;
        let msg: any;
        try {
          msg = JSON.parse(part);
        } catch {
          continue;
        }
        if (msg.type !== 1 || msg.target !== "Receive") continue;
        const arg = msg.arguments?.[0];
        if (!arg) continue;
        const messageType = String(arg.messageType ?? "");
        const payload = arg.payload ?? {};
        // Learn pre-match -> in-play id switches so we can still route odds.
        if (messageType === "MainToLiveUpdate") {
          for (const sw of payload.switchedFixtures ?? []) {
            const pre = bwinBareId(String(sw.preMatchId ?? ""));
            const inp = bwinBareId(String(sw.inPlayId ?? ""));
            if (pre && this.alias.has(pre) && inp) this.alias.set(inp, this.alias.get(pre)!);
          }
          continue;
        }
        const rawId = bwinBareId(
          String(payload.fixtureId ?? payload?.optionMarket?.fixtureId ?? ""),
        );
        const routed = this.alias.get(rawId) ?? (this.fixtureIds.length === 1 ? this.fixtureIds[0] : rawId);
        this.onUpdate(routed, payload, messageType);
      }
    });
    ws.on("error", (e) => this.onLog(`bwin ws err ${String(e).slice(0, 80)}`));
    ws.on("close", () => {
      this.onLog("bwin ws closed");
      this.onClose();
    });
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// OpticOdds — SSE odds stream (api key), multi-sportsbook relay
// ---------------------------------------------------------------------------
export interface OpticOddsRow {
  eventType: string; // "odds" | "locked-odds"
  sportsbook: string; // e.g. "pinnacle"
  market: string; // display name, e.g. "Total Goals"
  marketId: string; // e.g. "total_goals"
  price: number | null;
  points: number | null;
  selection: string;
  selectionLine: string; // "over"/"under"/""
  isMain: boolean;
  isLive: boolean;
  srcTsMs: number | null; // OpticOdds-side timestamp (their clock)
  fixtureId: string;
}

/**
 * SSE client for OpticOdds /stream/odds/{sport}. Auto-reconnects and resumes
 * from last_entry_id so no ticks are lost across drops.
 */
export class OpticOddsClient {
  private ac?: AbortController;
  private stopped = false;
  private lastEntryId: string | null = null;
  constructor(
    private opts: {
      key: string;
      sport: string; // "soccer" | "baseball" | "tennis" | ...
      fixtureId: string;
      sportsbooks: string[]; // max 5
      markets?: string[]; // display names, e.g. "Moneyline 3-Way"
    },
    private onOdds: (row: OpticOddsRow) => void,
    private onLog: (msg: string) => void = () => {},
  ) {}

  connect(): void {
    this.stopped = false;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const p = new URLSearchParams({ key: this.opts.key, odds_format: "DECIMAL" });
        for (const b of this.opts.sportsbooks) p.append("sportsbook", b);
        for (const m of this.opts.markets ?? []) p.append("market", m);
        p.append("fixture_id", this.opts.fixtureId);
        if (this.lastEntryId) p.set("last_entry_id", this.lastEntryId);
        const ac = new AbortController();
        this.ac = ac;
        const res = await fetch(
          `https://api.opticodds.com/api/v3/stream/odds/${this.opts.sport}?${p}`,
          { signal: ac.signal, headers: { accept: "text/event-stream" } },
        );
        if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
        this.onLog(`opticodds stream connected (${this.opts.sportsbooks.join(",")})`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let eventType = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("id:")) this.lastEntryId = line.slice(3).trim();
            else if (line.startsWith("data:") && (eventType === "odds" || eventType === "locked-odds")) {
              let msg: any;
              try {
                msg = JSON.parse(line.slice(5).trim());
              } catch {
                continue;
              }
              for (const o of msg?.data ?? []) {
                this.onOdds({
                  eventType,
                  sportsbook: String(o.sportsbook_id ?? o.sportsbook ?? ""),
                  market: String(o.market ?? ""),
                  marketId: String(o.market_id ?? ""),
                  price: o.price == null ? null : Number(o.price),
                  points: o.points == null ? null : Number(o.points),
                  selection: String(o.normalized_selection ?? o.selection ?? ""),
                  selectionLine: String(o.selection_line ?? ""),
                  isMain: o.is_main === true,
                  isLive: o.is_live === true,
                  srcTsMs: o.timestamp == null ? null : Math.round(Number(o.timestamp) * 1000),
                  fixtureId: String(o.fixture_id ?? ""),
                });
              }
            }
          }
        }
        this.onLog("opticodds stream ended");
      } catch (e) {
        if (!this.stopped) this.onLog(`opticodds err ${String(e).slice(0, 90)}`);
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  close(): void {
    this.stopped = true;
    try {
      this.ac?.abort();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Polymarket — gamma discovery, CLOB ladder WS, sports-api score WS
// ---------------------------------------------------------------------------
const GAMMA = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";

export interface PmEvent {
  slug: string;
  title: string;
  sideA: string;
  sideB: string;
  gameId: string;
  yesTokenId: string;
  noTokenId: string;
  yesOutcome: string;
  noOutcome: string;
  live: boolean;
  bestBid: number | null;
  bestAsk: number | null;
}

function parseJsonArray(s: any): string[] {
  if (Array.isArray(s)) return s.map(String);
  try {
    const v = JSON.parse(String(s ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function eventToPm(e: any): PmEvent | null {
  const markets = e.markets ?? [];
  // main match winner = market whose question equals the event title (skip "Completed Match")
  const main =
    markets.find((m: any) => m.question === e.title && !/completed/i.test(m.question ?? "")) ??
    markets.find((m: any) => !/completed/i.test(m.question ?? ""));
  if (!main) return null;
  const tokenIds = parseJsonArray(main.clobTokenIds);
  const outcomes = parseJsonArray(main.outcomes);
  if (tokenIds.length < 2) return null;
  const title = String(e.title ?? "");
  const sides = vsSides(title);
  if (!sides) return null;
  const num = (x: any) => (x == null || x === "" ? null : Number(x));
  return {
    slug: String(e.slug ?? ""),
    title,
    sideA: sides[0],
    sideB: sides[1],
    gameId: String(e.eventMetadata?.gameId ?? e.gameId ?? ""),
    yesTokenId: tokenIds[0],
    noTokenId: tokenIds[1],
    yesOutcome: outcomes[0] ?? "Yes",
    noOutcome: outcomes[1] ?? "No",
    live: e.live === true,
    bestBid: num(main.bestBid),
    bestAsk: num(main.bestAsk),
  };
}

/**
 * Fetch tennis events by tag. We do NOT filter by startDate (gamma startDate is
 * often stale for in-play matches) — liveness is established by the Flashscore-live
 * anchor at match time. Liquidity (bestBid/live) is captured so callers can prefer
 * actually-trading markets.
 */
export async function pmTennisEvents(limit = 250): Promise<PmEvent[]> {
  const url = `${GAMMA}/events?tag_slug=tennis&active=true&closed=false&limit=${limit}&order=startDate&ascending=false`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const data: any = await res.json().catch(() => []);
  const evs = Array.isArray(data) ? data : (data.events ?? []);
  const out: PmEvent[] = [];
  for (const e of evs) {
    const pm = eventToPm(e);
    if (pm) out.push(pm);
  }
  return out;
}

/** Fetch a single PM event by slug (used to force-target a specific match). */
export async function pmEventBySlug(slug: string): Promise<PmEvent | null> {
  const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!res.ok) return null;
  const data: any = await res.json().catch(() => null);
  const e = Array.isArray(data) ? data[0] : (data?.events ?? [])[0];
  return e ? eventToPm(e) : null;
}

export interface Level {
  price: number;
  size: number;
}
export interface BookTop {
  bestBid: number;
  bestBidSize: number;
  bestAsk: number;
  bestAskSize: number;
}

/** Polymarket CLOB market data WS. Tracks top-of-book per token, calls onTop on change. */
export class PmLadderClient {
  private ws?: WebSocket;
  private ping?: NodeJS.Timeout;
  private books = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();
  private lastTop = new Map<string, string>();
  constructor(
    private tokenIds: string[],
    private onTop: (tokenId: string, top: BookTop) => void,
    private onLog: (msg: string) => void = () => {},
    private onClose: () => void = () => {},
  ) {}

  private ensure(t: string) {
    let b = this.books.get(t);
    if (!b) {
      b = { bids: new Map(), asks: new Map() };
      this.books.set(t, b);
    }
    return b;
  }

  private top(t: string): BookTop | null {
    const b = this.books.get(t);
    if (!b) return null;
    let bestBid = 0;
    let bestBidSize = 0;
    let bestAsk = 0;
    let bestAskSize = 0;
    for (const [p, s] of b.bids) if (s > 0 && p > bestBid) [bestBid, bestBidSize] = [p, s];
    for (const [p, s] of b.asks)
      if (s > 0 && (bestAsk === 0 || p < bestAsk)) [bestAsk, bestAskSize] = [p, s];
    return { bestBid, bestBidSize, bestAsk, bestAskSize };
  }

  private emit(t: string) {
    const top = this.top(t);
    if (!top) return;
    const key = `${top.bestBid}:${top.bestBidSize}:${top.bestAsk}:${top.bestAskSize}`;
    if (this.lastTop.get(t) === key) return;
    this.lastTop.set(t, key);
    this.onTop(t, top);
  }

  connect(): void {
    const url =
      process.env.POLYMARKET_MARKET_WS_URL ??
      "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      ws.send(JSON.stringify({ assets_ids: this.tokenIds, type: "market" }));
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10000);
      this.onLog(`pm ladder subscribed ${this.tokenIds.length} tokens`);
    });
    ws.on("message", (raw) => {
      const s = raw.toString();
      if (s === "PONG") return;
      let data: any;
      try {
        data = JSON.parse(s);
      } catch {
        return;
      }
      const msgs = Array.isArray(data) ? data : [data];
      for (const msg of msgs) {
        const type = msg.event_type ?? msg.type;
        if (type === "book" || (msg.asset_id && (msg.bids || msg.asks || msg.buys || msg.sells))) {
          const t = msg.asset_id;
          const b = this.ensure(t);
          b.bids.clear();
          b.asks.clear();
          for (const l of msg.bids ?? msg.buys ?? [])
            b.bids.set(Number(l.price), Number(l.size));
          for (const l of msg.asks ?? msg.sells ?? [])
            b.asks.set(Number(l.price), Number(l.size));
          this.emit(t);
        }
        const changes = msg.price_changes ?? msg.changes ?? [];
        for (const ch of changes) {
          const t = ch.asset_id ?? msg.asset_id;
          if (!t) continue;
          const b = this.ensure(t);
          const side = String(ch.side ?? "").toLowerCase();
          const price = Number(ch.price);
          const size = Number(ch.size);
          const map = side.startsWith("b") ? b.bids : b.asks;
          if (size <= 0) map.delete(price);
          else map.set(price, size);
          this.emit(t);
        }
      }
    });
    ws.on("error", (e) => this.onLog(`pm ladder err ${String(e).slice(0, 80)}`));
    ws.on("close", () => {
      this.onLog("pm ladder closed");
      this.onClose();
    });
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
  }
}

/** Polymarket sports-api score WS (broadcast). Routes frames to a handler. */
export class PmScoreClient {
  private ws?: WebSocket;
  private ping?: NodeJS.Timeout;
  constructor(
    private onFrame: (f: {
      score: string;
      period: string;
      league: string;
      gameId: string;
    }) => void,
    private onLog: (msg: string) => void = () => {},
    private onClose: () => void = () => {},
  ) {}

  connect(): void {
    const ws = new WebSocket("wss://sports-api.polymarket.com/ws", {
      headers: { Origin: "https://polymarket.com", "User-Agent": "Mozilla/5.0" },
    });
    this.ws = ws;
    ws.on("open", () => {
      ws.send("PING");
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 15000);
    });
    ws.on("message", (buf) => {
      const raw = buf.toString();
      if (raw === "PONG" || raw === "PING") return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const score = String(msg.score ?? "");
      if (!score) return;
      this.onFrame({
        score,
        period: String(msg.period ?? ""),
        league: String(msg.leagueAbbreviation ?? msg.league ?? ""),
        gameId: String(msg.metadataGameId ?? msg.gameId ?? ""),
      });
    });
    ws.on("error", (e) => this.onLog(`pm score err ${String(e).slice(0, 80)}`));
    ws.on("close", () => {
      this.onLog("pm score closed");
      this.onClose();
    });
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    try {
      this.ws?.close();
    } catch {}
  }
}
