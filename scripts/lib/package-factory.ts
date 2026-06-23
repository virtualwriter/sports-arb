import { createHash } from "node:crypto";
import type { Candidate } from "./monotonic-arb-core.js";
import type { StrategyDecision } from "./sports-strategy.js";
import type { SportsArbLeg, SportsArbPackage } from "./types.js";

export function idempotencyKey(candidate: Candidate): string {
  return createHash("sha256")
    .update([
      candidate.eventSlug,
      candidate.broad.marketId,
      candidate.narrow.marketId,
      candidate.broad.yesTokenId,
      candidate.narrow.noTokenId,
      candidate.packageCost.toFixed(4),
    ].join("|"))
    .digest("hex")
    .slice(0, 24);
}

function legFromQuote(quote: Candidate["broad"], side: "YES" | "NO"): SportsArbLeg {
  const book = side === "YES" ? quote.yesBook : quote.noBook;
  return {
    marketId: quote.marketId,
    question: quote.question,
    tokenId: side === "YES" ? quote.yesTokenId : quote.noTokenId,
    side,
    strike: quote.strike,
    ask: book.ask,
    bid: book.bid,
    size: book.askSize,
    direction: quote.direction,
  };
}

export function packageFromCandidate(args: {
  candidate: Candidate;
  decision: StrategyDecision;
  mode: "live" | "shadow";
  targetUsd: number;
  maxPackageUsd: number;
  metadataSnapshotId: string;
}): SportsArbPackage {
  const now = new Date().toISOString();
  const key = idempotencyKey(args.candidate);
  const targetUsd = Math.max(0, Math.min(args.targetUsd, args.maxPackageUsd));
  const intendedShares = args.candidate.packageCost > 0
    ? Math.min(args.candidate.availableSize, targetUsd / args.candidate.packageCost)
    : 0;
  return {
    packageId: `${args.candidate.eventSlug}::${args.candidate.broad.marketId}+${args.candidate.narrow.marketId}`,
    idempotencyKey: key,
    status: args.mode === "live" ? "live_qualified" : "shadow_open",
    mode: args.mode,
    shadowPurpose: args.mode === "shadow" ? args.decision.shadowPurpose : undefined,
    sport: {
      sportId: args.decision.adapter?.sportId ?? "UNKNOWN",
      league: args.decision.adapter?.displayName,
      gender: args.decision.adapter?.defaultGender ?? "unknown",
      adapterVersion: args.decision.adapter?.adapterVersion ?? "unknown",
    },
    event: {
      slug: args.candidate.eventSlug,
      title: args.candidate.eventTitle,
      startTime: args.candidate.broad.startDate ?? args.candidate.narrow.startDate,
      endTime: args.candidate.broad.endDate ?? args.candidate.narrow.endDate,
    },
    strategy: {
      marketType: args.decision.marketType,
      lineFamily: args.decision.lineFamily,
      middleWidth: args.decision.middleWidth,
      costBucket: args.decision.costBucket,
      comparisonGroup: args.decision.comparisonGroup,
      liveGateFailed: args.decision.gateFailures,
      wouldHaveQualifiedExceptFor: args.decision.gateFailures.length ? args.decision.gateFailures : undefined,
    },
    legs: {
      broad: legFromQuote(args.candidate.broad, "YES"),
      narrow: legFromQuote(args.candidate.narrow, "NO"),
    },
    pricing: {
      packageCost: args.candidate.packageCost,
      lockedEdge: args.candidate.lockedEdge,
      availableShares: args.candidate.availableSize,
      maxSpread: args.candidate.maxSpread,
      minLiquidity: args.candidate.minLiquidity,
    },
    sizing: {
      targetUsd,
      intendedShares,
      maxPackageUsd: args.maxPackageUsd,
    },
    lifecycleMs: { discovered: 0 },
    timestamps: { created: now, updated: now, discovered: now },
    metadataSnapshotId: args.metadataSnapshotId,
    sourceCandidate: args.candidate,
    resolution: { status: "unresolved", payoutPerShare: 0, source: "pending_polymarket_resolution" },
  };
}
