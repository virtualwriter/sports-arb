/**
 * Kalshi NFL / college-football total-points ladder discovery.
 *
 * Kalshi mirrors the MLB layout — a `…GAME` series for the matchup and a
 * `…TOTAL` series carrying one market per strike — but the event stamp drops
 * the start time that baseball carries:
 *
 *   MLB    KXMLBTOTAL-26AUG311805SFATL-9      (date + HHMM + teams)
 *   NFL    KXNFLTOTAL-26SEP09NESEA-45         (date + teams)
 *   NCAAF  KXNCAAFTOTAL-26SEP03MASSRUTG-53    (date + teams)
 *
 * The trailing number is the ceiling of the strike, so `-45` is "over 44.5".
 * We never parse it: `floor_strike` carries the real 44.5 and is authoritative.
 *
 * Team codes are concatenated without a separator (`NESEA` = NE + SEA), which
 * cannot be split reliably — `MASSRUTG` could be MAS+SRUTG as easily as
 * MASS+RUTG. So matching runs off the event title ("New England vs Seattle")
 * against team names from the schedule instead.
 */

import { KalshiClient, type KalshiEvent, type KalshiMarket } from "./kalshi-client.js";
import { KalshiLadderFeed, type KalshiLadderRow } from "./kalshi-ladder-feed.js";

export type FootballLeague = "nfl" | "ncaaf";

type LeagueConfig = { totalPrefix: string; gameSeries: string; label: string };

