// Always-on, websocket-driven monotonic-arb daemon (Japan host).
//
// Design goals (see plan "Japan Always-On Websocket Arb Daemon"):
//   - React to order-book changes in real time on a fixed watchlist, evaluating
//     the arb gate many times per second purely in memory (no REST on the hot
//     path).
//   - Keep Polygon RPC off the hot path: balance/allowance checked at startup
//     and periodically via the multi-RPC failover provider; fills sized from the
//     User websocket (with an on-chain reconcile as the authority/fallback).
//   - Reuse the proven execution primitives from the hourly executor so order
//     signing, sizing, ledgering and reconciliation stay a single source of
//     truth.
//
// This is the SINGLE real-PM executor on Japan: the hourly
// polymarket-real-executor.timer must be disabled so packages are not double
// submitted.

import { webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { config } from "dotenv";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import { VpnGuard } from "./lib/VpnGuard.js";
import { adapterForCandidate } from "./lib/sports-registry.js";
import {
  pickCheapestSoccerPackagesByEvent,
  shouldDeferSoccerPackage,
  type ScoredWatchPackage,
} from "./lib/soccer-event-package-priority.js";
import { recordSoccerEventShapeCost, soccerBestSeenCostBlock } from "./lib/soccer-event-best-cost.js";
import { appendShadowPackage } from "./lib/shadow-ledger.js";
import { packageFromCandidate } from "./lib/package-factory.js";
import { evaluateSportsStrategy, soccerEffectiveMinNarrowYesBid, sportsEffectiveMaxEntryLegPrice } from "./lib/sports-strategy.js";
import {
  type Candidate,
  type Direction,
  type GammaEvent,
  type MarketQuote,
  EPSILON,
  evaluatePair,
  fetchBook,
  fetchEvent,
  fetchJson,
  findStructuralCandidates,
  isNestedLadderEvent,
  marketQuote,
  polymarketAssetForSlug,
} from "./lib/monotonic-arb-core.js";
import {
  arbConfig,
  appendJsonArray,
  assertOrderResponse,
  clobClient,
  eventSlugs,
  type LiveOrder,
  type LivePackage,
  ENABLED,
  HARD_DISABLED,
  FILL_WAIT_MS,
  MAX_DAILY_USD,
  MAX_OPEN_PACKAGES,
  MAX_PACKAGE_USD,
  MIN_AVAILABLE_SHARES,
  MIN_EDGE,
  MIN_ORDER_SHARES,
  MAX_SPREAD,
  ORDERS_PATH,
  PACKAGES_PATH,
  POLYMARKET_FUNDER_ADDRESS,
  SKIP_VPN,
  SOCKS_PROXY,
  orderId,
  packageRecord,
  postFakBuy,
  postLimitBuy,
  postLimitSell,
  postFakSell,
  proxyCollateralProbe,
  readJsonArray,
  reconcileTokenBalance,
  roundShares,
  sizeForCandidate,
  writeJsonArray,
} from "./polymarket-real-monotonic-executor.js";

// clob-client signs L2 requests via globalThis.crypto.subtle; Node 18 needs the
// polyfill before any CLOB call (same as the hourly executor).
if (!globalThis.crypto) (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });
config({ path: resolve(__dirname, "../../config.env") });
const require = createRequire(import.meta.url);

const HOST = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";
const MARKET_WS_URL = process.env.POLYMARKET_MARKET_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const USER_WS_URL = process.env.POLYMARKET_USER_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/user";

const DRY_RUN = process.argv.includes("--dry-run")
  || process.env.MONOTONIC_ARB_REAL_PM_DRY_RUN === "1"
  || !ENABLED
  || HARD_DISABLED;

// Daemon-specific tunables (safe defaults; all overridable via env).
const WATCHLIST_REFRESH_MS = Number(process.env.ARB_DAEMON_WATCHLIST_REFRESH_MS ?? 300_000);
const BALANCE_REFRESH_MS = Number(process.env.ARB_DAEMON_BALANCE_REFRESH_MS ?? 300_000);
const LEDGER_FLUSH_MS = Number(process.env.ARB_DAEMON_LEDGER_FLUSH_MS ?? 120_000);
const PING_MS = Number(process.env.ARB_DAEMON_PING_MS ?? 10_000);
const FILL_WAIT_DAEMON_MS = Number(process.env.ARB_DAEMON_FILL_WAIT_MS ?? FILL_WAIT_MS);
const MAX_PER_MIN = Number(process.env.ARB_DAEMON_MAX_PER_MIN ?? 6);
const RECONNECT_BASE_MS = Number(process.env.ARB_DAEMON_RECONNECT_BASE_MS ?? 1_000);
const RECONNECT_MAX_MS = Number(process.env.ARB_DAEMON_RECONNECT_MAX_MS ?? 30_000);
const BOOK_FETCH_TIMEOUT_MS = Number(process.env.ARB_DAEMON_BOOK_FETCH_TIMEOUT_MS ?? 8_000);
const GIT_PUSH = process.env.ARB_DAEMON_GIT_PUSH === "1";
const HTTP_KEEP_ALIVE = process.env.ARB_DAEMON_HTTP_KEEP_ALIVE !== "0";
const MONOTONIC_POST_MODE = (process.env.ARB_DAEMON_POST_MODE ?? "batch").toLowerCase();
const RESPONSE_FILL_FIRST = process.env.ARB_DAEMON_RESPONSE_FILL_FIRST !== "0";
const ENFORCE_SPORTS_STRATEGY_LIVE = process.env.ARB_DAEMON_ENFORCE_SPORTS_STRATEGY_LIVE !== "0";
// Sports markets can partially fill paired FAK orders asymmetrically even when
// posted in one CLOB batch. Keep sports in discovery/telemetry, but do not trade
// them live unless the operator explicitly accepts non-atomic execution risk.
const ALLOW_SPORTS_LIVE_EXECUTION = process.env.ARB_DAEMON_ALLOW_SPORTS_LIVE_EXECUTION !== "0";
const ENABLE_NBA_BATCH_EXECUTION = process.env.ARB_DAEMON_ENABLE_NBA_BATCH_EXECUTION !== "0";
const ALLOW_NBA_NON_ATOMIC_EXECUTION = process.env.ARB_DAEMON_ALLOW_NBA_NON_ATOMIC_EXECUTION === "1";
const SPORTS_EXIT_BALANCE_WAIT_MS = Number(process.env.ARB_DAEMON_SPORTS_EXIT_BALANCE_WAIT_MS ?? 15_000);
const NBA_LEDGER_ARCHIVE_GRACE_MS = Number(process.env.ARB_DAEMON_NBA_LEDGER_ARCHIVE_GRACE_MS ?? 30 * 60_000);
const DISCOVER_NBA_GAMES = process.env.ARB_DAEMON_DISCOVER_NBA_GAMES !== "0";
const DISCOVER_MLB_GAMES = process.env.ARB_DAEMON_DISCOVER_MLB_GAMES !== "0";
const DISCOVER_SOCCER_GAMES = process.env.ARB_DAEMON_DISCOVER_SOCCER_GAMES !== "0";
const DISCOVER_TENNIS_GAMES = process.env.ARB_DAEMON_DISCOVER_TENNIS_GAMES === "1";
const DISCOVER_LADDERS = process.env.ARB_DAEMON_DISCOVER_LADDERS !== "0";
const LADDER_DISCOVERY_TAGS = (process.env.ARB_DAEMON_LADDER_DISCOVERY_TAGS ?? "crypto,crypto-prices,stocks,commodities,indices,finance")
  .split(",").map((tag) => tag.trim()).filter(Boolean);
const TENNIS_EVENT_SLUGS = (process.env.ARB_DAEMON_TENNIS_EVENT_SLUGS ?? "")
  .split(",").map((slug) => slug.trim()).filter(Boolean);
const SPORTS_DISCOVERY_LIMIT = Number(process.env.ARB_DAEMON_SPORTS_DISCOVERY_LIMIT ?? process.env.ARB_DAEMON_MLB_DISCOVERY_LIMIT ?? 500);
const SOCCER_DISCOVERY_LIMIT = Number(process.env.ARB_DAEMON_SOCCER_DISCOVERY_LIMIT ?? 600);
const SPORTS_AUTO_DISCOVERY_DAYS = Number(process.env.ARB_DAEMON_SPORTS_AUTO_DISCOVERY_DAYS ?? 2);
const KEEP_FAR_FUTURE_CONFIGURED_SPORTS = process.env.ARB_DAEMON_KEEP_FAR_FUTURE_CONFIGURED_SPORTS === "1";
const DAEMON_MARKET_CONCURRENCY = Math.max(1, Number(process.env.ARB_DAEMON_MARKET_CONCURRENCY ?? 1));
const DAEMON_EVENT_CONCURRENCY = Math.max(1, Number(process.env.ARB_DAEMON_EVENT_CONCURRENCY ?? 2));
const CLOB_REST_429_COOLDOWN_MS = Number(process.env.ARB_DAEMON_CLOB_REST_429_COOLDOWN_MS ?? 60_000);
const BOOK_SEED_MIN_INTERVAL_MS = Number(process.env.ARB_DAEMON_BOOK_SEED_MIN_INTERVAL_MS ?? 15 * 60_000);
const BOOK_SEED_MAX_PER_RECONNECT = Math.max(0, Number(process.env.ARB_DAEMON_BOOK_SEED_MAX_PER_RECONNECT ?? 80));
const BALANCE_REFRESH_RETRIES = Math.max(1, Number(process.env.ARB_DAEMON_BALANCE_REFRESH_RETRIES ?? 2));
const BALANCE_REFRESH_RETRY_DELAY_MS = Number(process.env.ARB_DAEMON_BALANCE_REFRESH_RETRY_DELAY_MS ?? 1_000);
const BALANCE_REFRESH_FAILURE_LOG_MS = Number(process.env.ARB_DAEMON_BALANCE_REFRESH_FAILURE_LOG_MS ?? 15 * 60_000);
const LEDGER_ARCHIVE_DIR = join(dirname(PACKAGES_PATH), "archive");

arbConfig.marketConcurrency = DAEMON_MARKET_CONCURRENCY;
arbConfig.eventConcurrency = DAEMON_EVENT_CONCURRENCY;

// Near-miss telemetry: proves whether the daemon is barely missing executable
// arbs or the ladder is simply not offering them. This is telemetry only; entry
// still flows exclusively through the normal execution gate below.
const NEAR_MISS_LOG_MS = Number(process.env.ARB_DAEMON_NEAR_MISS_LOG_MS ?? 60_000);
const NEAR_MISS_TOP_N = Number(process.env.ARB_DAEMON_NEAR_MISS_TOP_N ?? 5);
// Capture both true sub-$1 arbs ("home run" candidates if they also hit the
// middle) and above-floor lottery candidates for later resolution analysis.
const CANDIDATE_SNAPSHOT_MIN_COST = Number(process.env.ARB_DAEMON_CANDIDATE_SNAPSHOT_MIN_COST ?? 0.95);
const CANDIDATE_SNAPSHOT_MAX_COST = Number(process.env.ARB_DAEMON_CANDIDATE_SNAPSHOT_MAX_COST ?? 1.03);
// Capture conversion audit includes the real execution path AND shadow rows for
// non-executable near buckets. Shadow rows let us study 1.000-1.005 / 1.005-1.02
// conversion blockers without loosening live trading gates or risking capital.
const CAPTURE_AUDIT_MIN_COST = Number(process.env.ARB_DAEMON_CAPTURE_AUDIT_MIN_COST ?? CANDIDATE_SNAPSHOT_MIN_COST);
// Must cover the live sports cost ceiling (Tier 3 soccer reaches ~1.35) so submitted_result
// rows land in monotonic-capture-audit.jsonl for shadow-vs-live middle-rate comparisons.
const CAPTURE_AUDIT_MAX_COST = Number(process.env.ARB_DAEMON_CAPTURE_AUDIT_MAX_COST ?? 1.35);
const CAPTURE_AUDIT_MIN_INTERVAL_MS = Number(process.env.ARB_DAEMON_CAPTURE_AUDIT_MIN_INTERVAL_MS ?? 5_000);
const MIN_MARKETABLE_BUY_USD = Number(process.env.MONOTONIC_ARB_REAL_PM_MIN_MARKETABLE_BUY_USD ?? 1);
// Live sports books move faster than the macro/crypto ladders, so they still
// require a fresh book pull before execution. Do not impose a sports-only share
// floor: small-but-marketable clean arbs should execute, while larger books
// should size to the maximum safely paired depth.
const SPORTS_MIN_EDGE = Number(process.env.ARB_DAEMON_SPORTS_MIN_EDGE ?? 0);
const SPORTS_MIN_AVAILABLE_SHARES = Number(process.env.ARB_DAEMON_SPORTS_MIN_AVAILABLE_SHARES ?? 0);
const SPORTS_MAX_SPREAD = Number(process.env.ARB_DAEMON_SPORTS_MAX_SPREAD ?? 0.04);
const SPORTS_MAX_PAIRED_SHARES = Number(process.env.ARB_DAEMON_SPORTS_MAX_PAIRED_SHARES ?? 0);
const SPORTS_MAX_ENTRY_LEG_PRICE = Number(process.env.ARB_DAEMON_SPORTS_MAX_ENTRY_LEG_PRICE ?? 0.98);
// SOCCER_MIN_NARROW_YES_BID is now shape-aware; resolved per-candidate via
// soccerEffectiveMinNarrowYesBid() so the strategy gate and execution gate
// always agree on the floor.
const SOCCER_MAX_NARROW_YES_BID = Number(process.env.ARB_DAEMON_SOCCER_MAX_NARROW_YES_BID ?? 0.10);
const MLB_MIN_NARROW_YES_BID = Number(process.env.ARB_DAEMON_MLB_MIN_NARROW_YES_BID ?? 0.30);
const SPORTS_MAX_EVENT_USD = Number(process.env.ARB_DAEMON_SPORTS_MAX_EVENT_USD ?? 50);
const SPORTS_MAX_EVENT_PACKAGES = Math.max(1, Number(process.env.ARB_DAEMON_SPORTS_MAX_EVENT_PACKAGES ?? 3));
const SPORTS_BLOCK_EVENT_OVERLAP = process.env.ARB_DAEMON_SPORTS_BLOCK_EVENT_OVERLAP !== "0";
// When multiple live-eligible soccer packages exist on one event (e.g. 3.5/5.5
// and 3.5/6.5), only submit the cheapest; equal cost prefers the narrower middle.
const SOCCER_PREFER_CHEAPEST_EVENT_PACKAGE = process.env.ARB_DAEMON_SOCCER_PREFER_CHEAPEST_EVENT_PACKAGE !== "0";
// One clean fill per soccer event; no re-entry at worse prices until operator resets ledger.
const SOCCER_ONE_FILL_PER_EVENT = process.env.ARB_DAEMON_SOCCER_ONE_FILL_PER_EVENT !== "0";
const SPORTS_PRICE_SLIPPAGE = Number(process.env.ARB_DAEMON_SPORTS_PRICE_SLIPPAGE ?? 0);
// Hedge completion (knock out the ~290ms preflight reprice → naked-leg failure
// mode). The cheap leg fills first; if the hedge ask ticks up past the stale
// snapshot price between preflight and submit, the hedge FAK no-fills and leaves
// the cheap leg naked. But for a monotonic middle the guaranteed floor pays >=$1,
// so completing the pair at ANY price keeping pair cost <= $1 is risk-free and
// strictly beats unwinding a naked directional leg. So once the cheap leg is
// filled we price the hedge FAK at the locked-pair break-even ceiling
// (1 - cheapAvgFill), not the snapshot ask: a reprice within the still-profitable
// band now completes the arb, and only a reprice past break-even no-fills.
const SPORTS_HEDGE_BREAKEVEN_FILL = (process.env.ARB_DAEMON_SPORTS_HEDGE_BREAKEVEN_FILL ?? "1") !== "0";
// Edge (in price units) the completed pair must retain vs $1.00. 0 = complete at
// break-even (risk-free floor). Raise it to demand realized edge on completion at
// the cost of more cheap-leg orphans when the hedge reprices hard.
const SPORTS_HEDGE_COMPLETION_MIN_EDGE = Number(process.env.ARB_DAEMON_SPORTS_HEDGE_COMPLETION_MIN_EDGE ?? 0);
type CostRange = { label: string; min: number; max: number; includeMin: boolean; includeMax: boolean };

function parseCostRangeToken(token: string): CostRange | null {
  const raw = token.trim();
  if (!raw) return null;
  if (raw.startsWith("<=")) {
    const max = Number(raw.slice(2));
    return Number.isFinite(max) ? { label: raw, min: Number.NEGATIVE_INFINITY, max, includeMin: true, includeMax: true } : null;
  }
  if (raw.startsWith("<")) {
    const max = Number(raw.slice(1));
    return Number.isFinite(max) ? { label: raw, min: Number.NEGATIVE_INFINITY, max, includeMin: true, includeMax: false } : null;
  }
  const range = raw.match(/^([0-9.]+)\s*-\s*([0-9.]+)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { label: raw, min, max, includeMin: true, includeMax: true };
    }
  }
  return null;
}

const SPORTS_ALLOWED_COST_RANGES = (process.env.ARB_DAEMON_SPORTS_ALLOWED_COST_RANGES ?? "")
  .split(",")
  .map(parseCostRangeToken)
  .filter((range): range is CostRange => Boolean(range));
// Pre-warm the CLOB client's tick-size + fee-rate caches for both legs before the
// cheap-first sequence starts. Without this, the hedge leg's first order on a
// fresh sports market pays two cold metadata round-trips (getTickSize +
// getFeeRateBps) inside the cheap-fill -> hedge-submit gap — the exact window
// where a reprice orphans the cheap leg. The warm-up is read-only and runs once
// up front, shrinking the inter-leg gap to just the hedge order submit.
const SPORTS_PREWARM_ORDER_META = (process.env.ARB_DAEMON_SPORTS_PREWARM_ORDER_META ?? "1") !== "0";
// Balance headroom applies to every package: concurrent executions, just-matched
// orders the exchange still counts against the balance, and fee dust all shave
// real buying power below the cached on-chain number. The Jun 8 GOLD orphan was
// a second-leg "not enough balance" rejection caused by a concurrent ETH fill.
const BALANCE_HEADROOM_USD = Number(
  process.env.ARB_DAEMON_BALANCE_HEADROOM_USD
  ?? process.env.ARB_DAEMON_SPORTS_BALANCE_HEADROOM_USD
  ?? 0.5,
);
const BALANCE_HEADROOM_MULTIPLIER = Number(
  process.env.ARB_DAEMON_BALANCE_HEADROOM_MULTIPLIER
  ?? process.env.ARB_DAEMON_SPORTS_BALANCE_HEADROOM_MULTIPLIER
  ?? 1.03,
);
// Block sports entries close to the scheduled event/market start. Sports top of
// book becomes especially stale near kickoff; default to a 15-minute no-entry
// buffer unless explicitly overridden.
const SPORTS_ENTRY_CUTOFF_MS = Number(process.env.ARB_DAEMON_SPORTS_ENTRY_CUTOFF_MS ?? 15 * 60_000);
// Non-sports keep reserve depth because stale or vanishing displayed liquidity
// produced uneven partial-fill orphans. Sports execution now buys the cheap leg
// first and sizes the hedge to the actual fill, so default to using the full
// visible paired touch rather than capping sports size to a fraction of depth.
const SPORTS_DEPTH_RESERVE_MULTIPLIER = Number(process.env.ARB_DAEMON_SPORTS_DEPTH_RESERVE_MULTIPLIER ?? 1);
const NON_SPORTS_DEPTH_RESERVE_MULTIPLIER = Number(process.env.ARB_DAEMON_NON_SPORTS_DEPTH_RESERVE_MULTIPLIER ?? 1.5);
const STALE_SUBMITTED_MS = Number(process.env.ARB_DAEMON_STALE_SUBMITTED_MS ?? 600_000);
const HL_API = process.env.HYPERLIQUID_INFO_API ?? "https://api.hyperliquid.xyz/info";
const SPOT_REFRESH_MS = Number(process.env.ARB_DAEMON_SPOT_REFRESH_MS ?? 60_000);
const JUNE_BREAKEVEN_EPSILON = Number(process.env.ARB_DAEMON_JUNE_BREAKEVEN_EPSILON ?? 0.00001);
const JUNE_BREAKEVEN_COMMODITY_MAX_DISTANCE = Number(process.env.ARB_DAEMON_JUNE_BREAKEVEN_COMMODITY_MAX_DISTANCE ?? 0.10);
const JUNE_BREAKEVEN_CRYPTO_MAX_DISTANCE = Number(process.env.ARB_DAEMON_JUNE_BREAKEVEN_CRYPTO_MAX_DISTANCE ?? 0.15);
const NEAR_MISS_BUCKETS = [
  { label: "cost<=0.9995", cost: 0.9995 },
  { label: "cost<=1.0000", cost: 1.0000 },
  { label: "cost<=1.0010", cost: 1.0010 },
  { label: "cost<=1.0020", cost: 1.0020 },
  { label: "cost<=1.0050", cost: 1.0050 },
] as const;

// ─── Orphan completion / unwind tunables ───
// A naked leg (one FAK fills, the other is killed) is NOT held to a directional
// resolution. We try to RE-PAIR it across the same event's live ladder into a
// positive-EV monotonic package; if that is impossible (ladder shrank, price ran
// away, or we hit the deadline) we FAK-sell the orphan to flatten.
// Cadence of the orphan completion/unwind sweep.
const ORPHAN_POLL_MS = Number(process.env.ARB_DAEMON_ORPHAN_POLL_MS ?? 1_000);
// Tight price stop: unwind the instant the orphan's best bid drops this many
// cents below our fill (the dominant guard — bounds directional bleed hard).
const ORPHAN_STOP_CENTS = Number(process.env.ARB_DAEMON_ORPHAN_STOP_CENTS ?? 0.01);
// Default to zero tolerated orphan unwind loss. Set explicitly only if the
// operator decides a small loss is better than carrying directional risk.
const ORPHAN_MAX_UNWIND_LOSS_CENTS = Number(process.env.ARB_DAEMON_ORPHAN_MAX_UNWIND_LOSS_CENTS ?? 0);
// Completion is positive-EV (a real arb) only if fillPrice + complementAsk is
// below 1 by at least this margin (survives slippage).
const ORPHAN_COMPLETION_MARGIN = Number(process.env.ARB_DAEMON_ORPHAN_COMPLETION_MARGIN ?? 0.01);
const NON_SPORTS_ORPHAN_COMPLETION_MARGIN = Number(process.env.ARB_DAEMON_NON_SPORTS_ORPHAN_COMPLETION_MARGIN ?? 0);
// Force-unwind this long before the orphan market's own expiry (so we never
// roll into a directional settlement). Default 10 min.
const ORPHAN_EXPIRY_BUFFER_MS = Number(process.env.ARB_DAEMON_ORPHAN_EXPIRY_BUFFER_MS ?? 600_000);
// This long PAST the orphan market's expiry we treat it as resolved: the game is
// over, the market has settled, and there is nothing left to trade. A resolved
// winner is auto-redeemed by Polymarket to the funder (and zeroes out via the
// balance reconcile); a resolved loser has no bid and is worth $0. Either way we
// must NOT keep deferring "unwind … no bid to sell into" every poll forever — we
// close the orphan terminally. Default 30 min after expiry.
const ORPHAN_RESOLVED_GRACE_MS = Number(process.env.ARB_DAEMON_ORPHAN_RESOLVED_GRACE_MS ?? 1_800_000);
// Throttle the live event re-fetch per orphan (the completion ladder source).
const ORPHAN_LADDER_REFRESH_MS = Number(process.env.ARB_DAEMON_ORPHAN_LADDER_REFRESH_MS ?? 5_000);
// Smallest residual orphan we bother completing/holding; below this we just
// unwind the dust.
const ORPHAN_MIN_SHARES = Number(process.env.ARB_DAEMON_ORPHAN_MIN_SHARES ?? MIN_ORDER_SHARES);
// Sports imbalances should be dust-only. Anything larger is flattened immediately
// instead of entering the normal orphan completion loop.
const SPORTS_ORPHAN_DUST_SHARES = Number(process.env.ARB_DAEMON_SPORTS_ORPHAN_DUST_SHARES ?? 0.01);
const MAX_NAKED_SHARES_BEFORE_PAUSE = Number(process.env.ARB_DAEMON_MAX_NAKED_SHARES_BEFORE_PAUSE ?? SPORTS_ORPHAN_DUST_SHARES);
const DUST_EXIT_LIMIT_WAIT_MS = Number(process.env.ARB_DAEMON_DUST_EXIT_LIMIT_WAIT_MS ?? 5_000);
const DUST_EXIT_RETRY_MS = Number(process.env.ARB_DAEMON_DUST_EXIT_RETRY_MS ?? 60_000);
const ORPHAN_COMPLETION_SKIP_LOG_MS = Number(process.env.ARB_DAEMON_ORPHAN_COMPLETION_SKIP_LOG_MS ?? 60_000);
// CTF balances can lag matched CLOB responses. A fresh orphan must not be
// marked closed just because the first reconcile sees zero before settlement.
const ORPHAN_BALANCE_SETTLE_GRACE_MS = Number(process.env.ARB_DAEMON_ORPHAN_BALANCE_SETTLE_GRACE_MS ?? 30_000);
// Sports orphan repair is allowed to be more permissive than new-entry gating:
// if the only alternative is naked directional exposure, buy the complement
// immediately when the repaired package cost lands in a historically positive
// sport/cost bucket. Source: monotonic strategy significance canvas.
const SPORTS_ORPHAN_REPAIR_ENABLED = process.env.ARB_DAEMON_SPORTS_ORPHAN_REPAIR_ENABLED !== "0";
const SPORTS_ORPHAN_REPAIR_MAX_COST = Number(process.env.ARB_DAEMON_SPORTS_ORPHAN_REPAIR_MAX_COST ?? 1.35);
const SPORTS_ORPHAN_REPAIR_MIN_RESOLVED = Number(process.env.ARB_DAEMON_SPORTS_ORPHAN_REPAIR_MIN_RESOLVED ?? 30);
const SPORTS_ORPHAN_REPAIR_MIN_ROI_PCT = Number(process.env.ARB_DAEMON_SPORTS_ORPHAN_REPAIR_MIN_ROI_PCT ?? 0);
const ORPHANS_PATH = join(dirname(PACKAGES_PATH), "polymarket-live-orphans.json");
const CANDIDATE_SNAPSHOTS_PATH = join(dirname(PACKAGES_PATH), "monotonic-candidate-snapshots.jsonl");
const MIDDLE_AUDIT_PATH = join(dirname(PACKAGES_PATH), "monotonic-middle-audit.jsonl");
const CAPTURE_AUDIT_PATH = join(dirname(PACKAGES_PATH), "monotonic-capture-audit.jsonl");
const PAUSE_PATH = join(dirname(PACKAGES_PATH), "polymarket-arb-daemon-paused.json");
// Per-event pause scope: a sports orphan fences off ONLY its own event, instead
// of the global PAUSE_PATH halting every asset/event. The global pause stays
// reserved for genuinely account-wide failures (e.g. maker address not allowed).
const PAUSED_EVENTS_PATH = join(dirname(PACKAGES_PATH), "polymarket-arb-daemon-paused-events.json");
const QUARANTINE_PATH = join(dirname(PACKAGES_PATH), "polymarket-arb-daemon-quarantine.json");

type PriceLevels = { bids: Map<number, number>; asks: Map<number, number> };
type TopOfBook = { ask: number; askSize: number; bid: number; bidSize: number; spread: number };

interface WatchPackage {
  key: string;
  base: Candidate;
  broadYesToken: string;
  narrowNoToken: string;
  narrowYesToken: string;
}

interface LiveLegs {
  broadYesAsk: number;
  broadYesAskSize: number;
  broadSpread: number;
  narrowNoAsk: number;
  narrowNoAskSize: number;
  narrowSpread: number;
}

interface NearMissSample {
  observedAt: string;
  packageId: string;
  eventSlug: string;
  asset: string;
  eventTitle: string;
  direction: Direction;
  ladderKey: string;
  broadMarketId: string;
  broadQuestion: string;
  broadStrike: number;
  broadYesTokenId: string;
  narrowMarketId: string;
  narrowQuestion: string;
  narrowStrike: number;
  narrowYesTokenId: string;
  narrowNoTokenId: string;
  broadEndDate: string | null;
  narrowEndDate: string | null;
  cost: number;
  edge: number;
  availableSize: number;
  broadYesAsk: number;
  broadYesAskSize: number;
  narrowNoAsk: number;
  narrowNoAskSize: number;
  maxSpread: number;
  minShares: number;
  farDatedBlock: string | null;
  rangeBlock: string | null;
  edgeOk: boolean;
  spreadOk: boolean;
  sizeOk: boolean;
  executableGate: boolean;
}

