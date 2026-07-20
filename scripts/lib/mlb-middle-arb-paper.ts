/**
 * Paper sidecar for MLB middle-arb (score-triggered lane).
 *
 * Streams with ladder-lag-race:
 *   - PM ladders (TOB for allowlisted middles)
 *   - PM / bwin score ticks → detect runs
 *   - StatsAPI poll → accurate P(middle) (innings + outs + bases)
 *
 * Fair model: empirical PA-chain MC (mlb-pa-chain.ts, 2024 kernel, beat the
 * Strat2 Poisson on 2025 hold-out) with the Poisson as fallback when the
 * kernel or a parseable game state is unavailable.
 *
 * On each score change:
 *   1. Record when each score signal arrived
 *   2. Snapshot every cached middle: pre/post P, cost, edge gain
 *   3. Track PM cost/edge path for ~15s to measure reprice window
 *   4. Log book-signal lags (ML / totals / spreads first move after score)
 *
 * Pre-confirm (each AB):
 *   - Cache fair for +1/+2/+3(+4) RBI branches
 *   - Weight branches with empirical PA RBI priors (outs×bases)
 *   - Shadow-log PA expected edge vs best branch edge
 */

import {
  findStructuralCandidates,
  type ArbCoreConfig,
  type Candidate,
} from "./monotonic-arb-core.js";
import {
  buildMlbMiddleArbEventCache,
  findKalshiSpreadMiddleCandidates,
  findKalshiTotalMiddleCandidates,
  huntListForRbiDelta,
  mergeMlbPaperCandidates,
  mlbPaperAllShapesEnabled,
  refreshMlbMiddleArbCacheState,
  serializeMlbMiddleArbEventCache,
  type MlbMiddleArbCachedPackage,
  type MlbMiddleArbEventCache,
} from "./mlb-middle-arb-cache.js";
import { rbiDeltaFromScoreChange, type MlbRbiDelta } from "./mlb-rbi-branches.js";
import {
  basesKeyFromFlags,
  bestStrat2BranchEdge,
  expectedEdgeUnderPaPriors,
  loadPaRbiPriors,
  lookupPaRbiP,
  scoringDeltaWeights,
  type PaRbiPriors,
} from "./mlb-pa-rbi-priors.js";
import {
  EDGE_MARGIN,
  PATH_COST_STEP,
  POST_SCORE_TRACK_MS,
  screenMlbMiddleArbEdge,
  screenMlbMiddleArbLegs,
  type MlbMiddleArbFilterReason,
} from "./mlb-middle-arb-filters.js";
import { PATHS } from "./paths.js";
import {
  ensureBinding,
  loadEventMap,
  pollMlbFeed,
  saveEventMap,
  type EventMapFile,
  type FeedSnapshot,
} from "./state-feed-map.js";
import {
  computeMlbBandState,
  computeMlbSpreadBandState,
  paChainTable,
} from "./mlb-pa-chain.js";

export const MLB_MIDDLE_ARB_PAPER_VERSION = "2026-07-18.1";

export type PaperEmit = (row: Record<string, unknown>) => void;
export type PaperLog = (msg: string) => void;

type TobSide = { ask: number; askSize: number; t: number };
type Venue = "pm" | "kalshi";

type ScoreSignals = {
  firstSource: string;
  t0: number;
  bySource: Record<string, number>;
};

type PackagePathPoint = {
  dtMs: number;
  cost: number;
  edge: number;
  fair: number;
  pMiddle: number;
};

type PackageSnapshot = {
  packageId: string;
  venue: Venue;
  lineFamily: string;
  marketType: string;
  shapeKey: string;
  cost: number;
  size: number;
  preP: number | null;
  preFair: number | null;
  preEdge: number;
  pMiddle: number;
  fair: number;
  postEdge: number;
  edgeGain: number;
  inningsLeft: number;
  terminal: boolean;
  screenOk: boolean;
  screenReason: MlbMiddleArbFilterReason;
  maxLiveCost: number;
};

type WatchedPackage = {
  packageId: string;
  venue: Venue;
  lineFamily: string;
  marketType: string;
  preEdge: number;
  postEdge: number;
  edgeGain: number;
  cost0: number;
  fair0: number;
  p0: number;
  path: PackagePathPoint[];
  lastCost: number;
  timeEdgeGeMarginMs: number | null;
  timeCostPlus3cMs: number | null;
  screenOk: boolean;
  screenReason: MlbMiddleArbFilterReason;
};

type ActiveScoreTrack = {
  eventId: string;
  t0: number;
  endsAt: number;
  scoreAway: number;
  scoreHome: number;
  signals: ScoreSignals;
  bookSignals: {
    moneylineFirstMoveMs: number | null;
    totalFirstMoveMs: number | null;
    spreadFirstMoveMs: number | null;
    kalshiTotalFirstMoveMs: number | null;
  };
  watched: WatchedPackage[];
};

function arbConfig(): ArbCoreConfig {
  return {
    host: process.env.CLOB_HOST ?? "https://clob.polymarket.com",
    gammaApi: process.env.GAMMA_API ?? "https://gamma-api.polymarket.com",
    fetchTimeoutMs: 12_000,
    marketConcurrency: 8,
    eventConcurrency: 2,
    allowedAssets: new Set(["MLB"]),
    minEdge: -1,
    maxSpread: 1,
    minLiquidity: 0,
    minAvailableShares: 0,
  };
}

function formatStrikeKey(n: number): string {
  return String(n);
}

function parseScorePair(score: string): { a: number; b: number } | null {
  const parts = String(score).replace("-", ":").split(":");
  if (parts.length < 2) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { a, b };
}

function summarizeSnap(s: PackageSnapshot) {
  return {
    venue: s.venue,
    lineFamily: s.lineFamily,
    marketType: s.marketType,
    cost: s.cost,
    preEdge: s.preEdge,
    postEdge: s.postEdge,
    edgeGain: s.edgeGain,
    pMiddle: s.pMiddle,
    fair: s.fair,
    inningsLeft: s.inningsLeft,
    screenOk: s.screenOk,
    screenReason: s.screenReason,
  };
}

function summarizeWatch(w: WatchedPackage) {
  return {
    venue: w.venue,
    lineFamily: w.lineFamily,
    marketType: w.marketType,
    cost0: w.cost0,
    postEdge: w.postEdge,
    edgeGain: w.edgeGain,
    screenOk: w.screenOk,
  };
}

