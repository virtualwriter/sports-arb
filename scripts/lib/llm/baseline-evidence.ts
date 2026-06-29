// Frozen Jun 16-22 backtest baseline. Loaded from
// analysis/monotonic-chronological-ledger-long.csv, which aggregates 4458
// resolved packages from the original monotonic audit corpus before disk
// pressure forced log truncation. The static CSV is the only surviving
// per-cost-bucket historical record for that window; it gives the LLM and the
// nightly rebuild a stable yardstick against which the (much smaller) live
// ledger can be compared.
//
// The CSV has many rows per bucket (one per bet_size). All bet-size rows for
// the same bucket share the same resolved_candidates / middle_rate /
// realized_roi_pct -- those numbers describe the population, not the sizing.
// We collapse to one row per bucket here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BaselineBucket = {
  bucket: string;
  resolved: number;
  middles: number;
  middleRate: number;
  realizedRoiPct: number;
  source: "monotonic-chronological-ledger-long.csv";
};

const BASELINE_CSV = join(process.cwd(), "analysis", "monotonic-chronological-ledger-long.csv");

const BUCKET_LABEL_REWRITE: Record<string, string> = {
  "1.005-1.02": "1.005-1.020",
  "1.02-1.05": "1.020-1.050",
  "1.05-1.10": "1.050-1.100",
  "1.10-1.16": "1.100-1.160",
  "1.16-1.25": "1.160-1.250",
  "1.25-2.00": "1.250-2.000",
};

function rewriteBucket(label: string): string {
  return BUCKET_LABEL_REWRITE[label] ?? label;
}

function parseCsvLine(line: string): string[] {
  // The CSV uses no embedded commas in fields we read (notes column would, but
  // it's the last column and we don't index it), so naive split is enough.
  return line.split(",");
}

export function loadBaselineBuckets(path: string = BASELINE_CSV): BaselineBucket[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {
    scenarioType: header.indexOf("scenario_type"),
    scenario: header.indexOf("scenario"),
    resolved: header.indexOf("resolved_candidates"),
    middles: header.indexOf("middles"),
    middleRate: header.indexOf("middle_rate_realized"),
    realizedRoi: header.indexOf("realized_roi_pct"),
  };
  const seen = new Set<string>();
  const out: BaselineBucket[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (cells[idx.scenarioType] !== "bucket") continue;
    const bucket = rewriteBucket(cells[idx.scenario]);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    out.push({
      bucket,
      resolved: Number(cells[idx.resolved]) || 0,
      middles: Number(cells[idx.middles]) || 0,
      middleRate: Number(cells[idx.middleRate]) || 0,
      realizedRoiPct: Number(cells[idx.realizedRoi]) || 0,
      source: "monotonic-chronological-ledger-long.csv",
    });
  }
  return out;
}

export function baselineForBucket(buckets: BaselineBucket[], costBucket: string): BaselineBucket | null {
  return buckets.find((b) => b.bucket === costBucket) ?? null;
}
