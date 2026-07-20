/**
 * Paper sidecar for soccer middle-arb shock lane.
 *
 * Consumes the same ladder / score ticks as ladder-lag-race, maintains the
 * middle-arb cache, and logs would_fire / screen_reject decisions — no orders.
 */

import {
  findStructuralCandidates,
  type ArbCoreConfig,
  type Candidate,
} from "./monotonic-arb-core.js";
import {
  buildSoccerMiddleArbEventCache,
  evaluateSoccerMiddleArbCachedPackage,
  refreshSoccerMiddleArbCacheState,
  serializeSoccerMiddleArbEventCache,
  soccerMinsLeftFromTimerSeconds,
  type SoccerMiddleArbEventCache,
  type SoccerMiddleArbLiveTob,
  type SoccerT1Branch,
} from "./soccer-middle-arb-cache.js";
import {
  SHOCK_MIN_ML_JUMP,
  type SoccerMiddleArbFilterReason,
} from "./soccer-middle-arb-filters.js";
import { teamKeyFromName } from "./strat2-mlb-live-gate.js";

export const SOCCER_MIDDLE_ARB_PAPER_VERSION = "2026-07-15.1";

const CLUSTER_GAP_MS = 500;
const TOTAL_MOVE_WINDOW_MS = 400;
const ML_SHOCK_SEED_JUMP = 0.05; // cluster seed; full screen still requires ≥8¢

export type PaperEmit = (row: Record<string, unknown>) => void;
export type PaperLog = (msg: string) => void;

export type SoccerMiddleArbPaperOptions = {
  eventSlug: string;
  moreSlug: string;
  eventTitle: string;
  emit: PaperEmit;
  log?: PaperLog;
  /** Enforce shape maxLiveCost in addition to scan band. Default false for paper (match ENG–ARG scan). */
  enforceShapeCostCap?: boolean;
};

type TobSide = { ask: number; askSize: number; t: number };
type MlSample = { ask: number; t: number };

function arbConfig(): ArbCoreConfig {
  return {
    host: process.env.CLOB_HOST ?? "https://clob.polymarket.com",
    gammaApi: process.env.GAMMA_API ?? "https://gamma-api.polymarket.com",
    fetchTimeoutMs: 12_000,
    marketConcurrency: 8,
    eventConcurrency: 2,
    allowedAssets: new Set(["SOCCER"]),
    minEdge: -1,
    maxSpread: 1,
    minLiquidity: 0,
    minAvailableShares: 0,
  };
}

function formatStrikeKey(n: number): string {
  // Match ladder-lag market keys (2.5 not 2.50).
  return String(n);
}

export class SoccerMiddleArbPaperSidecar {
  readonly opts: SoccerMiddleArbPaperOptions;
  private cache: SoccerMiddleArbEventCache | null = null;
  private readonly tob = new Map<string, TobSide>(); // `${market}:${side}`
  private readonly mlAsk = new Map<string, MlSample>(); // ml_* market
  private readonly totalAsk = new Map<string, TobSide>(); // total_* yes asks
  private readonly recentTotalMoves: Array<{ t: number; abs: number }> = [];
  private scoreHome = 0;
  private scoreAway = 0;
  private minsLeft = 45;
  private afterFt = false;
  private openCluster: {
    t0: number;
    t1: number;
    maxMlJumpAbs: number;
    cheapened: Set<string>;
  } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private wouldFire = 0;
  private rejects = 0;
  private shocks = 0;

  constructor(opts: SoccerMiddleArbPaperOptions) {
    this.opts = opts;
  }

  get stats() {
    return {
      wouldFire: this.wouldFire,
      rejects: this.rejects,
      shocks: this.shocks,
      packages: this.cache?.packages.length ?? 0,
    };
  }

  /** Test helper: skip Gamma and inject a prebuilt cache. */
  hydrateForTests(cache: SoccerMiddleArbEventCache, score = { away: 0, home: 0, minsLeft: 36 }): void {
    this.cache = cache;
    this.scoreAway = score.away;
    this.scoreHome = score.home;
    this.minsLeft = score.minsLeft;
  }