export class MlbMiddleArbPaperSidecar {
  readonly opts: {
    eventSlug: string;
    eventTitle: string;
    emit: PaperEmit;
    log?: PaperLog;
  };

  private cache: MlbMiddleArbEventCache | null = null;
  private readonly tob = new Map<string, TobSide>();
  private readonly kalshiTob = new Map<string, TobSide>();
  private scoreAway = 0;
  private scoreHome = 0;
  private seenScore = false;
  private eventMap: EventMapFile | null = null;
  private feedId: string | null = null;
  private latestFeed: FeedSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private track: ActiveScoreTrack | null = null;
  private trackTimer: ReturnType<typeof setTimeout> | null = null;
  private scoringLock: Promise<void> = Promise.resolve();

  private scoreEvents = 0;
  private wouldFire = 0;
  private statsapiPolls = 0;
  private lastMenuKey = "";
  private paPriors: PaRbiPriors | null = null;
  /** While set, slower feeds cannot pull the score back below the phone tap. */
  private phoneScoreLock: { away: number; home: number; until: number } | null = null;
  /** Book TOB frozen at phone-ping t0 for stale-book edge (fair moves, books don't). */
  private frozenTob: { pm: Map<string, TobSide>; kalshi: Map<string, TobSide> } | null = null;

  constructor(opts: {
    eventSlug: string;
    eventTitle: string;
    emit: PaperEmit;
    log?: PaperLog;
  }) {
    this.opts = opts;
  }

  get stats() {
    return {
      scoreEvents: this.scoreEvents,
      wouldFire: this.wouldFire,
      packages: this.cache?.packages.length ?? 0,
      statsapiPolls: this.statsapiPolls,
      feedId: this.feedId,
      paPriorsLoaded: Boolean(this.paPriors),
      paPriorsPas: this.paPriors?.totalPlateAppearances ?? 0,
      paChainLoaded: Boolean(paChainTable()),
      paChainPas: paChainTable()?.plateAppearances ?? 0,
    };
  }

  hydrateForTests(cache: MlbMiddleArbEventCache, score = { away: 0, home: 0 }): void {
    this.cache = cache;
    this.scoreAway = score.away;
    this.scoreHome = score.home;
    this.seenScore = true;
    this.latestFeed = cache.feed;
    this.paPriors = loadPaRbiPriors(process.env.PLR_MLB_PA_RBI_PRIOR_PATH ?? PATHS.mlbPaRbiPriors);
  }

  async init(): Promise<void> {
    const log = this.opts.log ?? (() => {});
    const priorPath = process.env.PLR_MLB_PA_RBI_PRIOR_PATH ?? PATHS.mlbPaRbiPriors;
    this.paPriors = loadPaRbiPriors(priorPath);
    if (this.paPriors) {
      log(
        `mlb-paper: PA RBI priors loaded pas=${this.paPriors.totalPlateAppearances} `
        + `window=${this.paPriors.startDate}..${this.paPriors.endDate} `
        + `cells=${this.paPriors.byOutsBases.size}`,
      );
    } else {
      log(`mlb-paper: PA RBI priors MISSING at ${priorPath} — equal branch weights fallback`);
    }

    const chain = paChainTable();
    if (chain) {
      log(
        `mlb-paper: PA-chain fair model loaded pas=${chain.plateAppearances} `
        + `train=${chain.trainYear ?? "?"} cells=${chain.cells.size} (Poisson fallback only)`,
      );
    } else {
      log("mlb-paper: PA-chain kernel MISSING — falling back to Strat2 Poisson fair");
    }

    const foundAt = new Date().toISOString();
    const { candidates, errors } = await findStructuralCandidates(
      arbConfig(),
      [this.opts.eventSlug],
      foundAt,
    );
    if (errors.length) log(`mlb-paper: structural errors: ${errors.join("; ")}`);

    const pmNormalized: Candidate[] = candidates.map((c) => ({
      ...c,
      eventSlug: this.opts.eventSlug,
      eventTitle: this.opts.eventTitle,
      asset: "MLB",
    }));

    // PM often lists only a couple totals/spread rungs; Kalshi carries full
    // ladders. Merge so every offered middle is in the paper cache.
    const totalsTicker = process.env.PLR_KALSHI_EVENT || process.env.KALSHI_MLB_EVENT;
    const kalshiTotals = await findKalshiTotalMiddleCandidates({
      eventSlug: this.opts.eventSlug,
      eventTitle: this.opts.eventTitle,
      foundAt,
      eventTicker: totalsTicker,
    });
    if (kalshiTotals.error) {
      log(`mlb-paper: Kalshi totals discover failed: ${kalshiTotals.error}`);
    } else {
      log(
        `mlb-paper: Kalshi totals ${kalshiTotals.eventTicker} rungs=${kalshiTotals.rungCount} `
        + `pairs=${kalshiTotals.candidates.length}`,
      );
    }
    const kalshiSpreads = await findKalshiSpreadMiddleCandidates({
      eventSlug: this.opts.eventSlug,
      eventTitle: this.opts.eventTitle,
      foundAt,
      totalsEventTicker: kalshiTotals.eventTicker ?? totalsTicker,
      spreadEventTicker: process.env.PLR_KALSHI_SPREAD_EVENT,
    });
    if (kalshiSpreads.error) {
      log(`mlb-paper: Kalshi spreads discover failed: ${kalshiSpreads.error}`);
    } else {
      log(
        `mlb-paper: Kalshi spreads ${kalshiSpreads.eventTicker} rungs=${kalshiSpreads.rungCount} `
        + `teams=${kalshiSpreads.teamCount} pairs=${kalshiSpreads.candidates.length}`,
      );
    }
    const kalshiAll = [...kalshiTotals.candidates, ...kalshiSpreads.candidates];
    const normalized = mergeMlbPaperCandidates(pmNormalized, kalshiAll);
    log(
      `mlb-paper: candidates pm=${pmNormalized.length} kalshiTotals=${kalshiTotals.candidates.length} `
      + `kalshiSpreads=${kalshiSpreads.candidates.length} merged=${normalized.length}`,
    );

    this.eventMap = loadEventMap(PATHS.stateFeedEventMap);
    const binding = await ensureBinding(
      this.eventMap,
      this.opts.eventSlug,
      "MLB",
      this.opts.eventTitle,
    );
    if (binding) {
      this.feedId = binding.feedId;
      try {
        saveEventMap(PATHS.stateFeedEventMap, this.eventMap);
      } catch {
        /* ignore */
      }
      try {
        this.latestFeed = await pollMlbFeed(binding.feedId);
        this.statsapiPolls += 1;
        if (this.latestFeed.scoreAway != null && this.latestFeed.scoreHome != null) {
          this.scoreAway = this.latestFeed.scoreAway;
          this.scoreHome = this.latestFeed.scoreHome;
          this.seenScore = true;
        }
      } catch (e) {
        log(`mlb-paper: initial StatsAPI poll failed: ${String(e).slice(0, 80)}`);
      }
    } else {
      log("mlb-paper: no StatsAPI binding — P(middle) weak until bound");
    }

    const allShapes = mlbPaperAllShapesEnabled();
    this.cache = buildMlbMiddleArbEventCache({
      eventSlug: this.opts.eventSlug,
      eventTitle: this.opts.eventTitle,
      candidates: normalized,
      feed: this.latestFeed,
      allShapes,
    });

    this.opts.emit({
      kind: "mlb_paper_init",
      version: MLB_MIDDLE_ARB_PAPER_VERSION,
      eventSlug: this.opts.eventSlug,
      title: this.opts.eventTitle,
      feedId: this.feedId,
      packages: this.cache.packages.length,
      allShapes,
      shapes: [...new Set(this.cache.packages.map((p) => p.shapeKey))],
      fairModel: chain ? "pa_chain" : "poisson",
      paChain: chain
        ? {
            path: chain.path,
            generatedAt: chain.generatedAt,
            trainYear: chain.trainYear,
            plateAppearances: chain.plateAppearances,
            cells: chain.cells.size,
          }
        : null,
      paPriors: this.paPriors
        ? {
            path: this.paPriors.path,
            generatedAt: this.paPriors.generatedAt,
            startDate: this.paPriors.startDate,
            endDate: this.paPriors.endDate,
            totalPlateAppearances: this.paPriors.totalPlateAppearances,
            cells: this.paPriors.byOutsBases.size,
          }
        : null,
      cache: serializeMlbMiddleArbEventCache(this.cache),
    });
    log(
      `mlb-paper: cache ready packages=${this.cache.packages.length} `
      + `totals=${this.cache.packages.filter((p) => p.marketType === "game_total").length} `
      + `spreads=${this.cache.packages.filter((p) => p.marketType === "spread").length} `
      + `allShapes=${allShapes ? "on" : "off"} `
      + `statsapi=${this.feedId ?? "none"} `
      + `fair=${chain ? "pa_chain" : "poisson"} `
      + `paPriors=${this.paPriors ? "on" : "off"} `
      + `rbiDeltas=[${this.cache.rbiBranches.map((b) => b.rbiDelta).join(",")}]`,
    );
    this.emitRbiMenu("init", true);

    this.pollTimer = setInterval(() => {
      void this.pollStatsApi("interval");
    }, Number(process.env.PLR_MLB_STATSAPI_POLL_MS ?? 2000));
  }