type CaptureTerminalStatus =
  | "trading_paused"
  | "shadow_gate_blocked"
  | "shadow_preflight_failed"
  | "shadow_sizing_rejected"
  | "shadow_would_submit"
  | "event_paused"
  | "already_open"
  | "quarantined"
  | "shared_token_in_flight"
  | "sports_event_in_flight"
  | "sports_blocked"
  | "sports_event_cap"
  | "per_minute_cap"
  | "low_balance"
  | "max_open_packages"
  | "sports_preflight_failed"
  | "sports_preflight_rejected"
  | "far_dated_blocked"
  | "range_blocked"
  | "sizing_rejected"
  | "dry_run"
  | "post_preflight_lock"
  | "post_preflight_event_lock"
  | "post_refresh_lock"
  | "post_refresh_event_lock"
  | "fresh_sizing_rejected"
  | "fresh_sports_event_cap"
  | "balance_headroom"
  | "submitted_result"
  | "execution_error";

interface ExecutionCaptureResult {
  packageRecordId: string;
  recordStatus: string;
  failureReason?: string;
  intendedShares: number;
  broadFilled: number;
  narrowFilled: number;
  matched: number;
  nakedShares: number;
  nakedRole: "broad_yes" | "narrow_no" | null;
  actualCost: number;
  actualPairCost: number | null;
  broadAvgPrice: number | null;
  narrowAvgPrice: number | null;
  legErrors: string[];
  fillSource?: string;
  latency?: Record<string, unknown>;
  orderIds?: Record<string, unknown>;
  orphanId?: string;
}

type ExecutionQuoteContext = {
  wsCost: number;
  freshCost: number;
  preflightFetchMs?: number;
};

function attachExecutionQuote(
  record: LivePackage,
  quoteContext: ExecutionQuoteContext | undefined,
  actualPairCost: number | null,
): void {
  if (!quoteContext) return;
  record.executionQuote = {
    wsCost: quoteContext.wsCost,
    freshCost: quoteContext.freshCost,
    actualPairCost,
    preflightFetchMs: quoteContext.preflightFetchMs,
    recordedAt: new Date().toISOString(),
  };
}

interface CaptureContext {
  captureId: string;
  startedMs: number;
  startedAt: string;
  wsCandidate: Candidate;
  executionTokens: string[];
  preflight?: Record<string, unknown>;
  sizing?: Record<string, unknown>;
  execution?: ExecutionCaptureResult;
}

// A naked leg awaiting re-pair or unwind. `role` is which leg of the original
// package actually filled (and is therefore the position we now hold):
//   broad_yes -> we hold YES(strike); complement is a NO at a more-extreme strike
//   narrow_no -> we hold NO(strike);  complement is a YES at a less-extreme strike
type OrphanStatus = "completing" | "completed" | "unwound" | "stranded";
interface Orphan {
  id: string;
  packageId: string;        // original package this leg came from
  eventSlug: string;
  asset: string;
  direction: Direction;
  role: "broad_yes" | "narrow_no";
  marketId: string;         // the orphan leg's own market
  tokenId: string;          // the token we are actually holding
  strike: number;
  fillPrice: number;        // p1 — sunk cost per share
  shares: number;           // remaining naked shares to cover
  endDate: string | null;   // orphan market expiry T
  resolutionSource: string;
  createdAt: string;
  updatedAt: string;
  status: OrphanStatus;
  attempts: number;
  note?: string;
}

interface QuarantineEntry {
  quarantinedAt: string;
  reason: string;
  packageId: string;
  eventSlug: string;
  asset: string;
  tokenIds: string[];
  details?: Record<string, unknown>;
}

interface PausedEventEntry {
  eventSlug: string;
  pausedAt: string;
  reason: string;
  details?: Record<string, unknown>;
}

// ─── In-memory order books, keyed by token id ───
const books = new Map<string, PriceLevels>();
// token id -> packages that reference it (for targeted re-evaluation)
const tokenToPackages = new Map<string, Set<string>>();
const packages = new Map<string, WatchPackage>();

// Idempotency / caps
const inFlight = new Set<string>();
const tokensInFlight = new Set<string>();
const eventsInFlight = new Set<string>();
const evaluatingPackages = new Set<string>();
let alreadyOpen = new Set<string>();
const submitTimestamps: number[] = [];
const quarantinedPackages = new Set<string>();
const quarantinedTokens = new Set<string>();
// eventSlug -> pause record. Scopes a sports orphan halt to its own event so an
// orphan in one game cannot freeze entries on every other event/asset.
const pausedEvents = new Map<string, PausedEventEntry>();
const spotPrices = new Map<string, number>();
let lastSpotRefreshAt = 0;

// Cached on-chain state (refreshed off the hot path)
let cachedFunderBalance = 0;
let cachedFunderAllowance = 0;
let balanceKnown = false;
let pausedForLowBalanceLogged = false;
let reservedSpendUsd = 0;
let balanceRefreshFailures = 0;
let lastBalanceFailureLogAt = 0;
let clobRestCooldownUntil = 0;
const lastBookSeedAt = new Map<string, number>();

// Fill-signal waiters keyed by token id (resolved by the User websocket)
const fillWaiters = new Map<string, Set<() => void>>();

// ─── Orphan inventory (naked legs awaiting re-pair or unwind) ───
const orphans = new Map<string, Orphan>();
// orphan id -> in-flight guard so the poll loop and the reactive stop never
// double-fire a completion/unwind on the same orphan.
const orphanInFlight = new Set<string>();
// orphan id -> last live-ladder refresh timestamp (throttles event re-fetch).
const orphanLadderAt = new Map<string, number>();
const dustExitAttemptAt = new Map<string, number>();
const completionSkipAttemptAt = new Map<string, number>();
// eventSlug -> cached freshly-fetched event ladder + quotes (shared across
// orphans in the same event within ORPHAN_LADDER_REFRESH_MS).
const orphanEventCache = new Map<string, { at: number; quotes: MarketQuote[] }>();

// Throttle repeated skip logs so a single near-miss package (passes the dynamic
// gate but always sizes below the min order) cannot flood the journal on every
// book delta.
const lastSkipLogAt = new Map<string, number>();
const SKIP_LOG_THROTTLE_MS = 60_000;

// Per-interval near-miss state. The map stores the best (lowest-cost) observation
// per package so logs answer "how many packages got close?" rather than "how
// many websocket ticks fired?"
let nearMissStartedAt = Date.now();
let nearMissObservations = 0;
const nearMissBestByPackage = new Map<string, NearMissSample>();
const captureAuditLastAt = new Map<string, number>();
const shadowCaptureInFlight = new Set<string>();
let sportsPreflightAttempts = 0;
let sportsPreflightFetchMsTotal = 0;
let sportsPreflightFetchMsMax = 0;
let sportsPreflightPassed = 0;
let sportsPreflightRejected = 0;

let clob: Awaited<ReturnType<typeof clobClient>> | null = null;
let reconcileAddress = "";
let marketWs: WebSocket | null = null;
let userWs: WebSocket | null = null;
let shuttingDown = false;
let tradingPausedReason: string | null = null;
const tickSizeCache = new Map<string, TickSize>();

function log(...args: unknown[]) {
  console.log(`[arb-daemon ${new Date().toISOString()}]`, ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installHttpKeepAlive() {
  if (!HTTP_KEEP_ALIVE) return;
  try {
    const undici = require("undici") as any;
    if (typeof undici?.setGlobalDispatcher !== "function" || typeof undici?.Agent !== "function") return;
    undici.setGlobalDispatcher(new undici.Agent({
      connections: Number(process.env.ARB_DAEMON_HTTP_CONNECTIONS ?? 16),
      keepAliveTimeout: Number(process.env.ARB_DAEMON_HTTP_KEEP_ALIVE_TIMEOUT_MS ?? 30_000),
      keepAliveMaxTimeout: Number(process.env.ARB_DAEMON_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS ?? 120_000),
    }));
    log("HTTP keep-alive dispatcher installed");
  } catch (err: any) {
    log(`HTTP keep-alive dispatcher unavailable: ${err?.message ?? String(err)}`);
  }
}

type Clob = Awaited<ReturnType<typeof clobClient>>["client"];
type PreparedFakBuy = {
  role: "broad_yes" | "narrow_no";
  tokenId: string;
  price: number;
  shares: number;
  order: Awaited<ReturnType<Clob["createOrder"]>>;
  orderType: OrderType;
};

async function tickSize(client: Clob, tokenId: string): Promise<TickSize> {
  const cached = tickSizeCache.get(tokenId);
  if (cached) return cached;
  const size = await client.getTickSize(tokenId) as TickSize;
  tickSizeCache.set(tokenId, size);
  return size;
}

async function prepareFakBuy(client: Clob, leg: { role: "broad_yes" | "narrow_no"; tokenId: string; price: number; shares: number }): Promise<PreparedFakBuy> {
  const size = await tickSize(client, leg.tokenId);
  const order = await client.createOrder(
    { tokenID: leg.tokenId, price: leg.price, size: Number(leg.shares.toFixed(6)), side: Side.BUY, ...(process.env.POLY_BUILDER_CODE?.trim() ? { builderCode: process.env.POLY_BUILDER_CODE.trim() } : {}) },
    { tickSize: size, negRisk: false },
  );
  return { ...leg, order, orderType: OrderType.FAK };
}

async function postPreparedFakBuys(client: Clob, prepared: PreparedFakBuy[], forceBatch: boolean) {
  const postStartedMs = Date.now();
  if (forceBatch || MONOTONIC_POST_MODE === "batch") {
    const response = await client.postOrders(prepared.map((row) => ({ order: row.order, orderType: row.orderType })));
    return {
      responses: Array.isArray(response) ? response : [response],
      postOrdersMs: Date.now() - postStartedMs,
      postMode: "batch",
    };
  }
  const responses = await Promise.all(prepared.map((row) => client.postOrder(row.order, row.orderType)));
  return {
    responses,
    postOrdersMs: Date.now() - postStartedMs,
    postMode: "parallel",
  };
}

function responseBuyShares(response: unknown): number {
  const shares = Number((response as any)?.takingAmount);
  return Number.isFinite(shares) && shares > 0 ? shares : 0;
}

function averageBuyPrice(response: unknown, fallbackPrice: number): number {
  const row = response as any;
  const cost = Number(row?.makingAmount);
  const shares = Number(row?.takingAmount);
  if (Number.isFinite(cost) && cost > 0 && Number.isFinite(shares) && shares > 0) return cost / shares;
  const price = Number(row?.price);
  if (Number.isFinite(price) && price > 0) return price;
  return fallbackPrice;
}

function emptyLevels(): PriceLevels {
  return { bids: new Map(), asks: new Map() };
}

function getBook(tokenId: string): PriceLevels {
  let b = books.get(tokenId);
  if (!b) {
    b = emptyLevels();
    books.set(tokenId, b);
  }
  return b;
}

function applySnapshot(tokenId: string, bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>) {
  const b = emptyLevels();
  for (const level of bids) if (level.price > 0 && level.size > 0) b.bids.set(level.price, level.size);
  for (const level of asks) if (level.price > 0 && level.size > 0) b.asks.set(level.price, level.size);
  books.set(tokenId, b);
}

function applyLevelChange(tokenId: string, side: string, price: number, size: number) {
  if (!(price > 0)) return;
  const b = getBook(tokenId);
  const map = side.toUpperCase() === "SELL" || side.toUpperCase() === "ASK" ? b.asks : b.bids;
  if (size > 0) map.set(price, size);
  else map.delete(price);
}

function topOfBook(tokenId: string): TopOfBook {
  const b = books.get(tokenId);
  if (!b) return { ask: 0, askSize: 0, bid: 0, bidSize: 0, spread: 0 };
  let ask = 0;
  let askSize = 0;
  for (const [price, size] of b.asks) {
    if (size <= 0) continue;
    if (ask === 0 || price < ask) {
      ask = price;
      askSize = size;
    }
  }
  let bid = 0;
  let bidSize = 0;
  for (const [price, size] of b.bids) {
    if (size <= 0) continue;
    if (price > bid) {
      bid = price;
      bidSize = size;
    }
  }
  const spread = bid > 0 && ask > 0 ? Math.max(0, ask - bid) : 0;
  return { ask, askSize, bid, bidSize, spread };
}

async function postHyperliquidInfo(payload: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOOK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(HL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "polymarket-arb-daemon/1.0" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`POST ${HL_API} ${JSON.stringify(payload)} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function setSpot(asset: string, raw: unknown) {
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) spotPrices.set(asset, value);
}

async function refreshSpotPrices() {
  try {
    const metaAndCtx = await postHyperliquidInfo({ type: "metaAndAssetCtxs" });
    const universe: Array<{ name?: string }> = metaAndCtx?.[0]?.universe ?? [];
    const ctxs: Array<{ markPx?: string; oraclePx?: string }> = metaAndCtx?.[1] ?? [];
    for (const asset of ["BTC", "ETH", "SOL", "HYPE"]) {
      const idx = universe.findIndex((row) => row.name === asset);
      if (idx >= 0) setSpot(asset, ctxs[idx]?.markPx ?? ctxs[idx]?.oraclePx);
    }

    const dexMeta = await postHyperliquidInfo({ type: "metaAndAssetCtxs", dex: "xyz" });
    const dexUniverse: Array<{ name?: string }> = dexMeta?.[0]?.universe ?? [];
    const dexCtxs: Array<{ markPx?: string; oraclePx?: string }> = dexMeta?.[1] ?? [];
    for (const [asset, coin] of [["GOLD", "xyz:GOLD"], ["SILVER", "xyz:SILVER"]] as const) {
      const idx = dexUniverse.findIndex((row) => row.name === coin);
      if (idx >= 0) setSpot(asset, dexCtxs[idx]?.markPx ?? dexCtxs[idx]?.oraclePx);
    }

    lastSpotRefreshAt = Date.now();
    log(`spot refresh: ${["BTC", "ETH", "SOL", "HYPE", "GOLD", "SILVER"].map((asset) => `${asset}=${spotPrices.get(asset)?.toFixed(2) ?? "na"}`).join(" ")}`);
  } catch (err: any) {
    log(`spot refresh failed: ${err?.message ?? String(err)}`);
  }
}

async function fetchRawBook(tokenId: string): Promise<{ bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }> {
  if (Date.now() < clobRestCooldownUntil) {
    throw new Error(`CLOB REST cooldown active for ${Math.ceil((clobRestCooldownUntil - Date.now()) / 1000)}s`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOOK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${HOST}/book?${new URLSearchParams({ token_id: tokenId })}`, {
      headers: { Accept: "application/json", "User-Agent": "polymarket-arb-daemon/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 429) clobRestCooldownUntil = Date.now() + CLOB_REST_429_COOLDOWN_MS;
      throw new Error(`GET /book ${tokenId} -> ${res.status}`);
    }
    const data = await res.json() as { bids?: Array<{ price?: string; size?: string }>; asks?: Array<{ price?: string; size?: string }> };
    const toLevels = (rows?: Array<{ price?: string; size?: string }>) => (rows ?? [])
      .map((r) => ({ price: Number(r.price), size: Number(r.size) }))
      .filter((r) => Number.isFinite(r.price) && Number.isFinite(r.size));
    return { bids: toLevels(data.bids), asks: toLevels(data.asks) };
  } finally {
    clearTimeout(timeout);
  }
}

function watchedTokens(): string[] {
  return [...books.keys()];
}

// ─── Watchlist construction ───

function registerToken(tokenId: string, key: string) {
  if (!tokenId) return;
  getBook(tokenId);
  let set = tokenToPackages.get(tokenId);
  if (!set) {
    set = new Set();
    tokenToPackages.set(tokenId, set);
  }
  set.add(key);
}

function isSportsGameSlug(slug: string): boolean {
  // Singles tennis / NBA / MLB:   <league>-<a>-<b>-YYYY-MM-DD
  // Tennis doubles:               (atp|wta)-doubles-<a>-<b>-YYYY-MM-DD
  // ITF singles:                  itf-<a>-<b>-YYYY-MM-DD
  // Soccer:                       (fifwc|mls)-<a>-<b>-YYYY-MM-DD(-more-markets)?
  return /^(?:(?:nba|mlb|atp|wta|itf)-[a-z0-9]+-[a-z0-9]+|(?:atp|wta)-doubles-[a-z0-9]+-[a-z0-9]+|(?:fifwc|mls)-[a-z0-9]+-[a-z0-9]+)-\d{4}-\d{2}-\d{2}(?:-more-markets)?$/.test(slug);
}

function sportsGameDate(slug: string): string | null {
  const match = slug.match(/-(\d{4}-\d{2}-\d{2})(?:-more-markets)?$/);
  return match?.[1] ?? null;
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

function isCurrentOrFutureSportsGameSlug(slug: string, today = todayInNewYork()): boolean {
  const gameDate = sportsGameDate(slug);
  return !!gameDate && gameDate >= today;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isWithinSportsAutoDiscoveryHorizon(slug: string, today = todayInNewYork()): boolean {
  if (SPORTS_AUTO_DISCOVERY_DAYS < 0) return true;
  const gameDate = sportsGameDate(slug);
  if (!gameDate || gameDate < today) return false;
  return gameDate <= addDaysToDateKey(today, SPORTS_AUTO_DISCOVERY_DAYS);
}

async function configuredEventSlugs(): Promise<string[]> {
  const today = todayInNewYork();
  const out: string[] = [];
  for (const slug of eventSlugs()) {
    if (!isSportsGameSlug(slug)) {
      out.push(slug);
      continue;
    }
    if (!isCurrentOrFutureSportsGameSlug(slug, today)) {
      log(`sports lifecycle: dropping past configured slug ${slug}`);
      continue;
    }
    if (!KEEP_FAR_FUTURE_CONFIGURED_SPORTS && !isWithinSportsAutoDiscoveryHorizon(slug, today)) {
      log(`sports lifecycle: dropping far-future configured slug ${slug}; set ARB_DAEMON_KEEP_FAR_FUTURE_CONFIGURED_SPORTS=1 to keep it`);
      continue;
    }
    try {
      const event = await fetchEvent(arbConfig, slug);
      if ((event as { closed?: boolean } | null)?.closed) {
        log(`sports lifecycle: dropping resolved configured slug ${slug}`);
        continue;
      }
    } catch (err: any) {
      log(`sports lifecycle: keeping configured slug ${slug}; status check failed: ${err?.message ?? String(err)}`);
    }
    out.push(slug);
  }
  return out;
}

type SportsGameKind = "nba" | "mlb" | "soccer" | "tennis";

function sportsGameDiscoveryEnabled(kind: SportsGameKind): boolean {
  if (kind === "nba") return DISCOVER_NBA_GAMES;
  if (kind === "mlb") return DISCOVER_MLB_GAMES;
  if (kind === "tennis") return DISCOVER_TENNIS_GAMES;
  return DISCOVER_SOCCER_GAMES;
}

function sportsGameDiscoveryTags(kind: SportsGameKind): string[] {
  if (kind === "nba") return ["nba", "basketball"];
  if (kind === "mlb") return ["mlb", "baseball"];
  if (kind === "tennis") return ["tennis", "atp", "wta", "itf"];
  // Polymarket buries fifwc-* events past offset 300 under the `soccer` tag,
  // while the dedicated `fifa-world-cup` tag surfaces them on page 1. Include
  // both so we discover FIFA tournament matches without bumping the soccer
  // pagination limit absurdly high.
  return ["soccer", "fifa-world-cup"];
}

function sportsGameDiscoveryLimit(kind: SportsGameKind): number {
  return kind === "soccer" ? SOCCER_DISCOVERY_LIMIT : SPORTS_DISCOVERY_LIMIT;
}

function matchesSportsGameKind(slug: string, kind: SportsGameKind): boolean {
  if (kind === "nba") return slug.startsWith("nba-");
  if (kind === "mlb") return slug.startsWith("mlb-");
  if (kind === "tennis") return slug.startsWith("atp-") || slug.startsWith("wta-") || slug.startsWith("itf-") || slug.includes("tennis");
  return slug.startsWith("fifwc-") || slug.startsWith("mls-");
}

function sportsGameHasLadder(event: GammaEvent): boolean {
  return (event.markets ?? []).some((market) => {
    const question = market.question ?? "";
    return /\b(?:Match\s+)?O\/U\s+[0-9]/i.test(question) || /^Spread:/i.test(question);
  });
}

async function discoverSportsGameSlugs(kind: SportsGameKind): Promise<string[]> {
  if (!sportsGameDiscoveryEnabled(kind)) return [];
  const out = new Set<string>();
  const today = todayInNewYork();
  for (const tag of sportsGameDiscoveryTags(kind)) {
    for (let offset = 0; offset < sportsGameDiscoveryLimit(kind); offset += 100) {
      const events = await fetchJson(`${GAMMA_API}/events?${new URLSearchParams({
        active: "true",
        closed: "false",
        limit: "100",
        offset: String(offset),
        tag_slug: tag,
      })}`, BOOK_FETCH_TIMEOUT_MS) as GammaEvent[];
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        const slug = event.slug ?? "";
        if (!matchesSportsGameKind(slug, kind) || !isSportsGameSlug(slug)) continue;
        if (!isWithinSportsAutoDiscoveryHorizon(slug, today)) continue;
        if (sportsGameHasLadder(event)) out.add(slug);
      }
      if (events.length < 100) break;
    }
  }
  return [...out].sort();
}

// Auto-discover price-ladder events (crypto/stock/commodity "what price will X
// hit" families) so the watchlist tracks every live ladder, not just the
// hardcoded defaults. Events must parse to a known asset and look like a
// nested ladder with at least 3 strike markets.
async function discoverLadderEventSlugs(): Promise<string[]> {
  if (!DISCOVER_LADDERS) return [];
  const out = new Set<string>();
  for (const tag of LADDER_DISCOVERY_TAGS) {
    for (let offset = 0; offset < SPORTS_DISCOVERY_LIMIT; offset += 100) {
      let events: GammaEvent[];
      try {
        events = await fetchJson(`${GAMMA_API}/events?${new URLSearchParams({
          active: "true",
          closed: "false",
          limit: "100",
          offset: String(offset),
          tag_slug: tag,
        })}`, BOOK_FETCH_TIMEOUT_MS) as GammaEvent[];
      } catch (err: any) {
        log(`ladder discovery tag=${tag} offset=${offset} failed: ${err?.message ?? String(err)}`);
        break;
      }
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        const slug = event.slug ?? "";
        if (!slug || (event.markets ?? []).length < 3) continue;
        if (!polymarketAssetForSlug(slug)) continue;
        if (!isNestedLadderEvent(slug, event.title ?? "")) continue;
        out.add(slug);
      }
      if (events.length < 100) break;
    }
  }
  return [...out].sort();
}

async function currentEventSlugs(): Promise<string[]> {
  const configured = await configuredEventSlugs();
  const [discoveredNba, discoveredMlb, discoveredSoccer, discoveredTennis, discoveredLadders] = await Promise.all([
    discoverSportsGameSlugs("nba"),
    discoverSportsGameSlugs("mlb"),
    discoverSportsGameSlugs("soccer"),
    discoverSportsGameSlugs("tennis"),
    discoverLadderEventSlugs(),
  ]);
  if (discoveredNba.length) log(`nba discovery: ${discoveredNba.length} active game slugs`);
  if (discoveredMlb.length) log(`mlb discovery: ${discoveredMlb.length} active game slugs`);
  if (discoveredSoccer.length) log(`soccer discovery: ${discoveredSoccer.length} active game slugs`);
  if (discoveredTennis.length) log(`tennis discovery: ${discoveredTennis.length} active match slugs`);
  if (discoveredLadders.length) log(`ladder discovery: ${discoveredLadders.length} active ladder events`);
  return [...configured, ...TENNIS_EVENT_SLUGS, ...discoveredNba, ...discoveredMlb, ...discoveredSoccer, ...discoveredTennis, ...discoveredLadders].filter((slug, idx, slugs) => slugs.indexOf(slug) === idx);
}

async function refreshWatchlist(): Promise<void> {
  const foundAt = new Date().toISOString();
  let candidates: Candidate[];
  try {
    const result = await findStructuralCandidates(arbConfig, await currentEventSlugs(), foundAt);
    candidates = result.candidates;
    if (result.errors.length) log(`watchlist scan errors=${result.errors.length} first=${result.errors[0]}`);
  } catch (err: any) {
    log(`watchlist refresh failed: ${err?.message ?? String(err)}`);
    return;
  }

  // Keep structurally-valid ladder packages even when they do NOT have a live
  // edge yet. The websocket daemon must subscribe before the arb appears; the
  // dynamic gate (edge/spread/top-of-book size) is re-checked on every delta.
  // Static deal-breakers (wrong asset, expiry/resolution mismatch) always
  // filter out. The liquidity gate ONLY filters live-tradable adapters; for
  // shadow-only sports (tennis, ITF, doubles, etc.) we want every ladder in
  // the watchlist so shadow capture can build a dataset on thin markets too.
  const watch = candidates.filter((c) => {
    if (!isTrueMiddleCandidate(c)) return false;
    const blockers = c.rejectionReasons;
    if (blockers.some((reason) => ["asset_not_allowlisted", "ladder_mismatch", "expiry_mismatch", "resolution_mismatch"].includes(reason))) return false;
    if (blockers.includes("low_liquidity")) {
      const adapter = adapterForCandidate(c);
      if (adapter?.mode === "live_enabled") return false;
    }
    return true;
  });
  const watchAssetCounts = watch.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.asset] = (counts[candidate.asset] ?? 0) + 1;
    return counts;
  }, {});
  const seen = new Set<string>();
  let added = 0;
  for (const base of watch) {
    const key = base.packageId;
    seen.add(key);
    if (!packages.has(key)) added += 1;
    packages.set(key, {
      key,
      base,
      broadYesToken: base.broad.yesTokenId,
      narrowNoToken: base.narrow.noTokenId,
      narrowYesToken: base.narrow.yesTokenId,
    });
    registerToken(base.broad.yesTokenId, key);
    registerToken(base.narrow.noTokenId, key);
    registerToken(base.narrow.yesTokenId, key);
  }
  // Drop packages that disappeared from discovery.
  for (const key of [...packages.keys()]) {
    if (!seen.has(key)) {
      const pkg = packages.get(key)!;
      packages.delete(key);
      for (const tok of [pkg.broadYesToken, pkg.narrowNoToken, pkg.narrowYesToken]) {
        tokenToPackages.get(tok)?.delete(key);
      }
    }
  }
  refreshAlreadyOpen();
  log(`watchlist: ${packages.size} packages / ${watchedTokens().length} tokens (added ${added}) assets=${JSON.stringify(watchAssetCounts)}`);
}

function refreshAlreadyOpen() {
  const rows = readJsonArray<LivePackage>(PACKAGES_PATH);
  const open = new Set<string>();
  for (const row of rows) {
    if (isDaemonOpenPackage(row) || isCompletedPackagePosition(row)) {
      open.add(row.packageId);
    }
  }
  for (const orphan of activeOrphans()) {
    open.add(orphan.packageId);
  }
  alreadyOpen = open;
}

function isCompletedPackagePosition(row: LivePackage): boolean {
  if (row.status !== "package_complete") return false;
  if (row.failureReason) return false;
  if ((row.actualCost ?? 0) <= 0 || (row.filledShares ?? 0) <= 0) return false;
  const soldShares = Number((row as { soldShares?: number }).soldShares ?? 0);
  return soldShares + EPSILON < (row.filledShares ?? 0);
}