  async init(): Promise<void> {
    const log = this.opts.log ?? (() => {});
    const slugs = [this.opts.eventSlug, this.opts.moreSlug].filter(Boolean);
    const foundAt = new Date().toISOString();
    const { candidates, errors } = await findStructuralCandidates(arbConfig(), slugs, foundAt);
    if (errors.length) log(`paper-middles: structural errors: ${errors.join("; ")}`);

    const normalized: Candidate[] = candidates.map((c) => ({
      ...c,
      eventSlug: this.opts.eventSlug,
      eventTitle: this.opts.eventTitle,
      asset: "SOCCER",
    }));

    const { awayTeamKey, homeTeamKey } = parseTitleTeams(this.opts.eventTitle);
    this.cache = buildSoccerMiddleArbEventCache({
      eventSlug: this.opts.eventSlug,
      eventTitle: this.opts.eventTitle,
      candidates: normalized,
      scoreHome: this.scoreHome,
      scoreAway: this.scoreAway,
      minsLeft: this.minsLeft,
      mlTokens: {
        awayYesTokenId: awayTeamKey ? `ml_${awayTeamKey}` : undefined,
        homeYesTokenId: homeTeamKey ? `ml_${homeTeamKey}` : undefined,
        byTeamKey: {},
      },
    });

    this.opts.emit({
      kind: "paper_middle_init",
      version: SOCCER_MIDDLE_ARB_PAPER_VERSION,
      eventSlug: this.opts.eventSlug,
      title: this.opts.eventTitle,
      packages: this.cache.packages.length,
      shapes: [...new Set(this.cache.packages.map((p) => p.shapeKey))],
      cache: serializeSoccerMiddleArbEventCache(this.cache),
    });
    log(
      `paper-middles: cache ready packages=${this.cache.packages.length} `
      + `totals=${this.cache.packages.filter((p) => p.marketType === "match_total").length} `
      + `spreads=${this.cache.packages.filter((p) => p.marketType === "spread").length}`,
    );
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
    // Clear the TOB entry so package costs go missing instead of stale/zero.
    if (row.bestAsk == null || !(row.bestAsk > 0) || !((row.bestAskSize ?? 0) > 0)) {
      this.tob.delete(key);
      return;
    }
    const ask = Number(row.bestAsk);
    const askSize = Number(row.bestAskSize);
    this.tob.set(key, { ask, askSize, t });

    if (row.klass === "total" || row.market.startsWith("total_")) {
      if (row.side === "yes") {
        const prev = this.totalAsk.get(row.market);
        if (prev) {
          const abs = Math.abs(ask - prev.ask);
          if (abs >= 0.01) this.recentTotalMoves.push({ t, abs });
        }
        this.totalAsk.set(row.market, { ask, askSize, t });
        this.pruneTotalMoves(t);
      }
    }

    if (row.klass === "moneyline" || row.market.startsWith("ml_")) {
      if (row.side !== "yes") return;
      const prev = this.mlAsk.get(row.market);
      this.mlAsk.set(row.market, { ask, t });
      if (!prev) return;
      const jump = ask - prev.ask;
      if (Math.abs(jump) < ML_SHOCK_SEED_JUMP) return;
      const teamKey = row.market.replace(/^ml_/, "");
      this.noteMlJump(t, Math.abs(jump), jump < 0 ? teamKey : null);
    }
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
    const score = String(sb?.score ?? "");
    const parts = score.replace("-", ":").split(":");
    if (parts.length >= 2) {
      const home = Number(parts[0]);
      const away = Number(parts[1]);
      // bwin often lists home first; PM title is Away vs Home — we use title keys
      // and treat bwin order as display only. Prefer matching via timer + totals.
      // For state we store as scoreHome/scoreAway from title convention after remap.
      if (Number.isFinite(home) && Number.isFinite(away)) {
        // Polymarket soccer titles are "Away vs. Home"; bwin scoreboard is usually
        // home:away for the fixture. Without a reliable map, keep numeric total
        // consistent: refresh mins always; only update scores when both change
        // coherently via applyScore(away, home) if we detect PM ordering...
        // Practical approach: store as (first, second) from bwin and also total.
        this.applyScore(home, away, sb?.timer?.seconds, t, "bwin");
      }
    }
    const seconds = sb?.timer?.seconds;
    if (seconds != null) {
      this.minsLeft = soccerMinsLeftFromTimerSeconds(Number(seconds));
      this.refreshState();
    }
    const period = String(sb?.period ?? sb?.gamePart ?? "");
    if (/FT|full.?time|ended|finished/i.test(period)) this.afterFt = true;
  }