  onLadder(row: {
    market: string;
    klass?: string;
    side: string;
    bestAsk?: number | null;
    bestAskSize?: number | null;
    t?: number;
  }): void {
    const t = row.t ?? Date.now();
    const key = `${row.market}:${row.side}`;
    // An emptied ask side (ask 0/null or no size) means "no quote", not "free".
    // Clear the TOB entry so package costs go missing instead of stale/zero
    // (e.g. a locked winning leg whose asks all get pulled).
    if (row.bestAsk == null || !(row.bestAsk > 0) || !((row.bestAskSize ?? 0) > 0)) {
      this.tob.delete(key);
      return;
    }
    const prev = this.tob.get(key);
    const ask = Number(row.bestAsk);
    this.tob.set(key, { ask, askSize: Number(row.bestAskSize), t });

    if (!this.track || t < this.track.t0) return;

    if (prev && Math.abs(ask - prev.ask) >= 0.01) {
      const dt = t - this.track.t0;
      if (dt >= 0 && dt <= POST_SCORE_TRACK_MS) {
        const klass = row.klass
          ?? (row.market.startsWith("total_")
            ? "total"
            : row.market.startsWith("spread_")
              ? "spread"
              : row.market === "moneyline"
                ? "moneyline"
                : "other");
        if (klass === "moneyline" && this.track.bookSignals.moneylineFirstMoveMs == null) {
          this.track.bookSignals.moneylineFirstMoveMs = dt;
        }
        if (klass === "total" && this.track.bookSignals.totalFirstMoveMs == null) {
          this.track.bookSignals.totalFirstMoveMs = dt;
        }
        if (klass === "spread" && this.track.bookSignals.spreadFirstMoveMs == null) {
          this.track.bookSignals.spreadFirstMoveMs = dt;
        }
      }
    }

    this.samplePaths(t);
  }

  onKalshiLadder(row: {
    market: string;
    side: string;
    bestAsk?: number | null;
    bestAskSize?: number | null;
    t?: number;
  }): void {
    const t = row.t ?? Date.now();
    const key = `${row.market}:${row.side}`;
    if (row.bestAsk == null || !(row.bestAsk > 0) || !((row.bestAskSize ?? 0) > 0)) {
      this.kalshiTob.delete(key);
      return;
    }
    const prev = this.kalshiTob.get(key);
    const ask = Number(row.bestAsk);
    this.kalshiTob.set(key, { ask, askSize: Number(row.bestAskSize), t });

    if (!this.track || t < this.track.t0) return;

    if (prev && Math.abs(ask - prev.ask) >= 0.01) {
      const dt = t - this.track.t0;
      if (
        dt >= 0
        && dt <= POST_SCORE_TRACK_MS
        && this.track.bookSignals.kalshiTotalFirstMoveMs == null
      ) {
        this.track.bookSignals.kalshiTotalFirstMoveMs = dt;
      }
    }

    this.samplePaths(t);
  }

  onPmScore(score: string, period?: string, t = Date.now()): void {
    const parsed = parseScorePair(score);
    if (!parsed) return;
    // PM sports score is away-home for mlb slugs.
    this.noteScore("pm_score", parsed.a, parsed.b, t, { period: period ?? null });
  }