function isStaleSubmittedNoFill(row: LivePackage): boolean {
  if (!["quoted", "leg1_submitted", "leg1_filled", "leg2_submitted"].includes(row.status)) return false;
  if ((row.filledShares ?? 0) > 0 || (row.actualCost ?? 0) > 0) return false;
  const updatedAt = Date.parse(row.updatedAt || row.createdAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_SUBMITTED_MS;
}

function isCheapFirstIntentMarker(failureReason: string | undefined): boolean {
  return /^sports_cheap_first_intent\b/i.test(failureReason ?? "");
}

function isFlatClosedPackage(row: LivePackage): boolean {
  if ((row as { status?: string }).status === "orphan_unwound") return true;
  if (row.status !== "unwind_required") return false;
  if ((row.actualCost ?? 0) > EPSILON || (row.filledShares ?? 0) > EPSILON) return false;
  return !activeOrphans().some((o) => o.packageId === row.packageId && o.shares > SPORTS_ORPHAN_DUST_SHARES);
}

function isDaemonOpenPackage(row: LivePackage): boolean {
  if (isStaleSubmittedNoFill(row)) return false;
  if (isFlatClosedPackage(row)) return false;
  if (["quoted", "leg1_submitted", "leg1_filled", "leg2_submitted"].includes(row.status)) return true;
  if (row.status === "package_complete") return !isCleanCompletedPackage(row);
  if (row.status !== "unwind_required") return false;
  return (row.actualCost ?? 0) > 0
    || (row.filledShares ?? 0) > 0
    || /orphan|sports_immediate_exit|naked_/i.test(row.failureReason ?? "");
}

function isCleanCompletedPackage(row: LivePackage): boolean {
  if (row.status !== "package_complete") return false;
  if ((row.actualCost ?? 0) <= 0 || (row.filledShares ?? 0) <= 0) return false;
  if (!row.failureReason) return true;
  // `sports_cheap_first_intent` is durable execution metadata, not an error.
  return isCheapFirstIntentMarker(row.failureReason);
}

function daemonOpenPackageCount(rows: LivePackage[]): number {
  return rows.filter(isDaemonOpenPackage).length;
}

function activeSportsEventPackages(rows: LivePackage[], eventSlug: string): LivePackage[] {
  return rows.filter((row) =>
    row.eventSlug === eventSlug
    && (isDaemonOpenPackage(row) || isCompletedPackagePosition(row))
    && (isSportsAsset(row.asset) || isSportsSlug(row.eventSlug))
  );
}

function activeSportsEventCost(rows: LivePackage[], eventSlug: string): number {
  return activeSportsEventPackages(rows, eventSlug).reduce((sum, row) => {
    const actual = Number(row.actualCost ?? 0);
    const intended = Number(row.intendedCost ?? 0);
    return sum + (actual > 0 ? actual : intended > 0 ? intended : 0);
  }, 0);
}

function sharesExecutionLeg(candidate: Candidate, row: LivePackage): boolean {
  return row.tokenIds?.broadYes === candidate.broad.yesTokenId
    || row.tokenIds?.narrowNo === candidate.narrow.noTokenId
    || row.tokenIds?.broadYes === candidate.narrow.noTokenId
    || row.tokenIds?.narrowNo === candidate.broad.yesTokenId;
}

function sportsEventExposureBlock(candidate: Candidate, rows: LivePackage[], nextCost = 0): string | null {
  if (!isSportsCandidate(candidate)) return null;
  if (candidate.asset === "SOCCER" && SOCCER_ONE_FILL_PER_EVENT) {
    const priorFill = rows.some((row) =>
      row.eventSlug === candidate.eventSlug
      && row.status === "package_complete"
      && isCleanCompletedPackage(row)
    );
    if (priorFill) {
      return `soccer_event_already_filled event=${candidate.eventSlug}`;
    }
  }
  const active = activeSportsEventPackages(rows, candidate.eventSlug);
  if (active.length >= SPORTS_MAX_EVENT_PACKAGES) {
    return `sports_event_package_cap event=${candidate.eventSlug} open=${active.length} cap=${SPORTS_MAX_EVENT_PACKAGES}`;
  }
  const eventCost = activeSportsEventCost(rows, candidate.eventSlug);
  if (SPORTS_MAX_EVENT_USD > 0 && eventCost + Math.max(0, nextCost) > SPORTS_MAX_EVENT_USD + EPSILON) {
    return `sports_event_usd_cap event=${candidate.eventSlug} openCost=${eventCost.toFixed(2)} next=${Math.max(0, nextCost).toFixed(2)} cap=${SPORTS_MAX_EVENT_USD.toFixed(2)}`;
  }
  if (SPORTS_BLOCK_EVENT_OVERLAP && active.some((row) => sharesExecutionLeg(candidate, row))) {
    return `sports_event_overlap event=${candidate.eventSlug} shared execution leg with active package`;
  }
  return null;
}

// ─── Live candidate + evaluation ───

function isTrueMiddleCandidate(candidate: Candidate): boolean {
  return candidate.broad.marketId !== candidate.narrow.marketId
    && candidate.broad.question !== candidate.narrow.question
    && candidate.broad.ladderKey === candidate.narrow.ladderKey
    && candidate.broad.direction === candidate.narrow.direction
    && candidate.broad.strike !== candidate.narrow.strike
    && (!candidate.broad.endDate || !candidate.narrow.endDate || candidate.broad.endDate === candidate.narrow.endDate);
}

function liveLegs(pkg: WatchPackage): LiveLegs | null {
  const broad = topOfBook(pkg.broadYesToken);
  const narrowNo = topOfBook(pkg.narrowNoToken);
  const narrowYes = topOfBook(pkg.narrowYesToken);
  if (broad.ask <= 0 || narrowNo.ask <= 0) return null;
  return {
    broadYesAsk: broad.ask,
    broadYesAskSize: broad.askSize,
    broadSpread: broad.spread,
    narrowNoAsk: narrowNo.ask,
    narrowNoAskSize: narrowNo.askSize,
    // Mirror the hourly gate: liquidity quality is judged on the YES books, not
    // the (independently quoted) NO book.
    narrowSpread: narrowYes.spread,
  };
}

function liveCandidate(base: Candidate, legs: LiveLegs): Candidate {
  const c = structuredClone(base);
  c.broad.yesBook.ask = legs.broadYesAsk;
  c.broad.yesBook.askSize = legs.broadYesAskSize;
  c.broad.yesBook.spread = legs.broadSpread;
  c.narrow.noBook.ask = legs.narrowNoAsk;
  c.narrow.noBook.askSize = legs.narrowNoAskSize;
  c.narrow.yesBook.spread = legs.narrowSpread;
  c.packageCost = legs.broadYesAsk + legs.narrowNoAsk;
  c.lockedEdge = 1 - c.packageCost;
  c.availableSize = Math.min(legs.broadYesAskSize, legs.narrowNoAskSize);
  c.maxSpread = Math.max(legs.broadSpread, legs.narrowSpread);
  c.foundAt = new Date().toISOString();
  return c;
}

function isSportsCandidate(candidate: Candidate): boolean {
  return candidate.asset === "NBA"
    || candidate.asset === "SOCCER"
    || candidate.asset === "MLB"
    || candidate.eventSlug.startsWith("nba-")
    || candidate.eventSlug.startsWith("mlb-")
    || candidate.eventSlug.startsWith("fifwc-")
    || candidate.eventSlug.startsWith("mls-")
    || candidate.eventSlug.includes("soccer")
    || candidate.eventSlug.includes("world-cup")
    || candidate.eventSlug.includes("fifa")
    || candidate.eventSlug.includes("uefa");
}

function sportsEntryBlocked(candidate: Candidate): string | null {
  if (!isSportsCandidate(candidate)) return null;
  if (SPORTS_ENTRY_CUTOFF_MS <= 0) return null;
  const dates = [candidate.broad.endDate, candidate.narrow.endDate].filter(Boolean) as string[];
  const endTimes = dates.map((date) => Date.parse(date)).filter((time) => Number.isFinite(time));
  if (!endTimes.length) return "sports market missing endDate";
  const cutoff = Math.min(...endTimes) - SPORTS_ENTRY_CUTOFF_MS;
  if (Date.now() >= cutoff) {
    return `sports market start cutoff endDate=${new Date(Math.min(...endTimes)).toISOString()} cutoffMs=${SPORTS_ENTRY_CUTOFF_MS}`;
  }
  return null;
}

function sportsExecutionBlocked(candidate: Candidate): string | null {
  if (!isSportsCandidate(candidate)) return null;
  if (!ALLOW_SPORTS_LIVE_EXECUTION) {
    return "sports live execution disabled: CLOB FAK pairs are not atomic and can leave naked inventory";
  }
  const entryBlock = sportsEntryBlocked(candidate);
  if (entryBlock) return entryBlock;
  const maxEntryLeg = Math.max(candidate.broad.yesBook.ask, candidate.narrow.noBook.ask);
  const effectiveLegCap = sportsEffectiveMaxEntryLegPrice(candidate, SPORTS_MAX_ENTRY_LEG_PRICE);
  if (effectiveLegCap > 0 && maxEntryLeg + EPSILON >= effectiveLegCap) {
    return `sports max entry leg price exceeded maxLeg=${maxEntryLeg.toFixed(4)} cap=${effectiveLegCap.toFixed(4)}`;
  }
  const narrowYesBid = Math.max(0, Math.min(1, 1 - candidate.narrow.noBook.ask));
  if (candidate.asset === "SOCCER") {
    const soccerMinNarrowYesBid = soccerEffectiveMinNarrowYesBid(candidate);
    if (soccerMinNarrowYesBid > 0 && narrowYesBid + EPSILON < soccerMinNarrowYesBid) {
      return `soccer narrow yes bid below live band bid=${narrowYesBid.toFixed(4)} min=${soccerMinNarrowYesBid.toFixed(4)}`;
    }
    if (SOCCER_MAX_NARROW_YES_BID > 0 && narrowYesBid - EPSILON > SOCCER_MAX_NARROW_YES_BID) {
      return `soccer narrow yes bid above live band bid=${narrowYesBid.toFixed(4)} max=${SOCCER_MAX_NARROW_YES_BID.toFixed(4)}`;
    }
  }
  if (candidate.asset === "MLB" && MLB_MIN_NARROW_YES_BID > 0 && narrowYesBid + EPSILON < MLB_MIN_NARROW_YES_BID) {
    return `mlb narrow yes bid below live band bid=${narrowYesBid.toFixed(4)} min=${MLB_MIN_NARROW_YES_BID.toFixed(4)}`;
  }
  const bestSeenBlock = soccerBestSeenCostBlock(candidate);
  if (bestSeenBlock) return bestSeenBlock;
  if (ENABLE_NBA_BATCH_EXECUTION) return null;
  if (ALLOW_NBA_NON_ATOMIC_EXECUTION) return null;
  return "NBA requires batched/tightly-coupled two-leg execution; separate FAK legs can leave naked inventory";
}

function packageSlug(packageId: string | undefined): string | null {
  if (!packageId) return null;
  const marker = packageId.indexOf("::");
  return marker >= 0 ? packageId.slice(0, marker) : null;
}

function isNbaSlug(slug: string | null | undefined): boolean {
  return !!slug && (slug.startsWith("nba-") || slug.includes("-nba-"));
}

function isSportsSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return isNbaSlug(slug)
    || slug.startsWith("fifwc-")
    || slug.startsWith("mls-")
    || slug.startsWith("mlb-")
    || slug.includes("soccer")
    || slug.includes("world-cup")
    || slug.includes("fifa")
    || slug.includes("uefa");
}

function isSportsAsset(asset: string | undefined): boolean {
  return ["NBA", "SOCCER", "MLB"].includes((asset ?? "").toUpperCase());
}

