/**
 * ESPN scoreboard as the authoritative football game-state feed.
 *
 * Covers NFL and college football from the same shape, needs no key, and
 * carries the two things a totals model lives on: the running score and how
 * much game is left. Possession and down/distance come along when a game is
 * in progress.
 *
 * ESPN has no per-event scoreboard filter — `?event=` is ignored and the whole
 * slate comes back — so a Saturday with fifty recorders would refetch the same
 * payload fifty times per interval. Responses are cached to a file with a
 * short TTL so co-located recorders share one fetch, matching how the weather
 * side caches METAR.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export type FootballLeague = "nfl" | "ncaaf";

const ESPN_PATH: Record<FootballLeague, string> = {
  nfl: "football/nfl",
  ncaaf: "football/college-football",
};

const CACHE_TTL_MS = Number(process.env.ESPN_SCOREBOARD_TTL_MS ?? 2_500);
const CACHE_DIR = process.env.ESPN_CACHE_DIR ?? join(tmpdir(), "sports-arb-espn");
/**
 * ESPN's edge 403s unrecognised user agents but lets `curl/*` through. A
 * custom agent happens to work from undici today and fails from Python, so
 * both callers claim to be curl rather than relying on that asymmetry.
 */
const ESPN_UA = process.env.ESPN_USER_AGENT ?? "curl/8.7.1";

export type FootballFeedSnapshot = {
  source: "espn";
  feedId: string;
  live: boolean;
  final: boolean;
  scoreHome: number;
  scoreAway: number;
  /** Quarter, or 5+ for overtime periods. */
  period: number | null;
  /** Seconds left in the period, as ESPN reports it. */
  clock: number | null;
  displayClock: string | null;
  status: string | null;
  /** Abbreviation of the team with the ball, when the game is live. */
  possession: string | null;
  down: number | null;
  distance: number | null;
  lastPlay: string | null;
  /** `away-home`, for cheap change detection. */
  rawScoreKey: string;
};

export type FootballGame = {
  espnEventId: string;
  /** ISO date-time of scheduled kickoff. */
  startsAt: string;
  /** ET calendar date, which is how slates are keyed. */
  dateEt: string;
  shortName: string;
  away: string;
  home: string;
  awayAbbr: string;
  homeAbbr: string;
  /** Every name ESPN carries for the side, for matching other venues' titles. */
  awayAliases: string[];
  homeAliases: string[];
  state: "pre" | "in" | "post";
};

function aliasesOf(team: any): string[] {
  const fields = ["location", "shortDisplayName", "displayName", "name", "nickname", "abbreviation"];
  const out = fields.map((f) => team?.[f]).filter((v) => typeof v === "string" && v.trim());
  return [...new Set(out as string[])];
}

function cachePath(league: FootballLeague, stamp: string): string {
  return join(CACHE_DIR, `${league}-scoreboard-${stamp}.json`);
}

/** ET calendar date as ESPN's `dates=` wants it: YYYYMMDD. */
export function etDayStamp(when: Date): string {
  return when.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replaceAll("-", "");
}

/**
 * ET dates a sweep or recorder should look at: yesterday through tomorrow.
 * Yesterday covers a night game still running past ET midnight, tomorrow the
 * kickoff we are about to launch for.
 */
export function slateWindow(now: Date = new Date()): string[] {
  const day = 86_400_000;
  return [-1, 0, 1].map((n) => etDayStamp(new Date(now.getTime() + n * day)));
}