  /** Stadium / phone tap — races against pm_score / bwin_score / statsapi on the same clock. */
  onPhonePing(
    away: number,
    home: number,
    t = Date.now(),
    meta: Record<string, unknown> = {},
  ): void {
    if (!Number.isFinite(away) || !Number.isFinite(home)) return;
    this.noteScore("phone_ping", Math.trunc(away), Math.trunc(home), t, {
      ...meta,
      client: "phone",
    });
  }

  /**
   * Drop phone lock / test bumps and re-sync score from StatsAPI (no hunt).
   * Use before a clean stadium tap.
   */
  async resetScoreToFeed(): Promise<{ away: number; home: number; period: string | null }> {
    this.phoneScoreLock = null;
    this.frozenTob = null;
    this.finishTrack("reset");
    if (this.feedId) {
      try {
        this.latestFeed = await pollMlbFeed(this.feedId);
        this.statsapiPolls += 1;
      } catch {
        /* keep prior feed */
      }
    }
    const feed = this.latestFeed;
    if (feed?.scoreAway != null && feed.scoreHome != null) {
      this.scoreAway = feed.scoreAway;
      this.scoreHome = feed.scoreHome;
      this.seenScore = true;
      if (this.cache) this.cache = refreshMlbMiddleArbCacheState(this.cache, feed);
    }
    this.opts.emit({
      kind: "mlb_paper_score_reset",
      away: this.scoreAway,
      home: this.scoreHome,
      period: feed?.period ?? null,
      outs: feed?.outs ?? null,
    });
    (this.opts.log ?? (() => {}))(
      `mlb-paper: RESET score→${this.scoreAway}-${this.scoreHome} `
      + `${feed?.period ?? "?"} outs=${feed?.outs ?? "?"} (phone lock cleared)`,
    );
    return {
      away: this.scoreAway,
      home: this.scoreHome,
      period: feed?.period ?? null,
    };
  }

  getScoreState(): {
    away: number;
    home: number;
    seen: boolean;
    phoneLock: null | { away: number; home: number; remainingMs: number };
    track: null | {
      t0: number;
      scoreAway: number;
      scoreHome: number;
      firstSource: string;
      bySource: Record<string, number>;
      bookSignals: ActiveScoreTrack["bookSignals"];
      ageMs: number;
    };
  } {
    const track = this.track;
    const lock = this.phoneScoreLock;
    return {
      away: this.scoreAway,
      home: this.scoreHome,
      seen: this.seenScore,
      phoneLock: lock
        ? {
            away: lock.away,
            home: lock.home,
            remainingMs: Math.max(0, lock.until - Date.now()),
          }
        : null,
      track: track
        ? {
            t0: track.t0,
            scoreAway: track.scoreAway,
            scoreHome: track.scoreHome,
            firstSource: track.signals.firstSource,
            bySource: { ...track.signals.bySource },
            bookSignals: { ...track.bookSignals },
            ageMs: Date.now() - track.t0,
          }
        : null,
    };
  }

