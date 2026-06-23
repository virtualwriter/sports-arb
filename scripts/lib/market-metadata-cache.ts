import { createHash } from "node:crypto";
import { PATHS } from "./paths.js";
import { appendJsonl, readJsonl } from "./storage.js";
import type { MarketMetadataSnapshot } from "./types.js";

export function snapshotId(eventSlug: string, capturedAt: string): string {
  return createHash("sha256").update(`${eventSlug}|${capturedAt}`).digest("hex").slice(0, 16);
}

export function recordMarketMetadataSnapshot(args: {
  eventSlug: string;
  eventTitle: string;
  marketIds: string[];
  gammaEvent: unknown;
  clobBooks?: Record<string, unknown>;
  capturedAt?: string;
}): MarketMetadataSnapshot {
  const capturedAt = args.capturedAt ?? new Date().toISOString();
  const snapshot: MarketMetadataSnapshot = {
    snapshotId: snapshotId(args.eventSlug, capturedAt),
    capturedAt,
    eventSlug: args.eventSlug,
    eventTitle: args.eventTitle,
    marketIds: args.marketIds,
    gammaEvent: args.gammaEvent,
    clobBooks: args.clobBooks,
  };
  appendJsonl(PATHS.metadataCache, snapshot);
  return snapshot;
}

export function latestMetadataSnapshot(eventSlug: string): MarketMetadataSnapshot | null {
  const rows = readJsonl<MarketMetadataSnapshot>(PATHS.metadataCache, 10_000)
    .filter((row) => row.eventSlug === eventSlug)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return rows[0] ?? null;
}
