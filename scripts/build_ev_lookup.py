#!/usr/bin/env python3
"""Build walk-forward EV lookup table for sports-arb daemon gates.

Inputs:
  - monotonic-chronological-packages-continuous.csv (resolved scan universe)
  - Optional live ledger + trades.json for post-scan resolutions
  - gamma-market-cache-v2.json (+ live event supplement)

Output:
  data/ev-lookup.json with per-record training rows and aggregated band stats
  keyed by asset|marketType|lineFamily|band.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shape_roi_best_worst import (
    classify_shape,
    classify_shape_from_audit,
    load_gamma_cache,
    load_packages,
    market_meta,
    parse_package_id,
    stream_cost_bounds,
    supplement_gamma_cache_for_events,
)

BAND_CUTS = [1.18, 1.22, 1.25, 1.35]
DEFAULT_MIN_N = 10
DEFAULT_MERGE_MIN_N = 15
ASSETS = {"SOCCER", "MLB"}


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def band_label(cost: float, upper: float) -> str:
    if cost < 1:
        return "<1.000"
    return f"<=${upper:.2f}" if cost <= upper else f">${upper:.2f}"


def assign_coarse_band(cost: float, cuts: list[float] = BAND_CUTS) -> tuple[str, float]:
    """Return (band_label, upper_cut) for cost. Last band is >max(cuts)."""
    if cost < 1:
        return "<1.000", 1.0
    prev = 1.0
    for cut in cuts:
        if cost <= cut + 1e-9:
            if prev <= 1.0 + 1e-9:
                return f"<=${cut:.2f}", cut
            return f"{prev:.2f}-{cut:.2f}", cut
        prev = cut
    return f">{cuts[-1]:.2f}", cuts[-1]


def wilson_ci(successes: int, n: int, z: float = 1.96) -> dict[str, float]:
    if n <= 0:
        return {"lo": 0.0, "hi": 0.0}
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
    return {"lo": max(0.0, center - margin), "hi": min(1.0, center + margin)}


def load_live_resolved_records(
    data_dir: Path,
    trades_json: Path,
    gamma_cache: dict[str, dict[str, Any]],
    bounds: dict[str, dict[str, Any]],
    *,
    csv_package_ids: set[str],
) -> list[dict[str, Any]]:
    """Add resolved live fills not already in the continuous CSV."""
    if not trades_json.exists():
        return []

    payload = json.loads(trades_json.read_text())
    trades = payload.get("trades") if isinstance(payload, dict) else payload
    if not isinstance(trades, list):
        return []

    # Load ledger for shape metadata
    ledger: list[dict[str, Any]] = []
    live_path = data_dir / "polymarket-live-packages.json"
    if live_path.exists():
        ledger.extend(json.loads(live_path.read_text()))
    archive_dir = data_dir / "archive"
    if archive_dir.is_dir():
        for name in os.listdir(archive_dir):
            if not name.endswith(".json"):
                continue
            try:
                recs = json.loads((archive_dir / name).read_text())
            except (json.JSONDecodeError, OSError):
                continue
            for rec in recs if isinstance(recs, list) else [recs]:
                ledger.extend(rec.get("packages") or [])

    by_pid: dict[str, dict[str, Any]] = {}
    for row in ledger:
        pid = row.get("packageId")
        if pid:
            by_pid[str(pid)] = row

    event_slugs = {str(r.get("eventSlug") or "") for r in ledger if r.get("eventSlug")}
    supplement_gamma_cache_for_events(gamma_cache, event_slugs)

    out: list[dict[str, Any]] = []
    for trade in trades:
        if trade.get("orphan"):
            continue
        result = str(trade.get("result") or "")
        if not result.startswith("RESOLVED"):
            continue
        pid = str(trade.get("packageId") or "")
        if not pid or pid in csv_package_ids:
            continue
        ledger_row = by_pid.get(pid)
        if not ledger_row:
            continue
        asset = str(trade.get("sport") or ledger_row.get("asset") or "")
        if asset not in ASSETS:
            continue
        parsed = parse_package_id(pid)
        shape = None
        if parsed:
            shape = classify_shape(
                asset,
                market_meta(gamma_cache, parsed[0]),
                market_meta(gamma_cache, parsed[1]),
            )
        if not shape:
            slot = bounds.get(pid, {}).get("sample")
            if slot:
                shape = classify_shape_from_audit(asset, slot)
        if not shape:
            broad = ledger_row.get("broadStrike")
            narrow = ledger_row.get("narrowStrike")
            if broad is not None and narrow is not None:
                lo, hi = sorted([float(broad), float(narrow)])
                mt_label = str(trade.get("marketType") or "")
                if "Spread" in mt_label:
                    mt = "spread"
                elif asset == "SOCCER":
                    mt = "match_total"
                else:
                    mt = "game_total"
                shape = (mt, f"{lo:g}-{hi:g}", int(round(hi - lo)))

        if not shape:
            continue

        market_type, family, width = shape
        payout = 2 if result.startswith("RESOLVED 2/2") else 1
        cost_per_share = float(trade.get("costPerShare") or 0)
        if cost_per_share <= 0:
            continue
        created = parse_ts(str(trade.get("createdAt") or ledger_row.get("createdAt") or ""))
        if not created:
            continue

        slot = bounds.get(pid)
        best = slot["min"] if slot else cost_per_share
        worst = slot["max"] if slot else cost_per_share

        out.append({
            "packageId": pid,
            "asset": asset,
            "marketType": market_type,
            "lineFamily": family,
            "middleWidth": width,
            "bestCost": best,
            "worstCost": worst,
            "payout": payout,
            "firstObserved": created.isoformat(),
            "source": "live_trades_json",
            "eventSlug": trade.get("eventSlug") or ledger_row.get("eventSlug"),
        })
    return out


def csv_records(
    packages_csv: Path,
    gamma_cache: dict[str, dict[str, Any]],
    bounds: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in load_packages(packages_csv):
        payout_raw = row.get("payoutMultiple", "")
        if payout_raw not in {"1", "2"}:
            continue
        asset = row.get("asset", "")
        if asset not in ASSETS:
            continue
        package_id = row.get("packageId", "")
        parsed = parse_package_id(package_id)
        shape = None
        if parsed:
            shape = classify_shape(
                asset,
                market_meta(gamma_cache, parsed[0]),
                market_meta(gamma_cache, parsed[1]),
            )
        if not shape:
            slot = bounds.get(package_id, {}).get("sample")
            if slot:
                shape = classify_shape_from_audit(asset, slot)
        if not shape:
            continue

        market_type, family, width = shape
        first = parse_ts(row.get("firstObserved") or row.get("bestObserved"))
        if not first:
            continue
        csv_cost = float(row.get("cost") or 0)
        slot = bounds.get(package_id)
        best = slot["min"] if slot else csv_cost
        worst = slot["max"] if slot else csv_cost

        out.append({
            "packageId": package_id,
            "asset": asset,
            "marketType": market_type,
            "lineFamily": family,
            "middleWidth": width,
            "bestCost": best,
            "worstCost": worst,
            "payout": int(payout_raw),
            "firstObserved": first.isoformat(),
            "source": "continuous_csv",
            "eventSlug": row.get("eventSlug"),
        })
    return out


def aggregate_band(
    rows: list[dict[str, Any]],
    *,
    min_n: int,
) -> dict[str, Any] | None:
    if not rows:
        return None
    n = len(rows)
    middles = sum(1 for r in rows if r["payout"] == 2)
    best_cost_sum = sum(r["bestCost"] for r in rows)
    worst_cost_sum = sum(r["worstCost"] for r in rows)
    best_pnl = sum(r["payout"] - r["bestCost"] for r in rows)
    worst_pnl = sum(r["payout"] - r["worstCost"] for r in rows)
    return {
        "n": n,
        "middleRate": middles / n,
        "roiAtBest": 100 * best_pnl / best_cost_sum if best_cost_sum else 0.0,
        "roiAtWorst": 100 * worst_pnl / worst_cost_sum if worst_cost_sum else 0.0,
        "confidenceInterval": wilson_ci(middles, n),
        "mergedFrom": sorted({r.get("bandKey", "") for r in rows if r.get("bandKey")}),
    }


def build_lookup(
    records: list[dict[str, Any]],
    *,
    band_cuts: list[float],
    min_n: int,
    merge_min_n: int,
) -> dict[str, dict[str, Any]]:
    """Aggregate records into band keys with auto-merge-up for sparse buckets."""
    # Tag each record with coarse band
    for rec in records:
        band, cut = assign_coarse_band(rec["worstCost"], band_cuts)
        rec["band"] = band
        rec["bandCut"] = cut
        rec["bandKey"] = f"{rec['asset']}|{rec['marketType']}|{rec['lineFamily']}|{band}"

    lookup: dict[str, dict[str, Any]] = {}
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for rec in records:
        groups[(rec["asset"], rec["marketType"], rec["lineFamily"])].append(rec)

    for (asset, market_type, family), shape_rows in groups.items():
        # Bucket by assigned band string
        by_band: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for rec in shape_rows:
            by_band[rec["band"]].append(rec)

        band_order = sorted(by_band.keys(), key=lambda b: (
            0 if b.startswith("<") else 1,
            b,
        ))

        merged_pool: list[dict[str, Any]] = []
        for band in band_order:
            band_rows = by_band[band]
            merged_pool = merged_pool + band_rows
            key = f"{asset}|{market_type}|{family}|{band}"
            stats = aggregate_band(merged_pool if len(band_rows) < min_n else band_rows, min_n=1)
            if not stats:
                continue

            use_rows = band_rows
            merged = False
            if len(band_rows) < min_n and len(merged_pool) >= merge_min_n:
                use_rows = merged_pool
                merged = True
            elif len(band_rows) < min_n and len(merged_pool) >= min_n:
                use_rows = merged_pool
                merged = True

            final = aggregate_band(use_rows, min_n=1)
            if not final:
                continue
            final["band"] = band
            final["insufficientN"] = len(band_rows) < min_n
            final["mergedUp"] = merged
            if merged:
                final["mergedFrom"] = band_order[: band_order.index(band) + 1]
            lookup[key] = final

    return lookup


def build(args: argparse.Namespace) -> dict[str, Any]:
    repo = Path(args.repo_root)
    data_dir = Path(args.data_dir)
    packages_csv = repo / args.packages
    gamma_cache_path = repo / args.gamma_cache
    trades_json = data_dir / args.trades_json

    gamma_cache = load_gamma_cache(gamma_cache_path)
    bounds = stream_cost_bounds([Path(p) for p in args.audit])

    csv_recs = csv_records(packages_csv, gamma_cache, bounds)
    csv_ids = {r["packageId"] for r in csv_recs}
    live_recs = load_live_resolved_records(
        data_dir,
        trades_json,
        gamma_cache,
        bounds,
        csv_package_ids=csv_ids,
    )
    records = csv_recs + live_recs
    records.sort(key=lambda r: r["firstObserved"])

    lookup = build_lookup(
        records,
        band_cuts=BAND_CUTS,
        min_n=args.min_n,
        merge_min_n=args.merge_min_n,
    )

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "config": {
            "bandCuts": BAND_CUTS,
            "minN": args.min_n,
            "mergeMinN": args.merge_min_n,
            "assets": sorted(ASSETS),
        },
        "sources": {
            "packagesCsv": str(packages_csv),
            "tradesJson": str(trades_json) if trades_json.exists() else None,
            "csvRecords": len(csv_recs),
            "liveRecords": len(live_recs),
            "totalRecords": len(records),
        },
        "records": records,
        "lookup": lookup,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build EV lookup for sports-arb gates")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--data-dir", default=os.environ.get("SPORTS_ARB_DATA_DIR", "data"))
    parser.add_argument(
        "--packages",
        default="analysis/monotonic-chronological-packages-continuous.csv",
    )
    parser.add_argument("--gamma-cache", default="analysis/gamma-market-cache-v2.json")
    parser.add_argument("--trades-json", default="reports/sports-pnl-report/trades.json")
    parser.add_argument("--audit", action="append", default=[])
    parser.add_argument("--min-n", type=int, default=DEFAULT_MIN_N)
    parser.add_argument("--merge-min-n", type=int, default=DEFAULT_MERGE_MIN_N)
    parser.add_argument("--out", default="data/ev-lookup.json")
    args = parser.parse_args()

    report = build(args)
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = Path(args.data_dir) / out_path.name if out_path.parent == Path("data") else out_path

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"[ev-lookup] records={report['sources']['totalRecords']} "
        f"lookup_keys={len(report['lookup'])} -> {out_path}"
    )


if __name__ == "__main__":
    main()
