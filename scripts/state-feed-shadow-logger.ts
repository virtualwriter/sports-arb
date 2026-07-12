// Read-only Strat 1/2 shadow logger.
// Polls StatsAPI (MLB) + FotMob (soccer) alongside Polymarket totals ladders.
// Shadow only — never trades.
//
// Output: $SPORTS_ARB_DATA_DIR/state-feed-shadow.jsonl
// Map:    $SPORTS_ARB_DATA_DIR/state-feed-event-map.json

import {
  type ArbCoreConfig,
  type Candidate,
  type GammaEvent,
  type MarketQuote,
  fetchBook,
  fetchEvent,
  fetchJson,
  mapLimit,
  polymarketAssetForSlug,
  structuralMarketQuote,
} from "./lib/monotonic-arb-core.js";
import { appendJsonl } from "./lib/storage.js";
import { DATA_DIR, PATHS, ensureStateDirs } from "./lib/paths.js";
import {
  type FeedSnapshot,
  ensureBinding,
  loadEventMap,
  parseSportsSlug,
  pollFotmobFeed,
  pollMlbFeed,
  saveEventMap,
} from "./lib/state-feed-map.js";

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const CLOB_HOST = process.env.CLOB_API_URL ?? "https://clob.polymarket.com";

const LIVE_POLL_MS = Number(process.env.STATE_FEED_LIVE_POLL_MS ?? 2_000);
const FOTMOB_POLL_MS = Number(process.env.STATE_FEED_FOTMOB_POLL_MS ?? 3_000);
const IDLE_POLL_MS = Number(process.env.STATE_FEED_IDLE_POLL_MS ?? 30_000);
const DISCOVERY_MS = Number(process.env.STATE_FEED_DISCOVERY_MS ?? 60_000);
const SHADOW_PATH = process.env.STATE_FEED_SHADOW_PATH ?? PATHS.stateFeedShadow;
const MAP_PATH = process.env.STATE_FEED_MAP_PATH ?? PATHS.stateFeedEventMap;
const MAX_WIDTH = Number(process.env.STATE_FEED_MAX_WIDTH ?? 4);
const BOOK_CONCURRENCY = Number(process.env.STATE_FEED_BOOK_CONCURRENCY ?? 6);
const DISCOVERY_LIMIT = Number(process.env.STATE_FEED_DISCOVERY_LIMIT ?? 400);
const DISCOVERY_DAYS = Number(process.env.STATE_FEED_DISCOVERY_DAYS ?? 1);

// SportsDataIO trial comparison feed (MLB only). Runs alongside StatsAPI so we
// can measure relative latency/accuracy; production (daemon strat2 gate) stays
// on StatsAPI. One GamesByDate call covers the whole slate, so polling is cheap
// even on a rate-limited trial key. Disabled unless SPORTSDATAIO_API_KEY is set.
const SDIO_KEY = (process.env.SPORTSDATAIO_API_KEY ?? "").trim();
const SDIO_POLL_MS = Number(process.env.STATE_FEED_SDIO_POLL_MS ?? 5_000);
const SDIO_IDLE_POLL_MS = Number(process.env.STATE_FEED_SDIO_IDLE_POLL_MS ?? 60_000);

// The Odds API scores comparison feed (MLB only). Same shadow-only role as
// SportsDataIO: latency/accuracy vs StatsAPI. Scores update ~every 30s and each
// call costs 1 quota credit (no daysFrom), so poll slower than StatsAPI.
// Disabled unless THE_ODDS_API_KEY is set.
const ODDS_API_KEY = (process.env.THE_ODDS_API_KEY ?? "").trim();
const ODDS_API_POLL_MS = Number(process.env.STATE_FEED_ODDS_API_POLL_MS ?? 30_000);
const ODDS_API_IDLE_POLL_MS = Number(process.env.STATE_FEED_ODDS_API_IDLE_POLL_MS ?? 120_000);

const arbConfig: ArbCoreConfig = {
  host: CLOB_HOST,
  gammaApi: GAMMA_API,
  fetchTimeoutMs: Number(process.env.STATE_FEED_FETCH_TIMEOUT_MS ?? 12_000),
  marketConcurrency: BOOK_CONCURRENCY,
  eventConcurrency: 3,
  allowedAssets: new Set(["MLB", "SOCCER"]),
  minEdge: -1,
  maxSpread: 1,
  minLiquidity: 0,
  minAvailableShares: 0,
};