function packageEndMs(row: LivePackage): number | null {
  const raw = row.settlementWindow?.endDate ?? null;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function orphanEndMs(row: Orphan): number | null {
  if (!row.endDate) return null;
  const t = Date.parse(row.endDate);
  return Number.isFinite(t) ? t : null;
}

function archiveFileForNow(now: Date): string {
  return join(LEDGER_ARCHIVE_DIR, `polymarket-sports-${now.toISOString().slice(0, 10)}.json`);
}

function appendArchiveSnapshot(entry: unknown) {
  mkdirSync(LEDGER_ARCHIVE_DIR, { recursive: true });
  appendJsonArray(archiveFileForNow(new Date()), [entry]);
}

function archiveStaleNbaLedgers() {
  const nowMs = Date.now();
  const cutoffMs = nowMs - NBA_LEDGER_ARCHIVE_GRACE_MS;
  const packagesRows = readJsonArray<LivePackage>(PACKAGES_PATH);
  const ordersRows = readJsonArray<LiveOrder>(ORDERS_PATH);
  const orphanRows = readJsonArray<Orphan>(ORPHANS_PATH);

  const activeNbaOrphanSlugs = new Set<string>();
  for (const row of orphanRows) {
    if (row.status !== "completing") continue;
    const slug = row.eventSlug || packageSlug(row.packageId);
    if (slug && (isSportsAsset(row.asset) || isSportsSlug(slug))) activeNbaOrphanSlugs.add(slug);
  }

  const staleSlugs = new Set<string>();
  for (const row of packagesRows) {
    const slug = row.eventSlug || packageSlug(row.packageId);
    if (!slug || activeNbaOrphanSlugs.has(slug)) continue;
    if (!isSportsAsset(row.asset) && !isSportsSlug(slug)) continue;
    const endMs = packageEndMs(row);
    if (endMs !== null && endMs <= cutoffMs) staleSlugs.add(slug);
  }
  for (const row of orphanRows) {
    const slug = row.eventSlug || packageSlug(row.packageId);
    if (!slug || activeNbaOrphanSlugs.has(slug)) continue;
    if (!isSportsAsset(row.asset) && !isSportsSlug(slug)) continue;
    const endMs = orphanEndMs(row);
    if (endMs !== null && endMs <= cutoffMs) staleSlugs.add(slug);
  }
  if (staleSlugs.size === 0) return;

  const belongsToStaleSlug = (packageId: string | undefined, eventSlug?: string) => {
    const slug = eventSlug || packageSlug(packageId);
    return !!slug && staleSlugs.has(slug);
  };
  const archivedPackages = packagesRows.filter((row) => belongsToStaleSlug(row.packageId, row.eventSlug));
  const archivedOrders = ordersRows.filter((row) => belongsToStaleSlug(row.packageId));
  const archivedOrphans = orphanRows.filter((row) => belongsToStaleSlug(row.packageId, row.eventSlug));
  if (!archivedPackages.length && !archivedOrders.length && !archivedOrphans.length) return;

  appendArchiveSnapshot({
    archivedAt: new Date(nowMs).toISOString(),
    kind: "sports_resolved_event_live_ledger_archive",
    eventSlugs: [...staleSlugs].sort(),
    counts: {
      packages: archivedPackages.length,
      orders: archivedOrders.length,
      orphans: archivedOrphans.length,
    },
    packages: archivedPackages,
    orders: archivedOrders,
    orphans: archivedOrphans,
  });

  writeJsonArray(PACKAGES_PATH, packagesRows.filter((row) => !belongsToStaleSlug(row.packageId, row.eventSlug)));
  writeJsonArray(ORDERS_PATH, ordersRows.filter((row) => !belongsToStaleSlug(row.packageId)));
  const remainingOrphans = orphanRows.filter((row) => !belongsToStaleSlug(row.packageId, row.eventSlug));
  writeJsonArray(ORPHANS_PATH, remainingOrphans);
  for (const row of archivedOrphans) orphans.delete(row.id);
  for (const slug of staleSlugs) clearPausedEvent(slug);
  log(`archived stale sports ledgers slugs=${[...staleSlugs].sort().join(",")} packages=${archivedPackages.length} orders=${archivedOrders.length} orphans=${archivedOrphans.length}`);
}

function isJuneExpiryCandidate(candidate: Candidate): boolean {
  const dates = [candidate.broad.endDate, candidate.narrow.endDate].filter(Boolean) as string[];
  return dates.some((date) => /^2026-06-/.test(date));
}

function juneBreakevenMaxDistance(asset: string): number | null {
  if (["GOLD", "SILVER"].includes(asset)) return JUNE_BREAKEVEN_COMMODITY_MAX_DISTANCE;
  if (["BTC", "ETH", "SOL", "HYPE"].includes(asset)) return JUNE_BREAKEVEN_CRYPTO_MAX_DISTANCE;
  return null;
}

function isJuneBreakevenCandidate(candidate: Candidate): boolean {
  return isJuneExpiryCandidate(candidate)
    && candidate.lockedEdge <= JUNE_BREAKEVEN_EPSILON
    && candidate.packageCost + EPSILON >= 1;
}

function juneBreakevenRangeBlock(candidate: Candidate): string | null {
  if (!isJuneBreakevenCandidate(candidate)) return null;
  const maxDistance = juneBreakevenMaxDistance(candidate.asset);
  if (maxDistance === null) return null;
  const spot = spotPrices.get(candidate.asset);
  if (!(spot && spot > 0)) return `june_breakeven_spot_unavailable asset=${candidate.asset}`;
  const broadDistance = Math.abs(candidate.broad.strike - spot) / spot;
  const narrowDistance = Math.abs(candidate.narrow.strike - spot) / spot;
  const worstDistance = Math.max(broadDistance, narrowDistance);
  if (worstDistance <= maxDistance + EPSILON) return null;
  return `june_breakeven_strike_too_far asset=${candidate.asset} spot=${spot.toFixed(2)} strikes=${candidate.broad.strike}/${candidate.narrow.strike} distance=${(worstDistance * 100).toFixed(1)}% max=${(maxDistance * 100).toFixed(1)}%`;
}

function minEdgeFor(candidate: Candidate): number {
  if (isSportsCandidate(candidate)) return SPORTS_MIN_EDGE;
  // June expiries are allowed at breakeven (cost <= 1.0000) to fish for middles.
  // Sizing/outlay rules remain exactly the normal daemon rules.
  if (isJuneExpiryCandidate(candidate)) return Number(process.env.ARB_DAEMON_JUNE_EXPIRY_MIN_EDGE ?? 0);
  return MIN_EDGE;
}

function minAvailableSharesFor(candidate: Candidate): number {
  return isSportsCandidate(candidate) ? SPORTS_MIN_AVAILABLE_SHARES : MIN_AVAILABLE_SHARES;
}

function maxSpreadFor(candidate: Candidate): number {
  return isSportsCandidate(candidate) ? SPORTS_MAX_SPREAD : MAX_SPREAD;
}

function depthReserveMultiplierFor(candidate: Candidate): number {
  const multiplier = isSportsCandidate(candidate) ? SPORTS_DEPTH_RESERVE_MULTIPLIER : NON_SPORTS_DEPTH_RESERVE_MULTIPLIER;
  return Math.max(1, multiplier);
}

function maxPairedSharesFor(candidate: Candidate): number {
  if (isSportsCandidate(candidate) && SPORTS_MAX_PAIRED_SHARES > 0) return SPORTS_MAX_PAIRED_SHARES;
  return Number.POSITIVE_INFINITY;
}

function costInRange(cost: number, range: CostRange): boolean {
  const aboveMin = range.includeMin ? cost + EPSILON >= range.min : cost > range.min + EPSILON;
  const belowMax = range.includeMax ? cost <= range.max + EPSILON : cost < range.max - EPSILON;
  return aboveMin && belowMax;
}

function sportsCostRangeBlock(candidate: Candidate): string | null {
  if (!isSportsCandidate(candidate) || SPORTS_ALLOWED_COST_RANGES.length === 0) return null;
  if (SPORTS_ALLOWED_COST_RANGES.some((range) => costInRange(candidate.packageCost, range))) return null;
  const allowed = SPORTS_ALLOWED_COST_RANGES.map((range) => range.label).join("|");
  return `sports_cost_range cost=${candidate.packageCost.toFixed(4)} allowed=${allowed}`;
}

function requiredDisplayedTouch(candidate: Candidate): number {
  // The reserve-shrunken execution size must still clear the exchange minimum,
  // so the displayed touch has to be at least minShares * reserve multiplier.
  // Touches that can only fit an exchange-min order with zero depth margin are
  // exactly the ones that produced uneven partial-fill orphans.
  const requiredTouch = Math.max(minAvailableSharesFor(candidate), requiredLiveMinShares(candidate) * depthReserveMultiplierFor(candidate));
  return requiredTouch <= maxPairedSharesFor(candidate) + EPSILON ? requiredTouch : Number.POSITIVE_INFINITY;
}

function executionSizingCandidate(candidate: Candidate): Candidate {
  const c = structuredClone(candidate);
  const reserveSize = Math.floor((candidate.availableSize / depthReserveMultiplierFor(candidate)) * 100) / 100;
  c.availableSize = Math.max(0, Math.min(reserveSize, maxPairedSharesFor(candidate)));
  return c;
}

function withSportsExecutionPrices(candidate: Candidate, broadAsk: number, narrowNoAsk: number): Candidate {
  const c = structuredClone(candidate);
  c.broad.yesBook.ask = Math.min(0.99, Math.ceil((broadAsk + SPORTS_PRICE_SLIPPAGE) * 1000) / 1000);
  c.narrow.noBook.ask = Math.min(0.99, Math.ceil((narrowNoAsk + SPORTS_PRICE_SLIPPAGE) * 1000) / 1000);
  c.packageCost = c.broad.yesBook.ask + c.narrow.noBook.ask;
  c.lockedEdge = 1 - c.packageCost;
  c.availableSize = Math.min(c.broad.yesBook.askSize, c.narrow.noBook.askSize);
  c.maxSpread = Math.max(c.broad.yesBook.spread, c.narrow.yesBook.spread);
  c.foundAt = new Date().toISOString();
  return c;
}

// Highest tick-valid hedge price that keeps the realized pair cost within the
// completion edge floor (default: break-even, pair cost <= $1). A FAK still fills
// against the resting ask, so lifting the ceiling above the stale snapshot ask
// only widens the band in which a reprice completes the pair instead of orphaning
// the cheap leg — it never makes us pay above break-even. Falls back to the
// snapshot ask when disabled or when the cheap fill price is unknown.
function sportsHedgeCompletionPrice(snapshotAsk: number, cheapAvgFill: number): number {
  if (!SPORTS_HEDGE_BREAKEVEN_FILL) return snapshotAsk;
  if (!Number.isFinite(cheapAvgFill) || cheapAvgFill <= 0) return snapshotAsk;
  const ceiling = Math.floor((1 - cheapAvgFill - SPORTS_HEDGE_COMPLETION_MIN_EDGE) * 1000) / 1000;
  const limit = Math.max(snapshotAsk, ceiling);
  return Math.min(0.99, Math.max(0.001, limit));
}

// Warm the CLOB client's per-token tick-size + fee-rate caches so a subsequent
// createOrder/postOrder is all cache hits (no cold metadata round-trips between
// legs). Best-effort: any failure falls back to the lazy fetch inside postFakBuy.
async function prewarmOrderMetadata(client: Clob, tokenIds: string[]): Promise<number> {
  if (!SPORTS_PREWARM_ORDER_META) return 0;
  const started = Date.now();
  const ids = tokenIds.filter(Boolean);
  try {
    await Promise.all([
      ...ids.map((id) => client.getTickSize(id).catch(() => undefined)),
      ...ids.map((id) => client.getFeeRateBps(id).catch(() => undefined)),
    ]);
  } catch {
    // Ignore: postFakBuy will lazily fetch whatever is missing.
  }
  return Date.now() - started;
}

async function freshSportsCandidate(candidate: Candidate): Promise<Candidate> {
  const [broadYes, narrowNo, narrowYes] = await Promise.all([
    fetchBook(arbConfig, candidate.broad.yesTokenId),
    fetchBook(arbConfig, candidate.narrow.noTokenId),
    fetchBook(arbConfig, candidate.narrow.yesTokenId),
  ]);
  const c = structuredClone(candidate);
  c.broad.yesBook = broadYes;
  c.narrow.noBook = narrowNo;
  c.narrow.yesBook = narrowYes;
  return withSportsExecutionPrices(c, broadYes.ask, narrowNo.ask);
}

function requiredLiveMinShares(candidate: Candidate): number {
  const broadNotionalShares = candidate.broad.yesBook.ask > 0
    ? Math.ceil((MIN_MARKETABLE_BUY_USD / candidate.broad.yesBook.ask) * 100) / 100
    : Number.POSITIVE_INFINITY;
  const narrowNotionalShares = candidate.narrow.noBook.ask > 0
    ? Math.ceil((MIN_MARKETABLE_BUY_USD / candidate.narrow.noBook.ask) * 100) / 100
    : Number.POSITIVE_INFINITY;
  return Math.max(
    MIN_ORDER_SHARES,
    candidate.broad.yesBook.minOrderSize,
    candidate.narrow.noBook.minOrderSize,
    broadNotionalShares,
    narrowNotionalShares,
  );
}

function passesDynamicGate(candidate: Candidate): boolean {
  if (candidate.lockedEdge + EPSILON < minEdgeFor(candidate)) return false;
  if (candidate.maxSpread - EPSILON > maxSpreadFor(candidate)) return false;
  if (candidate.availableSize + EPSILON < requiredDisplayedTouch(candidate)) return false;
  if (sportsCostRangeBlock(candidate)) return false;
  if (farDatedExecutionBlock(candidate)) return false;
  if (juneBreakevenRangeBlock(candidate)) return false;
  return true;
}

type SportsStrategyGate = ReturnType<typeof evaluateSportsStrategy>;

function strategySummary(decision: SportsStrategyGate) {
  return {
    sportId: decision.adapter?.sportId ?? "UNKNOWN",
    marketType: decision.marketType,
    lineFamily: decision.lineFamily,
    middleWidth: decision.middleWidth,
    costBucket: decision.costBucket,
    comparisonGroup: decision.comparisonGroup,
    liveEligible: decision.liveEligible,
    shadowEligible: decision.shadowEligible,
    shadowPurpose: decision.shadowPurpose,
    gateFailures: decision.gateFailures,
  };
}

function strictLiveStrategyFailures(decision: SportsStrategyGate): string[] {
  return decision.gateFailures.filter((failure) =>
    failure.startsWith("soccer_")
    || failure.startsWith("mlb_")
    || failure === "unsupported_sport"
    || failure.startsWith("adapter_")
  );
}

function sportsStrategyGate(candidate: Candidate): { decision: SportsStrategyGate; reason: string | null } {
  const decision = evaluateSportsStrategy(candidate);
  const strategyFailures = strictLiveStrategyFailures(decision);
  if (!ENFORCE_SPORTS_STRATEGY_LIVE || !isSportsCandidate(candidate) || strategyFailures.length === 0) {
    return { decision, reason: null };
  }
  return { decision, reason: `strict_strategy_gate_failed:${strategyFailures.join("+")}` };
}

function liveEligibleSoccerCandidate(pkg: WatchPackage): Candidate | null {
  const legs = liveLegs(pkg);
  if (!legs) return null;
  const candidate = liveCandidate(pkg.base, legs);
  if (candidate.asset !== "SOCCER") return null;
  recordSoccerEventShapeCost(candidate);
  if (!passesDynamicGate(candidate)) return null;
  if (sportsStrategyGate(candidate).reason) return null;
  if (sportsExecutionBlocked(candidate)) return null;
  return candidate;
}

function scoredLiveEligibleSoccerOnEvent(eventSlug: string): ScoredWatchPackage[] {
  const out: ScoredWatchPackage[] = [];
  for (const [key, pkg] of packages) {
    if (pkg.base.eventSlug !== eventSlug) continue;
    const candidate = liveEligibleSoccerCandidate(pkg);
    if (!candidate) continue;
    out.push({ key, candidate });
  }
  return out;
}

function soccerCheaperPackageBlock(pkg: WatchPackage, candidate: Candidate): string | null {
  if (!SOCCER_PREFER_CHEAPEST_EVENT_PACKAGE || candidate.asset !== "SOCCER") return null;
  const defer = shouldDeferSoccerPackage(candidate, pkg.key, scoredLiveEligibleSoccerOnEvent(candidate.eventSlug));
  if (!defer) return null;
  return `soccer_cheaper_event_package event=${candidate.eventSlug} cost=${candidate.packageCost.toFixed(4)} cheaper=${defer.cheaperKey}@${defer.cheaperCost.toFixed(4)}`;
}

function recordNearMiss(candidate: Candidate) {
  nearMissObservations += 1;
  const minShares = requiredDisplayedTouch(candidate);
  const sample: NearMissSample = {
    observedAt: new Date().toISOString(),
    packageId: candidate.packageId,
    eventSlug: candidate.eventSlug,
    asset: candidate.asset,
    eventTitle: candidate.eventTitle,
    direction: candidate.direction,
    ladderKey: candidate.broad.ladderKey,
    broadMarketId: candidate.broad.marketId,
    broadQuestion: candidate.broad.question,
    broadStrike: candidate.broad.strike,
    broadYesTokenId: candidate.broad.yesTokenId,
    narrowMarketId: candidate.narrow.marketId,
    narrowQuestion: candidate.narrow.question,
    narrowStrike: candidate.narrow.strike,
    narrowYesTokenId: candidate.narrow.yesTokenId,
    narrowNoTokenId: candidate.narrow.noTokenId,
    broadEndDate: candidate.broad.endDate,
    narrowEndDate: candidate.narrow.endDate,
    cost: candidate.packageCost,
    edge: candidate.lockedEdge,
    availableSize: candidate.availableSize,
    broadYesAsk: candidate.broad.yesBook.ask,
    broadYesAskSize: candidate.broad.yesBook.askSize,
    narrowNoAsk: candidate.narrow.noBook.ask,
    narrowNoAskSize: candidate.narrow.noBook.askSize,
    maxSpread: candidate.maxSpread,
    minShares,
    farDatedBlock: farDatedExecutionBlock(candidate),
    rangeBlock: sportsCostRangeBlock(candidate) ?? juneBreakevenRangeBlock(candidate),
    edgeOk: candidate.lockedEdge + EPSILON >= minEdgeFor(candidate),
    spreadOk: candidate.maxSpread - EPSILON <= maxSpreadFor(candidate),
    sizeOk: candidate.availableSize + EPSILON >= minShares,
    executableGate: candidate.lockedEdge + EPSILON >= minEdgeFor(candidate)
      && candidate.maxSpread - EPSILON <= maxSpreadFor(candidate)
      && candidate.availableSize + EPSILON >= minShares
      && !sportsCostRangeBlock(candidate)
      && !farDatedExecutionBlock(candidate)
      && !juneBreakevenRangeBlock(candidate),
  };
  const prev = nearMissBestByPackage.get(candidate.packageId);
  if (!prev || sample.cost < prev.cost) nearMissBestByPackage.set(candidate.packageId, sample);
}

function blockersForNearMiss(sample: NearMissSample): string[] {
  return [
    sample.edgeOk ? "" : "edge",
    sample.spreadOk ? "" : "spread",
    sample.sizeOk ? "" : "size",
    sample.farDatedBlock ? "far_dated" : "",
    sample.rangeBlock ? sample.rangeBlock.split(" ")[0] : "",
  ].filter(Boolean);
}

function isTrueMiddleSample(sample: NearMissSample): boolean {
  return sample.broadMarketId !== sample.narrowMarketId
    && sample.broadQuestion !== sample.narrowQuestion
    && sample.broadEndDate === sample.narrowEndDate
    && sample.broadStrike !== sample.narrowStrike;
}

function middleCondition(sample: NearMissSample): string {
  const low = Math.min(sample.broadStrike, sample.narrowStrike);
  const high = Math.max(sample.broadStrike, sample.narrowStrike);
  if (sample.direction === "above") return `underlying > ${low} and <= ${high}`;
  return `underlying <= ${high} and > ${low}`;
}

function appendJsonl(path: string, rows: unknown[]) {
  if (!rows.length) return;
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function captureCandidateFields(candidate: Candidate) {
  const minShares = requiredDisplayedTouch(candidate);
  const farDatedBlock = farDatedExecutionBlock(candidate);
  const rangeBlock = juneBreakevenRangeBlock(candidate);
  const strategy = evaluateSportsStrategy(candidate);
  const blockers = [
    candidate.lockedEdge + EPSILON >= minEdgeFor(candidate) ? "" : "edge",
    candidate.maxSpread - EPSILON <= maxSpreadFor(candidate) ? "" : "spread",
    candidate.availableSize + EPSILON >= minShares ? "" : "size",
    farDatedBlock ? "far_dated" : "",
    rangeBlock ? "june_range" : "",
  ].filter(Boolean);
  return {
    packageId: candidate.packageId,
    eventSlug: candidate.eventSlug,
    eventTitle: candidate.eventTitle,
    asset: candidate.asset,
    direction: candidate.direction,
    ladderKey: candidate.broad.ladderKey,
    middleCondition: middleCondition({
      direction: candidate.direction,
      broadStrike: candidate.broad.strike,
      narrowStrike: candidate.narrow.strike,
    } as NearMissSample),
    cost: candidate.packageCost,
    edge: candidate.lockedEdge,
    availableSize: candidate.availableSize,
    maxSpread: candidate.maxSpread,
    minShares,
    blockers,
    executableGate: blockers.length === 0,
    farDatedBlock,
    rangeBlock,
    strategy: strategySummary(strategy),
    broad: {
      marketId: candidate.broad.marketId,
      question: candidate.broad.question,
      strike: candidate.broad.strike,
      endDate: candidate.broad.endDate,
      yesTokenId: candidate.broad.yesTokenId,
      yesAsk: candidate.broad.yesBook.ask,
      yesAskSize: candidate.broad.yesBook.askSize,
      yesSpread: candidate.broad.yesBook.spread,
      minOrderSize: candidate.broad.yesBook.minOrderSize,
    },
    narrow: {
      marketId: candidate.narrow.marketId,
      question: candidate.narrow.question,
      strike: candidate.narrow.strike,
      endDate: candidate.narrow.endDate,
      yesTokenId: candidate.narrow.yesTokenId,
      noTokenId: candidate.narrow.noTokenId,
      noAsk: candidate.narrow.noBook.ask,
      noAskSize: candidate.narrow.noBook.askSize,
      noSpread: candidate.narrow.yesBook.spread,
      minOrderSize: candidate.narrow.noBook.minOrderSize,
    },
  };
}

function shouldCaptureCandidate(candidate: Candidate): boolean {
  return isTrueMiddleCandidate(candidate)
    && candidate.packageCost + EPSILON >= CAPTURE_AUDIT_MIN_COST
    && candidate.packageCost <= CAPTURE_AUDIT_MAX_COST + EPSILON;
}

function beginCapture(candidate: Candidate, executionTokens: string[]): CaptureContext | null {
  if (!shouldCaptureCandidate(candidate)) return null;
  const startedMs = Date.now();
  return {
    captureId: `${candidate.packageId}-${startedMs}`,
    startedMs,
    startedAt: new Date(startedMs).toISOString(),
    wsCandidate: structuredClone(candidate),
    executionTokens,
  };
}

function maybeAppendCaptureShadowLedger(ctx: CaptureContext, extra: Record<string, unknown>) {
  try {
    const decision = evaluateSportsStrategy(ctx.wsCandidate);
    if (!decision.shadowEligible && !decision.liveEligible) return;
    const sizing = ctx.sizing;
    const sizedCost = typeof sizing?.cost === "number" ? sizing.cost : ctx.wsCandidate.packageCost;
    const sizedShares = typeof sizing?.shares === "number" ? sizing.shares : ctx.wsCandidate.availableSize;
    const candidate = { ...ctx.wsCandidate, packageCost: sizedCost, availableSize: sizedShares };
    const targetUsd = Math.min(MAX_PACKAGE_USD, sizedCost * sizedShares);
    appendShadowPackage(packageFromCandidate({
      candidate,
      decision,
      mode: "shadow",
      targetUsd,
      maxPackageUsd: MAX_PACKAGE_USD,
      metadataSnapshotId: `capture:${ctx.captureId}`,
    }));
  } catch (err) {
    log(`shadow ledger append failed package=${ctx.wsCandidate.packageId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function emitCapture(
  ctx: CaptureContext | null,
  terminalStatus: CaptureTerminalStatus,
  reason: string,
  extra: Record<string, unknown> = {},
) {
  if (!ctx) return;
  const now = Date.now();
  if (terminalStatus !== "submitted_result" && terminalStatus !== "execution_error") {
    const throttleKey = `${ctx.wsCandidate.packageId}:${terminalStatus}:${reason}`;
    const last = captureAuditLastAt.get(throttleKey) ?? 0;
    if (now - last < CAPTURE_AUDIT_MIN_INTERVAL_MS) return;
    captureAuditLastAt.set(throttleKey, now);
  }
  const terminalAt = new Date().toISOString();
  appendJsonl(CAPTURE_AUDIT_PATH, [{
    schemaVersion: 1,
    captureId: ctx.captureId,
    observedAt: ctx.startedAt,
    terminalAt,
    elapsedMs: now - ctx.startedMs,
    terminalStatus,
    reason,
    executionTokens: ctx.executionTokens,
    ws: captureCandidateFields(ctx.wsCandidate),
    preflight: ctx.preflight,
    sizing: ctx.sizing,
    execution: ctx.execution,
    ...extra,
  }]);
  if (terminalStatus === "shadow_would_submit") {
    maybeAppendCaptureShadowLedger(ctx, extra);
  }
}

type ShadowCaptureOptions = {
  reason?: string;
  strategyDecision?: SportsStrategyGate;
  abTestArm?: "coarse_shadow" | "legacy_shadow";
};

async function emitShadowCapture(pkg: WatchPackage, candidate: Candidate, options: ShadowCaptureOptions = {}) {
  const executionTokens = [pkg.broadYesToken, pkg.narrowNoToken].filter(Boolean);
  const ctx = beginCapture(candidate, executionTokens);
  if (!ctx) return;
  const preflightThrottleKey = `shadow-preflight:${pkg.key}`;
  const now = Date.now();
  const lastPreflight = captureAuditLastAt.get(preflightThrottleKey) ?? 0;
  if (now - lastPreflight < CAPTURE_AUDIT_MIN_INTERVAL_MS) return;
  if (shadowCaptureInFlight.has(pkg.key)) return;
  captureAuditLastAt.set(preflightThrottleKey, now);
  shadowCaptureInFlight.add(pkg.key);
  try {
    let c = candidate;
    const initialFields = captureCandidateFields(candidate);
    const hardInitialBlock = sportsExecutionBlocked(candidate)
      ?? farDatedExecutionBlock(candidate)
      ?? juneBreakevenRangeBlock(candidate);
    if (hardInitialBlock) {
      const strategy = strategySummary(options.strategyDecision ?? evaluateSportsStrategy(candidate));
      emitCapture(ctx, "shadow_gate_blocked", hardInitialBlock, {
        shadow: true,
        wouldTrade: false,
        abTestArm: options.abTestArm ?? "legacy_shadow",
        shadowReason: options.reason,
        strategy,
        liveGateBlockers: initialFields.blockers,
        note: "shadow-only capture: hard execution block; no order was submitted",
      });
      return;
    }

    if (isSportsCandidate(c)) {
      const preflightStartedAt = Date.now();
      try {
        c = await freshSportsCandidate(c);
      } catch (err: any) {
        const fetchMs = Date.now() - preflightStartedAt;
        ctx.preflight = {
          status: "failed",
          fetchMs,
          error: err?.message ?? String(err),
        };
        const strategy = strategySummary(options.strategyDecision ?? evaluateSportsStrategy(c));
        emitCapture(ctx, "shadow_preflight_failed", err?.message ?? String(err), {
          shadow: true,
          wouldTrade: false,
          abTestArm: options.abTestArm ?? "legacy_shadow",
          shadowReason: options.reason,
          strategy,
          note: "shadow-only capture: fresh sports book failed; no order was submitted",
        });
        return;
      }
      const fetchMs = Date.now() - preflightStartedAt;
      ctx.preflight = {
        status: passesDynamicGate(c) ? "passed_live_gate" : "failed_live_gate",
        fetchMs,
        fresh: captureCandidateFields(c),
      };
    } else {
      ctx.preflight = {
        status: passesDynamicGate(c) ? "ws_passed_live_gate" : "ws_failed_live_gate",
        fetchMs: 0,
        fresh: captureCandidateFields(c),
      };
    }

    const freshFields = captureCandidateFields(c);
    const strategyDecision = options.strategyDecision ?? evaluateSportsStrategy(c);
    const strategy = strategySummary(strategyDecision);
    const hardFreshBlock = farDatedExecutionBlock(c) ?? juneBreakevenRangeBlock(c);
    if (hardFreshBlock) {
      emitCapture(ctx, "shadow_gate_blocked", hardFreshBlock, {
        shadow: true,
        wouldTrade: false,
        abTestArm: options.abTestArm ?? "legacy_shadow",
        strategy,
        liveGateBlockers: freshFields.blockers,
        note: "shadow-only capture: hard execution block after fresh book; no order was submitted",
      });
      return;
    }

    const packageRows = readJsonArray<LivePackage>(PACKAGES_PATH);
    const executionCandidate = executionSizingCandidate(c);
    const spendableUsd = spendableUsdAfterReservations();
    const sized = sizeForCandidate(
      executionCandidate,
      packageRows,
      sizingSpendableUsd(spendableUsd) * budgetFactorForCandidate(executionCandidate),
    );
    const reservedUsd = reservedUsdForSized(sized.cost);
    const balanceHeadroomReason = Number.isFinite(spendableUsd) && reservedUsd > spendableUsd + EPSILON
      ? `reserved=$${reservedUsd.toFixed(4)} spendable=$${spendableUsd.toFixed(4)}`
      : "";
    ctx.sizing = {
      stage: "shadow",
      shares: sized.shares,
      cost: sized.cost,
      reason: sized.reason || balanceHeadroomReason || "",
      spendableUsd,
      reservedUsd,
    };
    if (sized.reason || balanceHeadroomReason) {
      emitCapture(ctx, "shadow_sizing_rejected", sized.reason || balanceHeadroomReason, {
        shadow: true,
        wouldTrade: false,
        abTestArm: options.abTestArm ?? "legacy_shadow",
        shadowReason: options.reason,
        strategy,
        liveGateBlockers: freshFields.blockers,
        note: "shadow-only capture: candidate was not sizable under current caps/balance; no order was submitted",
      });
      return;
    }

    emitCapture(ctx, "shadow_would_submit", options.reason ?? "shadow candidate passed fresh preflight and sizing", {
      shadow: true,
      wouldTrade: false,
      abTestArm: options.abTestArm ?? "legacy_shadow",
      shadowReason: options.reason,
      strategy,
      liveGateBlockers: freshFields.blockers,
      executableIfGateRelaxed: freshFields.blockers.every((blocker) => blocker === "edge"),
      note: "shadow-only capture: no order was submitted",
    });
  } finally {
    shadowCaptureInFlight.delete(pkg.key);
  }
}

function appendCandidateSnapshots(samples: NearMissSample[]) {
  const rows = samples
    .filter((sample) =>
      isTrueMiddleSample(sample)
      && sample.cost + EPSILON >= CANDIDATE_SNAPSHOT_MIN_COST
      && sample.cost <= CANDIDATE_SNAPSHOT_MAX_COST + EPSILON
    )
    .map((sample) => ({
      schemaVersion: 2,
      observedAt: sample.observedAt,
      packageId: sample.packageId,
      eventSlug: sample.eventSlug,
      eventTitle: sample.eventTitle,
      asset: sample.asset,
      direction: sample.direction,
      middleCondition: middleCondition(sample),
      ladderKey: sample.ladderKey,
      broad: {
        marketId: sample.broadMarketId,
        question: sample.broadQuestion,
        strike: sample.broadStrike,
        endDate: sample.broadEndDate,
        yesTokenId: sample.broadYesTokenId,
        yesAsk: sample.broadYesAsk,
        yesAskSize: sample.broadYesAskSize,
      },
      narrow: {
        marketId: sample.narrowMarketId,
        question: sample.narrowQuestion,
        strike: sample.narrowStrike,
        endDate: sample.narrowEndDate,
        yesTokenId: sample.narrowYesTokenId,
        noTokenId: sample.narrowNoTokenId,
        noAsk: sample.narrowNoAsk,
        noAskSize: sample.narrowNoAskSize,
      },
      packageCost: sample.cost,
      lockedEdge: sample.edge,
      availableSize: sample.availableSize,
      minShares: sample.minShares,
      maxSpread: sample.maxSpread,
      gate: {
        edgeOk: sample.edgeOk,
        spreadOk: sample.spreadOk,
        sizeOk: sample.sizeOk,
        executableGate: sample.executableGate,
        rangeBlock: sample.rangeBlock,
        farDatedBlock: sample.farDatedBlock,
        blockers: blockersForNearMiss(sample),
      },
    }));
  appendJsonl(CANDIDATE_SNAPSHOTS_PATH, rows);
}

function appendMiddleAuditSnapshots(samples: NearMissSample[]): number {
  const rows = samples
    .filter(isTrueMiddleSample)
    .map((sample) => ({
      schemaVersion: 1,
      observedAt: sample.observedAt,
      packageId: sample.packageId,
      eventSlug: sample.eventSlug,
      eventTitle: sample.eventTitle,
      asset: sample.asset,
      direction: sample.direction,
      ladderKey: sample.ladderKey,
      middleCondition: middleCondition(sample),
      broad: {
        marketId: sample.broadMarketId,
        question: sample.broadQuestion,
        strike: sample.broadStrike,
        endDate: sample.broadEndDate,
        yesTokenId: sample.broadYesTokenId,
        yesAsk: sample.broadYesAsk,
        yesAskSize: sample.broadYesAskSize,
      },
      narrow: {
        marketId: sample.narrowMarketId,
        question: sample.narrowQuestion,
        strike: sample.narrowStrike,
        endDate: sample.narrowEndDate,
        yesTokenId: sample.narrowYesTokenId,
        noTokenId: sample.narrowNoTokenId,
        noAsk: sample.narrowNoAsk,
        noAskSize: sample.narrowNoAskSize,
      },
      packageCost: sample.cost,
      lockedEdge: sample.edge,
      availableSize: sample.availableSize,
      minShares: sample.minShares,
      maxSpread: sample.maxSpread,
      gate: {
        edgeOk: sample.edgeOk,
        spreadOk: sample.spreadOk,
        sizeOk: sample.sizeOk,
        executableGate: sample.executableGate,
        rangeBlock: sample.rangeBlock,
        farDatedBlock: sample.farDatedBlock,
        blockers: blockersForNearMiss(sample),
      },
    }));
  appendJsonl(MIDDLE_AUDIT_PATH, rows);
  return rows.length;
}

function flushNearMissTelemetry() {
  const samples = [...nearMissBestByPackage.values()];
  if (nearMissObservations === 0 && samples.length === 0) return;
  const middleSamples = samples.filter(isTrueMiddleSample);

  const bucketParts = NEAR_MISS_BUCKETS.map((bucket) => {
    const count = middleSamples.filter((sample) => sample.cost <= bucket.cost + EPSILON).length;
    return `${bucket.label}:${count}`;
  });
  const near = middleSamples.filter((sample) => sample.cost <= NEAR_MISS_BUCKETS[NEAR_MISS_BUCKETS.length - 1].cost + EPSILON);
  const executable = middleSamples.filter((sample) => sample.executableGate).length;
  const edgeOk = near.filter((sample) => sample.edgeOk).length;
  const spreadOk = near.filter((sample) => sample.spreadOk).length;
  const sizeOk = near.filter((sample) => sample.sizeOk).length;
  const best = middleSamples
    .sort((a, b) => a.cost - b.cost)
    .slice(0, Math.max(1, NEAR_MISS_TOP_N))
    .map((sample) => {
      const blockers = blockersForNearMiss(sample).join("+") || "none";
      return `${sample.asset} ${sample.eventSlug} YES ${sample.broadStrike}/NO ${sample.narrowStrike} cost=${sample.cost.toFixed(4)} edge=${(sample.edge * 100).toFixed(3)}c size=${sample.availableSize.toFixed(2)}/${sample.minShares.toFixed(2)} spread=${sample.maxSpread.toFixed(4)} block=${blockers}`;
    });

  appendCandidateSnapshots(samples);
  const audited = appendMiddleAuditSnapshots(samples);
  const sportsPreflightAvgMs = sportsPreflightAttempts > 0
    ? sportsPreflightFetchMsTotal / sportsPreflightAttempts
    : 0;
  log(`near-miss telemetry intervalMs=${Date.now() - nearMissStartedAt} observations=${nearMissObservations} unique=${samples.length} middleUnique=${middleSamples.length} middleAudit=${audited} near<=1.005=${near.length} executableGate=${executable} ${bucketParts.join(" ")} nearPass edge=${edgeOk}/${near.length} spread=${spreadOk}/${near.length} size=${sizeOk}/${near.length} sportsPreflight attempts=${sportsPreflightAttempts} pass=${sportsPreflightPassed} reject=${sportsPreflightRejected} avgFetchMs=${sportsPreflightAvgMs.toFixed(0)} maxFetchMs=${sportsPreflightFetchMsMax} best=[${best.join(" | ")}]`);
  nearMissStartedAt = Date.now();
  nearMissObservations = 0;
  nearMissBestByPackage.clear();
  sportsPreflightAttempts = 0;
  sportsPreflightFetchMsTotal = 0;
  sportsPreflightFetchMsMax = 0;
  sportsPreflightPassed = 0;
  sportsPreflightRejected = 0;
}

// ─── Caps / safety ───

function perMinuteCapReached(): boolean {
  const cutoff = Date.now() - 60_000;
  while (submitTimestamps.length && submitTimestamps[0] < cutoff) submitTimestamps.shift();
  return submitTimestamps.length >= MAX_PER_MIN;
}

function lowBalance(): boolean {
  if (!balanceKnown) return false;
  return spendableUsdAfterReservations() < MAX_PACKAGE_USD;
}

function spendableUsdAfterReservations(): number {
  if (!balanceKnown) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(cachedFunderBalance, cachedFunderAllowance) - reservedSpendUsd);
}

function sizingSpendableUsd(spendableUsd: number): number {
  if (!Number.isFinite(spendableUsd)) return spendableUsd;
  return Math.max(0, (spendableUsd - BALANCE_HEADROOM_USD) / Math.max(1, BALANCE_HEADROOM_MULTIPLIER));
}

// Sports games and near-dated expiries settle in hours/days and recycle
// capital; far-dated ladders (Dec-2026 / before-2027) lock it for months.
// Far-dated packages may only tap a fraction of spendable cash so near-term
// opportunities keep 2:1 priority over slow capital.
const PRIORITY_NEAR_TERM_DAYS = Number(process.env.ARB_DAEMON_PRIORITY_NEAR_TERM_DAYS ?? 45);
const FAR_DATED_BUDGET_FACTOR = Number(process.env.ARB_DAEMON_FAR_DATED_BUDGET_FACTOR ?? 0.5);
const ALLOW_FAR_DATED_EXECUTION = process.env.ARB_DAEMON_ALLOW_FAR_DATED_EXECUTION === "1";

function isNearTermCandidate(candidate: Candidate): boolean {
  const ends = [candidate.broad.endDate, candidate.narrow.endDate]
    .map((value) => Date.parse(value ?? ""))
    .filter((ms) => Number.isFinite(ms));
  return ends.length > 0 && Math.max(...ends) - Date.now() <= PRIORITY_NEAR_TERM_DAYS * 86_400_000;
}

function farDatedExecutionBlock(candidate: Candidate): string | null {
  if (ALLOW_FAR_DATED_EXECUTION || isSportsCandidate(candidate) || isNearTermCandidate(candidate)) return null;
  const endDates = [candidate.broad.endDate, candidate.narrow.endDate].filter(Boolean).join("/");
  return `far_dated_execution_disabled asset=${candidate.asset} endDates=${endDates || "unknown"} strikes=${candidate.broad.strike}/${candidate.narrow.strike}`;
}

function budgetFactorForCandidate(candidate: Candidate): number {
  if (isSportsCandidate(candidate) || isNearTermCandidate(candidate)) return 1;
  return FAR_DATED_BUDGET_FACTOR;
}

function reservedUsdForSized(nominalCost: number): number {
  return nominalCost * Math.max(1, BALANCE_HEADROOM_MULTIPLIER) + BALANCE_HEADROOM_USD;
}

function pauseNewEntries(reason: string, details: Record<string, unknown> = {}) {
  if (!tradingPausedReason) {
    tradingPausedReason = reason;
    writeFileSync(PAUSE_PATH, JSON.stringify({
      pausedAt: new Date().toISOString(),
      reason,
      details,
    }, null, 2) + "\n");
    log(`PAUSED new entries: ${reason}`);
    return;
  }
  log(`new entries already paused: ${tradingPausedReason}; additional reason=${reason}`);
}

function loadPersistentPause() {
  if (!existsSync(PAUSE_PATH)) return;
  try {
    const row = JSON.parse(readFileSync(PAUSE_PATH, "utf8")) as { reason?: string };
    tradingPausedReason = row.reason || "persistent_pause_file_present";
    log(`persistent pause loaded: ${tradingPausedReason}`);
  } catch (err: any) {
    tradingPausedReason = "persistent_pause_file_unreadable";
    log(`persistent pause loaded with unreadable file: ${err?.message ?? String(err)}`);
  }
}

function persistPausedEvents() {
  writeFileSync(PAUSED_EVENTS_PATH, JSON.stringify([...pausedEvents.values()], null, 2) + "\n");
}

// Pause new entries for a SINGLE event (scoped halt). Idempotent; persisted so it
// survives restarts like the global pause. Other events/assets keep trading.
function pauseEventEntries(eventSlug: string, reason: string, details: Record<string, unknown> = {}) {
  if (!eventSlug) {
    // No event context — fall back to the global pause so we never silently skip a halt.
    pauseNewEntries(reason, details);
    return;
  }
  if (pausedEvents.has(eventSlug)) {
    log(`event already paused: ${eventSlug} (${pausedEvents.get(eventSlug)!.reason}); additional reason=${reason}`);
    return;
  }
  pausedEvents.set(eventSlug, { eventSlug, pausedAt: new Date().toISOString(), reason, details });
  persistPausedEvents();
  log(`PAUSED event ${eventSlug}: ${reason}`);
}

function loadPausedEvents() {
  if (!existsSync(PAUSED_EVENTS_PATH)) return;
  try {
    const rows = JSON.parse(readFileSync(PAUSED_EVENTS_PATH, "utf8")) as PausedEventEntry[];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.eventSlug) pausedEvents.set(row.eventSlug, row);
    }
    if (pausedEvents.size) log(`paused events loaded: ${[...pausedEvents.keys()].sort().join(",")}`);
  } catch (err: any) {
    log(`paused events load failed; ignoring file: ${err?.message ?? String(err)}`);
  }
}

function isEventPaused(eventSlug: string | undefined): string | null {
  if (!eventSlug) return null;
  return pausedEvents.get(eventSlug)?.reason ?? null;
}

// Drop a per-event pause (called when the event's ledgers are archived as stale,
// so resolved games never linger in the paused set).
function clearPausedEvent(eventSlug: string): boolean {
  if (!pausedEvents.delete(eventSlug)) return false;
  persistPausedEvents();
  log(`cleared paused event ${eventSlug} (ledgers archived / resolved)`);
  return true;
}

function loadQuarantine() {
  if (!existsSync(QUARANTINE_PATH)) return;
  try {
    const entries = JSON.parse(readFileSync(QUARANTINE_PATH, "utf8")) as QuarantineEntry[];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry.packageId) quarantinedPackages.add(entry.packageId);
      const tokenIds = Array.isArray(entry.tokenIds) ? entry.tokenIds : [];
      for (const tokenId of tokenIds) quarantinedTokens.add(tokenId);
    }
    log(`quarantine loaded: packages=${quarantinedPackages.size} tokens=${quarantinedTokens.size}`);
  } catch (err: any) {
    log(`quarantine load failed; ignoring quarantine file: ${err?.message ?? String(err)}`);
  }
}

function appendQuarantine(entry: QuarantineEntry) {
  const existing = existsSync(QUARANTINE_PATH)
    ? JSON.parse(readFileSync(QUARANTINE_PATH, "utf8")) as QuarantineEntry[]
    : [];
  const entries = Array.isArray(existing) ? existing : [];
  const already = entries.some((row) => row.packageId === entry.packageId);
  if (!already) {
    entries.push(entry);
    writeFileSync(QUARANTINE_PATH, JSON.stringify(entries, null, 2) + "\n");
  }
  quarantinedPackages.add(entry.packageId);
  for (const tokenId of entry.tokenIds) quarantinedTokens.add(tokenId);
  log(`QUARANTINED package=${entry.packageId} tokens=${entry.tokenIds.length} reason=${entry.reason}`);
}

function reloadQuarantineSets(entries: QuarantineEntry[]) {
  quarantinedPackages.clear();
  quarantinedTokens.clear();
  for (const entry of entries) {
    if (entry.packageId) quarantinedPackages.add(entry.packageId);
    for (const tokenId of Array.isArray(entry.tokenIds) ? entry.tokenIds : []) {
      quarantinedTokens.add(tokenId);
    }
  }
}

function quarantineEntryIsStale(entry: QuarantineEntry, packageRows: LivePackage[]): boolean {
  if (activeOrphans().some((o) => o.packageId === entry.packageId && o.shares > SPORTS_ORPHAN_DUST_SHARES)) {
    return false;
  }
  const row = packageRows.find((r) => r.packageId === entry.packageId);
  if (!row) return true;
  if (isFlatClosedPackage(row)) return true;
  if (isDaemonOpenPackage(row) || isCompletedPackagePosition(row)) return false;
  return true;
}

function pruneStaleQuarantine() {
  if (!existsSync(QUARANTINE_PATH)) return;
  let entries: QuarantineEntry[];
  try {
    entries = JSON.parse(readFileSync(QUARANTINE_PATH, "utf8")) as QuarantineEntry[];
  } catch (err: any) {
    log(`quarantine prune skipped: ${err?.message ?? String(err)}`);
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) return;
  const packageRows = readJsonArray<LivePackage>(PACKAGES_PATH);
  const kept: QuarantineEntry[] = [];
  const removed: string[] = [];
  for (const entry of entries) {
    if (quarantineEntryIsStale(entry, packageRows)) removed.push(entry.packageId);
    else kept.push(entry);
  }
  if (removed.length === 0) return;
  writeFileSync(QUARANTINE_PATH, JSON.stringify(kept, null, 2) + "\n");
  reloadQuarantineSets(kept);
  log(`quarantine pruned stale=${removed.length} remaining=${kept.length} removed=${removed.join(", ")}`);
}

function quarantinePackage(pkg: WatchPackage, c: Candidate, reason: string, details: Record<string, unknown> = {}) {
  appendQuarantine({
    quarantinedAt: new Date().toISOString(),
    reason,
    packageId: pkg.key,
    eventSlug: c.eventSlug,
    asset: c.asset,
    tokenIds: [pkg.broadYesToken, pkg.narrowNoToken].filter(Boolean),
    details,
  });
}

// ─── Fill signalling (User websocket) ───

function signalFill(tokenId: string) {
  const waiters = fillWaiters.get(tokenId);
  if (!waiters) return;
  for (const resolveFn of waiters) resolveFn();
  waiters.clear();
}

function waitForFill(tokenId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveFn) => {
    let set = fillWaiters.get(tokenId);
    if (!set) {
      set = new Set();
      fillWaiters.set(tokenId, set);
    }
    const done = () => {
      clearTimeout(timer);
      set!.delete(done);
      resolveFn();
    };
    const timer = setTimeout(done, timeoutMs);
    set.add(done);
  });
}

async function waitForTokenBalance(tokenId: string, minShares: number, timeoutMs: number): Promise<number> {
  const started = Date.now();
  let latest = await reconcileTokenBalance(reconcileAddress, tokenId);
  while (latest + EPSILON < minShares && Date.now() - started < timeoutMs) {
    await waitForFill(tokenId, Math.min(1_000, Math.max(100, timeoutMs - (Date.now() - started))));
    latest = await reconcileTokenBalance(reconcileAddress, tokenId);
  }
  return latest;
}

// ─── Execution ───

async function tryExecute(pkg: WatchPackage, legs: LiveLegs): Promise<void> {
  if (evaluatingPackages.has(pkg.key)) return;
  evaluatingPackages.add(pkg.key);
  try {
    await tryExecuteInner(pkg, legs);
  } finally {
    evaluatingPackages.delete(pkg.key);
  }
}

async function tryExecuteInner(pkg: WatchPackage, legs: LiveLegs): Promise<void> {
  const wsCandidate = liveCandidate(pkg.base, legs);
  const executionTokens = [pkg.broadYesToken, pkg.narrowNoToken].filter(Boolean);
  const capture = beginCapture(wsCandidate, executionTokens);
  if (tradingPausedReason) {
    emitCapture(capture, "trading_paused", tradingPausedReason);
    return;
  }
  const eventPauseReason = isEventPaused(pkg.base.eventSlug);
  if (eventPauseReason) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: event paused ${pkg.base.eventSlug} (${eventPauseReason})`);
    }
    emitCapture(capture, "event_paused", eventPauseReason);
    return;
  }
  if (inFlight.has(pkg.key) || alreadyOpen.has(pkg.key)) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: already open package/orphan before preflight`);
    }
    emitCapture(capture, "already_open", "already open package/orphan before preflight");
    return;
  }
  if (quarantinedPackages.has(pkg.key) || executionTokens.some((tokenId) => quarantinedTokens.has(tokenId))) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: quarantined large-naked-leg market/package`);
    }
    emitCapture(capture, "quarantined", "quarantined large-naked-leg market/package");
    return;
  }
  if (executionTokens.some((tokenId) => tokensInFlight.has(tokenId))) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: shared token already executing`);
    }
    emitCapture(capture, "shared_token_in_flight", "shared token already executing");
    return;
  }
  if (isSportsCandidate(pkg.base) && eventsInFlight.has(pkg.base.eventSlug)) {
    const now = Date.now();
    const last = lastSkipLogAt.get(`${pkg.key}:event_in_flight`) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(`${pkg.key}:event_in_flight`, now);
      log(`skip ${pkg.key}: sports event already executing ${pkg.base.eventSlug}`);
    }
    emitCapture(capture, "sports_event_in_flight", "sports event already executing");
    return;
  }
  // Structural watchlist bases use emptyBook placeholders (ask=0); live prices live on wsCandidate.
  const sportsBlock = sportsExecutionBlocked(wsCandidate);
  if (sportsBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: ${sportsBlock}`);
    }
    emitCapture(capture, "sports_blocked", sportsBlock);
    return;
  }
  const cheaperPackageBlock = soccerCheaperPackageBlock(pkg, wsCandidate);
  if (cheaperPackageBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(`${pkg.key}:cheaper_event`) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(`${pkg.key}:cheaper_event`, now);
      log(`skip ${pkg.key}: ${cheaperPackageBlock}`);
    }
    emitCapture(capture, "sports_blocked", cheaperPackageBlock);
    return;
  }
  if (perMinuteCapReached()) {
    emitCapture(capture, "per_minute_cap", "per-minute submission cap reached");
    return;
  }
  if (lowBalance()) {
    if (!pausedForLowBalanceLogged) {
      log(`paused: cached funder balance=${cachedFunderBalance.toFixed(4)} allowance=${cachedFunderAllowance.toFixed(2)} < package budget $${MAX_PACKAGE_USD}; scanning but skipping new entries until cash recycles`);
      pausedForLowBalanceLogged = true;
    }
    emitCapture(capture, "low_balance", `cached funder balance=${cachedFunderBalance.toFixed(4)} allowance=${cachedFunderAllowance.toFixed(2)} < package budget $${MAX_PACKAGE_USD}`);
    return;
  }

  const packageRows = readJsonArray<LivePackage>(PACKAGES_PATH);
  const openCount = daemonOpenPackageCount(packageRows);
  if (openCount >= MAX_OPEN_PACKAGES) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: max_open_packages open=${openCount} cap=${MAX_OPEN_PACKAGES}`);
    }
    emitCapture(capture, "max_open_packages", `max_open_packages open=${openCount} cap=${MAX_OPEN_PACKAGES}`);
    return;
  }
  const eventPreflightBlock = sportsEventExposureBlock(pkg.base, packageRows);
  if (eventPreflightBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(`${pkg.key}:event_cap`) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(`${pkg.key}:event_cap`, now);
      log(`skip ${pkg.key}: ${eventPreflightBlock}`);
    }
    emitCapture(capture, "sports_event_cap", eventPreflightBlock);
    return;
  }

  let c = wsCandidate;
  if (isSportsCandidate(c)) {
    const wsCandidate = c;
    const preflightStartedAt = Date.now();
    try {
      c = await freshSportsCandidate(c);
    } catch (err: any) {
      const fetchMs = Date.now() - preflightStartedAt;
      sportsPreflightAttempts += 1;
      sportsPreflightFetchMsTotal += fetchMs;
      sportsPreflightFetchMsMax = Math.max(sportsPreflightFetchMsMax, fetchMs);
      const now = Date.now();
      const last = lastSkipLogAt.get(pkg.key) ?? 0;
      if (now - last >= SKIP_LOG_THROTTLE_MS) {
        lastSkipLogAt.set(pkg.key, now);
        log(`skip ${pkg.key}: sports_preflight_failed fetchMs=${fetchMs} wsCost=${wsCandidate.packageCost.toFixed(4)} wsSpread=${wsCandidate.maxSpread.toFixed(4)} ${err?.message ?? String(err)}`);
      }
      if (capture) {
        capture.preflight = {
          status: "failed",
          fetchMs,
          error: err?.message ?? String(err),
        };
      }
      emitCapture(capture, "sports_preflight_failed", err?.message ?? String(err));
      return;
    }
    const fetchMs = Date.now() - preflightStartedAt;
    sportsPreflightAttempts += 1;
    sportsPreflightFetchMsTotal += fetchMs;
    sportsPreflightFetchMsMax = Math.max(sportsPreflightFetchMsMax, fetchMs);
    if (capture) {
      capture.preflight = {
        status: "pass_pending_gate",
        fetchMs,
        fresh: captureCandidateFields(c),
      };
    }
    if (!passesDynamicGate(c)) {
      sportsPreflightRejected += 1;
      const now = Date.now();
      const last = lastSkipLogAt.get(pkg.key) ?? 0;
      if (now - last >= SKIP_LOG_THROTTLE_MS) {
        lastSkipLogAt.set(pkg.key, now);
        const rangeBlock = juneBreakevenRangeBlock(c);
        log(`skip ${pkg.key}: sports_preflight_gate fetchMs=${fetchMs} wsCost=${wsCandidate.packageCost.toFixed(4)} wsSpread=${wsCandidate.maxSpread.toFixed(4)} freshCost=${c.packageCost.toFixed(4)} freshSpread=${c.maxSpread.toFixed(4)} edge=${(c.lockedEdge * 100).toFixed(2)}c size=${c.availableSize.toFixed(2)}${rangeBlock ? ` ${rangeBlock}` : ""}`);
      }
      if (capture?.preflight) capture.preflight = { ...capture.preflight, status: "rejected" };
      emitCapture(capture, "sports_preflight_rejected", "fresh sports candidate failed dynamic gate");
      return;
    }
    const strategyGate = sportsStrategyGate(c);
    if (strategyGate.reason) {
      sportsPreflightRejected += 1;
      const executionCandidate = executionSizingCandidate(c);
      const spendableUsd = spendableUsdAfterReservations();
      const shadowSized = sizeForCandidate(
        executionCandidate,
        packageRows,
        sizingSpendableUsd(spendableUsd) * budgetFactorForCandidate(executionCandidate),
      );
      if (capture) {
        capture.sizing = {
          stage: "shadow",
          shares: shadowSized.shares,
          cost: shadowSized.cost,
          reason: shadowSized.reason,
          spendableUsd,
        };
      }
      const now = Date.now();
      const last = lastSkipLogAt.get(`${pkg.key}:strategy`) ?? 0;
      if (now - last >= SKIP_LOG_THROTTLE_MS) {
        lastSkipLogAt.set(`${pkg.key}:strategy`, now);
        log(`shadow ${pkg.key}: fresh_${strategyGate.reason} fetchMs=${fetchMs} cost=${c.packageCost.toFixed(4)} strategy=${strategyGate.decision.comparisonGroup}`);
      }
      if (capture?.preflight) capture.preflight = { ...capture.preflight, status: "rejected_strategy" };
      emitCapture(
        capture,
        shadowSized.reason ? "shadow_sizing_rejected" : "shadow_would_submit",
        shadowSized.reason ?? strategyGate.reason,
        {
          shadow: true,
          wouldTrade: false,
          abTestArm: "coarse_shadow",
          shadowReason: strategyGate.reason,
          strategy: strategySummary(strategyGate.decision),
          liveGateBlockers: [`strategy:${strategyGate.decision.gateFailures.join("+") || "not_live_eligible"}`],
          note: "coarse-range A/B shadow: candidate passed coarse daemon gate but failed strict sports strategy; no order was submitted",
        },
      );
      return;
    }
    sportsPreflightPassed += 1;
    if (capture?.preflight) capture.preflight = { ...capture.preflight, status: "passed" };
    log(`sports_preflight_pass ${pkg.key}: fetchMs=${fetchMs} wsCost=${wsCandidate.packageCost.toFixed(4)} wsSpread=${wsCandidate.maxSpread.toFixed(4)} freshCost=${c.packageCost.toFixed(4)} freshSpread=${c.maxSpread.toFixed(4)} edge=${(c.lockedEdge * 100).toFixed(2)}c size=${c.availableSize.toFixed(2)}`);
  }
  const farDatedBlock = farDatedExecutionBlock(c);
  if (farDatedBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: ${farDatedBlock} edge=${(c.lockedEdge * 100).toFixed(2)}c cost=${c.packageCost.toFixed(4)}`);
    }
    emitCapture(capture, "far_dated_blocked", farDatedBlock);
    return;
  }
  const rangeBlock = juneBreakevenRangeBlock(c);
  if (rangeBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: ${rangeBlock} edge=${(c.lockedEdge * 100).toFixed(2)}c cost=${c.packageCost.toFixed(4)}`);
    }
    emitCapture(capture, "range_blocked", rangeBlock);
    return;
  }
  const executionCandidate = executionSizingCandidate(c);
  const spendableUsd = spendableUsdAfterReservations();
  const sized = sizeForCandidate(executionCandidate, packageRows, sizingSpendableUsd(spendableUsd) * budgetFactorForCandidate(executionCandidate));
  if (capture) {
    capture.sizing = {
      stage: "initial",
      shares: sized.shares,
      cost: sized.cost,
      reason: sized.reason,
      spendableUsd,
    };
  }
  if (sized.reason) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: ${sized.reason} shares=${sized.shares.toFixed(2)} cost=$${sized.cost.toFixed(4)}`);
    }
    emitCapture(capture, "sizing_rejected", sized.reason);
    return;
  }
  const eventSizedBlock = sportsEventExposureBlock(executionCandidate, packageRows, sized.cost);
  if (eventSizedBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(`${pkg.key}:event_sized_cap`) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(`${pkg.key}:event_sized_cap`, now);
      log(`skip ${pkg.key}: ${eventSizedBlock}`);
    }
    emitCapture(capture, "sports_event_cap", eventSizedBlock);
    return;
  }

  if (DRY_RUN) {
    log(`DRY_RUN arb ${pkg.key} edge=${(c.lockedEdge * 100).toFixed(2)}c size=${c.availableSize.toFixed(2)} shares=${sized.shares.toFixed(2)} cost=$${sized.cost.toFixed(4)}`);
    alreadyOpen.add(pkg.key); // avoid spamming the same package every tick in dry-run
    emitCapture(capture, "dry_run", "dry run; would execute", { dryRunSized: sized });
    return;
  }

  if (alreadyOpen.has(pkg.key) || inFlight.has(pkg.key) || executionTokens.some((tokenId) => tokensInFlight.has(tokenId))) {
    log(`skip ${pkg.key}: execution lock acquired by another tick after preflight`);
    emitCapture(capture, "post_preflight_lock", "execution lock acquired by another tick after preflight");
    return;
  }
  if (isSportsCandidate(executionCandidate) && eventsInFlight.has(executionCandidate.eventSlug)) {
    log(`skip ${pkg.key}: sports event lock acquired after preflight ${executionCandidate.eventSlug}`);
    emitCapture(capture, "post_preflight_event_lock", "sports event lock acquired after preflight");
    return;
  }
  await refreshBalance();
  const freshPackageRows = readJsonArray<LivePackage>(PACKAGES_PATH);
  refreshAlreadyOpen();
  if (alreadyOpen.has(pkg.key) || inFlight.has(pkg.key) || executionTokens.some((tokenId) => tokensInFlight.has(tokenId))) {
    log(`skip ${pkg.key}: blocked after fresh preflight (open package/orphan or shared token)`);
    emitCapture(capture, "post_refresh_lock", "blocked after balance refresh/open state refresh");
    return;
  }
  if (isSportsCandidate(executionCandidate) && eventsInFlight.has(executionCandidate.eventSlug)) {
    log(`skip ${pkg.key}: sports event lock acquired after balance refresh ${executionCandidate.eventSlug}`);
    emitCapture(capture, "post_refresh_event_lock", "sports event lock acquired after balance refresh");
    return;
  }
  const freshSpendableUsd = spendableUsdAfterReservations();
  const freshSized = sizeForCandidate(executionCandidate, freshPackageRows, sizingSpendableUsd(freshSpendableUsd) * budgetFactorForCandidate(executionCandidate));
  if (capture) {
    capture.sizing = {
      stage: "fresh",
      initial: capture.sizing,
      shares: freshSized.shares,
      cost: freshSized.cost,
      reason: freshSized.reason,
      spendableUsd: freshSpendableUsd,
    };
  }
  if (freshSized.reason) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: fresh_${freshSized.reason} shares=${freshSized.shares.toFixed(2)} cost=$${freshSized.cost.toFixed(4)} reserved=$${reservedSpendUsd.toFixed(4)} spendable=$${spendableUsdAfterReservations().toFixed(4)}`);
    }
    emitCapture(capture, "fresh_sizing_rejected", freshSized.reason);
    return;
  }
  const freshEventBlock = sportsEventExposureBlock(executionCandidate, freshPackageRows, freshSized.cost);
  if (freshEventBlock) {
    const now = Date.now();
    const last = lastSkipLogAt.get(`${pkg.key}:fresh_event_cap`) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(`${pkg.key}:fresh_event_cap`, now);
      log(`skip ${pkg.key}: ${freshEventBlock}`);
    }
    emitCapture(capture, "fresh_sports_event_cap", freshEventBlock);
    return;
  }
  const freshReservedUsd = reservedUsdForSized(freshSized.cost);
  if (Number.isFinite(freshSpendableUsd) && freshReservedUsd > freshSpendableUsd + EPSILON) {
    const now = Date.now();
    const last = lastSkipLogAt.get(pkg.key) ?? 0;
    if (now - last >= SKIP_LOG_THROTTLE_MS) {
      lastSkipLogAt.set(pkg.key, now);
      log(`skip ${pkg.key}: balance_headroom nominal=$${freshSized.cost.toFixed(4)} reserved=$${freshReservedUsd.toFixed(4)} spendable=$${freshSpendableUsd.toFixed(4)} shares=${freshSized.shares.toFixed(2)}`);
    }
    emitCapture(capture, "balance_headroom", `reserved=$${freshReservedUsd.toFixed(4)} spendable=$${freshSpendableUsd.toFixed(4)}`, { freshReservedUsd });
    return;
  }
  reservedSpendUsd += freshReservedUsd;
  alreadyOpen.add(pkg.key);
  inFlight.add(pkg.key);
  if (isSportsCandidate(executionCandidate)) eventsInFlight.add(executionCandidate.eventSlug);
  for (const tokenId of executionTokens) tokensInFlight.add(tokenId);
  submitTimestamps.push(Date.now());
  try {
    const quoteContext: ExecutionQuoteContext = {
      wsCost: wsCandidate.packageCost,
      freshCost: executionCandidate.packageCost,
      preflightFetchMs: typeof capture?.preflight?.fetchMs === "number"
        ? capture.preflight.fetchMs
        : undefined,
    };
    const result = await executeLive(pkg, executionCandidate, freshSized.shares, quoteContext);
    if (capture) capture.execution = result;
    emitCapture(capture, "submitted_result", result.recordStatus, {
      freshReservedUsd,
      abTestArm: isSportsCandidate(c) ? "strict_live" : "live",
      strategy: strategySummary(evaluateSportsStrategy(c)),
    });
  } catch (err: any) {
    log(`execute ${pkg.key} failed: ${err?.message ?? String(err)}`);
    emitCapture(capture, "execution_error", err?.message ?? String(err), {
      freshReservedUsd,
      abTestArm: isSportsCandidate(c) ? "strict_live" : "live",
      strategy: strategySummary(evaluateSportsStrategy(c)),
    });
  } finally {
    reservedSpendUsd = Math.max(0, reservedSpendUsd - freshReservedUsd);
    inFlight.delete(pkg.key);
    if (isSportsCandidate(executionCandidate)) eventsInFlight.delete(executionCandidate.eventSlug);
    for (const tokenId of executionTokens) tokensInFlight.delete(tokenId);
    refreshAlreadyOpen();
  }
}

async function executeLive(
  pkg: WatchPackage,
  c: Candidate,
  shares: number,
  quoteContext?: ExecutionQuoteContext,
): Promise<ExecutionCaptureResult> {
  if (!clob) throw new Error("CLOB client not initialized");
  const sportsBlock = sportsExecutionBlocked(c);
  if (sportsBlock) throw new Error(`blocked_sports_non_atomic_execution: ${sportsBlock}`);
  if (isSportsCandidate(c)) {
    return executeSportsCheapFirst(pkg, c, shares, quoteContext);
  }
  const client = clob.client;
  const record = packageRecord(c, reconcileAddress, shares, false);
  const orders: LiveOrder[] = [];

  log(`ARB ${pkg.key} edge=${(c.lockedEdge * 100).toFixed(2)}c cost=${c.packageCost.toFixed(4)} shares=${shares.toFixed(2)} size=${c.availableSize.toFixed(2)}${isSportsCandidate(c) ? " sports_preflight=1 nba_batch=1" : ""}`);

  record.status = "leg1_submitted";
  record.updatedAt = new Date().toISOString();

  const submitStartedMs = Date.now();
  let legacyBalanceBefore: { leg1: number; leg2: number } | null = null;
  if (!RESPONSE_FILL_FIRST) {
    const balanceStartedMs = Date.now();
    const [leg1Before, leg2Before] = await Promise.all([
      reconcileTokenBalance(reconcileAddress, pkg.broadYesToken),
      reconcileTokenBalance(reconcileAddress, pkg.narrowNoToken),
    ]);
    legacyBalanceBefore = { leg1: leg1Before, leg2: leg2Before };
    (record as any).latency = { preSubmitBalanceMs: Date.now() - balanceStartedMs, balanceMode: "pre_submit_balance" };
  } else {
    (record as any).latency = { preSubmitBalanceMs: 0, balanceMode: "submit_response_first" };
  }

  const signStartedMs = Date.now();
  const prepared = await Promise.all([
    prepareFakBuy(client, { role: "broad_yes", tokenId: pkg.broadYesToken, price: c.broad.yesBook.ask, shares }),
    prepareFakBuy(client, { role: "narrow_no", tokenId: pkg.narrowNoToken, price: c.narrow.noBook.ask, shares }),
  ]);
  const signOrdersMs = Date.now() - signStartedMs;

  // Fire BOTH FAK legs in the tightest configured form. Batch mode is the
  // default because it is a single CLOB request; parallel mode remains available
  // for A/B latency tests.
  const submittedAt = new Date().toISOString();
  const forceBatch = isSportsCandidate(c) && ENABLE_NBA_BATCH_EXECUTION;
  let r1: PromiseSettledResult<unknown>;
  let r2: PromiseSettledResult<unknown>;
  let postMode = forceBatch || MONOTONIC_POST_MODE === "batch" ? "batch" : "parallel";
  let postOrdersMs = 0;
  try {
    const posted = await postPreparedFakBuys(client, prepared, forceBatch);
    postMode = posted.postMode;
    postOrdersMs = posted.postOrdersMs;
    r1 = { status: "fulfilled", value: posted.responses[0] };
    r2 = { status: "fulfilled", value: posted.responses[1] };
  } catch (err) {
    postOrdersMs = Date.now() - (submitStartedMs + signOrdersMs);
    r1 = { status: "rejected", reason: err };
    r2 = { status: "rejected", reason: err };
  }
  Object.assign((record as any).latency, {
    signOrdersMs,
    postOrdersMs,
    submitPairMs: Date.now() - submitStartedMs,
    postMode,
  });

  const legErrors: string[] = [];
  let leg1Resp: unknown;
  let leg2Resp: unknown;
  if (r1.status === "fulfilled") {
    leg1Resp = r1.value;
    try { assertOrderResponse(r1.value, "broad_yes"); record.legOrderIds.broadYes = orderId(r1.value); }
    catch (e: any) { legErrors.push(`broad_yes:${e?.message ?? String(e)}`); }
  } else {
    leg1Resp = { error: r1.reason?.message ?? String(r1.reason) };
    legErrors.push(`broad_yes:${r1.reason?.message ?? String(r1.reason)}`);
  }
  if (r2.status === "fulfilled") {
    leg2Resp = r2.value;
    try { assertOrderResponse(r2.value, "narrow_no"); record.legOrderIds.narrowNo = orderId(r2.value); }
    catch (e: any) { legErrors.push(`narrow_no:${e?.message ?? String(e)}`); }
  } else {
    leg2Resp = { error: r2.reason?.message ?? String(r2.reason) };
    legErrors.push(`narrow_no:${r2.reason?.message ?? String(r2.reason)}`);
  }
  record.status = "leg2_submitted";
  record.updatedAt = new Date().toISOString();

  let leg1Filled = roundShares(responseBuyShares(leg1Resp));
  let leg2Filled = roundShares(responseBuyShares(leg2Resp));
  let fillSource = "submit_response";
  if (!RESPONSE_FILL_FIRST && legacyBalanceBefore) {
    const fillWaitStartedMs = Date.now();
    await Promise.all([
      waitForFill(pkg.broadYesToken, FILL_WAIT_DAEMON_MS),
      waitForFill(pkg.narrowNoToken, FILL_WAIT_DAEMON_MS),
    ]);
    const reconcileStartedMs = Date.now();
    const [leg1After, leg2After] = await Promise.all([
      reconcileTokenBalance(reconcileAddress, pkg.broadYesToken),
      reconcileTokenBalance(reconcileAddress, pkg.narrowNoToken),
    ]);
    leg1Filled = roundShares(leg1After - legacyBalanceBefore.leg1);
    leg2Filled = roundShares(leg2After - legacyBalanceBefore.leg2);
    fillSource = "balance_delta";
    Object.assign((record as any).latency, {
      fillWaitMs: reconcileStartedMs - fillWaitStartedMs,
      reconcileMs: Date.now() - reconcileStartedMs,
    });
  } else {
    Object.assign((record as any).latency, { fillWaitMs: 0, reconcileMs: 0 });
  }
  (record as any).fillSource = fillSource;
  orders.push({ packageId: record.packageId, createdAt: submittedAt, role: "broad_yes", tokenId: pkg.broadYesToken, side: "BUY", price: c.broad.yesBook.ask, size: leg1Filled, orderType: "FAK", response: leg1Resp });
  orders.push({ packageId: record.packageId, createdAt: submittedAt, role: "narrow_no", tokenId: pkg.narrowNoToken, side: "BUY", price: c.narrow.noBook.ask, size: leg2Filled, orderType: "FAK", response: leg2Resp });

  const matched = roundShares(Math.min(leg1Filled, leg2Filled));
  const broadAvgPrice = averageBuyPrice(leg1Resp, c.broad.yesBook.ask);
  const narrowAvgPrice = averageBuyPrice(leg2Resp, c.narrow.noBook.ask);
  record.filledShares = matched;
  record.actualCost = (leg1Filled * broadAvgPrice) + (leg2Filled * narrowAvgPrice);
  record.guaranteedFloor = matched;
  record.lockedFloorProfit = matched * c.lockedEdge;
  record.jackpotPayout = matched * c.jackpotPayoutPerShare;

  // The matched portion is a genuine risk-free package and is booked complete.
  // Any excess on the over-filled leg is a NAKED leg: instead of holding it to a
  // directional resolution, we spin it off as an orphan for the completion/
  // unwind engine to re-pair across the ladder (or flatten on the tight stop).
  const nakedShares = roundShares(Math.abs(leg1Filled - leg2Filled));
  const nakedRole: "broad_yes" | "narrow_no" | null =
    leg1Filled > leg2Filled ? "broad_yes" : leg2Filled > leg1Filled ? "narrow_no" : null;
  const errSuffix = legErrors.length ? ` errors=${legErrors.join("; ")}` : "";
  if (legErrors.some((error) => error.toLowerCase().includes("maker address not allowed"))) {
    pauseNewEntries("wallet_flow_rejected: maker address not allowed; configure deposit-wallet maker/funder before resuming", {
      packageId: record.packageId,
      errors: legErrors,
    });
  }

  const sportsCandidate = isSportsCandidate(c);
  if (matched > 0) {
    record.status = "package_complete";
    if (nakedRole) {
      record.failureReason = sportsCandidate
        ? `partial_fill matched=${matched} naked_${nakedRole}=${nakedShares} -> sports_immediate_exit${errSuffix}`
        : `partial_fill matched=${matched} naked_${nakedRole}=${nakedShares} -> orphan${errSuffix}`;
    }
  } else {
    record.status = "unwind_required";
    record.failureReason = nakedRole
      ? sportsCandidate
        ? `naked_${nakedRole}=${nakedShares} -> sports_immediate_exit (no matched fill)${errSuffix}`
        : `naked_${nakedRole}=${nakedShares} -> orphan (no matched fill)${errSuffix}`
      : `no_fill both FAK legs killed (arb gone); no position${errSuffix}`;
  }
  const actualPairCost = matched > 0 ? broadAvgPrice + narrowAvgPrice : null;
  attachExecutionQuote(record, quoteContext, actualPairCost);
  record.updatedAt = new Date().toISOString();
  persist(record, orders);

  if (nakedRole && nakedShares >= SPORTS_ORPHAN_DUST_SHARES) {
    const orphan = registerOrphanFromExecution(c, nakedRole, nakedShares, record.packageId);
    if (nakedShares > MAX_NAKED_SHARES_BEFORE_PAUSE) {
      quarantinePackage(pkg, c, `large_naked_leg_detected: ${nakedRole}=${nakedShares} > dust=${MAX_NAKED_SHARES_BEFORE_PAUSE}`, {
        packageId: record.packageId,
        eventSlug: c.eventSlug,
        asset: c.asset,
        role: nakedRole,
        nakedShares,
        matched,
        intendedShares: shares,
        sports: sportsCandidate,
        orphanId: orphan.id,
        legErrors,
      });
    }
    if (sportsCandidate) {
      orphanInFlight.add(orphan.id);
      try {
        const { pick, reason } = immediateSportsRepairPick(orphan, c);
        const repaired = pick ? await doFastSportsRepairCompletion(orphan, pick, reason) : false;
        if (!repaired || (orphan.status !== "completed" && orphan.shares >= SPORTS_ORPHAN_DUST_SHARES)) {
          await doSportsImmediateUnwind(orphan, `sports_imbalance matched=${matched} intended=${shares} repair=${reason}`);
        }
      } finally {
        orphanInFlight.delete(orphan.id);
      }
      if (orphan.status === "stranded" && orphan.shares > SPORTS_ORPHAN_DUST_SHARES) {
        pauseEventEntries(c.eventSlug, `sports residual could not be repaired or cut immediately: ${nakedRole}=${orphan.shares} (scoped to this event; other events keep trading)`, {
          packageId: record.packageId,
          eventSlug: c.eventSlug,
          asset: c.asset,
          role: nakedRole,
          residualShares: orphan.shares,
          orphanId: orphan.id,
          legErrors,
        });
      }
    }
  }
  log(`package ${record.packageId} status=${record.status} leg1=${leg1Filled} leg2=${leg2Filled} matched=${matched.toFixed(2)} naked=${nakedShares.toFixed(2)}${nakedRole ? `(${nakedRole})` : ""} intended=${shares.toFixed(2)}`);
  return {
    packageRecordId: record.packageId,
    recordStatus: record.status,
    failureReason: record.failureReason,
    intendedShares: shares,
    broadFilled: leg1Filled,
    narrowFilled: leg2Filled,
    matched,
    nakedShares,
    nakedRole,
    actualCost: record.actualCost,
    actualPairCost: matched > 0 ? broadAvgPrice + narrowAvgPrice : null,
    broadAvgPrice,
    narrowAvgPrice,
    legErrors,
    fillSource,
    latency: (record as any).latency,
    orderIds: record.legOrderIds,
  };
}

async function executeSportsCheapFirst(
  pkg: WatchPackage,
  c: Candidate,
  shares: number,
  quoteContext?: ExecutionQuoteContext,
): Promise<ExecutionCaptureResult> {
  if (!clob) throw new Error("CLOB client not initialized");
  const client = clob.client;
  const record = packageRecord(c, reconcileAddress, shares, false);
  const submittedAt = new Date().toISOString();
  const broadLeg = { role: "broad_yes" as const, tokenId: pkg.broadYesToken, price: c.broad.yesBook.ask };
  const narrowLeg = { role: "narrow_no" as const, tokenId: pkg.narrowNoToken, price: c.narrow.noBook.ask };
  const first = broadLeg.price <= narrowLeg.price ? broadLeg : narrowLeg;
  const second = first.role === "broad_yes" ? narrowLeg : broadLeg;
  const legErrors: string[] = [];
  let broadFilled = 0;
  let narrowFilled = 0;
  let firstResp: unknown;
  let secondResp: unknown | undefined;
  let orphanId: string | undefined;

  // Warm tick-size + fee-rate caches for BOTH legs up front so the hedge submit
  // after the cheap fill is a single network call, not 1-3 (cold metadata fetches
  // otherwise land in the orphan-prone inter-leg gap). Excluded from submitPairMs.
  const prewarmMs = await prewarmOrderMetadata(client, [first.tokenId, second.tokenId]);
  const submitStartedMs = Date.now();

  log(`SPORTS_ARB ${pkg.key} cheap_first=${first.role} cheap=${first.price.toFixed(4)} complement=${second.price.toFixed(4)} edge=${(c.lockedEdge * 100).toFixed(2)}c cost=${c.packageCost.toFixed(4)} intended=${shares.toFixed(2)} prewarmMs=${prewarmMs}`);

  // Durable intent before the race starts. There is intentionally no disk I/O
  // between leg 1 and leg 2; startup recovery reconciles this intent if the
  // process dies mid-sequence.
  record.status = "leg1_submitted";
  record.updatedAt = new Date().toISOString();
  record.failureReason = `sports_cheap_first_intent first=${first.role} second=${second.role}`;
  (record as any).latency = { preSubmitBalanceMs: 0, balanceMode: "intent_then_response" };
  persist(record, []);

  try {
    firstResp = await postFakBuy(client, first.tokenId, first.price, shares);
    assertOrderResponse(firstResp, first.role);
    record.legOrderIds[first.role === "broad_yes" ? "broadYes" : "narrowNo"] = orderId(firstResp);
  } catch (err: any) {
    firstResp = { error: err?.message ?? String(err) };
    legErrors.push(`${first.role}:${err?.message ?? String(err)}`);
  }
  const firstFilled = roundShares(responseBuyShares(firstResp));
  if (first.role === "broad_yes") broadFilled = firstFilled;
  else narrowFilled = firstFilled;
  const firstOrder: LiveOrder = { packageId: record.packageId, createdAt: submittedAt, role: first.role, tokenId: first.tokenId, side: "BUY", price: first.price, size: firstFilled, orderType: "FAK", response: firstResp };

  record.status = "leg2_submitted";
  record.updatedAt = new Date().toISOString();

  // Price the hedge at the locked-pair break-even ceiling derived from the cheap
  // leg's ACTUAL fill price, not the stale snapshot ask. This is the structural
  // fix for the ~290ms preflight reprice: a hedge that ticked up still completes
  // the pair as long as the pair stays profitable (>= break-even), and only a
  // reprice past break-even no-fills (a clean cheap-leg orphan we then unwind).
  const cheapAvgFill = firstFilled > 0 ? averageBuyPrice(firstResp, first.price) : first.price;
  const hedgePrice = sportsHedgeCompletionPrice(second.price, cheapAvgFill);
  if (hedgePrice > second.price + EPSILON) {
    log(`sports hedge ceiling ${pkg.key}: ${second.role} snapshot=${second.price.toFixed(4)} -> breakeven=${hedgePrice.toFixed(4)} cheapFill=${cheapAvgFill.toFixed(4)} pairCeil=${(cheapAvgFill + hedgePrice).toFixed(4)}`);
  }
  const complementNotional = firstFilled * hedgePrice;
  if (firstFilled > 0 && complementNotional + EPSILON >= MIN_MARKETABLE_BUY_USD) {
    try {
      secondResp = await postFakBuy(client, second.tokenId, hedgePrice, firstFilled);
      assertOrderResponse(secondResp, second.role);
      record.legOrderIds[second.role === "broad_yes" ? "broadYes" : "narrowNo"] = orderId(secondResp);
    } catch (err: any) {
      secondResp = { error: err?.message ?? String(err) };
      legErrors.push(`${second.role}:${err?.message ?? String(err)}`);
    }
    const secondFilled = roundShares(responseBuyShares(secondResp));
    if (second.role === "broad_yes") broadFilled = secondFilled;
    else narrowFilled = secondFilled;
  } else if (firstFilled > 0) {
    legErrors.push(`${second.role}:skipped complement notional ${complementNotional.toFixed(4)} below minimum marketable buy`);
  }
  const orders: LiveOrder[] = [firstOrder];
  if (secondResp !== undefined) {
    orders.push({ packageId: record.packageId, createdAt: new Date().toISOString(), role: second.role, tokenId: second.tokenId, side: "BUY", price: hedgePrice, size: second.role === "broad_yes" ? broadFilled : narrowFilled, orderType: "FAK", response: secondResp });
  }

  Object.assign((record as any).latency, {
    preSubmitBalanceMs: 0,
    balanceMode: "submit_response_first",
    fillWaitMs: 0,
    reconcileMs: 0,
    postMode: "sports_cheap_first",
    submitPairMs: Date.now() - submitStartedMs,
    prewarmMs,
  });
  (record as any).fillSource = "submit_response";

  const reconcileStartedMs = Date.now();
  await Promise.all([
    waitForFill(pkg.broadYesToken, FILL_WAIT_DAEMON_MS),
    waitForFill(pkg.narrowNoToken, FILL_WAIT_DAEMON_MS),
  ]);
  const [broadBalance, narrowBalance] = await Promise.all([
    unpairedTokenBalance(pkg.broadYesToken),
    unpairedTokenBalance(pkg.narrowNoToken),
  ]);
  const reconciledBroad = Math.max(broadFilled, broadBalance);
  const reconciledNarrow = Math.max(narrowFilled, narrowBalance);
  if (Math.abs(reconciledBroad - broadFilled) > 0.000001 || Math.abs(reconciledNarrow - narrowFilled) > 0.000001) {
    log(`sports reconcile adjusted fills ${pkg.key}: response broad=${broadFilled} narrow=${narrowFilled} onchain broad=${reconciledBroad} narrow=${reconciledNarrow}`);
    broadFilled = reconciledBroad;
    narrowFilled = reconciledNarrow;
  }
  Object.assign((record as any).latency, { reconcileMs: Date.now() - reconcileStartedMs });

  let matched = roundShares(Math.min(broadFilled, narrowFilled));
  // PHANTOM-FAK GUARD: When `matched === 0` and only one leg "filled" by the
  // CLOB response, the on-chain unpaired balance is authoritative. Some FAK
  // responses over-report shares that never actually settle on Polygon (the
  // FAK was killed but the response still carries a non-zero makingAmount).
  // When that happens we previously wrote a phantom `actualCost` and a
  // phantom naked-orphan, ending up with a -$cost line in the PnL report even
  // though the wallet has nothing to sell. If the chain says balance==0 we
  // clamp the leg back to 0. We only do this when matched===0 so partial
  // fills with a real overhang are not silently dropped.
  if (matched === 0) {
    if (broadFilled > SPORTS_ORPHAN_DUST_SHARES && broadBalance <= SPORTS_ORPHAN_DUST_SHARES) {
      log(`SPORTS_PHANTOM_GUARD ${pkg.key}: broad response=${broadFilled} unpairedBalance=${broadBalance.toFixed(6)} -> clamping to 0`);
      broadFilled = 0;
    }
    if (narrowFilled > SPORTS_ORPHAN_DUST_SHARES && narrowBalance <= SPORTS_ORPHAN_DUST_SHARES) {
      log(`SPORTS_PHANTOM_GUARD ${pkg.key}: narrow response=${narrowFilled} unpairedBalance=${narrowBalance.toFixed(6)} -> clamping to 0`);
      narrowFilled = 0;
    }
    matched = roundShares(Math.min(broadFilled, narrowFilled));
  }
  const broadAvgPrice = averageBuyPrice(first.role === "broad_yes" ? firstResp : secondResp, c.broad.yesBook.ask);
  const narrowAvgPrice = averageBuyPrice(first.role === "narrow_no" ? firstResp : secondResp, c.narrow.noBook.ask);
  record.filledShares = matched;
  record.actualCost =
    broadFilled * broadAvgPrice
    + narrowFilled * narrowAvgPrice;
  record.guaranteedFloor = matched;
  record.lockedFloorProfit = matched * c.lockedEdge;
  record.jackpotPayout = matched * c.jackpotPayoutPerShare;

  const nakedShares = roundShares(Math.abs(broadFilled - narrowFilled));
  const nakedRole: "broad_yes" | "narrow_no" | null =
    broadFilled > narrowFilled ? "broad_yes" : narrowFilled > broadFilled ? "narrow_no" : null;
  const errSuffix = legErrors.length ? ` errors=${legErrors.join("; ")}` : "";
  if (matched > 0) {
    record.status = "package_complete";
    if (nakedRole) {
      record.failureReason = `sports_cheap_first_partial matched=${matched} naked_${nakedRole}=${nakedShares} -> immediate_exit${errSuffix}`;
    }
  } else {
    record.status = "unwind_required";
    record.failureReason = nakedRole
      ? `sports_cheap_first_naked_${nakedRole}=${nakedShares} -> immediate_exit (no matched fill)${errSuffix}`
      : `sports_cheap_first_no_fill; no position${errSuffix}`;
  }
  const actualPairCost = matched > 0 ? broadAvgPrice + narrowAvgPrice : null;
  attachExecutionQuote(record, quoteContext, actualPairCost);
  record.updatedAt = new Date().toISOString();
  persist(record, orders);

  if (nakedRole && nakedShares >= SPORTS_ORPHAN_DUST_SHARES) {
    const orphan = registerOrphanFromExecution(c, nakedRole, nakedShares, record.packageId);
    orphanId = orphan.id;
    quarantinePackage(pkg, c, `sports_cheap_first_residual: ${nakedRole}=${nakedShares}`, {
      packageId: record.packageId,
      eventSlug: c.eventSlug,
      asset: c.asset,
      role: nakedRole,
      nakedShares,
      matched,
      intendedShares: shares,
      orphanId: orphan.id,
      legErrors,
    });
    orphanInFlight.add(orphan.id);
    try {
      const { pick, reason } = immediateSportsRepairPick(orphan, c);
      const repaired = pick ? await doFastSportsRepairCompletion(orphan, pick, reason) : false;
      if (!repaired || (orphan.status !== "completed" && orphan.shares >= SPORTS_ORPHAN_DUST_SHARES)) {
        await doSportsImmediateUnwind(orphan, `sports_cheap_first_residual matched=${matched} intended=${shares} repair=${reason}`);
      }
    } finally {
      orphanInFlight.delete(orphan.id);
    }
    if (orphan.status === "stranded" && orphan.shares > SPORTS_ORPHAN_DUST_SHARES) {
      pauseEventEntries(c.eventSlug, `sports residual could not be cut immediately: ${nakedRole}=${orphan.shares} (scoped to this event; other events keep trading)`, {
        packageId: record.packageId,
        eventSlug: c.eventSlug,
        asset: c.asset,
        role: nakedRole,
        residualShares: orphan.shares,
        orphanId: orphan.id,
      });
    }
  }
  log(`sports package ${record.packageId} status=${record.status} broad=${broadFilled} narrow=${narrowFilled} matched=${matched.toFixed(2)} naked=${nakedShares.toFixed(2)}${nakedRole ? `(${nakedRole})` : ""} intended=${shares.toFixed(2)}`);
  return {
    packageRecordId: record.packageId,
    recordStatus: record.status,
    failureReason: record.failureReason,
    intendedShares: shares,
    broadFilled,
    narrowFilled,
    matched,
    nakedShares,
    nakedRole,
    actualCost: record.actualCost,
    actualPairCost: matched > 0 ? broadAvgPrice + narrowAvgPrice : null,
    broadAvgPrice,
    narrowAvgPrice,
    legErrors,
    fillSource: "submit_response",
    latency: (record as any).latency,
    orderIds: record.legOrderIds,
    orphanId,
  };
}

function persist(record: LivePackage, orders: LiveOrder[]) {
  const rows = readJsonArray<LivePackage>(PACKAGES_PATH).filter((row) => row.id !== record.id);
  writeJsonArray(PACKAGES_PATH, [...rows, record]);
  if (orders.length) appendJsonArray(ORDERS_PATH, orders);
}

// ─── Orphan inventory: re-pair a naked leg or unwind it ───
//
// Policy (operator-locked): a naked leg is NEVER held to a directional
// resolution. On each sweep we (1) bail immediately if the orphan's best bid
// has dropped ORPHAN_STOP_CENTS below our fill (tight stop = the dominant
// guard), (2) bail if the event ladder no longer contains ANY structurally
// valid complement (stranded), or we are within ORPHAN_EXPIRY_BUFFER_MS of the
// orphan market's own expiry; otherwise (3) we hunt the live ladder for a
// positive-EV complement (fillPrice + complementAsk < 1 - margin) and complete
// into it. The tight stop bounds downside, which is what makes the long
// hunt-until-expiry leash safe.

function loadOrphans() {
  for (const o of readJsonArray<Orphan>(ORPHANS_PATH)) {
    orphans.set(o.id, o);
    if (o.status === "completing") getBook(o.tokenId); // keep it subscribed
  }
}

function saveOrphans() {
  writeJsonArray(ORPHANS_PATH, [...orphans.values()]);
}

function activeOrphans(): Orphan[] {
  return [...orphans.values()].filter((o) => o.status === "completing");
}

function pairedPackageSharesForToken(tokenId: string): number {
  const rows = readJsonArray<LivePackage>(PACKAGES_PATH);
  let shares = 0;
  for (const row of rows) {
    if (row.status !== "package_complete") continue;
    if ((row.actualCost ?? 0) <= 0 || (row.filledShares ?? 0) <= 0) continue;
    const tokenIds = (row as { tokenIds?: Record<string, string | undefined> }).tokenIds ?? {};
    if (!Object.values(tokenIds).includes(tokenId)) continue;
    const soldShares = Number((row as { soldShares?: number }).soldShares ?? 0);
    shares += Math.max(0, (row.filledShares ?? 0) - soldShares);
  }
  return roundShares(shares);
}

function activeOrphanSharesForToken(tokenId: string, excludePackageId?: string): number {
  let shares = 0;
  for (const o of activeOrphans()) {
    if (o.tokenId !== tokenId) continue;
    if (excludePackageId && o.packageId === excludePackageId) continue;
    shares += o.shares;
  }
  return roundShares(shares);
}

async function unpairedTokenBalance(tokenId: string, excludeOrphanPackageId?: string): Promise<number> {
  const bal = await reconcileTokenBalance(reconcileAddress, tokenId);
  const pairedShares = pairedPackageSharesForToken(tokenId);
  const orphanShares = activeOrphanSharesForToken(tokenId, excludeOrphanPackageId);
  return roundShares(Math.max(0, bal - pairedShares - orphanShares));
}

async function syncOrphanToUnpairedBalance(o: Orphan, reason: string): Promise<boolean> {
  const unpairedShares = await unpairedTokenBalance(o.tokenId, o.packageId);
  if (unpairedShares + EPSILON < ORPHAN_MIN_SHARES) {
    const createdAtMs = Date.parse(o.createdAt);
    const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : Number.POSITIVE_INFINITY;
    if (ageMs < ORPHAN_BALANCE_SETTLE_GRACE_MS && o.shares >= ORPHAN_MIN_SHARES) {
      o.note = `balance pending ${reason}: unpaired=${unpairedShares}; ageMs=${Math.max(0, Math.round(ageMs))}`;
      o.updatedAt = new Date().toISOString();
      saveOrphans();
      log(`orphan ${o.id} balance pending ${reason}: unpaired=${unpairedShares} ageMs=${Math.max(0, Math.round(ageMs))}`);
      return true;
    }
    o.status = "completed"; // position no longer held outside completed packages
    o.note = `closed ${reason}: unpaired=${unpairedShares}`;
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} closed ${reason}: unpaired=${unpairedShares}`);
    return false;
  }
  if (unpairedShares + EPSILON < o.shares) {
    o.shares = unpairedShares; // trust on-chain, net of shares already owned by completed packages
    o.note = `resized ${reason}: unpaired=${unpairedShares}`;
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} resized ${reason}: unpaired=${unpairedShares}`);
  }
  return true;
}

function registerOrphanFromExecution(c: Candidate, role: "broad_yes" | "narrow_no", shares: number, fromPackageId: string): Orphan {
  const now = new Date().toISOString();
  const leg = role === "broad_yes" ? c.broad : c.narrow;
  const tokenId = role === "broad_yes" ? c.broad.yesTokenId : c.narrow.noTokenId;
  const fillPrice = role === "broad_yes" ? c.broad.yesBook.ask : c.narrow.noBook.ask;
  const o: Orphan = {
    id: `ORPH-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    packageId: fromPackageId,
    eventSlug: c.eventSlug,
    asset: c.asset,
    direction: c.direction,
    role,
    marketId: leg.marketId,
    tokenId,
    strike: leg.strike,
    fillPrice,
    shares: roundShares(shares),
    endDate: leg.endDate,
    resolutionSource: leg.resolutionSource,
    createdAt: now,
    updatedAt: now,
    status: "completing",
    attempts: 0,
  };
  orphans.set(o.id, o);
  getBook(o.tokenId);
  saveOrphans();
  log(`orphan ${o.id} OPEN role=${role} token=${tokenId.slice(0, 10)}… strike=${o.strike} shares=${o.shares} fill=${o.fillPrice.toFixed(4)} (re-pair target: complement on ${o.eventSlug})`);
  return o;
}

