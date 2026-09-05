/**
 * Per-game NFL / college-football recorder.
 *
 * Captures the three streams needed to hunt a football analogue of the MLB
 * next-line over: the full Kalshi total-points ladder, authoritative game
 * state from ESPN, and bwin's odds plus its fast scoreboard push.
 *
 * The record kinds deliberately mirror the MLB recorder so the same analysis
 * can be pointed at either sport. The one that matters for the hunt is
 * `football_game_state`, a 1 Hz heartbeat carrying the running total next to
 * the cheapest rung above it — the MLB work established that sampling only on
 * scoring events hides the quotes that appear when nothing is happening.
 *
 * Football differs from baseball in a way that shapes the whole question:
 * scores arrive in 3s and 7s rather than 1s, so a touchdown can vault the
 * total across two or three rungs at once, and Kalshi's ladder is dense
 * (1-point steps) only near the pregame number. Whether that makes the
 * post-score window richer or merely more efficient is what the data is for.
 *
 * Usage:
 *   FLR_LEAGUE=ncaaf FLR_ESPN_EVENT=401856663 tsx scripts/football-ladder-race.ts
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  bwinFixtureScore,
  bwinTeamNeedles,
  parseBwinFootballScoreboard,
} from "./lib/bwin-football-score.js";
import {
  listFootballGames,
  minutesRemaining,
  pollFootballFeed,
  type FootballFeedSnapshot,
  type FootballGame,
  type FootballLeague,
} from "./lib/espn-football-feed.js";
import {
  createFootballTotalsFeed,
  discoverFootballTotalsEvent,
  footballTotalRungs,
} from "./lib/kalshi-football-ws-feed.js";
import { bwinLiveFixtures, BwinPushClient } from "./lib/latency-feeds.js";

const LEAGUE = (process.env.FLR_LEAGUE ?? "ncaaf") as FootballLeague;
const ESPN_EVENT = process.env.FLR_ESPN_EVENT ?? "";
const KALSHI_EVENT = process.env.FLR_KALSHI_EVENT ?? "";
const POLL_MS = Math.max(1_000, Number(process.env.FLR_POLL_MS ?? 3_000));
const HEARTBEAT_MS = Math.max(250, Number(process.env.FLR_HEARTBEAT_MS ?? 1_000));
const DURATION_MS = Number(process.env.FLR_DURATION_MS ?? 5 * 60 * 60 * 1000);
/** Keep recording past the whistle: settlement quotes are part of the sample. */
const POST_FINAL_MS = Number(process.env.FLR_POST_FINAL_MS ?? 120_000);
const BWIN_SPORT = Number(process.env.FLR_BWIN_SPORT ?? 11); // 11 = American Football
const BWIN_ENABLED = !/^(0|false|no)$/i.test(process.env.FLR_BWIN ?? "1");
const BWIN_RETRY_MS = Number(process.env.FLR_BWIN_RETRY_MS ?? 120_000);
/** Silence this long from a bound fixture, mid-game, means go rediscover. */
const BWIN_STALE_MS = Number(process.env.FLR_BWIN_STALE_MS ?? 240_000);

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);

const now = () => Date.now();
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function gameSlug(league: FootballLeague, game: FootballGame): string {
  return `${league}-${slugify(game.awayAbbr || game.away)}-${slugify(game.homeAbbr || game.home)}-${game.dateEt}`;
}

function classifyBwinMarket(name: string): "moneyline" | "total" | "spread" | "other" {
  if (/handicap|spread|line/i.test(name)) return "spread";
  if (/total|over\/under|o\/u|points/i.test(name)) return "total";
  if (/money\s*line|match\s*(result|winner)|winner|result$/i.test(name)) return "moneyline";
  return "other";
}

type NearRung = { line: number; dist: number; ask: number; askSize: number; bid: number; ticker: string };

/**
 * The lowest quoted strike strictly above the running total — the next line
 * the game actually has to cross, and the direct analogue of the MLB
 * next-line over.
 *
 * Selecting by distance rather than by price matters here. Over-prices fall
 * monotonically as the strike rises, so the *cheapest* rung above the total is
 * always the furthest one out: on a 0-0 game that would record the 82.5
 * lottery ticket instead of the 40.5 near-certainty we care about.
 */
