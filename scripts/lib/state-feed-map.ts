// Persist + resolve Polymarket sports slugs → StatsAPI / FotMob feed IDs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureParent } from "./paths.js";
import { fetchJson } from "./monotonic-arb-core.js";

export type FeedBinding = {
  eventSlug: string;
  asset: "MLB" | "SOCCER";
  source: "statsapi" | "fotmob";
  feedId: string;
  title?: string;
  gameDate?: string;
  mappedAt: string;
  confidence: "exact" | "fuzzy";
};

export type EventMapFile = {
  updatedAt: string;
  bindings: Record<string, FeedBinding>;
};

const FETCH_TIMEOUT_MS = Number(process.env.STATE_FEED_FETCH_TIMEOUT_MS ?? 12_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadEventMap(path: string): EventMapFile {
  if (!existsSync(path)) return { updatedAt: "", bindings: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EventMapFile;
  } catch {
    return { updatedAt: "", bindings: {} };
  }
}

export function saveEventMap(path: string, map: EventMapFile): void {
  ensureParent(path);
  map.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(map, null, 2) + "\n");
}

export function parseSportsSlug(slug: string): {
  asset: "MLB" | "SOCCER" | null;
  teamA: string;
  teamB: string;
  gameDate: string;
} | null {
  const mlb = slug.match(/^mlb-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/i);
  if (mlb) {
    return { asset: "MLB", teamA: mlb[1].toLowerCase(), teamB: mlb[2].toLowerCase(), gameDate: mlb[3] };
  }
  const soccer = slug.match(/^(?:fifwc|mls|uel|col)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})(?:-more-markets)?$/i);
  if (soccer) {
    return { asset: "SOCCER", teamA: soccer[1].toLowerCase(), teamB: soccer[2].toLowerCase(), gameDate: soccer[3] };
  }
  return null;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(s: string): string[] {
  return normName(s).split(/\s+/).filter((t) => t.length >= 2);
}

function fuzzyOverlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

function abbrInName(abbr: string, name: string): boolean {
  const n = normName(name);
  if (n.split(/\s+/).includes(abbr)) return true;
  // 3-letter codes often appear as leading consonants of words
  const compacted = n.replace(/\s+/g, "");
  return compacted.includes(abbr);
}

async function fetchWithUa(url: string): Promise<any> {
  return fetchJson(url, FETCH_TIMEOUT_MS);
}

export async function resolveMlbFeedId(slug: string, title: string): Promise<FeedBinding | null> {
  const parsed = parseSportsSlug(slug);
  if (!parsed || parsed.asset !== "MLB") return null;
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(parsed.gameDate)}&hydrate=team`;
  const data = await fetchWithUa(url);
  const games: any[] = [];
  for (const day of data?.dates ?? []) games.push(...(day.games ?? []));
  let best: { game: any; score: number } | null = null;
  for (const game of games) {
    const away = String(game?.teams?.away?.team?.abbreviation ?? "").toLowerCase();
    const home = String(game?.teams?.home?.team?.abbreviation ?? "").toLowerCase();
    const awayName = String(game?.teams?.away?.team?.name ?? "");
    const homeName = String(game?.teams?.home?.team?.name ?? "");
    const abbrs = new Set([away, home].filter(Boolean));
    let score = 0;
    if (abbrs.has(parsed.teamA)) score += 2;
    if (abbrs.has(parsed.teamB)) score += 2;
    if (abbrInName(parsed.teamA, `${awayName} ${homeName}`)) score += 1;
    if (abbrInName(parsed.teamB, `${awayName} ${homeName}`)) score += 1;
    score += fuzzyOverlap(title, `${awayName} ${homeName}`);
    // Doubleheader tie-break: prefer the game that is live now over one already final.
    const state = String(game?.status?.abstractGameState ?? "");
    if (state === "Live") score += 0.5;
    else if (state === "Final") score -= 0.25;
    if (!best || score > best.score) best = { game, score };
  }
  if (!best || best.score < 3) return null;
  const gamePk = String(best.game.gamePk ?? "");
  if (!gamePk) return null;
  return {
    eventSlug: slug,
    asset: "MLB",
    source: "statsapi",
    feedId: gamePk,
    title,
    gameDate: parsed.gameDate,
    mappedAt: new Date().toISOString(),
    confidence: best.score >= 4 ? "exact" : "fuzzy",
  };
}

function fotmobDateKey(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

export async function resolveSoccerFeedId(slug: string, title: string): Promise<FeedBinding | null> {
  const parsed = parseSportsSlug(slug);
  if (!parsed || parsed.asset !== "SOCCER") return null;
  const dateKey = fotmobDateKey(parsed.gameDate);
  // FotMob day list; also try +/-1 day for TZ edge cases
  const dates = [dateKey];
  const base = new Date(`${parsed.gameDate}T12:00:00Z`);
  for (const delta of [-1, 1]) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + delta);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  let best: { matchId: string; score: number; name: string } | null = null;
  for (const day of dates) {
    let data: any;
    try {
      data = await fetchWithUa(`https://www.fotmob.com/api/data/matches?date=${day}`);
    } catch {
      continue;
    }
    for (const league of data?.leagues ?? []) {
      for (const match of league?.matches ?? []) {
        const home = String(match?.home?.name ?? match?.home?.longName ?? "");
        const away = String(match?.away?.name ?? match?.away?.longName ?? "");
        const label = `${home} vs ${away}`;
        let score = fuzzyOverlap(title, label) * 4;
        if (abbrInName(parsed.teamA, `${home} ${away}`)) score += 1.5;
        if (abbrInName(parsed.teamB, `${home} ${away}`)) score += 1.5;
        // Prefer exact day
        if (day === dateKey) score += 0.5;
        const matchId = String(match?.id ?? "");
        if (!matchId) continue;
        if (!best || score > best.score) best = { matchId, score, name: label };
      }
    }
    await sleep(50);
  }
  if (!best || best.score < 2.5) return null;
  return {
    eventSlug: slug,
    asset: "SOCCER",
    source: "fotmob",
    feedId: best.matchId,
    title,
    gameDate: parsed.gameDate,
    mappedAt: new Date().toISOString(),
    confidence: best.score >= 4 ? "exact" : "fuzzy",
  };
}