function registerOrphanFromPackageRecord(row: LivePackage, role: "broad_yes" | "narrow_no", shares: number, note: string): Orphan {
  const existing = activeOrphans().find((o) => o.packageId === row.packageId && o.role === role);
  if (existing) {
    existing.shares = roundShares(shares);
    existing.note = note;
    existing.updatedAt = new Date().toISOString();
    saveOrphans();
    return existing;
  }
  const now = new Date().toISOString();
  const leg = row.packageLegs.find((entry) => entry.role === role);
  const tokenId = role === "broad_yes" ? row.tokenIds.broadYes : row.tokenIds.narrowNo;
  const fillPrice = role === "broad_yes" ? row.prices.broadYesAsk : row.prices.narrowNoAsk;
  const marketId = leg?.instrumentId?.split("::").pop() ?? "";
  const o: Orphan = {
    id: `ORPH-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    packageId: row.packageId,
    eventSlug: row.eventSlug,
    asset: row.asset,
    direction: row.direction,
    role,
    marketId,
    tokenId,
    strike: role === "broad_yes" ? row.broadStrike : row.narrowStrike,
    fillPrice,
    shares: roundShares(shares),
    endDate: row.settlementWindow.endDate,
    resolutionSource: `recovered from sports intent ${row.eventSlug}`,
    createdAt: now,
    updatedAt: now,
    status: "completing",
    attempts: 0,
    note,
  };
  orphans.set(o.id, o);
  getBook(o.tokenId);
  saveOrphans();
  log(`orphan ${o.id} RECOVERED role=${role} token=${tokenId.slice(0, 10)}… shares=${o.shares} fill=${o.fillPrice.toFixed(4)} package=${row.packageId}`);
  return o;
}

function orphanBestBid(o: Orphan): number {
  return topOfBook(o.tokenId).bid;
}

function orphanCompletionMargin(o: Orphan): number {
  return o.asset === "NBA" || o.eventSlug.startsWith("nba-")
    ? ORPHAN_COMPLETION_MARGIN
    : NON_SPORTS_ORPHAN_COMPLETION_MARGIN;
}

async function doSportsImmediateUnwind(o: Orphan, reason: string) {
  if (!clob || DRY_RUN) return;
  const client = clob.client;
  let bid = orphanBestBid(o);
  if (!(bid > 0)) {
    try {
      const raw = await fetchRawBook(o.tokenId);
      bid = raw.bids.reduce((b, l) => (l.price > b ? l.price : b), 0);
    } catch { /* keep 0 */ }
  }
  if (!(bid > 0)) {
    o.status = "stranded";
    o.note = `sports immediate exit failed: no bid (${reason})`;
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} SPORTS_EXIT failed (${reason}): no bid`);
    return;
  }

  o.attempts += 1;
  let before = await waitForTokenBalance(o.tokenId, Math.min(o.shares, ORPHAN_MIN_SHARES), SPORTS_EXIT_BALANCE_WAIT_MS);
  const sellShares = roundShares(Math.min(o.shares, before));
  if (sellShares + EPSILON < SPORTS_ORPHAN_DUST_SHARES) {
    o.status = "stranded";
    o.note = `sports immediate exit failed: balance unavailable balance=${before} shares=${o.shares} (${reason})`;
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} SPORTS_EXIT failed (${reason}): balance unavailable balance=${before} shares=${o.shares}`);
    return;
  }
  log(`orphan ${o.id} SPORTS_EXIT (${reason}): FAK-sell ${sellShares} @ bid=${bid.toFixed(4)} fill=${o.fillPrice.toFixed(4)}`);
  let resp: unknown;
  try {
    resp = await postFakSell(client, o.tokenId, bid, sellShares);
    assertOrderResponse(resp, "sports_unwind");
  } catch (err: any) {
    resp = { error: err?.message ?? String(err) };
    log(`orphan ${o.id} sports exit order error: ${err?.message ?? String(err)}`);
  }
  await waitForFill(o.tokenId, FILL_WAIT_DAEMON_MS);
  const after = await reconcileTokenBalance(reconcileAddress, o.tokenId);
  const sold = roundShares(before - after);
  appendJsonArray(ORDERS_PATH, [{
    packageId: o.packageId,
    createdAt: new Date().toISOString(),
    role: "unwind",
    tokenId: o.tokenId,
    side: "SELL",
    price: bid,
    size: sold,
    orderType: "FAK",
    response: resp,
  }]);
  o.shares = roundShares(o.shares - sold);
  const realized = sold * (bid - o.fillPrice);
  o.note = `sports_immediate_exit sold=${sold} @ ${bid.toFixed(4)} realized=${realized.toFixed(4)} (${reason})`;
  o.status = o.shares + EPSILON < SPORTS_ORPHAN_DUST_SHARES ? "unwound" : "stranded";
  o.updatedAt = new Date().toISOString();
  saveOrphans();
  log(`orphan ${o.id} SPORTS_EXIT result sold=${sold} realized=${realized.toFixed(4)} residual=${o.shares}`);
}

// Reactive tight stop, fired off the market-WS hot path: the moment a held
// orphan's bid drops below fill - ORPHAN_STOP_CENTS, flatten it.
function maybeOrphanStop(tokenId: string) {
  if (DRY_RUN) return;
  for (const o of orphans.values()) {
    if (o.status !== "completing" || o.tokenId !== tokenId) continue;
    if (orphanInFlight.has(o.id)) continue;
    const bid = orphanBestBid(o);
    if (bid > 0 && bid + EPSILON <= o.fillPrice - ORPHAN_STOP_CENTS) {
      orphanInFlight.add(o.id);
      void doUnwind(o, `price_ran_away bid=${bid.toFixed(4)} fill=${o.fillPrice.toFixed(4)} stop=${ORPHAN_STOP_CENTS}`)
        .finally(() => orphanInFlight.delete(o.id));
    }
  }
}

// Fetch the orphan's event ladder live (throttled + shared per event) so the
// completion search runs against the CURRENT set of strikes, not a stale
// snapshot — a growing ladder helps, a shrunk one strands us.
async function orphanLadder(o: Orphan): Promise<MarketQuote[]> {
  const cached = orphanEventCache.get(o.eventSlug);
  if (cached && Date.now() - cached.at < ORPHAN_LADDER_REFRESH_MS) return cached.quotes;
  let event: GammaEvent | null = null;
  try {
    event = await fetchEvent(arbConfig, o.eventSlug);
  } catch (err: any) {
    log(`orphan ${o.id} ladder fetch failed: ${err?.message ?? String(err)}`);
    return cached?.quotes ?? [];
  }
  if (!event) return cached?.quotes ?? [];
  // Ensure the orphan carries an asset (older records / safety) for evaluatePair's allowlist gate.
  if (!o.asset) o.asset = polymarketAssetForSlug(event.slug ?? "") || o.asset;
  const quotes = (await Promise.all((event.markets ?? []).map(async (m) => {
    try { return await marketQuote(arbConfig, event!, m); } catch { return null; }
  }))).filter((q): q is MarketQuote => q !== null);
  orphanEventCache.set(o.eventSlug, { at: Date.now(), quotes });
  orphanLadderAt.set(o.id, Date.now());
  return quotes;
}

interface CompletionPick {
  candidate: Candidate;
  complementToken: string;
  complementAsk: number;
  completionShares: number;
  completionEdge: number;
  repairedPackageCost?: number;
  repairEvidence?: SportRepairBucketEvidence;
}

interface SportRepairBucketEvidence {
  sport: string;
  bucket: string;
  min: number;
  max: number;
  resolved: number;
  roiPct: number;
}

const SPORTS_REPAIR_BUCKET_EVIDENCE: SportRepairBucketEvidence[] = [
  { sport: "MLB", bucket: "<1.000", min: Number.NEGATIVE_INFINITY, max: 1.000, resolved: 37, roiPct: 5.1 },
  { sport: "MLB", bucket: "1.000-1.005", min: 1.000, max: 1.005, resolved: 29, roiPct: 3.4 },
  { sport: "MLB", bucket: "1.005-1.010", min: 1.005, max: 1.010, resolved: 1, roiPct: -0.8 },
  { sport: "MLB", bucket: "1.010-1.015", min: 1.010, max: 1.015, resolved: 13, roiPct: 6.6 },
  { sport: "MLB", bucket: "1.020-1.035", min: 1.020, max: 1.035, resolved: 29, roiPct: 7.5 },
  { sport: "MLB", bucket: "1.035-1.050", min: 1.035, max: 1.050, resolved: 34, roiPct: 1.5 },
  { sport: "MLB", bucket: "1.050-1.075", min: 1.050, max: 1.075, resolved: 246, roiPct: -0.6 },
  { sport: "MLB", bucket: "1.075-1.100", min: 1.075, max: 1.100, resolved: 323, roiPct: 0.1 },
  { sport: "MLB", bucket: "1.100-1.130", min: 1.100, max: 1.130, resolved: 201, roiPct: -0.4 },
  { sport: "MLB", bucket: "1.130-1.160", min: 1.130, max: 1.160, resolved: 184, roiPct: -1.5 },
  { sport: "MLB", bucket: "1.160-1.190", min: 1.160, max: 1.190, resolved: 302, roiPct: -2.0 },
  { sport: "MLB", bucket: "1.190-1.220", min: 1.190, max: 1.220, resolved: 137, roiPct: 8.5 },
  { sport: "MLB", bucket: "1.220-1.250", min: 1.220, max: 1.250, resolved: 93, roiPct: -3.9 },
  { sport: "MLB", bucket: "1.250-1.350", min: 1.250, max: 1.350, resolved: 369, roiPct: -0.7 },
  { sport: "MLB", bucket: "1.350-1.500", min: 1.350, max: 1.500, resolved: 282, roiPct: 0.2 },
  { sport: "SOCCER", bucket: "<1.000", min: Number.NEGATIVE_INFINITY, max: 1.000, resolved: 22, roiPct: 5.8 },
  { sport: "SOCCER", bucket: "1.000-1.005", min: 1.000, max: 1.005, resolved: 118, roiPct: 1.5 },
  { sport: "SOCCER", bucket: "1.005-1.010", min: 1.005, max: 1.010, resolved: 137, roiPct: -0.7 },
  { sport: "SOCCER", bucket: "1.010-1.015", min: 1.010, max: 1.015, resolved: 32, roiPct: 1.9 },
  { sport: "SOCCER", bucket: "1.015-1.020", min: 1.015, max: 1.020, resolved: 41, roiPct: 3.1 },
  { sport: "SOCCER", bucket: "1.020-1.035", min: 1.020, max: 1.035, resolved: 69, roiPct: 1.6 },
  { sport: "SOCCER", bucket: "1.035-1.050", min: 1.035, max: 1.050, resolved: 64, roiPct: 9.4 },
  { sport: "SOCCER", bucket: "1.050-1.075", min: 1.050, max: 1.075, resolved: 69, roiPct: 13.1 },
  { sport: "SOCCER", bucket: "1.075-1.100", min: 1.075, max: 1.100, resolved: 67, roiPct: 0.2 },
  { sport: "SOCCER", bucket: "1.100-1.130", min: 1.100, max: 1.130, resolved: 53, roiPct: 18.6 },
  { sport: "SOCCER", bucket: "1.130-1.160", min: 1.130, max: 1.160, resolved: 59, roiPct: 15.7 },
  { sport: "SOCCER", bucket: "1.160-1.190", min: 1.160, max: 1.190, resolved: 54, roiPct: 18.1 },
  { sport: "SOCCER", bucket: "1.190-1.220", min: 1.190, max: 1.220, resolved: 49, roiPct: 8.6 },
  { sport: "SOCCER", bucket: "1.220-1.250", min: 1.220, max: 1.250, resolved: 46, roiPct: 5.9 },
  { sport: "SOCCER", bucket: "1.250-1.350", min: 1.250, max: 1.350, resolved: 154, roiPct: 12.2 },
  { sport: "SOCCER", bucket: "1.350-1.500", min: 1.350, max: 1.500, resolved: 158, roiPct: 4.1 },
  { sport: "SOCCER", bucket: "1.500-1.750", min: 1.500, max: 1.750, resolved: 166, roiPct: 3.9 },
];

function repairBucketEvidence(asset: string, repairedPackageCost: number): SportRepairBucketEvidence | null {
  return SPORTS_REPAIR_BUCKET_EVIDENCE.find((row) =>
    row.sport === asset
    && (row.bucket === "<1.000" ? repairedPackageCost < 1 : repairedPackageCost >= row.min - EPSILON)
    && repairedPackageCost <= row.max + EPSILON
  ) ?? null;
}

function repairShapeBlockers(candidate: Candidate): string[] {
  return evaluateSportsStrategy(candidate).gateFailures.filter((failure) =>
    failure.includes("shape")
    || failure.includes("family")
    || failure.includes("width")
    || failure === "unsupported_sport"
    || failure.startsWith("adapter_")
  );
}

function repairEvidenceAllowed(asset: string, repairedPackageCost: number): { evidence: SportRepairBucketEvidence | null; reason: string | null } {
  const evidence = repairBucketEvidence(asset, repairedPackageCost);
  if (!evidence) return { evidence: null, reason: `no_repair_bucket cost=${repairedPackageCost.toFixed(4)}` };
  if (repairedPackageCost > SPORTS_ORPHAN_REPAIR_MAX_COST + EPSILON) {
    return { evidence, reason: `repair_cost_above_cap cost=${repairedPackageCost.toFixed(4)} cap=${SPORTS_ORPHAN_REPAIR_MAX_COST.toFixed(4)}` };
  }
  if (evidence.resolved < SPORTS_ORPHAN_REPAIR_MIN_RESOLVED) {
    return { evidence, reason: `repair_bucket_sample_too_small bucket=${evidence.bucket} resolved=${evidence.resolved}` };
  }
  if (evidence.roiPct <= SPORTS_ORPHAN_REPAIR_MIN_ROI_PCT) {
    return { evidence, reason: `repair_bucket_roi_not_positive bucket=${evidence.bucket} roi=${evidence.roiPct.toFixed(1)}%` };
  }
  return { evidence, reason: null };
}

function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-7;
}

function clobBuyAmountValid(price: number, shares: number): boolean {
  return hasAtMostDecimals(price * shares, 2) && hasAtMostDecimals(shares, 5);
}

function precisionSafeCompletionShares(price: number, minShares: number, maxShares: number): number | null {
  const maxCents = Math.floor((maxShares * price + EPSILON) * 100);
  const minCents = Math.ceil((minShares * price - EPSILON) * 100);
  for (let cents = maxCents; cents >= minCents; cents -= 1) {
    const shares = Math.floor(((cents / 100) / price) * 100_000) / 100_000;
    if (shares + EPSILON < minShares || shares - EPSILON > maxShares) continue;
    if (clobBuyAmountValid(price, shares)) return shares;
  }
  return null;
}

// Build the structurally-valid complement set for an orphan over a live ladder
// and pick the best positive-EV completion. Returns the structural count so the
// caller can distinguish "no valid complement exists" (stranded -> unwind) from
// "complements exist but none is positive-EV right now" (keep hunting).
function findCompletion(o: Orphan, quotes: MarketQuote[]): { pick: CompletionPick | null; structuralCount: number } {
  const self = quotes.find((q) => q.marketId === o.marketId);
  if (!self) return { pick: null, structuralCount: 0 }; // orphan market itself gone from ladder
  const now = new Date().toISOString();
  let structuralCount = 0;
  let best: CompletionPick | null = null;
  for (const q of quotes) {
    if (q.marketId === o.marketId || q.direction !== o.direction) continue;
    const broad = o.role === "broad_yes" ? self : q;
    const narrow = o.role === "broad_yes" ? q : self;
    // Nesting must hold for the $1 floor: above -> narrow strike higher; below -> lower.
    const nested = o.direction === "above" ? narrow.strike > broad.strike : narrow.strike < broad.strike;
    if (!nested) continue;
    const pair = evaluatePair(arbConfig, o.asset, broad, narrow, now);
    // Only expiry/resolution mismatches break the guarantee; ignore the entry
    // gates (edge/spread/liquidity/size) — completion EV is judged on sunk cost.
    if (pair.rejectionReasons.includes("expiry_mismatch") || pair.rejectionReasons.includes("resolution_mismatch")) continue;
    structuralCount += 1;
    const compBook = o.role === "broad_yes" ? narrow.noBook : broad.yesBook;
    const complementAsk = compBook.ask;
    if (!(complementAsk > 0)) continue;
    const completionEdge = 1 - (o.fillPrice + complementAsk);
    if (completionEdge <= orphanCompletionMargin(o)) continue;
    const completionShares = precisionSafeCompletionShares(
      complementAsk,
      compBook.minOrderSize,
      Math.min(o.shares, compBook.askSize),
    );
    if (!completionShares) continue;
    if (!best || completionEdge > best.completionEdge) {
      best = {
        candidate: pair,
        complementToken: o.role === "broad_yes" ? narrow.noTokenId : broad.yesTokenId,
        complementAsk,
        completionShares,
        completionEdge,
      };
    }
  }
  return { pick: best, structuralCount };
}

function immediateSportsRepairPick(o: Orphan, candidate: Candidate): { pick: CompletionPick | null; reason: string } {
  if (!SPORTS_ORPHAN_REPAIR_ENABLED) return { pick: null, reason: "sports_orphan_repair_disabled" };
  const shapeBlockers = repairShapeBlockers(candidate);
  if (shapeBlockers.length > 0) return { pick: null, reason: `repair_shape_blocked:${shapeBlockers.join("+")}` };
  const complementBook = o.role === "broad_yes" ? candidate.narrow.noBook : candidate.broad.yesBook;
  const complementToken = o.role === "broad_yes" ? candidate.narrow.noTokenId : candidate.broad.yesTokenId;
  const complementAsk = complementBook.ask;
  if (!(complementAsk > 0)) return { pick: null, reason: "repair_no_complement_ask" };
  const repairedPackageCost = o.fillPrice + complementAsk;
  const { evidence, reason } = repairEvidenceAllowed(o.asset, repairedPackageCost);
  if (reason) return { pick: null, reason };
  const completionShares = precisionSafeCompletionShares(
    complementAsk,
    complementBook.minOrderSize,
    Math.min(o.shares, complementBook.askSize),
  );
  if (!completionShares) {
    return {
      pick: null,
      reason: `repair_size_unavailable ask=${complementAsk.toFixed(4)} askSize=${complementBook.askSize.toFixed(4)} shares=${o.shares.toFixed(4)}`,
    };
  }
  return {
    pick: {
      candidate,
      complementToken,
      complementAsk,
      completionShares,
      completionEdge: 1 - repairedPackageCost,
      repairedPackageCost,
      repairEvidence: evidence ?? undefined,
    },
    reason: "repair_allowed",
  };
}

async function doFastSportsRepairCompletion(o: Orphan, pick: CompletionPick, reason: string): Promise<boolean> {
  if (!clob || DRY_RUN) return false;
  const client = clob.client;
  const buyShares = pick.completionShares;
  o.attempts += 1;
  log(`orphan ${o.id} FAST_REPAIR (${reason}): buy complement ${pick.complementToken.slice(0, 10)}… ask=${pick.complementAsk.toFixed(4)} repairedCost=${(pick.repairedPackageCost ?? (o.fillPrice + pick.complementAsk)).toFixed(4)} bucket=${pick.repairEvidence?.bucket ?? "unknown"} roi=${pick.repairEvidence?.roiPct ?? "unknown"}% shares=${buyShares}`);
  let resp: unknown;
  try {
    resp = await postFakBuy(client, pick.complementToken, pick.complementAsk, buyShares);
    assertOrderResponse(resp, "sports_fast_repair");
  } catch (err: any) {
    resp = { error: err?.message ?? String(err) };
    log(`orphan ${o.id} fast repair order error: ${err?.message ?? String(err)}`);
  }
  const filled = roundShares(responseBuyShares(resp));
  const matched = roundShares(Math.min(o.shares, filled));
  const order: LiveOrder = {
    packageId: pick.candidate.packageId,
    createdAt: new Date().toISOString(),
    role: "completion",
    tokenId: pick.complementToken,
    side: "BUY",
    price: pick.complementAsk,
    size: filled,
    orderType: "FAK_FAST_REPAIR",
    response: {
      response: resp,
      repairedPackageCost: pick.repairedPackageCost,
      repairEvidence: pick.repairEvidence,
      manualReason: "sports orphan repaired by positive historical ROI bucket",
    },
  };

  if (matched >= SPORTS_ORPHAN_DUST_SHARES) {
    const existing = readJsonArray<LivePackage>(PACKAGES_PATH).find((row) => row.packageId === pick.candidate.packageId && row.status === "unwind_required");
    const record = packageRecord(pick.candidate, reconcileAddress, matched, false);
    if (existing) record.id = existing.id;
    record.status = "package_complete";
    record.createdAt = existing?.createdAt ?? record.createdAt;
    record.filledShares = matched;
    record.actualCost = matched * o.fillPrice + filled * pick.complementAsk;
    record.guaranteedFloor = matched;
    record.lockedFloorProfit = matched * pick.completionEdge;
    record.jackpotPayout = matched * pick.candidate.jackpotPayoutPerShare;
    record.prices.packageCost = pick.repairedPackageCost ?? (o.fillPrice + pick.complementAsk);
    if (o.role === "broad_yes") {
      record.prices.broadYesAsk = o.fillPrice;
      record.prices.narrowNoAsk = pick.complementAsk;
      if (record.packageLegs[0]) record.packageLegs[0].entryPrice = o.fillPrice;
      if (record.packageLegs[1]) record.packageLegs[1].entryPrice = pick.complementAsk;
    } else {
      record.prices.broadYesAsk = pick.complementAsk;
      record.prices.narrowNoAsk = o.fillPrice;
      if (record.packageLegs[0]) record.packageLegs[0].entryPrice = pick.complementAsk;
      if (record.packageLegs[1]) record.packageLegs[1].entryPrice = o.fillPrice;
    }
    record.failureReason = `sports_fast_repair_from_orphan ${o.id} bucket=${pick.repairEvidence?.bucket ?? "unknown"} roi=${pick.repairEvidence?.roiPct ?? "unknown"}%`;
    record.updatedAt = new Date().toISOString();
    persist(record, [order]);
    o.shares = roundShares(o.shares - matched);
    o.note = `fast_repaired matched=${matched} ask=${pick.complementAsk.toFixed(4)} repairedCost=${record.prices.packageCost.toFixed(4)} residual=${o.shares}`;
    if (o.shares + EPSILON < SPORTS_ORPHAN_DUST_SHARES) o.status = "completed";
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} FAST_REPAIR result matched=${matched} filled=${filled} residual=${o.shares} status=${o.status}`);
    return true;
  }

  appendJsonArray(ORDERS_PATH, [order]);
  o.note = `fast_repair filled=0 ask=${pick.complementAsk.toFixed(4)}; falling back to immediate unwind`;
  o.updatedAt = new Date().toISOString();
  saveOrphans();
  log(`orphan ${o.id} FAST_REPAIR filled=0; falling back to immediate unwind`);
  return false;
}