  onPmScore(score: string, period?: string, t = Date.now()): void {
    const parts = String(score).replace("-", ":").split(":");
    if (parts.length >= 2) {
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) this.applyScore(a, b, null, t, "pm");
    }
    if (period && /FT|final|end/i.test(period)) this.afterFt = true;
  }

  end(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushCluster();
    this.opts.emit({
      kind: "paper_middle_end",
      version: SOCCER_MIDDLE_ARB_PAPER_VERSION,
      ...this.stats,
    });
  }

  private applyScore(
    a: number,
    b: number,
    timerSeconds: number | null,
    t: number,
    source: string,
  ): void {
    // Align to title Away vs Home when possible: if cache has team keys, prefer
    // leaving (scoreAway, scoreHome) = (a,b) when source is PM (usually matches
    // listing order). bwin is often home:away — swap if totals match prior±1.
    let scoreAway = a;
    let scoreHome = b;
    if (source === "bwin" && this.cache?.awayTeamKey && this.cache?.homeTeamKey) {
      // Heuristic: keep previous total continuity; if a+b == prev+1, choose
      // orientation that matches a one-goal increment on one side.
      const prevA = this.scoreAway;
      const prevH = this.scoreHome;
      const prevT = prevA + prevH;
      if (a + b === prevT + 1) {
        const asListed = { away: a, home: b }; // treat as away:home
        const swapped = { away: b, home: a }; // treat as home:away from bwin
        const dListed = Math.abs(asListed.away - prevA) + Math.abs(asListed.home - prevH);
        const dSwap = Math.abs(swapped.away - prevA) + Math.abs(swapped.home - prevH);
        if (dSwap < dListed) {
          scoreAway = swapped.away;
          scoreHome = swapped.home;
        } else {
          scoreAway = asListed.away;
          scoreHome = asListed.home;
        }
      } else {
        // default: assume bwin home:away → swap into title Away vs Home
        scoreAway = b;
        scoreHome = a;
      }
    }

    const changed = scoreAway !== this.scoreAway || scoreHome !== this.scoreHome;
    this.scoreAway = scoreAway;
    this.scoreHome = scoreHome;
    if (timerSeconds != null) this.minsLeft = soccerMinsLeftFromTimerSeconds(timerSeconds);
    if (changed) {
      this.refreshState();
      this.opts.emit({
        kind: "paper_middle_score",
        source,
        scoreAway: this.scoreAway,
        scoreHome: this.scoreHome,
        minsLeft: this.minsLeft,
        t,
      });
    }
  }

  private refreshState(): void {
    if (!this.cache) return;
    this.cache = refreshSoccerMiddleArbCacheState(
      this.cache,
      this.scoreHome,
      this.scoreAway,
      this.minsLeft,
    );
  }

  private pruneTotalMoves(t: number): void {
    while (this.recentTotalMoves.length && t - this.recentTotalMoves[0]!.t > TOTAL_MOVE_WINDOW_MS) {
      this.recentTotalMoves.shift();
    }
  }

  private noteMlJump(t: number, absJump: number, cheapenedTeamKey: string | null): void {
    if (!this.openCluster || t - this.openCluster.t1 > CLUSTER_GAP_MS) {
      this.flushCluster();
      this.openCluster = {
        t0: t,
        t1: t,
        maxMlJumpAbs: absJump,
        cheapened: new Set(cheapenedTeamKey ? [cheapenedTeamKey] : []),
      };
    } else {
      this.openCluster.t1 = t;
      this.openCluster.maxMlJumpAbs = Math.max(this.openCluster.maxMlJumpAbs, absJump);
      if (cheapenedTeamKey) this.openCluster.cheapened.add(cheapenedTeamKey);
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushCluster(), CLUSTER_GAP_MS + 20);
  }

  private maxTotalMoveNear(t: number): number {
    this.pruneTotalMoves(t);
    let max = 0;
    for (const m of this.recentTotalMoves) {
      if (Math.abs(m.t - t) <= TOTAL_MOVE_WINDOW_MS) max = Math.max(max, m.abs);
    }
    return max;
  }

  private flushCluster(): void {
    if (!this.openCluster || !this.cache) {
      this.openCluster = null;
      return;
    }
    const cluster = this.openCluster;
    this.openCluster = null;
    this.shocks += 1;

    const maxTotalMoveAbs = this.maxTotalMoveNear(cluster.t1);
    const shock = {
      maxMlJumpAbs: cluster.maxMlJumpAbs,
      maxTotalMoveAbs,
      afterFt: this.afterFt,
    };

    const cheapened = [...cluster.cheapened];
    const branch: SoccerT1Branch = cheapened.length
      ? { kind: "team_plus_1", teamKey: cheapened[0]! }
      : { kind: "total_plus_1" };

    const tobByPackageId = new Map<string, SoccerMiddleArbLiveTob>();
    const missing: string[] = [];
    for (const pkg of this.cache.packages) {
      const tob = this.tobForPackage(pkg);
      if (!tob) {
        missing.push(pkg.packageId);
        continue;
      }
      tobByPackageId.set(pkg.packageId, tob);
    }

    // Evaluate every package for logging (pass + reject), not only keepers.
    const evaluations = [];
    for (const pkg of this.cache.packages) {
      const tob = tobByPackageId.get(pkg.packageId);
      if (!tob) continue;
      let pkgBranch = branch;
      if (pkg.marketType === "match_total") pkgBranch = { kind: "total_plus_1" };
      else if (branch.kind === "total_plus_1") {
        // No scorer — still eval under max of home/away for diagnostics
        pkgBranch = this.cache.awayTeamKey
          ? { kind: "team_plus_1", teamKey: this.cache.awayTeamKey }
          : branch;
      }
      const hit = evaluateSoccerMiddleArbCachedPackage({
        cache: this.cache,
        pkg,
        tob,
        shock,
        branch: pkgBranch,
        enforceShapeCostCap: this.opts.enforceShapeCostCap ?? false,
      });
      if (!hit) continue;
      evaluations.push(hit);
      if (hit.screen.ok) this.wouldFire += 1;
      else this.rejects += 1;
    }

    const keepers = evaluations.filter((e) => e.screen.ok);

    this.opts.emit({
      kind: "paper_middle_shock",
      t0: cluster.t0,
      t1: cluster.t1,
      maxMlJumpAbs: cluster.maxMlJumpAbs,
      maxTotalMoveAbs,
      cheapenedTeamKeys: cheapened,
      branch,
      scoreAway: this.scoreAway,
      scoreHome: this.scoreHome,
      minsLeft: this.minsLeft,
      afterFt: this.afterFt,
      packagesPriced: tobByPackageId.size,
      packagesMissingTob: missing.length,
      wouldFire: keepers.length,
      rejects: evaluations.length - keepers.length,
      hits: keepers.map((h) => summarizeHit(h)),
      rejectsDetail: evaluations
        .filter((e) => !e.screen.ok)
        .slice(0, 40)
        .map((h) => summarizeHit(h)),
    });

    if (keepers.length) {
      (this.opts.log ?? (() => {}))(
        `paper-middles: WOULD_FIRE n=${keepers.length} `
        + keepers.map((h) => `${h.pkg.lineFamily}@${h.cost.toFixed(3)} edge=${(h.edgeAtTPlus1 * 100).toFixed(1)}¢`).join(", "),
      );
    } else if (cluster.maxMlJumpAbs >= SHOCK_MIN_ML_JUMP) {
      const topReason = modeReason(evaluations.map((e) => e.screen.reason));
      (this.opts.log ?? (() => {}))(
        `paper-middles: shock mag=${cluster.maxMlJumpAbs.toFixed(2)} totΔ=${maxTotalMoveAbs.toFixed(2)} `
        + `no fire (topReject=${topReason} priced=${tobByPackageId.size})`,
      );
    }
  }

  private tobForPackage(pkg: SoccerMiddleArbEventCache["packages"][number]): SoccerMiddleArbLiveTob | null {
    if (pkg.marketType === "match_total") {
      const broad = this.tob.get(`total_${formatStrikeKey(pkg.broadStrike)}:yes`);
      const narrow = this.tob.get(`total_${formatStrikeKey(pkg.narrowStrike)}:no`);
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
    // Ladder keys use signed lines (e.g. spread_england_-1.5).
    const broadLine = -Math.abs(pkg.broadStrike);
    const narrowLine = -Math.abs(pkg.narrowStrike);
    const broad = this.tob.get(`spread_${team}_${formatStrikeKey(broadLine)}:yes`)
      ?? this.tob.get(`spread_${team}_${formatStrikeKey(pkg.broadStrike)}:yes`);
    const narrow = this.tob.get(`spread_${team}_${formatStrikeKey(narrowLine)}:no`)
      ?? this.tob.get(`spread_${team}_${formatStrikeKey(pkg.narrowStrike)}:no`);
    if (!broad || !narrow) return null;
    return {
      broadYesAsk: broad.ask,
      narrowNoAsk: narrow.ask,
      broadYesAskSize: broad.askSize,
      narrowNoAskSize: narrow.askSize,
    };
  }
}