export async function ensureBinding(
  map: EventMapFile,
  slug: string,
  asset: "MLB" | "SOCCER",
  title: string,
): Promise<FeedBinding | null> {
  const existing = map.bindings[slug];
  if (existing?.feedId) return existing;
  try {
    const binding = asset === "MLB"
      ? await resolveMlbFeedId(slug, title)
      : await resolveSoccerFeedId(slug, title);
    if (binding) {
      map.bindings[slug] = binding;
      return binding;
    }
  } catch (err: any) {
    console.error(`state-feed map failed slug=${slug}: ${err?.message ?? err}`);
  }
  return null;
}

export type FeedSnapshot = {
  source: "statsapi" | "fotmob";
  feedId: string;
  live: boolean;
  scoreHome: number | null;
  scoreAway: number | null;
  period: string | null;
  outs: number | null;
  clock: string | null;
  status: string | null;
  rawScoreKey: string;
  /** Runners currently on base (0–3). Null if unknown. */
  runnersOn?: number | null;
  onFirst?: boolean;
  onSecond?: boolean;
  onThird?: boolean;
  /** Team currently batting (Top = away, Bottom = home). */
  battingSide?: "home" | "away" | null;
};

/** Count occupied bases from StatsAPI linescore.offense.{first,second,third}. */
export function countRunnersOn(offense: { first?: unknown; second?: unknown; third?: unknown } | null | undefined): {
  runnersOn: number;
  onFirst: boolean;
  onSecond: boolean;
  onThird: boolean;
} {
  const onFirst = Boolean(offense?.first);
  const onSecond = Boolean(offense?.second);
  const onThird = Boolean(offense?.third);
  return {
    runnersOn: Number(onFirst) + Number(onSecond) + Number(onThird),
    onFirst,
    onSecond,
    onThird,
  };
}

export async function pollMlbFeed(gamePk: string): Promise<FeedSnapshot> {
  const data = await fetchWithUa(
    `https://statsapi.mlb.com/api/v1.1/game/${encodeURIComponent(gamePk)}/feed/live`,
  );
  const linescore = data?.liveData?.linescore ?? {};
  const status = String(data?.gameData?.status?.detailedState ?? data?.gameData?.status?.abstractGameState ?? "");
  const abstract = String(data?.gameData?.status?.abstractGameState ?? "");
  const home = Number(linescore?.teams?.home?.runs);
  const away = Number(linescore?.teams?.away?.runs);
  const inning = linescore?.currentInning != null ? String(linescore.currentInning) : null;
  const half = linescore?.inningHalf ? String(linescore.inningHalf) : null;
  const outs = Number.isFinite(Number(linescore?.outs)) ? Number(linescore.outs) : null;
  const period = inning && half ? `${half} ${inning}` : inning;
  const scoreHome = Number.isFinite(home) ? home : null;
  const scoreAway = Number.isFinite(away) ? away : null;
  const bases = countRunnersOn(linescore?.offense);
  const halfLower = String(half ?? "").toLowerCase();
  const battingSide: "home" | "away" | null = halfLower.includes("bottom")
    ? "home"
    : halfLower.includes("top")
      ? "away"
      : null;
  return {
    source: "statsapi",
    feedId: gamePk,
    live: abstract === "Live",
    scoreHome,
    scoreAway,
    period,
    outs,
    clock: null,
    status,
    runnersOn: bases.runnersOn,
    onFirst: bases.onFirst,
    onSecond: bases.onSecond,
    onThird: bases.onThird,
    battingSide,
    rawScoreKey: `${scoreAway ?? "x"}-${scoreHome ?? "x"}|${period ?? ""}|${outs ?? ""}|${bases.runnersOn}|${status}`,
  };
}

export async function pollFotmobFeed(matchId: string): Promise<FeedSnapshot> {
  const data = await fetchWithUa(
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  );
  const general = data?.general ?? {};
  const header = data?.header ?? {};
  const status = header?.status ?? {};
  const home = Number(header?.teams?.[0]?.score ?? status?.score?.home);
  const away = Number(header?.teams?.[1]?.score ?? status?.score?.away);
  const live = Boolean(status?.ongoing || status?.liveTime);
  const clock = status?.liveTime?.long ?? status?.liveTime?.short ?? status?.reason?.short ?? null;
  const period = status?.period ?? (status?.halfTime ? "HT" : null);
  const scoreHome = Number.isFinite(home) ? home : null;
  const scoreAway = Number.isFinite(away) ? away : null;
  const finished = Boolean(status?.finished);
  return {
    source: "fotmob",
    feedId: matchId,
    live: live && !finished,
    scoreHome,
    scoreAway,
    period: period != null ? String(period) : null,
    outs: null,
    clock: clock != null ? String(clock) : null,
    status: finished ? "FT" : (live ? "LIVE" : String(status?.reason?.short ?? "NS")),
    rawScoreKey: `${scoreAway ?? "x"}-${scoreHome ?? "x"}|${period ?? ""}|${clock ?? ""}|${finished ? "FT" : live ? "LIVE" : "NS"}`,
  };
}
