import type { Candidate, Direction } from "./monotonic-arb-core.js";

export type SportId =
  | "MLB"
  | "SOCCER"
  | "COLLEGE_BASEBALL"
  | "TENNIS"
  | "WOMENS_TENNIS"
  | "GOLF"
  | "NCAAF"
  | "NFL"
  | "WNBA"
  | "NBA"
  | "UNKNOWN";

export type SportGender = "men" | "women" | "mixed" | "unknown";
export type AdapterMode = "live_enabled" | "shadow_only" | "discovery_only";
export type MarketType = "game_total" | "match_total" | "spread" | "team_total" | "player_prop" | "unknown";
export type PackageMode = "live" | "shadow";
export type ShadowPurpose = "sub_1_universal_capture" | "excluded_cost_bucket_probe" | "excluded_shape_probe" | "near_live_cut" | "operational_reject";

export type PackageStatus =
  | "candidate"
  | "shadow_open"
  | "live_qualified"
  | "preflight_passed"
  | "submitting"
  | "leg1_filled"
  | "paired"
  | "orphan"
  | "flattened"
  | "resolved"
  | "cancelled";

export type LifecycleStep =
  | "discovered"
  | "qualified"
  | "preflight_started"
  | "preflight_passed"
  | "submit_started"
  | "leg1_submitted"
  | "leg1_filled"
  | "leg2_submitted"
  | "paired"
  | "orphan_detected"
  | "completion_attempted"
  | "flattened"
  | "resolved"
  | "archived";

export type SportsArbLeg = {
  marketId: string;
  question: string;
  tokenId: string;
  side: "YES" | "NO";
  strike: number;
  ask: number;
  bid: number;
  size: number;
  direction: Direction;
};

export type SportsArbPackage = {
  packageId: string;
  idempotencyKey: string;
  status: PackageStatus;
  mode: PackageMode;
  shadowPurpose?: ShadowPurpose;
  sport: {
    sportId: SportId;
    league?: string;
    gender?: SportGender;
    adapterVersion: string;
  };
  event: {
    slug: string;
    title: string;
    startTime: string | null;
    endTime: string | null;
  };
  strategy: {
    marketType: MarketType;
    lineFamily: string;
    middleWidth: number;
    costBucket: string;
    comparisonGroup: string;
    liveGateFailed?: string[];
    wouldHaveQualifiedExceptFor?: string[];
  };
  legs: {
    broad: SportsArbLeg;
    narrow: SportsArbLeg;
  };
  pricing: {
    packageCost: number;
    lockedEdge: number;
    availableShares: number;
    maxSpread: number;
    minLiquidity: number;
    /** WS → preflight → fill price path when persisted by the daemon. */
    executionQuote?: {
      wsCost: number;
      freshCost: number;
      actualPairCost: number | null;
      preflightFetchMs?: number;
      fillSlippageCents: number | null;
      preflightDriftCents: number | null;
    };
  };
  sizing: {
    targetUsd: number;
    intendedShares: number;
    maxPackageUsd: number;
  };
  lifecycleMs: Partial<Record<LifecycleStep, number>>;
  timestamps: Partial<Record<LifecycleStep | "created" | "updated", string>>;
  metadataSnapshotId: string;
  sourceCandidate: Candidate;
  resolution?: {
    status: "unresolved" | "resolved" | "manual_review";
    payoutPerShare: number;
    pnlUsd?: number;
    roiPct?: number;
    source: string;
    resolvedAt?: string;
    winningTokenIds?: string[];
    notes?: string[];
  };
};

export type MarketMetadataSnapshot = {
  snapshotId: string;
  capturedAt: string;
  eventSlug: string;
  eventTitle: string;
  marketIds: string[];
  gammaEvent: unknown;
  clobBooks?: Record<string, unknown>;
};

export type ShadowLedgerRow = {
  recordedAt: string;
  package: SportsArbPackage;
};

export type OrphanIncident = {
  incidentId: string;
  packageId: string;
  detectedAt: string;
  unmatchedShares: number;
  dustThresholdShares: number;
  severity: "dust" | "large";
  action: "ignored_dust" | "paused_live_trading";
  reason: string;
  reviewedAt?: string;
  reviewNote?: string;
};

export type HealthSnapshot = {
  updatedAt: string;
  status: "ok" | "paused" | "degraded";
  lastScanAt?: string;
  lastOrderAttemptAt?: string;
  lastResolutionPassAt?: string;
  lastLlmRunAt?: string;
  clobAuth: "unknown" | "ok" | "failed";
  websocket: "unknown" | "connected" | "disconnected";
  walletBalanceUsd?: number;
  openPackages: number;
  largeOrphanActive: boolean;
  killSwitchActive: boolean;
  notes: string[];
};
