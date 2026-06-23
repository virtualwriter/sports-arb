/**
 * Paper Trading Engine with Adaptive Learning
 *
 * Runs after market-scanner.ts --snapshot. Evaluates signals, manages positions,
 * tracks P&L, and calls an LLM for hypothesis-driven pattern discovery.
 *
 * Usage:
 *   npx tsx scripts/trading-engine.ts              # full run (signals + LLM)
 *   npx tsx scripts/trading-engine.ts --no-llm     # signals only, skip LLM call
 *   npx tsx scripts/trading-engine.ts --dry-run    # show signals without trading
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  isContaminatedTrade as isLedgerContaminatedTrade,
  operationallyTaintedTradeIds,
  recomputePortfolioTotalsFromLedger,
} from "./portfolio-ledger.js";
import {
  applyEntryBookToPackageLegs,
  fetchMarketYesNoBooks,
  legSnapshotFromYesBook,
  type EntryBookSnapshot,
} from "./polymarket-clob-book.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = join(import.meta.dirname ?? ".", "..", "data");
const DEFAULT_LIVE_STATE_DIR = join(import.meta.dirname ?? ".", "..", ".runtime");
const LIVE_STATE_DIR = process.env.POLYMARKET_TRADER_STATE_DIR ?? DEFAULT_LIVE_STATE_DIR;
const LIVE_PORTFOLIO_FILE = process.env.POLYMARKET_TRADER_LIVE_PORTFOLIO ?? join(LIVE_STATE_DIR, "portfolio-live.json");
const PENDING_CLOSED_TRADES_FILE = process.env.POLYMARKET_TRADER_PENDING_CLOSED_TRADES ?? join(LIVE_STATE_DIR, "pending-closed-trades.jsonl");
const RELATIVE_VALUE_CSV = join(import.meta.dirname ?? ".", "..", "relative-value", "cross_venue_relative_value.csv");
const HYBRID_BOT_TRADES_FILE = process.env.HYPERLIQUID_HYBRID_TRADES_FILE
  ?? join(LIVE_STATE_DIR, "hyperliquid-hybrid-trades.jsonl");
const HYBRID_BOT_STATE_FILE = process.env.HYPERLIQUID_HYBRID_STATE_FILE
  ?? join(LIVE_STATE_DIR, "hyperliquid-hybrid-state.json");
const HYBRID_STRATEGY_DOC = join(import.meta.dirname ?? ".", "..", "docs", "hybrid-strategy-context.md");
const HYBRID_BOT_RECENT_TRADE_LIMIT = Number(process.env.HYPERLIQUID_HYBRID_TRADE_LIMIT ?? 20);
const INSTRUMENT_SNAPSHOTS_JSONL = "instrument-snapshots.jsonl";
const INSTRUMENT_SNAPSHOT_LOOKBACK = Number(process.env.INSTRUMENT_SNAPSHOT_LOOKBACK ?? 12);
const OIL_CRUDE_HISTORY_START = process.env.OIL_CRUDE_HISTORY_START ?? "2026-04-28";
const LEARNING_PARAMS_FILE = "learning-params.json";
const BLOCKED_SIGNALS_FILE = "blocked-signals.json";
const PROCESSED_CLOSED_TRADES_FILE = "processed-closed-trades.json";
const ENGINE_STATE_FILE = "engine-state.json";
const LLM_TRUTH_STATE_FILE = "llm-truth-state.json";
const CANDIDATE_ACTIONS_FILE = "candidate-actions.json";
const LLM_ADVICE_FILE = "llm-advice.json";
const EXECUTION_PLAN_FILE = "execution-plan.json";
const DRY_RUN_VERIFICATION_FILE = "dry-run-verification.json";
const REAL_PM_PACKAGES_FILE = "polymarket-live-packages.json";
const TRADE_SIZE = 1;
const MAX_BANKROLL = 100;
const MAX_OPEN_POSITIONS = 15;
const HEATMAP_SHADOW_MAX_SPREAD = 0.01;
const HEATMAP_SHADOW_MIN_LIQUIDITY = 1000;
const MONOTONIC_ARB_MAX_YES_SPREAD = 0.01;
// Gross locked edge only needs to be positive; hair (0.1–0.4¢) is intentional —
// sub-$1 packages are floor-risk-free with strike-gap jackpot convexity.
const MONOTONIC_ARB_MIN_GROSS_EDGE = 0.001;
const MONOTONIC_ARB_MIN_LEG_LIQUIDITY = 10_000;
// Min paired shares fillable at broad YES ask + narrow NO ask (lotto sizing).
const MONOTONIC_ARB_MIN_TOP_OF_BOOK_SIZE = 10;
const MONOTONIC_ARB_MAX_SNAPSHOT_AGE_MINUTES = 20;
const MONOTONIC_ARB_ASSETS = new Set(["BTC", "ETH", "GOLD", "OIL", "AMZN", "HYPE", "SPY", "SILVER", "SOL"]);
// Promoted to live 2026-06-01 after 10/10 May shadow packages settled
// profitably (avg +20.3%, two +100% jackpots, zero losers). Monotonic arb is
// structurally risk-free (minimum payout >= cost by the locked-edge gate), so
// it is exempt from the MAX_OPEN_POSITIONS cap and may run as many concurrent
// packages as the bankroll allows (one dedup per unique package id). It still
// draws TRADE_SIZE per package from cash like any other live position.
const ENABLE_MONOTONIC_ARB_LIVE = false;
const INVALID_MONOTONIC_SETTLEMENT_REASON = "invalid_monotonic_settlement_bucket";
const UNDERLYING_CAP_ENTRY_MAX_SPREAD = 0.02;
const UNDERLYING_CAP_ENTRY_MIN_LIQUIDITY = 1000;
const UNDERLYING_CAP_BUY_NO_RATIO = 1.03;
const UNDERLYING_CAP_BUY_YES_RATIO = 0.35;
const MAX_PM_ENTRY_SPREAD = 0.03;
const MIN_PM_ENTRY_LIQUIDITY = 1000;
const MIN_ONE_SIDED_PM_ENTRY_PRICE = 0.01;
const ONE_TOUCH_HIGH_EDGE_SIGNAL_NO = "ONE_TOUCH_HIGH_EDGE_NO";
const ONE_TOUCH_HIGH_EDGE_SIGNAL_YES = "ONE_TOUCH_HIGH_EDGE_YES_SHADOW";
const ONE_TOUCH_HIGH_EDGE_MIN_ABS_EDGE = 15;
const ONE_TOUCH_HIGH_EDGE_CONVICTION_EDGE = 20;
const ONE_TOUCH_HIGH_EDGE_HOLD_DAYS = 14;
const ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS = 1;
const ONE_TOUCH_NO_SHADOW_MAX_SPREAD = 0.03;
const ONE_TOUCH_NO_SHADOW_MIN_LIQUIDITY = 5_000;
const ONE_TOUCH_MODEL_VERSION = "relative_value_heatmap_v2_one_touch";
const ONE_TOUCH_STRICT_BAD_FLAGS = new Set([
  "wide_pm_spread",
  "low_pm_liquidity",
  "above_underlying_cap",
  "near_underlying_cap_bullish",
  "missing_options_iv",
  "no_listed_options_mapping",
]);
const ONE_TOUCH_BUY_YES_BAD_FLAGS = new Set([
  ...ONE_TOUCH_STRICT_BAD_FLAGS,
  "extreme_perp_funding",
]);
// Strike-IV-skew artifact guard: for far-OTM short-DTE touch/settlement setups,
// the model touch/terminal probability is driven by strike-specific option IV
// which can be lifted substantially by tail-hedging skew (call skew above spot,
// put skew below spot) vs the PM-implied IV. When option_iv runs materially
// above pm_iv on a short-dated far-OTM strike, the resulting "edge" is the
// model paying for skew the market is not actually pricing. Applies symmetrically
// to buy_yes (upside call skew) and sell_yes_or_buy_no (downside put skew).
const ONE_TOUCH_SKEW_GUARD_MAX_DTE = 60;
const ONE_TOUCH_SKEW_GUARD_MIN_DIST_PCT = 0.15;
const ONE_TOUCH_SKEW_GUARD_IV_RATIO = 1.3;
// STALE_LOTTERY_TICKET_NO: short-DTE far-OTM YES contracts where the touch model
// has decayed near zero but the PM market is slow to reprice the residual lottery
// premium. Shadow-only NO side; pays off if YES expires worthless.
const STALE_LOTTERY_TICKET_NO_SIGNAL = "STALE_LOTTERY_TICKET_NO";
const STALE_LOTTERY_TICKET_NO_MAX_YES_PRICE = 0.30;
const STALE_LOTTERY_TICKET_NO_MIN_YES_PRICE = 0.05;
const STALE_LOTTERY_TICKET_NO_MAX_MODEL_PROB = 0.05;
const STALE_LOTTERY_TICKET_NO_MIN_DIST_PCT = 0.20;
const STALE_LOTTERY_TICKET_NO_MAX_DTE = 30;
const STALE_LOTTERY_TICKET_NO_MIN_EDGE_PTS = 5;
const STALE_LOTTERY_TICKET_NO_HOLD_DAYS = 30;
const STALE_LOTTERY_TICKET_NO_BAD_FLAGS = new Set([
  "wide_pm_spread",
  "low_pm_liquidity",
  "missing_options_iv",
  "no_listed_options_mapping",
]);
const ENABLE_ONE_TOUCH_HIGH_EDGE_NO_OPENING = false;
const WEEKEND_HL_FUNDING_LIVE_SIGNAL = "WEEKEND_HL_FUNDING_REVERSION_LONG";
const WEEKEND_HL_FUNDING_SHADOW_REASON = "weekend_hl_funding_shadow";
const ENABLE_WEEKEND_HL_FUNDING_LIVE = true;
// Entry band tightened 2026-06-01 from `funding <= -0.30` to the mid-tier
// `-1.00 <= funding <= -0.50`. The shallow band (-0.30 to -0.50) was a
// net-negative drag (197 trades, -0.085% avg, -16.8% cum) and the deep band
// (<= -1.00) was flat (100 trades, -0.017% avg, -1.7% cum). The mid bucket
// produced 91 trades at +1.07% avg, +97.1% cum, Sharpe 0.223 (~4.7x baseline)
// with half the tail risk. See `.runtime/funding-analysis-bundle/Funding Rate
// Analysis_Summary.md` section D for the full backtest.
const WEEKEND_HL_FUNDING_ENTRY_PCT = -0.50;
const WEEKEND_HL_FUNDING_ENTRY_FLOOR_PCT = -1.00;
const WEEKEND_HL_FUNDING_EXIT_PCT = 0.10;
const WEEKEND_HL_FUNDING_LEVERAGE = 5;
const WEEKEND_HL_FUNDING_TARGET_PCT = 3;
const WEEKEND_HL_FUNDING_MAX_HOLD_HOURS = 24;
const NO_BIAS_ADJUSTED_GAP_SIGNAL = "NO_BIAS_ADJUSTED_GAP_SHADOW";
const NO_BIAS_ADJUSTED_GAP_REASON = "no_bias_adjusted_gap_shadow";
const NO_BIAS_ADJUSTED_GAP_HOLD_DAYS = 7;
const NO_BIAS_ADJUSTED_GAP_MAX_SPREAD = 0.02;
const NO_BIAS_ADJUSTED_GAP_MIN_LIQUIDITY = 5_000;
const LONG_DATED_POLYMARKET_HOLD_DAYS = 90;
const HYPE_STOCK_BUILDER_ASSETS = new Set([
  "AAPL", "AMD", "AMZN", "ARM", "BABA", "BIRD", "BX", "CBRS", "COIN",
  "COST", "CRCL", "DKNG", "EBAY", "GME", "GOOGL", "HIMS", "HOOD", "INTC",
  "LITE", "LLY", "META", "MRVL", "MSFT", "MSTR", "MU", "NFLX", "NVDA",
  "ORCL", "PLTR", "RIVN", "RKLB", "SKHX", "SNDK", "TSLA", "TSM", "ZM",
]);
const HYPOTHESIS_SHADOW_TESTS_REQUIRED = 20;
const HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT = 25;
const PROMOTE_THRESHOLD = 0.65;
const PROMOTE_MIN_TESTS = HYPOTHESIS_SHADOW_TESTS_REQUIRED;
const DEMOTE_THRESHOLD = 0.45;
const KILL_THRESHOLD = 0.40;
const WEIGHT_DECAY = 0.85;
const DATA_CONTAMINATED_SETUP_IDS = new Set([
  "oil_iv_statistical_breakdown_arbitrage",
  "oil_funding_volatility_mean_reversion",
  "oil_pm_spot_divergence_mean_reversion",
  "gold_pm_premium_futures_spread_mean_reversion",
  "cross_asset_funding_positioning_exhaustion",
]);
const RETIRED_LLM_SETUP_IDS = new Set([
  "oil_iv_statistical_breakdown_arbitrage",
  "cross_asset_funding_positioning_exhaustion",
  "cross_asset_iv_compression_vol_expansion",
  "other_mixed",
  "oil_funding_volatility_mean_reversion",
  "retired_btc_pm_iv_hardcoded_variants",
  "retired_btc_listed_iv_hardcoded_variants",
  "retired_btc_pm_iv_leftover_hardcoded_variants",
  "retired_hype_spot_pm_divergence_variants",
  "retired_amzn_hardcoded_variants",
  "retired_pm_settlement_bucket_hardcoded_variants",
  "retired_hype_adjacent_momentum_variants",
  "retired_btc_hype_confirmation_variants",
  "hype_adjacent_momentum_variants",
  "btc_hype_confirmation_shadow",
]);
const GOLD_SETTLEMENT_TAIL_HYPOTHESIS_IDS = new Set(["H-527"]);
const OIL_SETTLEMENT_TAIL_HYPOTHESIS_IDS = new Set(["H-528"]);
const GOLD_SETTLEMENT_SKEW_HYPOTHESIS_IDS = new Set(["H-529"]);
const OIL_SETTLEMENT_SKEW_HYPOTHESIS_IDS = new Set(["H-530"]);
const RETIRED_PM_SETTLEMENT_BUCKET_HARDCODED_HYPOTHESIS_IDS = new Set([
  "H-101", "H-105", "H-110", "H-114", "H-117", "H-120", "H-123", "H-174",
  "H-297", "H-327", "H-339", "H-372", "H-429",
]);
const RETIRED_BTC_PM_IV_HARDCODED_HYPOTHESIS_IDS = new Set([
  "H-213", "H-216", "H-219", "H-224", "H-227", "H-234", "H-239", "H-245",
  "H-248", "H-251", "H-255", "H-258", "H-268", "H-270", "H-289", "H-301",
  "H-305", "H-307", "H-350", "H-410", "H-413", "H-442",
]);
const BTC_LISTED_IV_MOMENTUM_HYPOTHESIS_IDS = new Set([
  "H-012", "H-170", "H-218",
]);
const RETIRED_BTC_LISTED_IV_HARDCODED_HYPOTHESIS_IDS = new Set([
  "H-054", "H-065", "H-073", "H-115", "H-152", "H-186",
]);
const BTC_OPTIONS_POSITIONING_MACRO_HYPOTHESIS_IDS = new Set(["H-300"]);
const BTC_PM_IV_EXPANSION_REVERSION_HYPOTHESIS_IDS = new Set(["H-001"]);
const BTC_MEDIAN_RANGE_HYPOTHESIS_IDS = new Set(["H-014", "H-017", "H-021"]);
const RETIRED_BTC_PM_IV_LEFTOVER_HARDCODED_HYPOTHESIS_IDS = new Set([
  "H-046", "H-221", "H-261", "H-273", "H-284", "H-285", "H-291", "H-336", "H-424",
]);
const HYPE_RELATIVE_OI_BREAKOUT_HYPOTHESIS_IDS = new Set([
  "H-521", "H-116", "H-181", "H-211", "H-122", "H-143", "H-225", "H-134",
  "H-128", "H-217", "H-333", "H-235",
]);
const HYPE_ADJACENT_MOMENTUM_HYPOTHESIS_IDS = new Set([
  "H-020", "H-214", "H-079", "H-081", "H-256", "H-118", "H-087", "H-089",
  "H-187", "H-067", "H-102", "H-131", "H-126", "H-140", "H-084", "H-137",
]);
const BTC_HYPE_CONFIRMATION_SHADOW_HYPOTHESIS_IDS = new Set([
  "H-180", "H-195", "H-038", "H-077", "H-208", "H-183", "H-041", "H-205",
  "H-059", "H-064", "H-426", "H-075", "H-098", "H-056",
]);
const RETIRED_HYPE_SPOT_PM_DIVERGENCE_HYPOTHESIS_IDS = new Set(["H-018", "H-040"]);
const AMZN_PERP_SPOT_FUNDING_CLEAN_HYPOTHESIS_IDS = new Set([
  "H-005", "H-037", "H-043", "H-045", "H-058", "H-060", "H-099", "H-100",
  "H-147", "H-150", "H-154", "H-254", "H-257", "H-259", "H-265", "H-328", "H-408",
]);
const AMZN_OPTIONS_POSITIONING_CLEAN_HYPOTHESIS_IDS = new Set([
  "H-023", "H-052", "H-055", "H-106", "H-119", "H-178",
]);
const RETIRED_AMZN_HARDCODED_HYPOTHESIS_IDS = new Set([
  "H-047", "H-062", "H-173", "H-191", "H-222", "H-238", "H-241", "H-244",
  "H-280", "H-294", "H-295", "H-299", "H-303", "H-306", "H-312", "H-354",
  "H-360", "H-374", "H-378", "H-381", "H-405", "H-425", "H-428", "H-433",
]);
const LIVE_SIGNAL_ALLOWLIST = new Set([
  "ONE_TOUCH_HIGH_EDGE_NO",
  "PC_RATIO_EXTREME_HIGH",
  "PC_RATIO_EXTREME_LOW",
  "FUNDING_EXTREME_SHORT",
  "FUNDING_EXTREME_LONG",
]);
// H-523 was a "BTC vol expands as PM IV mean reverts" thesis that the
// engine was force-converting into a directional BTC spot long via a
// keyword-scanner bug. Even with the bug fixed (vol-only theses are now
// skipped explicitly), the hypothesis itself doesn't carry a spot view
// and shouldn't be live. Re-promote only when there's a directional thesis.
const LIVE_PROMOTED_HYPOTHESIS_IDS = new Set(["H-521"]);
const OPERATIONALLY_TAINTED_TRADE_IDS = operationallyTaintedTradeIds();
const LOOKBACK_HOURS = 24;
const NO_LLM = process.argv.includes("--no-llm");
const DRY_RUN = process.argv.includes("--dry-run");
const SHADOW_ARCHITECTURE = process.argv.includes("--shadow-architecture") || DRY_RUN;
const LLM_DRY_RUN = process.argv.includes("--llm-dry-run");
const MUTATION_DISABLED = DRY_RUN || LLM_DRY_RUN;
const ALLOW_HOURLY_LLM_CLOSES = process.env.ALLOW_HOURLY_LLM_CLOSES !== "0" && process.env.ALLOW_HOURLY_LLM_CLOSES !== "false";
const LLM_CLOSE_MIN_HOLD_HOURS = 12;
const LLM_LONG_DATED_CLOSE_HOURS = 30 * 24;
const LLM_LONG_DATED_CLOSE_MIN_PROGRESS = 0.10;
const LLM_LONG_DATED_CLOSE_MAX_EXTRA_BUFFER_HOURS = 7 * 24;
const LLM_PROFIT_TAKE_TARGET_FRACTION = 0.75;

// LLM cadence gate. The hourly engine/reporting loop still runs, but expensive
// Sonnet calls are capped and deduped so trigger noise cannot blow through the
// daily Anthropic budget.
const LLM_CADENCE_HOURS = Number(process.env.LLM_CADENCE_HOURS ?? 2);
const LLM_FORCE_HOURLY = process.env.LLM_FORCE_HOURLY === "1" || process.env.LLM_FORCE_HOURLY === "true";
const LLM_MAX_CALLS_PER_DAY = Number(process.env.LLM_MAX_CALLS_PER_DAY ?? 12);
const LLM_NEW_SIGNAL_DEDUPE_HOURS = Number(process.env.LLM_NEW_SIGNAL_DEDUPE_HOURS ?? 6);
const LLM_NEAR_DECISION_PCT_TRIGGER = Number(process.env.LLM_NEAR_DECISION_PCT_TRIGGER ?? 0.5);
const LLM_HARD_RISK_PNL_PCT_TRIGGER = Number(process.env.LLM_HARD_RISK_PNL_PCT_TRIGGER ?? -30);
const LLM_BIG_MOVE_PCT_TRIGGER = Number(process.env.LLM_BIG_MOVE_PCT_TRIGGER ?? 5);
const LLM_BACKLOG_RESTOCK_HOURS = Number(process.env.LLM_BACKLOG_RESTOCK_HOURS ?? 24);
const LLM_STATE_FILE = "llm-state.json";

const DEFAULT_SIGNAL_RISK: Record<string, SignalRiskParams> = {
  PM_IV_GT_OPT_IV: { targetPct: null, stopPct: 5 },
  OPT_IV_GT_PM_IV: { targetPct: 4, stopPct: 4 },
  FUNDING_EXTREME_LONG: { targetPct: 5, stopPct: 2.5 },
  FUNDING_EXTREME_SHORT: { targetPct: 4, stopPct: 2.5 },
  PM_EV_ABOVE_SPOT: { targetPct: 4, stopPct: 4 },
  PM_EV_BELOW_SPOT: { targetPct: 3, stopPct: 3.5 },
  PC_RATIO_EXTREME_HIGH: { targetPct: 5, stopPct: 2 },
  PC_RATIO_EXTREME_LOW: { targetPct: 5, stopPct: 2 },
  BASIS_PREMIUM: { targetPct: 1.5, stopPct: 1.5 },
  BASIS_DISCOUNT: { targetPct: 1.5, stopPct: 1.5 },
  MACRO_MOMENTUM_UP: { targetPct: 3, stopPct: 3 },
  MACRO_MOMENTUM_DOWN: { targetPct: 4, stopPct: 3 },
  LLM_HYPOTHESIS: { targetPct: 3.5, stopPct: 2.5 },
  MOMENTUM_LONG: { targetPct: 6, stopPct: 3.5 },
  PROMOTED_HYPOTHESIS: { targetPct: 6, stopPct: 3.5 },
  ONE_TOUCH_HIGH_EDGE_NO: { targetPct: null, stopPct: 100 },
};
// Signals whose risk params are dictated by their backtest convention and must not be
// retuned by the hourly LLM. The LLM's signalRisk schema caps stopPct at 10, which would
// silently retighten ONE_TOUCH_HIGH_EDGE_NO (held to expiry, deep drawdowns expected)
// every run. We strip these entries from parameterUpdates.signalRisk before validation
// and again before applying, so the LLM cannot rewrite them.
const LLM_LOCKED_SIGNAL_RISK: ReadonlySet<string> = new Set(["ONE_TOUCH_HIGH_EDGE_NO"]);
const SPOT_LONG_RISK_BY_ASSET: Record<string, SignalRiskParams> = {
  BTC: { targetPct: 3, stopPct: 1.5 },
  AMZN: { targetPct: 3, stopPct: 1.5 },
  GOLD: { targetPct: 3, stopPct: 1.5 },
  OIL: { targetPct: 4, stopPct: 2 },
  HYPE: { targetPct: 4, stopPct: 2 },
};
const SPOT_SHORT_RISK: SignalRiskParams = { targetPct: 3, stopPct: 2 };
const PRODUCTION_POLYMARKET_RISK: SignalRiskParams = { targetPct: 5, stopPct: 2 };
const FUNDING_BREAKEVEN_ARM_PCT = 1.5;
const FUNDING_BREAKEVEN_LOCK_PCT = 0.25;
const FUNDING_EXTENDED_ABS_MOVE_PCT = 8;
const FUNDING_CHASE_MOVE_PCT = 4;

// ─── Types ───────────────────────────────────────────────────────────────────

interface PolymarketPackageLeg {
  role: "broad_yes" | "narrow_no";
  instrumentType: "pm_yes" | "pm_no";
  instrumentId: string;
  instrumentLabel: string;
  entryPrice: number;
  strike: number;
  direction: "above" | "below";
  yesBid: number;
  yesAsk: number;
  yesBidSize?: number | null;
  yesAskSize?: number | null;
  // Market creation date — touch markets resolve over [startDate, expiry], not
  // just the final calendar month, so the package settler needs this to award
  // the jackpot (the between-strikes outcome) correctly.
  startDate?: string | null;
}

interface Position {
  id: string;
  openedAt: string;
  asset: string;
  venue: "polymarket" | "hyperliquid" | "spot";
  direction: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage?: number;
  signalType: string;
  hypothesisId: string | null;
  thesis: string;
  targetPct: number | null;
  stopPct: number;
  expiryDate: string;
  instrumentType?: "spot" | "hl_perp" | "pm_yes" | "pm_no" | "pm_package" | "legacy_asset";
  instrumentId?: string;
  instrumentLabel?: string;
  packageLegs?: PolymarketPackageLeg[];
  /** Frozen CLOB top-of-book at open (sizes, bids/asks per leg). */
  entryBookSnapshot?: EntryBookSnapshot;
  entryUnderlyingPrice?: number;
  currentUnderlyingPrice?: number;
  fundingPnlAccrued?: number;
  peakPnlPct?: number;
}

interface RealPolymarketLivePackage {
  id?: string;
  packageId: string;
  status: string;
  createdAt: string;
  dryRun?: boolean;
  walletAddress?: string;
  asset: string;
  direction: "above" | "below";
  broadStrike: number;
  narrowStrike: number;
  filledShares: number;
  actualCost: number;
  settlementWindow?: { startDate?: string | null; endDate?: string | null };
  prices?: { packageCost?: number; broadYesAsk?: number; narrowNoAsk?: number };
  packageLegs?: PolymarketPackageLeg[];
}

interface ClosedTrade {
  id: string;
  openedAt: string;
  closedAt: string;
  asset: string;
  venue: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  leverage?: number;
  pnl: number;
  pnlPct: number;
  marketPnl?: number;
  fundingPnl?: number;
  signalType: string;
  hypothesisId: string | null;
  thesis: string;
  closeReason:
    | "target"
    | "stop"
    | "breakeven_stop"
    | "expiry"
    | "llm_decision"
    | "signal_killed"
    | "thesis_validated"
    | "thesis_validated_profitable"
    | "thesis_compressed_loss"
    | "data_quality_artifact";
  instrumentType?: string;
  instrumentId?: string;
  instrumentLabel?: string;
}

interface Portfolio {
  cash: number;
  positions: Position[];
  totalRealizedPnl: number;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  lastUpdated: string;
}

interface PerAssetSignalStats {
  trades: number;
  wins: number;
  avgPnlPct: number;
  disabled?: boolean;
  disabledAt?: string;
  disabledReason?: string;
}

interface SignalWeight {
  type: string;
  weight: number;
  trades: number;
  wins: number;
  avgPnlPct: number;
  lastTriggered: string;
  enabled: boolean;
  perAsset: Record<string, PerAssetSignalStats>;
}

interface SignalRiskParams {
  targetPct: number | null;
  stopPct: number;
}

interface LearningParams {
  macroMomentum24hThresholdPts: number;
  contrarianTrendMarginPct: number;
  positiveMomentum24hPct: number;
  llmTradeExpiryDays: number;
  momentumLongExpiryDays: number;
  signalRisk: Record<string, SignalRiskParams>;
  updatedAt: string;
}

interface LlmTradeInstruction {
  action: "buy" | "sell" | "close";
  positionId?: string;
  asset: string;
  venue: "polymarket" | "hyperliquid" | "spot";
  direction: "long" | "short" | "any";
  closeReasonCategory?: "thesis_invalidated" | "data_quality_issue" | "hard_portfolio_risk" | "risk_stale" | "profit_taking";
  evidenceColumns?: string[];
  thesis: string;
}

interface LlmAnalysisResult {
  marketAssessment: string;
  newHypotheses: Omit<Hypothesis, "id" | "tests" | "winRate" | "status" | "promotedToSignal" | "postMortem">[];
  hypothesisReviews: { id: string; observation: string }[];
  trades: LlmTradeInstruction[];
  parameterUpdates?: Partial<Omit<LearningParams, "updatedAt">>;
  journalEntry: string;
}

interface HypothesisTest {
  date: string;
  triggered: boolean;
  outcome: "win" | "loss" | "pending";
  actualMove: string;
  excludedFromSetupStats?: boolean;
  exclusionReason?: string;
}

interface Hypothesis {
  id: string;
  setupId?: string;
  setupLabel?: string;
  created: string;
  description: string;
  conditions: Record<string, string>;
  prediction: string;
  timeframeDays: number;
  confidence: number;
  // Explicit spot direction the hypothesis predicts. "neutral" is for
  // vol/IV/spread theses that do not carry a directional price view and
  // therefore should not be auto-converted to a spot bet. Older
  // hypotheses created before this field existed leave it undefined,
  // which falls back to the keyword inferrer.
  direction?: "long" | "short" | "neutral";
  tests: HypothesisTest[];
  winRate: number;
  status: "active" | "promoted" | "archived" | "killed";
  promotedToSignal: boolean;
  postMortem: string | null;
  source: "llm" | "statistical";
}

interface HypothesisSetupFamily {
  setupId: string;
  setupLabel: string;
  hypotheses: Hypothesis[];
  completed: HypothesisTest[];
  pending: HypothesisTest[];
  wins: number;
  losses: number;
  winRate: number;
  primary: Hypothesis;
}

interface Signal {
  type: string;
  asset: string;
  venue: "polymarket" | "hyperliquid" | "spot";
  direction: "long" | "short";
  strength: number; // 0-1, raw signal strength
  confidence: number; // strength * weight
  thesis: string;
  hypothesisId: string | null;
  entryPrice: number;
  targetPct: number | null;
  stopPct: number;
  expiryDays: number;
  leverage?: number;
  contractHint?: {
    preferredEventSlug?: string;
    preferredDirection?: "above" | "below";
    allowDirectionFallback?: boolean;
    forceInstrumentType?: "pm_yes" | "pm_no";
    forceMarketId?: string;
  };
}

interface BlockedSignalShadow {
  id: string;
  status: "open" | "resolved" | "cancelled";
  blockedAt: string;
  resolvedAt?: string;
  blockedReason: "short_blocked_by_positive_trend" | "iv_downside_leg_untracked" | "manual_shadow_trade" | "polymarket_proxy_short" | "relative_value_heatmap" | "monotonic_arb_shadow" | "one_touch_high_edge_shadow" | "stale_lottery_ticket_shadow" | "weekend_hl_funding_shadow" | "no_bias_adjusted_gap_shadow";
  signalType: string;
  asset: string;
  venue: Signal["venue"];
  direction: Signal["direction"];
  confidence: number;
  thesis: string;
  sourcePositionId?: string;
  sourcePositionLabel?: string;
  trendMetrics?: {
    aboveTrendPct: number;
    momentumPct: number;
  };
  marketQuality?: {
    yesBid: number;
    yesAsk: number;
    yesSpread: number;
    liquidity: number;
    availableSize?: number | null;
    flags: string[];
  };
  learningParamsSnapshot: Omit<LearningParams, "updatedAt">;
  position: Position;
  hypotheticalResult?: {
    closeReason: ClosedTrade["closeReason"];
    exitPrice: number;
    pnl: number;
    pnlPct: number;
    marketPnl: number;
    fundingPnl: number;
    outcome: "win" | "loss";
  };
  sourceComparison?: {
    sourceClosedAt: string;
    sourcePnl: number;
    sourcePnlPct: number;
    proxyOutperformed: boolean;
    correlation: "same_direction" | "opposite_direction" | "flat";
  };
  learningExcluded?: {
    reason: string;
    note: string;
  };
  heatmapRowSnapshot?: {
    schemaVersion: number;
    source: string;
    row: Record<string, string>;
    selectedSide?: string;
    selectedSignalType?: string;
  };
}

interface BlockedSignalLearningSummary {
  openCount: number;
  resolvedCount: number;
  wouldHaveWon: number;
  wouldHaveLost: number;
  bySignal: Array<{
    signalType: string;
    blocked: number;
    resolved: number;
    wouldHaveWon: number;
    wouldHaveLost: number;
    avgPnlPct: number;
  }>;
  recentResolved: Array<{
    signalType: string;
    asset: string;
    venue: Signal["venue"];
    direction: Signal["direction"];
    blockedReason: BlockedSignalShadow["blockedReason"];
    outcome: "win" | "loss";
    closeReason: ClosedTrade["closeReason"];
    pnlPct: number;
    resolvedAt: string;
    trendMetrics?: BlockedSignalShadow["trendMetrics"];
    marketQuality?: BlockedSignalShadow["marketQuality"];
    sourceComparison?: BlockedSignalShadow["sourceComparison"];
  }>;
  openQualityWarnings: Array<{
    signalType: string;
    asset: string;
    blockedReason: BlockedSignalShadow["blockedReason"];
    instrumentLabel?: string;
    marketQuality: NonNullable<BlockedSignalShadow["marketQuality"]>;
    thesis: string;
  }>;
}

interface SnapshotRow {
  date: string;
  [key: string]: string | number;
}

interface StatObservation {
  type: "correlation_flip" | "anomaly" | "lead_lag" | "divergence" | "regime_change";
  description: string;
  assets: string[];
  magnitude: number;
  data: Record<string, number>;
}

interface RelativeValueObservation {
  timestamp: string;
  modelVersion: string;
  asset: string;
  eventSlug: string;
  marketId: string;
  question: string;
  contractMonth: string;
  direction: "above" | "below";
  strike: number;
  expiry: string;
  pmYes: number | null;
  pmBid: number | null;
  pmAsk: number | null;
  pmSpread: number | null;
  modelProb: number | null;
  underlyingCapYes: number | null;
  pmToUnderlyingCapRatio: number | null;
  underlyingCapSignal: string;
  settlementYesSum: number | null;
  settlementOverround: number | null;
  settlementTailYes: number | null;
  settlementSkewYes: number | null;
  edgePts: number | null;
  bestExpression: string;
  optionIv: number | null;
  pmIv: number | null;
  cboeNoGapPts: number | null;
  cmeNoGapPts: number | null;
  adjustedNoGapPts: number | null;
  sourceAgreementBucket: string;
  noBiasCandidatePassed: boolean;
  liquidity: number | null;
  flags: string;
  rawRow: Record<string, string>;
}

interface InstrumentSnapshotContract {
  marketId: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  strike: number;
  direction: "above" | "below";
  yesPrice: number;
  volume: number;
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number | null;
  bestAskSize?: number | null;
  spread?: number;
  liquidity?: number;
  active?: boolean;
  closed?: boolean;
  startDate?: string | null;
  endDate?: string | null;
}

interface InstrumentSnapshotEvent {
  asset: string;
  slug: string;
  title: string;
  totalVolume: number;
  contracts: InstrumentSnapshotContract[];
}

interface InstrumentSnapshotOptionQuote {
  strike: number;
  bid: number;
  ask: number;
  mid: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number;
  expiration: string;
  type: "call" | "put";
}

interface InstrumentSnapshotOptions {
  symbol: string;
  underlyingPrice: number;
  source: string;
  chains: InstrumentSnapshotOptionQuote[];
}

interface InstrumentSnapshotFile {
  timestamp: string;
  spots: Record<string, number | null>;
  hyperliquid: Record<string, {
    markPx: number | null;
    fundingAnnualized: number | null;
    openInterestUsd: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
    spread?: number | null;
  }>;
  polymarket: InstrumentSnapshotEvent[];
  options?: Record<string, InstrumentSnapshotOptions>;
}

interface PositionMarkSummary {
  positionId: string;
  asset: string;
  venue: string;
  direction: string;
  signalType: string;
  pnlPct: number | null;
  currentPrice: number | null;
  underlyingPrice: number | null;
  targetPct: number | null;
  stopPct: number;
  closeReasonIfMechanical: ClosedTrade["closeReason"] | null;
  evidenceColumns: string[];
}

interface SetupTruthRecord {
  setupId: string;
  setupLabel: string;
  status: "eligible_live" | "validating" | "exploratory" | "disabled" | "needs_more_data" | "contaminated_retest";
  currentConclusion: string;
  evidenceSummary: {
    cleanTrades: number;
    tradeWins: number;
    avgTradePnlPct: number;
    resolvedShadows: number;
    shadowWins: number;
    avgShadowPnlPct: number;
    hypothesisTests: number;
    hypothesisWins: number;
  };
  allowedEvidenceColumns: string[];
  knownInvalidAssumptions: string[];
  representativeExamples: Array<{
    id: string;
    kind: "trade" | "shadow" | "hypothesis";
    outcome: "win" | "loss" | "pending" | "n/a";
    pnlPct?: number;
    note: string;
  }>;
  lastReviewedAt: string;
}

interface LlmTruthState {
  generatedAt: string;
  contaminationRules: Array<{
    id: string;
    description: string;
    affectedSetupIds: string[];
    affectedColumns: string[];
  }>;
  setupFamilies: SetupTruthRecord[];
}

interface EngineState {
  generatedAt: string;
  dataFreshness: {
    valuationRows: number;
    latestValuationAt: string;
    macroRows: number;
    instrumentSnapshots: number;
    latestInstrumentSnapshotAt: string | null;
  };
  portfolio: {
    cash: number;
    openPositions: number;
    realizedPnl: number;
    totalTrades: number;
    winRatePct: number | null;
    unrealizedPnl: number;
  };
  openPositions: PositionMarkSummary[];
  signalHealth: Array<{
    type: string;
    enabled: boolean;
    weight: number;
    trades: number;
    wins: number;
    avgPnlPct: number;
    disabledAssets: string[];
  }>;
  blockedSummary: BlockedSignalLearningSummary;
  learningParams: LearningParams;
}

interface CandidateActions {
  generatedAt: string;
  mechanicalExits: Array<{ positionId: string; reason: ClosedTrade["closeReason"] }>;
  signalKillExits: Array<{ positionId: string; signalType: string; asset: string }>;
  entryCandidates: Signal[];
  llmCloseEligibility: Array<{
    positionId: string;
    signalType: string;
    asset: string;
    venue: string;
    direction: string;
    allowed: boolean;
    allowedCategories: NonNullable<LlmTradeInstruction["closeReasonCategory"]>[];
    evidenceColumns: string[];
    hoursOpen: number | null;
    hoursToExpiry: number | null;
    plannedHoldHours: number | null;
    elapsedHoldPct: number | null;
    minHoldHours: number;
    reason: string;
  }>;
}

interface GatedLlmAdvice {
  acceptedCloses: LlmTradeInstruction[];
  rejectedCloses: Array<{ instruction: LlmTradeInstruction; reason: string }>;
  skippedTrades: Array<{ instruction: LlmTradeInstruction; reason: string }>;
  parameterUpdates: Partial<Omit<LearningParams, "updatedAt">> | undefined;
}

interface ExecutionPlan {
  generatedAt: string;
  dryRun: boolean;
  llmDryRun: boolean;
  mechanicalExits: Array<{ positionId: string; reason: ClosedTrade["closeReason"] }>;
  signalKillExits: Array<{ positionId: string; signalType: string; asset: string }>;
  llmCloses: LlmTradeInstruction[];
  entrySignals: Signal[];
  rejectedLlmActions: GatedLlmAdvice["rejectedCloses"];
  skippedLlmActions: GatedLlmAdvice["skippedTrades"];
  notes: string[];
}

// ─── File I/O ────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function ensureLiveStateDir() {
  if (!existsSync(LIVE_STATE_DIR)) mkdirSync(LIVE_STATE_DIR, { recursive: true });
}

function readJson<T>(filename: string, fallback: T): T {
  const p = join(DATA_DIR, filename);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return fallback; }
}

function writeJson(filename: string, data: unknown) {
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2) + "\n");
}

function readJsonPath<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

function writeJsonPath(path: string, data: unknown) {
  ensureLiveStateDir();
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        cell += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  return cells;
}

function readCsv(filename: string): SnapshotRow[] {
  const p = join(DATA_DIR, filename);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").trim().split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row: SnapshotRow = { date: "" };
    headers.forEach((h, i) => {
      const v = vals[i] ?? "";
      row[h] = v !== "" && !isNaN(Number(v)) ? Number(v) : v;
    });
    return row;
  });
}

function readCsvFile(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return [];
  const lines = raw.split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? ""]));
  });
}

// Compact JSON serializer for the LLM prompt's RELATIVE-VALUE HEATMAP section.
//
// Two shape changes vs JSON.stringify(rows, null, 1):
//   1. rawRow is omitted. The 18 explicit fields on RelativeValueObservation
//      already cover everything the LLM needs; rawRow is the full ~50-field
//      raw CSV row attached for internal callers (strict_one_touch_high_edge
//      gates, stale_lottery_ticket gates), and serializing it doubles every
//      row's footprint with content the model cannot use.
//   2. Indentation is stripped. The model does not need pretty-printed JSON
//      to parse this section, and the indent character was ~25% of the
//      section's total bytes at ~227 rows.
// Combined, these reductions cut the heatmap section roughly in half on a
// typical prompt without removing any field the LLM actually reasons about.
function serializeRelativeValueRowsForLlm(rows: RelativeValueObservation[]): string {
  return JSON.stringify(rows, (key, value) => (key === "rawRow" ? undefined : value));
}

function readRelativeValueObservations(limit = 30): RelativeValueObservation[] {
  return readCsvFile(RELATIVE_VALUE_CSV)
    .map((row): RelativeValueObservation | null => {
      const edgePts = num(row.edge_score);
      const strike = num(row.strike);
      const direction = row.direction === "above" || row.direction === "below" ? row.direction : null;
      const capRatio = num(row.pm_to_underlying_cap_ratio);
      if (strike === null || !direction) return null;
      if (edgePts === null && capRatio === null) return null;
      return {
        timestamp: row.timestamp ?? "",
        modelVersion: row.model_version ?? "",
        asset: row.asset ?? "",
        eventSlug: row.event_slug ?? "",
        marketId: row.market_id ?? "",
        question: row.contract_question ?? "",
        contractMonth: row.contract_month ?? "",
        direction,
        strike,
        expiry: row.expiry ?? "",
        pmYes: num(row.pm_yes_price),
        pmBid: num(row.pm_best_bid),
        pmAsk: num(row.pm_best_ask),
        pmSpread: num(row.pm_spread),
        modelProb: num(row.options_touch_adjusted_prob),
        underlyingCapYes: num(row.underlying_cap_yes_price),
        pmToUnderlyingCapRatio: capRatio,
        underlyingCapSignal: row.underlying_cap_signal ?? "",
        settlementYesSum: num(row.settlement_yes_sum),
        settlementOverround: num(row.settlement_overround),
        settlementTailYes: num(row.settlement_tail_yes),
        settlementSkewYes: num(row.settlement_skew_yes),
        edgePts,
        bestExpression: row.best_expression ?? "",
        optionIv: num(row.option_iv),
        pmIv: num(row.pm_iv),
        cboeNoGapPts: num(row.cboe_no_gap_pts),
        cmeNoGapPts: num(row.cme_no_gap_pts),
        adjustedNoGapPts: num(row.adjusted_no_gap_pts),
        sourceAgreementBucket: row.source_agreement_bucket ?? "",
        noBiasCandidatePassed: String(row.no_bias_candidate_passed ?? "").toLowerCase() === "true",
        liquidity: num(row.liquidity),
        flags: row.flags ?? "",
        rawRow: row,
      };
    })
    .filter((row): row is RelativeValueObservation => !!row)
    .filter((row) => row.bestExpression !== "no-options-model" || row.pmToUnderlyingCapRatio !== null)
    .sort((a, b) => {
      const score = (row: RelativeValueObservation) => Math.max(
        Math.abs(row.edgePts ?? 0),
        row.pmToUnderlyingCapRatio === null ? 0 : Math.abs(row.pmToUnderlyingCapRatio - 1) * 100,
        row.settlementOverround === null ? 0 : Math.abs(row.settlementOverround) * 100,
      );
      return score(b) - score(a);
    })
    .slice(0, limit);
}

function appendTradeCsv(trade: ClosedTrade) {
  const file = join(DATA_DIR, "trades-detailed.csv");
  const headers = [
    "id", "opened_at", "closed_at", "asset", "venue", "direction",
    "instrument_type", "instrument_id", "instrument_label",
    "entry_price", "exit_price", "size", "leverage",
    "pnl", "pnl_pct", "market_pnl", "funding_pnl",
    "signal_type", "hypothesis_id", "thesis", "close_reason",
  ];
  if (!existsSync(file)) writeFileSync(file, headers.join(",") + "\n");
  const vals = [
    trade.id, trade.openedAt, trade.closedAt, trade.asset, trade.venue,
    trade.direction, trade.instrumentType ?? "", trade.instrumentId ?? "",
    `"${(trade.instrumentLabel ?? "").replace(/"/g, '""')}"`,
    trade.entryPrice, trade.exitPrice, trade.size, trade.leverage ?? 1,
    trade.pnl.toFixed(4), trade.pnlPct.toFixed(2),
    (trade.marketPnl ?? trade.pnl).toFixed(4), (trade.fundingPnl ?? 0).toFixed(4),
    trade.signalType, trade.hypothesisId ?? "",
    `"${trade.thesis.replace(/"/g, '""')}"`, trade.closeReason,
  ];
  appendFileSync(file, vals.join(",") + "\n");
}

function readClosedTradeCsv(): ClosedTrade[] {
  const file = join(DATA_DIR, "trades-detailed.csv");
  if (!existsSync(file)) return [];

  const lines = readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const [headerLine, ...rows] = lines;
  if (!headerLine) return [];

  const headers = parseCsvLine(headerLine);
  return rows.map((line) => {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? ""]));
    return {
      id: row.id,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      asset: row.asset,
      venue: row.venue,
      direction: row.direction,
      entryPrice: Number(row.entry_price),
      exitPrice: Number(row.exit_price),
      size: Number(row.size),
      leverage: Number(row.leverage),
      pnl: Number(row.pnl),
      pnlPct: Number(row.pnl_pct),
      marketPnl: Number(row.market_pnl),
      fundingPnl: Number(row.funding_pnl),
      signalType: row.signal_type,
      hypothesisId: row.hypothesis_id || null,
      thesis: row.thesis,
      closeReason: row.close_reason as ClosedTrade["closeReason"],
      instrumentType: row.instrument_type || undefined,
      instrumentId: row.instrument_id || undefined,
      instrumentLabel: row.instrument_label || undefined,
    };
  }).filter((trade) => !!trade.id && !!trade.closedAt);
}

interface ProcessedClosedTrades {
  processedIds: string[];
  updatedAt: string;
}

function loadProcessedClosedTrades(allClosedTrades: ClosedTrade[]): ProcessedClosedTrades {
  const existing = readJson<ProcessedClosedTrades | null>(PROCESSED_CLOSED_TRADES_FILE, null);
  if (existing && Array.isArray(existing.processedIds)) {
    return {
      processedIds: existing.processedIds.filter((id) => typeof id === "string"),
      updatedAt: typeof existing.updatedAt === "string" ? existing.updatedAt : new Date().toISOString(),
    };
  }

  // First run after introducing the minute exit scanner: treat existing history
  // as already learned so we only ingest newly scanner-closed trades.
  return {
    processedIds: allClosedTrades.map((trade) => trade.id),
    updatedAt: new Date().toISOString(),
  };
}

function saveProcessedClosedTrades(state: ProcessedClosedTrades) {
  const uniqueIds = [...new Set(state.processedIds)].slice(-2000);
  writeJson(PROCESSED_CLOSED_TRADES_FILE, {
    processedIds: uniqueIds,
    updatedAt: new Date().toISOString(),
  });
}

function loadPendingScannerClosedTrades(): ClosedTrade[] {
  if (!existsSync(PENDING_CLOSED_TRADES_FILE)) return [];
  const content = readFileSync(PENDING_CLOSED_TRADES_FILE, "utf-8").trim();
  if (!content) return [];
  const trades: ClosedTrade[] = [];
  for (const line of content.split("\n")) {
    try {
      const trade = JSON.parse(line) as ClosedTrade;
      if (trade.id && trade.closedAt) trades.push(trade);
    } catch {}
  }
  return trades;
}

function clearPendingScannerClosedTrades() {
  if (!existsSync(PENDING_CLOSED_TRADES_FILE)) return;
  ensureLiveStateDir();
  writeFileSync(PENDING_CLOSED_TRADES_FILE, "");
}

function appendJournal(entry: string) {
  const file = join(DATA_DIR, "learning-journal.md");
  if (!existsSync(file)) writeFileSync(file, "# Trading Engine Learning Journal\n\n");
  appendFileSync(file, entry + "\n");
}

function readInstrumentSnapshots(): InstrumentSnapshotFile[] {
  const p = join(DATA_DIR, INSTRUMENT_SNAPSHOTS_JSONL);
  if (!existsSync(p)) return [];

  return readRecentJsonlRanges(p, INSTRUMENT_SNAPSHOT_LOOKBACK)
    .map((range) => readInstrumentSnapshotPrefix(p, range))
    .filter((line): line is string => !!line)
    .map((line) => {
      try {
        return JSON.parse(line) as InstrumentSnapshotFile;
      } catch {
        return null;
      }
    })
    .filter((row): row is InstrumentSnapshotFile => row !== null);
}

interface JsonlRange {
  start: number;
  end: number;
}

function readRecentJsonlRanges(path: string, maxLines: number): JsonlRange[] {
  const safeMaxLines = Math.max(1, Math.floor(maxLines || 1));
  const stat = statSync(path);
  if (stat.size === 0) return [];

  const fd = openSync(path, "r");
  const chunkSize = 1024 * 1024;
  const newlineOffsets: number[] = [];
  let position = stat.size;
  let effectiveEnd = stat.size;

  try {
    while (position > 0 && newlineOffsets.length <= safeMaxLines) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      const chunk = bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 10) continue;
        const absoluteOffset = position + i;
        if (absoluteOffset === stat.size - 1) {
          effectiveEnd = absoluteOffset;
          continue;
        }
        newlineOffsets.push(absoluteOffset);
        if (newlineOffsets.length > safeMaxLines) break;
      }
    }
  } finally {
    closeSync(fd);
  }

  const ranges: JsonlRange[] = [];
  let lineEnd = effectiveEnd;
  for (const newlineOffset of newlineOffsets) {
    const lineStart = newlineOffset + 1;
    if (lineEnd > lineStart) ranges.unshift({ start: lineStart, end: lineEnd });
    lineEnd = newlineOffset;
    if (ranges.length >= safeMaxLines) break;
  }
  if (ranges.length < safeMaxLines && lineEnd > 0) ranges.unshift({ start: 0, end: lineEnd });

  return ranges.slice(-safeMaxLines);
}

function readInstrumentSnapshotPrefix(path: string, range: JsonlRange): string | null {
  const fd = openSync(path, "r");
  const chunkSize = 64 * 1024;
  const optionNeedle = ',"options":';
  const maxPrefixBytes = 16 * 1024 * 1024;
  let position = range.start;
  let prefixBytes = 0;
  let text = "";

  try {
    while (position < range.end) {
      const bytesToRead = Math.min(chunkSize, range.end - position);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;

      position += bytesRead;
      prefixBytes += bytesRead;
      text += buffer.subarray(0, bytesRead).toString("utf-8");

      const optionIndex = text.indexOf(optionNeedle);
      if (optionIndex >= 0) return text.slice(0, optionIndex) + "}";
      if (prefixBytes > maxPrefixBytes) return null;
    }
  } finally {
    closeSync(fd);
  }

  return text.trim() || null;
}

function compactInstrumentSnapshotForLlm(snapshot: InstrumentSnapshotFile) {
  const optionSummaries = Object.fromEntries(
    Object.entries(snapshot.options ?? {}).map(([symbol, optionSnapshot]) => {
      const expirations = Array.from(
        new Set(optionSnapshot.chains.map((chain) => chain.expiration).filter(Boolean)),
      )
        .sort()
        .slice(0, 6);
      const callCount = optionSnapshot.chains.filter((chain) => chain.type === "call").length;
      const putCount = optionSnapshot.chains.length - callCount;
      const totalVolume = optionSnapshot.chains.reduce((sum, chain) => sum + (chain.volume ?? 0), 0);
      const totalOpenInterest = optionSnapshot.chains.reduce((sum, chain) => sum + (chain.openInterest ?? 0), 0);

      return [
        symbol,
        {
          underlyingPrice: optionSnapshot.underlyingPrice,
          source: optionSnapshot.source,
          chainCount: optionSnapshot.chains.length,
          callCount,
          putCount,
          expirations,
          totalVolume,
          totalOpenInterest,
        },
      ];
    }),
  );

  return {
    timestamp: snapshot.timestamp,
    spots: snapshot.spots,
    hyperliquid: snapshot.hyperliquid,
    polymarket: snapshot.polymarket,
    options: optionSummaries,
  };
}

function latestInstrumentSnapshot(snapshots: InstrumentSnapshotFile[]): InstrumentSnapshotFile | null {
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

// ─── Portfolio Management ────────────────────────────────────────────────────

function loadPortfolio(): Portfolio {
  const trackedPortfolio = readJson<Portfolio>("portfolio.json", {
    cash: MAX_BANKROLL,
    positions: [],
    totalRealizedPnl: 0,
    totalTrades: 0,
    winCount: 0,
    lossCount: 0,
    lastUpdated: new Date().toISOString(),
  });
  const portfolio = readJsonPath<Portfolio>(LIVE_PORTFOLIO_FILE, trackedPortfolio);
  // Counters are derived from the cleaned trades-detailed.csv on every load so
  // that accumulator drift (duplicate fills, contaminated closes baked into
  // totalRealizedPnl) self-heals next cycle. cash and positions still come
  // from disk because they reflect open exposure, not closed-trade history.
  try {
    const totals = recomputePortfolioTotalsFromLedger();
    portfolio.totalTrades = totals.totalTrades;
    portfolio.winCount = totals.winCount;
    portfolio.lossCount = totals.lossCount;
    portfolio.totalRealizedPnl = totals.totalRealizedPnl;
  } catch (err) {
    console.error(`[portfolio] recompute from ledger failed; using on-disk counters: ${(err as Error).message}`);
  }
  return portfolio;
}

function savePortfolio(p: Portfolio) {
  p.lastUpdated = new Date().toISOString();
  writeJson("portfolio.json", p);
  writeJsonPath(LIVE_PORTFOLIO_FILE, p);
}

function importCompletedRealPolymarketPackages(portfolio: Portfolio): string[] {
  const packages = readJson<RealPolymarketLivePackage[]>(REAL_PM_PACKAGES_FILE, []);
  if (!Array.isArray(packages) || packages.length === 0) return [];

  const existingIds = new Set(portfolio.positions
    .map((position) => position.instrumentId)
    .filter((id): id is string => typeof id === "string" && id.length > 0));
  const notes: string[] = [];

  for (const pkg of packages) {
    if (pkg.dryRun || pkg.status !== "package_complete") continue;
    if (!pkg.packageId || existingIds.has(pkg.packageId)) continue;
    if (!(pkg.filledShares > 0) || !(pkg.actualCost > 0)) continue;
    if (!Array.isArray(pkg.packageLegs) || pkg.packageLegs.length < 2) continue;

    const entryPrice = pkg.actualCost / pkg.filledShares;
    const expiryDate = pkg.settlementWindow?.endDate ?? new Date(Date.now() + 30 * 86400000).toISOString();
    const openedAt = pkg.createdAt ?? new Date().toISOString();
    const instrumentLabel = `${pkg.packageId.split("::")[0]} - real PM monotonic arb package - YES ${pkg.broadStrike} / NO ${pkg.narrowStrike}`;
    const position: Position = {
      id: `RPM-${pkg.id ?? Date.now().toString(36)}`,
      openedAt,
      asset: pkg.asset,
      venue: "polymarket",
      direction: "long",
      entryPrice,
      currentPrice: entryPrice,
      size: pkg.actualCost,
      leverage: 1,
      signalType: "MONOTONIC_ARB",
      hypothesisId: null,
      thesis: `[REAL PM MONOTONIC ARB MIRROR] Real Polymarket package filled first, then mirrored into tracker. Package cost $${pkg.actualCost.toFixed(4)} for ${pkg.filledShares.toFixed(4)} paired shares (entry ${entryPrice.toFixed(4)}); floor $${pkg.filledShares.toFixed(4)}, jackpot $${(pkg.filledShares * 2).toFixed(4)}.`,
      targetPct: null,
      stopPct: 100,
      expiryDate,
      instrumentType: "pm_package",
      instrumentId: pkg.packageId,
      instrumentLabel,
      packageLegs: pkg.packageLegs,
      fundingPnlAccrued: 0,
    };

    portfolio.cash -= pkg.actualCost;
    portfolio.positions.push(position);
    existingIds.add(pkg.packageId);
    notes.push(`Mirrored real PM monotonic package ${pkg.asset} ${pkg.broadStrike}/${pkg.narrowStrike}: cost $${pkg.actualCost.toFixed(4)}, shares ${pkg.filledShares.toFixed(4)}.`);
  }

  return notes;
}

// ─── LLM Cadence State ───────────────────────────────────────────────────────

interface LlmState {
  lastCallAt: string | null;
  lastCallReasons: string[];
  skipsSinceLastCall: number;
  recentSkipReasons: string[];
  dailyCallCounts: Record<string, number>;
  recentSignalKeys: Record<string, string>;
  updatedAt: string;
}

function utcDateKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function llmSignalKey(signal: Signal): string {
  const event = signal.contractHint?.preferredEventSlug ?? "";
  const market = signal.contractHint?.forceMarketId ?? "";
  return [signal.type, signal.asset, signal.venue, signal.direction, event, market].join(":");
}

function loadLlmState(): LlmState {
  const defaults: LlmState = {
    lastCallAt: null,
    lastCallReasons: [],
    skipsSinceLastCall: 0,
    recentSkipReasons: [],
    dailyCallCounts: {},
    recentSignalKeys: {},
    updatedAt: new Date().toISOString(),
  };
  const saved = readJson<Partial<LlmState>>(LLM_STATE_FILE, defaults);
  return {
    ...defaults,
    ...saved,
    lastCallReasons: saved.lastCallReasons ?? [],
    recentSkipReasons: saved.recentSkipReasons ?? [],
    dailyCallCounts: saved.dailyCallCounts ?? {},
    recentSignalKeys: saved.recentSignalKeys ?? {},
  };
}

function updateLlmCadenceAccounting(state: LlmState, signals: Signal[], didCall: boolean) {
  const now = Date.now();
  const today = utcDateKey(now);
  const minSignalSeenAt = now - Math.max(LLM_NEW_SIGNAL_DEDUPE_HOURS * 4, 24) * 60 * 60 * 1000;
  state.recentSignalKeys = Object.fromEntries(
    Object.entries(state.recentSignalKeys ?? {}).filter(([, seenAt]) => {
      const t = Date.parse(seenAt);
      return Number.isFinite(t) && t >= minSignalSeenAt;
    }),
  );
  for (const signal of signals) state.recentSignalKeys[llmSignalKey(signal)] = new Date(now).toISOString();
  state.dailyCallCounts = Object.fromEntries(
    Object.entries(state.dailyCallCounts ?? {}).filter(([date]) => date >= utcDateKey(now - 7 * 24 * 60 * 60 * 1000)),
  );
  if (didCall) state.dailyCallCounts[today] = (state.dailyCallCounts[today] ?? 0) + 1;
}

function saveLlmState(state: LlmState) {
  state.updatedAt = new Date().toISOString();
  writeJson(LLM_STATE_FILE, state);
}

function normalizeSignalWeight(weight: SignalWeight): SignalWeight {
  const perAsset = weight.perAsset ?? {};
  for (const [asset, stats] of Object.entries(perAsset)) {
    const accuracy = stats.trades > 0 ? stats.wins / stats.trades : 0.5;
    if (stats.trades >= 5 && accuracy < KILL_THRESHOLD && !stats.disabled) {
      stats.disabled = true;
      stats.disabledAt = weight.lastTriggered || new Date().toISOString();
      stats.disabledReason = `${weight.type} on ${asset} disabled after ${stats.wins}/${stats.trades} wins (${(accuracy * 100).toFixed(0)}% accuracy).`;
    }
  }
  return {
    ...weight,
    perAsset,
  };
}

function loadWeights(): SignalWeight[] {
  const defaults = defaultWeights();
  const saved = readJson<SignalWeight[]>("signal-weights.json", []);
  const byType = new Map(defaults.map((weight) => [weight.type, weight]));
  for (const weight of saved) byType.set(weight.type, weight);
  return Array.from(byType.values()).map(normalizeSignalWeight);
}

function saveWeights(w: SignalWeight[]) {
  writeJson("signal-weights.json", w);
}

function defaultLearningParams(): LearningParams {
  return {
    macroMomentum24hThresholdPts: 4,
    contrarianTrendMarginPct: 0.5,
    positiveMomentum24hPct: 1.5,
    llmTradeExpiryDays: 14,
    momentumLongExpiryDays: 21,
    signalRisk: DEFAULT_SIGNAL_RISK,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSignalRisk(raw: Partial<LearningParams>["signalRisk"]): Record<string, SignalRiskParams> {
  const normalized: Record<string, SignalRiskParams> = {};
  for (const [signalType, defaults] of Object.entries(DEFAULT_SIGNAL_RISK)) {
    if (LLM_LOCKED_SIGNAL_RISK.has(signalType)) {
      normalized[signalType] = { ...defaults };
      continue;
    }
    const candidate = raw?.[signalType];
    normalized[signalType] = {
      targetPct: candidate?.targetPct === null || typeof candidate?.targetPct === "number" ? candidate.targetPct : defaults.targetPct,
      stopPct: typeof candidate?.stopPct === "number" ? candidate.stopPct : defaults.stopPct,
    };
  }
  normalizeFundingRiskShape(normalized);
  return normalized;
}

function normalizeFundingRiskShape(signalRisk: Record<string, SignalRiskParams>) {
  signalRisk.FUNDING_EXTREME_SHORT = {
    targetPct: Math.max(signalRisk.FUNDING_EXTREME_SHORT?.targetPct ?? 0, 4),
    stopPct: Math.min(signalRisk.FUNDING_EXTREME_SHORT?.stopPct ?? 2.5, 2.5),
  };
  signalRisk.FUNDING_EXTREME_LONG = {
    targetPct: Math.max(signalRisk.FUNDING_EXTREME_LONG?.targetPct ?? 0, 5),
    stopPct: Math.min(signalRisk.FUNDING_EXTREME_LONG?.stopPct ?? 2.5, 2.5),
  };
}

function loadLearningParams(): LearningParams {
  const defaults = defaultLearningParams();
  const raw = readJson<Partial<LearningParams>>(LEARNING_PARAMS_FILE, defaults);
  return {
    macroMomentum24hThresholdPts: typeof raw.macroMomentum24hThresholdPts === "number" ? raw.macroMomentum24hThresholdPts : defaults.macroMomentum24hThresholdPts,
    contrarianTrendMarginPct: typeof raw.contrarianTrendMarginPct === "number" ? raw.contrarianTrendMarginPct : defaults.contrarianTrendMarginPct,
    positiveMomentum24hPct: typeof raw.positiveMomentum24hPct === "number" ? raw.positiveMomentum24hPct : defaults.positiveMomentum24hPct,
    llmTradeExpiryDays: typeof raw.llmTradeExpiryDays === "number" ? raw.llmTradeExpiryDays : defaults.llmTradeExpiryDays,
    momentumLongExpiryDays: typeof raw.momentumLongExpiryDays === "number" ? raw.momentumLongExpiryDays : defaults.momentumLongExpiryDays,
    signalRisk: normalizeSignalRisk(raw.signalRisk),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : defaults.updatedAt,
  };
}

function saveLearningParams(params: LearningParams) {
  writeJson(LEARNING_PARAMS_FILE, params);
}

function loadBlockedSignals(): BlockedSignalShadow[] {
  return readJson<BlockedSignalShadow[]>(BLOCKED_SIGNALS_FILE, []);
}

function saveBlockedSignals(blockedSignals: BlockedSignalShadow[]) {
  writeJson(BLOCKED_SIGNALS_FILE, blockedSignals);
}

function loadHypotheses(): Hypothesis[] {
  const hypotheses = readJson<Hypothesis[]>("hypotheses.json", []);
  for (const hypothesis of hypotheses) ensureHypothesisSetupMetadata(hypothesis);
  return hypotheses;
}

function saveHypotheses(h: Hypothesis[]) {
  writeJson("hypotheses.json", h);
}

// ─── Default Signal Weights ──────────────────────────────────────────────────

function defaultWeights(): SignalWeight[] {
  const types = [
    "PM_IV_GT_OPT_IV",
    "OPT_IV_GT_PM_IV",
    "FUNDING_EXTREME_LONG",
    "FUNDING_EXTREME_SHORT",
    "PM_EV_ABOVE_SPOT",
    "PM_EV_BELOW_SPOT",
    "MACRO_MOMENTUM_UP",
    "MACRO_MOMENTUM_DOWN",
    "BASIS_PREMIUM",
    "BASIS_DISCOUNT",
    "PC_RATIO_EXTREME_HIGH",
    "PC_RATIO_EXTREME_LOW",
    "LLM_HYPOTHESIS",
    "ONE_TOUCH_HIGH_EDGE_NO",
  ];
  return types.map((t) => ({
    type: t,
    weight: 0.5,
    trades: 0,
    wins: 0,
    avgPnlPct: 0,
    lastTriggered: "",
    enabled: true,
    perAsset: {},
  }));
}

// ─── Signal Generation ───────────────────────────────────────────────────────

function weightForSignalAsset(
  weightMap: Map<string, SignalWeight>,
  signalType: string,
  asset: string,
): SignalWeight | null {
  const weight = weightMap.get(signalType);
  if (!weight || !weight.enabled) return null;
  if (weight.perAsset?.[asset]?.disabled) return null;
  return weight;
}

function riskForSignal(learningParams: LearningParams, signalType: string): SignalRiskParams {
  return learningParams.signalRisk[signalType] ?? DEFAULT_SIGNAL_RISK[signalType] ?? { targetPct: 3, stopPct: 3 };
}

function spotRiskOverride(asset: string, venue: string, direction: string, leverage = 1): SignalRiskParams | null {
  if (venue !== "spot" || leverage !== 1) return null;
  if (direction === "long") return SPOT_LONG_RISK_BY_ASSET[asset] ?? null;
  if (direction === "short") return SPOT_SHORT_RISK;
  return null;
}

function applySpotRiskToSignal(signal: Signal): Signal {
  const override = spotRiskOverride(signal.asset, signal.venue, signal.direction, signal.leverage ?? 1);
  return override ? { ...signal, targetPct: override.targetPct, stopPct: override.stopPct } : signal;
}

function applySpotRiskToOpenPositions(portfolio: Portfolio): string[] {
  const notes: string[] = [];
  for (const position of portfolio.positions) {
    const override = spotRiskOverride(position.asset, position.venue, position.direction, position.leverage ?? 1);
    if (!override) continue;
    if (position.targetPct !== override.targetPct || position.stopPct !== override.stopPct) {
      notes.push(`${position.asset} ${position.direction} ${position.instrumentType ?? position.venue} ${position.signalType}: ${formatTargetPct(position.targetPct)}/-${position.stopPct} -> ${formatTargetPct(override.targetPct)}/-${override.stopPct}`);
      position.targetPct = override.targetPct;
      position.stopPct = override.stopPct;
    }
  }
  return notes;
}

function applyProductionPolymarketRisk(position: Position): string | null {
  if (position.venue !== "polymarket" || (position.instrumentType !== "pm_yes" && position.instrumentType !== "pm_no")) return null;
  if (position.signalType === ONE_TOUCH_HIGH_EDGE_SIGNAL_NO) {
    const risk = DEFAULT_SIGNAL_RISK[ONE_TOUCH_HIGH_EDGE_SIGNAL_NO];
    if (position.targetPct === risk.targetPct && position.stopPct === risk.stopPct) return null;
    const note = `${position.asset} ${position.direction} ${position.instrumentType} ${position.signalType}: ${formatTargetPct(position.targetPct)}/-${position.stopPct} -> ${formatTargetPct(risk.targetPct)}/-${risk.stopPct}`;
    position.targetPct = risk.targetPct;
    position.stopPct = risk.stopPct;
    return note;
  }
  if (position.targetPct === PRODUCTION_POLYMARKET_RISK.targetPct && position.stopPct === PRODUCTION_POLYMARKET_RISK.stopPct) return null;
  const note = `${position.asset} ${position.direction} ${position.instrumentType} ${position.signalType}: ${formatTargetPct(position.targetPct)}/-${position.stopPct} -> ${formatTargetPct(PRODUCTION_POLYMARKET_RISK.targetPct)}/-${PRODUCTION_POLYMARKET_RISK.stopPct}`;
  position.targetPct = PRODUCTION_POLYMARKET_RISK.targetPct;
  position.stopPct = PRODUCTION_POLYMARKET_RISK.stopPct;
  return note;
}

function applyProductionPolymarketRiskToOpenPositions(portfolio: Portfolio): string[] {
  const notes: string[] = [];
  for (const position of portfolio.positions) {
    const note = applyProductionPolymarketRisk(position);
    if (note) notes.push(note);
  }
  return notes;
}

function isFundingSignal(signalType: string): boolean {
  return signalType === "FUNDING_EXTREME_SHORT"
    || signalType === "FUNDING_EXTREME_LONG"
    || signalType === WEEKEND_HL_FUNDING_LIVE_SIGNAL;
}

function fundingSignalAllowed(signalType: string, asset: string): boolean {
  if (signalType === "FUNDING_EXTREME_SHORT" && asset === "HYPE") return false;
  if (signalType === "FUNDING_EXTREME_LONG" && asset === "OIL") return false;
  return true;
}

function formatTargetPct(targetPct: number | null): string {
  return targetPct === null ? "uncapped" : `+${targetPct}`;
}

function getAssetPrice(row: SnapshotRow, asset: string): number | null {
  const map: Record<string, string> = {
    BTC: "btc_spot", ETH: "eth_spot", HYPE: "hype_spot", GOLD: "gold_gc_spot",
    AMZN: "amzn_stock", SPY: "spy_spot", SILVER: "silver_spot", SOL: "sol_spot", OIL: "oil_wti_spot",
  };
  const v = row[map[asset] ?? ""];
  return typeof v === "number" && v > 0 ? v : null;
}

function getHyperliquidPerpPrice(row: SnapshotRow, asset: string): number | null {
  const map: Record<string, string> = {
    BTC: "btc_spot",
    ETH: "eth_spot",
    HYPE: "hype_spot",
    GOLD: "gold_gc_spot",
    AMZN: "amzn_hl_perp",
    SPY: "spy_spot",
    SILVER: "silver_spot",
    SOL: "sol_spot",
    OIL: "oil_wti_spot",
  };
  const v = row[map[asset] ?? ""];
  return typeof v === "number" && v > 0 ? v : null;
}

function getHyperliquidMarkPriceFromSnapshot(snapshot: InstrumentSnapshotFile | null | undefined, asset: string): number | null {
  const mark = snapshot?.hyperliquid?.[asset]?.markPx;
  return typeof mark === "number" && mark > 0 ? mark : null;
}

function getHyperliquidFundingFromSnapshot(snapshot: InstrumentSnapshotFile | null | undefined, asset: string): number | null {
  const funding = snapshot?.hyperliquid?.[asset]?.fundingAnnualized;
  return typeof funding === "number" && Number.isFinite(funding) ? funding : null;
}

// The Builder DEX stock perps are tied to US equity hours. Funding only
// dislocates while the underlying cash market is closed, so the funding
// reversion window opens at the Friday 4:00pm ET cash close (so the
// hourly :27 trader cron at 4:27pm ET is the first to fire) and stays
// open through the weekend until Monday 9:30am ET (cash open). We
// evaluate the current wall-clock time in America/New_York so the gate
// shifts correctly between EST and EDT without hardcoding offsets.
function isStockPerpFundingWindowOpen(date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutesOfDay = hour * 60 + minute;
  if (weekday === "Sat" || weekday === "Sun") return true;
  if (weekday === "Fri" && minutesOfDay >= 16 * 60) return true;
  if (weekday === "Mon" && minutesOfDay < 9 * 60 + 30) return true;
  return false;
}

function isLongDatedPolymarketPosition(position: Position): boolean {
  if (position.venue !== "polymarket") return false;
  const haystack = `${position.instrumentId ?? ""} ${position.instrumentLabel ?? ""} ${position.thesis ?? ""}`.toLowerCase();
  return haystack.includes("before-2027")
    || haystack.includes("december 31, 2026")
    || haystack.includes("end of december");
}

function longDatedPolymarketExpiry(openedAtIso: string): string {
  const opened = new Date(openedAtIso);
  const expiry = new Date(opened);
  expiry.setDate(expiry.getDate() + LONG_DATED_POLYMARKET_HOLD_DAYS);
  return expiry.toISOString();
}

function extendLongDatedPolymarketTimelines(portfolio: Portfolio, blockedSignals: BlockedSignalShadow[]): string[] {
  const notes: string[] = [];
  const maybeExtend = (position: Position, label: string) => {
    if (!isLongDatedPolymarketPosition(position)) return;
    const desired = longDatedPolymarketExpiry(position.openedAt);
    const currentMs = Date.parse(position.expiryDate);
    const desiredMs = Date.parse(desired);
    if (Number.isFinite(currentMs) && currentMs >= desiredMs) return;
    const before = position.expiryDate;
    position.expiryDate = desired;
    notes.push(`${label} ${position.id} ${position.asset} ${position.instrumentLabel ?? position.instrumentId ?? ""}: expiry ${before} → ${desired}`);
  };

  for (const position of portfolio.positions) {
    maybeExtend(position, "live");
  }
  for (const shadow of blockedSignals) {
    if (shadow.status !== "open") continue;
    maybeExtend(shadow.position, "shadow");
  }
  return notes;
}

function getHyperliquidFundingAnnualized(row: SnapshotRow, asset: string): number | null {
  const map: Record<string, string> = {
    BTC: "btc_hl_funding_ann",
    ETH: "eth_hl_funding_ann",
    HYPE: "hype_hl_funding_ann",
    GOLD: "gold_hl_funding_ann",
    AMZN: "amzn_hl_funding_ann",
    OIL: "oil_hl_funding_ann",
  };
  const v = row[map[asset] ?? ""];
  return typeof v === "number" ? v / 100 : null;
}

function preferredPolymarketEventSlugs(asset: string): string[] {
  switch (asset) {
    case "BTC":
      return ["what-price-will-bitcoin-hit-before-2027"];
    case "ETH":
      return ["what-price-will-ethereum-hit-before-2027"];
    case "HYPE":
      return ["what-price-will-hyperliquid-hit-before-2027"];
    case "GOLD":
      return ["gc-over-under-jun-2026", "gc-hit-jun-2026", "what-will-gold-gc-hit-by-end-of-december"];
    case "SPY":
      return ["spx-hit-jun-2026", "spx-hit-dec-2026"];
    case "SILVER":
      return ["si-hit-jun-2026"];
    case "SOL":
      return ["what-price-will-solana-hit-before-2027"];
    case "OIL":
      return ["cl-over-under-jun-2026", "cl-hit-jun-2026"];
    default:
      return [];
  }
}

function inferPolymarketPreferredDirection(
  direction: "long" | "short",
  signalType?: string,
  thesis?: string,
): "above" | "below" {
  if (signalType === "PM_IV_GT_OPT_IV" || signalType === "OPT_IV_GT_PM_IV" || signalType === "PM_EV_ABOVE_SPOT") {
    return "above";
  }
  if (signalType === "PM_EV_BELOW_SPOT") {
    return "below";
  }

  const text = (thesis ?? "").toLowerCase();
  if (
    text.includes("below")
    || text.includes("downside")
    || text.includes("decline")
    || text.includes("drop")
    || text.includes("bearish")
    || text.includes("selloff")
    || text.includes("fade")
  ) {
    return "below";
  }
  if (
    text.includes("above")
    || text.includes("upside")
    || text.includes("breakout")
    || text.includes("rally")
    || text.includes("bullish")
    || text.includes("target")
  ) {
    return "above";
  }

  return direction === "long" ? "above" : "below";
}

function instrumentTypeForPolymarketExposure(
  positionDirection: "long" | "short",
  contractDirection: "above" | "below",
): "pm_yes" | "pm_no" {
  if (positionDirection === "long") {
    return contractDirection === "above" ? "pm_yes" : "pm_no";
  }
  return contractDirection === "above" ? "pm_no" : "pm_yes";
}

function polymarketEntryPrice(contract: InstrumentSnapshotContract, instrumentType: "pm_yes" | "pm_no"): number {
  if (instrumentType === "pm_yes") return contract.bestAsk && contract.bestAsk > 0 ? contract.bestAsk : contract.yesPrice;
  return contract.bestBid && contract.bestBid > 0 ? 1 - contract.bestBid : 1 - contract.yesPrice;
}

function passesOneSidedPolymarketEntryPrice(entryPrice: number): boolean {
  return entryPrice >= MIN_ONE_SIDED_PM_ENTRY_PRICE && entryPrice < 1;
}

function passesPolymarketEntryQualityGate(contract: InstrumentSnapshotContract): boolean {
  const bid = contract.bestBid ?? 0;
  const ask = contract.bestAsk ?? 0;
  if (bid <= 0 || ask <= 0) return false;
  const spread = contract.spread ?? Math.max(0, ask - bid);
  if (spread > MAX_PM_ENTRY_SPREAD) return false;
  const liquidity = contract.liquidity ?? 0;
  if (liquidity < MIN_PM_ENTRY_LIQUIDITY) return false;
  return true;
}

function polymarketExitPrice(contract: InstrumentSnapshotContract, instrumentType: "pm_yes" | "pm_no"): number {
  if (instrumentType === "pm_yes") return contract.bestBid && contract.bestBid > 0 ? contract.bestBid : contract.yesPrice;
  return contract.bestAsk && contract.bestAsk > 0 ? 1 - contract.bestAsk : 1 - contract.yesPrice;
}

function selectPolymarketContract(
  snapshot: InstrumentSnapshotFile,
  asset: string,
  underlyingSpot: number,
  direction: "long" | "short",
  hint?: Signal["contractHint"],
): { event: InstrumentSnapshotEvent; contract: InstrumentSnapshotContract; instrumentType: "pm_yes" | "pm_no"; entryPrice: number } | null {
  if (hint?.forceMarketId && hint?.forceInstrumentType) {
    for (const event of snapshot.polymarket) {
      if (event.asset !== asset) continue;
      const contract = event.contracts.find((c) => c.marketId === hint.forceMarketId);
      if (!contract || !(contract.yesPrice > 0 && contract.yesPrice < 1)) continue;
      if (!passesPolymarketEntryQualityGate(contract)) continue;
      const entryPrice = polymarketEntryPrice(contract, hint.forceInstrumentType);
      if (!passesOneSidedPolymarketEntryPrice(entryPrice)) continue;
      return { event, contract, instrumentType: hint.forceInstrumentType, entryPrice };
    }
    return null;
  }
  const preferredSlugs = hint?.preferredEventSlug ? [hint.preferredEventSlug, ...preferredPolymarketEventSlugs(asset)] : preferredPolymarketEventSlugs(asset);
  const events = snapshot.polymarket.filter((event) => event.asset === asset);
  const rankedEvents = preferredSlugs
    .map((slug) => events.find((event) => event.slug === slug))
    .filter((event): event is InstrumentSnapshotEvent => !!event);
  const extraEvents = events
    .filter((event) => !rankedEvents.some((ranked) => ranked.slug === event.slug))
    .sort((a, b) => b.totalVolume - a.totalVolume);
  const eventOrder = [...rankedEvents, ...extraEvents];

  const preferredDirection = hint?.preferredDirection ?? inferPolymarketPreferredDirection(direction);
  const directionOrder: Array<"above" | "below"> = hint?.allowDirectionFallback === false
    ? [preferredDirection]
    : preferredDirection === "above" ? ["above", "below"] : ["below", "above"];

  for (const event of eventOrder) {
    const live = event.contracts.filter((c) => c.yesPrice > 0 && c.yesPrice < 1 && passesPolymarketEntryQualityGate(c));
    for (const contractDirection of directionOrder) {
      const directional = live.filter((c) => c.direction === contractDirection);
      const preferredSide = directional
        .filter((c) => contractDirection === "above" ? c.strike >= underlyingSpot : c.strike <= underlyingSpot)
        .sort((a, b) => Math.abs(a.strike - underlyingSpot) - Math.abs(b.strike - underlyingSpot) || b.volume - a.volume);
      const fallback = directional
        .sort((a, b) => Math.abs(a.strike - underlyingSpot) - Math.abs(b.strike - underlyingSpot) || b.volume - a.volume);
      const contract = preferredSide[0] ?? fallback[0];
      if (!contract) continue;

      const instrumentType = hint?.forceInstrumentType ?? instrumentTypeForPolymarketExposure(direction, contractDirection);
      const entryPrice = polymarketEntryPrice(contract, instrumentType);
      if (!passesOneSidedPolymarketEntryPrice(entryPrice)) continue;

      return { event, contract, instrumentType, entryPrice };
    }
  }

  return null;
}

function findPolymarketContractMark(
  snapshot: InstrumentSnapshotFile,
  position: Position,
  conservativeExit = false,
): { price: number; underlyingPrice: number | null } | null {
  const event = snapshot.polymarket.find((candidate) =>
    candidate.slug === position.instrumentId?.split("::")[0] && candidate.contracts.some((c) => c.marketId === position.instrumentId?.split("::")[1]),
  );
  if (!event) return null;
  const marketId = position.instrumentId?.split("::")[1];
  const contract = event.contracts.find((c) => c.marketId === marketId);
  if (!contract) return null;
  const price = conservativeExit && (position.instrumentType === "pm_yes" || position.instrumentType === "pm_no")
    ? polymarketExitPrice(contract, position.instrumentType)
    : position.instrumentType === "pm_no" ? 1 - contract.yesPrice : contract.yesPrice;
  return { price, underlyingPrice: snapshot.spots[position.asset] ?? null };
}

function findPolymarketPackageMark(
  snapshot: InstrumentSnapshotFile,
  position: Position,
): { price: number; underlyingPrice: number | null } | null {
  if (!position.packageLegs || position.packageLegs.length === 0) return null;

  let packagePrice = 0;
  for (const leg of position.packageLegs) {
    const [eventSlug, marketId] = leg.instrumentId.split("::");
    const event = snapshot.polymarket.find((candidate) => candidate.slug === eventSlug);
    const contract = event?.contracts.find((candidate) => candidate.marketId === marketId);
    if (!contract) return null;
    packagePrice += polymarketExitPrice(contract, leg.instrumentType);
  }

  return { price: packagePrice, underlyingPrice: snapshot.spots[position.asset] ?? null };
}

// Settle a monotonic-arb PM package at expiry by computing the actual leg
// payouts from the asset's realized high/low during the contract period.
//
// Each leg has a direction:
//   "above" → YES resolves $1 if max(spot during period) >= strike, else $0
//   "below" → YES resolves $1 if min(spot during period) <= strike, else $0
// NO leg payout is (1 - YES leg payout). Total package payout is the sum.
//
// Contract period comes from the market's own start/end window. Monthly touch
// markets effectively scan that month; long-window markets like "before 2027"
// or "by end of December" scan from market start through expiry. The
// position's actual openedAt is NOT used because PM resolves on the published
// market window, not just our held window.
//
// Returns null if no valuation rows fall inside the contract period
// (i.e. we don't have price data to settle against — leave it to the live
// mark for now).
function settleMonotonicArbPackage(
  position: Position,
  valRows: SnapshotRow[],
): { price: number; underlyingPrice: number | null; marketPnl: number; pnl: number; pnlPct: number } | null {
  if (!position.packageLegs || position.packageLegs.length < 2) return null;
  if (position.instrumentType !== "pm_package") return null;
  const expiryMs = new Date(position.expiryDate).getTime();
  if (!Number.isFinite(expiryMs) || expiryMs > Date.now()) return null;
  // Touch markets resolve on the underlying's price path between market
  // creation (startDate) and expiry — NOT just the final calendar month. A
  // market like "SPX hit by end of December" is created in January and a touch
  // anywhere Jan–Dec resolves it YES; restricting to December would miss most
  // touches and silently drop the jackpot (the between-strikes $2 outcome,
  // which is the whole upside of the strategy). Use the captured leg startDate;
  // fall back for legacy legs that predate startDate capture: scan the full
  // available history for multi-month / "before-YYYY" markets, and the single
  // calendar month only for "...-in-<month>-<year>" markets created at month
  // start.
  const periodEndMs = expiryMs;
  let periodStartMs = NaN;
  for (const leg of position.packageLegs) {
    const sd = (leg as { startDate?: string | null }).startDate;
    if (typeof sd === "string") {
      const ms = Date.parse(sd);
      if (Number.isFinite(ms)) periodStartMs = Number.isNaN(periodStartMs) ? ms : Math.min(periodStartMs, ms);
    }
  }
  if (!Number.isFinite(periodStartMs)) {
    const slug = (position.instrumentId ?? "").split("::")[0].toLowerCase();
    const singleMonth = /-in-(january|february|march|april|may|june|july|august|september|october|november|december)-\d{4}/.test(slug);
    if (singleMonth) {
      const inside = new Date(expiryMs - 12 * 60 * 60 * 1000);
      periodStartMs = Date.UTC(inside.getUTCFullYear(), inside.getUTCMonth(), 1);
    } else {
      periodStartMs = -Infinity;
    }
  }
  let highSeen = -Infinity;
  let lowSeen = Infinity;
  for (const row of valRows) {
    // daily-valuations rows are keyed by `date` (e.g. "2026-06-02T00" or
    // "2026-04-03"); instrument-snapshot-derived rows use `timestamp`. Accept
    // either and normalize the hour-truncated form via snapshotTimeMs.
    const tsRaw = typeof row.timestamp === "string" && row.timestamp
      ? row.timestamp
      : (typeof row.date === "string" ? row.date : "");
    const ts = tsRaw ? snapshotTimeMs(tsRaw) : NaN;
    if (!Number.isFinite(ts) || ts < periodStartMs || ts >= periodEndMs) continue;
    const px = getAssetPrice(row, position.asset);
    if (px === null) continue;
    if (px > highSeen) highSeen = px;
    if (px < lowSeen) lowSeen = px;
  }
  if (!Number.isFinite(highSeen) || !Number.isFinite(lowSeen)) return null;
  // Resolve each leg
  let totalPayout = 0;
  for (const leg of position.packageLegs) {
    const dir = (leg as { direction?: string }).direction;
    const strike = (leg as { strike?: number }).strike;
    if (typeof strike !== "number" || (dir !== "above" && dir !== "below")) return null;
    const yesResolves = dir === "above" ? highSeen >= strike : lowSeen <= strike;
    const legPayout = leg.instrumentType === "pm_yes"
      ? (yesResolves ? 1 : 0)
      : (yesResolves ? 0 : 1);
    totalPayout += legPayout;
  }
  // shares = position.size / entryPrice (paid `entryPrice` per share); at
  // settlement each share pays `totalPayout`. So realized cash = shares *
  // totalPayout and PnL = shares * (totalPayout - entryPrice).
  const shares = position.size / position.entryPrice;
  const marketPnl = shares * (totalPayout - position.entryPrice);
  const pnlPct = (marketPnl / position.size) * 100;
  const underlyingPrice = valRows.length > 0 ? (getAssetPrice(valRows[valRows.length - 1], position.asset) ?? null) : null;
  return { price: totalPayout, underlyingPrice, marketPnl, pnl: marketPnl, pnlPct };
}

function applyConservativePolymarketEntry(position: Position, latestSnapshot: InstrumentSnapshotFile | null) {
  if (!latestSnapshot || (position.instrumentType !== "pm_yes" && position.instrumentType !== "pm_no")) return;
  const [eventSlug, marketId] = position.instrumentId?.split("::") ?? [];
  const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === eventSlug);
  const contract = event?.contracts.find((candidate) => candidate.marketId === marketId);
  if (!contract) return;
  const entryPrice = polymarketEntryPrice(contract, position.instrumentType);
  if (!passesOneSidedPolymarketEntryPrice(entryPrice)) return;
  position.entryPrice = entryPrice;
  position.currentPrice = entryPrice;
}

function polymarketMarketQuality(
  position: Position,
  latestSnapshot: InstrumentSnapshotFile | null,
): BlockedSignalShadow["marketQuality"] | undefined {
  if (!latestSnapshot || (position.instrumentType !== "pm_yes" && position.instrumentType !== "pm_no")) return undefined;
  const [eventSlug, marketId] = position.instrumentId?.split("::") ?? [];
  const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === eventSlug);
  const contract = event?.contracts.find((candidate) => candidate.marketId === marketId);
  if (!contract) return undefined;

  const yesBid = contract.bestBid ?? 0;
  const yesAsk = contract.bestAsk ?? 0;
  const yesSpread = contract.spread ?? Math.max(0, yesAsk - yesBid);
  const liquidity = contract.liquidity ?? 0;
  const flags: string[] = [];
  if (yesBid <= 0 || yesAsk <= 0) flags.push("missing_bid_ask");
  if (yesSpread > HEATMAP_SHADOW_MAX_SPREAD) flags.push("wide_pm_spread");
  if (liquidity < HEATMAP_SHADOW_MIN_LIQUIDITY) flags.push("low_pm_liquidity");

  return {
    yesBid: Number(yesBid.toFixed(4)),
    yesAsk: Number(yesAsk.toFixed(4)),
    yesSpread: Number(yesSpread.toFixed(4)),
    liquidity: Number(liquidity.toFixed(2)),
    flags,
  };
}

function estimateFundingPnlSinceOpen(position: Position, snapshots: InstrumentSnapshotFile[]): number {
  if (position.venue !== "hyperliquid" || position.instrumentType !== "hl_perp") return 0;
  const openedAt = new Date(position.openedAt).getTime();
  const relevant = snapshots.filter((s) => snapshotTimeMs(s.timestamp) >= openedAt);
  if (relevant.length < 2) return position.fundingPnlAccrued ?? 0;

  let fundingPnl = 0;
  for (let i = 0; i < relevant.length - 1; i++) {
    const current = relevant[i];
    const next = relevant[i + 1];
    const fundingAnnualized = current.hyperliquid[position.asset]?.fundingAnnualized ?? 0;
    const dtHours = (snapshotTimeMs(next.timestamp) - snapshotTimeMs(current.timestamp)) / (1000 * 60 * 60);
    if (dtHours <= 0) continue;
    const intervalFunding = position.size * (position.leverage ?? 1) * fundingAnnualized * (dtHours / (365 * 24));
    fundingPnl += position.direction === "long" ? -intervalFunding : intervalFunding;
  }
  return fundingPnl;
}

function nearestInstrumentSnapshot(
  snapshots: InstrumentSnapshotFile[],
  openedAtIso: string,
): InstrumentSnapshotFile | null {
  if (snapshots.length === 0) return null;
  const openedAtMs = new Date(openedAtIso).getTime();
  let best: InstrumentSnapshotFile | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const snapshot of snapshots) {
    const distance = Math.abs(snapshotTimeMs(snapshot.timestamp) - openedAtMs);
    if (distance < bestDistance) {
      best = snapshot;
      bestDistance = distance;
    }
  }

  return best;
}

// Defensive startup reconciliation. We have observed (and confirmed via the
// 2026-05-19-18:30 cycle) that a closed position can be rehydrated into
// portfolio.positions by an upstream state-restore path even after the
// canonical close was recorded in trades-detailed.csv. The known sequence:
//   1. Operator closes position X manually (writes trades-detailed.csv row,
//      updates portfolio.json, pushes commit).
//   2. VPS cycle pulls the commit, but its in-memory engine state (loaded
//      from engine-state.json or a related artifact) still believes X is
//      open, marks-to-market, and re-emits X in portfolio.positions on
//      save.
//   3. Every subsequent cycle keeps re-emitting X — the close never
//      "sticks" because the operator's truth lives in the CSV ledger, not
//      in the state files the engine writes back every hour.
//
// This guard runs at startup, before any per-position logic, and treats
// trades-detailed.csv as the source of truth: any position whose id is
// also present in the closed-trade ledger is reconciled by mimicking the
// markToMarket close path (cash += position.size + pnl; realized += pnl;
// remove from positions). The function is idempotent: once a ghost is
// removed and savePortfolio runs at end-of-cycle, the same ghost can only
// re-appear if some upstream restore path keeps reintroducing it — in
// which case this guard fires again on the next cycle and cleans it up
// before any other code can act on it. We intentionally do NOT increment
// totalTrades / winCount / lossCount because we cannot tell whether the
// original close already incremented them before the rehydration path
// ran; under-counting is preferable to double-counting on every repeat
// fire, and the report layer recomputes counts directly from the CSV.
function reconcileClosedGhostPositions(portfolio: Portfolio): string[] {
  const notes: string[] = [];
  if (portfolio.positions.length === 0) return notes;

  let closedById: Map<string, ClosedTrade>;
  try {
    closedById = new Map(readClosedTradeCsv().map((t) => [t.id, t]));
  } catch (err) {
    notes.push(
      `Ghost reconciliation skipped: failed to read trades-detailed.csv (${(err as Error).message}).`,
    );
    return notes;
  }
  if (closedById.size === 0) return notes;

  const survivors: Position[] = [];
  for (const p of portfolio.positions) {
    const ghost = closedById.get(p.id);
    if (!ghost) {
      survivors.push(p);
      continue;
    }
    const tainted = isLedgerContaminatedTrade(ghost);
    if (tainted) {
      notes.push(
        `KILLED tainted ghost ${p.id} (${p.asset} ${p.direction} via ${p.venue}/${p.instrumentType ?? "legacy"}, ${p.signalType}) — already closed/excluded in trades-detailed.csv (reason=${ghost.closeReason}, pnl=${ghost.pnl >= 0 ? "+" : ""}$${ghost.pnl.toFixed(4)}); removed without re-adding cash or realized P&L.`,
      );
      continue;
    }
    const exitProceeds = p.size + ghost.pnl;
    portfolio.cash += exitProceeds;
    portfolio.totalRealizedPnl += ghost.pnl;
    notes.push(
      `KILLED ghost ${p.id} (${p.asset} ${p.direction} via ${p.venue}/${p.instrumentType ?? "legacy"}, ${p.signalType}) — already closed in trades-detailed.csv at exit=${ghost.exitPrice} (pnl=${ghost.pnl >= 0 ? "+" : ""}$${ghost.pnl.toFixed(4)}, reason=${ghost.closeReason}, closed_at=${ghost.closedAt}); cash += $${exitProceeds.toFixed(4)}, realized += $${ghost.pnl.toFixed(4)}.`,
    );
  }
  portfolio.positions = survivors;
  return notes;
}

// LLM cadence gate: decides whether this hourly cycle should pay for a
// Sonnet call or skip it. Returns the decision + a list of human-readable
// reasons (each reason that fired is included so the audit trail explains
// every call AND every skip; even on a "run", knowing which triggers fired
// helps tune the thresholds).
//
// The intent is: run the LLM only when it can actually move the portfolio.
// Today the LLM produces no-op analyses 83% of the time at hourly cadence;
// this gate aims to skip those 83%, keeping the journal honest about why
// each skip happened so we can verify the gate isn't dropping material
// cycles.
//
// Triggers (any of these → run):
//   1. LLM_FORCE_HOURLY=1 env  → kill switch, always run
//   2. First run ever (no llm-state.json) → run "first-run"
//   3. Daily budget not exhausted (LLM_MAX_CALLS_PER_DAY hard cap; force-hourly
//      is the only bypass)
//   4. >= LLM_CADENCE_HOURS since last call → scheduled refresh (keeps
//      journal continuity and gives the LLM regular regime check-ins)
//   5. Any rule-based signal key not seen in LLM_NEW_SIGNAL_DEDUPE_HOURS →
//      LLM can evaluate genuinely novel mechanical entry context
//   6. Any open LLM-owned position within LLM_NEAR_DECISION_PCT_TRIGGER pp
//      of its target OR stop → close-decision latency matters here
//   7. Any open position with pnlPct <= LLM_HARD_RISK_PNL_PCT_TRIGGER →
//      hard risk breach, LLM should review immediately
//   8. Any held asset's spot moved >= LLM_BIG_MOVE_PCT_TRIGGER % in last 1h
//      → regime change, thesis may have shifted
//   9. Hypothesis backlog complete AND no new hypothesis in last
//      LLM_BACKLOG_RESTOCK_HOURS hours → time to ask the LLM for new ones
//
// Otherwise skip; the engine still runs all mechanical work (scan, marks,
// rule-based closes, hypothesis lifecycle, etc.) — only the Sonnet call
// itself is suppressed. The journal entry on a skipped cycle includes the
// gate's reasoning so we can verify nothing material was missed.
interface LlmCadenceDecision {
  run: boolean;
  reasons: string[];
  suppressedReasons: string[];
  callsToday: number;
  maxCallsPerDay: number;
  hoursSinceLastCall: number | null;
  nextScheduledAt: string;
}

function decideLlmCadence(
  state: LlmState,
  signals: Signal[],
  portfolio: Portfolio,
  hypotheses: Hypothesis[],
  valRows: SnapshotRow[],
  latestRow: SnapshotRow,
  instrumentSnapshots: InstrumentSnapshotFile[],
): LlmCadenceDecision {
  const now = Date.now();
  const nextScheduledAt = new Date(now + LLM_CADENCE_HOURS * 60 * 60 * 1000).toISOString();
  const callsToday = state.dailyCallCounts?.[utcDateKey(now)] ?? 0;
  if (LLM_FORCE_HOURLY) {
    return {
      run: true,
      reasons: ["LLM_FORCE_HOURLY=1 — cadence and budget gates disabled"],
      suppressedReasons: [],
      callsToday,
      maxCallsPerDay: LLM_MAX_CALLS_PER_DAY,
      hoursSinceLastCall: null,
      nextScheduledAt,
    };
  }

  const hoursSinceLastCall = state.lastCallAt
    ? (now - Date.parse(state.lastCallAt)) / (1000 * 60 * 60)
    : null;
  const reasons: string[] = [];
  const suppressedReasons: string[] = [];

  if (hoursSinceLastCall === null) {
    reasons.push("first-run (no prior llm-state.json)");
  } else if (hoursSinceLastCall >= LLM_CADENCE_HOURS) {
    reasons.push(`scheduled (${hoursSinceLastCall.toFixed(1)}h since last call ≥ LLM_CADENCE_HOURS=${LLM_CADENCE_HOURS})`);
  }

  if (signals.length > 0) {
    const dedupeMs = LLM_NEW_SIGNAL_DEDUPE_HOURS * 60 * 60 * 1000;
    const novelSignals = signals.filter((signal) => {
      const seenAt = state.recentSignalKeys?.[llmSignalKey(signal)];
      const seenAtMs = seenAt ? Date.parse(seenAt) : NaN;
      return !Number.isFinite(seenAtMs) || now - seenAtMs >= dedupeMs;
    });
    if (novelSignals.length > 0) {
      const sigTypes = [...new Set(novelSignals.map((s) => s.type))].slice(0, 4).join(",");
      const more = novelSignals.length > 4 ? ", …" : "";
      reasons.push(`new-signals (${novelSignals.length}/${signals.length} novel after ${LLM_NEW_SIGNAL_DEDUPE_HOURS}h dedupe: ${sigTypes}${more})`);
    } else {
      suppressedReasons.push(`duplicate-signals (${signals.length} recurring signal${signals.length === 1 ? "" : "s"} seen within ${LLM_NEW_SIGNAL_DEDUPE_HOURS}h)`);
    }
  }

  for (const p of portfolio.positions) {
    const mark = markPosition(p, latestRow, instrumentSnapshots, true);
    if (!mark) continue;
    if (mark.pnlPct <= LLM_HARD_RISK_PNL_PCT_TRIGGER) {
      reasons.push(`hard-risk (${p.id} ${p.asset} ${p.direction} pnl=${mark.pnlPct.toFixed(1)}% ≤ ${LLM_HARD_RISK_PNL_PCT_TRIGGER}%)`);
      continue;
    }
    if (!isRuleBasedSignal(p.signalType)) {
      const targetDistance = p.targetPct === null ? Infinity : Math.abs(mark.pnlPct - p.targetPct);
      const stopDistance = Math.abs(mark.pnlPct - (-p.stopPct));
      const trigger = Math.min(targetDistance, stopDistance);
      if (trigger <= LLM_NEAR_DECISION_PCT_TRIGGER) {
        const which = targetDistance <= stopDistance ? `target=+${p.targetPct}%` : `stop=-${p.stopPct}%`;
        reasons.push(`near-decision (${p.id} ${p.asset} ${p.direction} pnl=${mark.pnlPct.toFixed(1)}%, within ${trigger.toFixed(1)}pp of ${which})`);
      }
    }
  }

  if (valRows.length >= 2) {
    const prev = valRows[valRows.length - 2];
    const heldAssets = new Set(portfolio.positions.map((p) => p.asset));
    for (const asset of heldAssets) {
      const col = `${asset.toLowerCase()}_spot`;
      const prevVal = Number((prev as Record<string, unknown>)[col]);
      const currVal = Number((latestRow as Record<string, unknown>)[col]);
      if (Number.isFinite(prevVal) && Number.isFinite(currVal) && prevVal > 0 && currVal > 0) {
        const pct = (currVal / prevVal - 1) * 100;
        if (Math.abs(pct) >= LLM_BIG_MOVE_PCT_TRIGGER) {
          reasons.push(`big-move (${asset} spot ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% in 1h ≥ ${LLM_BIG_MOVE_PCT_TRIGGER}%)`);
        }
      }
    }
  }

  const backlog = llmHypothesisBacklog(hypotheses);
  if (backlog.complete) {
    const latestHypMs = hypotheses
      .map((h) => Date.parse(h.created ?? ""))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    if (latestHypMs) {
      const hoursSinceLatest = (now - latestHypMs) / (1000 * 60 * 60);
      if (hoursSinceLatest >= LLM_BACKLOG_RESTOCK_HOURS) {
        reasons.push(`restock-backlog (no new hypothesis in ${hoursSinceLatest.toFixed(0)}h ≥ ${LLM_BACKLOG_RESTOCK_HOURS}h)`);
      }
    }
  }

  if (reasons.length > 0 && LLM_MAX_CALLS_PER_DAY > 0 && callsToday >= LLM_MAX_CALLS_PER_DAY) {
    suppressedReasons.push(`daily-budget-cap (${callsToday}/${LLM_MAX_CALLS_PER_DAY} LLM calls already used today)`);
    return { run: false, reasons, suppressedReasons, callsToday, maxCallsPerDay: LLM_MAX_CALLS_PER_DAY, hoursSinceLastCall, nextScheduledAt };
  }

  return { run: reasons.length > 0, reasons, suppressedReasons, callsToday, maxCallsPerDay: LLM_MAX_CALLS_PER_DAY, hoursSinceLastCall, nextScheduledAt };
}

function migrateLegacyPolymarketPositions(
  portfolio: Portfolio,
  snapshots: InstrumentSnapshotFile[],
): string[] {
  const notes: string[] = [];
  if (snapshots.length === 0) return notes;

  for (const position of portfolio.positions) {
    if (position.venue !== "polymarket") continue;
    if (position.instrumentType && position.instrumentType !== "legacy_asset") continue;
    if (position.signalType === "MONOTONIC_ARB") continue;

    const openedSnapshot = nearestInstrumentSnapshot(snapshots, position.openedAt) ?? latestInstrumentSnapshot(snapshots);
    if (!openedSnapshot) continue;
    const underlyingAtOpen = openedSnapshot.spots[position.asset];
    if (underlyingAtOpen == null) continue;

    const preferredDirection = inferPolymarketPreferredDirection(position.direction, position.signalType, position.thesis);
    const selected = selectPolymarketContract(
      openedSnapshot,
      position.asset,
      underlyingAtOpen,
      position.direction,
      { preferredDirection },
    );
    if (!selected) continue;

    position.instrumentType = selected.instrumentType;
    position.instrumentId = `${selected.event.slug}::${selected.contract.marketId}`;
    position.instrumentLabel = `${selected.event.slug} — ${selected.instrumentType === "pm_yes" ? "YES" : "NO"} — ${selected.contract.question}`;
    position.entryUnderlyingPrice = underlyingAtOpen;
    position.currentUnderlyingPrice = latestInstrumentSnapshot(snapshots)?.spots[position.asset] ?? underlyingAtOpen;
    position.entryPrice = selected.entryPrice;
    position.currentPrice = selected.entryPrice;
    position.fundingPnlAccrued = 0;

    notes.push(`Migrated legacy Polymarket ${position.asset} ${position.direction} to ${position.instrumentLabel} @ ${selected.entryPrice.toFixed(3)}.`);
  }

  return notes;
}

function markPosition(
  position: Position,
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
  conservativePolymarketExit = false,
): {
  currentPrice: number;
  underlyingPrice: number | null;
  marketPnl: number;
  fundingPnl: number;
  pnl: number;
  pnlPct: number;
} | null {
  const latestSnapshot = latestInstrumentSnapshot(snapshots);
  let currentPrice: number | null = null;
  let underlyingPrice: number | null = getAssetPrice(latestRow, position.asset);
  let marketPnl = 0;
  let fundingPnl = 0;

  if (position.instrumentType === "pm_yes" || position.instrumentType === "pm_no") {
    if (!latestSnapshot) return null;
    const pmMark = findPolymarketContractMark(latestSnapshot, position, conservativePolymarketExit);
    if (!pmMark) return null;
    currentPrice = pmMark.price;
    underlyingPrice = pmMark.underlyingPrice;
    const shares = position.size / position.entryPrice;
    marketPnl = shares * (currentPrice - position.entryPrice);
  } else if (position.instrumentType === "pm_package") {
    if (!latestSnapshot) return null;
    const packageMark = findPolymarketPackageMark(latestSnapshot, position);
    if (!packageMark) return null;
    currentPrice = packageMark.price;
    underlyingPrice = packageMark.underlyingPrice;
    const shares = position.size / position.entryPrice;
    marketPnl = shares * (currentPrice - position.entryPrice);
  } else if (position.instrumentType === "hl_perp") {
    currentPrice = getHyperliquidPerpPrice(latestRow, position.asset) ?? getHyperliquidMarkPriceFromSnapshot(latestSnapshot, position.asset);
    if (!currentPrice) return null;
    const rawReturn = position.direction === "long"
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;
    marketPnl = position.size * (position.leverage ?? 1) * rawReturn;
    fundingPnl = estimateFundingPnlSinceOpen(position, snapshots);
  } else {
    currentPrice = getAssetPrice(latestRow, position.asset);
    if (!currentPrice) return null;
    const rawReturn = position.direction === "long"
      ? (currentPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - currentPrice) / position.entryPrice;
    marketPnl = position.size * rawReturn;
  }

  const pnl = marketPnl + fundingPnl;
  const pnlPct = (pnl / position.size) * 100;
  return { currentPrice, underlyingPrice, marketPnl, fundingPnl, pnl, pnlPct };
}

function updatePeakPnl(position: Position, mark: { pnlPct: number }) {
  position.peakPnlPct = Math.max(position.peakPnlPct ?? mark.pnlPct, mark.pnlPct);
}

function fundingBreakevenStopHit(position: Position, mark: { pnlPct: number }): boolean {
  return isFundingSignal(position.signalType)
    && (position.peakPnlPct ?? mark.pnlPct) >= FUNDING_BREAKEVEN_ARM_PCT
    && mark.pnlPct <= FUNDING_BREAKEVEN_LOCK_PCT;
}

function weekendHyperliquidFundingExitHit(position: Position, snapshots: InstrumentSnapshotFile[]): boolean {
  return position.signalType === WEEKEND_HL_FUNDING_LIVE_SIGNAL
    && (
      !isStockPerpFundingWindowOpen()
      || (getHyperliquidFundingFromSnapshot(latestInstrumentSnapshot(snapshots), position.asset) ?? Number.NEGATIVE_INFINITY) >= WEEKEND_HL_FUNDING_EXIT_PCT
    );
}

function realizeClosedPosition(
  portfolio: Portfolio,
  position: Position,
  mark: {
    currentPrice: number;
    underlyingPrice: number | null;
    marketPnl: number;
    fundingPnl: number;
    pnl: number;
    pnlPct: number;
  },
  closeReason: ClosedTrade["closeReason"],
  closedAt: string,
  thesisOverride?: string,
): ClosedTrade {
  position.currentPrice = mark.currentPrice;
  position.currentUnderlyingPrice = mark.underlyingPrice ?? undefined;
  position.fundingPnlAccrued = mark.fundingPnl;

  const trade: ClosedTrade = {
    id: position.id,
    openedAt: position.openedAt,
    closedAt,
    asset: position.asset,
    venue: position.venue,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice: mark.currentPrice,
    size: position.size,
    leverage: position.leverage ?? 1,
    pnl: mark.pnl,
    pnlPct: mark.pnlPct,
    marketPnl: mark.marketPnl,
    fundingPnl: mark.fundingPnl,
    signalType: position.signalType,
    hypothesisId: position.hypothesisId,
    thesis: thesisOverride ?? position.thesis,
    closeReason,
    instrumentType: position.instrumentType,
    instrumentId: position.instrumentId,
    instrumentLabel: position.instrumentLabel,
  };

  portfolio.cash += position.size + mark.pnl;
  // Skip contaminated trades from portfolio counters even within the cycle.
  // Final source of truth is recomputePortfolioTotalsFromLedger() on next load;
  // this guard prevents same-cycle drift in logs / live snapshot.
  if (!isLedgerContaminatedTrade(trade)) {
    portfolio.totalRealizedPnl += mark.pnl;
    portfolio.totalTrades++;
    if (mark.pnl >= 0) portfolio.winCount++; else portfolio.lossCount++;
  }
  return trade;
}

function isValidVenue(value: string): value is Signal["venue"] {
  return value === "polymarket" || value === "hyperliquid" || value === "spot";
}

function closePositionsFromLlm(
  portfolio: Portfolio,
  instructions: LlmTradeInstruction[],
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
): ClosedTrade[] {
  if (instructions.length === 0) return [];
  const closed: ClosedTrade[] = [];
  const remaining: Position[] = [];
  const now = new Date().toISOString();

  for (const position of portfolio.positions) {
    const instruction = instructions.find((candidate) =>
      candidate.positionId === position.id
      && candidate.asset === position.asset
      && candidate.venue === position.venue
      && (candidate.direction === "any" || candidate.direction === position.direction),
    );
    if (!instruction) {
      remaining.push(position);
      continue;
    }

    const mark = markPosition(position, latestRow, snapshots);
    if (!mark) {
      remaining.push(position);
      continue;
    }

    closed.push(realizeClosedPosition(
      portfolio,
      position,
      mark,
      "llm_decision",
      now,
      `${position.thesis} | [LLM close] ${instruction.thesis}`,
    ));
  }

  portfolio.positions = remaining;
  return closed;
}

function getRowTimeMs(row: SnapshotRow): number | null {
  return typeof row.date === "string" && row.date ? snapshotTimeMs(row.date) : null;
}

function findRowAtOrBefore(rows: SnapshotRow[], targetMs: number): SnapshotRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const ts = getRowTimeMs(rows[i]);
    if (ts !== null && ts <= targetMs) return rows[i];
  }
  return null;
}

function average(nums: number[]): number | null {
  return nums.length > 0 ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function assetTrendMetrics(
  rows: SnapshotRow[],
  asset: string,
  lookbackHours: number,
): { current: number; lookback: number; sma: number; momentumPct: number; aboveTrendPct: number } | null {
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const latestTs = getRowTimeMs(latest);
  const current = getAssetPrice(latest, asset);
  if (latestTs === null || current === null) return null;

  const lookbackRow = findRowAtOrBefore(rows, latestTs - lookbackHours * 60 * 60 * 1000);
  const lookback = lookbackRow ? getAssetPrice(lookbackRow, asset) : null;
  if (lookback === null || lookback <= 0) return null;

  const windowPrices = rows
    .filter((row) => {
      const ts = getRowTimeMs(row);
      return ts !== null && ts >= latestTs - lookbackHours * 60 * 60 * 1000;
    })
    .map((row) => getAssetPrice(row, asset))
    .filter((value): value is number => value !== null && value > 0);
  const sma = average(windowPrices);
  if (sma === null || sma <= 0) return null;

  return {
    current,
    lookback,
    sma,
    momentumPct: ((current - lookback) / lookback) * 100,
    aboveTrendPct: ((current - sma) / sma) * 100,
  };
}

function macroCompositeShiftPts(rows: SnapshotRow[], lookbackHours: number): { shift: number; previous: number; current: number } | null {
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const latestTs = getRowTimeMs(latest);
  const latestComposite = num(latest.macro_composite);
  if (latestTs === null || latestComposite === null) return null;

  const lookbackRow = findRowAtOrBefore(rows, latestTs - lookbackHours * 60 * 60 * 1000);
  const previousComposite = lookbackRow ? num(lookbackRow.macro_composite) : null;
  if (previousComposite === null) return null;

  return {
    shift: latestComposite - previousComposite,
    previous: previousComposite,
    current: latestComposite,
  };
}

interface AssetPromptColumns {
  spot?: string;
  pmEv?: string;
  pmIv?: string;
  optIv30?: string;
  optIv90?: string;
  funding?: string;
  pcRatio?: string;
  hlPerp?: string;
}

function assetPromptColumns(asset: string): AssetPromptColumns {
  const map: Record<string, AssetPromptColumns> = {
    BTC: { spot: "btc_spot", pmEv: "btc_pm_ev", pmIv: "btc_pm_iv", funding: "btc_hl_funding_ann", pcRatio: "btc_ibit_pc_ratio" },
    ETH: { spot: "eth_spot", optIv30: "eth_opt_iv_30d", optIv90: "eth_opt_iv_90d", funding: "eth_hl_funding_ann", pcRatio: "eth_pc_ratio" },
    HYPE: { spot: "hype_spot", pmEv: "hype_pm_ev", pmIv: "hype_pm_iv", funding: "hype_hl_funding_ann" },
    GOLD: { spot: "gold_gc_spot", pmEv: "gold_pm_settle_ev", pmIv: "gold_pm_iv", optIv30: "gold_opt_iv_30d", optIv90: "gold_opt_iv_90d", funding: "gold_hl_funding_ann", pcRatio: "gold_gld_pc_ratio" },
    AMZN: { spot: "amzn_stock", hlPerp: "amzn_hl_perp", optIv30: "amzn_opt_iv_30d", optIv90: "amzn_opt_iv_90d", funding: "amzn_hl_funding_ann", pcRatio: "amzn_pc_ratio" },
    SPY: { spot: "spy_spot", optIv30: "spy_opt_iv_30d", optIv90: "spy_opt_iv_90d", pcRatio: "spy_pc_ratio" },
    OIL: { spot: "oil_wti_spot", pmEv: "oil_pm_settle_ev", pmIv: "oil_pm_iv", optIv30: "oil_opt_iv_30d", optIv90: "oil_opt_iv_90d", funding: "oil_hl_funding_ann", pcRatio: "oil_cl_pc_ratio" },
  };
  return map[asset] ?? {};
}

function uniqueColumns(columns: Array<string | undefined>): string[] {
  return [...new Set(columns.filter((column): column is string => !!column))];
}

function openPositionContextColumns(asset: string): string[] {
  const columns = assetPromptColumns(asset);
  return uniqueColumns([
    columns.spot, columns.hlPerp, columns.pmEv, columns.pmIv, columns.optIv30, columns.optIv90, columns.funding, columns.pcRatio,
    "macro_composite", "fed_score",
  ]);
}

function signalFamilyEvidenceColumns(position: Position): string[] {
  const columns = assetPromptColumns(position.asset);
  switch (position.signalType) {
    case "PC_RATIO_EXTREME_HIGH":
    case "PC_RATIO_EXTREME_LOW":
      return uniqueColumns([columns.spot, columns.pcRatio]);
    case "PM_IV_GT_OPT_IV":
    case "OPT_IV_GT_PM_IV":
      return uniqueColumns([columns.spot, columns.pmIv, columns.optIv30, columns.optIv90]);
    case "FUNDING_EXTREME_LONG":
    case "FUNDING_EXTREME_SHORT":
      return uniqueColumns([columns.spot, columns.hlPerp, columns.funding]);
    case "PM_EV_ABOVE_SPOT":
    case "PM_EV_BELOW_SPOT":
      return uniqueColumns([columns.spot, columns.pmEv]);
    case "MACRO_MOMENTUM_UP":
    case "MACRO_MOMENTUM_DOWN":
      return uniqueColumns([columns.spot, "macro_composite", "fed_score"]);
    case "MOMENTUM_LONG":
      return uniqueColumns([columns.spot]);
    case "ONE_TOUCH_HIGH_EDGE_NO":
    case "ONE_TOUCH_HIGH_EDGE_YES_SHADOW":
      // One-touch positions live or die on how spot moves relative to the
      // touch strike, but the LLM repeatedly reaches for funding and IV as
      // secondary thesis evidence ("HL funding spiked to +80%, extreme
      // crowding") with no rolling baseline. Promote pmIv/optIv/funding to
      // evidence columns so they pick up the trajectory + 24h/7d/30d
      // percentile context instead of bare current values.
      return uniqueColumns([columns.spot, columns.pmIv, columns.optIv30, columns.optIv90, columns.funding]);
    default:
      return uniqueColumns([columns.spot]);
  }
}

function formatPromptNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

function formatSinceOpenMetric(column: string, entryRow: SnapshotRow, latestRow: SnapshotRow): string | null {
  const entry = num(entryRow[column]);
  const latest = num(latestRow[column]);
  if (entry === null || latest === null) return null;
  const delta = latest - entry;
  // For negative-base values, naive (delta/entry) flips the sign and produces
  // confusing strings like "+-118%". Anchor the percentage to |entry| so the
  // sign reflects the direction of the move, not the sign of the base.
  let pct = "";
  if (entry !== 0) {
    const pctNum = (delta / Math.abs(entry)) * 100;
    pct = `, ${pctNum >= 0 ? "+" : ""}${pctNum.toFixed(2)}%`;
  }
  return `${column}: ${formatPromptNumber(entry)} -> ${formatPromptNumber(latest)} (delta ${delta >= 0 ? "+" : ""}${formatPromptNumber(delta)}${pct})`;
}

// Last N consecutive numeric readings for a column, oldest first, trailing the
// latest row. Used to show the LLM the *shape* of how a metric evolved, not
// just endpoints.
function recentColumnReadings(rows: SnapshotRow[], column: string, count: number): number[] {
  const out: number[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < count; i--) {
    const value = num(rows[i]?.[column]);
    if (value === null) continue;
    out.push(value);
  }
  return out.reverse();
}

// Format a percentile/range line for a column at a fixed lookback window.
function formatRollingPercentile(rows: SnapshotRow[], column: string, hours: number, label: string): string | null {
  const window = rows.slice(-Math.min(rows.length, hours));
  const values = valuesForKey(window, column);
  if (values.length < 4) return null;
  const latest = num(rows[rows.length - 1]?.[column]);
  if (latest === null) return null;
  const rank = percentileRank(values, latest);
  if (rank === null) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `${label}: percentile ${rank.toFixed(0)} (range ${formatPromptNumber(lo)} to ${formatPromptNumber(hi)})`;
}

// Enriched evidence line for signal-family columns: the existing entry->latest
// delta, plus a recent trajectory and rolling-window percentile context so the
// LLM can tell whether a move was a single tick vs. a sustained regime change.
function formatSignalEvidenceMetric(
  column: string,
  entryRow: SnapshotRow,
  latestRow: SnapshotRow,
  rows: SnapshotRow[],
): string[] {
  const head = formatSinceOpenMetric(column, entryRow, latestRow);
  if (!head) return [];
  const lines: string[] = [head];
  const trajectory = recentColumnReadings(rows, column, 12);
  if (trajectory.length >= 3) {
    lines.push(`  trajectory (last ${trajectory.length} hourly readings, oldest first): ${trajectory.map(formatPromptNumber).join(" -> ")}`);
  }
  const contextParts: string[] = [];
  for (const [hours, label] of [[24, "24h"], [168, "7d"], [720, "30d"]] as Array<[number, string]>) {
    const line = formatRollingPercentile(rows, column, hours, label);
    if (line) contextParts.push(line);
  }
  if (contextParts.length > 0) {
    lines.push(`  rolling context: ${contextParts.join("; ")}`);
  }
  return lines;
}

function isRuleBasedSignal(signalType: string): boolean {
  return signalType !== "LLM_HYPOTHESIS" && signalType !== "PROMOTED_HYPOTHESIS";
}

// Mechanical scanner signals that now permit LLM discretionary closes after the
// 12h min-hold, restricted to thesis-invalidated / data-quality / hard-risk
// categories. Profit-taking remains mechanical (the target governs).
// Motivation: the PC_RATIO and FUNDING families enter on a single observable
// (P/C ratio < threshold; funding < threshold). When that observable round-
// trips into invalidation territory (e.g. P/C 0.32 → 0.64 in 24h), the trade
// thesis is *gone* well before the mechanical stop fires. See the 5/29 GOLD
// short post-mortem: thesis broke ~16h in, journaled multiple times, stopped
// out at -2.05% anyway. Allowing a thesis_invalidated close in those cases
// avoids paying the full stop when the signal's own input has already
// reversed. One-touch / monotonic-arb / hybrid-shadow families are
// deliberately excluded — they have non-obvious payoff dynamics that don't
// map cleanly to single-input invalidation.
const MECHANICAL_LLM_CLOSE_ELIGIBLE_SIGNALS = new Set<string>([
  "PC_RATIO_EXTREME_HIGH",
  "PC_RATIO_EXTREME_LOW",
  "FUNDING_EXTREME_SHORT",
  "FUNDING_EXTREME_LONG",
]);

function isMechanicalLlmCloseEligible(signalType: string): boolean {
  return MECHANICAL_LLM_CLOSE_ELIGIBLE_SIGNALS.has(signalType);
}

function positionTimingContext(position: Position, nowMs = Date.now()): {
  hoursOpen: number | null;
  hoursToExpiry: number | null;
  plannedHoldHours: number | null;
  elapsedHoldPct: number | null;
} {
  const openedMs = Date.parse(position.openedAt);
  const expiryMs = Date.parse(position.expiryDate);
  const hoursOpen = Number.isFinite(openedMs) ? (nowMs - openedMs) / (60 * 60 * 1000) : null;
  const hoursToExpiry = Number.isFinite(expiryMs) ? (expiryMs - nowMs) / (60 * 60 * 1000) : null;
  const plannedHoldHours = Number.isFinite(openedMs) && Number.isFinite(expiryMs)
    ? Math.max(0, (expiryMs - openedMs) / (60 * 60 * 1000))
    : null;
  const elapsedHoldPct = plannedHoldHours && plannedHoldHours > 0 && hoursOpen !== null
    ? Math.max(0, Math.min(1, hoursOpen / plannedHoldHours))
    : null;
  return { hoursOpen, hoursToExpiry, plannedHoldHours, elapsedHoldPct };
}

function llmCloseMinHoldHours(position: Position, timing = positionTimingContext(position)): number {
  const plannedHoldHours = timing.plannedHoldHours;
  if (plannedHoldHours === null || plannedHoldHours < LLM_LONG_DATED_CLOSE_HOURS) return LLM_CLOSE_MIN_HOLD_HOURS;
  const progressBuffer = plannedHoldHours * LLM_LONG_DATED_CLOSE_MIN_PROGRESS;
  return Math.max(
    LLM_CLOSE_MIN_HOLD_HOURS,
    Math.min(LLM_LONG_DATED_CLOSE_MAX_EXTRA_BUFFER_HOURS, progressBuffer),
  );
}

// Polymarket binary contracts on price come in two flavors with very
// different resolution semantics. Keep these definitions explicit so the
// LLM decoder below stays in sync with the upstream signal/heatmap
// classifiers (see also isNestedLadderEvent).
//   - "touch":  path-dependent. Resolves YES as soon as spot prints
//               at/through the strike at any point before expiry
//               (slugs: hit / reach / dip / touch).
//   - "settle": terminal-only. Resolves YES if spot is on the correct
//               side of the strike AT EXPIRY only; path in between is
//               irrelevant (slugs: settle / over-under / final trading
//               day / end-of-month close).
//   - "range":  also terminal-only but bucketed ($60-$70 at expiry).
type PolymarketMarketKind = "touch" | "settle" | "range" | "unknown";

function polymarketMarketKind(slug: string, title = ""): PolymarketMarketKind {
  const haystack = `${slug} ${title}`.toLowerCase();
  if (
    haystack.includes("settle") ||
    haystack.includes("final trading day") ||
    haystack.includes("over-under") ||
    haystack.includes("over/under")
  ) {
    return "settle";
  }
  if (haystack.includes("range") || /\$\d+(?:\.\d+)?\s*-\s*\$?\d+(?:\.\d+)?/.test(haystack)) {
    return "range";
  }
  if (
    haystack.includes("hit") ||
    haystack.includes("reach") ||
    haystack.includes("dip") ||
    haystack.includes("touch")
  ) {
    return "touch";
  }
  return "unknown";
}

// For one-touch positions, the directional logic is non-trivial (buying NO on a
// LOW-touch question wins when spot stays HIGH, etc.) and the LLM has been
// observed flipping the sign on PnL/favorability multiple times within a
// single trade's life. Resolve the touch side + strike from the latest
// instrument snapshot (authoritative; question text is freeform and varies
// per asset — "(LOW) $90" vs "dip to $55,000") so the LLM never has to
// derive direction.
//
// We also detect when ONE_TOUCH_HIGH_EDGE_* was emitted against a SETTLE /
// RANGE market (a known data-artifact pattern: the upstream signal generator
// mis-classifies over-under markets as touch). When that happens we surface
// the mismatch and switch the language to terminal-price semantics so the
// LLM does not reason about "stays below through expiry" as if a single
// intraday print could lose the bet.
function formatOneTouchDirectionalLine(
  p: Position,
  latestSnapshot: InstrumentSnapshotFile | null,
): string | null {
  if (!p.signalType.startsWith("ONE_TOUCH_HIGH_EDGE")) return null;
  if (p.instrumentType !== "pm_no" && p.instrumentType !== "pm_yes") return null;
  if (!latestSnapshot) return null;
  const [eventSlug, marketId] = p.instrumentId?.split("::") ?? [];
  if (!eventSlug || !marketId) return null;
  const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === eventSlug);
  const contract = event?.contracts.find((candidate) => candidate.marketId === marketId);
  if (!contract) return null;

  const kind = polymarketMarketKind(eventSlug, event?.title ?? "");
  const isLow = contract.direction === "below";
  const strikeStr = `$${contract.strike.toLocaleString("en-US")}`;
  const isNo = p.instrumentType === "pm_no";

  let winCondition: string;
  let favorable: string;
  let adverse: string;
  let kindLabel: string;
  let mismatchWarning = "";

  if (kind === "settle" || kind === "range") {
    kindLabel = kind === "settle" ? "SETTLE-AT-EXPIRY" : "RANGE-AT-EXPIRY";
    // Surface the artifact: signal family is touch-style but the market
    // resolves on terminal price only. The thesis must be evaluated as a
    // terminal-price bet, never as a path-touch bet.
    mismatchWarning = ` [DATA-ARTIFACT WARNING: signal family ${p.signalType} is a TOUCH-style signal but this market resolves on TERMINAL PRICE AT EXPIRY only — path does NOT matter; do not close on intraday wicks]`;
    if (isNo && isLow) {
      winCondition = `Spot is AT OR ABOVE ${strikeStr} AT EXPIRY (intraday path is irrelevant — only the resolution print matters)`;
      favorable = `Spot trending UP into expiry is FAVORABLE`;
      adverse = `Spot dropping below ${strikeStr} as expiry approaches is ADVERSE`;
    } else if (isNo && !isLow) {
      winCondition = `Spot is AT OR BELOW ${strikeStr} AT EXPIRY (intraday path is irrelevant — only the resolution print matters)`;
      favorable = `Spot trending DOWN into expiry is FAVORABLE`;
      adverse = `Spot rising above ${strikeStr} as expiry approaches is ADVERSE`;
    } else if (!isNo && isLow) {
      winCondition = `Spot is BELOW ${strikeStr} AT EXPIRY (intraday path is irrelevant)`;
      favorable = `Spot trending DOWN into expiry is FAVORABLE`;
      adverse = `Spot rising above ${strikeStr} as expiry approaches is ADVERSE`;
    } else {
      winCondition = `Spot is AT OR ABOVE ${strikeStr} AT EXPIRY (intraday path is irrelevant)`;
      favorable = `Spot trending UP into expiry is FAVORABLE`;
      adverse = `Spot falling below ${strikeStr} as expiry approaches is ADVERSE`;
    }
  } else {
    kindLabel = kind === "touch" ? "TOUCH (path-dependent)" : "TOUCH (path-dependent, kind=unknown)";
    if (isNo && isLow) {
      winCondition = `Spot stays STRICTLY ABOVE ${strikeStr} at every point between now and expiry (a single print at/below ${strikeStr} loses)`;
      favorable = `Spot moving UP (away from ${strikeStr}) is FAVORABLE`;
      adverse = `Spot moving DOWN (toward ${strikeStr}) is ADVERSE`;
    } else if (isNo && !isLow) {
      winCondition = `Spot stays STRICTLY BELOW ${strikeStr} at every point between now and expiry (a single print at/above ${strikeStr} loses)`;
      favorable = `Spot moving DOWN (away from ${strikeStr}) is FAVORABLE`;
      adverse = `Spot moving UP (toward ${strikeStr}) is ADVERSE`;
    } else if (!isNo && isLow) {
      winCondition = `Spot prints at or below ${strikeStr} at any point before expiry (a single intraday touch wins)`;
      favorable = `Spot moving DOWN (toward ${strikeStr}) is FAVORABLE`;
      adverse = `Spot moving UP (away from ${strikeStr}) is ADVERSE`;
    } else {
      winCondition = `Spot prints at or above ${strikeStr} at any point before expiry (a single intraday touch wins)`;
      favorable = `Spot moving UP (toward ${strikeStr}) is FAVORABLE`;
      adverse = `Spot moving DOWN (away from ${strikeStr}) is ADVERSE`;
    }
  }

  const tokenWarning = isNo
    ? ` IMPORTANT: instrumentType=pm_no means the position is LONG the NO token / short YES probability, not a directional short on ${p.asset}. Evaluate underlying moves only with the favorable/adverse rules here.`
    : ` IMPORTANT: instrumentType=pm_yes means the position is LONG the YES token; evaluate underlying moves only with the favorable/adverse rules here.`;
  return `One-touch decoder: bought ${isNo ? "NO" : "YES"} at ${p.entryPrice.toFixed(2)} on (${isLow ? "LOW" : "HIGH"}) ${strikeStr} ${kindLabel} market${mismatchWarning} — ${winCondition}. ${favorable}; ${adverse}.${tokenWarning}`;
}

function formatMechanicalContextLine(
  position: Position,
  mark: { pnlPct: number } | null,
): string {
  const { hoursOpen, hoursToExpiry, plannedHoldHours, elapsedHoldPct } = positionTimingContext(position);
  const llmMinHold = llmCloseMinHoldHours(position, { hoursOpen, hoursToExpiry, plannedHoldHours, elapsedHoldPct });

  const parts: string[] = [];
  parts.push(`open ${hoursOpen === null ? "?" : hoursOpen.toFixed(1)}h`);
  if (mark) parts.push(`current PnL ${mark.pnlPct >= 0 ? "+" : ""}${mark.pnlPct.toFixed(2)}%`);
  else parts.push("current PnL n/a (mark unavailable)");
  if (typeof position.peakPnlPct === "number") parts.push(`peak ${position.peakPnlPct >= 0 ? "+" : ""}${position.peakPnlPct.toFixed(2)}%`);
  parts.push(`target ${position.targetPct === null ? "uncapped" : `+${position.targetPct}%`}`);
  parts.push(`stop -${position.stopPct}%`);
  if (hoursToExpiry !== null) {
    parts.push(hoursToExpiry >= 0 ? `expires in ${hoursToExpiry.toFixed(1)}h` : `expired ${Math.abs(hoursToExpiry).toFixed(1)}h ago`);
  }
  if (plannedHoldHours !== null && elapsedHoldPct !== null) {
    parts.push(`planned hold ${plannedHoldHours.toFixed(1)}h (${(elapsedHoldPct * 100).toFixed(1)}% elapsed)`);
  }
  parts.push(`LLM close min hold ${llmMinHold.toFixed(1)}h`);

  if (isFundingSignal(position.signalType)) {
    const armed = (position.peakPnlPct ?? mark?.pnlPct ?? 0) >= FUNDING_BREAKEVEN_ARM_PCT;
    parts.push(`breakeven arm: ${armed ? "armed" : "not armed"} (arms at peak ≥ +${FUNDING_BREAKEVEN_ARM_PCT}%, locks at PnL ≤ +${FUNDING_BREAKEVEN_LOCK_PCT}%)`);
  }

  return `Mechanical context: ${parts.join(", ")}.`;
}

function openPositionContextForLlm(
  positions: Position[],
  rows: SnapshotRow[],
  instrumentSnapshots: InstrumentSnapshotFile[],
): string {
  const latestRow = rows[rows.length - 1];
  if (positions.length === 0) return "  None";
  if (!latestRow) {
    return positions.map((p) => `  positionId=${p.id}; ${p.asset} ${p.direction} via ${p.venue} / ${p.instrumentType ?? "legacy"} @ ${p.entryPrice} [${p.instrumentLabel ?? "n/a"}] (${p.signalType}) — ${p.thesis.slice(0, 100)}`).join("\n");
  }

  return positions.map((p) => {
    const openedMs = Date.parse(p.openedAt);
    const entryRow = isNaN(openedMs) ? null : findRowAtOrBefore(rows, openedMs);
    const header = `  positionId=${p.id}; ${p.asset} ${p.direction} via ${p.venue} / ${p.instrumentType ?? "legacy"} @ ${p.entryPrice} [${p.instrumentLabel ?? "n/a"}] (${p.signalType}) — ${p.thesis.slice(0, 100)}`;
    const mark = markPosition(p, latestRow, instrumentSnapshots, true);
    const mechanicalLine = `    ${formatMechanicalContextLine(p, mark)}`;
    const ownershipLine = isMechanicalLlmCloseEligible(p.signalType)
      ? `    Mechanical ${p.signalType} setup with LLM thesis-invalidated discretion after ${LLM_CLOSE_MIN_HOLD_HOURS}h. Profit-taking, target, stop, breakeven_stop, and expiry remain mechanical — do NOT emit close instructions for those. You MAY emit a close with closeReasonCategory='thesis_invalidated' only when the signal's own input has round-tripped past invalidation (e.g. P/C ratio has normalized back through the entry threshold and beyond, or funding has crossed back through the entry threshold); cite the signal-family evidence metric below. 'data_quality_issue' and 'hard_portfolio_risk' are also allowed.`
      : isRuleBasedSignal(p.signalType)
        ? `    LLM closes are not permitted on this trade — mechanical scanner owns exits via target / stop / breakeven_stop / expiry. Do NOT emit a close instruction for this positionId in 'trades'; rule-based closes are policy-gated and will be rejected. Use 'journalEntry' if you have structural concerns about the signal family.`
        : `    LLM closes are policy-gated for this LLM-owned setup. Use ALLOWED ACTION SURFACE for whether this position is old enough and which close categories are currently allowed. Use signal-family evidence metrics below as primary justification.`;
    const decoderLine = formatOneTouchDirectionalLine(p, latestInstrumentSnapshot(instrumentSnapshots));
    const decoderBlock = decoderLine ? `\n    ${decoderLine}` : "";
    if (!entryRow) return `${header}\n${mechanicalLine}\n${ownershipLine}${decoderBlock}\n    Since-open baseline: unavailable (no valuation row at or before ${p.openedAt})`;

    const evidenceColumns = new Set(signalFamilyEvidenceColumns(p));
    const signalMetricLines: string[] = [];
    for (const column of openPositionContextColumns(p.asset)) {
      if (!evidenceColumns.has(column)) continue;
      signalMetricLines.push(...formatSignalEvidenceMetric(column, entryRow, latestRow, rows));
    }
    const contextMetricLines = openPositionContextColumns(p.asset)
      .filter((column) => !evidenceColumns.has(column))
      .map((column) => formatSinceOpenMetric(column, entryRow, latestRow))
      .filter((line): line is string => !!line);
    const signalMetrics = signalMetricLines.length > 0
      ? signalMetricLines.map((line) => `      ${line}`).join("\n")
      : "      No comparable asset/macro metrics available.";
    const contextMetrics = contextMetricLines.length > 0
      ? contextMetricLines.map((line) => `      ${line}`).join("\n")
      : "      No off-thesis context metrics available.";
    return `${header}\n${mechanicalLine}\n${ownershipLine}${decoderBlock}\n    Since-open baseline row: ${entryRow.date}; latest row: ${latestRow.date}\n    Signal-family evidence metrics (use for close decisions):\n${signalMetrics}\n    Context-only metrics (do not cite as close evidence unless there is a hard risk breach):\n${contextMetrics}`;
  }).join("\n");
}

function isAssetTrendAndMomentumPositive(rows: SnapshotRow[], asset: string, learningParams: LearningParams): boolean {
  const metrics = assetTrendMetrics(rows, asset, LOOKBACK_HOURS);
  if (!metrics) return false;
  return metrics.aboveTrendPct >= learningParams.contrarianTrendMarginPct
    && metrics.momentumPct >= learningParams.positiveMomentum24hPct;
}

function isShortSignalBlockedByTrend(signal: Signal, rows: SnapshotRow[], learningParams: LearningParams): boolean {
  if (signal.direction !== "short") return false;
  if (signal.type === "MACRO_MOMENTUM_DOWN") return false;
  return isAssetTrendAndMomentumPositive(rows, signal.asset, learningParams);
}

function isMomentumLongSignal(signal: Signal, rows: SnapshotRow[], learningParams: LearningParams): boolean {
  if (signal.direction !== "long") return false;
  if (signal.type === "MACRO_MOMENTUM_UP") return true;
  return isAssetTrendAndMomentumPositive(rows, signal.asset, learningParams);
}

function hyperliquidMarketQualityOk(
  latestSnapshot: InstrumentSnapshotFile | null,
  asset: string,
): boolean {
  const mark = latestSnapshot?.hyperliquid?.[asset];
  const markPx = mark?.markPx ?? null;
  if (!mark || !markPx || markPx <= 0) return true;

  const spread = mark.spread ?? (
    mark.bestBid && mark.bestAsk && mark.bestAsk > mark.bestBid
      ? mark.bestAsk - mark.bestBid
      : null
  );
  const spreadPct = spread !== null ? (spread / markPx) * 100 : 0;
  const openInterestUsd = mark.openInterestUsd ?? 0;
  return spreadPct <= 0.15 && openInterestUsd >= 1_000_000;
}

function fundingMoveNotExtended(
  rows: SnapshotRow[],
  asset: string,
  signalDirection: "long" | "short",
): boolean {
  const metrics = assetTrendMetrics(rows, asset, LOOKBACK_HOURS);
  if (!metrics) return true;
  if (Math.abs(metrics.momentumPct) > FUNDING_EXTENDED_ABS_MOVE_PCT) return false;
  if (signalDirection === "long" && metrics.momentumPct > FUNDING_CHASE_MOVE_PCT) return false;
  if (signalDirection === "short" && metrics.momentumPct < -FUNDING_CHASE_MOVE_PCT) return false;
  return true;
}

function fundingSetupAllowed(
  signalType: "FUNDING_EXTREME_LONG" | "FUNDING_EXTREME_SHORT",
  asset: string,
  signalDirection: "long" | "short",
  rows: SnapshotRow[],
  latestSnapshot: InstrumentSnapshotFile | null,
): boolean {
  return fundingSignalAllowed(signalType, asset)
    && hyperliquidMarketQualityOk(latestSnapshot, asset)
    && fundingMoveNotExtended(rows, asset, signalDirection);
}

function blockedSignalKey(signal: Pick<Signal, "type" | "asset" | "venue" | "direction">): string {
  return [signal.type, signal.asset, signal.venue, signal.direction].join("|");
}

function recordBlockedSignalShadow(
  signal: Signal,
  rows: SnapshotRow[],
  learningParams: LearningParams,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  blockedSignals: BlockedSignalShadow[],
) {
  const key = blockedSignalKey(signal);
  if (blockedSignals.some((shadow) =>
    shadow.status === "open"
    && blockedSignalKey({
      type: shadow.signalType,
      asset: shadow.asset,
      venue: shadow.venue,
      direction: shadow.direction,
    }) === key
  )) {
    return;
  }

  const position = buildPositionFromSignal(signal, latestRow, latestSnapshot);
  if (!position) return;
  applyConservativePolymarketEntry(position, latestSnapshot);

  const blockedAt = new Date().toISOString();
  position.id = `B-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  position.openedAt = blockedAt;

  const metrics = assetTrendMetrics(rows, signal.asset, LOOKBACK_HOURS);
  const marketQuality = polymarketMarketQuality(position, latestSnapshot);
  blockedSignals.push({
    id: position.id,
    status: "open",
    blockedAt,
    blockedReason: "short_blocked_by_positive_trend",
    signalType: signal.type,
    asset: signal.asset,
    venue: signal.venue,
    direction: signal.direction,
    confidence: Number(signal.confidence.toFixed(4)),
    thesis: signal.thesis,
    trendMetrics: metrics ? {
      aboveTrendPct: Number(metrics.aboveTrendPct.toFixed(2)),
      momentumPct: Number(metrics.momentumPct.toFixed(2)),
    } : undefined,
    marketQuality,
    learningParamsSnapshot: {
      macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
      contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
      positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
      llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
      momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
      signalRisk: learningParams.signalRisk,
    },
    position,
  });
}

/**
 * When an IV-divergence signal fires, the engine always expresses the trade through
 * the upside ("above") Polymarket contract. This function records a shadow position
 * for the *missing downside leg* — what would have happened if the same vol signal
 * had instead been expressed through the nearest "below" contract. The shadow is
 * tracked through normal resolution so the learning system can detect whether the
 * missing leg is consistently profitable and surface that to the LLM.
 */
function recordIVDownsideLegShadow(
  signal: Signal,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
) {
  const shadowSignalType = `${signal.type}_DOWNSIDE`;
  // One open shadow per asset/direction at a time.
  if (blockedSignals.some((s) =>
    s.status === "open" &&
    s.signalType === shadowSignalType &&
    s.asset === signal.asset &&
    s.venue === signal.venue &&
    s.direction === signal.direction,
  )) return;

  // Build a mirror signal pointing at the below contract while preserving
  // the token side of the real above-contract trade: YES-above -> YES-below,
  // NO-above -> NO-below.
  const forcedInstrumentType = instrumentTypeForPolymarketExposure(signal.direction, "above");
  const mirrorSignal: Signal = {
    ...signal,
    type: shadowSignalType,
    contractHint: { preferredDirection: "below", allowDirectionFallback: false, forceInstrumentType: forcedInstrumentType },
  };
  const position = buildPositionFromSignal(mirrorSignal, latestRow, latestSnapshot);
  if (!position) return;
  applyConservativePolymarketEntry(position, latestSnapshot);

  const now = new Date().toISOString();
  position.id = `DL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  position.openedAt = now;

  blockedSignals.push({
    id: position.id,
    status: "open",
    blockedAt: now,
    blockedReason: "iv_downside_leg_untracked",
    signalType: shadowSignalType,
    asset: signal.asset,
    venue: signal.venue,
    direction: signal.direction,
    confidence: signal.confidence,
    thesis: `[DOWNSIDE LEG SHADOW] ${signal.thesis}`,
    marketQuality: polymarketMarketQuality(position, latestSnapshot),
    learningParamsSnapshot: {
      macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
      contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
      positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
      llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
      momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
      signalRisk: learningParams.signalRisk,
    },
    position,
  });
}

function recordPolymarketProxyShortShadow(
  sourcePosition: Position,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
) {
  if (!["BTC", "GOLD", "HYPE"].includes(sourcePosition.asset)) return;
  if (sourcePosition.direction !== "short") return;
  if (sourcePosition.venue === "polymarket") return;
  if (!latestSnapshot) return;

  const shadowSignalType = `${sourcePosition.signalType}_PM_PROXY_SHORT`;
  const proxySignal: Signal = {
    type: shadowSignalType,
    asset: sourcePosition.asset,
    venue: "polymarket",
    direction: "short",
    strength: 0.5,
    confidence: 0.25,
    thesis: `[PM PROXY SHORT SHADOW] Real ${sourcePosition.asset} short via ${sourcePosition.venue}/${sourcePosition.instrumentType ?? "legacy"} (${sourcePosition.signalType}). Track buying NO on the comparable Polymarket upside contract.`,
    hypothesisId: sourcePosition.hypothesisId,
    entryPrice: getAssetPrice(latestRow, sourcePosition.asset) ?? sourcePosition.entryUnderlyingPrice ?? sourcePosition.entryPrice,
    targetPct: sourcePosition.targetPct,
    stopPct: sourcePosition.stopPct,
    expiryDays: Math.max(1, Math.ceil((new Date(sourcePosition.expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
    contractHint: { preferredDirection: "above", allowDirectionFallback: false, forceInstrumentType: "pm_no" },
  };

  const position = buildPositionFromSignal(proxySignal, latestRow, latestSnapshot);
  if (!position) return;
  applyConservativePolymarketEntry(position, latestSnapshot);

  if (blockedSignals.some((shadow) =>
    shadow.status === "open" &&
    shadow.signalType === shadowSignalType &&
    shadow.asset === position.asset &&
    shadow.venue === position.venue &&
    shadow.direction === position.direction &&
    shadow.position.instrumentId === position.instrumentId,
  )) return;

  const now = new Date().toISOString();
  position.id = `PS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  position.openedAt = now;

  blockedSignals.push({
    id: position.id,
    status: "open",
    blockedAt: now,
    blockedReason: "polymarket_proxy_short",
    signalType: shadowSignalType,
    asset: sourcePosition.asset,
    venue: "polymarket",
    direction: "short",
    confidence: proxySignal.confidence,
    thesis: proxySignal.thesis,
    sourcePositionId: sourcePosition.id,
    sourcePositionLabel: `${sourcePosition.asset} ${sourcePosition.direction} via ${sourcePosition.venue}/${sourcePosition.instrumentType ?? "legacy"} (${sourcePosition.signalType})`,
    marketQuality: polymarketMarketQuality(position, latestSnapshot),
    learningParamsSnapshot: {
      macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
      contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
      positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
      llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
      momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
      signalRisk: learningParams.signalRisk,
    },
    position,
  });
}

function snapshotAgeMinutes(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return (Date.now() - parsed) / 60000;
}

function normalizedResolutionSource(contract: InstrumentSnapshotContract): string {
  return (contract.resolutionSource ?? "").trim().toLowerCase();
}

function normalizedResolutionTemplate(contract: InstrumentSnapshotContract): string {
  return (contract.description ?? "")
    .toLowerCase()
    .replace(/\$?\d[\d,]*(?:\.\d+)?/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
}

function monotonicResolutionMatches(broad: InstrumentSnapshotContract, narrow: InstrumentSnapshotContract): boolean {
  const broadSource = normalizedResolutionSource(broad);
  const narrowSource = normalizedResolutionSource(narrow);
  if (broadSource && narrowSource && broadSource !== narrowSource) return false;

  const broadTemplate = normalizedResolutionTemplate(broad);
  const narrowTemplate = normalizedResolutionTemplate(narrow);
  if (broadTemplate && narrowTemplate && broadTemplate !== narrowTemplate) return false;

  return true;
}

async function attachMonotonicPackageEntryBook(position: Position): Promise<string | null> {
  if (!position.packageLegs || position.packageLegs.length < 2) return "missing package legs";
  const snapshot = await applyEntryBookToPackageLegs(position.packageLegs);
  if (!snapshot) return "clob entry book fetch failed";
  position.entryBookSnapshot = snapshot;
  const broad = position.packageLegs.find((leg) => leg.role === "broad_yes");
  const narrow = position.packageLegs.find((leg) => leg.role === "narrow_no");
  if (broad && narrow) {
    const packageCost = broad.yesAsk + (1 - narrow.yesBid);
    position.entryPrice = packageCost;
    position.currentPrice = packageCost;
    broad.entryPrice = broad.yesAsk;
    narrow.entryPrice = 1 - narrow.yesBid;
  }
  const packageAvailableSize = snapshot.packageAvailableSize ?? null;
  if (
    packageAvailableSize !== null
    && packageAvailableSize < MONOTONIC_ARB_MIN_TOP_OF_BOOK_SIZE
  ) {
    return `package top-of-book size ${packageAvailableSize.toFixed(2)} < min ${MONOTONIC_ARB_MIN_TOP_OF_BOOK_SIZE}`;
  }
  return null;
}

async function attachPolymarketEntryBook(position: Position): Promise<void> {
  if (position.instrumentType === "pm_package" && position.packageLegs) {
    await attachMonotonicPackageEntryBook(position);
    return;
  }
  if (
    (position.instrumentType === "pm_yes" || position.instrumentType === "pm_no")
    && position.instrumentId
  ) {
    const marketId = position.instrumentId.split("::")[1];
    if (!marketId) return;
    const books = await fetchMarketYesNoBooks(marketId);
    if (!books) return;
    const leg = legSnapshotFromYesBook(
      position.instrumentType === "pm_yes" ? "pm_yes" : "pm_no",
      marketId,
      books.yes,
      books.liquidity,
    );
    position.entryBookSnapshot = {
      capturedAt: new Date().toISOString(),
      source: "clob_live",
      legs: [leg],
    };
  }
}

async function recordMonotonicArbShadows(
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
  portfolio: Portfolio | null = null,
): Promise<number> {
  if (!latestSnapshot) return 0;
  const ageMinutes = snapshotAgeMinutes(latestSnapshot.timestamp);
  if (ageMinutes !== null && ageMinutes > MONOTONIC_ARB_MAX_SNAPSHOT_AGE_MINUTES) return 0;
  const liveMode = ENABLE_MONOTONIC_ARB_LIVE && portfolio !== null;
  let recorded = 0;

  for (const event of latestSnapshot.polymarket) {
    if (!MONOTONIC_ARB_ASSETS.has(event.asset)) continue;
    if (!isNestedLadderEvent(event.slug, event.title)) continue;
    const liveContracts = event.contracts.filter((contract) =>
      contract.active !== false &&
      !contract.closed &&
      contract.bestBid != null &&
      contract.bestAsk != null &&
      contract.bestBid > 0 &&
      contract.bestAsk > 0 &&
      Number.isFinite(contract.strike) &&
      (contract.direction === "above" || contract.direction === "below") &&
      (contract.spread ?? Math.max(0, contract.bestAsk - contract.bestBid)) <= MONOTONIC_ARB_MAX_YES_SPREAD
    );

    for (const direction of ["above", "below"] as const) {
      const directional = liveContracts
        .filter((contract) => contract.direction === direction)
        .sort((a, b) => a.strike - b.strike);

      for (let i = 0; i < directional.length; i++) {
        for (let j = i + 1; j < directional.length; j++) {
          const lower = directional[i];
          const higher = directional[j];
          const broad = direction === "above" ? lower : higher;
          const narrow = direction === "above" ? higher : lower;
          if (broad.endDate && narrow.endDate && broad.endDate !== narrow.endDate) continue;
          if (!monotonicResolutionMatches(broad, narrow)) continue;

          const maxSpread = Math.max(
            broad.spread ?? Math.max(0, (broad.bestAsk ?? 0) - (broad.bestBid ?? 0)),
            narrow.spread ?? Math.max(0, (narrow.bestAsk ?? 0) - (narrow.bestBid ?? 0)),
          );
          const minLiquidity = Math.min(broad.liquidity ?? 0, narrow.liquidity ?? 0);
          if (maxSpread > MONOTONIC_ARB_MAX_YES_SPREAD) continue;
          if (minLiquidity < MONOTONIC_ARB_MIN_LEG_LIQUIDITY) continue;

          const broadAsk = broad.bestAsk ?? 0;
          const narrowBid = narrow.bestBid ?? 0;
          const broadAskSize = broad.bestAskSize ?? null;
          const narrowNoAskSize = narrow.bestBidSize ?? null;
          const packageAvailableSize = broadAskSize !== null && narrowNoAskSize !== null
            ? Math.min(broadAskSize, narrowNoAskSize)
            : null;
          if (packageAvailableSize !== null && packageAvailableSize < MONOTONIC_ARB_MIN_TOP_OF_BOOK_SIZE) continue;

          const grossEdge = narrowBid - broadAsk;
          if (grossEdge < MONOTONIC_ARB_MIN_GROSS_EDGE) continue;

          const packageId = `${event.slug}::YES-${broad.marketId}+NO-${narrow.marketId}`;
          if (blockedSignals.some((shadow) =>
            shadow.status === "open" &&
            shadow.signalType === "MONOTONIC_ARB" &&
            shadow.position.instrumentId === packageId
          )) continue;
          // In live mode also dedup against open live positions (one package
          // id at a time), and stop if the bankroll is exhausted.
          if (liveMode && portfolio!.positions.some((p) => p.instrumentId === packageId)) continue;
          if (liveMode && portfolio!.cash < TRADE_SIZE) continue;

          const now = new Date().toISOString();
          const narrowNoAsk = 1 - narrowBid;
          const packageCost = broadAsk + narrowNoAsk;
          const expiryDate = broad.endDate || narrow.endDate || new Date(Date.now() + 30 * 86400000).toISOString();
          const position: Position = {
            id: `MA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            openedAt: now,
            asset: event.asset,
            venue: "polymarket",
            direction: "long",
            entryPrice: packageCost,
            currentPrice: packageCost,
            size: TRADE_SIZE,
            leverage: 1,
            signalType: "MONOTONIC_ARB",
            hypothesisId: null,
            thesis: `[MONOTONIC ARB SHADOW] Buy YES on broader ${direction} strike ${broad.strike} @ ${broadAsk.toFixed(4)} and buy NO on narrower ${direction} strike ${narrow.strike} @ ${narrowNoAsk.toFixed(4)}. Gross locked edge ${(grossEdge * 100).toFixed(2)}c per paired share before fees/slippage; track to expiry before production.`,
            targetPct: null,
            stopPct: 100,
            expiryDate,
            instrumentType: "pm_package",
            instrumentId: packageId,
            instrumentLabel: `${event.slug} — monotonic arb package — YES ${broad.strike} / NO ${narrow.strike}`,
            packageLegs: [
              {
                role: "broad_yes",
                instrumentType: "pm_yes",
                instrumentId: `${event.slug}::${broad.marketId}`,
                instrumentLabel: `${event.slug} — YES — ${broad.question}`,
                entryPrice: broadAsk,
                strike: broad.strike,
                direction: broad.direction,
                yesBid: broad.bestBid ?? 0,
                yesAsk: broadAsk,
                yesBidSize: broad.bestBidSize ?? null,
                yesAskSize: broadAskSize,
                startDate: broad.startDate ?? null,
              },
              {
                role: "narrow_no",
                instrumentType: "pm_no",
                instrumentId: `${event.slug}::${narrow.marketId}`,
                instrumentLabel: `${event.slug} — NO — ${narrow.question}`,
                entryPrice: narrowNoAsk,
                strike: narrow.strike,
                direction: narrow.direction,
                yesBid: narrowBid,
                yesAsk: narrow.bestAsk ?? 0,
                yesBidSize: narrowNoAskSize,
                yesAskSize: narrow.bestAskSize ?? null,
                startDate: narrow.startDate ?? null,
              },
            ],
            entryUnderlyingPrice: getAssetPrice(latestRow, event.asset) ?? latestSnapshot.spots[event.asset] ?? undefined,
            currentUnderlyingPrice: getAssetPrice(latestRow, event.asset) ?? latestSnapshot.spots[event.asset] ?? undefined,
          };

          const flags: string[] = [];
          if (maxSpread > MONOTONIC_ARB_MAX_YES_SPREAD) flags.push("wide_pm_spread");
          if (minLiquidity < MONOTONIC_ARB_MIN_LEG_LIQUIDITY) flags.push("low_leg_liquidity");
          if (packageAvailableSize !== null && packageAvailableSize < MONOTONIC_ARB_MIN_TOP_OF_BOOK_SIZE) flags.push("low_top_of_book_size");
          if (packageCost >= 1) flags.push("no_locked_edge");

          if (liveMode) {
            // Open a real (tracked) position rather than a shadow. Exempt from
            // MAX_OPEN_POSITIONS; only constrained by available cash.
            position.thesis = `[MONOTONIC ARB LIVE] Buy YES on broader ${direction} strike ${broad.strike} @ ${broadAsk.toFixed(4)} and buy NO on narrower ${direction} strike ${narrow.strike} @ ${narrowNoAsk.toFixed(4)}. Gross locked edge ${(grossEdge * 100).toFixed(2)}c per paired share before fees/slippage; min payout $1.00 >= cost $${packageCost.toFixed(4)} (risk-free). Threads the strike gap for the ~$1 jackpot payout.`;
            position.instrumentLabel = `${event.slug} — monotonic arb package (LIVE) — YES ${broad.strike} / NO ${narrow.strike}`;
            const entryBlock = await attachMonotonicPackageEntryBook(position);
            if (entryBlock) continue;
            portfolio!.cash -= TRADE_SIZE;
            portfolio!.positions.push(position);
            recorded++;
            continue;
          }

          const entryBlock = await attachMonotonicPackageEntryBook(position);
          if (entryBlock) continue;

          blockedSignals.push({
            id: position.id,
            status: "open",
            blockedAt: now,
            blockedReason: "monotonic_arb_shadow",
            signalType: "MONOTONIC_ARB",
            asset: event.asset,
            venue: "polymarket",
            direction: "long",
            confidence: Number(Math.min(1, grossEdge / 0.01).toFixed(4)),
            thesis: position.thesis,
            marketQuality: {
              yesBid: Number(narrowBid.toFixed(4)),
              yesAsk: Number(broadAsk.toFixed(4)),
              yesSpread: Number(maxSpread.toFixed(4)),
              liquidity: Number(minLiquidity.toFixed(2)),
              availableSize: packageAvailableSize === null ? null : Number(packageAvailableSize.toFixed(2)),
              flags,
            },
            learningParamsSnapshot: {
              macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
              contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
              positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
              llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
              momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
              signalRisk: learningParams.signalRisk,
            },
            position,
          });
          recorded++;
        }
      }
    }
  }

  return recorded;
}

function relativeValueFlagSet(row: RelativeValueObservation): Set<string> {
  return new Set(row.flags.split(";").map((flag) => flag.trim()).filter(Boolean));
}

function isStrikeIvSkewArtifact(row: RelativeValueObservation): boolean {
  // Applies symmetrically to both directions of one-touch / settlement edge:
  //   - buy_yes (upside): strike far above spot, option IV inflated by call skew
  //   - sell_yes_or_buy_no (downside): strike far below spot, option IV
  //     inflated by put skew. Same arithmetic test; the "side" is implicit in
  //     bestExpression and the distance metric is absolute.
  if (row.bestExpression !== "buy_yes" && row.bestExpression !== "sell_yes_or_buy_no") return false;
  const dteDays = Number(row.rawRow.dte_days);
  const spot = Number(row.rawRow.spot);
  const strike = row.strike;
  const optIv = row.optionIv;
  const pmIv = row.pmIv;
  if (!Number.isFinite(dteDays) || dteDays > ONE_TOUCH_SKEW_GUARD_MAX_DTE) return false;
  if (!Number.isFinite(spot) || spot <= 0) return false;
  if (optIv === null || pmIv === null || pmIv <= 0) return false;
  const distPct = Math.abs(strike - spot) / spot;
  if (distPct < ONE_TOUCH_SKEW_GUARD_MIN_DIST_PCT) return false;
  return (optIv / pmIv) >= ONE_TOUCH_SKEW_GUARD_IV_RATIO;
}

function strictOneTouchHighEdgeEligible(row: RelativeValueObservation): boolean {
  if (row.modelVersion !== ONE_TOUCH_MODEL_VERSION) return false;
  if (!row.marketId || !row.eventSlug) return false;
  if (row.edgePts === null || Math.abs(row.edgePts) < ONE_TOUCH_HIGH_EDGE_MIN_ABS_EDGE) return false;
  if (row.bestExpression !== "sell_yes_or_buy_no" && row.bestExpression !== "buy_yes") return false;
  const flags = relativeValueFlagSet(row);
  const badFlags = row.bestExpression === "buy_yes" ? ONE_TOUCH_BUY_YES_BAD_FLAGS : ONE_TOUCH_STRICT_BAD_FLAGS;
  if (Array.from(badFlags).some((flag) => flags.has(flag))) return false;
  if (isStrikeIvSkewArtifact(row)) return false;
  return true;
}

function staleLotteryTicketNoEligible(row: RelativeValueObservation): boolean {
  if (row.modelVersion !== ONE_TOUCH_MODEL_VERSION) return false;
  if (!row.marketId || !row.eventSlug) return false;
  if (row.bestExpression !== "sell_yes_or_buy_no") return false;
  const yesPrice = row.pmYes;
  if (yesPrice === null) return false;
  if (yesPrice < STALE_LOTTERY_TICKET_NO_MIN_YES_PRICE || yesPrice > STALE_LOTTERY_TICKET_NO_MAX_YES_PRICE) return false;
  const modelProb = row.modelProb;
  if (modelProb === null || modelProb > STALE_LOTTERY_TICKET_NO_MAX_MODEL_PROB) return false;
  const dte = Number(row.rawRow.dte_days);
  if (!Number.isFinite(dte) || dte > STALE_LOTTERY_TICKET_NO_MAX_DTE) return false;
  const spot = Number(row.rawRow.spot);
  if (!Number.isFinite(spot) || spot <= 0) return false;
  const distPct = Math.abs(row.strike - spot) / spot;
  if (distPct < STALE_LOTTERY_TICKET_NO_MIN_DIST_PCT) return false;
  const edge = row.edgePts;
  if (edge === null || edge < STALE_LOTTERY_TICKET_NO_MIN_EDGE_PTS) return false;
  const flags = relativeValueFlagSet(row);
  if (Array.from(STALE_LOTTERY_TICKET_NO_BAD_FLAGS).some((flag) => flags.has(flag))) return false;
  return true;
}

function sellYesEdgePts(row: RelativeValueObservation): number | null {
  const explicit = num(row.rawRow.sell_yes_edge_pts);
  if (explicit !== null) return explicit;
  return row.bestExpression === "sell_yes_or_buy_no" && row.edgePts !== null ? Math.abs(row.edgePts) : null;
}

function oneTouchNoShadowEligible(row: RelativeValueObservation): boolean {
  if (row.modelVersion !== ONE_TOUCH_MODEL_VERSION) return false;
  if (!row.marketId || !row.eventSlug) return false;
  if (row.bestExpression !== "sell_yes_or_buy_no") return false;
  const edge = sellYesEdgePts(row);
  if (edge === null || edge < ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS) return false;
  if (row.pmSpread === null || row.pmSpread > ONE_TOUCH_NO_SHADOW_MAX_SPREAD) return false;
  if (row.liquidity === null || row.liquidity < ONE_TOUCH_NO_SHADOW_MIN_LIQUIDITY) return false;
  const flags = relativeValueFlagSet(row);
  if (Array.from(ONE_TOUCH_STRICT_BAD_FLAGS).some((flag) => flags.has(flag))) return false;
  return true;
}

function buildOneTouchHighEdgeShadowPosition(
  row: RelativeValueObservation,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile,
): Position | null {
  const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === row.eventSlug);
  const contract = event?.contracts.find((candidate) => candidate.marketId === row.marketId);
  if (!event || !contract) return null;

  const instrumentType: "pm_yes" | "pm_no" = "pm_no";
  const entryPrice = polymarketEntryPrice(contract, instrumentType);
  if (!passesOneSidedPolymarketEntryPrice(entryPrice)) return null;

  const openedAt = new Date().toISOString();
  const expiryDate = new Date(openedAt);
  expiryDate.setDate(expiryDate.getDate() + ONE_TOUCH_HIGH_EDGE_HOLD_DAYS);

  const edge = sellYesEdgePts(row) ?? Math.abs(row.edgePts ?? 0);
  const sideLabel = instrumentType === "pm_no" ? "NO" : "YES";
  const signalType = instrumentType === "pm_no" ? ONE_TOUCH_HIGH_EDGE_SIGNAL_NO : ONE_TOUCH_HIGH_EDGE_SIGNAL_YES;
  const underlyingPrice = getAssetPrice(latestRow, row.asset) ?? latestSnapshot.spots[row.asset] ?? row.strike;
  return {
    id: `OT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    openedAt,
    asset: row.asset,
    venue: "polymarket",
    direction: instrumentType === "pm_no" ? "short" : "long",
    entryPrice,
    currentPrice: entryPrice,
    size: TRADE_SIZE,
    leverage: 1,
    signalType,
    hypothesisId: null,
    thesis: `[ONE-TOUCH NO EDGE SHADOW] NO-only touch-market shadow: sell-YES edge ${edge.toFixed(1)}pt on ${row.asset}, spread ${((row.pmSpread ?? 0) * 100).toFixed(1)}c, liquidity ${Math.round(row.liquidity ?? 0)}. Shadow-promotion guidance: avoid YES contracts and sell_yes_edge_pts < ${ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS}; exit when sell-YES edge disappears; keep bucketing edge size because current evidence supports edge as a gate, not a sizing multiplier.`,
    targetPct: null,
    stopPct: 100,
    expiryDate: expiryDate.toISOString(),
    instrumentType,
    instrumentId: `${event.slug}::${contract.marketId}`,
    instrumentLabel: `${event.slug} — ${sideLabel} — ${contract.question}`,
    entryUnderlyingPrice: underlyingPrice,
    currentUnderlyingPrice: underlyingPrice,
    fundingPnlAccrued: 0,
  };
}

function recordOneTouchHighEdgeShadows(
  relativeValueRows: RelativeValueObservation[],
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
  liveCoveredKeys: Set<string> = new Set(),
): number {
  if (!latestSnapshot) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const candidates = relativeValueRows
    .filter(oneTouchNoShadowEligible)
    .filter((row) => !liveCoveredKeys.has(`${row.asset}::${row.marketId}`))
    .sort((a, b) => (sellYesEdgePts(b) ?? 0) - (sellYesEdgePts(a) ?? 0));
  const seenThisRun = new Set<string>();
  let recorded = 0;

  for (const row of candidates) {
    const position = buildOneTouchHighEdgeShadowPosition(row, latestRow, latestSnapshot);
    if (!position || !position.instrumentId) continue;
    const dedupKey = `${position.signalType}|${position.instrumentId}`;
    if (seenThisRun.has(dedupKey)) continue;
    seenThisRun.add(dedupKey);
    if (blockedSignals.some((shadow) =>
      shadow.signalType === position.signalType &&
      shadow.position.instrumentId === position.instrumentId &&
      (shadow.status === "open" || shadow.blockedAt.slice(0, 10) === today)
    )) continue;

    const selectedSide = position.instrumentType === "pm_no" ? "no" : "yes";
    blockedSignals.push({
      id: position.id,
      status: "open",
      blockedAt: position.openedAt,
      blockedReason: "one_touch_high_edge_shadow",
      signalType: position.signalType,
      asset: row.asset,
      venue: "polymarket",
      direction: position.direction,
      confidence: Math.min(0.7, 0.45 + ((sellYesEdgePts(row) ?? 0) / 100)),
      thesis: position.thesis,
      marketQuality: polymarketMarketQuality(position, latestSnapshot),
      learningParamsSnapshot: {
        macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
        contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
        positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
        llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
        momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
        signalRisk: learningParams.signalRisk,
      },
      position,
      heatmapRowSnapshot: {
        schemaVersion: 1,
        source: "cross_venue_relative_value_heatmap",
        row: row.rawRow,
        selectedSide,
        selectedSignalType: position.signalType,
      },
    });
    recorded++;
  }

  return recorded;
}

function noBiasAdjustedGapEligible(row: RelativeValueObservation): boolean {
  if (!row.marketId || !row.eventSlug) return false;
  if (!row.noBiasCandidatePassed) return false;
  if (row.adjustedNoGapPts === null || row.adjustedNoGapPts <= 0) return false;
  if (row.pmSpread === null || row.pmSpread > NO_BIAS_ADJUSTED_GAP_MAX_SPREAD) return false;
  if (row.liquidity === null || row.liquidity < NO_BIAS_ADJUSTED_GAP_MIN_LIQUIDITY) return false;
  return true;
}

function buildNoBiasAdjustedGapShadowPosition(
  row: RelativeValueObservation,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile,
): Position | null {
  const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === row.eventSlug);
  const contract = event?.contracts.find((candidate) => candidate.marketId === row.marketId);
  if (!event || !contract) return null;

  const entryPrice = polymarketEntryPrice(contract, "pm_no");
  if (!passesOneSidedPolymarketEntryPrice(entryPrice)) return null;

  const openedAt = new Date().toISOString();
  const expiryDate = new Date(openedAt);
  const dteDays = Number(row.rawRow.dte_days);
  const holdDays = Number.isFinite(dteDays) && dteDays > 0
    ? Math.min(NO_BIAS_ADJUSTED_GAP_HOLD_DAYS, Math.ceil(dteDays))
    : NO_BIAS_ADJUSTED_GAP_HOLD_DAYS;
  expiryDate.setDate(expiryDate.getDate() + holdDays);

  const underlyingPrice = getAssetPrice(latestRow, row.asset) ?? latestSnapshot.spots[row.asset] ?? row.strike;
  const cmeGap = row.cmeNoGapPts === null ? "n/a" : `${row.cmeNoGapPts.toFixed(1)}pt`;
  return {
    id: `NB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    openedAt,
    asset: row.asset,
    venue: "polymarket",
    direction: "short",
    entryPrice,
    currentPrice: entryPrice,
    size: TRADE_SIZE,
    leverage: 1,
    signalType: NO_BIAS_ADJUSTED_GAP_SIGNAL,
    hypothesisId: null,
    thesis: `[NO-BIAS ADJUSTED GAP SHADOW] Buy NO where adjusted NO gap is ${row.adjustedNoGapPts?.toFixed(1)}pt after haircuts. CBOE gap ${row.cboeNoGapPts?.toFixed(1) ?? "n/a"}pt, CME gap ${cmeGap}, source agreement ${row.sourceAgreementBucket}, spread ${((row.pmSpread ?? 0) * 100).toFixed(1)}c, liquidity ${Math.round(row.liquidity ?? 0)}. Shadow-only calibration trade; hold ${holdDays}d or exit if adjusted gap disappears.`,
    targetPct: null,
    stopPct: 100,
    expiryDate: expiryDate.toISOString(),
    instrumentType: "pm_no",
    instrumentId: `${event.slug}::${contract.marketId}`,
    instrumentLabel: `${event.slug} — NO — ${contract.question}`,
    entryUnderlyingPrice: underlyingPrice,
    currentUnderlyingPrice: underlyingPrice,
    fundingPnlAccrued: 0,
  };
}

function recordNoBiasAdjustedGapShadows(
  relativeValueRows: RelativeValueObservation[],
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
): number {
  if (!latestSnapshot) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const candidates = relativeValueRows
    .filter(noBiasAdjustedGapEligible)
    .sort((a, b) => (b.adjustedNoGapPts ?? 0) - (a.adjustedNoGapPts ?? 0));
  const seenThisRun = new Set<string>();
  let recorded = 0;

  for (const row of candidates) {
    const position = buildNoBiasAdjustedGapShadowPosition(row, latestRow, latestSnapshot);
    if (!position || !position.instrumentId) continue;
    const dedupKey = `${position.signalType}|${position.instrumentId}`;
    if (seenThisRun.has(dedupKey)) continue;
    seenThisRun.add(dedupKey);
    if (blockedSignals.some((shadow) =>
      shadow.signalType === position.signalType &&
      shadow.position.instrumentId === position.instrumentId &&
      (shadow.status === "open" || shadow.blockedAt.slice(0, 10) === today)
    )) continue;

    blockedSignals.push({
      id: position.id,
      status: "open",
      blockedAt: position.openedAt,
      blockedReason: NO_BIAS_ADJUSTED_GAP_REASON,
      signalType: position.signalType,
      asset: row.asset,
      venue: "polymarket",
      direction: position.direction,
      confidence: Math.min(0.7, 0.45 + ((row.adjustedNoGapPts ?? 0) / 100)),
      thesis: position.thesis,
      marketQuality: polymarketMarketQuality(position, latestSnapshot),
      learningParamsSnapshot: {
        macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
        contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
        positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
        llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
        momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
        signalRisk: learningParams.signalRisk,
      },
      position,
      heatmapRowSnapshot: {
        schemaVersion: 1,
        source: "cross_venue_relative_value_heatmap",
        row: row.rawRow,
        selectedSide: "no",
        selectedSignalType: position.signalType,
      },
    });
    recorded++;
  }

  return recorded;
}

function buildStaleLotteryTicketNoShadowPosition(
  row: RelativeValueObservation,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile,
): Position | null {
  const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === row.eventSlug);
  const contract = event?.contracts.find((candidate) => candidate.marketId === row.marketId);
  if (!event || !contract) return null;

  const entryPrice = polymarketEntryPrice(contract, "pm_no");
  if (!passesOneSidedPolymarketEntryPrice(entryPrice)) return null;

  const openedAt = new Date().toISOString();
  const expiryDate = new Date(openedAt);
  const dteDays = Number(row.rawRow.dte_days);
  const holdDays = Number.isFinite(dteDays) && dteDays > 0
    ? Math.min(STALE_LOTTERY_TICKET_NO_HOLD_DAYS, Math.ceil(dteDays))
    : STALE_LOTTERY_TICKET_NO_HOLD_DAYS;
  expiryDate.setDate(expiryDate.getDate() + holdDays);

  const underlyingPrice = getAssetPrice(latestRow, row.asset) ?? latestSnapshot.spots[row.asset] ?? row.strike;
  const spot = Number(row.rawRow.spot);
  const distPct = Number.isFinite(spot) && spot > 0 ? (Math.abs(row.strike - spot) / spot) * 100 : null;
  const modelProbPct = row.modelProb !== null ? row.modelProb * 100 : null;
  const yesPricePct = row.pmYes !== null ? row.pmYes * 100 : null;

  return {
    id: `SL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    openedAt,
    asset: row.asset,
    venue: "polymarket",
    direction: "short",
    entryPrice,
    currentPrice: entryPrice,
    size: TRADE_SIZE,
    leverage: 1,
    signalType: STALE_LOTTERY_TICKET_NO_SIGNAL,
    hypothesisId: null,
    thesis: `[STALE LOTTERY TICKET NO SHADOW] Far-OTM YES (${distPct !== null ? distPct.toFixed(1) + "%" : "?"} from spot) with model touch prob ${modelProbPct !== null ? modelProbPct.toFixed(1) + "%" : "?"} but PM still pricing YES at ${yesPricePct !== null ? yesPricePct.toFixed(1) + "%" : "?"}. Sell residual lottery premium by buying NO; hold ${holdDays}d (capped at expiry) to test market repricing of unreachable strikes.`,
    targetPct: null,
    stopPct: 100,
    expiryDate: expiryDate.toISOString(),
    instrumentType: "pm_no",
    instrumentId: `${event.slug}::${contract.marketId}`,
    instrumentLabel: `${event.slug} — NO — ${contract.question}`,
    entryUnderlyingPrice: underlyingPrice,
    currentUnderlyingPrice: underlyingPrice,
    fundingPnlAccrued: 0,
  };
}

function recordStaleLotteryTicketNoShadows(
  relativeValueRows: RelativeValueObservation[],
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
): number {
  if (!latestSnapshot) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const candidates = relativeValueRows
    .filter(staleLotteryTicketNoEligible)
    .sort((a, b) => Math.abs(b.edgePts ?? 0) - Math.abs(a.edgePts ?? 0));
  const seenThisRun = new Set<string>();
  let recorded = 0;

  for (const row of candidates) {
    const position = buildStaleLotteryTicketNoShadowPosition(row, latestRow, latestSnapshot);
    if (!position || !position.instrumentId) continue;
    const dedupKey = `${position.signalType}|${position.instrumentId}`;
    if (seenThisRun.has(dedupKey)) continue;
    seenThisRun.add(dedupKey);
    if (blockedSignals.some((shadow) =>
      shadow.signalType === position.signalType &&
      shadow.position.instrumentId === position.instrumentId &&
      (shadow.status === "open" || shadow.blockedAt.slice(0, 10) === today)
    )) continue;

    blockedSignals.push({
      id: position.id,
      status: "open",
      blockedAt: position.openedAt,
      blockedReason: "stale_lottery_ticket_shadow",
      signalType: position.signalType,
      asset: row.asset,
      venue: "polymarket",
      direction: position.direction,
      confidence: Math.min(1, (row.edgePts ?? 0) / 20),
      thesis: position.thesis,
      marketQuality: polymarketMarketQuality(position, latestSnapshot),
      learningParamsSnapshot: {
        macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
        contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
        positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
        llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
        momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
        signalRisk: learningParams.signalRisk,
      },
      position,
      heatmapRowSnapshot: {
        schemaVersion: 1,
        source: "cross_venue_relative_value_heatmap",
        row: row.rawRow,
        selectedSide: "no",
        selectedSignalType: position.signalType,
      },
    });
    recorded++;
  }

  return recorded;
}

function weekendHyperliquidFundingCandidates(latestSnapshot: InstrumentSnapshotFile | null): Position[] {
  if (!latestSnapshot || !isStockPerpFundingWindowOpen()) return [];
  const openedAt = new Date().toISOString();
  const openedAtMs = Date.parse(openedAt);
  const expiryDate = new Date(openedAtMs + WEEKEND_HL_FUNDING_MAX_HOLD_HOURS * 60 * 60 * 1000);
  const positions: Position[] = [];

  for (const asset of HYPE_STOCK_BUILDER_ASSETS) {
    const quote = latestSnapshot.hyperliquid[asset];
    const markPx = quote?.markPx;
    const fundingAnnualized = quote?.fundingAnnualized;
    if (!(typeof markPx === "number" && markPx > 0)) continue;
    if (!(typeof fundingAnnualized === "number"
          && fundingAnnualized <= WEEKEND_HL_FUNDING_ENTRY_PCT
          && fundingAnnualized >= WEEKEND_HL_FUNDING_ENTRY_FLOOR_PCT)) continue;

    positions.push({
      id: `WF-${Date.now()}-${asset}-${Math.random().toString(36).slice(2, 6)}`,
      openedAt,
      asset,
      venue: "hyperliquid",
      direction: "long",
      entryPrice: markPx,
      currentPrice: markPx,
      currentUnderlyingPrice: markPx,
      entryUnderlyingPrice: markPx,
      size: TRADE_SIZE,
      leverage: WEEKEND_HL_FUNDING_LEVERAGE,
      signalType: WEEKEND_HL_FUNDING_LIVE_SIGNAL,
      hypothesisId: null,
      thesis: `[WEEKEND HL FUNDING LIVE] ${asset} Builder DEX stock perp funding ${(fundingAnnualized * 100).toFixed(1)}% annualized in mid band [${(WEEKEND_HL_FUNDING_ENTRY_FLOOR_PCT * 100).toFixed(0)}%, ${(WEEKEND_HL_FUNDING_ENTRY_PCT * 100).toFixed(0)}%] during US-equity-closed window (Fri 4:00pm ET → Mon 9:30am ET). Live tracked long at ${WEEKEND_HL_FUNDING_LEVERAGE}x; exit when margin P&L >= ${WEEKEND_HL_FUNDING_TARGET_PCT}%, funding >= ${(WEEKEND_HL_FUNDING_EXIT_PCT * 100).toFixed(0)}%, or held ${WEEKEND_HL_FUNDING_MAX_HOLD_HOURS}h.`,
      targetPct: WEEKEND_HL_FUNDING_TARGET_PCT,
      stopPct: 100,
      expiryDate: expiryDate.toISOString(),
      instrumentType: "hl_perp",
      instrumentId: asset,
      instrumentLabel: `HL ${asset} Builder DEX stock perp`,
      fundingPnlAccrued: 0,
    });
  }

  return positions;
}

function recordWeekendHyperliquidFundingLiveTrades(
  latestSnapshot: InstrumentSnapshotFile | null,
  portfolio: Portfolio,
  blockedSignals: BlockedSignalShadow[],
): number {
  if (!ENABLE_WEEKEND_HL_FUNDING_LIVE) return 0;
  let recorded = 0;

  for (const position of weekendHyperliquidFundingCandidates(latestSnapshot)) {
    if (portfolio.positions.length >= MAX_OPEN_POSITIONS) break;
    if (portfolio.cash < TRADE_SIZE) break;
    if (portfolio.positions.some((p) =>
      p.signalType === WEEKEND_HL_FUNDING_LIVE_SIGNAL &&
      p.asset === position.asset &&
      p.venue === "hyperliquid" &&
      p.direction === "long"
    )) continue;
    // If an old shadow is still open, don't double-count the same thesis as live.
    if (blockedSignals.some((shadow) =>
      shadow.status === "open" &&
      shadow.blockedReason === WEEKEND_HL_FUNDING_SHADOW_REASON &&
      shadow.asset === position.asset
    )) continue;

    portfolio.cash -= TRADE_SIZE;
    portfolio.positions.push(position);
    recorded++;
  }

  return recorded;
}

function promoteOpenWeekendFundingShadowsToLive(
  portfolio: Portfolio,
  blockedSignals: BlockedSignalShadow[],
): string[] {
  if (!ENABLE_WEEKEND_HL_FUNDING_LIVE) return [];
  if (!isStockPerpFundingWindowOpen()) return [];
  const notes: string[] = [];
  const now = new Date().toISOString();

  for (const shadow of blockedSignals) {
    if (shadow.status !== "open" || shadow.blockedReason !== WEEKEND_HL_FUNDING_SHADOW_REASON) continue;
    const position = {
      ...shadow.position,
      signalType: WEEKEND_HL_FUNDING_LIVE_SIGNAL,
      thesis: shadow.position.thesis
        .replace("[WEEKEND HL FUNDING SHADOW]", "[WEEKEND HL FUNDING LIVE]")
        .replace("Shadow long", "Live tracked long"),
    };
    if (portfolio.positions.some((p) =>
      p.signalType === WEEKEND_HL_FUNDING_LIVE_SIGNAL &&
      p.asset === position.asset &&
      p.venue === "hyperliquid" &&
      p.direction === "long"
    )) {
      notes.push(`Skipped ${shadow.asset}: live weekend funding position already open.`);
      continue;
    }
    if (portfolio.positions.length >= MAX_OPEN_POSITIONS) {
      notes.push(`Skipped ${shadow.asset}: max open positions reached.`);
      continue;
    }
    if (portfolio.cash < position.size) {
      notes.push(`Skipped ${shadow.asset}: insufficient cash to promote shadow (${portfolio.cash.toFixed(2)} < ${position.size.toFixed(2)}).`);
      continue;
    }

    portfolio.cash -= position.size;
    portfolio.positions.push(position);
    shadow.status = "cancelled";
    shadow.resolvedAt = now;
    shadow.learningExcluded = {
      reason: "promoted_to_live",
      note: "Weekend HL funding shadow was converted into a live tracked portfolio position.",
    };
    notes.push(`Promoted ${shadow.asset} weekend HL funding shadow to live tracked trade.`);
  }

  return notes;
}

function recordWeekendHyperliquidFundingShadows(
  latestSnapshot: InstrumentSnapshotFile | null,
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
): number {
  if (ENABLE_WEEKEND_HL_FUNDING_LIVE) return 0;
  let recorded = 0;

  for (const position of weekendHyperliquidFundingCandidates(latestSnapshot)) {
    if (blockedSignals.some((shadow) =>
      shadow.status === "open" &&
      shadow.blockedReason === WEEKEND_HL_FUNDING_SHADOW_REASON &&
      shadow.asset === position.asset
    )) continue;

    position.thesis = position.thesis.replace("[WEEKEND HL FUNDING LIVE]", "[WEEKEND HL FUNDING SHADOW]")
      .replace("Live tracked long", "Shadow long");
    blockedSignals.push({
      id: position.id,
      status: "open",
      blockedAt: position.openedAt,
      blockedReason: WEEKEND_HL_FUNDING_SHADOW_REASON,
      signalType: WEEKEND_HL_FUNDING_LIVE_SIGNAL,
      asset: position.asset,
      venue: "hyperliquid",
      direction: "long",
      confidence: 0.5,
      thesis: position.thesis,
      learningParamsSnapshot: {
        macroMomentum24hThresholdPts: learningParams.macroMomentum24hThresholdPts,
        contrarianTrendMarginPct: learningParams.contrarianTrendMarginPct,
        positiveMomentum24hPct: learningParams.positiveMomentum24hPct,
        llmTradeExpiryDays: learningParams.llmTradeExpiryDays,
        momentumLongExpiryDays: learningParams.momentumLongExpiryDays,
        signalRisk: learningParams.signalRisk,
      },
      position,
    });
    recorded++;
  }

  return recorded;
}

const ONE_TOUCH_HIGH_EDGE_LIVE_ASSETS = new Set(["BTC", "ETH", "OIL", "SPY"]);

function generateOneTouchHighEdgeNoSignals(
  rows: RelativeValueObservation[],
  weights: SignalWeight[],
  learningParams: LearningParams,
  latestSnapshot: InstrumentSnapshotFile | null,
): Signal[] {
  if (!latestSnapshot) return [];
  const weight = weights.find((w) => w.type === ONE_TOUCH_HIGH_EDGE_SIGNAL_NO);
  if (!weight || !weight.enabled) return [];

  const candidates = rows
    .filter(strictOneTouchHighEdgeEligible)
    .filter((row) => row.bestExpression === "sell_yes_or_buy_no")
    .filter((row) => ONE_TOUCH_HIGH_EDGE_LIVE_ASSETS.has(row.asset))
    .filter((row) => !weight.perAsset?.[row.asset]?.disabled)
    .sort((a, b) => Math.abs(b.edgePts ?? 0) - Math.abs(a.edgePts ?? 0));

  const risk = riskForSignal(learningParams, ONE_TOUCH_HIGH_EDGE_SIGNAL_NO);
  const signals: Signal[] = [];

  for (const row of candidates) {
    const edgeMagnitude = Math.abs(row.edgePts ?? 0);
    const event = latestSnapshot.polymarket.find((candidate) => candidate.slug === row.eventSlug);
    const contract = event?.contracts.find((candidate) => candidate.marketId === row.marketId);
    if (!event || !contract) continue;
    if (!passesPolymarketEntryQualityGate(contract)) continue;
    const entryPrice = polymarketEntryPrice(contract, "pm_no");
    if (!passesOneSidedPolymarketEntryPrice(entryPrice)) continue;
    const underlyingPrice = latestSnapshot.spots[row.asset] ?? row.strike;
    const strength = Math.min(1, edgeMagnitude / 30);
    const highConviction = edgeMagnitude >= ONE_TOUCH_HIGH_EDGE_CONVICTION_EDGE;

    signals.push({
      type: ONE_TOUCH_HIGH_EDGE_SIGNAL_NO,
      asset: row.asset,
      venue: "polymarket",
      direction: "short",
      strength,
      confidence: strength * weight.weight,
      thesis: `[ONE-TOUCH HIGH-EDGE NO LIVE] Strict one-touch NO ${edgeMagnitude.toFixed(1)}pt edge on ${row.asset}; hold ${ONE_TOUCH_HIGH_EDGE_HOLD_DAYS}d for repricing.${highConviction ? " Edge >=20pt: high-conviction bucket." : ""}`,
      hypothesisId: null,
      entryPrice: underlyingPrice,
      targetPct: risk.targetPct,
      stopPct: risk.stopPct,
      expiryDays: ONE_TOUCH_HIGH_EDGE_HOLD_DAYS,
      contractHint: {
        preferredEventSlug: row.eventSlug,
        forceInstrumentType: "pm_no",
        forceMarketId: row.marketId,
        allowDirectionFallback: false,
      },
    });
  }

  return signals;
}

function liveOneTouchHighEdgeNoKeys(signals: Signal[]): Set<string> {
  const keys = new Set<string>();
  for (const sig of signals) {
    if (sig.type !== ONE_TOUCH_HIGH_EDGE_SIGNAL_NO) continue;
    const marketId = sig.contractHint?.forceMarketId;
    if (marketId) keys.add(`${sig.asset}::${marketId}`);
  }
  return keys;
}

function isNestedLadderEvent(slug: string, title = ""): boolean {
  const haystack = `${slug} ${title}`.toLowerCase();
  if (haystack.includes("settle") || haystack.includes("final trading day") || haystack.includes("over-under")) return false;
  if (haystack.includes("range") || /\$\d+(?:\.\d+)?\s*-\s*\$?\d+(?:\.\d+)?/.test(haystack)) return false;
  return haystack.includes("hit") || haystack.includes("reach");
}

function cancelOpenInvalidMonotonicArbShadows(blockedSignals: BlockedSignalShadow[]): string[] {
  const now = new Date().toISOString();
  const notes: string[] = [];
  for (const shadow of blockedSignals) {
    if (shadow.status !== "open" || shadow.signalType !== "MONOTONIC_ARB") continue;
    const eventSlug = shadow.position.instrumentId?.split("::")[0] ?? "";
    if (isNestedLadderEvent(eventSlug, shadow.position.instrumentLabel ?? shadow.thesis)) continue;
    shadow.status = "cancelled";
    shadow.resolvedAt = now;
    shadow.learningExcluded = {
      reason: INVALID_MONOTONIC_SETTLEMENT_REASON,
      note: "Cancelled: monotonic-arb validation only applies to nested hit/reach ladders. Settlement buckets, over-under final-day markets, and range markets are not nested contracts.",
    };
    shadow.marketQuality = {
      ...(shadow.marketQuality ?? { yesBid: 0, yesAsk: 0, yesSpread: 0, liquidity: 0, flags: [] }),
      flags: Array.from(new Set([...(shadow.marketQuality?.flags ?? []), INVALID_MONOTONIC_SETTLEMENT_REASON])),
    };
    notes.push(`${shadow.asset} ${shadow.position.instrumentLabel ?? shadow.position.instrumentId ?? shadow.id}`);
  }
  return notes;
}

// One-touch shadows opened before the directional decoder / far-tail cap /
// entry-time edge persistence shipped in mid-May 2026 lack the
// `heatmapRowSnapshot` audit trail and were priced by the old
// path-vs-settle-agnostic model. They're operationally tainted training data:
// we still want their realized history to count, but the open book is a
// runoff we'd rather close out cleanly and exclude from future learning so
// the engine trains on the new improved one-touch model trades only.
function cancelLegacyOneTouchShadows(blockedSignals: BlockedSignalShadow[]): { cancelled: string[]; retroExcluded: number } {
  const now = new Date().toISOString();
  const cancelled: string[] = [];
  let retroExcluded = 0;
  for (const shadow of blockedSignals) {
    if (shadow.blockedReason !== "one_touch_high_edge_shadow") continue;
    if (shadow.heatmapRowSnapshot) continue;
    if (shadow.status === "open") {
      shadow.status = "cancelled";
      shadow.resolvedAt = now;
      shadow.learningExcluded = {
        reason: "legacy_one_touch_pre_directional_decoder_model",
        note: "Cancelled: opened before the directional decoder + far-tail cap + entry-edge audit trail shipped. Marked as data artifact so it never enters the learning loop; new-model one-touch shadows (heatmapRowSnapshot present) continue tracking normally.",
      };
      cancelled.push(`${shadow.asset} ${shadow.position.instrumentLabel ?? shadow.position.instrumentId ?? shadow.id}`);
    } else if (shadow.status === "resolved" && !shadow.learningExcluded) {
      // Resolved trades already booked their realized P&L; we leave the
      // accounting intact and only flag them as data artifacts so the
      // learning loop ignores them. Training will only see new-model data.
      shadow.learningExcluded = {
        reason: "legacy_one_touch_pre_directional_decoder_model",
        note: "Resolved under the path-vs-settle-agnostic model. Excluded from learning so the engine trains exclusively on new-model one-touch trades (heatmapRowSnapshot present).",
      };
      retroExcluded += 1;
    }
  }
  return { cancelled, retroExcluded };
}

function cancelOpenRelativeValueHeatmapShadows(blockedSignals: BlockedSignalShadow[]): string[] {
  const now = new Date().toISOString();
  const notes: string[] = [];
  for (const shadow of blockedSignals) {
    if (shadow.status !== "open" || shadow.blockedReason !== "relative_value_heatmap") continue;
    shadow.status = "cancelled";
    shadow.resolvedAt = now;
    shadow.learningExcluded = {
      reason: "heatmap_shadow_horizon_mismatch",
      note: "Cancelled: relative-value heatmap convergence should be evaluated on a longer horizon than minute/hour stop-target shadow trading.",
    };
    notes.push(`${shadow.asset} ${shadow.position.instrumentLabel ?? shadow.thesis}`);
  }
  return notes;
}

function currentOneTouchNoEdgeRow(shadow: BlockedSignalShadow, relativeValueRows: RelativeValueObservation[]): RelativeValueObservation | null {
  const [eventSlug, marketId] = shadow.position.instrumentId?.split("::") ?? [];
  if (!eventSlug || !marketId) return null;
  return relativeValueRows.find((row) => row.eventSlug === eventSlug && row.marketId === marketId) ?? null;
}

function oneTouchNoEdgeDisappeared(shadow: BlockedSignalShadow, relativeValueRows: RelativeValueObservation[]): boolean {
  if (shadow.blockedReason !== "one_touch_high_edge_shadow") return false;
  if (shadow.signalType !== ONE_TOUCH_HIGH_EDGE_SIGNAL_NO || shadow.position.instrumentType !== "pm_no") return false;
  const row = currentOneTouchNoEdgeRow(shadow, relativeValueRows);
  if (!row) return true;
  return !oneTouchNoShadowEligible(row);
}

function noBiasAdjustedGapDisappeared(shadow: BlockedSignalShadow, relativeValueRows: RelativeValueObservation[]): boolean {
  if (shadow.blockedReason !== NO_BIAS_ADJUSTED_GAP_REASON) return false;
  if (shadow.signalType !== NO_BIAS_ADJUSTED_GAP_SIGNAL || shadow.position.instrumentType !== "pm_no") return false;
  const row = currentOneTouchNoEdgeRow(shadow, relativeValueRows);
  if (!row) return true;
  return !noBiasAdjustedGapEligible(row);
}

function resolveBlockedSignalShadows(
  blockedSignals: BlockedSignalShadow[],
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
  relativeValueRows: RelativeValueObservation[] = [],
  valRows: SnapshotRow[] = [],
): BlockedSignalShadow[] {
  const resolved: BlockedSignalShadow[] = [];
  const now = new Date().toISOString();

  for (const shadow of blockedSignals) {
    if (shadow.status === "resolved") continue;
    let mark = markPosition(shadow.position, latestRow, snapshots, true);
    if (!mark) {
      // PM package contracts may no longer be in the live snapshot once the
      // market resolves. Fall back to terminal settlement so expired packages
      // can still close out.
      if (shadow.position.instrumentType === "pm_package" && new Date(shadow.position.expiryDate) <= new Date()) {
        const settled = settleMonotonicArbPackage(shadow.position, valRows);
        if (settled) {
          mark = { currentPrice: settled.price, underlyingPrice: settled.underlyingPrice, marketPnl: settled.marketPnl, fundingPnl: 0, pnl: settled.pnl, pnlPct: settled.pnlPct };
        }
      }
      if (!mark) continue;
    }
    // For pm_package shadows that have hit expiry, override the live mark
    // with realized leg settlement — `findPolymarketPackageMark` uses live
    // bid/ask which doesn't reflect actual market resolution.
    if (shadow.position.instrumentType === "pm_package" && new Date(shadow.position.expiryDate) <= new Date()) {
      const settled = settleMonotonicArbPackage(shadow.position, valRows);
      if (settled) {
        mark = { currentPrice: settled.price, underlyingPrice: settled.underlyingPrice ?? mark.underlyingPrice, marketPnl: settled.marketPnl, fundingPnl: 0, pnl: settled.pnl, pnlPct: settled.pnlPct };
      }
    }

    const expiryOnlyShadow = shadow.blockedReason === "manual_shadow_trade"
      || shadow.blockedReason === "one_touch_high_edge_shadow"
      || shadow.blockedReason === "stale_lottery_ticket_shadow";
    let closeReason: ClosedTrade["closeReason"] | null = null;
    const edgeDisappeared = oneTouchNoEdgeDisappeared(shadow, relativeValueRows);
    const noBiasGapDisappeared = noBiasAdjustedGapDisappeared(shadow, relativeValueRows);
    const weekendFundingExit = shadow.blockedReason === WEEKEND_HL_FUNDING_SHADOW_REASON
      && (
        !isStockPerpFundingWindowOpen()
        || (getHyperliquidFundingFromSnapshot(latestInstrumentSnapshot(snapshots), shadow.asset) ?? Number.NEGATIVE_INFINITY) >= WEEKEND_HL_FUNDING_EXIT_PCT
      );
    if (weekendFundingExit) closeReason = !isStockPerpFundingWindowOpen()
      ? "expiry"
      : mark.pnl >= 0 ? "thesis_validated_profitable" : "thesis_compressed_loss";
    else if (!expiryOnlyShadow && shadow.position.targetPct !== null && mark.pnlPct >= shadow.position.targetPct) closeReason = "target";
    else if (!expiryOnlyShadow && mark.pnlPct <= -shadow.position.stopPct) closeReason = "stop";
    else if (edgeDisappeared) closeReason = mark.pnl >= 0 ? "thesis_validated_profitable" : "thesis_compressed_loss";
    else if (noBiasGapDisappeared) closeReason = mark.pnl >= 0 ? "thesis_validated_profitable" : "thesis_compressed_loss";
    else if (new Date(shadow.position.expiryDate) <= new Date()) closeReason = "expiry";

    shadow.position.currentPrice = mark.currentPrice;
    shadow.position.currentUnderlyingPrice = mark.underlyingPrice ?? undefined;
    shadow.position.fundingPnlAccrued = mark.fundingPnl;

    if (!closeReason) continue;

    shadow.status = "resolved";
    shadow.resolvedAt = now;
    if (edgeDisappeared) {
      shadow.thesis = `${shadow.thesis} [CLOSED ${now}: edge_disappeared — Current heatmap no longer has valid NO edge under shadow-promotion gates: sell_yes_edge_pts >= ${ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS}, spread <= ${(ONE_TOUCH_NO_SHADOW_MAX_SPREAD * 100).toFixed(0)}c, liquidity >= ${ONE_TOUCH_NO_SHADOW_MIN_LIQUIDITY}.]`;
      shadow.position.thesis = shadow.thesis;
    }
    if (noBiasGapDisappeared) {
      shadow.thesis = `${shadow.thesis} [CLOSED ${now}: adjusted_no_gap_disappeared — Current heatmap no longer passes adjusted NO-bias gates: adjusted gap threshold, spread <= ${(NO_BIAS_ADJUSTED_GAP_MAX_SPREAD * 100).toFixed(0)}c, liquidity >= ${NO_BIAS_ADJUSTED_GAP_MIN_LIQUIDITY}.]`;
      shadow.position.thesis = shadow.thesis;
    }
    shadow.hypotheticalResult = {
      closeReason,
      exitPrice: mark.currentPrice,
      pnl: Number(mark.pnl.toFixed(4)),
      pnlPct: Number(mark.pnlPct.toFixed(2)),
      marketPnl: Number(mark.marketPnl.toFixed(4)),
      fundingPnl: Number(mark.fundingPnl.toFixed(4)),
      outcome: mark.pnl >= 0 ? "win" : "loss",
    };
    resolved.push(shadow);
  }

  return resolved;
}

function pnlCorrelation(proxyPnl: number, sourcePnl: number): NonNullable<BlockedSignalShadow["sourceComparison"]>["correlation"] {
  if (proxyPnl === 0 || sourcePnl === 0) return "flat";
  return Math.sign(proxyPnl) === Math.sign(sourcePnl) ? "same_direction" : "opposite_direction";
}

function updateProxyShortShadowComparisons(
  blockedSignals: BlockedSignalShadow[],
  closedTrades: ClosedTrade[],
): string[] {
  const notes: string[] = [];
  const tradesById = new Map(closedTrades.map((trade) => [trade.id, trade]));

  for (const shadow of blockedSignals) {
    if (
      shadow.blockedReason !== "polymarket_proxy_short" ||
      shadow.status !== "resolved" ||
      !shadow.hypotheticalResult ||
      !shadow.sourcePositionId ||
      shadow.sourceComparison
    ) continue;

    const sourceTrade = tradesById.get(shadow.sourcePositionId);
    if (!sourceTrade) continue;

    const comparison = {
      sourceClosedAt: sourceTrade.closedAt,
      sourcePnl: Number(sourceTrade.pnl.toFixed(4)),
      sourcePnlPct: Number(sourceTrade.pnlPct.toFixed(2)),
      proxyOutperformed: shadow.hypotheticalResult.pnlPct > sourceTrade.pnlPct,
      correlation: pnlCorrelation(shadow.hypotheticalResult.pnl, sourceTrade.pnl),
    };
    shadow.sourceComparison = comparison;

    const better = comparison.proxyOutperformed ? "outperformed" : "underperformed";
    const correlated = comparison.correlation === "same_direction"
      ? "correlated"
      : comparison.correlation === "opposite_direction" ? "inversely correlated" : "flat/mixed";
    notes.push(
      `${shadow.signalType} ${shadow.asset} PM proxy short ${better} actual short ` +
      `(${shadow.hypotheticalResult.pnlPct >= 0 ? "+" : ""}${shadow.hypotheticalResult.pnlPct.toFixed(2)}% vs ` +
      `${sourceTrade.pnlPct >= 0 ? "+" : ""}${sourceTrade.pnlPct.toFixed(2)}%) and was ${correlated}.`,
    );
  }

  return notes;
}

function summarizeBlockedSignals(blockedSignals: BlockedSignalShadow[]): BlockedSignalLearningSummary {
  const openCount = blockedSignals.filter((shadow) => shadow.status === "open").length;
  const resolved = blockedSignals
    .filter((shadow): shadow is BlockedSignalShadow & { hypotheticalResult: NonNullable<BlockedSignalShadow["hypotheticalResult"]>; resolvedAt: string } =>
      shadow.status === "resolved" && !!shadow.hypotheticalResult && !!shadow.resolvedAt && !shadow.learningExcluded)
    .sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt));
  const openQualityWarnings = blockedSignals
    .filter((shadow): shadow is BlockedSignalShadow & { marketQuality: NonNullable<BlockedSignalShadow["marketQuality"]> } =>
      shadow.status === "open" && !!shadow.marketQuality && shadow.marketQuality.flags.length > 0)
    .slice(-8)
    .map((shadow) => ({
      signalType: shadow.signalType,
      asset: shadow.asset,
      blockedReason: shadow.blockedReason,
      instrumentLabel: shadow.position.instrumentLabel,
      marketQuality: shadow.marketQuality,
      thesis: shadow.thesis,
    }));

  const bySignal = new Map<string, BlockedSignalLearningSummary["bySignal"][number]>();
  for (const shadow of blockedSignals) {
    if (shadow.learningExcluded) continue;
    const row = bySignal.get(shadow.signalType) ?? {
      signalType: shadow.signalType,
      blocked: 0,
      resolved: 0,
      wouldHaveWon: 0,
      wouldHaveLost: 0,
      avgPnlPct: 0,
    };
    row.blocked++;
    if (shadow.hypotheticalResult) {
      row.resolved++;
      if (shadow.hypotheticalResult.outcome === "win") row.wouldHaveWon++;
      else row.wouldHaveLost++;
      row.avgPnlPct = ((row.avgPnlPct * (row.resolved - 1)) + shadow.hypotheticalResult.pnlPct) / row.resolved;
    }
    bySignal.set(shadow.signalType, row);
  }

  return {
    openCount,
    resolvedCount: resolved.length,
    wouldHaveWon: resolved.filter((shadow) => shadow.hypotheticalResult.outcome === "win").length,
    wouldHaveLost: resolved.filter((shadow) => shadow.hypotheticalResult.outcome === "loss").length,
    bySignal: Array.from(bySignal.values())
      .map((row) => ({ ...row, avgPnlPct: Number(row.avgPnlPct.toFixed(2)) }))
      .sort((a, b) => (b.wouldHaveWon - b.wouldHaveLost) - (a.wouldHaveWon - a.wouldHaveLost))
      .slice(0, 8),
    recentResolved: resolved.slice(-8).map((shadow) => ({
      signalType: shadow.signalType,
      asset: shadow.asset,
      venue: shadow.venue,
      direction: shadow.direction,
      blockedReason: shadow.blockedReason,
      outcome: shadow.hypotheticalResult.outcome,
      closeReason: shadow.hypotheticalResult.closeReason,
      pnlPct: shadow.hypotheticalResult.pnlPct,
      resolvedAt: shadow.resolvedAt,
      trendMetrics: shadow.trendMetrics,
      marketQuality: shadow.marketQuality,
      sourceComparison: shadow.sourceComparison,
    })),
    openQualityWarnings,
  };
}

// Per-bucket calibration observer for the new one-touch model. The
// `summarizeBlockedSignals` aggregator above only buckets by signalType
// (NO vs YES exploratory), so a 30% win rate hidden inside an otherwise
// healthy population goes unnoticed. This observer slices the resolved
// new-model shadows along the dimensions the model itself emits at entry
// (heatmapRowSnapshot.row.edge_bucket and moneyness_bucket) so we can see
// which slices are calibrated and which are not. Excluded:
//   - learningExcluded shadows (legacy / artifact)
//   - shadows missing heatmapRowSnapshot (legacy pre-decoder)
//   - cancelled shadows
// We require a per-bucket sample of MIN_BUCKET_N before emitting any
// note so we don't flag noise. Thresholds are intentionally conservative.
const ONE_TOUCH_OBSERVER_MIN_BUCKET_N = 30;
const ONE_TOUCH_OBSERVER_NEGATIVE_WIN_RATE = 0.40;
const ONE_TOUCH_OBSERVER_NEGATIVE_SUM_USD = -0.10;
const ONE_TOUCH_OBSERVER_POSITIVE_WIN_RATE = 0.60;
const ONE_TOUCH_OBSERVER_POSITIVE_SUM_USD = 0.10;

function oneTouchBucketObservations(blockedSignals: BlockedSignalShadow[]): string[] {
  type BucketStat = {
    n: number;
    wins: number;
    losses: number;
    flats: number;
    sumPnlUsd: number;
    sumPnlPct: number;
  };
  const byEdgeBucket = new Map<string, BucketStat>();
  const byMoneyness = new Map<string, BucketStat>();
  const byAbsEdgeBin = new Map<string, BucketStat>();

  function bumpBucket(map: Map<string, BucketStat>, key: string, pnlUsd: number, pnlPct: number): void {
    const stat = map.get(key) ?? { n: 0, wins: 0, losses: 0, flats: 0, sumPnlUsd: 0, sumPnlPct: 0 };
    stat.n += 1;
    stat.sumPnlUsd += pnlUsd;
    stat.sumPnlPct += pnlPct;
    if (pnlUsd > 0) stat.wins += 1;
    else if (pnlUsd < 0) stat.losses += 1;
    else stat.flats += 1;
    map.set(key, stat);
  }

  function absEdgeBin(absEdge: number): string {
    if (absEdge >= 50) return "abs_edge>=50";
    if (absEdge >= 30) return "abs_edge_30_50";
    if (absEdge >= 20) return "abs_edge_20_30";
    if (absEdge >= 15) return "abs_edge_15_20";
    return "abs_edge<15";
  }

  for (const shadow of blockedSignals) {
    if (shadow.blockedReason !== "one_touch_high_edge_shadow") continue;
    if (shadow.status !== "resolved") continue;
    if (shadow.learningExcluded) continue;
    if (!shadow.hypotheticalResult) continue;
    const snap = shadow.heatmapRowSnapshot;
    if (!snap) continue;
    const row = snap.row ?? {};
    const pnlUsd = shadow.hypotheticalResult.pnl;
    const pnlPct = shadow.hypotheticalResult.pnlPct;
    const edgeBucket = typeof row.edge_bucket === "string" && row.edge_bucket.length > 0 ? row.edge_bucket : null;
    const moneyness = typeof row.moneyness_bucket === "string" && row.moneyness_bucket.length > 0 ? row.moneyness_bucket : null;
    const side = snap.selectedSide ?? "no";
    const edgeKey = side === "no" ? "sell_yes_edge_pts" : "buy_yes_edge_pts";
    const edgeRaw = row[edgeKey];
    const edgeNum = typeof edgeRaw === "string" && edgeRaw.length > 0 ? Number(edgeRaw) : null;

    if (edgeBucket) bumpBucket(byEdgeBucket, edgeBucket, pnlUsd, pnlPct);
    if (moneyness) bumpBucket(byMoneyness, moneyness, pnlUsd, pnlPct);
    if (edgeNum !== null && Number.isFinite(edgeNum)) bumpBucket(byAbsEdgeBin, absEdgeBin(Math.abs(edgeNum)), pnlUsd, pnlPct);
  }

  function emitNotes(label: string, map: Map<string, BucketStat>): string[] {
    const out: string[] = [];
    const entries = Array.from(map.entries()).sort((a, b) => b[1].n - a[1].n);
    for (const [bucket, stat] of entries) {
      if (stat.n < ONE_TOUCH_OBSERVER_MIN_BUCKET_N) continue;
      const decided = stat.wins + stat.losses;
      const winRate = decided > 0 ? stat.wins / decided : 0;
      const avgPnlPct = stat.sumPnlPct / stat.n;
      const flatPart = stat.flats > 0 ? `/${stat.flats}flat` : "";
      const header = `one-touch ${label}="${bucket}" n=${stat.n} (${stat.wins}W/${stat.losses}L${flatPart}, ${(winRate * 100).toFixed(1)}% win-rate, sum $${stat.sumPnlUsd.toFixed(4)}, avg ${avgPnlPct.toFixed(2)}%)`;
      if (decided > 0 && winRate <= ONE_TOUCH_OBSERVER_NEGATIVE_WIN_RATE && stat.sumPnlUsd <= ONE_TOUCH_OBSERVER_NEGATIVE_SUM_USD) {
        out.push(`${header} — calibration weak; consider excluding this slice from the live opening gate or tightening edge requirement.`);
      } else if (decided > 0 && winRate >= ONE_TOUCH_OBSERVER_POSITIVE_WIN_RATE && stat.sumPnlUsd >= ONE_TOUCH_OBSERVER_POSITIVE_SUM_USD) {
        out.push(`${header} — calibration is profitable; this slice is a candidate for live promotion.`);
      }
    }
    return out;
  }

  return [
    ...emitNotes("edge_bucket", byEdgeBucket),
    ...emitNotes("moneyness_bucket", byMoneyness),
    ...emitNotes("abs_edge_bin", byAbsEdgeBin),
  ];
}

function blockedSignalObservations(summary: BlockedSignalLearningSummary): string[] {
  const notes: string[] = [];
  for (const row of summary.bySignal) {
    if (row.resolved < 3) continue;
    if (row.signalType.endsWith("_DOWNSIDE")) {
      // IV divergence missing-leg shadows
      const base = row.signalType.replace("_DOWNSIDE", "");
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`${base} missing downside leg is profitable: ${row.wouldHaveWon}/${row.resolved} below-contract shadows would have won. The engine is leaving money on the table by ignoring the downside contract.`);
      } else if (row.wouldHaveLost >= row.wouldHaveWon + 2) {
        notes.push(`${base} missing downside leg is unprofitable: ${row.wouldHaveLost}/${row.resolved} below-contract shadows would have lost. The current upside-only approach appears correct.`);
      } else {
        notes.push(`${base} missing downside leg is inconclusive (${row.wouldHaveWon}W/${row.wouldHaveLost}L across ${row.resolved} resolved shadows, avg P&L ${row.avgPnlPct.toFixed(2)}%).`);
      }
    } else if (row.signalType.endsWith("_PM_PROXY_SHORT")) {
      const base = row.signalType.replace("_PM_PROXY_SHORT", "");
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`${base} Polymarket proxy short is promising: ${row.wouldHaveWon}/${row.resolved} NO-upside proxy shorts would have won, avg P&L ${row.avgPnlPct.toFixed(2)}%.`);
      } else if (row.wouldHaveLost >= row.wouldHaveWon + 2) {
        notes.push(`${base} Polymarket proxy short is weak: ${row.wouldHaveLost}/${row.resolved} NO-upside proxy shorts would have lost, avg P&L ${row.avgPnlPct.toFixed(2)}%.`);
      } else {
        notes.push(`${base} Polymarket proxy short is inconclusive (${row.wouldHaveWon}W/${row.wouldHaveLost}L across ${row.resolved} resolved shadows, avg P&L ${row.avgPnlPct.toFixed(2)}%).`);
      }
    } else if (row.signalType === "MONOTONIC_ARB") {
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`MONOTONIC_ARB setup category is validating: ${row.wouldHaveWon}/${row.resolved} shadow packages settled profitably, avg P&L ${row.avgPnlPct.toFixed(2)}%. Review fee/slippage assumptions before live promotion.`);
      } else if (row.wouldHaveLost > 0) {
        notes.push(`MONOTONIC_ARB setup category has execution/model breaks: ${row.wouldHaveLost}/${row.resolved} shadow packages lost money despite locked-edge screening, avg P&L ${row.avgPnlPct.toFixed(2)}%.`);
      } else {
        notes.push(`MONOTONIC_ARB setup category is inconclusive (${row.wouldHaveWon}W/${row.wouldHaveLost}L across ${row.resolved} resolved shadow packages, avg P&L ${row.avgPnlPct.toFixed(2)}%).`);
      }
    } else if (row.signalType === STALE_LOTTERY_TICKET_NO_SIGNAL) {
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`STALE_LOTTERY_TICKET_NO shadow is validating: ${row.wouldHaveWon}/${row.resolved} far-OTM NO shadows would have won, avg P&L ${row.avgPnlPct.toFixed(2)}%. The market is repricing stale lottery premium and the shadow is collecting it.`);
      } else if (row.wouldHaveLost >= row.wouldHaveWon + 2) {
        notes.push(`STALE_LOTTERY_TICKET_NO shadow is weak: ${row.wouldHaveLost}/${row.resolved} far-OTM NO shadows would have lost, avg P&L ${row.avgPnlPct.toFixed(2)}%. Either model touch prob is biased low or PM is pricing tails efficiently.`);
      } else {
        notes.push(`STALE_LOTTERY_TICKET_NO shadow is inconclusive (${row.wouldHaveWon}W/${row.wouldHaveLost}L across ${row.resolved} resolved shadows, avg P&L ${row.avgPnlPct.toFixed(2)}%).`);
      }
    } else if (row.signalType === ONE_TOUCH_HIGH_EDGE_SIGNAL_NO || row.signalType === ONE_TOUCH_HIGH_EDGE_SIGNAL_YES) {
      const side = row.signalType === ONE_TOUCH_HIGH_EDGE_SIGNAL_NO ? "NO-only sell-YES-edge" : "YES exploratory";
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`${side} one-touch shadow is validating: ${row.wouldHaveWon}/${row.resolved} shadows won, avg P&L ${row.avgPnlPct.toFixed(2)}%. For new touch-market shadows, keep NO-only, sell_yes_edge_pts >= ${ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS}, spread <= ${(ONE_TOUCH_NO_SHADOW_MAX_SPREAD * 100).toFixed(0)}c, liquidity >= ${ONE_TOUCH_NO_SHADOW_MIN_LIQUIDITY}, and exit when edge disappears.`);
      } else if (row.wouldHaveLost >= row.wouldHaveWon + 2) {
        notes.push(`${side} one-touch shadow is weak: ${row.wouldHaveLost}/${row.resolved} shadows lost, avg P&L ${row.avgPnlPct.toFixed(2)}%. Do not promote YES contracts or sell_yes_edge_pts < ${ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS}; continue bucketing NO edge size before sizing from edge magnitude.`);
      } else {
        notes.push(`${side} one-touch shadow is inconclusive (${row.wouldHaveWon}W/${row.wouldHaveLost}L across ${row.resolved} resolved shadows, avg P&L ${row.avgPnlPct.toFixed(2)}%). Use edge as a gate, not a sizing multiplier, until edge-size buckets have more data.`);
      }
    } else if (row.signalType.startsWith("USER_")) {
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`${row.signalType} manual shadow signal is promising: ${row.wouldHaveWon}/${row.resolved} shadows would have won, avg P&L ${row.avgPnlPct.toFixed(2)}%.`);
      } else if (row.wouldHaveLost >= row.wouldHaveWon + 2) {
        notes.push(`${row.signalType} manual shadow signal is weak: ${row.wouldHaveLost}/${row.resolved} shadows would have lost, avg P&L ${row.avgPnlPct.toFixed(2)}%.`);
      } else {
        notes.push(`${row.signalType} manual shadow signal is inconclusive (${row.wouldHaveWon}W/${row.wouldHaveLost}L across ${row.resolved} resolved shadows, avg P&L ${row.avgPnlPct.toFixed(2)}%).`);
      }
    } else {
      // Trend-blocked shadows
      if (row.wouldHaveWon >= row.wouldHaveLost + 2) {
        notes.push(`${row.signalType} trend filter may be too strict: ${row.wouldHaveWon}/${row.resolved} blocked trades would have won.`);
      } else if (row.wouldHaveLost >= row.wouldHaveWon + 2) {
        notes.push(`${row.signalType} trend filter is avoiding losses: ${row.wouldHaveLost}/${row.resolved} blocked trades would have lost.`);
      }
    }
  }
  return notes;
}

function finalizeSignal(
  signal: Signal,
  rows: SnapshotRow[],
  learningParams: LearningParams,
  blockedContext?: {
    latestRow: SnapshotRow;
    latestSnapshot: InstrumentSnapshotFile | null;
    blockedSignals: BlockedSignalShadow[];
  },
): Signal | null {
  if (isShortSignalBlockedByTrend(signal, rows, learningParams)) {
    if (blockedContext) {
      recordBlockedSignalShadow(
        signal,
        rows,
        learningParams,
        blockedContext.latestRow,
        blockedContext.latestSnapshot,
        blockedContext.blockedSignals,
      );
    }
    return null;
  }

  const next = { ...signal };
  if (next.type === "LLM_HYPOTHESIS") {
    const llmRisk = riskForSignal(learningParams, "LLM_HYPOTHESIS");
    next.targetPct = next.targetPct === null || llmRisk.targetPct === null ? null : Math.max(next.targetPct, llmRisk.targetPct);
    next.stopPct = Math.min(next.stopPct, llmRisk.stopPct);
    next.expiryDays = Math.max(next.expiryDays, learningParams.llmTradeExpiryDays);
  }
  if (isMomentumLongSignal(next, rows, learningParams)) {
    const momentumRisk = riskForSignal(learningParams, "MOMENTUM_LONG");
    next.targetPct = next.targetPct === null || momentumRisk.targetPct === null ? null : Math.max(next.targetPct, momentumRisk.targetPct);
    next.stopPct = Math.min(next.stopPct, momentumRisk.stopPct);
    next.expiryDays = Math.max(next.expiryDays, learningParams.momentumLongExpiryDays);
  }
  return next;
}

function generateSignals(
  rows: SnapshotRow[],
  macroRows: SnapshotRow[],
  weights: SignalWeight[],
  learningParams: LearningParams,
  latestSnapshot: InstrumentSnapshotFile | null,
  blockedSignals: BlockedSignalShadow[],
): Signal[] {
  if (rows.length === 0) return [];
  const latest = rows[rows.length - 1];
  const signals: Signal[] = [];
  const weightMap = new Map(weights
    .filter((w) => w.enabled && LIVE_SIGNAL_ALLOWLIST.has(w.type))
    .map((w) => [w.type, w]));

  const assets = [
    { key: "BTC", pmIv: "btc_pm_iv", optIv30: "btc_opt_iv_30d", optIv90: "btc_opt_iv_90d",
      funding: "btc_hl_funding_ann", pmEv: "btc_pm_ev", spot: "btc_spot",
      pcRatio: "btc_ibit_pc_ratio", hlPerp: "btc_spot" },
    { key: "HYPE", pmIv: "hype_pm_iv", optIv30: null, optIv90: null,
      funding: "hype_hl_funding_ann", pmEv: "hype_pm_ev", spot: "hype_spot",
      pcRatio: null, hlPerp: "hype_spot" },
    { key: "GOLD", pmIv: "gold_pm_iv", optIv30: "gold_opt_iv_30d", optIv90: "gold_opt_iv_90d",
      funding: "gold_hl_funding_ann", pmEv: null, spot: "gold_gc_spot",
      pcRatio: "gold_gld_pc_ratio", hlPerp: "gold_gc_spot" },
    { key: "AMZN", pmIv: null, optIv30: "amzn_opt_iv_30d", optIv90: "amzn_opt_iv_90d",
      funding: "amzn_hl_funding_ann", pmEv: null, spot: "amzn_stock",
      pcRatio: "amzn_pc_ratio", hlPerp: "amzn_hl_perp" },
    { key: "OIL", pmIv: "oil_pm_iv", optIv30: "oil_opt_iv_30d", optIv90: "oil_opt_iv_90d",
      funding: "oil_hl_funding_ann", pmEv: null, spot: "oil_wti_spot",
      pcRatio: "oil_cl_pc_ratio", hlPerp: "oil_wti_spot" },
  ];

  for (const a of assets) {
    const spot = num(latest[a.spot]);
    if (!spot) continue;

    const pmIv = a.pmIv ? num(latest[a.pmIv]) : null;
    const optIv = a.optIv30 ? num(latest[a.optIv30]) : null;
    if (pmIv && optIv && optIv > 0) {
      const ratio = pmIv / optIv;
      const pmIvGtWeight = weightForSignalAsset(weightMap, "PM_IV_GT_OPT_IV", a.key);
      if (ratio > 1.3 && pmIvGtWeight) {
        const strength = Math.min(1, (ratio - 1.3) / 0.7);
        const w = pmIvGtWeight;
        const risk = riskForSignal(learningParams, "PM_IV_GT_OPT_IV");
        const rawSignalPmGt: Signal = {
          type: "PM_IV_GT_OPT_IV", asset: a.key, venue: "polymarket", direction: "short",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} PM IV (${pmIv.toFixed(1)}%) >> Options IV (${optIv.toFixed(1)}%), ratio ${ratio.toFixed(2)}. PM overpricing vol → sell PM upside.`,
          hypothesisId: null, entryPrice: spot, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 7,
          contractHint: { preferredDirection: "above" },
        };
        const signal = finalizeSignal(rawSignalPmGt, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) {
          signals.push(signal);
          recordIVDownsideLegShadow(signal, latest, latestSnapshot, learningParams, blockedSignals);
        }
      }
      const optIvGtWeight = weightForSignalAsset(weightMap, "OPT_IV_GT_PM_IV", a.key);
      if (ratio < 0.7 && optIvGtWeight) {
        const strength = Math.min(1, (0.7 - ratio) / 0.3);
        const w = optIvGtWeight;
        const risk = riskForSignal(learningParams, "OPT_IV_GT_PM_IV");
        const rawSignalOptGt: Signal = {
          type: "OPT_IV_GT_PM_IV", asset: a.key, venue: "polymarket", direction: "long",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} Options IV (${optIv.toFixed(1)}%) >> PM IV (${pmIv.toFixed(1)}%), ratio ${ratio.toFixed(2)}. PM underpricing vol → buy PM upside.`,
          hypothesisId: null, entryPrice: spot, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 7,
          contractHint: { preferredDirection: "above" },
        };
        const signal = finalizeSignal(rawSignalOptGt, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) {
          signals.push(signal);
          recordIVDownsideLegShadow(signal, latest, latestSnapshot, learningParams, blockedSignals);
        }
      }
    }

    const funding = a.funding ? num(latest[a.funding]) : null;
    if (funding !== null) {
      const fundingLongWeight = weightForSignalAsset(weightMap, "FUNDING_EXTREME_LONG", a.key);
      if (funding > 15 && fundingLongWeight && fundingSetupAllowed("FUNDING_EXTREME_LONG", a.key, "short", rows, latestSnapshot)) {
        const strength = Math.min(1, (funding - 15) / 35);
        const w = fundingLongWeight;
        const risk = riskForSignal(learningParams, "FUNDING_EXTREME_LONG");
        const perpEntry = getHyperliquidPerpPrice(latest, a.key) ?? spot;
        const signal = finalizeSignal({
          type: "FUNDING_EXTREME_LONG", asset: a.key, venue: "hyperliquid", direction: "short",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} HL funding ${funding.toFixed(1)}% annualized — crowded longs. Fade. (Entry trigger: funding > +15%; consider thesis-invalidated only when funding has been inside ±15% for ≥2 consecutive hourly snapshots OR has flipped sign.)`,
          hypothesisId: null, entryPrice: perpEntry, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 3, leverage: 1,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
      const fundingShortWeight = weightForSignalAsset(weightMap, "FUNDING_EXTREME_SHORT", a.key);
      if (funding < -15 && fundingShortWeight && fundingSetupAllowed("FUNDING_EXTREME_SHORT", a.key, "long", rows, latestSnapshot)) {
        const strength = Math.min(1, (-funding - 15) / 35);
        const w = fundingShortWeight;
        const risk = riskForSignal(learningParams, "FUNDING_EXTREME_SHORT");
        const perpEntry = getHyperliquidPerpPrice(latest, a.key) ?? spot;
        const signal = finalizeSignal({
          type: "FUNDING_EXTREME_SHORT", asset: a.key, venue: "hyperliquid", direction: "long",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} HL funding ${funding.toFixed(1)}% annualized — crowded shorts. Buy. (Entry trigger: funding < -15%; consider thesis-invalidated only when funding has been inside ±15% for ≥2 consecutive hourly snapshots OR has flipped sign.)`,
          hypothesisId: null, entryPrice: perpEntry, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 7, leverage: 1,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
    }

    const pmEv = a.pmEv ? num(latest[a.pmEv]) : null;
    if (pmEv && spot) {
      const divergencePct = ((pmEv - spot) / spot) * 100;
      const pmEvAboveWeight = weightForSignalAsset(weightMap, "PM_EV_ABOVE_SPOT", a.key);
      if (divergencePct > 8 && pmEvAboveWeight) {
        const strength = Math.min(1, (divergencePct - 8) / 20);
        const w = pmEvAboveWeight;
        const risk = riskForSignal(learningParams, "PM_EV_ABOVE_SPOT");
        const signal = finalizeSignal({
          type: "PM_EV_ABOVE_SPOT", asset: a.key, venue: "spot", direction: "long",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} PM EV ($${pmEv.toFixed(0)}) is ${divergencePct.toFixed(1)}% above spot ($${spot.toFixed(0)}). Market expects upside.`,
          hypothesisId: null, entryPrice: spot, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 14,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
      const pmEvBelowWeight = weightForSignalAsset(weightMap, "PM_EV_BELOW_SPOT", a.key);
      if (divergencePct < -5 && pmEvBelowWeight) {
        const strength = Math.min(1, (-divergencePct - 5) / 15);
        const w = pmEvBelowWeight;
        const risk = riskForSignal(learningParams, "PM_EV_BELOW_SPOT");
        const signal = finalizeSignal({
          type: "PM_EV_BELOW_SPOT", asset: a.key, venue: "spot", direction: "short",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} PM EV ($${pmEv.toFixed(0)}) is ${divergencePct.toFixed(1)}% below spot ($${spot.toFixed(0)}). Market expects downside.`,
          hypothesisId: null, entryPrice: spot, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 14,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
    }

    const pcRatio = a.pcRatio ? num(latest[a.pcRatio]) : null;
    if (pcRatio !== null && pcRatio > 0) {
      const pcHighWeight = weightForSignalAsset(weightMap, "PC_RATIO_EXTREME_HIGH", a.key);
      if (pcRatio > 1.2 && pcHighWeight) {
        const strength = Math.min(1, (pcRatio - 1.2) / 0.8);
        const w = pcHighWeight;
        const risk = riskForSignal(learningParams, "PC_RATIO_EXTREME_HIGH");
        const signal = finalizeSignal({
          type: "PC_RATIO_EXTREME_HIGH", asset: a.key, venue: "spot", direction: "long",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} P/C ratio ${pcRatio.toFixed(2)} — heavy put buying → contrarian long.`,
          hypothesisId: null, entryPrice: spot, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 5,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
      const pcLowWeight = weightForSignalAsset(weightMap, "PC_RATIO_EXTREME_LOW", a.key);
      if (a.key !== "AMZN" && pcRatio < 0.5 && pcLowWeight) {
        const strength = Math.min(1, (0.5 - pcRatio) / 0.3);
        const w = pcLowWeight;
        const risk = riskForSignal(learningParams, "PC_RATIO_EXTREME_LOW");
        const signal = finalizeSignal({
          type: "PC_RATIO_EXTREME_LOW", asset: a.key, venue: "spot", direction: "short",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} P/C ratio ${pcRatio.toFixed(2)} — heavy call buying → contrarian short.`,
          hypothesisId: null, entryPrice: spot, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 5,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
    }

    const hlPerp = a.hlPerp ? num(latest[a.hlPerp]) : null;
    const stockSpot = a.spot === a.hlPerp ? null : num(latest[a.spot]);
    if (hlPerp && stockSpot && a.key === "AMZN") {
      const basisPct = ((hlPerp - stockSpot) / stockSpot) * 100;
      const basisPremiumWeight = weightForSignalAsset(weightMap, "BASIS_PREMIUM", a.key);
      if (basisPct > 1.5 && basisPremiumWeight) {
        const strength = Math.min(1, (basisPct - 1.5) / 3);
        const w = basisPremiumWeight;
        const risk = riskForSignal(learningParams, "BASIS_PREMIUM");
        const signal = finalizeSignal({
          type: "BASIS_PREMIUM", asset: a.key, venue: "hyperliquid", direction: "short",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} HL perp ($${hlPerp.toFixed(2)}) at ${basisPct.toFixed(1)}% premium to stock ($${stockSpot.toFixed(2)}). Basis convergence → short perp.`,
          hypothesisId: null, entryPrice: hlPerp, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 5, leverage: 1,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
      const basisDiscountWeight = weightForSignalAsset(weightMap, "BASIS_DISCOUNT", a.key);
      if (basisPct < -1.5 && basisDiscountWeight) {
        const strength = Math.min(1, (-basisPct - 1.5) / 3);
        const w = basisDiscountWeight;
        const risk = riskForSignal(learningParams, "BASIS_DISCOUNT");
        const signal = finalizeSignal({
          type: "BASIS_DISCOUNT", asset: a.key, venue: "hyperliquid", direction: "long",
          strength, confidence: strength * w.weight,
          thesis: `${a.key} HL perp ($${hlPerp.toFixed(2)}) at ${basisPct.toFixed(1)}% discount to stock ($${stockSpot.toFixed(2)}). Basis convergence → long perp.`,
          hypothesisId: null, entryPrice: hlPerp, targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 5, leverage: 1,
        }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
        if (signal) signals.push(signal);
      }
    }
  }

  const macroShift = macroCompositeShiftPts(macroRows, LOOKBACK_HOURS);
  if (macroShift) {
    const threshold = learningParams.macroMomentum24hThresholdPts;
    const macroUpWeight = weightForSignalAsset(weightMap, "MACRO_MOMENTUM_UP", "BTC");
    if (macroShift.shift > threshold && macroUpWeight) {
      const strength = Math.min(1, (macroShift.shift - threshold) / 12);
      const w = macroUpWeight;
      const risk = riskForSignal(learningParams, "MACRO_MOMENTUM_UP");
      const signal = finalizeSignal({
        type: "MACRO_MOMENTUM_UP", asset: "BTC", venue: "spot", direction: "long",
        strength, confidence: strength * w.weight,
        thesis: `Macro composite rose +${macroShift.shift.toFixed(1)} pts over ${LOOKBACK_HOURS}h (${macroShift.previous.toFixed(1)}→${macroShift.current.toFixed(1)}). Risk-on momentum → long BTC.`,
        hypothesisId: null, entryPrice: num(rows[rows.length - 1].btc_spot) ?? 0,
        targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 7,
      }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
      if (signal) signals.push(signal);
    }
    const macroDownWeight = weightForSignalAsset(weightMap, "MACRO_MOMENTUM_DOWN", "BTC");
    const btcTrendForMacroDown = assetTrendMetrics(rows, "BTC", LOOKBACK_HOURS);
    const macroDownConfirmed = macroShift.current < 45
      && !!btcTrendForMacroDown
      && btcTrendForMacroDown.momentumPct < 0
      && btcTrendForMacroDown.aboveTrendPct < 0;
    if (macroShift.shift < -threshold && macroDownWeight && macroDownConfirmed) {
      const strength = Math.min(1, (-macroShift.shift - threshold) / 12);
      const w = macroDownWeight;
      const risk = riskForSignal(learningParams, "MACRO_MOMENTUM_DOWN");
      const signal = finalizeSignal({
        type: "MACRO_MOMENTUM_DOWN", asset: "BTC", venue: "spot", direction: "short",
        strength, confidence: strength * w.weight,
        thesis: `Macro composite fell ${macroShift.shift.toFixed(1)} pts over ${LOOKBACK_HOURS}h (${macroShift.previous.toFixed(1)}→${macroShift.current.toFixed(1)}) into bearish territory with BTC below trend (${btcTrendForMacroDown!.aboveTrendPct.toFixed(1)}%) and negative momentum (${btcTrendForMacroDown!.momentumPct.toFixed(1)}%). Risk-off confirmation → short BTC.`,
        hypothesisId: null, entryPrice: num(rows[rows.length - 1].btc_spot) ?? 0,
        targetPct: risk.targetPct, stopPct: risk.stopPct, expiryDays: 7,
      }, rows, learningParams, { latestRow: latest, latestSnapshot, blockedSignals });
      if (signal) signals.push(signal);
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

// ─── Statistical Scanner ─────────────────────────────────────────────────────

function statisticalScan(rows: SnapshotRow[], macroRows: SnapshotRow[]): StatObservation[] {
  const obs: StatObservation[] = [];
  if (rows.length < 3) return obs;

  const numericCols = Object.keys(rows[0]).filter((k) => k !== "date" && typeof rows[0][k] === "number");
  const latest = rows[rows.length - 1];

  const sampleRowsForColumn = (col: string) => {
    if (!col.startsWith("oil_")) return rows;
    return rows.filter((r) => String(r.date ?? "") >= OIL_CRUDE_HISTORY_START);
  };

  // Z-score anomalies (need at least 5 data points)
  if (rows.length >= 5) {
    for (const col of numericCols) {
      const sampleRows = sampleRowsForColumn(col);
      const vals = sampleRows
        .map((r) => num(r[col]))
        .filter((v): v is number => v !== null && !(col.endsWith("_pc_ratio") && v <= 0));
      if (vals.length < 5) continue;
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
      if (std === 0) continue;
      const latestVal = num(latest[col]);
      if (latestVal === null) continue;
      if (col.endsWith("_pc_ratio") && latestVal <= 0) continue;
      const z = (latestVal - mean) / std;
      if (Math.abs(z) > 2) {
        const scope = col.startsWith("oil_") ? ` since ${OIL_CRUDE_HISTORY_START}` : "";
        obs.push({
          type: "anomaly",
          description: `${col} = ${latestVal} is ${z.toFixed(1)} std devs from mean${scope} (${mean.toFixed(2)} ± ${std.toFixed(2)})`,
          assets: [col.split("_")[0].toUpperCase()],
          magnitude: Math.abs(z),
          data: { value: latestVal, mean, std, z },
        });
      }
    }
  }

  // Day-over-day divergences
  if (rows.length >= 2) {
    const prev = rows[rows.length - 2];
    const pairs = [
      ["btc_pm_iv", "btc_opt_iv_30d", "BTC"],
      ["gold_pm_iv", "gold_opt_iv_30d", "GOLD"],
      ["oil_pm_iv", "oil_opt_iv_30d", "OIL"],
    ];
    for (const [a, b, asset] of pairs) {
      const nowA = num(latest[a]), nowB = num(latest[b]);
      const prevA = num(prev[a]), prevB = num(prev[b]);
      if (nowA && nowB && prevA && prevB) {
        const gapNow = nowA - nowB;
        const gapPrev = prevA - prevB;
        const gapChange = gapNow - gapPrev;
        if (Math.abs(gapChange) > 5) {
          obs.push({
            type: "divergence",
            description: `${asset} PM-Options IV gap moved ${gapChange > 0 ? "wider" : "narrower"} by ${Math.abs(gapChange).toFixed(1)}pp (was ${gapPrev.toFixed(1)}, now ${gapNow.toFixed(1)})`,
            assets: [asset],
            magnitude: Math.abs(gapChange),
            data: { gapNow, gapPrev, gapChange },
          });
        }
      }
    }
  }

  // Correlation changes (need 7+ rows)
  if (rows.length >= 7) {
    const corrPairs = [
      ["btc_spot", "gold_gc_spot", "BTC", "GOLD"],
      ["btc_spot", "oil_wti_spot", "BTC", "OIL"],
      ["gold_gc_spot", "oil_wti_spot", "GOLD", "OIL"],
      ["btc_hl_funding_ann", "hype_hl_funding_ann", "BTC", "HYPE"],
    ];
    const halfLen = Math.floor(rows.length / 2);
    for (const [colA, colB, assetA, assetB] of corrPairs) {
      const recentA = rows.slice(-halfLen).map((r) => num(r[colA])).filter((v): v is number => v !== null);
      const recentB = rows.slice(-halfLen).map((r) => num(r[colB])).filter((v): v is number => v !== null);
      const olderA = rows.slice(0, halfLen).map((r) => num(r[colA])).filter((v): v is number => v !== null);
      const olderB = rows.slice(0, halfLen).map((r) => num(r[colB])).filter((v): v is number => v !== null);
      const len = Math.min(recentA.length, recentB.length, olderA.length, olderB.length);
      if (len < 3) continue;
      const corrRecent = pearson(recentA.slice(0, len), recentB.slice(0, len));
      const corrOlder = pearson(olderA.slice(0, len), olderB.slice(0, len));
      if (Math.abs(corrRecent - corrOlder) > 0.4) {
        const rolling24h = rollingPairwiseCorrelation(rows, colA, colB, 24);
        const rolling7d = rollingPairwiseCorrelation(rows, colA, colB, 168);
        const rolling30d = rollingPairwiseCorrelation(rows, colA, colB, 720);
        const ctxParts: string[] = [];
        if (rolling24h !== null) ctxParts.push(`24h=${rolling24h.toFixed(2)}`);
        if (rolling7d !== null) ctxParts.push(`7d=${rolling7d.toFixed(2)}`);
        if (rolling30d !== null) ctxParts.push(`30d=${rolling30d.toFixed(2)}`);
        const rollingSuffix = ctxParts.length > 0 ? ` Rolling correlation: ${ctxParts.join(", ")}.` : "";

        const dist = dailyCorrelationDistribution(rows, colA, colB, 720, 24);
        let percentileSuffix = "";
        if (dist.length >= 7 && rolling24h !== null) {
          const pct = percentileRank(dist, rolling24h);
          if (pct !== null) {
            const lo = Math.min(...dist);
            const hi = Math.max(...dist);
            percentileSuffix = ` Current 24h corr is at ${pct.toFixed(0)}th pct of last ${dist.length} daily 24h-rolling values (range ${lo.toFixed(2)} to ${hi.toFixed(2)}).`;
          }
        }

        const dataRollups: Record<string, number> = { corrRecent, corrOlder };
        if (rolling24h !== null) dataRollups.rolling24h = rolling24h;
        if (rolling7d !== null) dataRollups.rolling7d = rolling7d;
        if (rolling30d !== null) dataRollups.rolling30d = rolling30d;
        if (dist.length > 0) {
          dataRollups.distributionCount = dist.length;
          dataRollups.distributionMin = Math.min(...dist);
          dataRollups.distributionMax = Math.max(...dist);
        }
        obs.push({
          type: "correlation_flip",
          description: `${assetA}-${assetB} correlation shifted from ${corrOlder.toFixed(2)} to ${corrRecent.toFixed(2)}.${rollingSuffix}${percentileSuffix}`,
          assets: [assetA, assetB],
          magnitude: Math.abs(corrRecent - corrOlder),
          data: dataRollups,
        });
      }
    }
  }

  return obs.sort((a, b) => b.magnitude - a.magnitude);
}

function sanitizeValuationsForLlm(rows: SnapshotRow[]): SnapshotRow[] {
  const unreliablePcRatioColumns = new Set(["gold_gld_pc_ratio", "oil_cl_pc_ratio"]);
  return rows.map((row) => {
    const sanitized = { ...row };
    for (const col of unreliablePcRatioColumns) {
      const value = num(sanitized[col]);
      if (value !== null && value <= 0) (sanitized as Record<string, string | number | null>)[col] = null;
    }
    return sanitized;
  });
}

// ─── Hyperliquid hybrid bot context ──────────────────────────────────────────
//
// The hyperliquid-crv-rebalancer multi-coin hybrid bot runs as its own systemd
// service on the same VPS. Every real (non-dry-run) open/close it makes is
// appended to a JSONL feed. We expose the recent tail + currently-open
// positions + bot's persisted regime so the polymarket-trader LLM can reason
// about what real capital is doing on Hyperliquid alts. See
// docs/hybrid-strategy-context.md for the strategy explanation that is also
// injected into the LLM prompt.
//
// The LLM does NOT trade these markets; this is read-only situational context.

type HybridShadowTrade = {
  ts: string;
  coin: string;
  action: "open" | "close";
  side: "long" | "short";
  price?: number;
  entry_price?: number | null;
  exit_price?: number;
  size_usd?: number;
  pnl_pct?: number;
  regime?: "bull" | "bear";
  reason?: string;
  ema_diff_pct?: number;
};

type HybridBotContext = {
  available: boolean;
  recentTrades: HybridShadowTrade[];
  openPositions: Array<{
    coin: string;
    side: "long" | "short";
    entry_price: number;
    entry_time: string;
    mode: string;
  }>;
  totals: { trades: number; wins: number; winRatePct: number | null };
  lastEventTs: string | null;
};

function loadHybridBotContext(limit = HYBRID_BOT_RECENT_TRADE_LIMIT): HybridBotContext {
  const ctx: HybridBotContext = {
    available: false,
    recentTrades: [],
    openPositions: [],
    totals: { trades: 0, wins: 0, winRatePct: null },
    lastEventTs: null,
  };

  if (existsSync(HYBRID_BOT_TRADES_FILE)) {
    try {
      const raw = readFileSync(HYBRID_BOT_TRADES_FILE, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const tail = lines.slice(-limit);
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line) as HybridShadowTrade;
          ctx.recentTrades.push(parsed);
        } catch {
          // Skip malformed lines silently; the bot writes JSON per line.
        }
      }
      ctx.available = true;
      if (ctx.recentTrades.length > 0) {
        ctx.lastEventTs = ctx.recentTrades[ctx.recentTrades.length - 1].ts ?? null;
      }
    } catch (err) {
      console.log(`  [hybrid-bot] failed to read trade feed: ${(err as Error).message}`);
    }
  }

  if (existsSync(HYBRID_BOT_STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(HYBRID_BOT_STATE_FILE, "utf8"));
      ctx.available = true;
      const positions = state.positions ?? {};
      for (const [coin, p] of Object.entries(positions) as Array<[string, any]>) {
        if (p && p.in_position) {
          ctx.openPositions.push({
            coin,
            side: p.is_long ? "long" : "short",
            entry_price: Number(p.entry_price),
            entry_time: String(p.entry_time ?? ""),
            mode: String(p.mode ?? ""),
          });
        }
      }
      const totalTrades = Number(state.total_trades ?? 0);
      const totalWins = Number(state.total_wins ?? 0);
      ctx.totals = {
        trades: totalTrades,
        wins: totalWins,
        winRatePct: totalTrades > 0 ? (totalWins / totalTrades) * 100 : null,
      };
    } catch (err) {
      console.log(`  [hybrid-bot] failed to read state file: ${(err as Error).message}`);
    }
  }

  return ctx;
}

function loadHybridStrategyDoc(): string {
  if (!existsSync(HYBRID_STRATEGY_DOC)) return "";
  try {
    return readFileSync(HYBRID_STRATEGY_DOC, "utf8");
  } catch {
    return "";
  }
}

function formatHybridBotSection(ctx: HybridBotContext): string {
  if (!ctx.available) {
    return "  (no hybrid-bot data on this host)";
  }
  const lines: string[] = [];
  lines.push(`  totals: ${ctx.totals.trades} trades, ${ctx.totals.wins} wins`
    + (ctx.totals.winRatePct !== null ? ` (${ctx.totals.winRatePct.toFixed(0)}% WR)` : "")
    + (ctx.lastEventTs ? ` | last event: ${ctx.lastEventTs}` : ""));
  if (ctx.openPositions.length === 0) {
    lines.push("  open positions: none");
  } else {
    lines.push(`  open positions (${ctx.openPositions.length}):`);
    for (const p of ctx.openPositions) {
      lines.push(`    - ${p.coin} ${p.side.toUpperCase()} @ ${p.entry_price} (entered ${p.entry_time}, mode=${p.mode})`);
    }
  }
  if (ctx.recentTrades.length === 0) {
    lines.push("  recent trade events: none");
  } else {
    lines.push(`  recent trade events (last ${ctx.recentTrades.length}, newest last):`);
    for (const t of ctx.recentTrades) {
      if (t.action === "open") {
        lines.push(`    ${t.ts} OPEN  ${t.coin} ${t.side} @ ${t.price ?? "?"} regime=${t.regime ?? "?"} reason=${t.reason ?? "?"}`);
      } else {
        const pnl = typeof t.pnl_pct === "number" ? `${t.pnl_pct >= 0 ? "+" : ""}${t.pnl_pct.toFixed(2)}%` : "?";
        lines.push(`    ${t.ts} CLOSE ${t.coin} ${t.side} entry=${t.entry_price ?? "?"} exit=${t.exit_price ?? "?"} pnl=${pnl} regime=${t.regime ?? "?"}`);
      }
    }
  }
  return lines.join("\n");
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

// Pairwise correlation over the trailing `lookbackHours` rows, requiring at
// least half the window to have non-null observations for both columns.
function rollingPairwiseCorrelation(
  rows: SnapshotRow[],
  colA: string,
  colB: string,
  lookbackHours: number,
): number | null {
  if (rows.length < Math.min(lookbackHours, 6)) return null;
  const slice = rows.slice(-lookbackHours);
  const a: number[] = [];
  const b: number[] = [];
  for (const r of slice) {
    const va = num(r[colA]);
    const vb = num(r[colB]);
    if (va !== null && vb !== null) {
      a.push(va);
      b.push(vb);
    }
  }
  const minPoints = Math.min(Math.floor(lookbackHours / 2), 12);
  if (a.length < Math.max(3, minPoints)) return null;
  return pearson(a, b);
}

// Distribution of daily-stepped rolling-window correlations across the full
// historical window. Used to surface "is the current correlation a regime
// extreme or a routine fluctuation?" by computing a percentile rank for the
// current 24h correlation against the empirical 30d daily distribution.
function dailyCorrelationDistribution(
  rows: SnapshotRow[],
  colA: string,
  colB: string,
  totalHours: number,
  windowHours: number,
): number[] {
  if (rows.length < windowHours + 24) return [];
  const slice = rows.slice(-Math.min(rows.length, totalHours));
  const values: number[] = [];
  for (let end = slice.length; end >= windowHours; end -= 24) {
    const window = slice.slice(end - windowHours, end);
    const a: number[] = [];
    const b: number[] = [];
    for (const r of window) {
      const va = num(r[colA]);
      const vb = num(r[colB]);
      if (va !== null && vb !== null) {
        a.push(va);
        b.push(vb);
      }
    }
    const minPoints = Math.min(Math.floor(windowHours / 2), 12);
    if (a.length < Math.max(3, minPoints)) continue;
    values.push(pearson(a, b));
  }
  return values;
}

// ─── Position Management ─────────────────────────────────────────────────────

function markToMarket(
  portfolio: Portfolio,
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
  valRows: SnapshotRow[] = [],
): ClosedTrade[] {
  const closed: ClosedTrade[] = [];
  const now = new Date().toISOString();
  const remaining: Position[] = [];

  for (const pos of portfolio.positions) {
    const expiredPackage = pos.instrumentType === "pm_package" && new Date(pos.expiryDate) <= new Date();
    let mark = markPosition(pos, latestRow, snapshots);
    // Expired monotonic-arb packages must settle from realized underlying
    // highs/lows, not live PM bid/ask (which is stale or gone post-resolution).
    // This also rescues packages whose contracts have aged out of the live
    // snapshot (markPosition returns null) so they don't get stuck open.
    if (expiredPackage) {
      const settled = settleMonotonicArbPackage(pos, valRows);
      if (settled) {
        mark = { currentPrice: settled.price, underlyingPrice: settled.underlyingPrice, marketPnl: settled.marketPnl, fundingPnl: 0, pnl: settled.pnl, pnlPct: settled.pnlPct };
      }
    }
    if (!mark) { remaining.push(pos); continue; }
    updatePeakPnl(pos, mark);

    let closeReason: ClosedTrade["closeReason"] | null = null;
    if (weekendHyperliquidFundingExitHit(pos, snapshots)) closeReason = !isStockPerpFundingWindowOpen()
      ? "expiry"
      : mark.pnl >= 0 ? "thesis_validated_profitable" : "thesis_compressed_loss";
    else if (pos.targetPct !== null && mark.pnlPct >= pos.targetPct) closeReason = "target";
    else if (fundingBreakevenStopHit(pos, mark)) closeReason = "breakeven_stop";
    else if (mark.pnlPct <= -pos.stopPct) closeReason = "stop";
    else if (new Date(pos.expiryDate) <= new Date()) closeReason = "expiry";

    if (closeReason) {
      const trade = realizeClosedPosition(portfolio, pos, mark, closeReason, now);
      closed.push(trade);
    } else {
      pos.currentPrice = mark.currentPrice;
      pos.currentUnderlyingPrice = mark.underlyingPrice ?? undefined;
      pos.fundingPnlAccrued = mark.fundingPnl;
      remaining.push(pos);
    }
  }

  portfolio.positions = remaining;
  return closed;
}

function buildPositionFromSignal(
  signal: Signal,
  latestRow: SnapshotRow,
  latestSnapshot: InstrumentSnapshotFile | null,
): Position | null {
  const riskAdjustedSignal = applySpotRiskToSignal(signal);
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + riskAdjustedSignal.expiryDays);
  const underlyingPrice = getAssetPrice(latestRow, riskAdjustedSignal.asset) ?? riskAdjustedSignal.entryPrice;

  const base: Position = {
    id: `T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    openedAt: new Date().toISOString(),
    asset: riskAdjustedSignal.asset,
    venue: riskAdjustedSignal.venue,
    direction: riskAdjustedSignal.direction,
    entryPrice: riskAdjustedSignal.entryPrice,
    currentPrice: riskAdjustedSignal.entryPrice,
    currentUnderlyingPrice: underlyingPrice,
    entryUnderlyingPrice: underlyingPrice,
    size: TRADE_SIZE,
    leverage: riskAdjustedSignal.leverage ?? 1,
    signalType: riskAdjustedSignal.type,
    hypothesisId: riskAdjustedSignal.hypothesisId,
    thesis: riskAdjustedSignal.thesis,
    targetPct: riskAdjustedSignal.targetPct,
    stopPct: riskAdjustedSignal.stopPct,
    expiryDate: expiry.toISOString(),
  };

  if (riskAdjustedSignal.venue === "spot") {
    return { ...base, instrumentType: "spot", instrumentLabel: `${riskAdjustedSignal.asset} spot` };
  }

  if (riskAdjustedSignal.venue === "hyperliquid") {
    const perpPrice = getHyperliquidPerpPrice(latestRow, riskAdjustedSignal.asset);
    if (!perpPrice) return null;
    return {
      ...base,
      entryPrice: perpPrice,
      currentPrice: perpPrice,
      instrumentType: "hl_perp",
      instrumentId: riskAdjustedSignal.asset,
      instrumentLabel: `HL ${riskAdjustedSignal.asset} perp`,
      fundingPnlAccrued: 0,
    };
  }

  if (riskAdjustedSignal.venue === "polymarket") {
    if (!latestSnapshot) return null;
    const selected = selectPolymarketContract(
      latestSnapshot,
      riskAdjustedSignal.asset,
      underlyingPrice,
      riskAdjustedSignal.direction,
      riskAdjustedSignal.contractHint ?? { preferredDirection: inferPolymarketPreferredDirection(riskAdjustedSignal.direction, riskAdjustedSignal.type, riskAdjustedSignal.thesis) },
    );
    if (!selected) return null;
    const instrumentLabel = `${selected.event.slug} — ${selected.instrumentType === "pm_yes" ? "YES" : "NO"} — ${selected.contract.question}`;
    const longDatedCandidate = {
      ...base,
      venue: "polymarket" as const,
      instrumentId: `${selected.event.slug}::${selected.contract.marketId}`,
      instrumentLabel,
    };
    return {
      ...base,
      entryPrice: selected.entryPrice,
      currentPrice: selected.entryPrice,
      expiryDate: isLongDatedPolymarketPosition(longDatedCandidate)
        ? longDatedPolymarketExpiry(base.openedAt)
        : base.expiryDate,
      instrumentType: selected.instrumentType,
      instrumentId: longDatedCandidate.instrumentId,
      instrumentLabel,
    };
  }

  return { ...base, instrumentType: "legacy_asset" };
}

async function openPositions(
  portfolio: Portfolio,
  signals: Signal[],
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
): Promise<Position[]> {
  const opened: Position[] = [];
  const latestSnapshot = latestInstrumentSnapshot(snapshots);
  for (const sig of signals) {
    if (portfolio.positions.length >= MAX_OPEN_POSITIONS) break;
    if (portfolio.cash < TRADE_SIZE) break;
    if (sig.confidence < 0.15) break;

    // Don't double up on same asset+direction
    const dup = portfolio.positions.find((p) => p.asset === sig.asset && p.direction === sig.direction);
    if (dup) continue;

    const pos = buildPositionFromSignal(sig, latestRow, latestSnapshot);
    if (!pos) continue;
    applyProductionPolymarketRisk(pos);
    if (pos.venue === "polymarket") {
      await attachPolymarketEntryBook(pos);
    }

    portfolio.cash -= TRADE_SIZE;
    portfolio.positions.push(pos);
    opened.push(pos);
    recordPolymarketProxyShortShadow(pos, latestRow, latestSnapshot, learningParams, blockedSignals);
  }
  return opened;
}

function applyFundingRiskShapeToOpenPositions(portfolio: Portfolio, learningParams: LearningParams): string[] {
  const notes: string[] = [];
  for (const position of portfolio.positions) {
    if (!isFundingSignal(position.signalType)) continue;
    const risk = riskForSignal(learningParams, position.signalType);
    if (position.targetPct !== risk.targetPct || position.stopPct !== risk.stopPct) {
      notes.push(`${position.asset} ${position.signalType}: ${formatTargetPct(position.targetPct)}/-${position.stopPct} -> ${formatTargetPct(risk.targetPct)}/-${risk.stopPct}`);
      position.targetPct = risk.targetPct;
      position.stopPct = risk.stopPct;
    }
  }
  return notes;
}

// ─── Weight Updates ──────────────────────────────────────────────────────────

function updateWeights(weights: SignalWeight[], closedTrades: ClosedTrade[]): string[] {
  const observations: string[] = [];

  for (const trade of closedTrades) {
    const w = weights.find((w) => w.type === trade.signalType);
    if (!w) continue;

    const isWin = trade.pnl >= 0;
    w.trades++;
    if (isWin) w.wins++;
    w.avgPnlPct = ((w.avgPnlPct * (w.trades - 1)) + trade.pnlPct) / w.trades;
    w.lastTriggered = trade.closedAt;

    // Per-asset tracking
    if (!w.perAsset[trade.asset]) w.perAsset[trade.asset] = { trades: 0, wins: 0, avgPnlPct: 0 };
    const pa = w.perAsset[trade.asset];
    pa.trades++;
    if (isWin) pa.wins++;
    pa.avgPnlPct = ((pa.avgPnlPct * (pa.trades - 1)) + trade.pnlPct) / pa.trades;

    // Adaptive weight update
    const recentAccuracy = w.trades > 0 ? w.wins / w.trades : 0.5;
    w.weight = w.weight * WEIGHT_DECAY + recentAccuracy * (1 - WEIGHT_DECAY);
    w.weight = Math.max(0.05, Math.min(0.95, w.weight));

    // Demotion check
    if (w.trades >= 10 && recentAccuracy < DEMOTE_THRESHOLD && w.enabled) {
      observations.push(`⚠ ${w.type} accuracy dropped to ${(recentAccuracy * 100).toFixed(0)}% over ${w.trades} trades. Weight reduced to ${w.weight.toFixed(2)}.`);
    }
    if (w.trades >= 10 && recentAccuracy < KILL_THRESHOLD) {
      w.enabled = false;
      observations.push(`🛑 ${w.type} DISABLED — accuracy ${(recentAccuracy * 100).toFixed(0)}% over ${w.trades} trades is below kill threshold.`);
    }

    // Per-asset kill switch. This keeps a broken asset/signal pair from
    // suppressing useful behavior on other assets.
    const perAssetAccuracy = pa.trades > 0 ? pa.wins / pa.trades : 0.5;
    if (pa.trades >= 5 && perAssetAccuracy < KILL_THRESHOLD && !pa.disabled) {
      pa.disabled = true;
      pa.disabledAt = trade.closedAt;
      pa.disabledReason = `${w.type} on ${trade.asset} disabled after ${pa.wins}/${pa.trades} wins (${(perAssetAccuracy * 100).toFixed(0)}% accuracy).`;
      observations.push(`🛑 ${w.type} on ${trade.asset} DISABLED — ${pa.wins}/${pa.trades} wins is below per-asset kill threshold.`);
    }
  }

  return observations;
}

function closePositionsForKilledSignals(
  portfolio: Portfolio,
  weights: SignalWeight[],
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
): ClosedTrade[] {
  const closed: ClosedTrade[] = [];
  const remaining: Position[] = [];
  const now = new Date().toISOString();

  for (const position of portfolio.positions) {
    const weight = weights.find((candidate) => candidate.type === position.signalType);
    const perAsset = weight?.perAsset?.[position.asset];
    const signalKilled = !!weight && (!weight.enabled || perAsset?.disabled === true);
    if (!signalKilled) {
      remaining.push(position);
      continue;
    }

    const mark = markPosition(position, latestRow, snapshots, true);
    if (!mark) {
      remaining.push(position);
      continue;
    }

    closed.push(realizeClosedPosition(portfolio, position, mark, "signal_killed", now));
  }

  portfolio.positions = remaining;
  return closed;
}

// ─── Hypothesis Evaluation ───────────────────────────────────────────────────

function inferHypothesisAsset(hypothesis: Hypothesis): string | null {
  const keys = Object.keys(hypothesis.conditions).join(" ").toLowerCase();
  const text = `${hypothesis.description} ${hypothesis.prediction} ${keys}`.toLowerCase();
  if (text.includes("btc") || text.includes("bitcoin")) return "BTC";
  if (text.includes("hype") || text.includes("hyperliquid")) return "HYPE";
  if (text.includes("gold")) return "GOLD";
  if (text.includes("amzn") || text.includes("amazon")) return "AMZN";
  if (text.includes("oil") || text.includes("brent") || text.includes("wti")) return "OIL";
  return null;
}

function evaluateHypothesisTest(hypothesis: Hypothesis, startRow: SnapshotRow, endRow: SnapshotRow): { outcome: "win" | "loss"; actualMove: string } {
  const prediction = hypothesis.prediction.toLowerCase();
  const percentMatch = prediction.match(/>(\d+(?:\.\d+)?)%/);
  const thresholdPct = percentMatch ? parseFloat(percentMatch[1]) : 2;

  if (prediction.includes("funding")) {
    const conditionKey = Object.keys(hypothesis.conditions).find((key) => key.includes("_hl_funding_ann"));
    if (!conditionKey) return { outcome: "loss", actualMove: "No funding key found" };
    const start = num(startRow[conditionKey]);
    const end = num(endRow[conditionKey]);
    if (start === null || end === null) return { outcome: "loss", actualMove: "Missing funding history" };
    if (prediction.includes("below")) {
      const target = prediction.match(/below\s+(\d+(?:\.\d+)?)/);
      const level = target ? parseFloat(target[1]) : 10;
      return {
        outcome: end < level ? "win" : "loss",
        actualMove: `Funding moved ${start.toFixed(1)}% → ${end.toFixed(1)}%`,
      };
    }
  }

  const asset = inferHypothesisAsset(hypothesis);
  if (!asset) return { outcome: "loss", actualMove: "Could not infer asset" };
  const startPx = getAssetPrice(startRow, asset);
  const endPx = getAssetPrice(endRow, asset);
  if (!startPx || !endPx) return { outcome: "loss", actualMove: "Missing price history" };
  const movePct = ((endPx - startPx) / startPx) * 100;

  if (prediction.includes("decline") || prediction.includes("drop") || prediction.includes("down")) {
    return {
      outcome: movePct <= -thresholdPct ? "win" : "loss",
      actualMove: `${asset} moved ${movePct.toFixed(2)}% (${startPx} → ${endPx})`,
    };
  }
  if (prediction.includes("move")) {
    return {
      outcome: Math.abs(movePct) >= thresholdPct ? "win" : "loss",
      actualMove: `${asset} moved ${movePct.toFixed(2)}% (${startPx} → ${endPx})`,
    };
  }

  return {
    outcome: movePct >= thresholdPct ? "win" : "loss",
    actualMove: `${asset} moved ${movePct.toFixed(2)}% (${startPx} → ${endPx})`,
  };
}

function completedHypothesisTests(hypothesis: Hypothesis): HypothesisTest[] {
  return hypothesis.tests.filter((test) => test.outcome !== "pending" && !test.excludedFromSetupStats);
}

function pendingHypothesisTests(hypothesis: Hypothesis): HypothesisTest[] {
  return hypothesis.tests.filter((test) => test.outcome === "pending" && !test.excludedFromSetupStats);
}

function slugifySetupId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function classifyHypothesisSetup(hypothesis: Hypothesis): { setupId: string; setupLabel: string } {
  if (hypothesis.id === "H-523") {
    return {
      setupId: "btc_pm_iv_regime_relative_compression",
      setupLabel: "BTC PM IV regime-relative compression",
    };
  }
  if (RETIRED_BTC_PM_IV_HARDCODED_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_btc_pm_iv_hardcoded_variants",
      setupLabel: "Retired BTC PM-IV hard-coded variants",
    };
  }
  if (BTC_LISTED_IV_MOMENTUM_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "btc_listed_iv_momentum_confirmation",
      setupLabel: "BTC listed-IV momentum confirmation",
    };
  }
  if (RETIRED_BTC_LISTED_IV_HARDCODED_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_btc_listed_iv_hardcoded_variants",
      setupLabel: "Retired BTC listed-IV hard-coded variants",
    };
  }
  if (BTC_OPTIONS_POSITIONING_MACRO_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "btc_options_positioning_macro",
      setupLabel: "BTC options positioning / macro",
    };
  }
  if (BTC_PM_IV_EXPANSION_REVERSION_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "btc_pm_iv_expansion_reversion",
      setupLabel: "BTC PM-IV expansion / reversion",
    };
  }
  if (BTC_MEDIAN_RANGE_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "btc_median_range_strike_distribution",
      setupLabel: "BTC median range / strike distribution",
    };
  }
  if (RETIRED_BTC_PM_IV_LEFTOVER_HARDCODED_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_btc_pm_iv_leftover_hardcoded_variants",
      setupLabel: "Retired BTC PM-IV leftover hard-coded variants",
    };
  }
  if (HYPE_RELATIVE_OI_BREAKOUT_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "hype_relative_oi_breakout_continuation",
      setupLabel: "HYPE relative OI breakout continuation",
    };
  }
  if (HYPE_ADJACENT_MOMENTUM_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_hype_adjacent_momentum_variants",
      setupLabel: "Retired HYPE adjacent momentum hard-coded variants",
    };
  }
  if (BTC_HYPE_CONFIRMATION_SHADOW_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_btc_hype_confirmation_variants",
      setupLabel: "Retired BTC-HYPE confirmation hard-coded variants",
    };
  }
  if (RETIRED_HYPE_SPOT_PM_DIVERGENCE_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_hype_spot_pm_divergence_variants",
      setupLabel: "Retired HYPE spot-PM divergence variants",
    };
  }
  if (AMZN_PERP_SPOT_FUNDING_CLEAN_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "amzn_perp_spot_funding_convergence",
      setupLabel: "AMZN perp/spot funding convergence",
    };
  }
  if (AMZN_OPTIONS_POSITIONING_CLEAN_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "amzn_options_positioning_momentum",
      setupLabel: "AMZN options positioning / momentum",
    };
  }
  if (RETIRED_AMZN_HARDCODED_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_amzn_hardcoded_variants",
      setupLabel: "Retired AMZN hard-coded variants",
    };
  }
  if (GOLD_SETTLEMENT_TAIL_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "gold_settlement_bucket_tail_volatility",
      setupLabel: "Gold settlement bucket tail volatility",
    };
  }
  if (OIL_SETTLEMENT_TAIL_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "oil_settlement_bucket_tail_volatility",
      setupLabel: "Oil settlement bucket tail volatility",
    };
  }
  if (GOLD_SETTLEMENT_SKEW_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "gold_settlement_bucket_skew",
      setupLabel: "Gold settlement bucket upside skew",
    };
  }
  if (OIL_SETTLEMENT_SKEW_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "oil_settlement_bucket_skew",
      setupLabel: "Oil settlement bucket upside skew",
    };
  }
  if (RETIRED_PM_SETTLEMENT_BUCKET_HARDCODED_HYPOTHESIS_IDS.has(hypothesis.id)) {
    return {
      setupId: "retired_pm_settlement_bucket_hardcoded_variants",
      setupLabel: "Retired PM settlement bucket hard-coded variants",
    };
  }

  const text = `${hypothesis.description} ${hypothesis.prediction} ${Object.keys(hypothesis.conditions ?? {}).join(" ")}`.toLowerCase();
  // Use word-boundary matching for "hype" so substrings like "hyperliquid" (the
  // venue, applies to all assets) don't get misclassified as the HYPE asset.
  const mentionsHypeAsset = /\bhype\b/.test(text);

  let label = "Other / mixed";
  if (text.includes("settlement bucket") || text.includes("settle bucket") || (text.includes("settle") && (text.includes("tail") || text.includes("overround") || text.includes("volatility")))) {
    label = "PM settlement bucket volatility";
  } else if (text.includes("underlying cap") || text.includes("spot/strike") || text.includes("payoff cap") || text.includes("pm/cap")) {
    label = "PM odds / underlying payoff cap";
  } else if (text.includes("cross-asset") && (text.includes("funding") || text.includes("positioning"))) {
    label = "Cross-asset funding/positioning exhaustion";
  } else if (text.includes("cross-asset") && text.includes("iv")) {
    label = "Cross-asset IV compression / vol expansion";
  } else if (text.includes("cross-asset") && (text.includes("p/c") || text.includes("put-call"))) {
    label = "Cross-asset options repositioning";
  } else if (text.includes("btc") && mentionsHypeAsset && (text.includes("correlation") || text.includes("coordinated"))) {
    label = "BTC momentum / correlation breakout";
  } else if (mentionsHypeAsset && text.includes("funding/oi long bounce")) {
    label = "HYPE funding/OI long bounce";
  } else if (mentionsHypeAsset && text.includes("funding/oi liquidation short")) {
    label = "HYPE funding/OI liquidation short";
  } else if (mentionsHypeAsset && (text.includes("oi") || text.includes("open interest")) && (text.includes("distribution") || text.includes("exhaustion"))) {
    label = "HYPE OI distribution exhaustion / reversal";
  } else if (mentionsHypeAsset && (text.includes("breakout") || text.includes("momentum") || text.includes("fomo") || text.includes("surge"))) {
    label = "HYPE breakout / OI surge momentum";
  } else if (mentionsHypeAsset && (text.includes("funding") || text.includes("oi") || text.includes("open interest"))) {
    label = "HYPE funding/OI normalization";
  } else if (text.includes("btc") && (text.includes("dealer hedg") || text.includes("term spread") || text.includes("term structure") || text.includes("gamma stress") || text.includes("hedge stress"))) {
    label = "BTC dealer hedge stress / pullback";
  } else if (text.includes("btc") && text.includes("funding")) {
    label = "BTC funding exhaustion / reversal";
  } else if (text.includes("btc") && (text.includes("iv compression") || text.includes("pm iv") || text.includes("vol"))) {
    label = "BTC IV compression / vol reversion";
  } else if (text.includes("btc") && (text.includes("p/c") || text.includes("put-call"))) {
    label = "BTC put-call exhaustion / reversal";
  } else if (text.includes("btc") && (text.includes("momentum") || text.includes("breakout") || text.includes("correlation"))) {
    label = "BTC momentum / correlation breakout";
  } else if (text.includes("oil") && (text.includes("iv") || text.includes("statistical") || text.includes("arbitrage") || text.includes("breakdown"))) {
    label = "Oil IV/statistical breakdown arbitrage";
  } else if (text.includes("oil") && text.includes("funding")) {
    label = "Oil funding volatility / mean reversion";
  } else if (text.includes("oil") && (text.includes("pm") || text.includes("spot"))) {
    label = "Oil PM-spot divergence / mean reversion";
  } else if (text.includes("gold") && (text.includes("pm") || text.includes("premium") || text.includes("settlement") || text.includes("futures"))) {
    label = "Gold PM premium / futures spread mean reversion";
  } else if (text.includes("gold") && (text.includes("iv") || text.includes("compression"))) {
    label = "Gold IV compression / vol reversion";
  } else if (text.includes("amzn") && (text.includes("funding") || text.includes("basis") || text.includes("perp"))) {
    label = "AMZN perp/spot funding convergence";
  } else if (text.includes("amzn") && (text.includes("p/c") || text.includes("put-call") || text.includes("momentum"))) {
    label = "AMZN options positioning / momentum";
  } else if (text.includes("macro")) {
    label = "Macro regime / risk momentum";
  }

  return {
    setupId: slugifySetupId(label),
    setupLabel: label,
  };
}

function ensureHypothesisSetupMetadata(hypothesis: Hypothesis): void {
  const setup = classifyHypothesisSetup(hypothesis);
  hypothesis.setupId = setup.setupId;
  hypothesis.setupLabel = setup.setupLabel;
}

function completedSetupTests(hypotheses: Hypothesis[]): HypothesisTest[] {
  return hypotheses.flatMap((hypothesis) => completedHypothesisTests(hypothesis));
}

function pendingSetupTests(hypotheses: Hypothesis[]): HypothesisTest[] {
  return hypotheses.flatMap((hypothesis) => pendingHypothesisTests(hypothesis));
}

function selectSetupPrimary(hypotheses: Hypothesis[]): Hypothesis {
  // Killed/archived hypotheses are never eligible to represent a family — if
  // we let them through, the promotion path at evaluateHypotheses() will set
  // status="promoted" on a killed entry and resurrect it. Fall back to the
  // full list only when every member is killed/archived (so the family record
  // still has a representative for reporting).
  const eligible = hypotheses.filter((h) => h.status !== "killed" && h.status !== "archived");
  const pool = eligible.length > 0 ? eligible : hypotheses;
  return [...pool].sort((a, b) => {
    if (a.status === "promoted" && b.status !== "promoted") return -1;
    if (b.status === "promoted" && a.status !== "promoted") return 1;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.id.localeCompare(b.id);
  })[0];
}

function hypothesisSetupFamilies(hypotheses: Hypothesis[]): HypothesisSetupFamily[] {
  const bySetup = new Map<string, Hypothesis[]>();
  for (const hypothesis of hypotheses) {
    ensureHypothesisSetupMetadata(hypothesis);
    const setupId = hypothesis.setupId ?? "other_mixed";
    bySetup.set(setupId, [...(bySetup.get(setupId) ?? []), hypothesis]);
  }

  return [...bySetup.entries()].map(([setupId, familyHypotheses]) => {
    const completed = completedSetupTests(familyHypotheses);
    const pending = pendingSetupTests(familyHypotheses);
    const wins = completed.filter((test) => test.outcome === "win").length;
    const losses = completed.filter((test) => test.outcome === "loss").length;
    const setupLabel = familyHypotheses[0]?.setupLabel ?? setupId;
    return {
      setupId,
      setupLabel,
      hypotheses: familyHypotheses,
      completed,
      pending,
      wins,
      losses,
      winRate: completed.length > 0 ? wins / completed.length : 0,
      primary: selectSetupPrimary(familyHypotheses),
    };
  });
}

function hypothesisSetupNeedsMoreShadowTests(family: HypothesisSetupFamily): boolean {
  if (!family.hypotheses.some((hypothesis) => hypothesis.source === "llm")) return false;
  if (!family.hypotheses.some((hypothesis) => hypothesis.status !== "killed" && hypothesis.status !== "archived")) return false;
  return family.completed.length < HYPOTHESIS_SHADOW_TESTS_REQUIRED;
}

function isDataContaminatedSetup(setupId: string): boolean {
  return DATA_CONTAMINATED_SETUP_IDS.has(setupId);
}

function isRepeatHypothesisShadowTest(test: HypothesisTest): boolean {
  return test.outcome === "pending" && /Shadow test \d+\/\d+ opened/.test(test.actualMove);
}

function llmHypothesisBacklog(hypotheses: Hypothesis[]) {
  const llmHypotheses = hypotheses.filter((hypothesis) => hypothesis.source === "llm");
  const families = hypothesisSetupFamilies(llmHypotheses);
  const needingTests = families.filter(hypothesisSetupNeedsMoreShadowTests);
  const activeRetestQueue = needingTests.slice(0, HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT);
  const pending = needingTests.reduce((sum, family) => sum + family.pending.length, 0);
  return {
    total: llmHypotheses.length,
    setupFamilies: families.length,
    needingTests: needingTests.length,
    activeRetestLimit: HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT,
    activeRetestQueue: activeRetestQueue.length,
    pending,
    complete: needingTests.length === 0,
  };
}

function lookbackRows(valuationRows: SnapshotRow[], amount: number, unit: string): SnapshotRow[] {
  const periods = Math.max(1, Math.round(amount * (unit === "d" ? 24 : 1)));
  return valuationRows.slice(-Math.min(valuationRows.length, periods));
}

function valuesForKey(rows: SnapshotRow[], key: string): number[] {
  return rows.map((row) => num(row[key])).filter((value): value is number => value !== null);
}

function percentileRank(values: number[], current: number): number | null {
  if (values.length === 0) return null;
  const belowOrEqual = values.filter((value) => value <= current).length;
  return (belowOrEqual / values.length) * 100;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], avg: number): number | null {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function derivedHypothesisConditionValue(key: string, valuationRows: SnapshotRow[]): number | null {
  const latestRow = valuationRows[valuationRows.length - 1];
  if (!latestRow) return null;

  const pctFromExtreme = key.match(/^(.+)_pct_from_(\d+)(h|d)_(high|low)$/);
  if (pctFromExtreme) {
    const [, baseKey, amount, unit, extreme] = pctFromExtreme;
    const current = num(latestRow[baseKey]);
    const values = valuesForKey(lookbackRows(valuationRows, Number(amount), unit), baseKey);
    if (current === null || values.length === 0) return null;
    const reference = extreme === "high" ? Math.max(...values) : Math.min(...values);
    return reference === 0 ? null : ((current - reference) / reference) * 100;
  }

  const pctVsSma = key.match(/^(.+)_pct_vs_(\d+)(h|d)_sma$/);
  if (pctVsSma) {
    const [, baseKey, amount, unit] = pctVsSma;
    const current = num(latestRow[baseKey]);
    const avg = mean(valuesForKey(lookbackRows(valuationRows, Number(amount), unit), baseKey));
    return current === null || avg === null || avg === 0 ? null : ((current - avg) / avg) * 100;
  }

  const percentile = key.match(/^(.+)_percentile_(\d+)(h|d)$/);
  if (percentile) {
    const [, baseKey, amount, unit] = percentile;
    const current = num(latestRow[baseKey]);
    const values = valuesForKey(lookbackRows(valuationRows, Number(amount), unit), baseKey);
    return current === null ? null : percentileRank(values, current);
  }

  const zscore = key.match(/^(.+)_zscore_(\d+)(h|d)$/);
  if (zscore) {
    const [, baseKey, amount, unit] = zscore;
    const current = num(latestRow[baseKey]);
    const values = valuesForKey(lookbackRows(valuationRows, Number(amount), unit), baseKey);
    const avg = mean(values);
    const sd = avg === null ? null : standardDeviation(values, avg);
    return current === null || avg === null || sd === null || sd === 0 ? null : (current - avg) / sd;
  }

  const changePct = key.match(/^(.+)_change_pct_(\d+)(h|d)$/);
  if (changePct) {
    const [, baseKey, amount, unit] = changePct;
    const periods = Math.max(1, Math.round(Number(amount) * (unit === "d" ? 24 : 1)));
    const current = num(latestRow[baseKey]);
    const priorRow = valuationRows[Math.max(0, valuationRows.length - 1 - periods)];
    const prior = priorRow ? num(priorRow[baseKey]) : null;
    return current === null || prior === null || prior === 0 ? null : ((current - prior) / prior) * 100;
  }

  return null;
}

function relativeValueConditionValue(key: string, relativeValueRows: RelativeValueObservation[]): number | null {
  const match = key.match(/^([a-z]+)_pm_(underlying_cap|settle)_(ratio|edge_pts|yes_sum|overround|tail_yes|skew_yes)_(max|min|avg)(_tight)?$/);
  if (!match) return null;
  const [, rawAsset, group, metric, reducer, tightOnly] = match;
  const asset = rawAsset.toUpperCase();
  const values = relativeValueRows
    .filter((row) => row.asset === asset)
    .filter((row) => group !== "underlying_cap" || (row.direction === "above" && row.underlyingCapYes !== null))
    .filter((row) => group !== "settle" || row.settlementYesSum !== null)
    .filter((row) => !tightOnly || (
      row.pmSpread !== null
      && row.pmSpread <= UNDERLYING_CAP_ENTRY_MAX_SPREAD
      && row.liquidity !== null
      && row.liquidity >= UNDERLYING_CAP_ENTRY_MIN_LIQUIDITY
    ))
    .map((row) => {
      if (metric === "ratio") return row.pmToUnderlyingCapRatio;
      if (metric === "edge_pts") return row.edgePts;
      if (metric === "yes_sum") return row.settlementYesSum;
      if (metric === "overround") return row.settlementOverround;
      if (metric === "tail_yes") return row.settlementTailYes;
      if (metric === "skew_yes") return row.settlementSkewYes;
      return null;
    })
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  if (reducer === "max") return Math.max(...values);
  if (reducer === "min") return Math.min(...values);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hypothesisConditionValue(
  key: string,
  valuationRows: SnapshotRow[],
  hypothesis: Hypothesis,
  relativeValueRows: RelativeValueObservation[] = [],
): number | null {
  const latestRow = valuationRows[valuationRows.length - 1];
  const previousRow = valuationRows.length > 1 ? valuationRows[valuationRows.length - 2] : null;
  if (!latestRow) return null;
  if (key.startsWith("previous_")) return previousRow ? num(previousRow[key.replace(/^previous_/, "")]) : null;
  const direct = num(latestRow[key]);
  if (direct !== null) return direct;
  const derived = derivedHypothesisConditionValue(key, valuationRows);
  if (derived !== null) return derived;
  const relativeValue = relativeValueConditionValue(key, relativeValueRows);
  if (relativeValue !== null) return relativeValue;

  if (key === "ratio") {
    const pmIvKey = Object.keys(hypothesis.conditions).find((conditionKey) => conditionKey.endsWith("_pm_iv"));
    const optIvKey = Object.keys(hypothesis.conditions).find((conditionKey) => conditionKey.includes("_opt_iv"));
    const pmIv = pmIvKey ? num(latestRow[pmIvKey]) : null;
    const optIv = optIvKey ? num(latestRow[optIvKey]) : null;
    if (pmIv !== null && optIv !== null && optIv !== 0) return pmIv / optIv;
  }

  return null;
}

function evaluateHypothesisCondition(
  key: string,
  rawExpression: string,
  valuationRows: SnapshotRow[],
  hypothesis: Hypothesis,
  relativeValueRows: RelativeValueObservation[] = [],
): boolean {
  const latestRow = valuationRows[valuationRows.length - 1];
  const previousRow = valuationRows.length > 1 ? valuationRows[valuationRows.length - 2] : null;
  const expression = String(rawExpression).trim().toLowerCase().replace(/%/g, "");
  const value = hypothesisConditionValue(key, valuationRows, hypothesis, relativeValueRows);
  const previousValue = key.startsWith("previous_")
    ? null
    : previousRow ? num(previousRow[key]) : null;

  const between = expression.match(/^between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/);
  if (between) {
    if (value === null) return false;
    const low = Number(between[1]);
    const high = Number(between[2]);
    return value >= low && value <= high;
  }

  const absChange = expression.match(/^abs\(current\s*-\s*previous\)\s*([<>]=?)\s*(-?\d+(?:\.\d+)?)/);
  if (absChange) {
    if (value === null || previousValue === null) return false;
    const delta = Math.abs(value - previousValue);
    const threshold = Number(absChange[2]);
    return absChange[1].startsWith(">") ? delta > threshold : delta < threshold;
  }

  const declining = expression.match(/^declining\s*>\s*(-?\d+(?:\.\d+)?)/);
  if (declining) {
    if (value === null || previousValue === null) return false;
    return previousValue - value > Number(declining[1]);
  }

  if (expression.includes("changes sign")) {
    if (value === null || previousValue === null) return false;
    return Math.sign(value) !== 0 && Math.sign(previousValue) !== 0 && Math.sign(value) !== Math.sign(previousValue);
  }

  const dailyChange = expression.match(/^<\s*(-?\d+(?:\.\d+)?)\s*daily change/);
  if (dailyChange) {
    if (value === null || previousValue === null || previousValue === 0) return false;
    return Math.abs(((value - previousValue) / previousValue) * 100) < Number(dailyChange[1]);
  }

  const comparison = expression.match(/^([<>]=?|=|==)\s*(-?\d+(?:\.\d+)?)/);
  if (comparison) {
    if (value === null) return false;
    const threshold = Number(comparison[2]);
    switch (comparison[1]) {
      case ">": return value > threshold;
      case ">=": return value >= threshold;
      case "<": return value < threshold;
      case "<=": return value <= threshold;
      case "=":
      case "==": return value === threshold;
    }
  }

  return false;
}

function hypothesisConditionsSatisfied(
  hypothesis: Hypothesis,
  valuationRows: SnapshotRow[],
  relativeValueRows: RelativeValueObservation[] = [],
): boolean {
  const latestRow = valuationRows[valuationRows.length - 1];
  if (!latestRow) return false;
  const entries = Object.entries(hypothesis.conditions ?? {});
  if (entries.length === 0) return false;
  return entries.every(([key, expression]) => evaluateHypothesisCondition(key, String(expression), valuationRows, hypothesis, relativeValueRows));
}

function hasRegimeRelativeConditions(hypothesis: Hypothesis): boolean {
  return Object.keys(hypothesis.conditions ?? {}).some((key) => (
    /^.+_pct_from_\d+[hd]_(high|low)$/.test(key)
    || /^.+_pct_vs_\d+[hd]_sma$/.test(key)
    || /^.+_percentile_\d+[hd]$/.test(key)
    || /^.+_zscore_\d+[hd]$/.test(key)
    || /^.+_change_pct_\d+[hd]$/.test(key)
  ));
}

// Tight directional keywords. Each entry must carry unambiguous direction in
// the context of a price-prediction sentence. Ambiguous words like "continues",
// "expansion", "extends", "above", "below", "long-term", "short-term",
// "momentum" are deliberately excluded — they fire false positives constantly.
const BEARISH_KEYWORDS = [
  "decline", "declining", "drops", "dropping",
  "downside", "downturn", "downward",
  "falls", "falling",
  "pullback", "selloff", "sell-off",
  "weakness", "weaken", "weakening",
  "bearish",
  "unwind", "liquidation",
  "breakdown", "breaks down", "break down",
  "reverses lower", "reverts lower",
  "capitulat", "crash", "tumble", "slump",
  "deteriorat", "rolls over",
];

const BULLISH_KEYWORDS = [
  "rally", "rallies", "rallying",
  "rises", "rising",
  "rebound", "bounce", "bouncing",
  "breakout", "breaks out", "break out",
  "upside", "upturn", "up move",
  "strengthen", "strengthening",
  "bullish",
  "outperform",
  "reverses higher", "reverts higher",
  "accumulat",
];

// Vol/IV reversion themes that don't carry a spot direction. Defaulting these
// to long is the bug that produced the H-523 BTC stop-out: the thesis was
// "BTC vol expands as PM IV mean reverts", which says nothing about whether
// BTC spot goes up or down.
const VOL_ONLY_KEYWORDS = [
  "vol expansion", "vol expands", "volatility expansion", "volatility expands",
  "iv expansion", "iv expands", "iv expand", "implied vol expand",
  "vol compression", "vol compresses", "volatility compression",
  "iv compression", "iv compresses",
  "mean revert", "mean-revert", "mean reverts",
  "vol reversion", "volatility reversion", "iv reversion",
  "vol mean revert", "iv mean revert",
];

const EXPLICIT_LONG_PREFIX = /\blong\s+(btc|eth|hype|amzn|sol|sui|gold|oil|spy|nvda)\b/i;
const EXPLICIT_SHORT_PREFIX = /\bshort\s+(btc|eth|hype|amzn|sol|sui|gold|oil|spy|nvda)\b/i;

function containsAny(text: string, keywords: readonly string[]): boolean {
  for (const k of keywords) if (text.includes(k)) return true;
  return false;
}

function inferHypothesisDirection(hypothesis: Hypothesis): "long" | "short" | null {
  // 1. Authoritative: the LLM now emits `direction` on every new hypothesis
  //    (long/short/neutral). When present we trust it absolutely; "neutral"
  //    means the thesis has no spot view (vol/IV/spread play) -> skip.
  if (hypothesis.direction === "long") return "long";
  if (hypothesis.direction === "short") return "short";
  if (hypothesis.direction === "neutral") return null;

  // Older hypotheses created before the `direction` field existed fall back
  // to the keyword-based inferrer below.
  const raw = `${hypothesis.description} ${hypothesis.prediction}`;
  const text = raw.toLowerCase();

  // 2. Explicit "LONG <ASSET>" / "SHORT <ASSET>" prefix the LLM used on
  //    ~50 recent hypotheses. Authoritative over keyword scanning.
  const longHit = EXPLICIT_LONG_PREFIX.test(raw);
  const shortHit = EXPLICIT_SHORT_PREFIX.test(raw);
  if (longHit && !shortHit) return "long";
  if (shortHit && !longHit) return "short";

  // 3. Vol/IV reversion themes have no spot direction; refuse to convert to a
  //    directional spot bet (this is the H-523 fix).
  if (containsAny(text, VOL_ONLY_KEYWORDS)) return null;

  // 4. Tight keyword scan; conflict -> skip rather than default to long.
  const bearish = containsAny(text, BEARISH_KEYWORDS);
  const bullish = containsAny(text, BULLISH_KEYWORDS);
  if (bearish && !bullish) return "short";
  if (bullish && !bearish) return "long";
  return null;
}

function generatePromotedHypothesisSignals(
  hypotheses: Hypothesis[],
  rows: SnapshotRow[],
  latestRow: SnapshotRow,
  learningParams: LearningParams,
  latestSnapshot: InstrumentSnapshotFile | null,
  blockedSignals: BlockedSignalShadow[],
  relativeValueRows: RelativeValueObservation[] = [],
): Signal[] {
  const signals: Signal[] = [];
  const risk = riskForSignal(learningParams, "PROMOTED_HYPOTHESIS");
  const promotedFamilies = hypothesisSetupFamilies(hypotheses)
    .filter((family) => !RETIRED_LLM_SETUP_IDS.has(family.setupId))
    .filter((family) => family.hypotheses.some((hypothesis) =>
      hypothesis.status === "promoted" &&
      hypothesis.promotedToSignal &&
      LIVE_PROMOTED_HYPOTHESIS_IDS.has(hypothesis.id)
    ));

  for (const family of promotedFamilies) {
    const promotedRepresentatives = family.hypotheses.filter((hypothesis) =>
      hypothesis.status === "promoted" &&
      hypothesis.promotedToSignal &&
      LIVE_PROMOTED_HYPOTHESIS_IDS.has(hypothesis.id)
    );
    for (const representative of promotedRepresentatives) {
      const promotedAsset = inferHypothesisAsset(representative);
      if (!promotedAsset) continue;
      const candidates = family.hypotheses
        .filter((hypothesis) => hypothesis.status !== "killed" && hypothesis.status !== "archived")
        .filter((hypothesis) => inferHypothesisAsset(hypothesis) === promotedAsset)
        .filter((hypothesis) => !hasRegimeRelativeConditions(representative) || hasRegimeRelativeConditions(hypothesis))
        .filter((hypothesis) => hypothesisConditionsSatisfied(hypothesis, rows, relativeValueRows))
        .sort((a, b) => {
          const regimeRelativeDelta = Number(hasRegimeRelativeConditions(b)) - Number(hasRegimeRelativeConditions(a));
          if (regimeRelativeDelta !== 0) return regimeRelativeDelta;
          if (b.winRate !== a.winRate) return b.winRate - a.winRate;
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return completedHypothesisTests(b).length - completedHypothesisTests(a).length;
        });
      const hypothesis = candidates[0];
      if (!hypothesis) continue;

      const asset = inferHypothesisAsset(hypothesis);
      if (!asset) continue;
      const direction = inferHypothesisDirection(hypothesis);
      if (!direction) {
        // Thesis is direction-ambiguous (e.g. pure vol/IV reversion) or
        // contains mixed bullish+bearish language. Skip rather than
        // defaulting to long — this used to fire BTC longs against
        // explicitly bearish predictions like "BTC continues pullback".
        continue;
      }
      const entryPrice = getAssetPrice(latestRow, asset);
      if (!entryPrice) continue;
      const signal = finalizeSignal({
        type: "PROMOTED_HYPOTHESIS",
        asset,
        venue: "spot",
        direction,
        strength: Math.max(0.2, family.winRate, hypothesis.winRate),
        confidence: Math.min(0.9, Math.max(0.2, hypothesis.confidence * Math.max(family.winRate, hypothesis.winRate, 0.5))),
        thesis: `[PROMOTED ${family.setupLabel} via ${hypothesis.id}] ${hypothesis.description}`,
        hypothesisId: hypothesis.id,
        entryPrice,
        targetPct: risk.targetPct,
        stopPct: risk.stopPct,
        expiryDays: Math.max(3, Math.min(14, hypothesis.timeframeDays)),
      }, rows, learningParams, { latestRow, latestSnapshot, blockedSignals });
      if (signal) signals.push(signal);
    }
  }
  return signals;
}

function evaluateHypotheses(
  hypotheses: Hypothesis[],
  valuationRows: SnapshotRow[],
  relativeValueRows: RelativeValueObservation[] = [],
): string[] {
  const observations: string[] = [];
  const now = new Date();
  const latestDate = String(valuationRows[valuationRows.length - 1]?.date ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  let openedShadowTests = 0;
  let skippedInactiveBacklog = 0;
  let skippedConditionNotMet = 0;

  for (const h of hypotheses) {
    ensureHypothesisSetupMetadata(h);
    if (h.status === "killed" || h.status === "archived") continue;

    // Check pending tests
    for (const test of h.tests) {
      if (test.outcome !== "pending") continue;
      const testDate = new Date(test.date);
      const elapsed = (now.getTime() - testDate.getTime()) / (1000 * 60 * 60 * 24);
      if (elapsed < h.timeframeDays) continue;
      const startRow = valuationRows.find((row) => row.date.startsWith(test.date));
      const endRow = valuationRows[valuationRows.length - 1];
      if (!startRow || !endRow) {
        test.outcome = "loss";
        test.actualMove = "Missing valuation history";
        continue;
      }
      const result = evaluateHypothesisTest(h, startRow, endRow);
      test.outcome = result.outcome;
      test.actualMove = result.actualMove;
    }

    // Update win rate
    const completed = h.tests.filter((t) => t.outcome !== "pending");
    if (completed.length > 0) {
      h.winRate = completed.filter((t) => t.outcome === "win").length / completed.length;
    }
  }

  const setupFamilies = hypothesisSetupFamilies(hypotheses.filter((hypothesis) => hypothesis.source === "llm"));

  for (const family of setupFamilies) {
    const completedCount = family.completed.length;
    if (completedCount < PROMOTE_MIN_TESTS) continue;

    const activeFamilyHypotheses = family.hypotheses.filter((hypothesis) => hypothesis.status !== "killed" && hypothesis.status !== "archived");
    if (activeFamilyHypotheses.length === 0) continue;
    if (RETIRED_LLM_SETUP_IDS.has(family.setupId)) continue;
    if (isDataContaminatedSetup(family.setupId)) continue;

    if (family.winRate >= PROMOTE_THRESHOLD) {
      const primary = family.primary;
      const alreadyPromoted = primary.status === "promoted" && primary.promotedToSignal;
      primary.status = "promoted";
      primary.promotedToSignal = true;
      primary.winRate = family.winRate;
      primary.postMortem = primary.postMortem ?? `Setup family promoted: ${(family.winRate * 100).toFixed(0)}% win rate over ${completedCount} completed tests across ${family.hypotheses.length} variants.`;
      for (const sibling of activeFamilyHypotheses) {
        if (sibling.id === primary.id) continue;
        if (sibling.status === "promoted") sibling.status = "active";
        sibling.promotedToSignal = false;
        sibling.postMortem = sibling.postMortem ?? `Covered by promoted setup family ${family.setupId} via primary ${primary.id}.`;
      }
      if (!alreadyPromoted) {
        observations.push(`🎯 Setup family ${family.setupId} PROMOTED via ${primary.id} (${(family.winRate * 100).toFixed(0)}% over ${completedCount} tests across ${family.hypotheses.length} variants): ${family.setupLabel}`);
      }
      continue;
    }

    if (family.winRate < KILL_THRESHOLD) {
      for (const hypothesis of activeFamilyHypotheses) {
        hypothesis.status = "killed";
        hypothesis.promotedToSignal = false;
        hypothesis.postMortem = hypothesis.postMortem ?? `Setup family killed: ${(family.winRate * 100).toFixed(0)}% win rate over ${completedCount} completed tests across ${family.hypotheses.length} variants.`;
      }
      observations.push(`💀 Setup family ${family.setupId} KILLED (${(family.winRate * 100).toFixed(0)}% over ${completedCount} tests across ${family.hypotheses.length} variants): ${family.setupLabel}`);
      continue;
    }

    for (const hypothesis of activeFamilyHypotheses) {
      if (hypothesis.status === "promoted" && family.winRate < DEMOTE_THRESHOLD) {
        hypothesis.status = "active";
        hypothesis.promotedToSignal = false;
        hypothesis.postMortem = `Setup family demoted: win rate dropped to ${(family.winRate * 100).toFixed(0)}% over ${completedCount} completed tests.`;
        observations.push(`📉 Setup family ${family.setupId} DEMOTED from promoted trading: ${family.setupLabel}`);
      } else if (family.winRate < PROMOTE_THRESHOLD) {
        hypothesis.postMortem = hypothesis.postMortem ?? `Setup family inconclusive after ${completedCount} completed tests: ${(family.winRate * 100).toFixed(0)}% win rate.`;
      }
    }
  }

  const familiesNeedingTests = hypothesisSetupFamilies(hypotheses.filter((hypothesis) => hypothesis.source === "llm"))
    .filter(hypothesisSetupNeedsMoreShadowTests);
  const activeSetupIds = new Set(
    familiesNeedingTests
      .slice(0, HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT)
      .map((family) => family.setupId),
  );

  for (const family of familiesNeedingTests) {
    if (family.pending.length > 0) continue;
    if (!activeSetupIds.has(family.setupId)) {
      skippedInactiveBacklog++;
      continue;
    }

    const candidate = family.hypotheses
      .filter((hypothesis) => hypothesis.status !== "killed" && hypothesis.status !== "archived")
      .filter((hypothesis) => pendingHypothesisTests(hypothesis).length === 0)
      .sort((a, b) => completedHypothesisTests(a).length - completedHypothesisTests(b).length || b.confidence - a.confidence)
      .find((hypothesis) => hypothesisConditionsSatisfied(hypothesis, valuationRows, relativeValueRows));

    if (!candidate) {
      skippedConditionNotMet++;
      continue;
    }

    const nextTestNumber = family.completed.length + family.pending.length + 1;
    candidate.tests.push({
      date: latestDate,
      triggered: true,
      outcome: "pending",
      actualMove: `Setup ${family.setupId} shadow test ${nextTestNumber}/${HYPOTHESIS_SHADOW_TESTS_REQUIRED} opened via ${candidate.id} after current row satisfied variant conditions.`,
    });
    openedShadowTests++;
  }

  if (openedShadowTests > 0) {
    observations.push(`🧪 Opened ${openedShadowTests} condition-triggered setup-family shadow tests from the first ${HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT} LLM setup families.`);
  }
  if (skippedConditionNotMet > 0 || skippedInactiveBacklog > 0) {
    observations.push(`🧪 Hypothesis setup retest queue: ${skippedConditionNotMet} of the first ${HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT} setup families did not trigger; ${skippedInactiveBacklog} later setup families are waiting for the next batch.`);
  }

  return observations;
}

// ─── Lean Engine State / Truth / Policy Artifacts ─────────────────────────────

function mechanicalCloseReason(position: Position, mark: { pnlPct: number } | null): ClosedTrade["closeReason"] | null {
  if (!mark) return null;
  if (position.targetPct !== null && mark.pnlPct >= position.targetPct) return "target";
  if (fundingBreakevenStopHit(position, mark)) return "breakeven_stop";
  if (mark.pnlPct <= -position.stopPct) return "stop";
  if (new Date(position.expiryDate) <= new Date()) return "expiry";
  return null;
}

function positionMarkSummary(position: Position, latestRow: SnapshotRow, snapshots: InstrumentSnapshotFile[]): PositionMarkSummary {
  const mark = markPosition(position, latestRow, snapshots, true);
  return {
    positionId: position.id,
    asset: position.asset,
    venue: position.venue,
    direction: position.direction,
    signalType: position.signalType,
    pnlPct: mark ? Number(mark.pnlPct.toFixed(2)) : null,
    currentPrice: mark ? Number(mark.currentPrice.toFixed(6)) : null,
    underlyingPrice: mark?.underlyingPrice ?? null,
    targetPct: position.targetPct,
    stopPct: position.stopPct,
    closeReasonIfMechanical: mechanicalCloseReason(position, mark),
    evidenceColumns: signalFamilyEvidenceColumns(position),
  };
}

function buildEngineState(
  valuationRows: SnapshotRow[],
  macroRows: SnapshotRow[],
  instrumentSnapshots: InstrumentSnapshotFile[],
  portfolio: Portfolio,
  weights: SignalWeight[],
  learningParams: LearningParams,
  blockedSummary: BlockedSignalLearningSummary,
): EngineState {
  const latestRow = valuationRows[valuationRows.length - 1];
  const openPositions = latestRow
    ? portfolio.positions.map((position) => positionMarkSummary(position, latestRow, instrumentSnapshots))
    : [];
  const unrealizedPnl = openPositions.reduce((sum, position) => {
    const live = portfolio.positions.find((candidate) => candidate.id === position.positionId);
    return sum + (live ? estimateOpenPositionPnl(live) : 0);
  }, 0);

  return {
    generatedAt: new Date().toISOString(),
    dataFreshness: {
      valuationRows: valuationRows.length,
      latestValuationAt: String(latestRow?.date ?? ""),
      macroRows: macroRows.length,
      instrumentSnapshots: instrumentSnapshots.length,
      latestInstrumentSnapshotAt: latestInstrumentSnapshot(instrumentSnapshots)?.timestamp ?? null,
    },
    portfolio: {
      cash: Number(portfolio.cash.toFixed(4)),
      openPositions: portfolio.positions.length,
      realizedPnl: Number(portfolio.totalRealizedPnl.toFixed(4)),
      totalTrades: portfolio.totalTrades,
      winRatePct: portfolio.totalTrades > 0 ? Number(((portfolio.winCount / portfolio.totalTrades) * 100).toFixed(1)) : null,
      unrealizedPnl: Number(unrealizedPnl.toFixed(4)),
    },
    openPositions,
    signalHealth: weights.map((weight) => ({
      type: weight.type,
      enabled: weight.enabled,
      weight: Number(weight.weight.toFixed(4)),
      trades: weight.trades,
      wins: weight.wins,
      avgPnlPct: Number(weight.avgPnlPct.toFixed(4)),
      disabledAssets: Object.entries(weight.perAsset ?? {})
        .filter(([, stats]) => stats.disabled)
        .map(([asset]) => asset),
    })),
    blockedSummary,
    learningParams,
  };
}

function setupIdForSignalType(signalType: string): { setupId: string; setupLabel: string } {
  if (signalType === ONE_TOUCH_HIGH_EDGE_SIGNAL_NO) return { setupId: "one_touch_high_edge_no", setupLabel: "One-touch NO sell-YES edge" };
  if (signalType === ONE_TOUCH_HIGH_EDGE_SIGNAL_YES) return { setupId: "one_touch_high_edge_yes_exploratory", setupLabel: "One-touch high-edge YES exploratory" };
  if (signalType === STALE_LOTTERY_TICKET_NO_SIGNAL) return { setupId: "stale_lottery_ticket_no", setupLabel: "Stale lottery ticket NO" };
  if (signalType.includes("USER_PM_IV_TOUCH_CHEAP_YES")) return { setupId: "manual_iv_touch_cheap_yes", setupLabel: "Manual IV-touch cheap YES" };
  if (signalType.includes("USER_PM_IV_TOUCH_RICH_NO")) return { setupId: "manual_iv_touch_rich_no", setupLabel: "Manual IV-touch rich NO" };
  if (signalType === "MONOTONIC_ARB") return { setupId: "monotonic_arb", setupLabel: "Monotonic arb" };
  const label = signalType
    .replace(/_PM_PROXY_SHORT$/, " Polymarket proxy short")
    .replace(/_DOWNSIDE$/, " downside leg")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return { setupId: slugifySetupId(signalType), setupLabel: label };
}

function setupIdForTrade(trade: ClosedTrade, hypothesesById: Map<string, Hypothesis>): { setupId: string; setupLabel: string } {
  const hypothesis = trade.hypothesisId ? hypothesesById.get(trade.hypothesisId) : null;
  if (hypothesis?.setupId && hypothesis.setupLabel) return { setupId: hypothesis.setupId, setupLabel: hypothesis.setupLabel };
  if (trade.signalType === "PROMOTED_HYPOTHESIS" && hypothesis?.setupId) {
    return { setupId: hypothesis.setupId, setupLabel: hypothesis.setupLabel ?? hypothesis.setupId };
  }
  return setupIdForSignalType(trade.signalType);
}

function setupIdForShadow(shadow: BlockedSignalShadow): { setupId: string; setupLabel: string } {
  if (shadow.blockedReason === "one_touch_high_edge_shadow") return setupIdForSignalType(shadow.signalType);
  if (shadow.blockedReason === "stale_lottery_ticket_shadow") return setupIdForSignalType(shadow.signalType);
  if (shadow.blockedReason === "manual_shadow_trade") return setupIdForSignalType(shadow.signalType);
  if (shadow.blockedReason === "monotonic_arb_shadow") return setupIdForSignalType("MONOTONIC_ARB");
  if (shadow.signalType.endsWith("_PM_PROXY_SHORT") || shadow.signalType.endsWith("_DOWNSIDE")) return setupIdForSignalType(shadow.signalType);
  return setupIdForSignalType(shadow.signalType);
}

function humanCloseReason(reason: ClosedTrade["closeReason"]): string {
  switch (reason) {
    case "target": return "hit target";
    case "stop": return "hit stop";
    case "breakeven_stop": return "stopped at breakeven";
    case "expiry": return "expired";
    case "llm_decision": return "closed by LLM";
    case "signal_killed": return "closed because signal was killed";
    case "thesis_validated": return "closed with thesis validated (near-money repriced)";
    case "thesis_validated_profitable": return "closed with thesis validated profitably";
    case "thesis_compressed_loss": return "edge compressed but trade lost money";
    case "data_quality_artifact": return "closed as data-quality artifact (excluded from learning)";
    default: return reason;
  }
}

function isLearningContaminatedTrade(trade: ClosedTrade, setupId: string): boolean {
  if (isLedgerContaminatedTrade(trade)) return true;
  if (!DATA_CONTAMINATED_SETUP_IDS.has(setupId)) return false;
  const opened = String(trade.openedAt ?? "");
  const oilOrGoldPc = (trade.asset === "OIL" || trade.asset === "GOLD") && trade.signalType.includes("PC_RATIO");
  return oilOrGoldPc && opened < "2026-04-30";
}

function allowedEvidenceColumnsForSetup(setupId: string, assetHint?: string): string[] {
  const asset = assetHint ?? (
    setupId.includes("btc") ? "BTC" :
    setupId.includes("hype") ? "HYPE" :
    setupId.includes("gold") ? "GOLD" :
    setupId.includes("amzn") ? "AMZN" :
    setupId.includes("oil") ? "OIL" : "BTC"
  );
  const columns = assetPromptColumns(asset);
  if (setupId.includes("funding")) return uniqueColumns([columns.spot, columns.hlPerp, columns.funding]);
  if (setupId.includes("pc_ratio") || setupId.includes("put_call") || setupId.includes("options")) return uniqueColumns([columns.spot, columns.pcRatio, columns.optIv30, columns.optIv90]);
  if (setupId.includes("iv") || setupId.includes("vol")) return uniqueColumns([columns.spot, columns.pmIv, columns.optIv30, columns.optIv90]);
  if (setupId.includes("one_touch") || setupId.includes("underlying_cap")) return uniqueColumns([columns.spot, columns.pmIv, columns.optIv30, columns.optIv90]);
  return uniqueColumns([columns.spot, columns.hlPerp, columns.funding, columns.pcRatio, columns.pmIv, columns.optIv30, columns.optIv90]);
}

function buildTruthConclusion(record: SetupTruthRecord): string {
  const e = record.evidenceSummary;
  const tradeRate = e.cleanTrades > 0 ? `${e.tradeWins}/${e.cleanTrades}` : "no clean live trades";
  const shadowRate = e.resolvedShadows > 0 ? `${e.shadowWins}/${e.resolvedShadows}` : "no resolved shadows";
  if (record.status === "contaminated_retest") {
    return `${record.setupLabel} is under clean retest: contaminated or superseded historical evidence is excluded. Clean live trades: ${tradeRate}, avg P&L ${e.avgTradePnlPct.toFixed(2)}%; shadows: ${shadowRate}.`;
  }
  if (record.status === "eligible_live") {
    return `${record.setupLabel} is eligible for live consideration based on grouped setup-family evidence. Clean live trades: ${tradeRate}, avg P&L ${e.avgTradePnlPct.toFixed(2)}%; shadows: ${shadowRate}.`;
  }
  if (record.status === "disabled") {
    return `${record.setupLabel} is disabled or weak on current clean evidence. Clean live trades: ${tradeRate}, avg P&L ${e.avgTradePnlPct.toFixed(2)}%; shadows: ${shadowRate}.`;
  }
  if (record.status === "validating") {
    return `${record.setupLabel} is validating but still sample-size sensitive. Clean live trades: ${tradeRate}, avg P&L ${e.avgTradePnlPct.toFixed(2)}%; shadows: ${shadowRate}.`;
  }
  return `${record.setupLabel} remains exploratory. Clean live trades: ${tradeRate}, avg P&L ${e.avgTradePnlPct.toFixed(2)}%; shadows: ${shadowRate}.`;
}

function finalizeTruthRecord(record: SetupTruthRecord): SetupTruthRecord {
  const e = record.evidenceSummary;
  const tradeWinRate = e.cleanTrades > 0 ? e.tradeWins / e.cleanTrades : null;
  const shadowWinRate = e.resolvedShadows > 0 ? e.shadowWins / e.resolvedShadows : null;
  if (record.knownInvalidAssumptions.length > 0 && e.cleanTrades + e.resolvedShadows < 10) {
    record.status = "contaminated_retest";
  } else if ((e.cleanTrades >= 5 && tradeWinRate !== null && tradeWinRate < KILL_THRESHOLD) || (e.cleanTrades >= 10 && e.avgTradePnlPct < -1)) {
    record.status = "disabled";
  } else if ((e.cleanTrades >= 5 && tradeWinRate !== null && tradeWinRate >= PROMOTE_THRESHOLD && e.avgTradePnlPct > 0) || (e.resolvedShadows >= 10 && shadowWinRate !== null && shadowWinRate >= PROMOTE_THRESHOLD && e.avgShadowPnlPct > 0)) {
    record.status = "eligible_live";
  } else if (e.cleanTrades + e.resolvedShadows + e.hypothesisTests >= 5) {
    record.status = "validating";
  } else {
    record.status = "exploratory";
  }
  record.currentConclusion = buildTruthConclusion(record);
  return record;
}

function buildLlmTruthState(hypotheses: Hypothesis[], weights: SignalWeight[], closedTrades: ClosedTrade[], blockedSignals: BlockedSignalShadow[]): LlmTruthState {
  const generatedAt = new Date().toISOString();
  const hypothesesById = new Map(hypotheses.map((hypothesis) => [hypothesis.id, hypothesis]));
  const records = new Map<string, SetupTruthRecord>();
  const getRecord = (setupId: string, setupLabel: string, assetHint?: string): SetupTruthRecord => {
    const existing = records.get(setupId);
    if (existing) return existing;
    const record: SetupTruthRecord = {
      setupId,
      setupLabel,
      status: "exploratory",
      currentConclusion: "",
      evidenceSummary: {
        cleanTrades: 0,
        tradeWins: 0,
        avgTradePnlPct: 0,
        resolvedShadows: 0,
        shadowWins: 0,
        avgShadowPnlPct: 0,
        hypothesisTests: 0,
        hypothesisWins: 0,
      },
      allowedEvidenceColumns: allowedEvidenceColumnsForSetup(setupId, assetHint),
      knownInvalidAssumptions: DATA_CONTAMINATED_SETUP_IDS.has(setupId)
        ? ["Historical Oil/Gold-derived evidence for this setup family may include contaminated or superseded inputs; use clean post-correction evidence only."]
        : [],
      representativeExamples: [],
      lastReviewedAt: generatedAt,
    };
    records.set(setupId, record);
    return record;
  };

  for (const family of hypothesisSetupFamilies(hypotheses)) {
    const record = getRecord(family.setupId, family.setupLabel, inferHypothesisAsset(family.primary) ?? undefined);
    record.evidenceSummary.hypothesisTests += family.completed.length;
    record.evidenceSummary.hypothesisWins += family.wins;
    if (isDataContaminatedSetup(family.setupId) && record.knownInvalidAssumptions.length === 0) {
      record.knownInvalidAssumptions.push("Historical tests for this family are excluded from promotion until clean retests accumulate.");
    }
    for (const test of family.completed.slice(-2)) {
      record.representativeExamples.push({
        id: family.primary.id,
        kind: "hypothesis",
        outcome: test.outcome,
        note: test.actualMove.slice(0, 180),
      });
    }
  }

  for (const weight of weights) {
    const setup = setupIdForSignalType(weight.type);
    const record = getRecord(setup.setupId, setup.setupLabel);
    if (!weight.enabled && !record.knownInvalidAssumptions.includes("Signal disabled by adaptive weight state.")) {
      record.knownInvalidAssumptions.push("Signal disabled by adaptive weight state.");
    }
  }

  for (const trade of closedTrades) {
    const setup = setupIdForTrade(trade, hypothesesById);
    if (isLearningContaminatedTrade(trade, setup.setupId)) {
      const record = getRecord(setup.setupId, setup.setupLabel, trade.asset);
      if (!record.knownInvalidAssumptions.some((note) => note.includes("contaminated trade"))) {
        record.knownInvalidAssumptions.push("At least one historical contaminated trade was excluded from this setup-family truth record.");
      }
      continue;
    }
    const record = getRecord(setup.setupId, setup.setupLabel, trade.asset);
    const e = record.evidenceSummary;
    e.cleanTrades++;
    if (trade.pnl >= 0) e.tradeWins++;
    e.avgTradePnlPct = ((e.avgTradePnlPct * (e.cleanTrades - 1)) + trade.pnlPct) / e.cleanTrades;
    if (record.representativeExamples.length < 4) {
      record.representativeExamples.push({
        id: trade.id,
        kind: "trade",
        outcome: trade.pnl >= 0 ? "win" : "loss",
        pnlPct: Number(trade.pnlPct.toFixed(2)),
        note: `${trade.asset} ${trade.direction} ${trade.closeReason} via ${trade.venue}/${trade.instrumentType ?? "legacy"}`,
      });
    }
  }

  for (const shadow of blockedSignals) {
    if (shadow.status !== "resolved" || !shadow.hypotheticalResult || shadow.learningExcluded) continue;
    const setup = setupIdForShadow(shadow);
    const record = getRecord(setup.setupId, setup.setupLabel, shadow.asset);
    const e = record.evidenceSummary;
    e.resolvedShadows++;
    if (shadow.hypotheticalResult.outcome === "win") e.shadowWins++;
    e.avgShadowPnlPct = ((e.avgShadowPnlPct * (e.resolvedShadows - 1)) + shadow.hypotheticalResult.pnlPct) / e.resolvedShadows;
    if (record.representativeExamples.length < 4) {
      record.representativeExamples.push({
        id: shadow.id,
        kind: "shadow",
        outcome: shadow.hypotheticalResult.outcome,
        pnlPct: Number(shadow.hypotheticalResult.pnlPct.toFixed(2)),
        note: `${shadow.blockedReason}: ${shadow.signalType} ${shadow.asset} ${shadow.direction}`,
      });
    }
  }

  const setupFamilies = Array.from(records.values())
    .map((record) => {
      record.evidenceSummary.avgTradePnlPct = Number(record.evidenceSummary.avgTradePnlPct.toFixed(4));
      record.evidenceSummary.avgShadowPnlPct = Number(record.evidenceSummary.avgShadowPnlPct.toFixed(4));
      record.representativeExamples = record.representativeExamples.slice(0, 4);
      return finalizeTruthRecord(record);
    })
    .sort((a, b) => b.evidenceSummary.cleanTrades + b.evidenceSummary.resolvedShadows - (a.evidenceSummary.cleanTrades + a.evidenceSummary.resolvedShadows));

  return {
    generatedAt,
    contaminationRules: [
      {
        id: "oil_gold_pc_cl_source_cleanup",
        description: "Exclude historical Oil/Gold P/C and CL-derived conclusions that predate corrected data/source handling.",
        affectedSetupIds: Array.from(DATA_CONTAMINATED_SETUP_IDS),
        affectedColumns: ["oil_cl_pc_ratio", "gold_gld_pc_ratio", "oil_pm_settle_ev", "gold_pm_settle_ev"],
      },
    ],
    setupFamilies,
  };
}

function llmCloseEligibilityForPosition(
  position: Position,
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
): CandidateActions["llmCloseEligibility"][number] {
  const signalOwned = position.signalType === "LLM_HYPOTHESIS" || position.signalType === "PROMOTED_HYPOTHESIS";
  const mechanicalEligible = isMechanicalLlmCloseEligible(position.signalType);
  const llmCloseEligible = signalOwned || mechanicalEligible;
  const timing = positionTimingContext(position);
  const minHoldHours = llmCloseMinHoldHours(position, timing);
  const mark = markPosition(position, latestRow, snapshots, true);
  const baseCategories: NonNullable<LlmTradeInstruction["closeReasonCategory"]>[] = signalOwned
    ? ["thesis_invalidated", "data_quality_issue", "hard_portfolio_risk", "risk_stale", "profit_taking"]
    : mechanicalEligible
      ? ["thesis_invalidated", "data_quality_issue", "hard_portfolio_risk"]
      : [];
  const conservativeCategories: NonNullable<LlmTradeInstruction["closeReasonCategory"]>[] = ["data_quality_issue", "hard_portfolio_risk"];
  const profitableEnoughForEarlyTake =
    signalOwned
    && mark !== null
    && position.targetPct !== null
    && mark.pnlPct >= position.targetPct * LLM_PROFIT_TAKE_TARGET_FRACTION;
  if (profitableEnoughForEarlyTake) conservativeCategories.push("profit_taking");

  let allowed = llmCloseEligible;
  let allowedCategories = baseCategories;
  let reason = signalOwned
    ? `LLM-owned/promoted setup may be closed after ${LLM_CLOSE_MIN_HOLD_HOURS}h if signal-family evidence supports it.`
    : mechanicalEligible
      ? `Mechanical ${position.signalType} setup may be closed after ${LLM_CLOSE_MIN_HOLD_HOURS}h only when the signal's own input has reversed (thesis_invalidated), or for hard portfolio risk / data quality. Profit-taking remains mechanical.`
      : "Rule-based signal exits remain mechanical; LLM closes are not allowed.";

  if (llmCloseEligible && (timing.hoursOpen === null || timing.hoursOpen < LLM_CLOSE_MIN_HOLD_HOURS)) {
    allowed = false;
    allowedCategories = [];
    const observed = timing.hoursOpen === null ? "unknown" : `${timing.hoursOpen.toFixed(1)}h`;
    reason = `Too new for discretionary LLM close: open ${observed}, requires at least ${LLM_CLOSE_MIN_HOLD_HOURS}h.`;
  } else if (signalOwned && timing.hoursOpen !== null && timing.hoursOpen < minHoldHours) {
    allowed = true;
    allowedCategories = conservativeCategories;
    reason = `Long-dated trade is only ${(timing.elapsedHoldPct === null ? 0 : timing.elapsedHoldPct * 100).toFixed(1)}% through planned hold; early LLM closes limited to hard risk/data quality${profitableEnoughForEarlyTake ? "/profit-taking near target" : ""} until ${minHoldHours.toFixed(1)}h.`;
  }

  return {
    positionId: position.id,
    signalType: position.signalType,
    asset: position.asset,
    venue: position.venue,
    direction: position.direction,
    allowed,
    allowedCategories,
    evidenceColumns: signalFamilyEvidenceColumns(position),
    hoursOpen: timing.hoursOpen === null ? null : Number(timing.hoursOpen.toFixed(2)),
    hoursToExpiry: timing.hoursToExpiry === null ? null : Number(timing.hoursToExpiry.toFixed(2)),
    plannedHoldHours: timing.plannedHoldHours === null ? null : Number(timing.plannedHoldHours.toFixed(2)),
    elapsedHoldPct: timing.elapsedHoldPct === null ? null : Number(timing.elapsedHoldPct.toFixed(4)),
    minHoldHours: Number(minHoldHours.toFixed(2)),
    reason,
  };
}

function buildCandidateActions(portfolio: Portfolio, weights: SignalWeight[], signals: Signal[], latestRow: SnapshotRow, snapshots: InstrumentSnapshotFile[]): CandidateActions {
  const mechanicalExits = portfolio.positions
    .map((position) => {
      const reason = mechanicalCloseReason(position, markPosition(position, latestRow, snapshots, true));
      return reason ? { positionId: position.id, reason } : null;
    })
    .filter((row): row is { positionId: string; reason: ClosedTrade["closeReason"] } => !!row);
  const signalKillExits = portfolio.positions
    .filter((position) => {
      const weight = weights.find((candidate) => candidate.type === position.signalType);
      const perAsset = weight?.perAsset?.[position.asset];
      return !!weight && (!weight.enabled || perAsset?.disabled === true);
    })
    .map((position) => ({ positionId: position.id, signalType: position.signalType, asset: position.asset }));
  const llmCloseEligibility = portfolio.positions.map((position) => llmCloseEligibilityForPosition(position, latestRow, snapshots));
  return {
    generatedAt: new Date().toISOString(),
    mechanicalExits,
    signalKillExits,
    entryCandidates: signals,
    llmCloseEligibility,
  };
}

function gateLlmAdvice(llmResult: LlmAnalysisResult | null, portfolio: Portfolio, candidateActions: CandidateActions): GatedLlmAdvice {
  const acceptedCloses: LlmTradeInstruction[] = [];
  const rejectedCloses: GatedLlmAdvice["rejectedCloses"] = [];
  const skippedTrades: GatedLlmAdvice["skippedTrades"] = [];
  if (!llmResult) return { acceptedCloses, rejectedCloses, skippedTrades, parameterUpdates: undefined };

  for (const instruction of llmResult.trades ?? []) {
    if (instruction.action !== "close") {
      skippedTrades.push({ instruction, reason: "Direct LLM entries remain disabled; hypotheses must be promoted before trading." });
      continue;
    }
    if (!ALLOW_HOURLY_LLM_CLOSES) {
      rejectedCloses.push({ instruction, reason: "LLM close rejected: hourly discretionary closes are disabled; minute scanner handles mechanical exits." });
      continue;
    }
    if (!instruction.positionId) {
      rejectedCloses.push({ instruction, reason: "LLM close rejected: missing positionId." });
      continue;
    }
    const position = portfolio.positions.find((candidate) => candidate.id === instruction.positionId);
    if (!position) {
      rejectedCloses.push({ instruction, reason: `LLM close rejected: unknown positionId ${instruction.positionId}.` });
      continue;
    }
    if (instruction.asset !== position.asset || instruction.venue !== position.venue || (instruction.direction !== "any" && instruction.direction !== position.direction)) {
      rejectedCloses.push({ instruction, reason: "LLM close rejected: position identity fields do not match the requested positionId." });
      continue;
    }
    const eligibility = candidateActions.llmCloseEligibility.find((row) => row.positionId === position.id);
    if (!eligibility?.allowed) {
      rejectedCloses.push({ instruction, reason: "LLM close rejected: position is not eligible for LLM exits." });
      continue;
    }
    const category = instruction.closeReasonCategory ?? "thesis_invalidated";
    if (!eligibility.allowedCategories.includes(category)) {
      rejectedCloses.push({ instruction, reason: `LLM close rejected: category ${category} is not allowed for ${position.signalType}.` });
      continue;
    }
    const evidenceColumns = instruction.evidenceColumns ?? [];
    const invalidEvidence = evidenceColumns.filter((column) => !eligibility.evidenceColumns.includes(column));
    if (invalidEvidence.length > 0 && category !== "hard_portfolio_risk" && category !== "data_quality_issue") {
      rejectedCloses.push({ instruction, reason: `LLM close rejected: evidence columns outside signal family (${invalidEvidence.join(", ")}).` });
      continue;
    }
    if (position.signalType !== "LLM_HYPOTHESIS" && position.signalType !== "PROMOTED_HYPOTHESIS" && category === "profit_taking") {
      rejectedCloses.push({ instruction, reason: "LLM close rejected: profit-taking on rule-based signals is handled by mechanical targets." });
      continue;
    }
    acceptedCloses.push(instruction);
  }

  return {
    acceptedCloses,
    rejectedCloses,
    skippedTrades,
    parameterUpdates: llmResult.parameterUpdates,
  };
}

function buildExecutionPlan(candidateActions: CandidateActions, gatedAdvice: GatedLlmAdvice, signals: Signal[]): ExecutionPlan {
  return {
    generatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    llmDryRun: LLM_DRY_RUN,
    mechanicalExits: candidateActions.mechanicalExits,
    signalKillExits: candidateActions.signalKillExits,
    llmCloses: gatedAdvice.acceptedCloses,
    entrySignals: signals.sort((a, b) => b.confidence - a.confidence),
    rejectedLlmActions: gatedAdvice.rejectedCloses,
    skippedLlmActions: gatedAdvice.skippedTrades,
    notes: [
      MUTATION_DISABLED ? "Executor mutations disabled for dry-run verification." : "Executor mutations enabled.",
      `${gatedAdvice.acceptedCloses.length} LLM closes accepted; ${gatedAdvice.rejectedCloses.length} rejected; ${gatedAdvice.skippedTrades.length} non-close instructions skipped.`,
    ],
  };
}

async function executeApprovedPlan(
  plan: ExecutionPlan,
  portfolio: Portfolio,
  latestRow: SnapshotRow,
  snapshots: InstrumentSnapshotFile[],
  learningParams: LearningParams,
  blockedSignals: BlockedSignalShadow[],
): Promise<{ llmClosedTrades: ClosedTrade[]; openedPositions: Position[] }> {
  if (plan.dryRun || plan.llmDryRun) return { llmClosedTrades: [], openedPositions: [] };
  const llmClosedTrades = closePositionsFromLlm(portfolio, plan.llmCloses, latestRow, snapshots);
  const openedPositions = await openPositions(portfolio, plan.entrySignals, latestRow, snapshots, learningParams, blockedSignals);
  return { llmClosedTrades, openedPositions };
}

function writeLeanArtifacts(engineState: EngineState, truthState: LlmTruthState, candidateActions: CandidateActions, gatedAdvice: GatedLlmAdvice | null, executionPlan: ExecutionPlan | null) {
  writeJson(ENGINE_STATE_FILE, engineState);
  writeJson(LLM_TRUTH_STATE_FILE, truthState);
  writeJson(CANDIDATE_ACTIONS_FILE, candidateActions);
  if (gatedAdvice) writeJson(LLM_ADVICE_FILE, gatedAdvice);
  if (executionPlan) writeJson(EXECUTION_PLAN_FILE, executionPlan);
}

function writeDryRunVerification(engineState: EngineState, candidateActions: CandidateActions, executionPlan: ExecutionPlan | null) {
  if (!MUTATION_DISABLED && !SHADOW_ARCHITECTURE) return;
  writeJson(DRY_RUN_VERIFICATION_FILE, {
    generatedAt: new Date().toISOString(),
    mutationDisabled: MUTATION_DISABLED,
    checks: {
      portfolioPositions: engineState.portfolio.openPositions,
      mechanicalExitCandidates: candidateActions.mechanicalExits.length,
      signalKillExitCandidates: candidateActions.signalKillExits.length,
      entryCandidates: candidateActions.entryCandidates.length,
      llmClosesAccepted: executionPlan?.llmCloses.length ?? 0,
      llmClosesRejected: executionPlan?.rejectedLlmActions.length ?? 0,
    },
    protectedStateFiles: [
      "portfolio.json",
      "trades-detailed.csv",
      "learning-journal.md",
      "hypotheses.json",
      "signal-weights.json",
      "blocked-signals.json",
      "learning-params.json",
    ],
  });
}

// ─── LLM Integration ─────────────────────────────────────────────────────────

function extractBalancedJsonObject(text: string): string | null {
  const candidates: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") candidates.push(i);
  }

  for (const start of candidates) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = inString;
        continue;
      }
      if (ch === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

const llmTradeInstructionSchema = z.object({
  action: z.enum(["buy", "sell", "close"]),
  positionId: z.string().min(1).optional(),
  asset: z.string().min(1),
  venue: z.enum(["polymarket", "hyperliquid", "spot"]),
  direction: z.enum(["long", "short", "any"]),
  closeReasonCategory: z.enum(["thesis_invalidated", "data_quality_issue", "hard_portfolio_risk", "risk_stale", "profit_taking"]).optional(),
  evidenceColumns: z.array(z.string().min(1)).optional(),
  thesis: z.string().min(1),
});

const llmNewHypothesisSchema = z.object({
  created: z.string().min(1),
  description: z.string().min(1),
  conditions: z.record(z.string(), z.string()),
  prediction: z.string().min(1),
  timeframeDays: z.number().int().min(1).max(30),
  confidence: z.number().min(0).max(1),
  direction: z.enum(["long", "short", "neutral"]),
  source: z.literal("llm"),
});

const llmSignalRiskUpdateSchema = z.object({
  targetPct: z.number().min(0.5).max(15).nullable().optional(),
  stopPct: z.number().min(0.5).max(10).optional(),
});

const llmParameterUpdatesSchema = z.object({
  macroMomentum24hThresholdPts: z.number().min(2).max(20).optional(),
  contrarianTrendMarginPct: z.number().min(0).max(5).optional(),
  positiveMomentum24hPct: z.number().min(0).max(10).optional(),
  llmTradeExpiryDays: z.number().int().min(3).max(30).optional(),
  momentumLongExpiryDays: z.number().int().min(3).max(45).optional(),
  signalRisk: z.record(z.string(), llmSignalRiskUpdateSchema).optional(),
}).optional();

const llmAnalysisResultSchema = z.object({
  marketAssessment: z.string().min(1),
  newHypotheses: z.array(llmNewHypothesisSchema),
  hypothesisReviews: z.array(z.object({
    id: z.string().min(1),
    observation: z.string().min(1),
  })),
  trades: z.array(llmTradeInstructionSchema),
  parameterUpdates: llmParameterUpdatesSchema,
  journalEntry: z.string().min(1),
});

function validateLlmResult(value: unknown): { result: LlmAnalysisResult | null; error: string | null } {
  const parsed = llmAnalysisResultSchema.safeParse(value);
  if (parsed.success) return { result: parsed.data as LlmAnalysisResult, error: null };
  const issues = parsed.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  return { result: null, error: `Schema validation failed: ${issues}` };
}

function stripLockedSignalRiskUpdates(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const root = raw as Record<string, unknown>;
  const updates = root.parameterUpdates;
  if (!updates || typeof updates !== "object") return;
  const signalRisk = (updates as Record<string, unknown>).signalRisk;
  if (!signalRisk || typeof signalRisk !== "object") return;
  for (const key of Object.keys(signalRisk as Record<string, unknown>)) {
    if (LLM_LOCKED_SIGNAL_RISK.has(key)) delete (signalRisk as Record<string, unknown>)[key];
  }
}

function parseLlmJson(text: string): { result: LlmAnalysisResult | null; error: string | null; jsonText: string | null } {
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const jsonText = extractBalancedJsonObject(trimmed);
  if (!jsonText) return { result: null, error: "No balanced JSON object found in response", jsonText: null };

  try {
    const parsed = JSON.parse(jsonText);
    stripLockedSignalRiskUpdates(parsed);
    const validation = validateLlmResult(parsed);
    return { result: validation.result, error: validation.error, jsonText };
  } catch (e: any) {
    return { result: null, error: e.message, jsonText };
  }
}

function anthropicText(data: any): string {
  const content = Array.isArray(data?.content) ? data.content : [];
  return content
    .map((block: any) => typeof block?.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

const LLM_PROVIDER = process.env.LLM_PROVIDER ?? "anthropic";
const LLM_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 300_000);

type LmMessage = { role: "user" | "assistant"; content: string };

async function requestLlmText(
  apiKey: string,
  model: string,
  messages: LmMessage[],
): Promise<{ text: string; stopReason: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

  try {
    if (LLM_PROVIDER === "deepseek") {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          temperature: 0.2,
          messages,
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`DeepSeek API error: ${res.status} ${res.statusText}`);
      const data = await res.json() as any;
      const choice = data?.choices?.[0];
      return {
        text: choice?.message?.content?.trim() ?? "",
        stopReason: choice?.finish_reason ?? null,
      };
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        temperature: 0.2,
        messages,
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as any;
    return { text: anthropicText(data), stopReason: data.stop_reason ?? null };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`LLM request timeout after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function callLLM(
  valuationRows: SnapshotRow[],
  macroRows: SnapshotRow[],
  instrumentSnapshots: InstrumentSnapshotFile[],
  portfolio: Portfolio,
  learningParams: LearningParams,
  weights: SignalWeight[],
  hypotheses: Hypothesis[],
  statObs: StatObservation[],
  closedTrades: ClosedTrade[],
  blockedSummary: BlockedSignalLearningSummary,
  relativeValueRows: RelativeValueObservation[],
  journalTail: string,
  engineState: EngineState,
  truthState: LlmTruthState,
  candidateActions: CandidateActions,
): Promise<LlmAnalysisResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const llmModel = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

  const recentValuations = sanitizeValuationsForLlm(valuationRows.slice(-14));
  const recentMacro = macroRows.slice(-14);
  // Only the latest instrument snapshot is sent to the LLM. Per-asset hourly
  // trajectory (spot / IV / funding / OI / PC ratio) is already provided in
  // the denser MARKET DATA section above (14 hourly rows), so historical
  // instrument snapshots add no unique information and previously bloated
  // the prompt by ~390 KB / cycle (~$0.33/call) by duplicating the full
  // Polymarket contract list 4 times. The latest snapshot is retained
  // because the decoder (formatOneTouchDirectionalLine) and signal-family
  // gates need access to current per-contract structure via
  // latestInstrumentSnapshot(), and the latest option chain summary is the
  // only source of options OI / volume / chain breadth in the prompt.
  const recentInstruments = instrumentSnapshots.slice(-1).map(compactInstrumentSnapshotForLlm);
  const activeHypotheses = hypotheses.filter((h) => h.status === "active" || h.status === "promoted");
  const killedRecently = hypotheses.filter((h) => h.status === "killed").slice(-5);
  const activeWeights = weights.filter((w) => w.trades > 0);
  const hypothesisBacklog = llmHypothesisBacklog(hypotheses);
  const openPositionContext = openPositionContextForLlm(portfolio.positions, valuationRows, instrumentSnapshots);
  const hybridBotCtx = loadHybridBotContext();
  const hybridStrategyDoc = loadHybridStrategyDoc();

  const prompt = `You are a quantitative paper trading system analyzing cross-venue market data. Your job is to:
1. Assess the current market state
2. Propose NEW testable hypotheses about patterns in the data
3. Review existing hypotheses
4. Suggest specific trades

MARKET DATA (last ${recentValuations.length} snapshots):
${JSON.stringify(recentValuations, null, 1)}

MACRO DATA (last ${recentMacro.length} snapshots):
${JSON.stringify(recentMacro, null, 1)}

INSTRUMENT SNAPSHOTS (latest run only — per-asset hourly trajectory is in MARKET DATA above):
${JSON.stringify(recentInstruments, null, 1)}

PORTFOLIO:
Cash: $${portfolio.cash.toFixed(2)} | Open positions: ${portfolio.positions.length} | Realized P&L: $${portfolio.totalRealizedPnl.toFixed(2)}
Win rate: ${portfolio.totalTrades > 0 ? ((portfolio.winCount / portfolio.totalTrades) * 100).toFixed(0) : "N/A"}% over ${portfolio.totalTrades} trades

OPEN POSITIONS:
${openPositionContext}

CANONICAL ENGINE STATE:
${JSON.stringify(engineState, null, 1)}

CANONICAL CURRENT TRUTH BY SETUP FAMILY:
${JSON.stringify(truthState, null, 1)}

ALLOWED ACTION SURFACE:
${JSON.stringify({
  llmCloseEligibility: candidateActions.llmCloseEligibility,
  candidateEntryCount: candidateActions.entryCandidates.length,
  mechanicalExitCount: candidateActions.mechanicalExits.length,
  signalKillExitCount: candidateActions.signalKillExits.length,
}, null, 1)}

SIGNAL PERFORMANCE:
${activeWeights.map((w) => {
  const disabledAssets = Object.entries(w.perAsset ?? {})
    .filter(([, stats]) => stats.disabled)
    .map(([asset, stats]) => `${asset} disabled (${stats.wins}/${stats.trades} wins, avg pnl=${stats.avgPnlPct.toFixed(2)}%)`)
    .join("; ");
  return `  ${w.type}: weight=${w.weight.toFixed(2)}, ${w.wins}/${w.trades} wins (${w.trades > 0 ? ((w.wins / w.trades) * 100).toFixed(0) : "N/A"}%), avg pnl=${w.avgPnlPct.toFixed(2)}%${disabledAssets ? ` | disabled assets: ${disabledAssets}` : ""}`;
}).join("\n") || "  No trades yet"}

ACTIVE HYPOTHESES:
${activeHypotheses.map((h) => `  ${h.id} (${h.setupId ?? "unclassified"}): ${h.description} [${h.status}, ${(h.winRate * 100).toFixed(0)}% over ${h.tests.length} variant tests]`).join("\n") || "  None yet"}

HYPOTHESIS SHADOW TEST BACKLOG:
${JSON.stringify(hypothesisBacklog, null, 1)}
${hypothesisBacklog.complete ? "Existing LLM setup-family backlog is complete; new hypotheses may be proposed." : `Do NOT propose unrelated new setup families right now. Existing LLM setup families still need condition-triggered repeat shadow tests (${hypothesisBacklog.needingTests}/${hypothesisBacklog.setupFamilies} setup families need more tests, ${hypothesisBacklog.pending} pending). Only the first ${HYPOTHESIS_SETUP_RETEST_ACTIVE_LIMIT} setup families are active for retesting; others wait. You MAY propose regime-relative replacement variants for already-promoted setup families when existing variants use brittle absolute price levels. Otherwise return newHypotheses: [] and focus on reviewing/testing existing setup families.`}
Retired LLM setup families are blocked from live trading and new hypothesis creation: ${Array.from(RETIRED_LLM_SETUP_IDS).join(", ")}. Do not recreate these broad families under a new name; propose only narrower replacement variants with distinct measurable inputs.
Current live production signal allowlist: ${Array.from(LIVE_SIGNAL_ALLOWLIST).join(", ")} plus promoted hypothesis IDs ${Array.from(LIVE_PROMOTED_HYPOTHESIS_IDS).join(", ")}. Treat all other signal families as shadow/research only.
Active LLM hypothesis families that may continue shadow testing after regime-relative rewrites:
  - BTC dealer hedge stress / pullback: SHORT BTC pullback only; requires near-high spot, stressed front IV/term structure, and crowded long positioning.
  - PM odds / underlying payoff cap: Polymarket one-touch cap-ratio only; rich/over-cap upside contracts are buy-NO or avoid-YES, deeply cheap cap-adjusted upside contracts are buy-YES.
  - BTC momentum / correlation breakout: LONG BTC momentum continuation only; requires spot strength relative to recent trend and optional HYPE confirmation, not absolute BTC price levels.
  - AMZN options positioning / momentum: LONG AMZN momentum only; requires low put-call ratio relative to its own history plus positive stock momentum, not fixed stock prices.
  - HYPE funding/OI long bounce: LONG HYPE bounce only; requires funding in its low/negative regime, OI stabilizing, and spot lifting from recent lows.
  - HYPE funding/OI liquidation short: SHORT HYPE liquidation only; requires funding in its high/crowded-long regime, OI falling, and spot losing short-term trend.
Do not mix long-bounce and liquidation-short HYPE evidence in a single hypothesis. Every hypothesis description should name LONG or SHORT and every prediction should match that direction.

RECENTLY KILLED HYPOTHESES:
${killedRecently.map((h) => `  ${h.id}: ${h.description} — ${h.postMortem}`).join("\n") || "  None"}

STATISTICAL OBSERVATIONS:
${statObs.map((o) => `  [${o.type}] ${o.description}`).join("\n") || "  None"}

RECENT CLOSED TRADES:
${closedTrades.slice(-10).map((t) => `  ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} ${t.closeReason}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (market=${(t.marketPnl ?? t.pnl).toFixed(4)}, funding=${(t.fundingPnl ?? 0).toFixed(4)}) [${t.instrumentLabel ?? "n/a"}]`).join("\n") || "  None"}

HYPERLIQUID HYBRID BOT — RECENT ACTIVITY (read-only context; not your trades):
${formatHybridBotSection(hybridBotCtx)}
${hybridStrategyDoc ? `\nHYPERLIQUID HYBRID BOT — STRATEGY CONTEXT:\n${hybridStrategyDoc}` : ""}

CURRENT LEARNABLE PARAMETERS:
${JSON.stringify(learningParams, null, 2)}

BLOCKED SIGNAL SHADOW LEARNING:
${JSON.stringify(blockedSummary, null, 1)}

RELATIVE-VALUE HEATMAP OBSERVATIONS (ranked by absolute executable edge):
${serializeRelativeValueRowsForLlm(relativeValueRows)}

AUDIT LOG TAIL${DRY_RUN ? " (dry-run debug only; not canonical truth)" : " (not canonical decision truth)"}:
${DRY_RUN ? (journalTail || "  No entries yet") : "  Omitted from decision context. Use CANONICAL CURRENT TRUTH BY SETUP FAMILY instead."}

IMPORTANT RULES:
- Each hypothesis MUST be specific and testable with a clear timeframe (1-14 days)
- Each hypothesis MUST define measurable conditions using column names from the data
- Prefer regime-relative conditions over hard-coded price levels so promoted setup families can generalize across BTC/HYPE/GOLD/OIL/AMZN price regimes. Use absolute spot thresholds only when the exact level is essential to the thesis.
- Supported derived condition keys:
  - <column>_pct_from_<N>h_high / <column>_pct_from_<N>d_high, e.g. btc_spot_pct_from_7d_high > -3
  - <column>_pct_from_<N>h_low / <column>_pct_from_<N>d_low, e.g. btc_spot_pct_from_3d_low > 2
  - <column>_pct_vs_<N>h_sma / <column>_pct_vs_<N>d_sma, e.g. btc_spot_pct_vs_24h_sma > 0
  - <column>_percentile_<N>h / <column>_percentile_<N>d, e.g. btc_ibit_pc_ratio_percentile_30d < 15
  - <column>_zscore_<N>h / <column>_zscore_<N>d, e.g. btc_pm_iv_zscore_30d < -2
  - <column>_change_pct_<N>h / <column>_change_pct_<N>d, e.g. btc_spot_change_pct_24h > 1.5
- For promoted setup-family variants, describe the reusable setup in relative terms such as "within 3% of 7d high", "bottom 15th percentile P/C ratio", "PM IV z-score below -2", or "spot above 24h SMA" instead of "BTC above 78k".
- Every newHypothesis MUST include a direction field: "long" if the spot/perp price is predicted to go up, "short" if predicted down, "neutral" for vol/IV/spread/basis theses that do NOT carry a directional spot view (e.g. "BTC IV expands as PM IV mean reverts" — the price could go either way). Direction is enforced as the authoritative signal when the hypothesis is later promoted; do NOT rely on the engine to infer direction from prose. If the thesis is contrarian, "long" still means buy spot (e.g. "P/C extreme high → contrarian long" is direction=long, not short).
- Existing LLM hypotheses must receive ${HYPOTHESIS_SHADOW_TESTS_REQUIRED} condition-triggered shadow tests before promotion/kill/inconclusive demotion. Do not create new hypotheses while the backlog is incomplete.
- Similar hypotheses are grouped into setup families. Promotion/kill decisions happen at the setup-family level, not per wording variant. Prefer reviewing whether the parent setup is working over proposing near-duplicate threshold variants.
- Generic live LLM_HYPOTHESIS entries are retired. The LLM may propose hypotheses for shadow testing and may advise eligible closes, but live entries require a non-retired promoted setup family.
- Focus on cross-venue divergences and patterns the rule-based system can't detect
- Be honest about what's working and what isn't
- If a pattern stopped working, explain WHY you think it changed
- Trade sizes are always $1, max $100 bankroll
- Available venues: polymarket, hyperliquid, spot
- Available assets: BTC, HYPE, GOLD, AMZN, OIL
- Polymarket trades are real contract simulations: long = buy YES, short = buy NO on a specific contract
- Hyperliquid trades are perp simulations and include funding carry in realized P&L
- Hyperliquid funding sign convention: negative funding means shorts pay longs, so a FUNDING_EXTREME_SHORT long benefits from negative funding carry. More-negative funding is thesis continuation/intensification, not a carry cost and not by itself a close reason. Positive funding means longs pay shorts, so a FUNDING_EXTREME_LONG short benefits from positive funding carry. Only treat funding as thesis weakening when it normalizes materially toward zero/flips sign or when price action fails over the intended hold/risk window despite favorable carry.
- Spot trades are marked only to the underlying spot price
- Prefer polymarket only for assets with explicit contracts in the instrument snapshots
- If you suggest parameter changes, keep them incremental and evidence-based
- Use BLOCKED SIGNAL SHADOW LEARNING to judge whether filters are too strict or appropriately defensive. If a blocked short loses money, the block was directionally correct.
- Separately evaluate market quality. A blocked trade can be correctly blocked by trend AND still be a bad setup because the Polymarket bid/ask is too wide or liquidity is too thin.
- Never treat one-sided Polymarket entries below ${(MIN_ONE_SIDED_PM_ENTRY_PRICE * 100).toFixed(0)}c as legitimate learning evidence or valid trades. Sub-cent entries are near-resolved artifacts, not the thesis the trader is testing; exclude them from performance conclusions and avoid reopening them.
- Avoid suggesting generic Polymarket trades when yesSpread > ${(HEATMAP_SHADOW_MAX_SPREAD * 100).toFixed(0)}c, liquidity < ${HEATMAP_SHADOW_MIN_LIQUIDITY}, or marketQuality flags include wide_pm_spread / low_pm_liquidity / missing_bid_ask. Treat those as "avoid due to spread/liquidity", not as clean directional evidence. The touch-market shadow-promotion rule below has its own stricter liquidity and explicit 3c max-spread gate from the dedicated backtest.
- Use RELATIVE-VALUE HEATMAP OBSERVATIONS to look for clean cross-venue edges. If you suggest a trade because of this section, say "relative-value heatmap" in the thesis so its performance can be reviewed.
- HYPERLIQUID HYBRID BOT activity is informational only. Do NOT emit trades, closes, or hypotheses targeting the alt coins in that bot's universe (ADA/APT/ARB/AVAX/BCH/CRV/DOT/FARTCOIN/INJ/LIDO/OP/TRUMP). Use its current regime (bull/bear) and recent closed-trade tape as a cross-check on broad crypto-alt risk appetite. A sustained bull regime with positive recent closes ≈ alt breadth healthy; a flip back to bear with losing shorts ≈ breakouts dominating ranges. Do not over-weight a sample of < ~30 closed trades.
- Touch-market shadow-promotion guidance from May 14+ backtest: only promote NO-side touch trades. Hard avoid YES contracts and NO trades with sell_yes_edge_pts < ${ONE_TOUCH_NO_SHADOW_MIN_SELL_YES_EDGE_PTS}. Require spread <= ${(ONE_TOUCH_NO_SHADOW_MAX_SPREAD * 100).toFixed(0)}c and liquidity >= ${ONE_TOUCH_NO_SHADOW_MIN_LIQUIDITY}. Exit when sell_yes_edge_pts disappears or falls below the gate. Why: spread-filtered generic NO was weak (-2.92% avg, -76.50c total one-share P&L); positive sell-YES edge NO improved materially (-0.38% avg, +34.60c); adding edge-disappearance exits turned it positive (+2.44% avg, +81.55c), a +158.05c total-cent improvement versus generic NO. Treat edge size as a gate for now, but keep evaluating edge-size buckets because more data may show edge magnitude is predictive.
- For upside "hit/reach" contracts, use underlyingCapYes and pmToUnderlyingCapRatio to interpret sentiment against the underlying payoff cap. A ratio above 1.0 means PM YES is richer than the spot/strike cap; 0.85-1.0 means very bullish cap-adjacent pricing; below ~0.35 means weak sentiment relative to the underlying upside payoff.
- Supported hypothesis aggregate keys for this cap-ratio setup: btc_pm_underlying_cap_ratio_max/min/avg, hype_pm_underlying_cap_ratio_max/min/avg, gold_pm_underlying_cap_ratio_max/min/avg, oil_pm_underlying_cap_ratio_max/min/avg, and the matching *_edge_pts_max/min/avg keys. Add _tight before the comparison suffix to require spread <= ${(UNDERLYING_CAP_ENTRY_MAX_SPREAD * 100).toFixed(0)}c and liquidity >= ${UNDERLYING_CAP_ENTRY_MIN_LIQUIDITY}, e.g. btc_pm_underlying_cap_ratio_max_tight > ${UNDERLYING_CAP_BUY_NO_RATIO.toFixed(2)} for buy-NO over-cap tests or btc_pm_underlying_cap_ratio_min_tight < ${UNDERLYING_CAP_BUY_YES_RATIO.toFixed(2)} for buy-YES cheap-vs-cap tests.
- Treat GOLD/OIL settle-at bucket markets as drifting Polymarket bucket-forwards / volatility shape indicators, not fair-value anchors for spot. Columns named *_pm_settle_ev are probability-weighted settlement-bucket values from Polymarket; they have their own drift and may stay far from spot for long periods. Do NOT argue that spot should revert to *_pm_settle_ev, and do NOT cite a static PM/spot gap as new close evidence. Anti-pattern: "oil_pm_settle_ev is $87 while spot is $97, so spot should drift to $87" — wrong unless oil_pm_settle_ev itself moved materially since the trade opened and belongs to the signal family under review. Supported aggregate keys: gold_pm_settle_yes_sum_max/min/avg, gold_pm_settle_overround_max/min/avg, gold_pm_settle_tail_yes_max/min/avg, gold_pm_settle_skew_yes_max/min/avg, plus oil_* equivalents. yes_sum/overround measure bucket-price breadth, tail_yes measures total top+bottom tail demand, and skew_yes measures upside minus downside tail demand.
- Settlement-bucket volatility hypotheses must be replicable across changing ladders: use aggregate bucket metrics from the current active market prices, not hard-coded strikes or price levels. "Top tail" means the highest active settle-at bucket; "bottom tail" means the lowest active settle-at bucket.
- You may return \"action: close\" to exit an existing open position only when ALLOWED ACTION SURFACE says allowed=true for that exact positionId and the requested category is listed in allowedCategories.
- LLM-owned/promoted trades need at least ${LLM_CLOSE_MIN_HOLD_HOURS}h before discretionary closes. Long-dated trades may have a higher minHoldHours; if they are still early in their planned hold, do not make drastic thesis calls from short-term noise unless the allowed category is hard_portfolio_risk, data_quality_issue, or explicitly allowed profit_taking near target.
- If a position is below minHoldHours or allowed=false, discuss concerns in journalEntry/hypothesisReviews only; do not emit a close instruction.
- Every close instruction MUST include the exact positionId from OPEN POSITIONS and ALLOWED ACTION SURFACE.
- Every close instruction SHOULD include closeReasonCategory and evidenceColumns. Allowed categories are thesis_invalidated, data_quality_issue, hard_portfolio_risk, risk_stale, profit_taking.
- Rule-based signal closes are policy-gated. Profit-taking on rule-based signals is rejected; mechanical targets handle routine profit-taking.
- For close decisions, use each open position's "Signal-family evidence metrics" as the primary evidence. Do not justify closing a P/C-ratio trade with PM EV, funding, macro, or other context-only metrics unless there is a hard portfolio risk breach; if context-only metrics were already present at entry, do not describe them as new evidence.
- For \"action: close\", set direction to long, short, or any and include positionId to identify which existing position to close.
- Keep parameter updates inside these bounds:
  - macroMomentum24hThresholdPts: 2 to 20
  - contrarianTrendMarginPct: 0 to 5
  - positiveMomentum24hPct: 0 to 10
  - llmTradeExpiryDays: 3 to 30
  - momentumLongExpiryDays: 3 to 45
  - signalRisk.<signal>.targetPct: 0.5 to 15, or null for no upside take-profit cap
  - signalRisk.<signal>.stopPct: 0.5 to 10
- You may update signalRisk when realized wins are too small, losses are too large, or shadow/blocked learning shows a better payoff shape.
- Keep signalRisk updates incremental and explain them in journalEntry.
- Do NOT include parameterUpdates.signalRisk entries for these locked signals; their risk is fixed by their backtest convention and any proposed change will be silently dropped: ONE_TOUCH_HIGH_EDGE_NO.

Respond with ONLY valid JSON in this exact format:
{
  "marketAssessment": "2-3 sentence summary",
  "newHypotheses": [
    {
      "created": "YYYY-MM-DD",
      "description": "clear description of pattern",
      "conditions": {"column_name": "> value", ...},
      "prediction": "specific testable prediction",
      "timeframeDays": 7,
      "confidence": 0.6,
      "direction": "long",
      "source": "llm"
    }
  ],
  "hypothesisReviews": [{"id": "H-xxx", "observation": "what happened and why"}],
  "trades": [{"action": "close", "positionId": "T-example", "asset": "BTC", "venue": "spot", "direction": "long", "closeReasonCategory": "thesis_invalidated", "evidenceColumns": ["btc_spot"], "thesis": "reason"}],
  "parameterUpdates": {
    "macroMomentum24hThresholdPts": 4,
    "contrarianTrendMarginPct": 0.5,
    "positiveMomentum24hPct": 1.5,
    "llmTradeExpiryDays": 14,
    "momentumLongExpiryDays": 21,
    "signalRisk": {
      "PM_IV_GT_OPT_IV": {"targetPct": null, "stopPct": 5},
      "FUNDING_EXTREME_SHORT": {"targetPct": 2.5, "stopPct": 2.5},
      "LLM_HYPOTHESIS": {"targetPct": 3.5, "stopPct": 2.5}
    }
  },
  "journalEntry": "Key observations and lessons from today's analysis..."
}`;

  if (DRY_RUN) {
    ensureLiveStateDir();
    const dumpFile = join(LIVE_STATE_DIR, "dry-run-prompt.txt");
    writeFileSync(dumpFile, prompt);
    console.log(`  [LLM] Dry-run: prompt written to ${dumpFile} (${prompt.length} chars).`);
  }

  if (!apiKey) {
    if (LLM_PROVIDER === "deepseek") {
      console.log("  [LLM] DeepSeek provider active (no ANTHROPIC_API_KEY), skipping LLM reasoning.");
    } else {
      console.log("  [LLM] No ANTHROPIC_API_KEY set, skipping LLM reasoning.");
    }
    return null;
  }

  try {
    const first = await requestLlmText(apiKey, llmModel, [{ role: "user", content: prompt }]);
    const parsed = parseLlmJson(first.text);
    if (parsed.result) return parsed.result;

    console.log(`  [LLM] Invalid JSON (${parsed.error}); requesting repair.${first.stopReason ? ` stop_reason=${first.stopReason}` : ""}`);
    const repairPrompt = `Your previous response was not valid JSON and could not be parsed.

Parse error: ${parsed.error}

Return ONLY a corrected JSON object that follows the original schema exactly. Do not include markdown, comments, or explanation. Preserve the same analysis as much as possible.
Required top-level keys and types:
- marketAssessment: non-empty string
- newHypotheses: array of objects with created, description, conditions, prediction, timeframeDays, confidence, direction ("long"|"short"|"neutral"), source="llm"
- hypothesisReviews: array of {id, observation}
- trades: array of {action, positionId?, asset, venue, direction, closeReasonCategory?, evidenceColumns?, thesis}
- parameterUpdates: optional object
- journalEntry: non-empty string

Previous response:
${first.text.slice(0, 12000)}`;

    const repaired = await requestLlmText(apiKey, llmModel, [
      { role: "user", content: prompt },
      { role: "assistant", content: first.text },
      { role: "user", content: repairPrompt },
    ]);
    const repairedParsed = parseLlmJson(repaired.text);
    if (repairedParsed.result) {
      console.log("  [LLM] Repaired JSON response parsed successfully.");
      return repairedParsed.result;
    }

    console.log(`  [LLM] Repair failed: ${repairedParsed.error}${repaired.stopReason ? ` stop_reason=${repaired.stopReason}` : ""}`);
    return null;
  } catch (e: any) {
    console.log(`  [LLM] Error: ${e.message}`);
    return null;
  }
}

function formatPct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

// ─── LLM Close Rejection Tracking ────────────────────────────────────────────
// Surfaces "token burn" — when the LLM repeatedly recommends closing trades
// that the gate is going to reject anyway. A single open position racking up
// 14+ rejected close instructions across 22 hours (as happened with
// T-1778794152516-60c7 on 2026-05-15) is a strong signal that either the
// prompt isn't communicating ownership clearly enough, or the LLM is wasting
// context budget restating the same recommendation. Persisted per-day so we
// can track the trend across runs without parsing terminal output.

interface RejectedCloseRecord {
  positionId: string | null;
  signalType: string | null;
  asset: string | null;
  reason: string;
  category: string | null;
  evidenceColumns: string[];
  recordedAt: string;
}

interface DailyRejectionBucket {
  byPositionId: Record<string, number>;
  bySignalType: Record<string, number>;
  bySignalAsset: Record<string, number>;
  total: number;
  recent: RejectedCloseRecord[];
}

interface RejectionRollup {
  updatedAt: string;
  daily: Record<string, DailyRejectionBucket>;
}

const REJECTION_ROLLUP_FILE = "llm-close-rejections.json";
const REJECTION_RECENT_KEEP = 20;
const REJECTION_DAILY_RETENTION_DAYS = 30;

function emptyRejectionBucket(): DailyRejectionBucket {
  return { byPositionId: {}, bySignalType: {}, bySignalAsset: {}, total: 0, recent: [] };
}

function loadRejectionRollup(): RejectionRollup {
  return readJson<RejectionRollup>(REJECTION_ROLLUP_FILE, { updatedAt: "", daily: {} });
}

function saveRejectionRollup(rollup: RejectionRollup) {
  writeJson(REJECTION_ROLLUP_FILE, rollup);
}

function prunedRollup(rollup: RejectionRollup, today: string): RejectionRollup {
  const cutoffMs = Date.parse(today + "T00:00:00Z") - REJECTION_DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const next: RejectionRollup = { updatedAt: rollup.updatedAt, daily: {} };
  for (const [date, bucket] of Object.entries(rollup.daily)) {
    const ts = Date.parse(date + "T00:00:00Z");
    if (!isNaN(ts) && ts >= cutoffMs) next.daily[date] = bucket;
  }
  return next;
}

function recordLlmCloseRejections(
  rejections: GatedLlmAdvice["rejectedCloses"],
  portfolio: Portfolio,
): { todayBucket: DailyRejectionBucket; dateKey: string } {
  const dateKey = new Date().toISOString().slice(0, 10);
  const rollup = prunedRollup(loadRejectionRollup(), dateKey);
  const bucket = rollup.daily[dateKey] ?? emptyRejectionBucket();

  for (const rejection of rejections) {
    const positionId = rejection.instruction.positionId ?? null;
    const position = positionId ? portfolio.positions.find((candidate) => candidate.id === positionId) : null;
    const signalType = position?.signalType ?? null;
    const asset = position?.asset ?? rejection.instruction.asset ?? null;
    const record: RejectedCloseRecord = {
      positionId,
      signalType,
      asset,
      reason: rejection.reason,
      category: rejection.instruction.closeReasonCategory ?? null,
      evidenceColumns: rejection.instruction.evidenceColumns ?? [],
      recordedAt: new Date().toISOString(),
    };
    bucket.total += 1;
    if (positionId) bucket.byPositionId[positionId] = (bucket.byPositionId[positionId] ?? 0) + 1;
    if (signalType) bucket.bySignalType[signalType] = (bucket.bySignalType[signalType] ?? 0) + 1;
    if (signalType && asset) {
      const key = `${signalType} / ${asset}`;
      bucket.bySignalAsset[key] = (bucket.bySignalAsset[key] ?? 0) + 1;
    }
    bucket.recent.push(record);
  }
  if (bucket.recent.length > REJECTION_RECENT_KEEP) {
    bucket.recent = bucket.recent.slice(-REJECTION_RECENT_KEEP);
  }
  rollup.daily[dateKey] = bucket;
  rollup.updatedAt = new Date().toISOString();
  saveRejectionRollup(rollup);
  return { todayBucket: bucket, dateKey };
}

function formatRejectionJournalSection(bucket: DailyRejectionBucket, dateKey: string): string[] {
  if (bucket.total === 0) return [];
  const lines: string[] = [`**LLM close rejections today (${dateKey}, token-burn signal):**`];
  lines.push(`- Total rejected close instructions: ${bucket.total}`);
  const topSignalAssets = Object.entries(bucket.bySignalAsset).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topSignalAssets.length > 0) {
    lines.push(`- Top signal/asset pairs: ${topSignalAssets.map(([k, v]) => `${k} (${v})`).join("; ")}`);
  }
  const topPositions = Object.entries(bucket.byPositionId).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topPositions.length > 0) {
    const flagged = topPositions.filter(([, count]) => count >= 3);
    if (flagged.length > 0) {
      lines.push(`- Repeat-offender positions (≥3 rejections today): ${flagged.map(([id, n]) => `${id} (${n})`).join("; ")} — consider tightening the prompt or surfacing a hard "mechanical-owned" marker for these.`);
    }
  }
  return lines;
}

// ─── Journal Writer ──────────────────────────────────────────────────────────

function writeJournalEntry(
  closedTrades: ClosedTrade[],
  openedPositions: Position[],
  weightObs: string[],
  hypothesisObs: string[],
  statObs: StatObservation[],
  blockedObs: string[],
  blockedSummary: BlockedSignalLearningSummary,
  llmJournal: string | null,
  portfolio: Portfolio,
  rejectionSection: string[],
) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace("T", " ");
  const lines: string[] = [];

  lines.push(`### ${dateStr} UTC`);
  lines.push("");

  // Portfolio summary
  const winRate = portfolio.totalTrades > 0 ? ((portfolio.winCount / portfolio.totalTrades) * 100).toFixed(0) : "N/A";
  lines.push(`**Portfolio:** $${(portfolio.cash + portfolio.positions.length * TRADE_SIZE).toFixed(2)} total | Cash $${portfolio.cash.toFixed(2)} | ${portfolio.positions.length} open | P&L $${portfolio.totalRealizedPnl.toFixed(4)} | ${winRate}% win rate (${portfolio.totalTrades} trades)`);
  lines.push("");

  if (closedTrades.length > 0) {
    lines.push(`**Closed ${closedTrades.length} trades:**`);
    for (const t of closedTrades) {
      const emoji = t.pnl >= 0 ? "✅" : "❌";
      lines.push(`- ${emoji} ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} [${t.instrumentLabel ?? "n/a"}] (${t.signalType}) → ${t.closeReason}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (${t.pnlPct.toFixed(1)}%, market ${(t.marketPnl ?? t.pnl).toFixed(4)}, funding ${(t.fundingPnl ?? 0).toFixed(4)})`);
    }
    lines.push("");
  }

  if (openedPositions.length > 0) {
    lines.push(`**Opened ${openedPositions.length} positions:**`);
    for (const p of openedPositions) {
      lines.push(`- ${p.asset} ${p.direction} @ $${p.entryPrice} via ${p.venue}/${p.instrumentType ?? "legacy"} [${p.instrumentLabel ?? "n/a"}] (${p.signalType})`);
    }
    lines.push("");
  }

  if (weightObs.length > 0) {
    lines.push("**Signal weight changes:**");
    for (const o of weightObs) lines.push(`- ${o}`);
    lines.push("");
  }

  if (hypothesisObs.length > 0) {
    lines.push("**Hypothesis lifecycle:**");
    for (const o of hypothesisObs) lines.push(`- ${o}`);
    lines.push("");
  }

  if (statObs.length > 0) {
    lines.push("**Statistical observations:**");
    for (const o of statObs.slice(0, 5)) lines.push(`- [${o.type}] ${o.description}`);
    lines.push("");
  }

  if (blockedObs.length > 0 || blockedSummary.recentResolved.length > 0 || blockedSummary.openCount > 0) {
    lines.push("**Blocked signal learning:**");
    lines.push(`- Open blocked shadows: ${blockedSummary.openCount}`);
    lines.push(`- Resolved blocked shadows: ${blockedSummary.resolvedCount} (${blockedSummary.wouldHaveWon} wins / ${blockedSummary.wouldHaveLost} losses)`);
    for (const note of blockedObs) lines.push(`- ${note}`);
    for (const shadow of blockedSummary.recentResolved.slice(-4)) {
      const emoji = shadow.outcome === "win" ? "✅" : "❌";
      const label = shadow.blockedReason === "iv_downside_leg_untracked"
        ? "Missing downside leg"
        : shadow.blockedReason === "polymarket_proxy_short" ? "PM proxy short"
        : shadow.blockedReason === "relative_value_heatmap" ? "Relative-value heatmap"
        : shadow.blockedReason === "one_touch_high_edge_shadow" ? "One-touch high-edge"
        : shadow.blockedReason === "stale_lottery_ticket_shadow" ? "Stale lottery NO"
        : shadow.blockedReason === "manual_shadow_trade" ? "Manual shadow" : "Blocked";
      lines.push(`- ${emoji} ${label}: ${shadow.signalType} ${shadow.asset} ${shadow.direction} via ${shadow.venue} would have ${humanCloseReason(shadow.closeReason)} (${shadow.pnlPct >= 0 ? "+" : ""}${shadow.pnlPct.toFixed(2)}%)`);
    }
    lines.push("");
  }

  if (llmJournal) {
    lines.push("**LLM analysis:**");
    lines.push(llmJournal);
    lines.push("");
  }

  if (rejectionSection.length > 0) {
    for (const line of rejectionSection) lines.push(line);
    lines.push("");
  }

  lines.push("---\n");
  appendJournal(lines.join("\n"));
}

// ─── Regime Detection ────────────────────────────────────────────────────────

function checkRegime(portfolio: Portfolio): { inDrawdown: boolean; sizeMultiplier: number } {
  if (portfolio.totalTrades < 10) return { inDrawdown: false, sizeMultiplier: 1.0 };

  const recentFile = existsSync(join(DATA_DIR, "trades-detailed.csv"))
    ? join(DATA_DIR, "trades-detailed.csv")
    : join(DATA_DIR, "trades.csv");
  if (!existsSync(recentFile)) return { inDrawdown: false, sizeMultiplier: 1.0 };

  const lines = readFileSync(recentFile, "utf-8").trim().split("\n");
  const headers = parseCsvLine(lines[0] ?? "");
  const pnlIndex = Math.max(0, headers.indexOf("pnl"));
  const recent = lines.slice(-20);
  let wins = 0, total = 0;
  for (const line of recent) {
    if (line.startsWith("id,")) continue;
    const cols = parseCsvLine(line);
    const pnl = parseFloat(cols[pnlIndex] ?? "0");
    total++;
    if (pnl >= 0) wins++;
  }

  const winRate = total > 0 ? wins / total : 0.5;
  if (winRate < 0.35) {
    return { inDrawdown: true, sizeMultiplier: 0.5 };
  }
  return { inDrawdown: false, sizeMultiplier: 1.0 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  return null;
}

function snapshotTimeMs(ts: string): number {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(ts)) return Date.parse(`${ts}:00:00Z`);
  return Date.parse(ts);
}

function readJournalTail(lines: number = 50): string {
  const file = join(DATA_DIR, "learning-journal.md");
  if (!existsSync(file)) return "";
  const content = readFileSync(file, "utf-8");
  const allLines = content.split("\n");
  return allLines.slice(-lines).join("\n");
}

function estimateOpenPositionPnl(position: Position): number {
  if (position.instrumentType === "pm_yes" || position.instrumentType === "pm_no") {
    const shares = position.size / position.entryPrice;
    return shares * (position.currentPrice - position.entryPrice);
  }
  const leverage = position.leverage ?? 1;
  const directional = position.direction === "long"
    ? ((position.currentPrice - position.entryPrice) / position.entryPrice)
    : ((position.entryPrice - position.currentPrice) / position.entryPrice);
  const marketPnl = position.size * leverage * directional;
  return marketPnl + (position.fundingPnlAccrued ?? 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function applyLearningParamUpdates(
  current: LearningParams,
  updates: Partial<Omit<LearningParams, "updatedAt">> | undefined,
): { next: LearningParams; notes: string[] } {
  if (!updates) return { next: current, notes: [] };
  const next = { ...current };
  const notes: string[] = [];
  const candidates: Array<{
    key: "macroMomentum24hThresholdPts" | "contrarianTrendMarginPct" | "positiveMomentum24hPct" | "llmTradeExpiryDays" | "momentumLongExpiryDays";
    min: number;
    max: number;
    digits: number;
  }> = [
    { key: "macroMomentum24hThresholdPts", min: 2, max: 20, digits: 1 },
    { key: "contrarianTrendMarginPct", min: 0, max: 5, digits: 2 },
    { key: "positiveMomentum24hPct", min: 0, max: 10, digits: 2 },
    { key: "llmTradeExpiryDays", min: 3, max: 30, digits: 0 },
    { key: "momentumLongExpiryDays", min: 3, max: 45, digits: 0 },
  ];

  for (const candidate of candidates) {
    const proposed = updates[candidate.key];
    if (typeof proposed !== "number" || Number.isNaN(proposed)) continue;
    const bounded = clamp(proposed, candidate.min, candidate.max);
    const normalized = candidate.digits === 0
      ? Math.round(bounded)
      : Number(bounded.toFixed(candidate.digits));
    if (normalized !== next[candidate.key]) {
      notes.push(`${candidate.key}: ${next[candidate.key]} -> ${normalized}`);
      next[candidate.key] = normalized;
    }
  }

  if (updates.signalRisk && typeof updates.signalRisk === "object") {
    const nextSignalRisk = { ...next.signalRisk };
    for (const [signalType, proposed] of Object.entries(updates.signalRisk)) {
      if (!DEFAULT_SIGNAL_RISK[signalType] || !proposed) continue;
      if (LLM_LOCKED_SIGNAL_RISK.has(signalType)) continue;
      const currentRisk = nextSignalRisk[signalType] ?? DEFAULT_SIGNAL_RISK[signalType];
      const nextRisk = { ...currentRisk };
      if (proposed.targetPct === null) {
        nextRisk.targetPct = null;
      } else if (typeof proposed.targetPct === "number" && !Number.isNaN(proposed.targetPct)) {
        nextRisk.targetPct = Number(clamp(proposed.targetPct, 0.5, 15).toFixed(2));
      }
      if (typeof proposed.stopPct === "number" && !Number.isNaN(proposed.stopPct)) {
        nextRisk.stopPct = Number(clamp(proposed.stopPct, 0.5, 10).toFixed(2));
      }
      if (nextRisk.targetPct !== currentRisk.targetPct || nextRisk.stopPct !== currentRisk.stopPct) {
        notes.push(`${signalType} risk: ${formatTargetPct(currentRisk.targetPct)}/-${currentRisk.stopPct} -> ${formatTargetPct(nextRisk.targetPct)}/-${nextRisk.stopPct}`);
        nextSignalRisk[signalType] = nextRisk;
      }
    }
    const beforeFundingShort = nextSignalRisk.FUNDING_EXTREME_SHORT;
    const beforeFundingLong = nextSignalRisk.FUNDING_EXTREME_LONG;
    normalizeFundingRiskShape(nextSignalRisk);
    for (const signalType of ["FUNDING_EXTREME_SHORT", "FUNDING_EXTREME_LONG"]) {
      const before = signalType === "FUNDING_EXTREME_SHORT" ? beforeFundingShort : beforeFundingLong;
      const after = nextSignalRisk[signalType];
      if (before.targetPct !== after.targetPct || before.stopPct !== after.stopPct) {
        notes.push(`${signalType} risk floor: ${formatTargetPct(before.targetPct)}/-${before.stopPct} -> ${formatTargetPct(after.targetPct)}/-${after.stopPct}`);
      }
    }
    next.signalRisk = nextSignalRisk;
  }

  if (notes.length > 0) next.updatedAt = new Date().toISOString();
  return { next, notes };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  ensureDataDir();
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`\n  Trading Engine — ${timestamp} UTC`);
  console.log(`  ${"─".repeat(55)}`);

  // Load data
  const valRows = readCsv("daily-valuations.csv");
  const macroRows = readCsv("daily-macro.csv");
  const instrumentSnapshots = readInstrumentSnapshots();

  if (valRows.length === 0) {
    console.log("  No snapshot data found. Run market-scanner.ts --snapshot first.");
    return;
  }

  console.log(`  Data: ${valRows.length} valuation snapshots, ${macroRows.length} macro snapshots`);

  // Load state
  const portfolio = loadPortfolio();
  let learningParams = loadLearningParams();
  const weights = loadWeights();
  let hypotheses = loadHypotheses();
  const blockedSignals = loadBlockedSignals();
  // Run the ghost-killer reconciliation FIRST, before any other startup
  // pass touches the portfolio. If a previously-closed position has been
  // rehydrated by an upstream state-restore path, we want it removed
  // before migrateLegacyPolymarketPositions / risk-shape passes /
  // mark-to-market run, so none of them act on a phantom.
  const ghostKillNotes = reconcileClosedGhostPositions(portfolio);
  const migrationNotes = migrateLegacyPolymarketPositions(portfolio, instrumentSnapshots);
  const longDatedTimelineNotes = extendLongDatedPolymarketTimelines(portfolio, blockedSignals);
  const fundingRiskShapeNotes = applyFundingRiskShapeToOpenPositions(portfolio, learningParams);
  const spotRiskShapeNotes = applySpotRiskToOpenPositions(portfolio);
  const productionPolymarketRiskNotes = applyProductionPolymarketRiskToOpenPositions(portfolio);
  const weekendFundingPromotionNotes = promoteOpenWeekendFundingShadowsToLive(portfolio, blockedSignals);
  const cancelledHeatmapShadows = cancelOpenRelativeValueHeatmapShadows(blockedSignals);
  const cancelledInvalidMonotonicArbShadows = cancelOpenInvalidMonotonicArbShadows(blockedSignals);
  const legacyOneTouchSweep = cancelLegacyOneTouchShadows(blockedSignals);
  const realPmMirrorNotes = importCompletedRealPolymarketPackages(portfolio);

  console.log(`  Portfolio: $${portfolio.cash.toFixed(2)} cash, ${portfolio.positions.length} open positions, $${portfolio.totalRealizedPnl.toFixed(4)} realized P&L`);
  console.log(`  Learnable params: macro24h>${learningParams.macroMomentum24hThresholdPts.toFixed(1)}, trend>${learningParams.contrarianTrendMarginPct.toFixed(2)}%, momentum>${learningParams.positiveMomentum24hPct.toFixed(2)}%, llm expiry=${learningParams.llmTradeExpiryDays}d, momentum expiry=${learningParams.momentumLongExpiryDays}d`);
  console.log(`  Risk params: HL funding ${formatTargetPct(learningParams.signalRisk.FUNDING_EXTREME_SHORT.targetPct)}/-${learningParams.signalRisk.FUNDING_EXTREME_SHORT.stopPct}, LLM ${formatTargetPct(learningParams.signalRisk.LLM_HYPOTHESIS.targetPct)}/-${learningParams.signalRisk.LLM_HYPOTHESIS.stopPct}, PM overvol ${formatTargetPct(learningParams.signalRisk.PM_IV_GT_OPT_IV.targetPct)}/-${learningParams.signalRisk.PM_IV_GT_OPT_IV.stopPct}`);
  for (const note of ghostKillNotes) console.log(`  Ghost killer: ${note}`);
  for (const note of migrationNotes) console.log(`  ${note}`);
  for (const note of longDatedTimelineNotes) console.log(`  Long-dated PM timeline: ${note}`);
  for (const note of fundingRiskShapeNotes) console.log(`  Funding risk shape: ${note}`);
  for (const note of spotRiskShapeNotes) console.log(`  Spot risk shape: ${note}`);
  for (const note of productionPolymarketRiskNotes) console.log(`  Production PM risk shape: ${note}`);
  for (const note of weekendFundingPromotionNotes) console.log(`  Weekend funding promotion: ${note}`);
  for (const note of realPmMirrorNotes) console.log(`  Real PM mirror: ${note}`);
  if (cancelledHeatmapShadows.length > 0) {
    console.log(`  Cancelled ${cancelledHeatmapShadows.length} open relative-value heatmap shadow trades; heatmap is report-only until the horizon model is redesigned.`);
  }
  if (cancelledInvalidMonotonicArbShadows.length > 0) {
    console.log(`  Cancelled ${cancelledInvalidMonotonicArbShadows.length} invalid monotonic-arb shadow packages; only nested hit/reach ladders are eligible.`);
  }
  if (legacyOneTouchSweep.cancelled.length > 0 || legacyOneTouchSweep.retroExcluded > 0) {
    console.log(`  Legacy one-touch sweep: cancelled ${legacyOneTouchSweep.cancelled.length} open shadow trades, retro-excluded ${legacyOneTouchSweep.retroExcluded} resolved shadows from learning. Engine now trains on new-model one-touch trades only.`);
  }

  // Regime check
  const regime = checkRegime(portfolio);
  if (regime.inDrawdown) {
    console.log(`  ⚠ DRAWDOWN MODE — win rate below 35% in last 20 trades. Position sizes halved.`);
  }

  // Step 1: Mark-to-market and close positions
  const latestRow = valRows[valRows.length - 1];
  const latestSnapshot = latestInstrumentSnapshot(instrumentSnapshots);
  const relativeValueRows = readRelativeValueObservations(250);
  const closedTrades = markToMarket(portfolio, latestRow, instrumentSnapshots, valRows);
  if (closedTrades.length > 0) {
    console.log(`\n  Closed ${closedTrades.length} positions:`);
    for (const t of closedTrades) {
      const emoji = t.pnl >= 0 ? "✅" : "❌";
      console.log(`    ${emoji} ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} [${t.instrumentLabel ?? "n/a"}] → ${t.closeReason}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (${t.pnlPct.toFixed(1)}%)`);
      if (!MUTATION_DISABLED) appendTradeCsv(t);
    }
  }

  const pendingScannerClosedTrades = loadPendingScannerClosedTrades();
  if (pendingScannerClosedTrades.length > 0) {
    const existingClosedTradeIds = new Set(readClosedTradeCsv().map((trade) => trade.id));
    const currentRunClosedIds = new Set(closedTrades.map((trade) => trade.id));
    const newPendingScannerClosedTrades = pendingScannerClosedTrades.filter((trade) =>
      !existingClosedTradeIds.has(trade.id) && !currentRunClosedIds.has(trade.id)
    );
    console.log(`\n  Importing ${newPendingScannerClosedTrades.length}/${pendingScannerClosedTrades.length} minute-scanner closed trades from live state:`);
    for (const t of newPendingScannerClosedTrades) {
      const emoji = t.pnl >= 0 ? "✅" : "❌";
      console.log(`    ${emoji} ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} [${t.instrumentLabel ?? "n/a"}] → ${t.closeReason}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (${t.pnlPct.toFixed(1)}%)`);
      if (!MUTATION_DISABLED) appendTradeCsv(t);
      closedTrades.push(t);
    }
  }

  const allClosedTrades = readClosedTradeCsv();
  const processedClosedTrades = loadProcessedClosedTrades(allClosedTrades);
  const currentRunClosedIds = new Set(closedTrades.map((trade) => trade.id));
  const processedIds = new Set(processedClosedTrades.processedIds);
  const scannerClosedTrades = allClosedTrades.filter((trade) =>
    !processedIds.has(trade.id) && !currentRunClosedIds.has(trade.id)
  );
  if (scannerClosedTrades.length > 0) {
    console.log(`\n  Ingested ${scannerClosedTrades.length} minute-scanner closed trades for learning:`);
    for (const t of scannerClosedTrades) {
      const emoji = t.pnl >= 0 ? "✅" : "❌";
      console.log(`    ${emoji} ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} [${t.instrumentLabel ?? "n/a"}] → ${t.closeReason}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (${t.pnlPct.toFixed(1)}%)`);
    }
    closedTrades.push(...scannerClosedTrades);
  }

  const resolvedBlockedSignals = resolveBlockedSignalShadows(blockedSignals, latestRow, instrumentSnapshots, relativeValueRows, valRows);
  if (resolvedBlockedSignals.length > 0) {
    console.log(`\n  Resolved ${resolvedBlockedSignals.length} blocked-signal shadows:`);
    for (const shadow of resolvedBlockedSignals.slice(-6)) {
      const result = shadow.hypotheticalResult!;
      const emoji = result.outcome === "win" ? "✅" : "❌";
      const shadowLabel = shadow.blockedReason === "iv_downside_leg_untracked"
        ? "Missing downside leg"
        : shadow.blockedReason === "polymarket_proxy_short" ? "PM proxy short"
        : shadow.blockedReason === "relative_value_heatmap" ? "Relative-value heatmap"
        : shadow.blockedReason === "one_touch_high_edge_shadow" ? "One-touch high-edge"
        : shadow.blockedReason === WEEKEND_HL_FUNDING_SHADOW_REASON ? "Weekend HL funding"
        : shadow.blockedReason === "stale_lottery_ticket_shadow" ? "Stale lottery NO"
        : shadow.blockedReason === "monotonic_arb_shadow" ? "Monotonic arb"
        : shadow.blockedReason === "manual_shadow_trade" ? "Manual shadow" : "Blocked";
      console.log(`    ${emoji} ${shadowLabel}: ${shadow.signalType} ${shadow.asset} ${shadow.direction} via ${shadow.venue} would have ${humanCloseReason(result.closeReason)}: ${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct.toFixed(2)}%`);
    }
  }
  const newMonotonicArbShadows = await recordMonotonicArbShadows(latestRow, latestSnapshot, learningParams, blockedSignals, portfolio);
  if (newMonotonicArbShadows > 0) {
    console.log(`\n  Opened ${newMonotonicArbShadows} monotonic-arb ${ENABLE_MONOTONIC_ARB_LIVE ? "LIVE" : "shadow"} package trades.`);
  }
  const oneTouchHighEdgeNoLiveSignals = ENABLE_ONE_TOUCH_HIGH_EDGE_NO_OPENING
    ? generateOneTouchHighEdgeNoSignals(relativeValueRows, weights, learningParams, latestSnapshot)
    : [];
  const oneTouchHighEdgeLiveCoveredKeys = liveOneTouchHighEdgeNoKeys(oneTouchHighEdgeNoLiveSignals);
  if (ENABLE_ONE_TOUCH_HIGH_EDGE_NO_OPENING) {
    if (oneTouchHighEdgeNoLiveSignals.length > 0) {
      console.log(`\n  Generated ${oneTouchHighEdgeNoLiveSignals.length} one-touch high-edge NO live signals (${Array.from(ONE_TOUCH_HIGH_EDGE_LIVE_ASSETS).join("/")}, |edge|>=${ONE_TOUCH_HIGH_EDGE_MIN_ABS_EDGE}, strict).`);
    }
    const newOneTouchHighEdgeShadows = recordOneTouchHighEdgeShadows(relativeValueRows, latestRow, latestSnapshot, learningParams, blockedSignals, oneTouchHighEdgeLiveCoveredKeys);
    if (newOneTouchHighEdgeShadows > 0) {
      console.log(`\n  Opened ${newOneTouchHighEdgeShadows} one-touch NO edge shadow trades.`);
    }
  } else {
    console.log("\n  One-touch high-edge NO live/shadow opening is disabled; existing shadows still resolve normally.");
  }
  const newNoBiasAdjustedGapShadows = recordNoBiasAdjustedGapShadows(relativeValueRows, latestRow, latestSnapshot, learningParams, blockedSignals);
  if (newNoBiasAdjustedGapShadows > 0) {
    console.log(`\n  Opened ${newNoBiasAdjustedGapShadows} adjusted NO-bias shadow trades.`);
  }
  const newStaleLotteryTicketNoShadows = recordStaleLotteryTicketNoShadows(relativeValueRows, latestRow, latestSnapshot, learningParams, blockedSignals);
  if (newStaleLotteryTicketNoShadows > 0) {
    console.log(`\n  Opened ${newStaleLotteryTicketNoShadows} stale-lottery-ticket NO shadow trades.`);
  }
  const newWeekendFundingLiveTrades = recordWeekendHyperliquidFundingLiveTrades(latestSnapshot, portfolio, blockedSignals);
  if (newWeekendFundingLiveTrades > 0) {
    console.log(`\n  Opened ${newWeekendFundingLiveTrades} weekend HL stock funding LIVE trades (mid-band entry [${(WEEKEND_HL_FUNDING_ENTRY_FLOOR_PCT * 100).toFixed(0)}%, ${(WEEKEND_HL_FUNDING_ENTRY_PCT * 100).toFixed(0)}%], ${(WEEKEND_HL_FUNDING_EXIT_PCT * 100).toFixed(0)}% funding exit, ${WEEKEND_HL_FUNDING_LEVERAGE}x tracked).`);
  }
  const newWeekendFundingShadows = recordWeekendHyperliquidFundingShadows(latestSnapshot, learningParams, blockedSignals);
  if (newWeekendFundingShadows > 0) {
    console.log(`\n  Opened ${newWeekendFundingShadows} weekend HL stock funding shadow trades (mid-band entry [${(WEEKEND_HL_FUNDING_ENTRY_FLOOR_PCT * 100).toFixed(0)}%, ${(WEEKEND_HL_FUNDING_ENTRY_PCT * 100).toFixed(0)}%], ${(WEEKEND_HL_FUNDING_EXIT_PCT * 100).toFixed(0)}% exit, ${WEEKEND_HL_FUNDING_LEVERAGE}x).`);
  }
  let proxyComparisonObs = updateProxyShortShadowComparisons(blockedSignals, [...readClosedTradeCsv(), ...closedTrades]);
  let blockedSummary = summarizeBlockedSignals(blockedSignals);
  let oneTouchBucketObs = oneTouchBucketObservations(blockedSignals);
  let blockedObs = [...blockedSignalObservations(blockedSummary), ...proxyComparisonObs, ...oneTouchBucketObs];
  for (const note of blockedObs) console.log(`  Shadow learning: ${note}`);

  // Step 2: Update signal weights
  let weightObs = updateWeights(weights, closedTrades);
  for (const o of weightObs) console.log(`  ${o}`);

  const killedSignalClosedTrades = closePositionsForKilledSignals(portfolio, weights, latestRow, instrumentSnapshots);
  if (killedSignalClosedTrades.length > 0) {
    console.log(`\n  Closed ${killedSignalClosedTrades.length} positions because their signal/asset was killed:`);
    for (const t of killedSignalClosedTrades) {
      const emoji = t.pnl >= 0 ? "✅" : "❌";
      console.log(`    ${emoji} ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} [${t.instrumentLabel ?? "n/a"}] → signal_killed: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (${t.pnlPct.toFixed(1)}%)`);
      if (!MUTATION_DISABLED) appendTradeCsv(t);
      closedTrades.push(t);
    }
    const killedSignalWeightObs = updateWeights(weights, killedSignalClosedTrades);
    weightObs = [...weightObs, ...killedSignalWeightObs];
    for (const o of killedSignalWeightObs) console.log(`  ${o}`);
  }

  // Step 3: Evaluate hypotheses
  const hypothesisObs = evaluateHypotheses(hypotheses, valRows, relativeValueRows);
  for (const o of hypothesisObs) console.log(`  ${o}`);

  // Step 4: Statistical scan
  const statObs = statisticalScan(valRows, macroRows);
  if (statObs.length > 0) {
    console.log(`\n  Statistical observations (${statObs.length}):`);
    for (const o of statObs.slice(0, 5)) {
      console.log(`    [${o.type}] ${o.description}`);
    }
  }

  // Step 5: Generate rule-based signals
  const signals = generateSignals(valRows, macroRows, weights, learningParams, latestSnapshot, blockedSignals);
  const promotedSignals = generatePromotedHypothesisSignals(hypotheses, valRows, latestRow, learningParams, latestSnapshot, blockedSignals, relativeValueRows);
  signals.push(...promotedSignals);
  signals.push(...oneTouchHighEdgeNoLiveSignals);
  proxyComparisonObs = updateProxyShortShadowComparisons(blockedSignals, [...readClosedTradeCsv(), ...closedTrades]);
  blockedSummary = summarizeBlockedSignals(blockedSignals);
  oneTouchBucketObs = oneTouchBucketObservations(blockedSignals);
  blockedObs = [...blockedSignalObservations(blockedSummary), ...proxyComparisonObs, ...oneTouchBucketObs];
  console.log(`\n  Signals generated: ${signals.length}`);
  for (const s of signals.slice(0, 8)) {
    console.log(`    ${s.asset} ${s.direction} (${s.type}) confidence=${s.confidence.toFixed(3)} — ${s.thesis.slice(0, 70)}`);
  }

  const engineState = buildEngineState(valRows, macroRows, instrumentSnapshots, portfolio, weights, learningParams, blockedSummary);
  const truthState = buildLlmTruthState(hypotheses, weights, [...readClosedTradeCsv(), ...closedTrades], blockedSignals);
  const candidateActions = buildCandidateActions(portfolio, weights, signals, latestRow, instrumentSnapshots);
  let gatedAdvice: GatedLlmAdvice = { acceptedCloses: [], rejectedCloses: [], skippedTrades: [], parameterUpdates: undefined };
  let executionPlan: ExecutionPlan | null = null;
  writeLeanArtifacts(engineState, truthState, candidateActions, null, null);

  // Step 6: LLM reasoning (gated by cadence)
  let llmJournal: string | null = null;
  let rejectionJournalSection: string[] = [];
  const llmState = loadLlmState();
  const cadence = decideLlmCadence(llmState, signals, portfolio, hypotheses, valRows, latestRow, instrumentSnapshots);
  const llmShouldRun = !NO_LLM && cadence.run;
  if (!NO_LLM && !cadence.run) {
    const sinceTxt = cadence.hoursSinceLastCall === null
      ? "no prior call recorded"
      : `${cadence.hoursSinceLastCall.toFixed(1)}h since last call`;
    const suppressTxt = cadence.suppressedReasons.length > 0
      ? cadence.suppressedReasons.join(" | ")
      : "no trigger fired";
    console.log(`\n  LLM call SKIPPED (${sinceTxt}, ${llmState.skipsSinceLastCall + 1} skip${llmState.skipsSinceLastCall + 1 === 1 ? "" : "s"} since last call). ${suppressTxt}.`);
    console.log(`  LLM daily budget: ${cadence.callsToday}/${cadence.maxCallsPerDay} calls used today.`);
    if (cadence.reasons.length > 0) console.log(`  Suppressed triggers: ${cadence.reasons.join(" | ")}`);
    console.log(`  Next scheduled LLM call: ${cadence.nextScheduledAt}`);
    llmState.skipsSinceLastCall += 1;
    llmState.recentSkipReasons = [
      ...llmState.recentSkipReasons,
      `${new Date().toISOString()} ${suppressTxt}`,
    ].slice(-12);
    updateLlmCadenceAccounting(llmState, signals, false);
    if (!MUTATION_DISABLED) saveLlmState(llmState);
    llmJournal = `_LLM call skipped (${suppressTxt}; ${sinceTxt}; daily budget ${cadence.callsToday}/${cadence.maxCallsPerDay}; next scheduled ${cadence.nextScheduledAt}). Mechanical cycle ran normally._`;
  }
  if (llmShouldRun) {
    console.log(`\n  Calling LLM for pattern discovery...`);
    console.log(`    Triggers: ${cadence.reasons.join(" | ")}`);
    console.log(`    LLM daily budget before call: ${cadence.callsToday}/${cadence.maxCallsPerDay}`);
    const journalTail = readJournalTail(40);
    const llmResult = await callLLM(valRows, macroRows, instrumentSnapshots, portfolio, learningParams, weights, hypotheses, statObs, closedTrades, blockedSummary, relativeValueRows, journalTail, engineState, truthState, candidateActions);

    if (llmResult) {
      console.log(`  LLM assessment: ${llmResult.marketAssessment.slice(0, 120)}`);
      const appliedUpdates = applyLearningParamUpdates(learningParams, llmResult.parameterUpdates);
      learningParams = appliedUpdates.next;
      for (const note of appliedUpdates.notes) {
        console.log(`    Param update: ${note}`);
      }

      // Add new hypotheses only after the existing LLM backlog has enough repeat shadow tests.
      const currentHypothesisBacklog = llmHypothesisBacklog(hypotheses);
      if (!currentHypothesisBacklog.complete && (llmResult.newHypotheses ?? []).length > 0) {
        console.log(`    Skipping ${llmResult.newHypotheses.length} new LLM hypotheses; ${currentHypothesisBacklog.needingTests} existing hypotheses still need shadow tests.`);
      } else {
        for (const nh of llmResult.newHypotheses ?? []) {
          const id = `H-${String(hypotheses.length + 1).padStart(3, "0")}`;
          const hypothesis: Hypothesis = {
            id, created: nh.created, description: nh.description,
            conditions: nh.conditions, prediction: nh.prediction,
            timeframeDays: nh.timeframeDays, confidence: nh.confidence,
            direction: nh.direction,
            tests: [{ date: new Date().toISOString().slice(0, 10), triggered: true, outcome: "pending", actualMove: `Shadow test 1/${HYPOTHESIS_SHADOW_TESTS_REQUIRED} opened for initial validation.` }],
            winRate: 0, status: "active", promotedToSignal: false, postMortem: null,
            source: nh.source ?? "llm",
          };
          ensureHypothesisSetupMetadata(hypothesis);
          if (RETIRED_LLM_SETUP_IDS.has(hypothesis.setupId ?? "")) {
            console.log(`    Skipping retired LLM setup hypothesis ${id}: ${hypothesis.setupLabel}`);
            continue;
          }
          hypotheses.push(hypothesis);
          console.log(`    New hypothesis ${id}: ${nh.description.slice(0, 80)}`);
        }
      }

      // Process hypothesis reviews
      for (const review of llmResult.hypothesisReviews ?? []) {
        const h = hypotheses.find((h) => h.id === review.id);
        if (h) {
          if (!h.postMortem) h.postMortem = review.observation;
          else h.postMortem += " | " + review.observation;
        }
      }

      gatedAdvice = gateLlmAdvice(llmResult, portfolio, candidateActions);
      for (const rejection of gatedAdvice.rejectedCloses) {
        console.log(`    Rejected LLM close: ${rejection.reason}`);
      }
      for (const skipped of gatedAdvice.skippedTrades) {
        console.log(`    Skipped LLM ${skipped.instruction.action}: ${skipped.reason}`);
      }
      if (gatedAdvice.rejectedCloses.length > 0 && !MUTATION_DISABLED) {
        const tracked = recordLlmCloseRejections(gatedAdvice.rejectedCloses, portfolio);
        rejectionJournalSection = formatRejectionJournalSection(tracked.todayBucket, tracked.dateKey);
        const totalToday = tracked.todayBucket.total;
        console.log(`    LLM close rejections logged: ${gatedAdvice.rejectedCloses.length} this run, ${totalToday} so far today (see data/${REJECTION_ROLLUP_FILE}).`);
      }

      llmJournal = llmResult.journalEntry;
      proxyComparisonObs = updateProxyShortShadowComparisons(blockedSignals, [...readClosedTradeCsv(), ...closedTrades]);
      blockedSummary = summarizeBlockedSignals(blockedSignals);
      oneTouchBucketObs = oneTouchBucketObservations(blockedSignals);
      blockedObs = [...blockedSignalObservations(blockedSummary), ...proxyComparisonObs, ...oneTouchBucketObs];
    }
    llmState.lastCallAt = new Date().toISOString();
    llmState.lastCallReasons = cadence.reasons;
    llmState.skipsSinceLastCall = 0;
    llmState.recentSkipReasons = [];
    updateLlmCadenceAccounting(llmState, signals, true);
    if (!MUTATION_DISABLED) saveLlmState(llmState);
  }

  executionPlan = buildExecutionPlan(candidateActions, gatedAdvice, signals);
  writeLeanArtifacts(engineState, truthState, candidateActions, gatedAdvice, executionPlan);
  writeDryRunVerification(engineState, candidateActions, executionPlan);

  // Step 7: Open new positions
  if (!MUTATION_DISABLED) {
    const { llmClosedTrades, openedPositions: opened } = await executeApprovedPlan(executionPlan, portfolio, latestRow, instrumentSnapshots, learningParams, blockedSignals);
    if (llmClosedTrades.length > 0) {
      console.log(`\n  LLM closed ${llmClosedTrades.length} positions:`);
      for (const t of llmClosedTrades) {
        const emoji = t.pnl >= 0 ? "✅" : "❌";
        console.log(`    ${emoji} ${t.asset} ${t.direction} via ${t.venue}/${t.instrumentType ?? "legacy"} [${t.instrumentLabel ?? "n/a"}] → ${t.closeReason}: ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(4)} (${t.pnlPct.toFixed(1)}%)`);
        appendTradeCsv(t);
        closedTrades.push(t);
      }
      weightObs = [...weightObs, ...updateWeights(weights, llmClosedTrades)];
    }
    if (opened.length > 0) {
      console.log(`\n  Opened ${opened.length} new positions:`);
      for (const p of opened) {
        console.log(`    ${p.asset} ${p.direction} @ $${p.entryPrice} via ${p.venue}/${p.instrumentType ?? "legacy"} [${p.instrumentLabel ?? "n/a"}] (${p.signalType})`);
      }
    }

    // Step 8: Write journal entry
    writeJournalEntry(closedTrades, opened, weightObs, hypothesisObs, statObs, blockedObs, blockedSummary, llmJournal, portfolio, rejectionJournalSection);

    // Step 9: Save all state
    savePortfolio(portfolio);
    saveWeights(weights);
    saveHypotheses(hypotheses);
    saveLearningParams(learningParams);
    saveBlockedSignals(blockedSignals);
    saveProcessedClosedTrades({
      processedIds: [...processedIds, ...closedTrades.map((trade) => trade.id)],
      updatedAt: new Date().toISOString(),
    });
    clearPendingScannerClosedTrades();
  } else {
    console.log("\n  Dry-run verification: executor skipped; portfolio, trade ledger, journal, and learning state were not saved.");
  }

  // Summary
  const totalValue = portfolio.cash + portfolio.positions.length * TRADE_SIZE;
  const unrealized = portfolio.positions.reduce((s, p) => s + estimateOpenPositionPnl(p), 0);

  console.log(`\n  ${"─".repeat(55)}`);
  console.log(`  Portfolio Summary:`);
  console.log(`    Cash:           $${portfolio.cash.toFixed(2)}`);
  console.log(`    Open positions: ${portfolio.positions.length}`);
  console.log(`    Unrealized P&L: $${unrealized.toFixed(4)}`);
  console.log(`    Realized P&L:   $${portfolio.totalRealizedPnl.toFixed(4)}`);
  console.log(`    Total value:    ~$${(totalValue + unrealized).toFixed(2)}`);
  console.log(`    Win rate:       ${portfolio.totalTrades > 0 ? ((portfolio.winCount / portfolio.totalTrades) * 100).toFixed(0) : "N/A"}% (${portfolio.totalTrades} trades)`);
  console.log(`    Active signals: ${weights.filter((w) => w.enabled).length}/${weights.length}`);
  console.log(`    Hypotheses:     ${hypotheses.filter((h) => h.status === "active").length} active, ${hypotheses.filter((h) => h.status === "promoted").length} promoted, ${hypotheses.filter((h) => h.status === "killed").length} killed`);
  console.log(`  ${"─".repeat(55)}\n`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