function parseTitleTeams(title: string): { awayTeamKey: string | null; homeTeamKey: string | null } {
  const m = title.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s*:.*)?$/i);
  if (!m) return { awayTeamKey: null, homeTeamKey: null };
  return {
    awayTeamKey: teamKeyFromName(m[1]!.trim()),
    homeTeamKey: teamKeyFromName(m[2]!.trim()),
  };
}

function summarizeHit(h: {
  pkg: { packageId: string; marketType: string; lineFamily: string; shapeKey: string; spreadTeamKey: string | null };
  branch: SoccerT1Branch;
  cost: number;
  size: number;
  pCurrent: number;
  pTPlus1: number;
  edgeAtCurrent: number;
  edgeAtTPlus1: number;
  screen: { ok: boolean; reason: SoccerMiddleArbFilterReason };
}) {
  return {
    packageId: h.pkg.packageId,
    marketType: h.pkg.marketType,
    lineFamily: h.pkg.lineFamily,
    shapeKey: h.pkg.shapeKey,
    spreadTeamKey: h.pkg.spreadTeamKey,
    branch: h.branch,
    cost: h.cost,
    size: h.size,
    pCurrent: h.pCurrent,
    pTPlus1: h.pTPlus1,
    edgeAtCurrent: h.edgeAtCurrent,
    edgeAtTPlus1: h.edgeAtTPlus1,
    ok: h.screen.ok,
    reason: h.screen.reason,
  };
}

function modeReason(reasons: SoccerMiddleArbFilterReason[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  let best = "none";
  let n = 0;
  for (const [r, c] of counts) {
    if (c > n) {
      best = r;
      n = c;
    }
  }
  return best;
}

/** Env helper: paper middles on for soccer unless explicitly disabled. */
export function paperMiddlesEnabled(mode: string): boolean {
  const raw = process.env.PLR_PAPER_MIDDLES;
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return mode === "soccer";
}