export const FOOTBALL_SERIES: Record<FootballLeague, LeagueConfig> = {
  nfl: {
    totalPrefix: process.env.KALSHI_NFL_TOTAL_PREFIX ?? "KXNFLTOTAL",
    gameSeries: process.env.KALSHI_NFL_GAME_SERIES ?? "KXNFLGAME",
    label: "NFL",
  },
  ncaaf: {
    totalPrefix: process.env.KALSHI_NCAAF_TOTAL_PREFIX ?? "KXNCAAFTOTAL",
    gameSeries: process.env.KALSHI_NCAAF_GAME_SERIES ?? "KXNCAAFGAME",
    label: "NCAAF",
  },
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** `2026-09-03` → `26SEP03`, the date portion of a football event stamp. */
export function footballStamp(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Expected an ISO date, received ${isoDate}`);
  return `${m[1]!.slice(2)}${MONTHS[Number(m[2]) - 1]}${m[3]}`;
}

/** The stamp a football event ticker carries, or null if it is malformed. */
export function stampOfEventTicker(eventTicker: string): string | null {
  const m = eventTicker.toUpperCase().match(/-(\d{2}[A-Z]{3}\d{2})[A-Z0-9]*$/);
  return m ? m[1]! : null;
}

function strikeOf(market: KalshiMarket): number | null {
  // floor_strike is the real line (74.5); the ticker suffix is its ceiling.
  if (typeof market.floor_strike === "number" && Number.isFinite(market.floor_strike)) {
    return market.floor_strike;
  }
  const text = `${market.yes_sub_title ?? ""} ${market.subtitle ?? ""} ${market.title ?? ""}`;
  const match = text.match(/over\D*(\d+(?:\.\d+)?)/i);
  const strike = match ? Number(match[1]) : NaN;
  return Number.isFinite(strike) ? strike : null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** `"UMass vs Rutgers: Total Points"` → `["umass", "rutgers"]`, away first. */
function titleHalves(title: string): [string, string] | null {
  const body = normalize(title.replace(/:\s*total points\s*$/i, ""));
  const m = body.match(/^(.*?)\s+vs\s+(.*)$/);
  return m ? [m[1]!.trim(), m[2]!.trim()] : null;
}

/**
 * How well one side of a Kalshi title names a team, given every alias the
 * schedule knows for it. Kalshi's school names agree with no single ESPN
 * field: it says "UMass" where ESPN's location is "Massachusetts", and
 * "Kennesaw St." where ESPN's location is "Kennesaw State".
 */
function scoreSideByName(half: string, aliases: string[]): number {
  let best = 0;
  for (const alias of aliases) {
    const name = normalize(alias);
    if (!name || name.length < 3) continue;
    if (name === half) return 3;
    if (half.includes(name) || name.includes(half)) best = Math.max(best, 2);
    else {
      const words = name.split(" ").filter((w) => w.length >= 4);
      if (words.some((w) => half.includes(w))) best = Math.max(best, 1);
    }
  }
  return best;
}

/**
 * The team blob in `KXNCAAFTOTAL-26SEP03ALBYBUFF` is away-then-home with no
 * separator, so it cannot be split, but it can still be anchored: the away
 * code must start it and the home code must end it. This rescues the games
 * whose titles use a name ESPN never emits ("University at Albany").
 */
function scoreSideByTicker(eventTicker: string, abbr: string, side: "away" | "home"): number {
  const m = eventTicker.toUpperCase().match(/-\d{2}[A-Z]{3}\d{2}([A-Z0-9]+)$/);
  const blob = m?.[1];
  const code = abbr.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!blob || code.length < 2) return 0;
  return (side === "away" ? blob.startsWith(code) : blob.endsWith(code)) ? 2 : 0;
}

export type FootballTotalsTarget = {
  league: FootballLeague;
  /** ISO date of the game in US Eastern terms, e.g. 2026-09-03. */
  date: string;
  away: string;
  home: string;
  /** Every name the schedule knows for each side; improves the title match. */
  awayAliases?: string[];
  homeAliases?: string[];
  awayAbbr?: string;
  homeAbbr?: string;
};

/** Combined title+ticker confidence that an event is this game, 0 when not. */
function scoreEvent(event: KalshiEvent, target: FootballTotalsTarget): number {
  const halves = titleHalves(event.title ?? "");
  const awayAliases = [target.away, ...(target.awayAliases ?? [])];
  const homeAliases = [target.home, ...(target.homeAliases ?? [])];

  let away = halves ? scoreSideByName(halves[0], awayAliases) : 0;
  let home = halves ? scoreSideByName(halves[1], homeAliases) : 0;
  if (target.awayAbbr) {
    away = Math.max(away, scoreSideByTicker(event.event_ticker, target.awayAbbr, "away"));
  }
  if (target.homeAbbr) {
    home = Math.max(home, scoreSideByTicker(event.event_ticker, target.homeAbbr, "home"));
  }
  // Both ends must be identified; one strong name is not a game.
  return away > 0 && home > 0 ? away + home : 0;
}

async function openTotalEvents(client: KalshiClient, league: FootballLeague): Promise<KalshiEvent[]> {
  const { totalPrefix } = FOOTBALL_SERIES[league];
  const out: KalshiEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const resp = await client.listEvents({
      series_ticker: totalPrefix,
      status: "open",
      limit: 200,
      cursor,
    });
    out.push(...(resp.events ?? []));
    cursor = resp.cursor;
    if (!cursor) break;
  }
  return out;
}

export async function discoverFootballTotalsEvent(
  target: FootballTotalsTarget,
): Promise<{ eventTicker: string; title: string }> {
  const client = new KalshiClient({ unauthenticated: true });
  const { totalPrefix, label } = FOOTBALL_SERIES[target.league];
  const wantStamp = footballStamp(target.date);
  const events = await openTotalEvents(client, target.league);

  // A game listed for Saturday night can carry the next day's stamp once it
  // crosses midnight UTC, so accept the neighbouring date too.
  const next = new Date(`${target.date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const altStamp = footballStamp(next.toISOString().slice(0, 10));

  const sameDay = events.filter((e) => {
    const stamp = stampOfEventTicker(e.event_ticker);
    return stamp === wantStamp || stamp === altStamp;
  });
  const scored = sameDay
    .map((e) => ({ event: e, score: scoreEvent(e, target) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    throw new Error(
      `No open ${label} ${totalPrefix} event for ${target.away} @ ${target.home} on ${target.date} `
      + `(${sameDay.length} events carried stamp ${wantStamp})`,
    );
  }
  // A tie means two events describe this game equally well; recording the
  // wrong ladder is worse than recording nothing, so refuse to guess.
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) {
    throw new Error(
      `Ambiguous ${label} match for ${target.away} @ ${target.home} on ${target.date}: `
      + scored.filter((x) => x.score === scored[0]!.score)
        .map((x) => x.event.event_ticker).join(", "),
    );
  }
  return { eventTicker: scored[0]!.event.event_ticker, title: scored[0]!.event.title ?? "" };
}

/** Strike → ticker for every quoted rung on a football totals event. */
export async function footballTotalRungs(eventTicker: string): Promise<Map<number, string>> {
  const client = new KalshiClient({ unauthenticated: true });
  const event = await client.getEvent(eventTicker, true);
  let markets = event?.markets ?? [];
  if (!markets.length) {
    markets = (await client.listMarkets({ event_ticker: eventTicker, limit: 200 })).markets ?? [];
  }
  const rungs = new Map<number, string>();
  for (const market of markets) {
    const strike = strikeOf(market);
    if (strike !== null && market.ticker) rungs.set(strike, market.ticker);
  }
  if (!rungs.size) throw new Error(`No total rungs found for ${eventTicker}`);
  return new Map([...rungs.entries()].sort((a, b) => a[0] - b[0]));
}

export function createFootballTotalsFeed(opts: {
  eventTicker: string;
  rungs: Map<number, string>;
  onTick: (row: KalshiLadderRow) => void;
  onReconnect?: (reason: string) => void;
  depth?: number;
}): KalshiLadderFeed {
  return new KalshiLadderFeed({ ...opts, klass: "total", marketPrefix: "total" });
}