async function fetchScoreboard(league: FootballLeague, stamp: string): Promise<any> {
  const path = cachePath(league, stamp);
  try {
    const raw = readFileSync(path, "utf8");
    const cached = JSON.parse(raw) as { t: number; body: unknown };
    if (Date.now() - cached.t < CACHE_TTL_MS) return cached.body;
  } catch {
    // No usable cache; fall through and fetch.
  }
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATH[league]}/scoreboard?dates=${stamp}`;
  const res = await fetch(url, { headers: { "user-agent": ESPN_UA } });
  if (!res.ok) throw new Error(`ESPN ${league} scoreboard ${res.status}`);
  const body = await res.json();
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Rename so a reader never observes a half-written file.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ t: Date.now(), body }));
    renameSync(tmp, path);
  } catch {
    // Cache is an optimisation; a failure to write must not fail the poll.
  }
  return body;
}

function etDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function sideOf(competitors: any[], which: "home" | "away"): any {
  return competitors.find((c) => c?.homeAway === which) ?? {};
}

/**
 * Every game ESPN lists for the league on the given ET dates.
 *
 * The dates are not optional in spirit: a bare scoreboard call returns a
 * curated, rolling "this week" subset that both omits games and changes what
 * it omits during the day. On 2 Sep 2026 it advertised 25 college games and
 * none of Thursday's eleven, while `?dates=20260903` returned all eleven and
 * `?dates=20260905` returned 68 against the bare call's 17.
 */
export async function listFootballGames(
  league: FootballLeague,
  stamps: string[] = slateWindow(),
): Promise<FootballGame[]> {
  const events: any[] = [];
  for (const stamp of stamps) {
    try {
      const board = await fetchScoreboard(league, stamp);
      events.push(...(board?.events ?? []));
    } catch {
      // One bad day must not blank the slate; the others still count.
    }
  }
  const out: FootballGame[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const comp = event?.competitions?.[0];
    if (!comp) continue;
    if (seen.has(String(event.id))) continue;
    seen.add(String(event.id));
    const home = sideOf(comp.competitors ?? [], "home");
    const away = sideOf(comp.competitors ?? [], "away");
    out.push({
      espnEventId: String(event.id),
      startsAt: String(event.date),
      dateEt: etDate(String(event.date)),
      shortName: String(event.shortName ?? ""),
      away: String(away?.team?.location ?? away?.team?.shortDisplayName ?? ""),
      home: String(home?.team?.location ?? home?.team?.shortDisplayName ?? ""),
      awayAbbr: String(away?.team?.abbreviation ?? ""),
      homeAbbr: String(home?.team?.abbreviation ?? ""),
      awayAliases: aliasesOf(away?.team),
      homeAliases: aliasesOf(home?.team),
      state: (comp?.status?.type?.state ?? "pre") as "pre" | "in" | "post",
    });
  }
  return out;
}

/**
 * `dateEt` pins the poll to one scoreboard page. A recorder knows its game's
 * date at startup, so passing it keeps the poll to a single cached fetch
 * instead of walking the whole window every tick.
 */
export async function pollFootballFeed(
  league: FootballLeague,
  espnEventId: string,
  dateEt?: string,
): Promise<FootballFeedSnapshot | null> {
  const stamps = dateEt ? [dateEt.replaceAll("-", "")] : slateWindow();
  let event: any = null;
  for (const stamp of stamps) {
    try {
      const board = await fetchScoreboard(league, stamp);
      event = (board?.events ?? []).find((e: any) => String(e?.id) === String(espnEventId));
    } catch {
      continue;
    }
    if (event) break;
  }
  if (!event) return null;
  const comp = event?.competitions?.[0];
  if (!comp) return null;

  const status = comp.status ?? {};
  const state = status?.type?.state ?? "pre";
  const home = sideOf(comp.competitors ?? [], "home");
  const away = sideOf(comp.competitors ?? [], "away");
  const scoreHome = Number(home?.score ?? 0) || 0;
  const scoreAway = Number(away?.score ?? 0) || 0;
  const situation = comp.situation ?? null;

  return {
    source: "espn",
    feedId: String(espnEventId),
    live: state === "in",
    final: Boolean(status?.type?.completed) || state === "post",
    scoreHome,
    scoreAway,
    period: Number.isFinite(Number(status?.period)) ? Number(status.period) : null,
    clock: Number.isFinite(Number(status?.clock)) ? Number(status.clock) : null,
    displayClock: status?.displayClock != null ? String(status.displayClock) : null,
    status: status?.type?.description != null ? String(status.type.description) : null,
    possession: situation?.possession != null ? String(situation.possession) : null,
    down: Number.isFinite(Number(situation?.down)) ? Number(situation.down) : null,
    distance: Number.isFinite(Number(situation?.distance)) ? Number(situation.distance) : null,
    lastPlay: situation?.lastPlay?.text != null ? String(situation.lastPlay.text) : null,
    rawScoreKey: `${scoreAway}-${scoreHome}`,
  };
}

/**
 * Regulation minutes left, the football analogue of `inningsLeft`. Both codes
 * play four 15-minute quarters; overtime returns 0 because the total is then
 * decided by sudden-ish death rather than remaining clock.
 */
export function minutesRemaining(snap: FootballFeedSnapshot): number | null {
  if (snap.final) return 0;
  if (snap.period == null) return 60;
  if (snap.period > 4) return 0;
  const secondsLeftInPeriod = snap.clock ?? 0;
  const fullPeriodsLeft = 4 - snap.period;
  return fullPeriodsLeft * 15 + secondsLeftInPeriod / 60;
}
