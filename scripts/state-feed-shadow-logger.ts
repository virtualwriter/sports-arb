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

async function main(): Promise<void> {
  ensureStateDirs();
  log(`starting shadowPath=${SHADOW_PATH} mapPath=${MAP_PATH} dataDir=${DATA_DIR}`);
  log(`poll live=${LIVE_POLL_MS}ms fotmob=${FOTMOB_POLL_MS}ms idle=${IDLE_POLL_MS}ms discovery=${DISCOVERY_MS}ms`);

  const map = loadEventMap(MAP_PATH);
  const tracked = new Map<string, TrackedEvent>();
  let lastDiscovery = 0;

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