async function processOrphan(o: Orphan) {
  if (orphanInFlight.has(o.id)) return;
  orphanInFlight.add(o.id);
  try {
    if (!(await syncOrphanToUnpairedBalance(o, "preflight"))) return;
    if (o.shares + EPSILON < ORPHAN_MIN_SHARES) { // dust — flatten it
      await doUnwind(o, `dust shares=${o.shares}`);
      return;
    }
    // Expiry guard: never roll into a directional settlement.
    if (o.endDate) {
      const t = Date.parse(o.endDate);
      // Well past expiry: the market has resolved. Close terminally instead of
      // spinning "unwind deferred: no bid to sell into" on a worthless loser
      // every poll forever (winners are auto-redeemed by Polymarket).
      if (Number.isFinite(t) && Date.now() >= t + ORPHAN_RESOLVED_GRACE_MS) {
        await resolveExpiredOrphan(o);
        return;
      }
      if (Number.isFinite(t) && Date.now() >= t - ORPHAN_EXPIRY_BUFFER_MS) {
        await doUnwind(o, `near_expiry endDate=${o.endDate}`);
        return;
      }
    }
    // Tight price stop (also checked reactively on the WS hot path).
    const bid = orphanBestBid(o);
    if (bid > 0 && bid + EPSILON <= o.fillPrice - ORPHAN_STOP_CENTS) {
      await doUnwind(o, `price_ran_away bid=${bid.toFixed(4)} fill=${o.fillPrice.toFixed(4)}`);
      return;
    }
    const quotes = await orphanLadder(o);
    if (quotes.length === 0) return; // transient fetch failure; retry next sweep
    const { pick, structuralCount } = findCompletion(o, quotes);
    if (structuralCount === 0) {
      await doUnwind(o, "stranded no structurally-valid complement in ladder");
      return;
    }
    if (pick) await doCompletion(o, pick);
    else if (await maybeTopUpDustAndExit(o, "no_positive_completion")) return;
    else await maybePostNoLossExitLimit(o, "no_positive_completion");
    // else: complements exist but none positive-EV/no-loss exit — keep holding. Lossy exits require an explicit env allowance.
  } finally {
    orphanInFlight.delete(o.id);
  }
}