  onBwinScore(raw: unknown, t = Date.now()): void {
    let payload: any = raw;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
    }
    const sb = payload?.scoreboard ?? payload;
    const parsed = parseScorePair(String(sb?.score ?? ""));
    if (!parsed) return;
    // bwin is usually home:away — pick orientation closest to current/StatsAPI.
    let away = parsed.b;
    let home = parsed.a;
    const cur = { away: this.scoreAway, home: this.scoreHome };
    const swap = { away: parsed.b, home: parsed.a };
    const listed = { away: parsed.a, home: parsed.b };
    const dSwap = Math.abs(swap.away - cur.away) + Math.abs(swap.home - cur.home);
    const dList = Math.abs(listed.away - cur.away) + Math.abs(listed.home - cur.home);
    if (this.seenScore && dList < dSwap) {
      away = listed.away;
      home = listed.home;
    }
    this.noteScore("bwin_score", away, home, t, {
      period: sb?.period != null ? String(sb.period) : null,
    });
  }

  end(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.trackTimer) clearTimeout(this.trackTimer);
    this.finishTrack("end");
    this.opts.emit({
      kind: "mlb_paper_end",
      version: MLB_MIDDLE_ARB_PAPER_VERSION,
      ...this.stats,
    });
  }

  private async pollStatsApi(reason: string): Promise<void> {
    if (!this.feedId) return;
    try {
      const feed = await pollMlbFeed(this.feedId);
      this.statsapiPolls += 1;
      this.latestFeed = feed;
      if (this.cache) {
        this.cache = refreshMlbMiddleArbCacheState(this.cache, feed);
        this.emitRbiMenu("statsapi_poll");
      }
      if (feed.scoreAway != null && feed.scoreHome != null) {
        this.noteScore("statsapi", feed.scoreAway, feed.scoreHome, Date.now(), {
          period: feed.period,
          outs: feed.outs,
          runnersOn: feed.runnersOn,
          battingSide: feed.battingSide,
          status: feed.status,
          reason,
        });
      }
    } catch {
      /* interval retries */
    }
  }

  private costByPackageId(): Map<string, number> {
    const m = new Map<string, number>();
    if (!this.cache) return m;
    const useFrozen = Boolean(this.frozenTob);
    for (const pkg of this.cache.packages) {
      // Prefer PM TOB when present; fall back to Kalshi for Kalshi-only bands.
      const tob = this.tobForPackage(pkg, "pm", useFrozen)
        ?? this.tobForPackage(pkg, "kalshi", useFrozen);
      if (!tob) continue;
      m.set(pkg.packageId, tob.broadYesAsk + tob.narrowNoAsk);
    }
    return m;
  }

  private emitRbiMenu(reason: string, force = false): void {
    if (!this.cache?.feed) return;
    const feed = this.cache.feed;
    const bases = basesKeyFromFlags(feed.onFirst, feed.onSecond, feed.onThird);
    const key = [
      feed.runnersOn ?? "x",
      feed.battingSide ?? "x",
      feed.scoreAway ?? "x",
      feed.scoreHome ?? "x",
      feed.outs ?? "x",
      bases,
      this.cache.rbiBranches.map((b) => b.rbiDelta).join(","),
    ].join("|");
    if (!force && key === this.lastMenuKey) return;
    this.lastMenuKey = key;

    const deltas = this.cache.rbiBranches.map((b) => b.rbiDelta);
    const priorLookup = this.paPriors
      ? lookupPaRbiP(this.paPriors, {
          outs: feed.outs,
          onFirst: feed.onFirst,
          onSecond: feed.onSecond,
          onThird: feed.onThird,
          runnersOn: feed.runnersOn,
        })
      : null;
    const pRbi = priorLookup?.p ?? null;
    const weights = priorLookup
      ? scoringDeltaWeights(priorLookup.p, deltas as MlbRbiDelta[])
      : Object.fromEntries(deltas.map((d) => [d, 1 / Math.max(deltas.length, 1)]));

    const costs = this.costByPackageId();
    const menus = this.cache.rbiBranches.map((b) => ({
      rbiDelta: b.rbiDelta,
      scoreAway: b.scoreAway,
      scoreHome: b.scoreHome,
      battingSide: b.battingSide,
      pWeight: weights[b.rbiDelta] ?? 0,
      pRbi: pRbi ? (pRbi as Record<number, number>)[b.rbiDelta] ?? 0 : null,
      hunt: huntListForRbiDelta(this.cache!, b.rbiDelta, costs).slice(0, 10),
    }));

    // Per-package shadow: PA-weighted expected edge vs best Strat2 branch.
    const packageShadow = this.cache.packages.map((pkg) => {
      const cost = costs.get(pkg.packageId) ?? null;
      const evals = this.cache!.branchEvalsByPackage[pkg.packageId] ?? [];
      const branchInputs = evals
        .filter((e) => !e.terminal)
        .map((e) => ({ rbiDelta: e.rbiDelta, fair: e.fair, cost }));
      const expectedEdgePa = expectedEdgeUnderPaPriors(weights, branchInputs);
      const bestStrat2 = bestStrat2BranchEdge(branchInputs);
      return {
        packageId: pkg.packageId,
        lineFamily: pkg.lineFamily,
        marketType: pkg.marketType,
        cost,
        expectedEdgePa,
        bestStrat2Branch: bestStrat2,
      };
    });
    packageShadow.sort(
      (a, b) => (b.expectedEdgePa ?? -Infinity) - (a.expectedEdgePa ?? -Infinity),
    );

    this.opts.emit({
      kind: "mlb_paper_rbi_menu",
      reason,
      runnersOn: feed.runnersOn ?? null,
      onFirst: feed.onFirst ?? null,
      onSecond: feed.onSecond ?? null,
      onThird: feed.onThird ?? null,
      bases,
      battingSide: feed.battingSide ?? null,
      scoreAway: feed.scoreAway,
      scoreHome: feed.scoreHome,
      period: feed.period,
      outs: feed.outs,
      paPrior: priorLookup
        ? {
            source: priorLookup.source,
            cellN: priorLookup.cellN,
            outs: priorLookup.outs,
            bases: priorLookup.bases,
            pRbi: priorLookup.p,
            scoringWeights: weights,
          }
        : {
            source: "equal_fallback",
            cellN: 0,
            outs: feed.outs,
            bases,
            pRbi: null,
            scoringWeights: weights,
          },
      branches: menus,
      topExpectedEdgePa: packageShadow.slice(0, 8),
      confirmPath: "strat2_on_realized_rbi",
    });
  }

  private noteScore(
    source: string,
    away: number,
    home: number,
    t: number,
    meta: Record<string, unknown> = {},
  ): void {
    // Phone is authoritative during the post-tap window: lagging feeds that still
    // show the old score must not rewind fair / kill the stale-book edge calc.
    const lock = this.phoneScoreLock;
    if (lock && t < lock.until && source !== "phone_ping") {
      if (away === lock.away && home === lock.home) {
        if (this.track && this.track.signals.bySource[source] == null) {
          this.track.signals.bySource[source] = t - this.track.t0;
          this.opts.emit({
            kind: "mlb_paper_score_signal",
            source,
            dtMs: t - this.track.t0,
            scoreAway: away,
            scoreHome: home,
            ...meta,
          });
        }
        return;
      }
      if (away + home < lock.away + lock.home) {
        this.opts.emit({
          kind: "mlb_paper_score_ignored",
          source,
          reason: "phone_lock_lagging_feed",
          ignoredAway: away,
          ignoredHome: home,
          lockAway: lock.away,
          lockHome: lock.home,
        });
        return;
      }
    }

    const changed = !this.seenScore || away !== this.scoreAway || home !== this.scoreHome;

    if (!changed) {
      if (this.track && this.track.signals.bySource[source] == null) {
        this.track.signals.bySource[source] = t - this.track.t0;
        this.opts.emit({
          kind: "mlb_paper_score_signal",
          source,
          dtMs: t - this.track.t0,
          scoreAway: away,
          scoreHome: home,
          ...meta,
        });
      }
      return;
    }

    const prevAway = this.scoreAway;
    const prevHome = this.scoreHome;
    const prevTotal = prevAway + prevHome;
    const newTotal = away + home;
    this.scoreAway = away;
    this.scoreHome = home;
    this.seenScore = true;

    this.opts.emit({
      kind: "mlb_paper_score",
      source,
      prevAway,
      prevHome,
      scoreAway: away,
      scoreHome: home,
      runsDelta: newTotal - prevTotal,
      ...meta,
    });

    const isScoringPlay = newTotal > prevTotal;
    if (!isScoringPlay) {
      void this.pollStatsApi("score_touch");
      return;
    }

    this.scoringLock = this.scoringLock
      .then(() => this.onScoringPlay(source, prevAway, prevHome, away, home, t, meta))
      .catch(() => {});
  }

  private async onScoringPlay(
    source: string,
    prevAway: number,
    prevHome: number,
    away: number,
    home: number,
    t: number,
    meta: Record<string, unknown>,
  ): Promise<void> {
    if (!this.cache) return;
    this.finishTrack("superseded");

    // Capture at-bat state before StatsAPI/post-score refresh (for PA prior calibration).
    const preAbFeed = this.cache.feed;
    const preDeltas = this.cache.rbiBranches.map((b) => b.rbiDelta);
    const preBranchEvals = { ...this.cache.branchEvalsByPackage };
    // Freeze books at tap — phone is faster; this is the stale-book cost for edge.
    this.frozenTob = {
      pm: new Map(this.tob),
      kalshi: new Map(this.kalshiTob),
    };
    const preCosts = this.costByPackageId();

    const phoneLead = source === "phone_ping";
    if (phoneLead) {
      this.phoneScoreLock = {
        away,
        home,
        until: t + POST_SCORE_TRACK_MS + 2_000,
      };
    }

    // Do not let a lagging StatsAPI poll rewrite score before we price the phone tap.
    if (!phoneLead && this.feedId) {
      try {
        this.latestFeed = await pollMlbFeed(this.feedId);
        this.statsapiPolls += 1;
      } catch {
        /* use synthetic below */
      }
    }

    const baseFeed = preAbFeed ?? this.latestFeed;
    let feed: FeedSnapshot;
    if (!baseFeed || baseFeed.scoreAway !== away || baseFeed.scoreHome !== home || phoneLead) {
      feed = {
        source: phoneLead ? "phone_ping" : (baseFeed?.source ?? "statsapi"),
        feedId: this.feedId ?? baseFeed?.feedId ?? "synthetic",
        live: true,
        scoreHome: home,
        scoreAway: away,
        period: (typeof meta.period === "string" ? meta.period : null)
          ?? baseFeed?.period
          ?? this.latestFeed?.period
          ?? "Top 5",
        outs: baseFeed?.outs ?? this.latestFeed?.outs ?? null,
        clock: baseFeed?.clock ?? null,
        status: baseFeed?.status ?? "Live",
        rawScoreKey: `${away}-${home}`,
        runnersOn: baseFeed?.runnersOn ?? null,
        onFirst: baseFeed?.onFirst ?? null,
        onSecond: baseFeed?.onSecond ?? null,
        onThird: baseFeed?.onThird ?? null,
        battingSide: baseFeed?.battingSide ?? null,
      };
    } else {
      feed = { ...baseFeed, scoreAway: away, scoreHome: home, live: true };
    }
    this.latestFeed = feed;
    this.cache = refreshMlbMiddleArbCacheState(this.cache, feed);

    const rbiDelta = rbiDeltaFromScoreChange(prevAway, prevHome, away, home);
    // Hunt / edges vs frozen books (phone thesis: fair moved, TOB has not).
    const costs = preCosts;
    const hunt = rbiDelta != null
      ? huntListForRbiDelta(this.cache, rbiDelta, costs)
      : [];

    const paCalibration = this.paPriorCalibrationShadow({
      preAbFeed,
      preDeltas,
      preBranchEvals,
      preCosts,
      realizedRbiDelta: rbiDelta,
    });

    const snapshots = this.snapshotPackages(prevAway, prevHome, feed, { useFrozenTob: true });
    // For phone taps, rank by absolute stale-book edge (fair_new − cost_frozen).
    snapshots.sort((a, b) => (phoneLead ? b.postEdge - a.postEdge : b.edgeGain - a.edgeGain));

    // Watch more bands now that Kalshi fills the full totals ladder.
    const watchTop = Math.max(12, Number(process.env.PLR_MLB_PAPER_WATCH_TOP ?? 32) || 32);
    const selected = snapshots.slice(0, watchTop);
    const bestPositiveKalshi = snapshots.find((s) =>
      s.venue === "kalshi" && (phoneLead ? s.postEdge > 0 : s.edgeGain > 0),
    );
    if (bestPositiveKalshi && !selected.some((s) => s.venue === "kalshi" && s.packageId === bestPositiveKalshi.packageId)) {
      if (selected.length < watchTop) selected.push(bestPositiveKalshi);
      else selected[selected.length - 1] = bestPositiveKalshi;
    }

    const watched: WatchedPackage[] = selected.map((s) => ({
      packageId: s.packageId,
      venue: s.venue,
      lineFamily: s.lineFamily,
      marketType: s.marketType,
      preEdge: s.preEdge,
      postEdge: s.postEdge,
      edgeGain: s.edgeGain,
      cost0: s.cost,
      fair0: s.fair,
      p0: s.pMiddle,
      path: [{ dtMs: 0, cost: s.cost, edge: s.postEdge, fair: s.fair, pMiddle: s.pMiddle }],
      lastCost: s.cost,
      timeEdgeGeMarginMs: s.screenOk ? 0 : null,
      timeCostPlus3cMs: null,
      screenOk: s.screenOk,
      screenReason: s.screenReason,
    }));

    for (const w of watched) {
      if (w.screenOk) this.wouldFire += 1;
    }
    this.scoreEvents += 1;

    this.track = {
      eventId: `${t}-${away}-${home}`,
      t0: t,
      endsAt: t + POST_SCORE_TRACK_MS,
      scoreAway: away,
      scoreHome: home,
      signals: { firstSource: source, t0: t, bySource: { [source]: 0 } },
      bookSignals: {
        moneylineFirstMoveMs: null,
        totalFirstMoveMs: null,
        spreadFirstMoveMs: null,
        kalshiTotalFirstMoveMs: null,
      },
      watched,
    };

    const staleBookEdges = snapshots
      .map((s) => ({
        venue: s.venue,
        lineFamily: s.lineFamily,
        marketType: s.marketType,
        fair: s.fair,
        preFair: s.preFair,
        frozenCost: s.cost,
        edge: s.postEdge,
        fairMove: s.fair - (s.preFair ?? s.fair),
        screenOk: s.screenOk,
        screenReason: s.screenReason,
        terminal: s.terminal,
      }))
      .sort((a, b) => b.edge - a.edge);

    this.opts.emit({
      kind: "mlb_paper_score_event",
      eventId: this.track.eventId,
      t0: t,
      source,
      prevAway,
      prevHome,
      scoreAway: away,
      scoreHome: home,
      rbiDelta,
      phoneAuthoritative: phoneLead,
      booksFrozenAtTap: phoneLead,
      /** Precomputed hunt list for this RBI size (from runners-on cache). */
      huntForDelta: hunt.slice(0, 12),
      paCalibration,
      confirmPath: "strat2_on_realized_rbi",
      feed: {
        period: feed.period,
        outs: feed.outs,
        runnersOn: feed.runnersOn,
        battingSide: feed.battingSide,
        status: feed.status,
        live: feed.live,
      },
      topEdgeGains: snapshots.slice(0, 8).map(summarizeSnap),
      topStaleBookEdges: staleBookEdges.slice(0, 16),
      wouldFire: watched.filter((w) => w.screenOk).map(summarizeWatch),
      allPositiveGain: snapshots.filter((s) => (phoneLead ? s.postEdge > 0 : s.edgeGain > 0)).map(summarizeSnap),
    });

    if (phoneLead) {
      this.opts.emit({
        kind: "mlb_paper_phone_stale_edges",
        t0: t,
        prevAway,
        prevHome,
        scoreAway: away,
        scoreHome: home,
        rbiDelta,
        note: "fair at phone score vs book TOB frozen at tap",
        shapes: staleBookEdges,
      });
    }

    const top = snapshots[0];
    const topLabel = top
      ? phoneLead
        ? `${top.venue} ${top.lineFamily} edge=${(top.postEdge * 100).toFixed(1)}c fair=${top.fair.toFixed(3)} cost=$${top.cost.toFixed(2)}`
        : `${top.lineFamily} gain=${(top.edgeGain * 100).toFixed(1)}c`
      : "n/a";
    (this.opts.log ?? (() => {}))(
      `mlb-paper: SCORE ${prevAway}-${prevHome}→${away}-${home} via ${source} `
      + `rbi=+${rbiDelta ?? "?"} `
      + (phoneLead ? `PHONE_AUTH staleBooks ` : `hunt=${hunt.slice(0, 3).map((h) => h.lineFamily).join(",") || "n/a"} `)
      + `top=${topLabel} `
      + `wouldFire=${watched.filter((w) => w.screenOk).length}`
      + (typeof paCalibration?.pWeightRealized === "number"
        ? ` pWeight=${(paCalibration.pWeightRealized * 100).toFixed(0)}%`
        : ""),
    );

    if (this.trackTimer) clearTimeout(this.trackTimer);
    this.trackTimer = setTimeout(() => this.finishTrack("timeout"), POST_SCORE_TRACK_MS + 50);
  }

  /** Shadow-log: how well PA priors weighted the realized RBI vs Strat2 confirm hunt. */
  private paPriorCalibrationShadow(input: {
    preAbFeed: FeedSnapshot | null;
    preDeltas: number[];
    preBranchEvals: MlbMiddleArbEventCache["branchEvalsByPackage"];
    preCosts: Map<string, number>;
    realizedRbiDelta: number | null;
  }): Record<string, unknown> | null {
    const { preAbFeed, preDeltas, preBranchEvals, preCosts, realizedRbiDelta } = input;
    if (!preAbFeed || realizedRbiDelta == null || !preDeltas.length) return null;

    const bases = basesKeyFromFlags(preAbFeed.onFirst, preAbFeed.onSecond, preAbFeed.onThird);
    const priorLookup = this.paPriors
      ? lookupPaRbiP(this.paPriors, {
          outs: preAbFeed.outs,
          onFirst: preAbFeed.onFirst,
          onSecond: preAbFeed.onSecond,
          onThird: preAbFeed.onThird,
          runnersOn: preAbFeed.runnersOn,
        })
      : null;
    const weights = priorLookup
      ? scoringDeltaWeights(priorLookup.p, preDeltas as MlbRbiDelta[])
      : Object.fromEntries(preDeltas.map((d) => [d, 1 / Math.max(preDeltas.length, 1)]));

    let bestPaPkg: {
      packageId: string;
      lineFamily: string;
      expectedEdgePa: number;
      bestStrat2: ReturnType<typeof bestStrat2BranchEdge>;
      realizedEdge: number | null;
    } | null = null;

    for (const pkg of this.cache?.packages ?? []) {
      const cost = preCosts.get(pkg.packageId) ?? null;
      const evals = preBranchEvals[pkg.packageId] ?? [];
      const branchInputs = evals
        .filter((e) => !e.terminal)
        .map((e) => ({ rbiDelta: e.rbiDelta, fair: e.fair, cost }));
      const expectedEdgePa = expectedEdgeUnderPaPriors(weights, branchInputs);
      const bestStrat2 = bestStrat2BranchEdge(branchInputs);
      const realized = evals.find((e) => e.rbiDelta === realizedRbiDelta && !e.terminal);
      const realizedEdge = realized && cost != null ? realized.fair - cost : null;
      if (expectedEdgePa == null) continue;
      if (!bestPaPkg || expectedEdgePa > bestPaPkg.expectedEdgePa) {
        bestPaPkg = {
          packageId: pkg.packageId,
          lineFamily: pkg.lineFamily,
          expectedEdgePa,
          bestStrat2,
          realizedEdge,
        };
      }
    }

    return {
      outs: preAbFeed.outs ?? null,
      bases,
      runnersOn: preAbFeed.runnersOn ?? null,
      priorSource: priorLookup?.source ?? "equal_fallback",
      cellN: priorLookup?.cellN ?? 0,
      pRbi: priorLookup?.p ?? null,
      scoringWeights: weights,
      realizedRbiDelta,
      pWeightRealized: weights[realizedRbiDelta] ?? 0,
      pRbiRealized: priorLookup?.p
        ? (priorLookup.p as Record<number, number>)[realizedRbiDelta] ?? 0
        : null,
      topPaPackage: bestPaPkg,
    };
  }

  private snapshotPackages(
    prevAway: number,
    prevHome: number,
    postFeed: FeedSnapshot,
    opts: { useFrozenTob?: boolean } = {},
  ): PackageSnapshot[] {
    if (!this.cache) return [];
    const preFeed: FeedSnapshot = {
      ...postFeed,
      scoreAway: prevAway,
      scoreHome: prevHome,
    };
    const out: PackageSnapshot[] = [];
    for (const pkg of this.cache.packages) {
      const post = pkg.state;
      if (!post) continue;

      const pre =
        pkg.marketType === "game_total"
          ? computeMlbBandState(preFeed, pkg.bandLo, pkg.bandHi)
          : pkg.spreadSide
            ? computeMlbSpreadBandState(preFeed, pkg.bandLo, pkg.bandHi, pkg.spreadSide)
            : null;
      const venues: Venue[] = ["pm", "kalshi"];
      for (const venue of venues) {
        const tob = this.tobForPackage(pkg, venue, opts.useFrozenTob === true);
        if (!tob) continue;
        const cost = tob.broadYesAsk + tob.narrowNoAsk;
        const legs = screenMlbMiddleArbLegs(tob);
        const preEdge = pre ? pre.fair - cost : Number.NaN;
        const postEdge = post.fair - cost;
        const edgeGain = postEdge - (Number.isFinite(preEdge) ? preEdge : 0);

        let screenReason: MlbMiddleArbFilterReason = "ok";
        let screenOk = true;
        if (!legs.ok) {
          screenOk = false;
          screenReason = legs.reason;
        } else if (pkg.terminal) {
          screenOk = false;
          screenReason = "terminal_state";
        } else {
          const edgeScreen = screenMlbMiddleArbEdge(post.fair, cost);
          screenOk = edgeScreen.ok;
          screenReason = edgeScreen.reason;
        }

        out.push({
          packageId: pkg.packageId,
          venue,
          lineFamily: pkg.lineFamily,
          marketType: pkg.marketType,
          shapeKey: pkg.shapeKey,
          cost,
          size: Math.min(tob.broadYesAskSize ?? 0, tob.narrowNoAskSize ?? 0),
          preP: pre?.pMiddle ?? null,
          preFair: pre?.fair ?? null,
          preEdge,
          pMiddle: post.pMiddle,
          fair: post.fair,
          postEdge,
          edgeGain,
          inningsLeft: post.inningsLeft,
          terminal: pkg.terminal,
          screenOk,
          screenReason,
          maxLiveCost: pkg.costBands.maxLiveCost,
        });
      }
    }
    return out;
  }

  private samplePaths(t: number): void {
    if (!this.track || !this.cache) return;
    if (t > this.track.endsAt) {
      this.finishTrack("timeout");
      return;
    }
    const byId = new Map(this.cache.packages.map((p) => [p.packageId, p]));
    for (const w of this.track.watched) {
      const pkg = byId.get(w.packageId);
      if (!pkg?.state) continue;
      const tob = this.tobForPackage(pkg, w.venue);
      if (!tob) continue;
      const cost = tob.broadYesAsk + tob.narrowNoAsk;
      const edge = pkg.state.fair - cost;
      const dt = t - this.track.t0;
      if (Math.abs(cost - w.lastCost) >= PATH_COST_STEP || w.path.length === 1) {
        if (Math.abs(cost - w.lastCost) >= PATH_COST_STEP) {
          w.path.push({
            dtMs: dt,
            cost,
            edge,
            fair: pkg.state.fair,
            pMiddle: pkg.state.pMiddle,
          });
          w.lastCost = cost;
        }
      }
      if (w.timeCostPlus3cMs == null && cost >= w.cost0 + 0.03) w.timeCostPlus3cMs = dt;
      if (edge >= EDGE_MARGIN) w.timeEdgeGeMarginMs = dt;
    }
  }

  private finishTrack(why: string): void {
    if (!this.track) {
      if (why === "reset" || why === "end") {
        this.phoneScoreLock = null;
        this.frozenTob = null;
      }
      return;
    }
    const track = this.track;
    this.track = null;
    this.phoneScoreLock = null;
    this.frozenTob = null;
    if (this.trackTimer) {
      clearTimeout(this.trackTimer);
      this.trackTimer = null;
    }
    this.opts.emit({
      kind: "mlb_paper_score_window",
      eventId: track.eventId,
      why,
      t0: track.t0,
      trackMs: POST_SCORE_TRACK_MS,
      scoreAway: track.scoreAway,
      scoreHome: track.scoreHome,
      scoreSignals: track.signals,
      bookSignals: track.bookSignals,
      watched: track.watched.map((w) => ({
        packageId: w.packageId,
        venue: w.venue,
        lineFamily: w.lineFamily,
        marketType: w.marketType,
        preEdge: w.preEdge,
        postEdge: w.postEdge,
        edgeGain: w.edgeGain,
        cost0: w.cost0,
        fair0: w.fair0,
        p0: w.p0,
        screenOk: w.screenOk,
        screenReason: w.screenReason,
        timeEdgeGeMarginMs: w.timeEdgeGeMarginMs,
        timeCostPlus3cMs: w.timeCostPlus3cMs,
        path: w.path,
        finalEdge: w.path[w.path.length - 1]?.edge ?? w.postEdge,
        finalCost: w.path[w.path.length - 1]?.cost ?? w.cost0,
      })),
    });
  }

  private tobForPackage(
    pkg: MlbMiddleArbCachedPackage,
    venue: Venue = "pm",
    useFrozen = false,
  ): {
    broadYesAsk: number;
    narrowNoAsk: number;
    broadYesAskSize?: number;
    narrowNoAskSize?: number;
  } | null {
    const live = venue === "kalshi" ? this.kalshiTob : this.tob;
    const frozen = useFrozen && this.frozenTob
      ? (venue === "kalshi" ? this.frozenTob.kalshi : this.frozenTob.pm)
      : null;
    const tobMap = frozen ?? live;
    if (pkg.marketType === "game_total") {
      const broad = tobMap.get(`total_${formatStrikeKey(pkg.broadStrike)}:yes`);
      const narrow = tobMap.get(`total_${formatStrikeKey(pkg.narrowStrike)}:no`);
      if (!broad || !narrow) return null;
      return {
        broadYesAsk: broad.ask,
        narrowNoAsk: narrow.ask,
        broadYesAskSize: broad.askSize,
        narrowNoAskSize: narrow.askSize,
      };
    }
    const team = pkg.spreadTeamKey;
    if (!team) return null;
    const broadLine = -Math.abs(pkg.broadStrike);
    const narrowLine = -Math.abs(pkg.narrowStrike);
    const broad = tobMap.get(`spread_${team}_${formatStrikeKey(broadLine)}:yes`)
      ?? tobMap.get(`spread_${team}_${formatStrikeKey(pkg.broadStrike)}:yes`);
    const narrow = tobMap.get(`spread_${team}_${formatStrikeKey(narrowLine)}:no`)
      ?? tobMap.get(`spread_${team}_${formatStrikeKey(pkg.narrowStrike)}:no`);
    if (!broad || !narrow) return null;
    return {
      broadYesAsk: broad.ask,
      narrowNoAsk: narrow.ask,
      broadYesAskSize: broad.askSize,
      narrowNoAskSize: narrow.askSize,
    };
  }
}

/** Paper middles on for soccer + mlb unless PLR_PAPER_MIDDLES=0. */
export function mlbPaperMiddlesEnabled(mode: string): boolean {
  const raw = process.env.PLR_PAPER_MIDDLES;
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return mode === "mlb";
}
