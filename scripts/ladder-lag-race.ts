/**
 * Ladder-lag race (sport-agnostic): when a scoring event happens, do Polymarket's
 * secondary books (totals / spread) reprice SLOWER than the main moneyline — and
 * does bwin (fast sharp book) lead any of them by the millisecond?
 *
 * One clock:
 *   - PM CLOB ladder for moneyline + every full-game totals + spread ladder
 *   - bwin cds-push (Match Result / Totals / Handicap|Run Line) for the same fixture
 *   - bwin scoreboard + PM sports-api score WS for scoring-event ground truth
 *   - staleness watchdog reconnect; auto-stops at game end
 *
 * Usage:
 *   MLB:    PLR_MODE=mlb    PLR_SLUG=mlb-al-nl-2026-07-14        npx tsx scripts/ladder-lag-race.ts record
 *   Soccer: PLR_MODE=soccer PLR_SLUG=fifwc-eng-arg-2026-07-15    npx tsx scripts/ladder-lag-race.ts record
 *   Analyze: npx tsx scripts/ladder-lag-race.ts analyze [file]
 *
 * Paper middle-arb (default ON per sport; disable with PLR_PAPER_MIDDLES=0):
 *   Soccer — T+1 shock cache + filters → data/soccer-middle-arb-paper-*.jsonl
 *   MLB    — Strat2 score-trigger + PA-weighted RBI menu shadow → data/mlb-middle-arb-paper-*.jsonl
 *            Confirm/hunt still Strat2 on realized RBI; PA priors weight pre-confirm branches.
 *   (no orders)
 *
 * Env: PLR_SLUG (required), PLR_MODE (mlb|soccer, default mlb),
 *      PLR_DURATION_MS (4h cap), PLR_BWIN_SPORT (auto by mode), PLR_BWIN_FIXTURE (override),
 *      PLR_MORE_SLUG (default `${SLUG}-more-markets`), PLR_STALE_MS (25000),
 *      PLR_PAPER_MIDDLES (default on for soccer|mlb),
 *      PLR_MLB_PA_RBI_PRIOR_PATH (default analysis/per-plate-rbi-p-backtest.json),
 *      PLR_MLB_PAPER_ALL_SHAPES=1 (cache every structural total/spread middle, not +ROI only),
 *      PLR_MLB_STATSAPI_POLL_MS (default 2000), PLR_MLB_POST_SCORE_TRACK_MS (default 15000),
 *      PLR_KALSHI=1 (MLB only: stream Kalshi total rungs via WS; needs API creds),
 *      PLR_KALSHI_EVENT (optional Kalshi totals event ticker; else discover from PLR_SLUG),
 *      PLR_SCORE_PING_PORT (MLB: HTTP phone tap UI + POST /ping → phone_ping race source),
 *      PLR_SCORE_PING_TOKEN / PLR_SCORE_PING_BIND (optional auth token / bind host),
 *      PLR_AWAY_LABEL / PLR_HOME_LABEL (optional stadium button labels; default slug codes)
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, DATA_DIR, ensureParent } from "./lib/paths.js";
import { appendJsonl, readJson, readJsonl, writeJson } from "./lib/storage.js";
import {
  BwinPushClient,
  PmLadderClient,
  PmScoreClient,
  OpticOddsClient,
  bwinLiveFixtures,
} from "./lib/latency-feeds.js";
import {
  mlbPaperMiddlesEnabled,
  MlbMiddleArbPaperSidecar,
} from "./lib/mlb-middle-arb-paper.js";
import {
  paperMiddlesEnabled,
  SoccerMiddleArbPaperSidecar,
} from "./lib/soccer-middle-arb-paper.js";
import {
  KalshiMlbSpreadsFeed,
  KalshiMlbTotalsFeed,
  type KalshiMlbLadderRow,
} from "./lib/kalshi-mlb-ws-feed.js";
import { startPhoneScorePingServer } from "./lib/phone-score-ping-server.js";

type PaperSidecar = SoccerMiddleArbPaperSidecar | MlbMiddleArbPaperSidecar;

const SLUG = process.env.PLR_SLUG ?? "";
const MODE = (process.env.PLR_MODE ?? "mlb").toLowerCase(); // "mlb" | "soccer"
const PLR_KALSHI = process.env.PLR_KALSHI === "1" && MODE === "mlb";
const PLR_KALSHI_EVENT = process.env.PLR_KALSHI_EVENT ?? "";
const PLR_SCORE_PING_PORT = Number(process.env.PLR_SCORE_PING_PORT ?? 0);
const PLR_SCORE_PING_BIND = process.env.PLR_SCORE_PING_BIND ?? "0.0.0.0";
const DURATION_MS = Number(process.env.PLR_DURATION_MS ?? 14_400_000); // 4h cap; stops early on game end
const BWIN_SPORT = Number(process.env.PLR_BWIN_SPORT ?? (MODE === "soccer" ? 4 : MODE === "tennis" ? 5 : 23));
const MORE_SLUG = process.env.PLR_MORE_SLUG ?? `${SLUG}-more-markets`;
const GAMMA = "https://gamma-api.polymarket.com";

// OpticOdds SSE relay (trial). Streams sharp books + polymarket itself so we can
// measure OpticOdds' relay lag against our direct PM/bwin sockets.
const OPTIC_KEY = process.env.OPTICODDS_API_KEY ?? process.env.PLR_OPTIC_KEY ?? "9fcea6f9-44ca-4f2f-98d7-d62e7253cf01";
const OPTIC_SPORT = process.env.PLR_OPTIC_SPORT ?? (MODE === "soccer" ? "soccer" : MODE === "tennis" ? "tennis" : MODE === "wnba" ? "basketball" : "baseball");
const OPTIC_BOOKS = (process.env.PLR_OPTIC_BOOKS ?? "pinnacle,bwin,draftkings,fanduel,polymarket").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5);
const OPTIC_MARKETS: Record<string, string[]> = {
  soccer: ["Moneyline 3-Way", "Total Goals", "Goal Spread", "Asian Handicap", "Asian Total Goals"],
  baseball: ["Moneyline", "Run Line", "Total Runs"],
  basketball: ["Moneyline", "Point Spread", "Total Points"],
  tennis: ["Moneyline", "Total Games", "Game Spread"],
};
function classifyOpticMarket(marketId: string): "moneyline" | "total" | "spread" | "other" {
  if (/^moneyline/.test(marketId)) return "moneyline";
  if (/total_goals|total_runs|total_points|total_games|asian_total/.test(marketId)) return "total";
  if (/goal_spread|run_line|point_spread|game_spread|asian_handicap/.test(marketId)) return "spread";
  return "other";
}

const now = () => Date.now();
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const t0Wall = now();
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} [+${((now() - t0Wall) / 1000).toFixed(1)}s] ${m}`);

interface TokenMeta {
  market: string; // "moneyline" | "total_8.5" | "spread_national_-1.5" | ...
  klass: "moneyline" | "total" | "spread";
  side: "yes" | "no";
  line: number | null;
}

async function fetchEvent(slug: string): Promise<any> {
  const res = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`, { headers: { "user-agent": "Mozilla/5.0" } });
  const data: any = await res.json();
  return Array.isArray(data) ? data[0] : (data?.events ?? [])[0];
}

// Merge the main event with its "-more-markets" sibling (soccer totals/spreads live there).
async function fetchMerged(): Promise<{ title: string; live: boolean; gameId: string; opticFixtureId: string; markets: any[] }> {
  const main = await fetchEvent(SLUG);
  if (!main) throw new Error(`no PM event for slug ${SLUG}`);
  let markets = [...(main.markets ?? [])];
  if (MODE === "soccer") {
    try {
      const more = await fetchEvent(MORE_SLUG);
      if (more?.markets) markets = markets.concat(more.markets);
    } catch {}
  }
  const gameId = String(main.gameId ?? main.markets?.[0]?.gameId ?? "");
  // PM embeds the OpticOdds fixture id in market metadata — exact cross-venue join.
  const opticFixtureId = String(markets.map((m) => m?.marketMetadata?.opticOddsFixtureId).find(Boolean) ?? "");
  return { title: String(main.title ?? ""), live: !!main.live, gameId, opticFixtureId, markets };
}

// "England vs. Argentina" -> ["england","argentina"]; "American League at National League" -> [...]
function teamTokens(title: string): string[] {
  return title
    .split(/\s+(?:vs\.?|at|@|v)\s+/i)
    .map((s) => s.replace(/[^a-z ]/gi, "").trim().toLowerCase())
    .filter(Boolean);
}

// Select markets worth racing (mode-aware): moneyline + full-game totals + spreads.
function selectMarkets(title: string, markets: any[]): { tokenMeta: Map<string, TokenMeta>; picked: string[] } {
  const tokenMeta = new Map<string, TokenMeta>();
  const picked: string[] = [];
  for (const m of markets) {
    if (m.closed) continue;
    const q = String(m.question ?? "");
    let toks: string[] = [];
    try {
      toks = JSON.parse(m.clobTokenIds ?? "[]");
    } catch {}
    if (toks.length < 2) continue;
    const bestBid = m.bestBid == null ? null : Number(m.bestBid);
    const bestAsk = m.bestAsk == null ? null : Number(m.bestAsk);
    const priced = bestBid != null && bestAsk != null && bestAsk - bestBid <= 0.25 && bestBid >= 0.05 && bestBid <= 0.95;

    // ---- moneyline ----
    let mlKey: string | null = null;
    if (MODE === "soccer") {
      const win = /^Will\s+(.+?)\s+win\b/i.exec(q);
      const draw = /end in a draw/i.test(q);
      if (win) mlKey = `ml_${win[1].trim().toLowerCase().replace(/\s+/g, "-")}`;
      else if (draw) mlKey = "ml_draw";
    } else if ((q === title || q === `${title}?`) && !/completed match/i.test(q)) {
      mlKey = "moneyline";
    }
    if (mlKey) {
      picked.push(mlKey);
      tokenMeta.set(toks[0], { market: mlKey, klass: "moneyline", side: "yes", line: null });
      tokenMeta.set(toks[1], { market: mlKey, klass: "moneyline", side: "no", line: null });
      continue;
    }

    // ---- totals ----
    // Tennis totals carry a qualifier before O/U ("Match O/U 21.5", "Total Sets O/U 2.5").
    const tennisMatchGames = MODE === "tennis" ? /Match O\/U\s+(\d+(?:\.\d+)?)/i.exec(q) : null;
    const tennisSets = MODE === "tennis" ? /Total Sets O\/U\s+(\d+(?:\.\d+)?)/i.exec(q) : null;
    // Full-game total (soccer/mlb): O/U right after the colon, excluding halves/1st-5.
    const fullTotal = /:\s*O\/U\s+(\d+(?:\.\d+)?)/i.exec(q);
    const totalMatch = tennisMatchGames
      ? { line: Number(tennisMatchGames[1]), key: `total_games_${tennisMatchGames[1]}` }
      : tennisSets
        ? { line: Number(tennisSets[1]), key: `total_sets_${tennisSets[1]}` }
        : fullTotal && !/1st 5|1st half|2nd half|first half|second half|set \d/i.test(q)
          ? { line: Number(fullTotal[1]), key: `total_${fullTotal[1]}` }
          : null;
    if (totalMatch) {
      picked.push(`${totalMatch.key}${priced ? "" : "(wide)"}`);
      tokenMeta.set(toks[0], { market: totalMatch.key, klass: "total", side: "yes", line: totalMatch.line });
      tokenMeta.set(toks[1], { market: totalMatch.key, klass: "total", side: "no", line: totalMatch.line });
      continue;
    }

    // ---- spread / handicap ----
    const fullSpread = /^(?:Spread|Set Handicap|Games Handicap):\s*(.+?)\s*\(([+-]?\d+(?:\.\d+)?)\)/i.exec(q);
    if (fullSpread && !/1st 5|1st half|2nd half/i.test(q)) {
      const team = fullSpread[1].trim().toLowerCase().replace(/\s+/g, "-");
      const line = Number(fullSpread[2]);
      const key = `spread_${team}_${line}`;
      picked.push(`${key}${priced ? "" : "(wide)"}`);
      tokenMeta.set(toks[0], { market: key, klass: "spread", side: "yes", line });
      tokenMeta.set(toks[1], { market: key, klass: "spread", side: "no", line });
    }
  }
  return { tokenMeta, picked };
}

function classifyBwinMarket(name: string): "moneyline" | "total" | "spread" | "other" {
  if (/run\s*line|handicap|spread/i.test(name)) return "spread";
  if (/money\s*line|match\s*(result|winner|betting)|full.?time result|to\s*win(?!ner of set)|1x2|winner|result$/i.test(name)) return "moneyline";
  if (/total|over\/under|o\/u|goals|games/i.test(name)) return "total";
  return "other";
}

async function record(): Promise<void> {
  if (!SLUG) throw new Error("set PLR_SLUG=<polymarket slug>");
  const ev = await fetchMerged();
  const { tokenMeta, picked } = selectMarkets(ev.title, ev.markets);
  log(`PM "${ev.title}" (${MODE}) live=${ev.live} gameId=${ev.gameId} | tracking ${tokenMeta.size} tokens across: ${picked.join(", ")}`);
  const tokens = [...tokenMeta.keys()];
  if (!tokens.length) throw new Error("no markets to track");

  const outPath = join(DATA_DIR, `ladder-lag-race-${ts()}.jsonl`);
  ensureParent(outPath);
  writeJson(join(DATA_DIR, "ladder-lag-race-latest.json"), { path: outPath });
  const emit = (o: any) => appendJsonl(outPath, { v: 1, t: now(), ...o });

  let paper: PaperSidecar | null = null;
  let paperPath: string | null = null;
  let scorePing: ReturnType<typeof startPhoneScorePingServer> | null = null;
  const wantSoccerPaper = MODE === "soccer" && paperMiddlesEnabled(MODE);
  const wantMlbPaper = MODE === "mlb" && mlbPaperMiddlesEnabled(MODE);
  if (wantSoccerPaper || wantMlbPaper) {
    const paperPrefix = wantMlbPaper ? "mlb-middle-arb-paper" : "soccer-middle-arb-paper";
    paperPath = join(DATA_DIR, `${paperPrefix}-${ts()}.jsonl`);
    ensureParent(paperPath);
    writeJson(join(DATA_DIR, `${paperPrefix}-latest.json`), {
      path: paperPath,
      slug: SLUG,
      ladderPath: outPath,
    });
    const paperEmit = (o: Record<string, unknown>) => {
      const row = { v: 1, t: now(), ...o };
      appendJsonl(paperPath!, row);
      const kind = String(o.kind ?? "");
      if (
        kind.includes("paper_middle")
        || kind.includes("mlb_paper")
      ) {
        emit(row);
      }
    };
    try {
      if (wantMlbPaper) {
        paper = new MlbMiddleArbPaperSidecar({
          eventSlug: SLUG,
          eventTitle: ev.title,
          emit: paperEmit,
          log,
        });
      } else {
        paper = new SoccerMiddleArbPaperSidecar({
          eventSlug: SLUG,
          moreSlug: MORE_SLUG,
          eventTitle: ev.title,
          emit: paperEmit,
          log,
        });
      }
      await paper.init();
    } catch (e) {
      log(`paper-middles: init failed: ${String(e).slice(0, 120)} — continuing without paper`);
      paper = null;
    }
  }

  if (PLR_SCORE_PING_PORT > 0 && paper instanceof MlbMiddleArbPaperSidecar) {
    // Prefer slug codes (mlb-lad-nyy-…) for short stadium button labels.
    const slugBits = SLUG.split("-");
    const awayCode = (slugBits[1] ?? "away").toUpperCase();
    const homeCode = (slugBits[2] ?? "home").toUpperCase();
    const awayLabel = (process.env.PLR_AWAY_LABEL ?? awayCode).trim() || awayCode;
    const homeLabel = (process.env.PLR_HOME_LABEL ?? homeCode).trim() || homeCode;
    scorePing = startPhoneScorePingServer(paper, {
      port: PLR_SCORE_PING_PORT,
      bind: PLR_SCORE_PING_BIND,
      token: process.env.PLR_SCORE_PING_TOKEN,
      awayLabel,
      homeLabel,
      slug: SLUG,
      log,
      onEmit: (row) => emit(row),
    });
    const localUrl = `http://127.0.0.1:${PLR_SCORE_PING_PORT}/?token=${scorePing.token}`;
    writeJson(join(DATA_DIR, "phone-score-ping-latest.json"), {
      slug: SLUG,
      title: ev.title,
      awayLabel,
      homeLabel,
      port: PLR_SCORE_PING_PORT,
      bind: PLR_SCORE_PING_BIND,
      token: scorePing.token,
      url: localUrl,
      startedAt: new Date().toISOString(),
    });
    log(`phone-score-ping READY ${awayLabel} @ ${homeLabel} → ${localUrl}`);
  } else if (PLR_SCORE_PING_PORT > 0) {
    log(`phone-score-ping: port set but MLB paper sidecar unavailable — skipping`);
  }

  emit({ kind: "target", slug: SLUG, mode: MODE, title: ev.title, gameId: ev.gameId, opticFixtureId: ev.opticFixtureId, opticBooks: OPTIC_BOOKS, markets: picked, tokenMeta: [...tokenMeta.entries()].map(([tok, m]) => ({ tok, ...m })), paperMiddles: !!paper, paperPath, kalshi: PLR_KALSHI, scorePingPort: PLR_SCORE_PING_PORT || null });

  let kalshiFeed: KalshiMlbTotalsFeed | null = null;
  let kalshiSpreadFeed: KalshiMlbSpreadsFeed | null = null;
  let kalshiRetryTimer: ReturnType<typeof setInterval> | null = null;
  const onKalshiTick = (row: KalshiMlbLadderRow) => {
    emit(row);
    if (paper instanceof MlbMiddleArbPaperSidecar) {
      paper.onKalshiLadder({ ...row, t: now() });
    }
  };
  const startKalshiFeed = async (): Promise<boolean> => {
    if (!PLR_KALSHI) return false;
    let ok = !!kalshiFeed;
    if (!kalshiFeed) {
      try {
        const discovered = await KalshiMlbTotalsFeed.discover(
          PLR_KALSHI_EVENT ? { eventTicker: PLR_KALSHI_EVENT } : { pmSlug: SLUG },
        );
        const feed = new KalshiMlbTotalsFeed({
          eventTicker: discovered.eventTicker,
          rungs: discovered.rungs,
          onTick: onKalshiTick,
          onReconnect: (reason) => {
            emit({ kind: "reconnect", reason, feed: "kalshi_ladder" });
            log(`kalshi ${reason} — reconnecting`);
          },
        });
        await feed.start();
        kalshiFeed = feed;
        emit({
          kind: "kalshi_init",
          eventTicker: discovered.eventTicker,
          rungs: [...discovered.rungs.entries()].map(([line, ticker]) => ({ line, ticker })),
        });
        log(`kalshi WS ${discovered.eventTicker} rungs=${discovered.rungs.size}`);
        ok = true;
      } catch (e) {
        log(`kalshi WS unavailable: ${String(e).slice(0, 180)} — will retry`);
        ok = false;
      }
    }
    if (!kalshiSpreadFeed) {
      try {
        const discovered = await KalshiMlbSpreadsFeed.discover({
          totalsEventTicker: kalshiFeed?.eventTicker || PLR_KALSHI_EVENT || undefined,
          spreadEventTicker: process.env.PLR_KALSHI_SPREAD_EVENT,
          pmSlug: SLUG,
          eventTitle: ev.title,
        });
        const feed = new KalshiMlbSpreadsFeed({
          eventTicker: discovered.eventTicker,
          rungs: discovered.rungs,
          onTick: onKalshiTick,
          onReconnect: (reason) => {
            emit({ kind: "reconnect", reason, feed: "kalshi_spread" });
            log(`kalshi-spread ${reason} — reconnecting`);
          },
        });
        await feed.start();
        kalshiSpreadFeed = feed;
        emit({
          kind: "kalshi_spread_init",
          eventTicker: discovered.eventTicker,
          rungs: discovered.rungs.map((r) => ({
            ticker: r.ticker,
            teamKey: r.teamKey,
            teamAbbr: r.teamAbbr,
            strike: r.strike,
          })),
        });
        log(
          `kalshi-spread WS ${discovered.eventTicker} rungs=${discovered.rungs.length} `
          + `teams=${new Set(discovered.rungs.map((r) => r.teamKey)).size}`,
        );
      } catch (e) {
        log(`kalshi-spread WS unavailable: ${String(e).slice(0, 180)} — will retry`);
        ok = false;
      }
    }
    if (ok && kalshiFeed && kalshiSpreadFeed && kalshiRetryTimer) {
      clearInterval(kalshiRetryTimer);
      kalshiRetryTimer = null;
    }
    return !!(kalshiFeed && kalshiSpreadFeed);
  };
  if (PLR_KALSHI) {
    const ok = await startKalshiFeed();
    if (!ok) {
      const retryMs = Number(process.env.PLR_KALSHI_RETRY_MS ?? 120_000);
      kalshiRetryTimer = setInterval(() => {
        void startKalshiFeed();
      }, retryMs);
    }
  }

  // Per-feed freshness — other feeds must NOT keep a dead PM ladder "alive".
  // Generation tokens: intentional close bumps gen so the OLD socket's async
  // "close" event is ignored (prevents the HT reconnect storm).
  let lastPm = now();
  let lastBwin = now();
  let lastOptic = now();
  let lastScore = now();
  let lastPmReconnect = 0;
  let lastBwinReconnect = 0;
  let lastOpticReconnect = 0;
  let lastScoreReconnect = 0;
  let pmGen = 0;
  let bwinGen = 0;
  let scoreGen = 0;
  let shuttingDown = false;
  const RECONNECT_COOLDOWN_MS = 5_000;

  // ---- PM CLOB ladders (moneyline + totals + spreads) ----
  const lastMid = new Map<string, number>();
  let pm: PmLadderClient;
  const reconnectPm = (reason: string) => {
    if (shuttingDown) return;
    if (now() - lastPmReconnect < RECONNECT_COOLDOWN_MS) return;
    lastPmReconnect = now();
    emit({ kind: "reconnect", reason, feed: "pm_ladder", staleMs: now() - lastPm });
    log(`PM ladder ${reason} (stale ${((now() - lastPm) / 1000).toFixed(1)}s) — reconnecting`);
    pmGen++; // invalidate in-flight close from the socket we're killing
    try { pm.close(); } catch {}
    pm = makePm();
    pm.connect();
    lastPm = now();
  };
  const makePm = () => {
    const gen = pmGen;
    return new PmLadderClient(
      tokens,
      (tokenId, top) => {
        if (gen !== pmGen) return;
        const meta = tokenMeta.get(tokenId);
        if (!meta) return;
        lastPm = now();
        const mid = top.bestBid > 0 && top.bestAsk > 0 ? (top.bestBid + top.bestAsk) / 2 : top.bestBid || top.bestAsk;
        const ladderRow = {
          kind: "ladder" as const,
          market: meta.market,
          klass: meta.klass,
          side: meta.side,
          line: meta.line,
          mid,
          bestBid: top.bestBid,
          bestAsk: top.bestAsk,
          bestBidSize: top.bestBidSize,
          bestAskSize: top.bestAskSize,
        };
        emit(ladderRow);
        paper?.onLadder({ ...ladderRow, t: now() });
        lastMid.set(tokenId, mid); // paper consumes same ladder ticks
      },
      log,
      () => { if (gen === pmGen && !shuttingDown) reconnectPm("socket_closed"); },
    );
  };
  pm = makePm();
  pm.connect();

  // ---- bwin fixture (match by PM team names) ----
  let bwinFixtureId = process.env.PLR_BWIN_FIXTURE ?? "";
  const teams = teamTokens(ev.title);
  // Match on team nicknames in the fixture *name* only. The old any-word-in-
  // name+players substring match once bound STL@LAA to a TB@TOR fixture
  // (player-name collision), poisoning the paper score feed.
  const nickname = (t: string): string =>
    t.split(" ").filter((w) => w.length >= 3).pop() ?? t;
  const matchesTeams = (f: { name: string; players: string[] }): boolean => {
    const name = f.name.toLowerCase();
    return teams.length >= 2 && teams.every((t) => name.includes(nickname(t)));
  };
  const lastOdds = new Map<string, string>();
  let bwin: BwinPushClient | null = null;
  const reconnectBwin = (reason: string) => {
    if (!bwinFixtureId || shuttingDown) return;
    if (now() - lastBwinReconnect < RECONNECT_COOLDOWN_MS) return;
    lastBwinReconnect = now();
    emit({ kind: "reconnect", reason, feed: "bwin", staleMs: now() - lastBwin });
    log(`bwin ${reason} (stale ${((now() - lastBwin) / 1000).toFixed(1)}s) — reconnecting`);
    bwinGen++;
    try { bwin?.close(); } catch {}
    bwin = makeBwin();
    bwin.connect();
    lastBwin = now();
  };
  const makeBwin = () => {
    const gen = bwinGen;
    return new BwinPushClient(
      [bwinFixtureId],
      (_fx, payload, messageType) => {
        if (gen !== bwinGen) return;
        lastBwin = now();
        if (messageType === "ScoreboardSlim") {
          const raw = JSON.stringify(payload).slice(0, 1600);
          emit({ kind: "bwin_score", raw });
          paper?.onBwinScore(payload, now());
          return;
        }
        const g = payload.game ?? payload.optionMarket ?? payload;
        const marketName = g?.name?.value ?? "";
        if (/delete/i.test(messageType)) {
          emit({ kind: "odds", source: "bwin", market: marketName, klass: classifyBwinMarket(marketName), event: "market_delete" });
          return;
        }
        const marketVisible = (g?.visibility ?? "Visible") === "Visible";
        const results = g?.results ?? g?.options ?? [];
        for (const o of results) {
          const odds = o?.odds ?? o?.price?.odds;
          if (odds == null) continue;
          const suspended = !marketVisible || (o?.visibility != null ? o.visibility !== "Visible" : !!o?.isSuspended);
          const id = `${g?.id}:${o?.id}`;
          const cur = `${odds}:${suspended ? 1 : 0}`;
          if (lastOdds.get(id) !== cur) {
            lastOdds.set(id, cur);
            emit({
              kind: "odds",
              source: "bwin",
              market: marketName,
              klass: classifyBwinMarket(marketName),
              option: o?.name?.value ?? "",
              odds,
              suspended,
            });
          }
        }
      },
      log,
      () => { if (gen === bwinGen && !shuttingDown) reconnectBwin("socket_closed"); },
    );
  };
  // Games launched pregame aren't on bwin's live list yet, so keep retrying
  // discovery until the fixture appears (it lists at first pitch).
  let bwinRetryTimer: ReturnType<typeof setInterval> | null = null;
  const discoverBwin = async (): Promise<void> => {
    if (bwinFixtureId || shuttingDown) return;
    try {
      const fx = await bwinLiveFixtures(BWIN_SPORT);
      const hit = fx.find(matchesTeams);
      if (hit) {
        bwinFixtureId = hit.id;
        log(`bwin fixture ${hit.id} ${hit.name}`);
        bwin = makeBwin();
        bwin.connect();
        lastBwin = now();
      }
    } catch (e) {
      log(`bwin discovery failed: ${String(e).slice(0, 60)}`);
    }
    if (bwinFixtureId && bwinRetryTimer) {
      clearInterval(bwinRetryTimer);
      bwinRetryTimer = null;
    }
  };
  if (bwinFixtureId) {
    bwin = makeBwin();
    bwin.connect();
  } else {
    await discoverBwin();
    if (!bwinFixtureId) {
      const retryMs = Number(process.env.PLR_BWIN_RETRY_MS ?? 120_000);
      log(`bwin: fixture for [${teams.join(" / ")}] not live yet — retrying every ${retryMs / 1000}s`);
      bwinRetryTimer = setInterval(() => { void discoverBwin(); }, retryMs);
    }
  }

  // ---- OpticOdds SSE relay (sharp books + PM itself, for relay-lag measurement) ----
  const lastOpticTick = new Map<string, string>();
  let optic: OpticOddsClient | null = null;
  const reconnectOptic = (reason: string) => {
    if (!ev.opticFixtureId || !OPTIC_KEY || shuttingDown) return;
    if (now() - lastOpticReconnect < RECONNECT_COOLDOWN_MS) return;
    lastOpticReconnect = now();
    emit({ kind: "reconnect", reason, feed: "opticodds", staleMs: now() - lastOptic });
    log(`opticodds ${reason} (stale ${((now() - lastOptic) / 1000).toFixed(1)}s) — recycling`);
    try { optic?.close(); } catch {}
    optic = makeOptic();
    optic.connect();
    lastOptic = now();
  };
  const makeOptic = () =>
    new OpticOddsClient(
      { key: OPTIC_KEY, sport: OPTIC_SPORT, fixtureId: ev.opticFixtureId, sportsbooks: OPTIC_BOOKS, markets: OPTIC_MARKETS[OPTIC_SPORT] },
      (row) => {
        lastOptic = now();
        const id = `${row.sportsbook}:${row.marketId}:${row.selection}:${row.selectionLine}:${row.points}`;
        const cur = `${row.price}:${row.eventType}`;
        if (lastOpticTick.get(id) === cur) return;
        lastOpticTick.set(id, cur);
        emit({
          kind: "odds",
          source: `optic_${row.sportsbook}`,
          market: `${row.market}${row.points != null ? ` ${row.points}` : ""}`,
          klass: classifyOpticMarket(row.marketId),
          option: `${row.selection}${row.selectionLine ? ` ${row.selectionLine}` : ""}`,
          odds: row.price,
          suspended: row.eventType === "locked-odds",
          isMain: row.isMain,
          srcTs: row.srcTsMs,
        });
      },
      log,
    );
  if (ev.opticFixtureId && OPTIC_KEY) {
    log(`opticodds fixture ${ev.opticFixtureId} books=${OPTIC_BOOKS.join(",")}`);
    optic = makeOptic();
    optic.connect();
  } else {
    log("opticodds: no fixture id in PM metadata — skipping");
  }

  // ---- PM sports-api score WS (scoring-event ground truth) ----
  // The sports-api streams ALL live games, so filter strictly by our event gameId to
  // avoid leaking other games into the record. If gameId is unknown, record nothing
  // from the score feed (bwin scoreboard/odds still anchor scoring events).
  let scoreDiag = 0;
  let score: PmScoreClient;
  const reconnectScore = (reason: string) => {
    if (shuttingDown) return;
    if (now() - lastScoreReconnect < RECONNECT_COOLDOWN_MS) return;
    lastScoreReconnect = now();
    emit({ kind: "reconnect", reason, feed: "pm_score", staleMs: now() - lastScore });
    log(`pm score ${reason} (stale ${((now() - lastScore) / 1000).toFixed(1)}s) — reconnecting`);
    scoreGen++;
    try { score.close(); } catch {}
    score = makeScore();
    score.connect();
    lastScore = now();
  };
  const makeScore = () => {
    const gen = scoreGen;
    return new PmScoreClient(
      (f) => {
        if (gen !== scoreGen) return;
        // Any frame proves the score socket is alive (even other games).
        lastScore = now();
        if (!ev.gameId) return;
        if (f.gameId !== ev.gameId) {
          if (scoreDiag < 3) { log(`pm_score (other game) league=${f.league} gid=${f.gameId} score=${f.score}`); scoreDiag++; }
          return;
        }
        emit({ kind: "pm_score", score: f.score, period: f.period, league: f.league, gameId: f.gameId });
        paper?.onPmScore(f.score, f.period, now());
      },
      log,
      () => { if (gen === scoreGen && !shuttingDown) reconnectScore("socket_closed"); },
    );
  };
  score = makeScore();
  score.connect();

  log(`recording "${ev.title}" until game end (max ${(DURATION_MS / 1000).toFixed(0)}s) -> ${outPath}`);
  // Per-feed stale thresholds. Forgiving enough for HT quiet books; tight enough
  // that a dead PM ladder can't hide behind OpticOdds for minutes.
  const PM_STALE_MS = Number(process.env.PLR_PM_STALE_MS ?? 20_000);
  const BWIN_STALE_MS = Number(process.env.PLR_BWIN_STALE_MS ?? 90_000);
  const OPTIC_STALE_MS = Number(process.env.PLR_OPTIC_STALE_MS ?? 60_000);
  const SCORE_STALE_MS = Number(process.env.PLR_SCORE_STALE_MS ?? 90_000);
  const deadline = now() + DURATION_MS;
  let ended = false;

  let gameLive = true;
  let seenLive = false;
  let liveFalseSince: number | null = null;
  while (now() < deadline && !ended) {
    for (let i = 0; i < 12 && !ended; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      // Keep reconnecting even if gamma briefly flips live=false (HT glitch).
      // Only skip when we've decided the game is truly over.
      if (now() - lastPm > PM_STALE_MS) reconnectPm("stale");
      if (bwinFixtureId && now() - lastBwin > BWIN_STALE_MS) reconnectBwin("stale");
      if (ev.opticFixtureId && now() - lastOptic > OPTIC_STALE_MS) reconnectOptic("stale");
      if (now() - lastScore > SCORE_STALE_MS) reconnectScore("stale");
    }
    try {
      const cur = await fetchEvent(SLUG);
      gameLive = !!cur?.live;
      if (cur?.live) {
        seenLive = true;
        liveFalseSince = null;
      } else if (seenLive && cur && cur.live === false) {
        if (liveFalseSince == null) liveFalseSince = now();
      }
      // End only on closed, OR live=false for >=2min AND ladder also quiet for >=2min.
      // Prevents HT / gamma glitches from killing the 2H recording.
      const ladderQuiet = now() - lastPm > 120_000;
      const liveFalseLong = liveFalseSince != null && now() - liveFalseSince > 120_000;
      if (cur && (cur.closed === true || (liveFalseLong && ladderQuiet))) {
        log(`game ended on gamma (live=${cur.live} closed=${cur.closed} ladderQuiet=${ladderQuiet}); stopping`);
        ended = true;
      }
    } catch {}
  }
  emit({ kind: "end" });
  shuttingDown = true;
  try { scorePing?.close(); } catch {}
  try { paper?.end(); } catch {}
  if (paper) log(`paper-middles: done ${JSON.stringify(paper.stats)} -> ${paperPath}`);
  pmGen++; bwinGen++; scoreGen++;
  if (kalshiRetryTimer) {
    clearInterval(kalshiRetryTimer);
    kalshiRetryTimer = null;
  }
  if (bwinRetryTimer) {
    clearInterval(bwinRetryTimer);
    bwinRetryTimer = null;
  }
  try { kalshiFeed?.stop(); } catch {}
  try { kalshiSpreadFeed?.stop(); } catch {}
  try { pm.close(); } catch {}
  try { bwin?.close(); } catch {}
  try { optic?.close(); } catch {}
  try { score.close(); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  log("done");
  analyze(outPath);
}

// ------------------------------ analysis ------------------------------

interface Row {
  t: number;
  kind: string;
  source?: string;
  market?: string;
  klass?: string;
  side?: string;
  mid?: number;
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
  event?: string;
  suspended?: boolean;
  [k: string]: any;
}

function pctl(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}
const median = (xs: number[]) => pctl(xs, 50);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

const MID_MOVE = 0.01; // 1¢ persistent shift = a "real" PM reprice
const PERSIST = 0.008;
const WINDOW = 25_000;

// Series of "yes"-mid samples for a market, sorted by time.
function midSeries(rows: Row[], market: string): Array<{ t: number; mid: number; bidSz: number; askSz: number }> {
  return rows
    .filter((r) => r.kind === "ladder" && r.market === market && r.side === "yes" && (r.mid ?? 0) > 0)
    .map((r) => ({ t: r.t, mid: r.mid as number, bidSz: r.bestBidSize ?? 0, askSz: r.bestAskSize ?? 0 }))
    .sort((a, b) => a.t - b.t);
}

// Times at which a market makes a persistent >=MID_MOVE move (confirmed reprices).
function confirmedMoves(series: Array<{ t: number; mid: number }>): number[] {
  const out: number[] = [];
  let base = series[0]?.mid;
  let baseT = series[0]?.t ?? 0;
  for (const s of series) {
    if (base == null) {
      base = s.mid;
      baseT = s.t;
      continue;
    }
    if (Math.abs(s.mid - base) >= MID_MOVE) {
      // confirm it holds for 4s
      const holds = series.some((x) => x.t > s.t && x.t <= s.t + 4000 && Math.abs(x.mid - base!) >= PERSIST);
      if (holds) {
        out.push(s.t);
        base = s.mid;
        baseT = s.t;
      }
    } else if (s.t - baseT > 15000) {
      base = s.mid; // slow drift rebaseline
      baseT = s.t;
    }
  }
  return out;
}

function firstAfter(times: number[], t0: number, window = WINDOW): number | null {
  return times.find((t) => t >= t0 && t <= t0 + window) ?? null;
}

function analyze(file?: string): void {
  const path =
    file ??
    readJson<{ path?: string }>(join(DATA_DIR, "ladder-lag-race-latest.json"), {}).path ??
    (() => {
      const p = readdirSync(DATA_DIR).filter((f) => f.startsWith("ladder-lag-race-") && f.endsWith(".jsonl")).sort();
      return p.length ? join(DATA_DIR, p[p.length - 1]) : undefined;
    })();
  if (!path) return console.log("no recording file found");
  const rows = readJsonl<Row>(path);
  const target = rows.find((r) => r.kind === "target");
  log(`analyzing ${rows.length} rows from ${path}`);

  const pmMarkets = [...new Set(rows.filter((r) => r.kind === "ladder").map((r) => r.market!))];

  const klassOf = (mk: string): "moneyline" | "total" | "spread" =>
    mk.startsWith("total") ? "total" : mk.startsWith("spread") ? "spread" : "moneyline";

  // Representative moneyline = the moneyline-class market with the most updates
  // (single "moneyline" for MLB; the most active of ml_* for soccer 1X2).
  const mlMarkets = pmMarkets.filter((m) => klassOf(m) === "moneyline");
  const mlMarket = mlMarkets.map((m) => ({ m, n: midSeries(rows, m).length })).sort((a, b) => b.n - a.n)[0]?.m ?? "moneyline";
  const mlSeries = midSeries(rows, mlMarket);
  const mlMoves = confirmedMoves(mlSeries);

  // A total/spread ladder is "liquid" if it stayed near-the-money, tight, and ticked.
  const isLiquid = (mk: string): boolean => {
    if (klassOf(mk) === "moneyline") return true;
    const s = midSeries(rows, mk);
    if (s.length < 20) return false;
    const medMid = median(s.map((x) => x.mid));
    const spreads = rows.filter((r) => r.kind === "ladder" && r.market === mk && (r.bestBid ?? 0) > 0 && (r.bestAsk ?? 0) > 0).map((r) => (r.bestAsk as number) - (r.bestBid as number));
    return medMid >= 0.08 && medMid <= 0.92 && median(spreads) <= 0.15;
  };
  const liquidTotals = pmMarkets.filter((m) => m.startsWith("total") && isLiquid(m));
  const liquidSpreads = pmMarkets.filter((m) => m.startsWith("spread") && isLiquid(m));

  // Dedup a sorted list of timestamps into distinct "events" >= w ms apart.
  const dedupW = (xs: number[], w: number) => {
    const s = [...xs].sort((a, b) => a - b);
    const out: number[] = [];
    for (const t of s) if (!out.length || t - out[out.length - 1] > w) out.push(t);
    return out;
  };
  // RAW per-class bwin tick times at full ms resolution (never grouped) — used for
  // the true smallest-ms lead measurement.
  const bwinRawByClass: Record<string, number[]> = {
    moneyline: rows.filter((r) => r.kind === "odds" && r.source === "bwin" && r.klass === "moneyline").map((r) => r.t).sort((a, b) => a - b),
    total: rows.filter((r) => r.kind === "odds" && r.source === "bwin" && r.klass === "total").map((r) => r.t).sort((a, b) => a - b),
    spread: rows.filter((r) => r.kind === "odds" && r.source === "bwin" && r.klass === "spread").map((r) => r.t).sort((a, b) => a - b),
  };
  // FAST signal grouped into distinct events (only for counting / "signal -> next PM move").
  // Grouping window is configurable; default 100ms. It never affects the ms lead number.
  const GROUP_MS = Number(process.env.PLR_GROUP_MS ?? 100);
  const bwinFast = (klass: string) => dedupW(bwinRawByClass[klass] ?? [], GROUP_MS);
  const bwinFastByClass: Record<string, number[]> = {
    moneyline: bwinFast("moneyline"),
    total: bwinFast("total"),
    spread: bwinFast("spread"),
  };
  // bwin suspend/delete reactions (the "hard" signal), for reference.
  const bwinReact = (klass: string) =>
    dedupW(rows.filter((r) => r.kind === "odds" && r.source === "bwin" && r.klass === klass && (r.event === "market_delete" || r.suspended === true)).map((r) => r.t), 1500);

  // Per-market repricing profile + bwin<->PM millisecond mapping.
  const perMarket: any[] = [];
  for (const mk of pmMarkets) {
    const series = midSeries(rows, mk);
    if (!series.length) continue;
    const moves = confirmedMoves(series);
    const klass = klassOf(mk);
    const fastSig = bwinFastByClass[klass] ?? [];

    // (a) bwin fast signal -> next PM confirmed move (does a bwin tick precede a PM move?).
    const bwinToPm: number[] = [];
    for (const bt of fastSig) {
      const pt = firstAfter(moves, bt, 15_000);
      if (pt != null) bwinToPm.push((pt - bt) / 1000);
    }
    // (b) PM move <- nearest PRECEDING bwin tick, using RAW ms ticks for the true
    //     smallest-resolution lead (+ => bwin led PM, in ms).
    const rawSig = bwinRawByClass[klass] ?? [];
    const leadMs: number[] = [];
    let coveredByBwin = 0;
    for (const pt of moves) {
      let last: number | null = null;
      for (const bt of rawSig) {
        if (bt <= pt && pt - bt <= 20_000) last = bt;
        else if (bt > pt) break;
      }
      if (last != null) {
        leadMs.push(pt - last);
        coveredByBwin++;
      }
    }
    const depth = series.map((s) => Math.min(s.bidSz, s.askSz)).filter((x) => x > 0);
    perMarket.push({
      market: mk,
      klass,
      liquid: isLiquid(mk),
      updates: series.length,
      confirmedMoves: moves.length,
      medMid: r2(median(series.map((s) => s.mid))),
      bwinFastToPmMoveS: { n: bwinToPm.length, medianS: r2(median(bwinToPm)), p10S: r2(pctl(bwinToPm, 10)), p90S: r2(pctl(bwinToPm, 90)) },
      bwinLeadOnPmMoveMs: { n: leadMs.length, coveragePct: r2((coveredByBwin / Math.max(1, moves.length)) * 100), medianMs: r2(median(leadMs)), p10Ms: r2(pctl(leadMs, 10)), p90Ms: r2(pctl(leadMs, 90)) },
      touchDepthMedian: r2(median(depth)),
    });
  }
  const bwinMlTimes = bwinReact("moneyline");
  const bwinTotTimes = bwinReact("total");
  const bwinAnyReact = dedupW(rows.filter((r) => r.kind === "odds" && r.source === "bwin" && (r.event === "market_delete" || r.suspended === true)).map((r) => r.t), 1500);

  // Core question: does the totals ladder lag the moneyline on the SAME event?
  // Authoritative game events = scoring events (runs / goals). Two independent sources:
  //   (1) PM sports-api score WS ("X-Y") — primary for soccer & general.
  //   (2) bwin baseball scoreboard (player1/player2 "255") — MLB run totals.
  // We take the earliest sighting per event and dedup within 5s.
  const parseTotal = (s: string): number | null => {
    const m = /(\d+)\s*[-:]\s*(\d+)/.exec(s || "");
    return m ? Number(m[1]) + Number(m[2]) : null;
  };
  const rawScoreTimes: number[] = [];
  // (1) PM score feed
  let prevPm: number | null = null;
  for (const r of rows.filter((r) => r.kind === "pm_score").sort((a, b) => a.t - b.t)) {
    const tot = parseTotal((r as any).score ?? "");
    if (tot == null) continue;
    if (prevPm != null && tot > prevPm) rawScoreTimes.push(r.t);
    prevPm = tot;
  }
  // (2) bwin baseball scoreboard
  let prevRuns: number | null = null;
  for (const r of rows) {
    if (r.kind !== "bwin_score" || typeof r.raw !== "string") continue;
    const p1 = /player1"\s*:\s*\{[^}]*"255"\s*:\s*(\d+)/.exec(r.raw);
    const p2 = /player2"\s*:\s*\{[^}]*"255"\s*:\s*(\d+)/.exec(r.raw);
    if (!p1 || !p2) continue;
    const runs = Number(p1[1]) + Number(p2[1]);
    if (prevRuns != null && runs > prevRuns) rawScoreTimes.push(r.t);
    prevRuns = runs;
  }
  const runEvents = dedupW(rawScoreTimes, 5000); // "runEvents" == scoring events (runs/goals)

  // Run-anchored lag: after a run, does the totals ladder reprice later than the moneyline?
  const liquidTotMovesForLag = liquidTotals.flatMap((tm) => confirmedMoves(midSeries(rows, tm))).sort((a, b) => a - b);
  const totLagVsMl: number[] = []; // totalMoveT - mlMoveT (+ => totals moved AFTER moneyline)
  for (const rt of runEvents) {
    const mlT = firstAfter(mlMoves, rt);
    const toT = firstAfter(liquidTotMovesForLag, rt);
    if (mlT != null && toT != null) totLagVsMl.push((toT - mlT) / 1000);
  }

  // Common-anchor test: after a RUN scores, which PM market reprices first —
  // the moneyline or the (liquid) totals ladder?
  const liquidTotMoves = liquidTotMovesForLag;
  const mlLatFromEvent: number[] = [];
  const totLatFromEvent: number[] = [];
  const totMinusMl: number[] = []; // + => totals ladder repriced later than moneyline after the run
  for (const rt of runEvents) {
    const mlT = firstAfter(mlMoves, rt);
    const toT = firstAfter(liquidTotMoves, rt);
    if (mlT != null) mlLatFromEvent.push((mlT - rt) / 1000);
    if (toT != null) totLatFromEvent.push((toT - rt) / 1000);
    if (mlT != null && toT != null) totMinusMl.push((toT - mlT) / 1000);
  }

  // Per-source scoring-event reaction race: for every odds source (direct bwin +
  // each optic_<book>), how fast after each scoring event did it first tick, and
  // how does that compare to PM's own confirmed ladder moves?
  const oddsSources = [...new Set(rows.filter((r) => r.kind === "odds" && r.source).map((r) => r.source!))];
  const sourceRace: any[] = [];
  for (const src of oddsSources) {
    const ticks = rows.filter((r) => r.kind === "odds" && r.source === src).map((r) => r.t).sort((a, b) => a - b);
    const reactions: number[] = [];
    for (const rt of runEvents) {
      const t = firstAfter(ticks, rt, 30_000);
      if (t != null) reactions.push((t - rt) / 1000);
    }
    sourceRace.push({
      source: src,
      ticks: ticks.length,
      eventReactionS: { n: reactions.length, medianS: r2(median(reactions)), p10S: r2(pctl(reactions, 10)), p90S: r2(pctl(reactions, 90)) },
    });
  }
  sourceRace.sort((a, b) => (a.eventReactionS.medianS ?? 999) - (b.eventReactionS.medianS ?? 999));

  const report = {
    generatedAt: new Date().toISOString(),
    sourceFile: path,
    game: target?.title ?? SLUG,
    mode: (target as any)?.mode ?? MODE,
    representativeMoneyline: mlMarket,
    config: { MID_MOVE, PERSIST, WINDOW_S: WINDOW / 1000, eventGroupMs: GROUP_MS, leadResolution: "raw ms (ungrouped)" },
    totals: {
      rows: rows.length,
      pmMarketsTracked: pmMarkets.length,
      moneylineUpdates: mlSeries.length,
      moneylineConfirmedMoves: mlMoves.length,
      liquidTotalLadders: liquidTotals,
      liquidSpreadLadders: liquidSpreads,
      scoringEventsDuringRecording: runEvents.length,
      pmScoreRows: rows.filter((r) => r.kind === "pm_score").length,
      bwinFastTicks: { moneyline: bwinFastByClass.moneyline.length, total: bwinFastByClass.total.length, spread: bwinFastByClass.spread.length },
      bwinMoneylineReactions: bwinMlTimes.length,
      bwinTotalReactions: bwinTotTimes.length,
      bwinScoreboardRows: rows.filter((r) => r.kind === "bwin_score").length,
    },
    verdict: {
      question: "Do PM secondary ladders (totals/spread) reprice slower than PM's moneyline on a scoring event, and does bwin lead them?",
      scoringEventsDuringRecording: runEvents.length,
      totalsLagMoneylineMedianS: r2(median(totLagVsMl)),
      totalsLagN: totLagVsMl.length,
      interpretation:
        runEvents.length < 3
          ? `INSUFFICIENT — only ${runEvents.length} scoring event(s) during recording; too few to measure event-response lag`
          : median(totLagVsMl) > 1.5
            ? "YES — totals ladder trails the moneyline; a moneyline/bwin move front-runs the total"
            : median(totLagVsMl) < -1.5
              ? "INVERTED — totals actually led the moneyline"
              : "TIED — totals and moneyline reprice together (no exploitable lag)",
    },
    totalsLagVsMoneylineS: { note: "+ => the totals ladder repriced AFTER the moneyline for the same event", n: totLagVsMl.length, medianS: r2(median(totLagVsMl)), meanS: r2(mean(totLagVsMl)), p10S: r2(pctl(totLagVsMl, 10)), p90S: r2(pctl(totLagVsMl, 90)) },
    commonAnchorLatencyS: {
      note: "latency from a bwin game-event reaction to the next PM confirmed move",
      moneyline: { n: mlLatFromEvent.length, medianS: r2(median(mlLatFromEvent)) },
      liquidTotals: { n: totLatFromEvent.length, medianS: r2(median(totLatFromEvent)) },
      totalsMinusMoneyline: { note: "+ => totals ladder is the laggard", n: totMinusMl.length, medianS: r2(median(totMinusMl)), p10S: r2(pctl(totMinusMl, 10)), p90S: r2(pctl(totMinusMl, 90)) },
    },
    sourceRace: { note: "per odds source: first tick after each scoring event (s); lower = faster reaction", sources: sourceRace },
    perMarket: perMarket.sort((a, b) => b.updates - a.updates),
    bwinActivity: { moneylineReactions: bwinMlTimes.length, totalReactions: bwinTotTimes.length, anyReactions: bwinAnyReact.length },
  };

  const outJson = join(REPO_ROOT, "analysis", `ladder-lag-race-${SLUG || "report"}.json`);
  writeJson(outJson, report);
  log(`report -> ${outJson}`);
  console.log(JSON.stringify(report, null, 2));
}

const mode = process.argv[2] ?? "record";
if (mode === "analyze") analyze(process.argv[3]);
else record().catch((e) => { console.error("fatal", e); process.exit(1); });