// Buy the chosen complement to re-pair the orphan into a positive-EV package.
// Caller owns the orphanInFlight guard.
async function doCompletion(o: Orphan, pick: CompletionPick) {
  if (!clob || DRY_RUN) return;
  const client = clob.client;
  {
    const minNotionalShares = pick.complementAsk > 0
      ? Math.ceil((MIN_MARKETABLE_BUY_USD / pick.complementAsk) * 100) / 100
      : Number.POSITIVE_INFINITY;
    const buyShares = Math.max(pick.completionShares, minNotionalShares);
    const overfillShares = Math.max(0, buyShares - o.shares);
    const completionCost = buyShares * pick.complementAsk;
    const protectedShares = Math.min(o.shares, buyShares);
    const protectedEdge = protectedShares * (1 - o.fillPrice - pick.complementAsk);
    const extraComplementCost = overfillShares * pick.complementAsk;
    const spendableUsd = spendableUsdAfterReservations();
    if (Number.isFinite(spendableUsd) && completionCost > spendableUsd + EPSILON) {
      const now = Date.now();
      const last = completionSkipAttemptAt.get(o.id) ?? 0;
      if (now - last >= ORPHAN_COMPLETION_SKIP_LOG_MS) {
        completionSkipAttemptAt.set(o.id, now);
        o.attempts += 1;
        o.note = `completion skipped: insufficient cash cost=${completionCost.toFixed(4)} spendable=${spendableUsd.toFixed(4)} ask=${pick.complementAsk.toFixed(4)}`;
        o.updatedAt = new Date().toISOString();
        saveOrphans();
        log(`orphan ${o.id} completion skipped: insufficient cash cost=$${completionCost.toFixed(4)} spendable=$${spendableUsd.toFixed(4)} ask=${pick.complementAsk.toFixed(4)} shares=${buyShares.toFixed(2)}`);
      }
      return;
    }
    if (
      !Number.isFinite(buyShares)
      || completionCost + EPSILON < MIN_MARKETABLE_BUY_USD
      || protectedEdge + EPSILON < extraComplementCost
    ) {
      const now = Date.now();
      const last = completionSkipAttemptAt.get(o.id) ?? 0;
      if (now - last >= ORPHAN_COMPLETION_SKIP_LOG_MS) {
        completionSkipAttemptAt.set(o.id, now);
        o.attempts += 1;
        o.note = `completion skipped: minNotional buyShares=${buyShares.toFixed(2)} cost=${completionCost.toFixed(4)} protectedEdge=${protectedEdge.toFixed(4)} extraCost=${extraComplementCost.toFixed(4)}`;
        o.updatedAt = new Date().toISOString();
        saveOrphans();
        log(`orphan ${o.id} completion skipped: complement notional below min or overfill uneconomic ask=${pick.complementAsk.toFixed(4)} requested=${pick.completionShares} minShares=${minNotionalShares.toFixed(2)} orphanShares=${o.shares} protectedEdge=${protectedEdge.toFixed(4)} extraCost=${extraComplementCost.toFixed(4)}`);
      }
      return;
    }
    o.attempts += 1;
    log(`orphan ${o.id} COMPLETE attempt: buy complement ${pick.complementToken.slice(0, 10)}… ask=${pick.complementAsk.toFixed(4)} edge=${(pick.completionEdge * 100).toFixed(2)}c shares=${buyShares} orphanShares=${o.shares}${buyShares > pick.completionShares ? ` minNotionalTopUp=${(buyShares - pick.completionShares).toFixed(2)}` : ""}`);
    const before = await reconcileTokenBalance(reconcileAddress, pick.complementToken);
    let resp: unknown;
    try {
      resp = await postFakBuy(client, pick.complementToken, pick.complementAsk, buyShares);
      assertOrderResponse(resp, "completion");
    } catch (err: any) {
      resp = { error: err?.message ?? String(err) };
      log(`orphan ${o.id} completion order error: ${err?.message ?? String(err)}`);
    }
    await waitForFill(pick.complementToken, FILL_WAIT_DAEMON_MS);
    const after = await reconcileTokenBalance(reconcileAddress, pick.complementToken);
    const filled = roundShares(after - before);
    const matched = roundShares(Math.min(o.shares, filled));

    const order: LiveOrder = {
      packageId: pick.candidate.packageId,
      createdAt: new Date().toISOString(),
      role: "completion",
      tokenId: pick.complementToken,
      side: "BUY",
      price: pick.complementAsk,
      size: filled,
      orderType: "FAK",
      response: resp,
    };

    if (matched >= 0.01) {
      const record = packageRecord(pick.candidate, reconcileAddress, matched, false);
      record.status = "package_complete";
      record.filledShares = matched;
      record.actualCost = matched * o.fillPrice + filled * pick.complementAsk;
      record.guaranteedFloor = matched;
      record.lockedFloorProfit = matched * pick.completionEdge;
      record.jackpotPayout = matched * pick.candidate.jackpotPayoutPerShare;
      record.failureReason = `completed_from_orphan ${o.id} (re-paired naked ${o.role})`;
      record.updatedAt = new Date().toISOString();
      persist(record, [order]);
      o.shares = roundShares(o.shares - matched);
      o.note = `completed ${matched} via ${pick.complementToken.slice(0, 10)}…`;
      log(`orphan ${o.id} COMPLETED ${matched} shares edge=${(pick.completionEdge * 100).toFixed(2)}c; residual=${o.shares}`);
    } else {
      appendJsonArray(ORDERS_PATH, [order]);
      log(`orphan ${o.id} completion filled 0 (complement ask moved); will retry`);
    }
    if (o.shares + EPSILON < ORPHAN_MIN_SHARES) o.status = "completed";
    o.updatedAt = new Date().toISOString();
    saveOrphans();
  }
}