type TrackedEvent = {
  slug: string;
  asset: "MLB" | "SOCCER";
  title: string;
  lastFeedKey: string | null;
  lastFeedPollAt: number;
  lastBookPollAt: number;
  feedLive: boolean;
};

function log(msg: string): void {
  console.log(`[state-feed] ${new Date().toISOString()} ${msg}`);
}

function todayInNewYork(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sportsGameDate(slug: string): string | null {
  const m = slug.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function isWithinHorizon(slug: string, today: string): boolean {
  const gameDate = sportsGameDate(slug);
  if (!gameDate || gameDate < today) return false;
  return gameDate <= addDays(today, DISCOVERY_DAYS);
}

function isTargetSlug(slug: string): boolean {
  if (/(?:player-props|total-corners|corners|spreads?)$/i.test(slug)) return false;
  if (/-more-markets$/.test(slug)) {
    return /^(?:fifwc|mls|uel|col)-/i.test(slug);
  }
  // Game root slugs: mlb-a-b-YYYY-MM-DD or soccer a-b-YYYY-MM-DD
  return (
    /^mlb-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/i.test(slug)
    || /^(?:fifwc|mls|uel|col)-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}(?:-more-markets)?$/i.test(slug)
  );
}

function hasTotalsLadder(event: GammaEvent): boolean {
  return (event.markets ?? []).some((market) => {
    const q = market.question ?? "";
    return /\b(?:Match\s+)?O\/U\s+[0-9]/i.test(q);
  });
}

async function discoverSlugs(): Promise<{ slug: string; asset: "MLB" | "SOCCER"; title: string }[]> {
  const today = todayInNewYork();
  const tags = [
    { tag: "mlb", asset: "MLB" as const },
    { tag: "baseball", asset: "MLB" as const },
    { tag: "soccer", asset: "SOCCER" as const },
    { tag: "fifa-world-cup", asset: "SOCCER" as const },
    { tag: "uel", asset: "SOCCER" as const },
    { tag: "europa-conference-league", asset: "SOCCER" as const },
  ];
  const out = new Map<string, { slug: string; asset: "MLB" | "SOCCER"; title: string }>();
  for (const { tag, asset } of tags) {
    for (let offset = 0; offset < DISCOVERY_LIMIT; offset += 100) {
      let events: GammaEvent[];
      try {
        events = await fetchJson(
          `${GAMMA_API}/events?${new URLSearchParams({
            active: "true",
            closed: "false",
            limit: "100",
            offset: String(offset),
            tag_slug: tag,
          })}`,
          arbConfig.fetchTimeoutMs,
        ) as GammaEvent[];
      } catch (err: any) {
        log(`discovery tag=${tag} offset=${offset} failed: ${err?.message ?? err}`);
        break;
      }
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        const slug = event.slug ?? "";
        if (!isTargetSlug(slug) || !isWithinHorizon(slug, today)) continue;
        if (!hasTotalsLadder(event)) continue;
        const resolvedAsset = polymarketAssetForSlug(slug);
        if (resolvedAsset !== "MLB" && resolvedAsset !== "SOCCER") continue;
        if (asset === "MLB" && resolvedAsset !== "MLB") continue;
        if (asset === "SOCCER" && resolvedAsset !== "SOCCER") continue;
        out.set(slug, { slug, asset: resolvedAsset, title: event.title ?? slug });
      }
      if (events.length < 100) break;
    }
  }
  return [...out.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function loadTotalsLadder(slug: string): Promise<{ quotes: MarketQuote[]; eventTitle: string }> {
  const event = await fetchEvent(arbConfig, slug);
  if (!event?.slug) return { quotes: [], eventTitle: slug };
  const structural = (event.markets ?? [])
    .map((market) => structuralMarketQuote(event, market))
    .filter((q): q is MarketQuote => q !== null)
    .filter((q) => q.direction === "above" && q.ladderKey.includes(":total:"));
  // Deduplicate by strike (prefer full-game)
  const byStrike = new Map<number, MarketQuote>();
  for (const quote of structural) {
    const isFull = quote.ladderKey.includes(":total:full-game") || quote.ladderKey.includes(":total:match");
    const prev = byStrike.get(quote.strike);
    if (!prev || isFull) byStrike.set(quote.strike, quote);
  }
  const quotes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  // Fetch books
  await mapLimit(quotes, BOOK_CONCURRENCY, async (quote) => {
    try {
      const [yesBook, noBook] = await Promise.all([
        fetchBook(arbConfig, quote.yesTokenId),
        fetchBook(arbConfig, quote.noTokenId),
      ]);
      quote.yesBook = yesBook;
      quote.noBook = noBook;
    } catch {
      // leave empty books
    }
    return quote;
  });
  return { quotes, eventTitle: event.title ?? slug };
}

function buildPackages(quotes: MarketQuote[], foundAt: string, asset: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < quotes.length; i++) {
    for (let j = i + 1; j < quotes.length; j++) {
      const broad = quotes[i];
      const narrow = quotes[j];
      if (narrow.strike - broad.strike > MAX_WIDTH + 1e-9) continue;
      if (broad.ladderKey !== narrow.ladderKey) continue;
      const packageCost = broad.yesBook.ask + narrow.noBook.ask;
      if (!(packageCost > 0) || !Number.isFinite(packageCost)) continue;
      const availableSize = Math.min(broad.yesBook.askSize, narrow.noBook.askSize);
      candidates.push({
        foundAt,
        asset,
        eventSlug: broad.eventSlug,
        eventTitle: broad.eventTitle,
        packageId: `${broad.eventSlug}::YES-${broad.marketId}+NO-${narrow.marketId}`,
        direction: "above",
        broad,
        narrow,
        packageCost,
        lockedEdge: 1 - packageCost,
        availableSize,
        maxSpread: Math.max(broad.yesBook.spread, narrow.yesBook.spread),
        minLiquidity: Math.min(broad.liquidity, narrow.liquidity),
        jackpotPayoutPerShare: 2,
        eligible: true,
        rejectionReasons: [],
      });
    }
  }
  return candidates;
}

function ladderRows(quotes: MarketQuote[]) {
  return quotes.map((q) => ({
    strike: q.strike,
    marketId: q.marketId,
    yesTokenId: q.yesTokenId,
    noTokenId: q.noTokenId,
    yesAsk: q.yesBook.ask,
    yesAskSize: q.yesBook.askSize,
    noAsk: q.noBook.ask,
    noAskSize: q.noBook.askSize,
    ladderKey: q.ladderKey,
  }));
}

function packageRows(candidates: Candidate[]) {
  return candidates.map((c) => ({
    packageId: c.packageId,
    lo: Math.min(c.broad.strike, c.narrow.strike),
    hi: Math.max(c.broad.strike, c.narrow.strike),
    packageCost: c.packageCost,
    availableSize: c.availableSize,
    broadYesAsk: c.broad.yesBook.ask,
    narrowNoAsk: c.narrow.noBook.ask,
    broadYesAskSize: c.broad.yesBook.askSize,
    narrowNoAskSize: c.narrow.noBook.askSize,
    broadMarketId: c.broad.marketId,
    narrowMarketId: c.narrow.marketId,
    broadYesTokenId: c.broad.yesTokenId,
    narrowNoTokenId: c.narrow.noTokenId,
    ladderKey: c.broad.ladderKey,
  }));
}

async function pollFeed(bindingSource: "statsapi" | "fotmob", feedId: string): Promise<FeedSnapshot> {
  return bindingSource === "statsapi" ? pollMlbFeed(feedId) : pollFotmobFeed(feedId);
}

// --- SportsDataIO comparison feed (shadow-only; production stays on StatsAPI) ---

type SdioGame = {
  GameID?: number;
  Status?: string;
  AwayTeam?: string;
  HomeTeam?: string;
  AwayTeamRuns?: number | null;
  HomeTeamRuns?: number | null;
  Inning?: number | null;
  InningHalf?: string | null; // T (top), B (bottom), M (middle), E (end), null
  Outs?: number | null;
  Balls?: number | null;
  Strikes?: number | null;
  DateTime?: string | null;
};

// Polymarket slug abbreviations vs SportsDataIO abbreviations occasionally
// differ; canonicalize both sides before matching.
const SDIO_TEAM_ALIASES: Record<string, string> = {
  chw: "cws",
  was: "wsh",
  az: "ari",
  oak: "ath",
};

function canonTeam(abbr: string): string {
  const a = abbr.toLowerCase();
  return SDIO_TEAM_ALIASES[a] ?? a;
}

function sdioDateKey(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month").toUpperCase()}-${get("day")}`;
}

function sdioScoreKey(g: SdioGame): string {
  const away = g.AwayTeamRuns ?? "x";
  const home = g.HomeTeamRuns ?? "x";
  const period = g.Inning != null ? `${g.InningHalf ?? ""}${g.Inning}` : "";
  return `${away}-${home}|${period}|${g.Outs ?? ""}|${g.Status ?? ""}`;
}

const lastSdioKeys = new Map<string, string>();

async function pollSdioSlate(tracked: Map<string, TrackedEvent>): Promise<void> {
  const url = `https://api.sportsdata.io/v3/mlb/scores/json/GamesByDate/${sdioDateKey()}?key=${SDIO_KEY}`;
  const games = await fetchJson(url, Number(process.env.STATE_FEED_FETCH_TIMEOUT_MS ?? 12_000)) as SdioGame[];
  if (!Array.isArray(games)) return;
  const observedAt = new Date().toISOString();
  for (const te of tracked.values()) {
    if (te.asset !== "MLB") continue;
    const parsed = parseSportsSlug(te.slug);
    if (!parsed) continue;
    // Match teams order-insensitively; slug order is usually away-home but not guaranteed.
    const slugTeams = new Set([canonTeam(parsed.teamA), canonTeam(parsed.teamB)]);
    const game = games.find((g) =>
      slugTeams.has(canonTeam(String(g.AwayTeam ?? "")))
      && slugTeams.has(canonTeam(String(g.HomeTeam ?? "")))
      && g.AwayTeam !== g.HomeTeam,
    );
    if (!game) continue;
    const key = sdioScoreKey(game);
    const prev = lastSdioKeys.get(te.slug);
    if (prev === key) continue;
    lastSdioKeys.set(te.slug, key);
    // First observation just seeds the key (mirrors lastFeedKey handling) so a
    // logger restart mid-game doesn't fabricate a change event.
    if (prev === undefined) continue;
    appendJsonl(SHADOW_PATH, {
      schemaVersion: 1,
      kind: "sdio_change",
      observedAt,
      eventSlug: te.slug,
      asset: te.asset,
      prevSdioKey: prev,
      sdioKey: key,
      // StatsAPI's latest key at this instant, for direct lead/lag comparison.
      statsapiKey: te.lastFeedKey,
      sdio: {
        gameId: game.GameID ?? null,
        status: game.Status ?? null,
        scoreAway: game.AwayTeamRuns ?? null,
        scoreHome: game.HomeTeamRuns ?? null,
        inning: game.Inning ?? null,
        inningHalf: game.InningHalf ?? null,
        outs: game.Outs ?? null,
        balls: game.Balls ?? null,
        strikes: game.Strikes ?? null,
      },
    });
    log(`sdio_change slug=${te.slug} ${prev} -> ${key} (statsapi=${te.lastFeedKey})`);
  }
}

// --- The Odds API scores comparison feed (shadow-only) ---

type OddsApiScore = { name?: string; score?: string };
type OddsApiGame = {
  id?: string;
  commence_time?: string;
  completed?: boolean;
  home_team?: string;
  away_team?: string;
  scores?: OddsApiScore[] | null;
  last_update?: string | null;
};

// Polymarket MLB slug abbreviations -> Odds API full team names.
const ODDS_API_TEAM_BY_ABBR: Record<string, string> = {
  ari: "Arizona Diamondbacks",
  atl: "Atlanta Braves",
  bal: "Baltimore Orioles",
  bos: "Boston Red Sox",
  chc: "Chicago Cubs",
  cin: "Cincinnati Reds",
  cle: "Cleveland Guardians",
  col: "Colorado Rockies",
  cws: "Chicago White Sox",
  det: "Detroit Tigers",
  hou: "Houston Astros",
  kc: "Kansas City Royals",
  laa: "Los Angeles Angels",
  lad: "Los Angeles Dodgers",
  mia: "Miami Marlins",
  mil: "Milwaukee Brewers",
  min: "Minnesota Twins",
  nym: "New York Mets",
  nyy: "New York Yankees",
  oak: "Athletics",
  ath: "Athletics",
  phi: "Philadelphia Phillies",
  pit: "Pittsburgh Pirates",
  sd: "San Diego Padres",
  sea: "Seattle Mariners",
  sf: "San Francisco Giants",
  stl: "St. Louis Cardinals",
  tb: "Tampa Bay Rays",
  tex: "Texas Rangers",
  tor: "Toronto Blue Jays",
  wsh: "Washington Nationals",
  was: "Washington Nationals",
  chw: "Chicago White Sox",
  az: "Arizona Diamondbacks",
};

function oddsApiScoreOf(game: OddsApiGame, teamName: string): number | null {
  const row = (game.scores ?? []).find((s) => s.name === teamName);
  if (!row || row.score == null || row.score === "") return null;
  const n = Number(row.score);
  return Number.isFinite(n) ? n : null;
}

function oddsApiScoreKey(game: OddsApiGame): string {
  const away = oddsApiScoreOf(game, String(game.away_team ?? ""));
  const home = oddsApiScoreOf(game, String(game.home_team ?? ""));
  const awayPart = away == null ? "x" : String(away);
  const homePart = home == null ? "x" : String(home);
  const status = game.completed ? "Final" : (away == null && home == null ? "Scheduled" : "InProgress");
  return `${awayPart}-${homePart}|${status}`;
}

const lastOddsApiKeys = new Map<string, string>();

async function pollOddsApiSlate(tracked: Map<string, TrackedEvent>): Promise<void> {
  // No daysFrom: live + upcoming only, costs 1 quota credit per call.
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/scores/?apiKey=${ODDS_API_KEY}`;
  const games = await fetchJson(url, Number(process.env.STATE_FEED_FETCH_TIMEOUT_MS ?? 12_000)) as OddsApiGame[];
  if (!Array.isArray(games)) return;
  const observedAt = new Date().toISOString();
  for (const te of tracked.values()) {
    if (te.asset !== "MLB") continue;
    const parsed = parseSportsSlug(te.slug);
    if (!parsed) continue;
    const nameA = ODDS_API_TEAM_BY_ABBR[canonTeam(parsed.teamA)];
    const nameB = ODDS_API_TEAM_BY_ABBR[canonTeam(parsed.teamB)];
    if (!nameA || !nameB) continue;
    const slugTeams = new Set([nameA, nameB]);
    const game = games.find((g) =>
      slugTeams.has(String(g.away_team ?? ""))
      && slugTeams.has(String(g.home_team ?? ""))
      && g.away_team !== g.home_team,
    );
    if (!game) continue;
    const key = oddsApiScoreKey(game);
    const prev = lastOddsApiKeys.get(te.slug);
    if (prev === key) continue;
    lastOddsApiKeys.set(te.slug, key);
    if (prev === undefined) continue;
    const scoreAway = oddsApiScoreOf(game, String(game.away_team ?? ""));
    const scoreHome = oddsApiScoreOf(game, String(game.home_team ?? ""));
    appendJsonl(SHADOW_PATH, {
      schemaVersion: 1,
      kind: "oddsapi_change",
      observedAt,
      eventSlug: te.slug,
      asset: te.asset,
      prevOddsApiKey: prev,
      oddsApiKey: key,
      statsapiKey: te.lastFeedKey,
      oddsapi: {
        eventId: game.id ?? null,
        completed: game.completed ?? null,
        scoreAway,
        scoreHome,
        lastUpdate: game.last_update ?? null,
        commenceTime: game.commence_time ?? null,
      },
    });
    log(`oddsapi_change slug=${te.slug} ${prev} -> ${key} (statsapi=${te.lastFeedKey})`);
  }
}

async function main(): Promise<void> {
  ensureStateDirs();
  log(`starting shadowPath=${SHADOW_PATH} mapPath=${MAP_PATH} dataDir=${DATA_DIR}`);
  log(`poll live=${LIVE_POLL_MS}ms fotmob=${FOTMOB_POLL_MS}ms idle=${IDLE_POLL_MS}ms discovery=${DISCOVERY_MS}ms`);

  const map = loadEventMap(MAP_PATH);
  const tracked = new Map<string, TrackedEvent>();
  let lastDiscovery = 0;
  let lastSdioPollAt = 0;
  let lastOddsApiPollAt = 0;
  if (SDIO_KEY) log(`sportsdata.io comparison feed enabled (MLB, poll=${SDIO_POLL_MS}ms live / ${SDIO_IDLE_POLL_MS}ms idle)`);
  if (ODDS_API_KEY) log(`the-odds-api comparison feed enabled (MLB, poll=${ODDS_API_POLL_MS}ms live / ${ODDS_API_IDLE_POLL_MS}ms idle)`);

  async function refreshDiscovery(): Promise<void> {
    const found = await discoverSlugs();
    log(`discovery: ${found.length} MLB/soccer slugs`);
    for (const item of found) {
      const binding = await ensureBinding(map, item.slug, item.asset, item.title);
      if (!binding) {
        log(`unmapable slug=${item.slug}`);
        continue;
      }
      if (!tracked.has(item.slug)) {
        tracked.set(item.slug, {
          slug: item.slug,
          asset: item.asset,
          title: item.title,
          lastFeedKey: null,
          lastFeedPollAt: 0,
          lastBookPollAt: 0,
          feedLive: false,
        });
        log(`mapped ${item.slug} -> ${item.asset}/${binding.source}:${binding.feedId} (${binding.confidence})`);
      } else {
        const t = tracked.get(item.slug)!;
        t.title = item.title;
      }
    }
    // Drop slugs no longer discovered
    for (const slug of [...tracked.keys()]) {
      if (!found.some((f) => f.slug === slug)) tracked.delete(slug);
    }
    saveEventMap(MAP_PATH, map);
    lastDiscovery = Date.now();
  }

  await refreshDiscovery();

  for (;;) {
    const now = Date.now();
    if (now - lastDiscovery >= DISCOVERY_MS) {
      try {
        await refreshDiscovery();
      } catch (err: any) {
        log(`discovery failed: ${err?.message ?? err}`);
      }
    }

    if (SDIO_KEY) {
      const anyMlbLive = [...tracked.values()].some((t) => t.asset === "MLB" && t.feedLive);
      const sdioInterval = anyMlbLive ? SDIO_POLL_MS : SDIO_IDLE_POLL_MS;
      if (now - lastSdioPollAt >= sdioInterval) {
        lastSdioPollAt = now;
        try {
          await pollSdioSlate(tracked);
        } catch (err: any) {
          log(`sdio poll failed: ${err?.message ?? err}`);
        }
      }
    }

    if (ODDS_API_KEY) {
      const anyMlbLive = [...tracked.values()].some((t) => t.asset === "MLB" && t.feedLive);
      const oddsInterval = anyMlbLive ? ODDS_API_POLL_MS : ODDS_API_IDLE_POLL_MS;
      if (now - lastOddsApiPollAt >= oddsInterval) {
        lastOddsApiPollAt = now;
        try {
          await pollOddsApiSlate(tracked);
        } catch (err: any) {
          log(`oddsapi poll failed: ${err?.message ?? err}`);
        }
      }
    }

    const slugs = [...tracked.values()];
    for (const te of slugs) {
      const binding = map.bindings[te.slug];
      if (!binding) continue;

      const feedInterval = te.asset === "SOCCER"
        ? (te.feedLive ? FOTMOB_POLL_MS : IDLE_POLL_MS)
        : (te.feedLive ? LIVE_POLL_MS : IDLE_POLL_MS);
      const bookInterval = te.feedLive ? LIVE_POLL_MS : IDLE_POLL_MS;

      let feed: FeedSnapshot | null = null;
      if (now - te.lastFeedPollAt >= feedInterval) {
        try {
          feed = await pollFeed(binding.source, binding.feedId);
          te.lastFeedPollAt = Date.now();
          te.feedLive = feed.live;
        } catch (err: any) {
          log(`feed poll failed slug=${te.slug}: ${err?.message ?? err}`);
        }
      }

      let quotes: MarketQuote[] = [];
      let eventTitle = te.title;
      if (now - te.lastBookPollAt >= bookInterval) {
        try {
          const loaded = await loadTotalsLadder(te.slug);
          quotes = loaded.quotes;
          eventTitle = loaded.eventTitle;
          te.lastBookPollAt = Date.now();
        } catch (err: any) {
          log(`book poll failed slug=${te.slug}: ${err?.message ?? err}`);
        }
      }

      // Need both feed+books to emit a full snapshot; score_change can emit with prior books
      if (!feed && quotes.length === 0) continue;

      if (feed && quotes.length > 0) {
        const foundAt = new Date().toISOString();
        const candidates = buildPackages(quotes, foundAt, te.asset);
        const row = {
          schemaVersion: 1,
          kind: "snapshot",
          observedAt: foundAt,
          eventSlug: te.slug,
          eventTitle,
          asset: te.asset,
          feed: {
            source: feed.source,
            feedId: feed.feedId,
            live: feed.live,
            scoreHome: feed.scoreHome,
            scoreAway: feed.scoreAway,
            period: feed.period,
            outs: feed.outs,
            clock: feed.clock,
            status: feed.status,
          },
          ladder: ladderRows(quotes),
          packages: packageRows(candidates),
        };
        appendJsonl(SHADOW_PATH, row);

        if (te.lastFeedKey && te.lastFeedKey !== feed.rawScoreKey) {
          const scoreOnlyAwayHome = te.lastFeedKey.split("|")[0];
          const newAwayHome = feed.rawScoreKey.split("|")[0];
          const scoring = isNumericScore(scoreOnlyAwayHome) && isNumericScore(newAwayHome) && scoreOnlyAwayHome !== newAwayHome;
          appendJsonl(SHADOW_PATH, {
            schemaVersion: 1,
            kind: "score_change",
            observedAt: foundAt,
            eventSlug: te.slug,
            eventTitle,
            asset: te.asset,
            scoring,
            prevScoreKey: te.lastFeedKey,
            feed: row.feed,
            ladder: row.ladder,
            packages: row.packages,
          });
          log(`score_change slug=${te.slug} scoring=${scoring} ${te.lastFeedKey} -> ${feed.rawScoreKey}`);
        }
        te.lastFeedKey = feed.rawScoreKey;
      } else if (feed && te.lastFeedKey && te.lastFeedKey !== feed.rawScoreKey) {
        // Feed moved but books not refreshed this tick — still log score_change without ladder
        const foundAt = new Date().toISOString();
        const prevScorePart = te.lastFeedKey.split("|")[0];
        const newScorePart = feed.rawScoreKey.split("|")[0];
        const scoring = isNumericScore(prevScorePart) && isNumericScore(newScorePart) && prevScorePart !== newScorePart;
        appendJsonl(SHADOW_PATH, {
          schemaVersion: 1,
          kind: "score_change",
          observedAt: foundAt,
          eventSlug: te.slug,
          eventTitle: te.title,
          asset: te.asset,
          scoring,
          prevScoreKey: te.lastFeedKey,
          feed: {
            source: feed.source,
            feedId: feed.feedId,
            live: feed.live,
            scoreHome: feed.scoreHome,
            scoreAway: feed.scoreAway,
            period: feed.period,
            outs: feed.outs,
            clock: feed.clock,
            status: feed.status,
          },
          ladder: [],
          packages: [],
        });
        te.lastFeedKey = feed.rawScoreKey;
        log(`score_change(no-books) slug=${te.slug} scoring=${scoring}`);
      } else if (feed && !te.lastFeedKey) {
        te.lastFeedKey = feed.rawScoreKey;
      }
    }

    await sleep(250);
  }
}

// A real score looks like "0-3"; pre-game placeholders look like "x-x". A transition
// from placeholder to "0-0" is game start, not a scoring play.
function isNumericScore(scorePart: string): boolean {
  return /^\d+-\d+$/.test(scorePart);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