function nearestOverRung(
  curTotal: number,
  quotes: Map<number, { yesAsk: number; yesAskSize: number; yesBid: number }>,
  rungs: Map<number, string>,
): NearRung | null {
  let best: NearRung | null = null;
  for (const [line, q] of quotes) {
    const dist = line - curTotal;
    if (!(dist > 0)) continue;
    if (!(q.yesAsk > 0) || !(q.yesAskSize > 0)) continue;
    if (best == null || dist < best.dist) {
      best = { line, dist, ask: q.yesAsk, askSize: q.yesAskSize, bid: q.yesBid, ticker: rungs.get(line) ?? "" };
    }
  }
  return best;
}

async function main(): Promise<void> {
  const games = await listFootballGames(LEAGUE);
  const game = ESPN_EVENT
    ? games.find((g) => g.espnEventId === ESPN_EVENT)
    : games.find((g) => g.state === "in") ?? games.find((g) => g.state === "pre");
  if (!game) throw new Error(`No ${LEAGUE} game found for FLR_ESPN_EVENT=${ESPN_EVENT || "(auto)"}`);

  const slug = gameSlug(LEAGUE, game);
  log(`${LEAGUE.toUpperCase()} ${game.shortName} (${game.away} @ ${game.home}) ${game.dateEt} state=${game.state}`);

  const discovered = KALSHI_EVENT
    ? { eventTicker: KALSHI_EVENT, title: "" }
    : await discoverFootballTotalsEvent({
      league: LEAGUE,
      date: game.dateEt,
      away: game.away,
      home: game.home,
      awayAliases: game.awayAliases,
      homeAliases: game.homeAliases,
      awayAbbr: game.awayAbbr,
      homeAbbr: game.homeAbbr,
    });
  const rungs = await footballTotalRungs(discovered.eventTicker);
  const strikes = [...rungs.keys()];
  log(`kalshi ${discovered.eventTicker} — ${strikes.length} rungs ${strikes[0]}..${strikes[strikes.length - 1]}`);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(DATA_DIR, `football-ladder-race-${slug}-${stamp}.jsonl`);
  const out = createWriteStream(outPath, { flags: "a" });
  const emit = (row: Record<string, unknown>) => {
    out.write(`${JSON.stringify({ t: now(), slug, ...row })}\n`);
  };
  writeFileSync(join(DATA_DIR, "football-ladder-race-latest.json"), JSON.stringify({ path: outPath, slug }));
  log(`recording -> ${outPath}`);

  emit({
    kind: "target",
    league: LEAGUE,
    espnEventId: game.espnEventId,
    shortName: game.shortName,
    away: game.away,
    home: game.home,
    awayAbbr: game.awayAbbr,
    homeAbbr: game.homeAbbr,
    startsAt: game.startsAt,
    dateEt: game.dateEt,
    kalshiEvent: discovered.eventTicker,
    kalshiTitle: discovered.title,
    rungs: Object.fromEntries([...rungs].map(([k, v]) => [k, v])),
  });

  let shuttingDown = false;
  let finalAt = 0;

  // ---- Kalshi ladder ----
  const feed = createFootballTotalsFeed({
    eventTicker: discovered.eventTicker,
    rungs,
    onTick: (row) => emit(row),
    onReconnect: (reason) => emit({ kind: "reconnect", feed: "kalshi", reason }),
  });
  await feed.start();
  emit({ kind: "kalshi_init", eventTicker: discovered.eventTicker, rungs: strikes.length });

  // ---- score race: which feed saw a given score first ----
  // Same idea as the MLB bwin/statsapi race. Keyed by the score itself, so the
  // two feeds are compared on the state they report rather than on wall time.
  const scoreFirstSeen = new Map<string, { source: "bwin" | "espn"; t: number }>();
  const noteScore = (source: "bwin" | "espn", away: number, home: number) => {
    const key = `${away}-${home}`;
    const seen = scoreFirstSeen.get(key);
    if (!seen) {
      scoreFirstSeen.set(key, { source, t: now() });
      return { firstSource: source, leadMs: 0 };
    }
    return { firstSource: seen.source, leadMs: now() - seen.t };
  };

  // ---- bwin odds + fast scoreboard ----
  let bwinFixtureId = process.env.FLR_BWIN_FIXTURE ?? "";
  let lastBwinScoreKey = "";
  let bwin: BwinPushClient | null = null;
  let bwinRetry: NodeJS.Timeout | null = null;
  let bwinWatchdog: NodeJS.Timeout | null = null;
  let lastBwinPushAt = 0;
  const lastOdds = new Map<string, string>();
  // Needles for finding this game in bwin's in-play list. One word off a
  // single ESPN name is too brittle: bwin says "Albany" where ESPN says
  // "UAlbany", and that game recorded 0 bwin pushes all Thursday night. Take
  // words from every alias instead, and match either direction so a longer
  // school name still finds the shorter one bwin prints.
  const awayNeedles = bwinTeamNeedles([game.away, ...game.awayAliases]);
  const homeNeedles = bwinTeamNeedles([game.home, ...game.homeAliases]);

  const makeBwin = () => new BwinPushClient(
    [bwinFixtureId],
    (_fx, payload, messageType) => {
      lastBwinPushAt = now();
      if (messageType === "ScoreboardSlim") {
        // Keep the raw blob: it is the record of record if the parser changes.
        emit({ kind: "bwin_score", raw: JSON.stringify(payload).slice(0, 1600) });
        const s = parseBwinFootballScoreboard(payload);
        if (s) {
          const key = `${s.scoreAway}-${s.scoreHome}`;
          if (key !== lastBwinScoreKey) {
            const prevTotal = lastBwinScoreKey
              ? lastBwinScoreKey.split("-").reduce((a, b) => a + Number(b), 0)
              : null;
            lastBwinScoreKey = key;
            const race = noteScore("bwin", s.scoreAway, s.scoreHome);
            emit({
              kind: "football_score",
              source: "bwin",
              scoreAway: s.scoreAway,
              scoreHome: s.scoreHome,
              curTotal: s.total,
              delta: prevTotal == null ? null : s.total - prevTotal,
              period: s.period,
              clock: s.secondsLeftInPeriod,
              possession: s.possession,
              down: s.down,
              distance: s.distance,
              ...race,
            });
          }
        }
        return;
      }
      const g = payload.game ?? payload.optionMarket ?? payload;
      const marketName = g?.name?.value ?? "";
      if (/delete/i.test(messageType)) {
        emit({ kind: "odds", source: "bwin", market: marketName, event: "market_delete" });
        return;
      }
      const visible = (g?.visibility ?? "Visible") === "Visible";
      for (const o of g?.results ?? g?.options ?? []) {
        const odds = o?.odds ?? o?.price?.odds;
        if (odds == null) continue;
        const suspended = !visible || (o?.visibility != null ? o.visibility !== "Visible" : !!o?.isSuspended);
        const id = `${g?.id}:${o?.id}`;
        const cur = `${odds}:${suspended ? 1 : 0}`;
        if (lastOdds.get(id) === cur) continue;
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
    },
    log,
    () => { if (!shuttingDown && bwinFixtureId) { try { bwin?.close(); } catch { /* closing */ } bwin = makeBwin(); bwin.connect(); } },
  );

  const discoverBwin = async () => {
    if (bwinFixtureId || shuttingDown) return;
    try {
      // bwin only lists a fixture once it goes in-play, so this keeps retrying.
      const scored = (await bwinLiveFixtures(BWIN_SPORT))
        .map((f) => ({ f, score: bwinFixtureScore(f.name, awayNeedles, homeNeedles) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      // Binding the wrong fixture would feed another game's scores into this
      // capture, which is worse than having no bwin at all. Only bind a clear
      // winner.
      const ambiguous = scored.length > 1 && scored[0]!.score === scored[1]!.score;
      if (ambiguous) {
        emit({
          kind: "bwin_ambiguous",
          candidates: scored.slice(0, 3).map((x) => x.f.name),
        });
      }
      const hit = ambiguous ? undefined : scored[0]?.f;
      if (hit) {
        bwinFixtureId = hit.id;
        lastBwinPushAt = now();
        log(`bwin fixture ${hit.id} ${hit.name}`);
        emit({ kind: "bwin_init", fixtureId: hit.id, name: hit.name });
        bwin = makeBwin();
        bwin.connect();
        if (bwinRetry) { clearInterval(bwinRetry); bwinRetry = null; }
      }
    } catch (err) {
      log(`bwin discovery failed: ${String(err).slice(0, 80)}`);
    }
  };
  if (BWIN_ENABLED) {
    await discoverBwin();
    if (!bwinFixtureId) {
      log(`bwin: no live fixture for [${game.away} / ${game.home}] yet — retrying every ${BWIN_RETRY_MS / 1000}s`);
      bwinRetry = setInterval(() => { void discoverBwin(); }, BWIN_RETRY_MS);
    }
  }

  // ---- ESPN game state ----
  let snap: FootballFeedSnapshot | null = null;
  let lastScoreKey = "";
  const pollTimer = setInterval(async () => {
    try {
      const next = await pollFootballFeed(LEAGUE, game.espnEventId, game.dateEt);
      if (!next) return;
      if (next.rawScoreKey !== lastScoreKey) {
        const prev = snap;
        emit({
          kind: "football_score",
          source: "espn",
          scoreAway: next.scoreAway,
          scoreHome: next.scoreHome,
          curTotal: next.scoreAway + next.scoreHome,
          delta: prev ? (next.scoreAway + next.scoreHome) - (prev.scoreAway + prev.scoreHome) : null,
          period: next.period,
          clock: next.clock,
          displayClock: next.displayClock,
          possession: next.possession,
          lastPlay: next.lastPlay,
          minutesLeft: minutesRemaining(next),
          ...noteScore("espn", next.scoreAway, next.scoreHome),
        });
        lastScoreKey = next.rawScoreKey;
      }
      snap = next;
      if (next.final && !finalAt) {
        finalAt = now();
        log(`final ${next.scoreAway}-${next.scoreHome} — recording ${POST_FINAL_MS / 1000}s more`);
      }
    } catch (err) {
      emit({ kind: "feed_error", feed: "espn", error: String(err).slice(0, 200) });
    }
  }, POLL_MS);

  // ---- bwin staleness watchdog ----
  // Binding once is not enough. Two of Thursday's games bound fine and then
  // went quiet mid-game — 34 and 67 pushes against 300-450 for a full game —
  // and because discovery stops after the first hit, the fast feed was gone
  // for the rest of the night. If bwin falls silent while the game is live,
  // drop the fixture and go looking again.
  if (BWIN_ENABLED) {
    bwinWatchdog = setInterval(() => {
      if (shuttingDown || !bwinFixtureId || !snap?.live) return;
      if (now() - lastBwinPushAt < BWIN_STALE_MS) return;
      emit({
        kind: "bwin_stale",
        fixtureId: bwinFixtureId,
        silentMs: now() - lastBwinPushAt,
      });
      log(`bwin silent ${Math.round((now() - lastBwinPushAt) / 1000)}s — rediscovering`);
      try { bwin?.close(); } catch { /* already closing */ }
      bwin = null;
      bwinFixtureId = "";
      void discoverBwin();
    }, BWIN_RETRY_MS);
  }

  // ---- 1 Hz heartbeat: game state next to the near rung ----
  const heartbeat = setInterval(() => {
    if (!snap) return;
    const curTotal = snap.scoreAway + snap.scoreHome;
    const quotes = feed.getQuotes();
    const near = nearestOverRung(curTotal, quotes as any, rungs);
    emit({
      kind: "football_game_state",
      live: snap.live,
      final: snap.final,
      status: snap.status,
      scoreAway: snap.scoreAway,
      scoreHome: snap.scoreHome,
      curTotal,
      period: snap.period,
      clock: snap.clock,
      displayClock: snap.displayClock,
      minutesLeft: minutesRemaining(snap),
      possession: snap.possession,
      down: snap.down,
      distance: snap.distance,
      nearLine: near?.line ?? null,
      nearDist: near?.dist ?? null,
      nearAsk: near?.ask ?? null,
      nearSize: near?.askSize ?? null,
      nearBid: near?.bid ?? null,
      nearTicker: near?.ticker ?? null,
      quotedRungs: quotes.size,
    });
  }, HEARTBEAT_MS);

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(pollTimer);
    clearInterval(heartbeat);
    if (bwinRetry) clearInterval(bwinRetry);
    if (bwinWatchdog) clearInterval(bwinWatchdog);
    if (endTimer) clearInterval(endTimer);
    feed.stop();
    try { bwin?.close(); } catch { /* closing */ }
    emit({ kind: "end", reason, scoreAway: snap?.scoreAway ?? null, scoreHome: snap?.scoreHome ?? null });
    log(`shutdown: ${reason}`);
    out.end(() => process.exit(0));
  };

  const startedAt = now();
  const endTimer = setInterval(() => {
    if (finalAt && now() - finalAt >= POST_FINAL_MS) shutdown("final");
    else if (now() - startedAt >= DURATION_MS) shutdown("duration_cap");
  }, 5_000);

  process.on("SIGINT", () => shutdown("sigint"));
  process.on("SIGTERM", () => shutdown("sigterm"));
}

main().catch((err) => {
  console.error(`football-ladder-race failed: ${(err as Error).message}`);
  process.exit(1);
});