// If residual orphan dust is below the market's minimum SELL size, it cannot be
// flattened directly. Top up the same token only when the top-up order is
// CLOB-valid and the combined position can immediately sell at breakeven or
// better. Otherwise we leave the dust under the normal stop/completion watch.
async function maybeTopUpDustAndExit(o: Orphan, reason: string): Promise<boolean> {
  if (!clob || DRY_RUN) return false;
  const last = dustExitAttemptAt.get(o.id) ?? 0;
  if (Date.now() - last < DUST_EXIT_RETRY_MS) return false;
  const client = clob.client;
  const book = await fetchBook(arbConfig, o.tokenId);
  if (o.shares + EPSILON >= book.minOrderSize) return false;
  if (!(book.ask > 0) || !(book.bid > 0)) return false;
  const deficit = Math.max(0, book.minOrderSize - o.shares);
  const topUpShares = Math.max(book.minOrderSize, Math.ceil((deficit - EPSILON) * 100_000) / 100_000);
  const maxTopUpPrice = Math.floor(((book.bid * (o.shares + topUpShares)) - (o.shares * o.fillPrice) + EPSILON) / topUpShares * 1000) / 1000;
  if (!(maxTopUpPrice > 0)) return false;
  const topUpPrice = Math.min(book.ask, maxTopUpPrice);
  if (!(topUpPrice > 0)) return false;

  const combinedShares = roundShares(o.shares + topUpShares);
  const avgCost = ((o.shares * o.fillPrice) + (topUpShares * topUpPrice)) / combinedShares;
  const noLossSellPrice = Math.ceil((avgCost - EPSILON) * 1000) / 1000;
  if (book.bid + EPSILON < noLossSellPrice || book.bidSize + EPSILON < combinedShares) return false;

  o.attempts += 1;
  dustExitAttemptAt.set(o.id, Date.now());
  log(`orphan ${o.id} DUST_EXIT (${reason}): limit top-up ${topUpShares} @ ${topUpPrice.toFixed(4)} then sell ${combinedShares} @ ${noLossSellPrice.toFixed(4)} avg=${avgCost.toFixed(6)}`);
  const before = await reconcileTokenBalance(reconcileAddress, o.tokenId);
  let buyResp: unknown;
  let topUpOrderId: string | undefined;
  try {
    buyResp = await postLimitBuy(client, o.tokenId, topUpPrice, topUpShares);
    assertOrderResponse(buyResp, "dust_topup");
    topUpOrderId = orderId(buyResp);
  } catch (err: any) {
    buyResp = { error: err?.message ?? String(err) };
    log(`orphan ${o.id} dust top-up error: ${err?.message ?? String(err)}`);
  }
  await waitForFill(o.tokenId, DUST_EXIT_LIMIT_WAIT_MS);
  if (topUpOrderId) {
    try { await client.cancelOrder({ orderID: topUpOrderId }); }
    catch (err: any) { log(`orphan ${o.id} dust top-up cancel warning: ${err?.message ?? String(err)}`); }
  }
  const afterBuy = await reconcileTokenBalance(reconcileAddress, o.tokenId);
  const bought = roundShares(afterBuy - before);
  const buyOrder: LiveOrder = {
    packageId: o.packageId,
    createdAt: new Date().toISOString(),
    role: "completion",
    tokenId: o.tokenId,
    side: "BUY",
    price: topUpPrice,
    size: bought,
    orderType: "GTC",
    response: buyResp,
  };
  appendJsonArray(ORDERS_PATH, [buyOrder]);
  if (bought <= 0) {
    o.note = `dust top-up filled 0 (${reason})`;
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    return true;
  }

  const sellShares = roundShares(o.shares + bought);
  const realizedIfSold = sellShares * noLossSellPrice - (o.shares * o.fillPrice) - (bought * topUpPrice);
  if (realizedIfSold + EPSILON < 0) {
    o.shares = sellShares;
    o.note = `dust top-up bought=${bought}; no-loss sell no longer available`;
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} DUST_EXIT deferred after top-up: sell would lose ${realizedIfSold.toFixed(4)} residual=${o.shares}`);
    return true;
  }
  let sellResp: unknown;
  try {
    sellResp = await postFakSell(client, o.tokenId, noLossSellPrice, sellShares);
    assertOrderResponse(sellResp, "dust_exit");
  } catch (err: any) {
    sellResp = { error: err?.message ?? String(err) };
    log(`orphan ${o.id} dust exit sell error: ${err?.message ?? String(err)}`);
  }
  await waitForFill(o.tokenId, FILL_WAIT_DAEMON_MS);
  const afterSell = await reconcileTokenBalance(reconcileAddress, o.tokenId);
  const sold = roundShares(afterBuy - afterSell);
  const sellOrder: LiveOrder = {
    packageId: o.packageId,
    createdAt: new Date().toISOString(),
    role: "unwind",
    tokenId: o.tokenId,
    side: "SELL",
    price: noLossSellPrice,
    size: sold,
    orderType: "FAK",
    response: sellResp,
  };
  appendJsonArray(ORDERS_PATH, [sellOrder]);

  const realized = sold * noLossSellPrice - Math.min(sold, o.shares) * o.fillPrice - Math.max(0, sold - o.shares) * topUpPrice;
  o.shares = roundShares(o.shares + bought - sold);
  o.note = `dust_exit bought=${bought} sold=${sold} realized=${realized.toFixed(4)} (${reason})`;
  if (o.shares + EPSILON < ORPHAN_MIN_SHARES) o.status = sold > 0 ? "unwound" : "stranded";
  o.updatedAt = new Date().toISOString();
  saveOrphans();
  log(`orphan ${o.id} DUST_EXIT result bought=${bought} sold=${sold} realized=${realized.toFixed(4)} residual=${o.shares}`);
  return true;
}


async function maybePostNoLossExitLimit(o: Orphan, reason: string): Promise<boolean> {
  if (!clob || DRY_RUN) return false;
  if ((o as any).noLossSellOrderId) return true;
  const last = dustExitAttemptAt.get(`${o.id}:no_loss_exit`) ?? 0;
  if (Date.now() - last < DUST_EXIT_RETRY_MS) return false;
  const book = await fetchBook(arbConfig, o.tokenId);
  if (o.shares + EPSILON < book.minOrderSize) return false;
  const minExitPrice = Math.max(0.001, Math.ceil((o.fillPrice - ORPHAN_MAX_UNWIND_LOSS_CENTS - EPSILON) * 1000) / 1000);
  dustExitAttemptAt.set(`${o.id}:no_loss_exit`, Date.now());
  o.attempts += 1;
  log(`orphan ${o.id} NO_LOSS_EXIT (${reason}): rest SELL ${o.shares} @ ${minExitPrice.toFixed(4)} fill=${o.fillPrice.toFixed(4)} maxLoss=${ORPHAN_MAX_UNWIND_LOSS_CENTS.toFixed(4)}`);
  let resp: unknown;
  try {
    resp = await postLimitSell(clob.client, o.tokenId, minExitPrice, o.shares);
    assertOrderResponse(resp, "no_loss_exit");
    (o as any).noLossSellOrderId = orderId(resp);
  } catch (err: any) {
    resp = { error: err?.message ?? String(err) };
    log(`orphan ${o.id} no-loss exit order error: ${err?.message ?? String(err)}`);
  }
  appendJsonArray(ORDERS_PATH, [{
    packageId: o.packageId,
    createdAt: new Date().toISOString(),
    role: "unwind",
    tokenId: o.tokenId,
    side: "SELL",
    price: minExitPrice,
    size: 0,
    orderType: "GTC",
    response: resp,
  }]);
  o.note = `no_loss_exit resting @ ${minExitPrice.toFixed(4)} (${reason})`;
  o.updatedAt = new Date().toISOString();
  saveOrphans();
  return true;
}

// Terminally dispose of an orphan whose market is well past expiry (resolved).
// We never roll into a directional settlement, so there is nothing to trade: if
// a residual bid somehow still exists we take it, otherwise we close the record.
// Closing is financially safe — a resolved WINNER is auto-redeemed by Polymarket
// to the funder regardless of this record (and would already have zeroed out via
// the balance reconcile at the top of processOrphan), and a resolved LOSER has no
// bid and is worth $0. The point is to stop the infinite "no bid to sell into"
// retry loop that otherwise persists until a process restart archives the orphan.
// Caller owns the orphanInFlight guard.
async function resolveExpiredOrphan(o: Orphan) {
  if (!clob || DRY_RUN) return;
  const bid = orphanBestBid(o);
  if (bid > 0) {
    // Rare: a tradeable bid still exists post-expiry — flatten normally.
    await doUnwind(o, `post_expiry endDate=${o.endDate}`);
    return;
  }
  o.status = "completed";
  o.note = `resolved_post_expiry endDate=${o.endDate}: no bid, market settled; residual ${o.shares} sh treated as resolved (winner auto-redeems to funder, loser worthless)`;
  o.updatedAt = new Date().toISOString();
  saveOrphans();
  log(`orphan ${o.id} resolved_post_expiry: closed (residual ${o.shares} sh; market past endDate=${o.endDate} with no tradeable bid)`);
}

// FAK-sell the orphan to flatten it. Caller owns the orphanInFlight guard.
async function doUnwind(o: Orphan, reason: string) {
  if (!clob || DRY_RUN) return;
  const client = clob.client;
  {
    let bid = orphanBestBid(o);
    if (!(bid > 0)) {
      try {
        const raw = await fetchRawBook(o.tokenId);
        bid = raw.bids.reduce((b, l) => (l.price > b ? l.price : b), 0);
      } catch { /* keep 0 */ }
    }
    const minExitPrice = Math.max(0.001, Math.ceil((o.fillPrice - ORPHAN_MAX_UNWIND_LOSS_CENTS - EPSILON) * 1000) / 1000);
    if (!(bid > 0)) {
      const throttleKey = `orphan-nobid:${o.id}`;
      const nowMs = Date.now();
      if (nowMs - (lastSkipLogAt.get(throttleKey) ?? 0) >= SKIP_LOG_THROTTLE_MS) {
        lastSkipLogAt.set(throttleKey, nowMs);
        log(`orphan ${o.id} unwind deferred (${reason}): no bid to sell into`);
      }
      await maybePostNoLossExitLimit(o, reason);
      return; // stay "completing"; retry next sweep
    }
    if (bid + EPSILON < minExitPrice) {
      log(`orphan ${o.id} unwind blocked (${reason}): bid=${bid.toFixed(4)} minExit=${minExitPrice.toFixed(4)} fill=${o.fillPrice.toFixed(4)}`);
      await maybePostNoLossExitLimit(o, reason);
      return;
    }
    o.attempts += 1;
    log(`orphan ${o.id} UNWIND (${reason}): FAK-sell ${o.shares} @ bid=${bid.toFixed(4)} fill=${o.fillPrice.toFixed(4)} minExit=${minExitPrice.toFixed(4)}`);
    const before = await reconcileTokenBalance(reconcileAddress, o.tokenId);
    let resp: unknown;
    try {
      resp = await postFakSell(client, o.tokenId, bid, o.shares);
      assertOrderResponse(resp, "unwind");
    } catch (err: any) {
      resp = { error: err?.message ?? String(err) };
      log(`orphan ${o.id} unwind order error: ${err?.message ?? String(err)}`);
    }
    await waitForFill(o.tokenId, FILL_WAIT_DAEMON_MS);
    const after = await reconcileTokenBalance(reconcileAddress, o.tokenId);
    const sold = roundShares(before - after);
    const order: LiveOrder = {
      packageId: o.packageId,
      createdAt: new Date().toISOString(),
      role: "unwind",
      tokenId: o.tokenId,
      side: "SELL",
      price: bid,
      size: sold,
      orderType: "FAK",
      response: resp,
    };
    appendJsonArray(ORDERS_PATH, [order]);
    o.shares = roundShares(o.shares - sold);
    const realized = sold * (bid - o.fillPrice);
    o.note = `unwound ${sold} @ ${bid.toFixed(4)} realized=${realized.toFixed(4)} (${reason})`;
    if (o.shares + EPSILON < ORPHAN_MIN_SHARES) o.status = sold > 0 ? "unwound" : "stranded";
    o.updatedAt = new Date().toISOString();
    saveOrphans();
    log(`orphan ${o.id} ${o.status} sold=${sold} realized=${realized.toFixed(4)} residual=${o.shares}`);
  }
}

function orphanLoop() {
  if (DRY_RUN) return;
  for (const o of activeOrphans()) void processOrphan(o);
}

async function reconcileOrphansAtStartup() {
  if (DRY_RUN || !reconcileAddress) return;
  for (const o of activeOrphans()) {
    try {
      await syncOrphanToUnpairedBalance(o, "at startup");
    } catch (err: any) {
      log(`orphan ${o.id} startup reconcile failed: ${err?.message ?? String(err)}`);
    }
  }
  const active = activeOrphans().length;
  if (active) log(`orphans: ${active} active (completing) loaded`);
}

async function recoverIncompleteSportsIntentsAtStartup() {
  if (DRY_RUN || !reconcileAddress) return;
  const rows = readJsonArray<LivePackage>(PACKAGES_PATH);
  let changed = false;
  for (const row of rows) {
    const isSports = ["MLB", "NBA", "SOCCER"].includes(String(row.asset).toUpperCase())
      || /^(mlb|nba|fifwc|soccer)-/i.test(row.eventSlug);
    if (!isSports) continue;
    if (!["leg1_submitted", "leg1_filled", "leg2_submitted"].includes(row.status)) continue;
    if (!/sports_cheap_first_intent/i.test(row.failureReason ?? "")) continue;

    const [broadUnpaired, narrowUnpaired] = await Promise.all([
      unpairedTokenBalance(row.tokenIds.broadYes, row.packageId),
      unpairedTokenBalance(row.tokenIds.narrowNo, row.packageId),
    ]);
    const broadFilled = roundShares(broadUnpaired);
    const narrowFilled = roundShares(narrowUnpaired);
    const matched = roundShares(Math.min(broadFilled, narrowFilled));
    const nakedShares = roundShares(Math.abs(broadFilled - narrowFilled));
    const nakedRole: "broad_yes" | "narrow_no" | null =
      broadFilled > narrowFilled ? "broad_yes" : narrowFilled > broadFilled ? "narrow_no" : null;
    row.filledShares = matched;
    row.actualCost = broadFilled * row.prices.broadYesAsk + narrowFilled * row.prices.narrowNoAsk;
    row.guaranteedFloor = matched;
    row.lockedFloorProfit = Math.max(0, matched - row.actualCost);
    const jackpotPerShare = row.intendedShares > 0 ? row.jackpotPayout / row.intendedShares : 0;
    row.jackpotPayout = matched * jackpotPerShare;
    row.updatedAt = new Date().toISOString();

    if (matched > 0) {
      row.status = "package_complete";
      row.failureReason = nakedRole
        ? `recovered_sports_intent_partial matched=${matched} naked_${nakedRole}=${nakedShares} -> immediate_exit`
        : undefined;
    } else {
      row.status = "unwind_required";
      row.failureReason = nakedRole
        ? `recovered_sports_intent_naked_${nakedRole}=${nakedShares} -> immediate_exit`
        : "recovered_sports_intent_no_fill";
    }

    if (nakedRole && nakedShares >= SPORTS_ORPHAN_DUST_SHARES) {
      const orphan = registerOrphanFromPackageRecord(row, nakedRole, nakedShares, "recovered incomplete sports cheap-first intent at startup");
      appendQuarantine({
        quarantinedAt: new Date().toISOString(),
        reason: `recovered_incomplete_sports_intent: ${nakedRole}=${nakedShares}`,
        packageId: row.packageId,
        eventSlug: row.eventSlug,
        asset: row.asset,
        tokenIds: [row.tokenIds.broadYes, row.tokenIds.narrowNo].filter(Boolean),
        details: { orphanId: orphan.id, role: nakedRole, shares: nakedShares, matched },
      });
    }
    changed = true;
    log(`recovered sports intent ${row.packageId}: broad=${broadFilled} narrow=${narrowFilled} matched=${matched} naked=${nakedShares}${nakedRole ? `(${nakedRole})` : ""}`);
  }
  if (changed) writeJsonArray(PACKAGES_PATH, rows);
}

// ─── Evaluation entry point (called on every relevant book delta) ───

function evaluateToken(tokenId: string) {
  const keys = tokenToPackages.get(tokenId);
  if (!keys || keys.size === 0) return;
  const ready: Array<{ pkg: WatchPackage; legs: LiveLegs; candidate: Candidate }> = [];
  for (const key of keys) {
    const pkg = packages.get(key);
    if (!pkg) continue;
    const legs = liveLegs(pkg);
    if (!legs) continue;
    const candidate = liveCandidate(pkg.base, legs);
    if (candidate.asset === "SOCCER") recordSoccerEventShapeCost(candidate);
    recordNearMiss(candidate);
    if (!passesDynamicGate(candidate)) {
      void emitShadowCapture(pkg, candidate);
      continue;
    }
    const strategyGate = sportsStrategyGate(candidate);
    if (strategyGate.reason) {
      const now = Date.now();
      const last = lastSkipLogAt.get(`${pkg.key}:strategy`) ?? 0;
      if (now - last >= SKIP_LOG_THROTTLE_MS) {
        lastSkipLogAt.set(`${pkg.key}:strategy`, now);
        log(`shadow ${pkg.key}: ${strategyGate.reason} cost=${candidate.packageCost.toFixed(4)} strategy=${strategyGate.decision.comparisonGroup}`);
      }
      void emitShadowCapture(pkg, candidate, {
        reason: strategyGate.reason,
        strategyDecision: strategyGate.decision,
        abTestArm: "coarse_shadow",
      });
      continue;
    }
    if (isSportsCandidate(candidate)) {
      log(`sports_ws_gate_pass ${pkg.key}: wsCost=${candidate.packageCost.toFixed(4)} wsSpread=${candidate.maxSpread.toFixed(4)} edge=${(candidate.lockedEdge * 100).toFixed(2)}c size=${candidate.availableSize.toFixed(2)} strategy=${strategyGate.decision.comparisonGroup}`);
    }
    ready.push({ pkg, legs, candidate });
  }
  if (ready.length === 0) return;

  const soccerReady = ready.filter((row) => row.candidate.asset === "SOCCER");
  const otherReady = ready.filter((row) => row.candidate.asset !== "SOCCER");
  const soccerExecuteKeys = SOCCER_PREFER_CHEAPEST_EVENT_PACKAGE
    ? new Set(pickCheapestSoccerPackagesByEvent(soccerReady.map((row) => ({ key: row.pkg.key, candidate: row.candidate }))).map((row) => row.key))
    : new Set(soccerReady.map((row) => row.pkg.key));

  for (const row of otherReady) void tryExecute(row.pkg, row.legs);
  for (const row of soccerReady) {
    if (!soccerExecuteKeys.has(row.pkg.key)) continue;
    void tryExecute(row.pkg, row.legs);
  }
}

// ─── Market websocket ───

function handleMarketMessage(raw: WebSocket.RawData) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages: any[] = Array.isArray(data) ? data : [data];
  const touched = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;

    // Full book snapshot
    if (eventType === "book" || (msg.asset_id && (msg.bids || msg.asks || msg.buys || msg.sells))) {
      const tokenId = msg.asset_id;
      if (!tokenId) continue;
      const toLevels = (rows: any) => (Array.isArray(rows) ? rows : [])
        .map((r: any) => ({ price: Number(r.price), size: Number(r.size) }))
        .filter((r: any) => Number.isFinite(r.price) && Number.isFinite(r.size));
      applySnapshot(tokenId, toLevels(msg.bids ?? msg.buys), toLevels(msg.asks ?? msg.sells));
      touched.add(tokenId);
      continue;
    }

    // Incremental level changes (price_changes / changes)
    const changes: any[] = msg.price_changes ?? msg.changes ?? [];
    for (const ch of changes) {
      const tokenId = ch.asset_id ?? msg.asset_id;
      if (!tokenId) continue;
      applyLevelChange(tokenId, String(ch.side ?? ""), Number(ch.price), Number(ch.size));
      touched.add(tokenId);
    }
  }
  for (const tokenId of touched) {
    evaluateToken(tokenId);
    maybeOrphanStop(tokenId);
  }
}

function connectMarketWs(attempt = 0) {
  if (shuttingDown) return;
  const tokens = watchedTokens();
  if (tokens.length === 0) {
    setTimeout(() => connectMarketWs(0), 5_000);
    return;
  }
  const ws = new WebSocket(MARKET_WS_URL);
  marketWs = ws;
  let ping: ReturnType<typeof setInterval> | undefined;
  let healthy = false;

  ws.on("open", async () => {
    healthy = true;
    log(`market WS connected; subscribing ${tokens.length} tokens`);
    ws.send(JSON.stringify({ assets_ids: tokens, type: "market" }));
    ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, PING_MS);
    // Re-seed every book over REST so depth (and thus ask size) is accurate
    // even before the first delta arrives.
    await seedBooks(tokens);
  });
  ws.on("message", (raw) => handleMarketMessage(raw));
  ws.on("error", (err) => log(`market WS error: ${err.message}`));
  ws.on("close", () => {
    if (ping) clearInterval(ping);
    if (shuttingDown) return;
    // A healthy connection that closed (e.g. our watchlist-refresh cycle or a
    // transient drop) reconnects immediately; only genuine connect failures use
    // exponential backoff.
    const nextAttempt = healthy ? 0 : attempt + 1;
    const delay = healthy ? RECONNECT_BASE_MS : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    log(`market WS closed; reconnecting in ${delay}ms`);
    setTimeout(() => connectMarketWs(nextAttempt), delay);
  });
}

async function seedBooks(tokens: string[]) {
  if (BOOK_SEED_MAX_PER_RECONNECT === 0) {
    log(`book seed skipped: disabled by ARB_DAEMON_BOOK_SEED_MAX_PER_RECONNECT=0`);
    return;
  }
  if (Date.now() < clobRestCooldownUntil) {
    log(`book seed skipped: CLOB REST cooldown ${Math.ceil((clobRestCooldownUntil - Date.now()) / 1000)}s`);
    return;
  }
  const now = Date.now();
  const due = tokens
    .filter((tokenId) => now - (lastBookSeedAt.get(tokenId) ?? 0) >= BOOK_SEED_MIN_INTERVAL_MS)
    .sort((a, b) => tokenSeedPriority(a) - tokenSeedPriority(b))
    .slice(0, BOOK_SEED_MAX_PER_RECONNECT);
  const tennisDue = due.filter((tokenId) => tokenSeedPriority(tokenId) === 0).length;
  let seeded = 0;
  let errors = 0;
  for (const tokenId of due) {
    try {
      const { bids, asks } = await fetchRawBook(tokenId);
      applySnapshot(tokenId, bids, asks);
      lastBookSeedAt.set(tokenId, Date.now());
      evaluateToken(tokenId);
      seeded += 1;
    } catch {
      errors += 1;
      if (Date.now() < clobRestCooldownUntil) break;
    }
  }
  if (due.length || tokens.length) {
    log(`book seed: seeded=${seeded}/${due.length} tennisDue=${tennisDue} errors=${errors} tokens=${tokens.length}${Date.now() < clobRestCooldownUntil ? ` cooldown=${Math.ceil((clobRestCooldownUntil - Date.now()) / 1000)}s` : ""}`);
  }
}

function tokenSeedPriority(tokenId: string): number {
  const packageKeys = tokenToPackages.get(tokenId);
  if (!packageKeys?.size) return 3;
  let priority = 2;
  for (const key of packageKeys) {
    const asset = packages.get(key)?.base.asset;
    if (asset === "TENNIS" || asset === "WOMENS_TENNIS") return 0;
    if (asset === "MLB" || asset === "SOCCER") priority = Math.min(priority, 1);
  }
  return priority;
}

// ─── User websocket (instant fills) ───

function handleUserMessage(raw: WebSocket.RawData) {
  let data: any;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages: any[] = Array.isArray(data) ? data : [data];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const eventType = msg.event_type ?? msg.type;
    if (eventType !== "trade") continue;
    const tokenId = msg.asset_id;
    const status = String(msg.status ?? "").toUpperCase();
    // MATCHED / CONFIRMED both mean shares moved; signal the waiter so leg
    // sizing proceeds immediately instead of waiting the full fill window.
    if (tokenId && (status === "MATCHED" || status === "CONFIRMED" || !status)) {
      signalFill(tokenId);
    }
  }
}

async function fetchConditionIds(): Promise<string[]> {
  const marketIds = new Set<string>();
  for (const pkg of packages.values()) {
    marketIds.add(pkg.base.broad.marketId);
    marketIds.add(pkg.base.narrow.marketId);
  }
  const conditionIds = new Set<string>();
  for (const id of marketIds) {
    try {
      const res = await fetch(`${GAMMA_API}/markets/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json", "User-Agent": "polymarket-arb-daemon/1.0" },
      });
      if (!res.ok) continue;
      const market = await res.json() as { conditionId?: string };
      if (market?.conditionId) conditionIds.add(market.conditionId);
    } catch {
      // best effort; fills still reconcile via RPC
    }
  }
  return [...conditionIds];
}

async function connectUserWs(attempt = 0) {
  if (shuttingDown || DRY_RUN || !clob) return;
  const conditionIds = await fetchConditionIds();
  const ws = new WebSocket(USER_WS_URL);
  userWs = ws;
  let ping: ReturnType<typeof setInterval> | undefined;
  let healthy = false;

  ws.on("open", () => {
    healthy = true;
    log(`user WS connected; subscribing ${conditionIds.length} markets`);
    ws.send(JSON.stringify({
      auth: { apiKey: clob!.creds.key, secret: clob!.creds.secret, passphrase: clob!.creds.passphrase },
      markets: conditionIds,
      type: "user",
    }));
    ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, PING_MS);
  });
  ws.on("message", (raw) => handleUserMessage(raw));
  ws.on("error", (err) => log(`user WS error: ${err.message}`));
  ws.on("close", () => {
    if (ping) clearInterval(ping);
    if (shuttingDown) return;
    const nextAttempt = healthy ? 0 : attempt + 1;
    const delay = healthy ? RECONNECT_BASE_MS : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    setTimeout(() => connectUserWs(nextAttempt), delay);
  });
}

// ─── Periodic off-hot-path work ───

async function refreshBalance() {
  const funder = POLYMARKET_FUNDER_ADDRESS ?? reconcileAddress;
  if (!funder) return;
  let lastError: any;
  for (let attempt = 1; attempt <= BALANCE_REFRESH_RETRIES; attempt += 1) {
    try {
      const probe = await proxyCollateralProbe(funder);
      cachedFunderBalance = probe.collateralBalance;
      cachedFunderAllowance = probe.exchangeV2Allowance;
      balanceKnown = true;
      balanceRefreshFailures = 0;
      lastBalanceFailureLogAt = 0;
      if (!lowBalance()) pausedForLowBalanceLogged = false;
      log(`balance refresh: pUSD=${cachedFunderBalance.toFixed(6)} exchangeV2Allowance=${cachedFunderAllowance.toFixed(2)}`);
      return;
    } catch (err: any) {
      lastError = err;
      if (attempt < BALANCE_REFRESH_RETRIES) await sleep(BALANCE_REFRESH_RETRY_DELAY_MS);
    }
  }
  balanceRefreshFailures += 1;
  const now = Date.now();
  if (now - lastBalanceFailureLogAt >= BALANCE_REFRESH_FAILURE_LOG_MS) {
    lastBalanceFailureLogAt = now;
    log(`balance refresh failed x${balanceRefreshFailures} (keeping last known=${balanceKnown}): ${lastError?.message ?? String(lastError)}`);
  }
}

function flushLedger() {
  if (!GIT_PUSH) return;
  const child = spawn("bash", ["-lc", "git add data/polymarket-live-packages.json data/polymarket-live-orders.json data/polymarket-live-orphans.json data/archive 2>/dev/null && git diff --cached --quiet || git commit -m 'arb-daemon: ledger update' -q && git push -q"], {
    stdio: "ignore",
    detached: false,
  });
  child.on("error", (err) => log(`ledger git push failed: ${err.message}`));
}

// ─── Startup ───

async function main() {
  installHttpKeepAlive();
  log(`starting; mode=${DRY_RUN ? "DRY_RUN" : "REAL"} enabled=${ENABLED} hardDisabled=${HARD_DISABLED}`);
  log(`gates: maxPackage=$${MAX_PACKAGE_USD} maxDaily=$${MAX_DAILY_USD} maxOpen=${MAX_OPEN_PACKAGES} maxPerMin=${MAX_PER_MIN} minEdge=${(MIN_EDGE * 100).toFixed(2)}c minTouch=${MIN_AVAILABLE_SHARES} maxSpread=${MAX_SPREAD} sportsMinEdge=${(SPORTS_MIN_EDGE * 100).toFixed(2)}c sportsMaxSpread=${SPORTS_MAX_SPREAD} sportsMaxPairedShares=${SPORTS_MAX_PAIRED_SHARES > 0 ? SPORTS_MAX_PAIRED_SHARES : "none"} sportsHedgeFill=${SPORTS_HEDGE_BREAKEVEN_FILL ? `breakeven(minEdge=${(SPORTS_HEDGE_COMPLETION_MIN_EDGE * 100).toFixed(2)}c)` : "snapshot_ask"} sportsPrewarmMeta=${SPORTS_PREWARM_ORDER_META ? "1" : "0"}`);
  log(`sports cost ranges: ${SPORTS_ALLOWED_COST_RANGES.length ? SPORTS_ALLOWED_COST_RANGES.map((range) => range.label).join(",") : "unrestricted"}`);
  log(`sports safety: live execution ${ALLOW_SPORTS_LIVE_EXECUTION ? "ENABLED (cheap-leg-first; no full expensive leg before hedge fill)" : "BLOCKED by ARB_DAEMON_ALLOW_SPORTS_LIVE_EXECUTION=0"}; nbaBatch=${ENABLE_NBA_BATCH_EXECUTION ? "1" : "0"} nonAtomicOverride=${ALLOW_NBA_NON_ATOMIC_EXECUTION ? "1" : "0"}`);
  log(`submit hot path: postMode=${MONOTONIC_POST_MODE} responseFillFirst=${RESPONSE_FILL_FIRST ? "1" : "0"} httpKeepAlive=${HTTP_KEEP_ALIVE ? "1" : "0"}`);
  log(`watchlist throttle: eventConcurrency=${arbConfig.eventConcurrency} marketConcurrency=${arbConfig.marketConcurrency} sportsAutoDiscoveryDays=${SPORTS_AUTO_DISCOVERY_DAYS} soccerLimit=${SOCCER_DISCOVERY_LIMIT} bookSeedMax=${BOOK_SEED_MAX_PER_RECONNECT} bookSeedMinIntervalMs=${BOOK_SEED_MIN_INTERVAL_MS} clob429CooldownMs=${CLOB_REST_429_COOLDOWN_MS}`);
  log(`June breakeven filter: commodities<=${(JUNE_BREAKEVEN_COMMODITY_MAX_DISTANCE * 100).toFixed(1)}% crypto<=${(JUNE_BREAKEVEN_CRYPTO_MAX_DISTANCE * 100).toFixed(1)}% refreshMs=${SPOT_REFRESH_MS}`);
  log(`orphan policy: stop=${ORPHAN_STOP_CENTS} completionMargin=${ORPHAN_COMPLETION_MARGIN} expiryBufferMs=${ORPHAN_EXPIRY_BUFFER_MS} resolvedGraceMs=${ORPHAN_RESOLVED_GRACE_MS} pollMs=${ORPHAN_POLL_MS} (re-pair naked legs across ladder, else unwind; close terminally once past expiry)`);
  log(`large-orphan quarantine: maxNakedShares=${MAX_NAKED_SHARES_BEFORE_PAUSE} quarantineFile=${QUARANTINE_PATH} globalPauseFile=${PAUSE_PATH} pausedEventsFile=${PAUSED_EVENTS_PATH} (sports orphans pause per-event, not globally)`);

  const vpnGuard = new VpnGuard({
    socksProxy: SOCKS_PROXY,
    skipChecks: DRY_RUN || SKIP_VPN,
    onVpnDrop: (reason) => {
      console.error(`\n[VPN] *** VPN DROPPED *** ${reason}`);
      console.error(`[VPN] Halting arb daemon immediately — no further orders.`);
      process.exit(1);
    },
  });
  vpnGuard.activateProxy();
  if (!DRY_RUN) {
    try {
      await vpnGuard.verifyLocation();
    } catch (err: any) {
      console.error(`\n[VPN] *** BLOCKED *** ${err.message}`);
      process.exit(1);
    }
    vpnGuard.startMonitoring();
  }

  if (!DRY_RUN) {
    clob = await clobClient();
    reconcileAddress = POLYMARKET_FUNDER_ADDRESS ?? clob.signer.address;
    log(`wallet signer=${clob.signer.address} funder/reconcile=${reconcileAddress}`);
    await refreshBalance();
    if (lowBalance()) {
      log(`WARNING: funder balance/allowance below min marketable buy at startup; entries paused until funded.`);
    }
  } else {
    log(`dry-run: skipping CLOB client + balance probe`);
  }

  loadPersistentPause();
  loadPausedEvents();
  loadQuarantine();
  loadOrphans();
  pruneStaleQuarantine();
  await refreshSpotPrices();
  await recoverIncompleteSportsIntentsAtStartup();
  await reconcileOrphansAtStartup();
  archiveStaleNbaLedgers();

  await refreshWatchlist();
  connectMarketWs(0);
  await connectUserWs(0);

  setInterval(() => { void refreshWatchlist(); }, WATCHLIST_REFRESH_MS);
  setInterval(() => { void refreshBalance(); }, BALANCE_REFRESH_MS);
  setInterval(() => { void refreshSpotPrices(); }, SPOT_REFRESH_MS);
  setInterval(() => archiveStaleNbaLedgers(), WATCHLIST_REFRESH_MS);
  setInterval(() => flushLedger(), LEDGER_FLUSH_MS);
  setInterval(() => orphanLoop(), ORPHAN_POLL_MS);
  setInterval(() => flushNearMissTelemetry(), NEAR_MISS_LOG_MS);

  // Resubscribe the market WS to any newly discovered tokens after a watchlist
  // refresh by cycling the socket (cheap; books re-seed over REST on reconnect).
  setInterval(() => {
    if (marketWs && marketWs.readyState === WebSocket.OPEN) marketWs.close();
  }, WATCHLIST_REFRESH_MS + 5_000);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shuttingDown = true;
      log(`received ${signal}; shutting down`);
      vpnGuard.stopMonitoring();
      marketWs?.close();
      userWs?.close();
      process.exit(0);
    });
  }

  log(`daemon running.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
