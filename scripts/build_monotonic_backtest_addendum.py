#!/usr/bin/env python3
"""
Build Jun 23–present backtest addendum from monotonic-middle-audit.jsonl.

Keeps the frozen Jun 16–22 baseline CSVs untouched. Writes:
  - analysis/monotonic-middle-report.addendum.json
  - analysis/monotonic-chronological-packages-addendum.csv
  - analysis/monotonic-chronological-packages-combined.csv
  - analysis/monotonic-backtest-comparison.json
  - docs/SPORTS-MONOTONIC-SOCCER-MLB-ADDENDUM.md

Dedupes against analysis/monotonic-chronological-packages-long.csv by packageId
(one row per package, lowest observed cost).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from monotonic_middle_report import (
    bucket_label,
    parse_ts,
    resolve_samples,
)

SPORTS_ASSETS = {"SOCCER", "MLB"}
ADDENDUM_SINCE_DEFAULT = "2026-06-22T20:27:13Z"

# Match monotonic-chronological-packages-long.csv bucket labels.
LEDGER_BUCKETS = [
    (float("-inf"), 0.9999999, "<1.000"),
    (0.9999999, 1.0050001, "1.000-1.005"),
    (1.0050001, 1.02, "1.005-1.02"),
    (1.02, 1.05, "1.02-1.05"),
    (1.05, 1.10, "1.05-1.10"),
    (1.10, 1.16, "1.10-1.16"),
    (1.16, 1.25, "1.16-1.25"),
    (1.25, float("inf"), "1.25-2.00"),
]

SHAPE_COST_BUCKETS = [
    (1.05, 1.10, "1.050-1.100"),
    (1.10, 1.16, "1.100-1.160"),
    (1.16, 1.19, "1.160-1.190"),
    (1.19, 1.22, "1.190-1.220"),
    (1.22, 1.25, "1.220-1.250"),
    (1.25, 1.35, "1.250-1.350"),
    (1.35, 1.50, "1.350-1.500"),
]


def ledger_bucket(cost: float) -> str:
    return bucket_label(cost, LEDGER_BUCKETS)


def load_baseline_package_ids(path: Path) -> set[str]:
    with path.open(newline="") as handle:
        return {row["packageId"] for row in csv.DictReader(handle) if row.get("packageId")}


def load_baseline_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def stream_addendum_samples(
    audit_path: Path,
    since: dt.datetime,
    exclude_ids: set[str],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    observations = 0
    skipped_baseline = 0
    min_ts: dt.datetime | None = None
    max_ts: dt.datetime | None = None

    with audit_path.open(errors="replace") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            observed_at = parse_ts(row.get("observedAt"))
            if observed_at is None or observed_at < since:
                continue
            observations += 1
            min_ts = observed_at if min_ts is None or observed_at < min_ts else min_ts
            max_ts = observed_at if max_ts is None or observed_at > max_ts else max_ts
            package_id = row.get("packageId")
            if not package_id:
                continue
            if package_id in exclude_ids:
                skipped_baseline += 1
                continue
            sample_cost = float(row.get("packageCost", 99))
            previous = best.get(package_id)
            if previous is None or sample_cost < float(previous.get("packageCost", 99)):
                best[package_id] = row

    return best, {
        "observations": observations,
        "skippedBaselineHits": skipped_baseline,
        "range": [
            min_ts.isoformat().replace("+00:00", "Z") if min_ts else None,
            max_ts.isoformat().replace("+00:00", "Z") if max_ts else None,
        ],
    }


def classify_market_type(sample: dict[str, Any]) -> str:
    asset = str(sample.get("asset", ""))
    q_broad = str((sample.get("broad") or {}).get("question", "")).lower()
    q_narrow = str((sample.get("narrow") or {}).get("question", "")).lower()
    text = " ".join([q_broad, q_narrow])
    if "team-total" in text or "team total" in text:
        return "team_total"
    if "spread" in text:
        return "spread"
    if asset == "SOCCER":
        if "total" in text or "o/u" in text or "over/under" in text:
            return "match_total"
        return "unknown"
    if asset == "MLB":
        if "total" in text or "o/u" in text or "over/under" in text:
            return "game_total"
        return "unknown"
    return "unknown"


def line_family(sample: dict[str, Any]) -> str:
    try:
        broad = float((sample.get("broad") or {})["strike"])
        narrow = float((sample.get("narrow") or {})["strike"])
    except (KeyError, TypeError, ValueError):
        return "?"
    return f"{broad:g}-{narrow:g}"


def middle_width(sample: dict[str, Any]) -> int | None:
    try:
        broad = float((sample.get("broad") or {})["strike"])
        narrow = float((sample.get("narrow") or {})["strike"])
    except (KeyError, TypeError, ValueError):
        return None
    return int(round(abs(narrow - broad)))


def shape_cost_bucket(cost: float) -> str | None:
    for low, high, label in SHAPE_COST_BUCKETS:
        if low < cost <= high:
            return label
    return None


def package_csv_row(sample: dict[str, Any], source: str) -> dict[str, str]:
    cost = float(sample.get("packageCost", 0))
    observed = str(sample.get("observedAt", ""))
    gate = sample.get("gate") or {}
    blockers = gate.get("blockers") or []
    payout = sample.get("resolvedPayout")
    return {
        "packageId": str(sample.get("packageId", "")),
        "bucket": ledger_bucket(cost),
        "cost": f"{cost:g}",
        "bestObserved": observed,
        "firstObserved": observed,
        "endDate": str(sample.get("endDate") or ""),
        "eventSlug": str(sample.get("eventSlug") or ""),
        "asset": str(sample.get("asset") or ""),
        "source": source,
        "gateOk": "True" if not blockers else "False",
        "availableSize": str(sample.get("availableSize") or ""),
        "minShares": str(sample.get("minShares") or ""),
        "payoutMultiple": "" if payout is None else str(int(payout)),
    }


def aggregate_population(rows: list[dict[str, Any]], *, sports_only: bool) -> dict[str, Any]:
    filtered = [
        row for row in rows
        if row.get("resolvedPayout") in (0, 1, 2)
        and (not sports_only or row.get("asset") in SPORTS_ASSETS)
    ]
    payout_counts = Counter(int(row["resolvedPayout"]) for row in filtered)
    total_cost = sum(float(row.get("packageCost") or row.get("cost") or 0) for row in filtered)
    total_pnl = sum(
        int(row["resolvedPayout"]) - float(row.get("packageCost") or row.get("cost") or 0)
        for row in filtered
    )
    by_sport: dict[str, dict[str, Any]] = defaultdict(lambda: {"resolved": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})
    by_bucket: dict[str, dict[str, Any]] = defaultdict(lambda: {"resolved": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})

    for row in filtered:
        asset = str(row.get("asset", ""))
        cost = float(row.get("packageCost") or row.get("cost") or 0)
        payout = int(row["resolvedPayout"])
        sport = by_sport[asset]
        sport["resolved"] += 1
        sport["middles"] += 1 if payout == 2 else 0
        sport["cost_sum"] += cost
        sport["pnl_sum"] += payout - cost
        bucket = ledger_bucket(cost)
        bucket_row = by_bucket[bucket]
        bucket_row["resolved"] += 1
        bucket_row["middles"] += 1 if payout == 2 else 0
        bucket_row["cost_sum"] += cost
        bucket_row["pnl_sum"] += payout - cost

    def finish(groups: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for key, stats in groups.items():
            resolved = stats["resolved"]
            cost_sum = stats["cost_sum"]
            out.append({
                "key": key,
                "resolved": resolved,
                "middles": stats["middles"],
                "middleRate": stats["middles"] / resolved if resolved else 0.0,
                "avgCost": cost_sum / resolved if resolved else 0.0,
                "observedCostRoi": stats["pnl_sum"] / cost_sum if cost_sum else 0.0,
            })
        out.sort(key=lambda item: item["resolved"], reverse=True)
        return out

    return {
        "resolvedPackages": len(filtered),
        "middleHits": payout_counts.get(2, 0),
        "floorOnly": payout_counts.get(1, 0),
        "zeroPayout": payout_counts.get(0, 0),
        "observedCostRoi": total_pnl / total_cost if total_cost else 0.0,
        "bySport": finish(by_sport),
        "byCostBucket": finish(by_bucket),
    }


def baseline_rows_to_resolved(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        payout = row.get("payoutMultiple")
        if payout not in ("0", "1", "2"):
            continue
        out.append({
            "packageId": row["packageId"],
            "asset": row["asset"],
            "packageCost": float(row["cost"]),
            "resolvedPayout": int(payout),
        })
    return out


def aggregate_shapes(resolved: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = defaultdict(lambda: {"resolved": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})
    for sample in resolved:
        if sample.get("asset") not in SPORTS_ASSETS:
            continue
        cost = float(sample.get("packageCost", 0))
        payout = int(sample.get("resolvedPayout", 0))
        market_type = classify_market_type(sample)
        width = middle_width(sample)
        bucket = shape_cost_bucket(cost)
        if width is None or bucket is None:
            continue
        key = f"{sample.get('asset')}|{market_type}|{width}-unit|{bucket}"
        group = groups[key]
        group["resolved"] += 1
        group["middles"] += 1 if payout == 2 else 0
        group["cost_sum"] += cost
        group["pnl_sum"] += payout - cost

    rows = []
    for key, stats in groups.items():
        if stats["resolved"] < 5:
            continue
        asset, market_type, width_label, bucket = key.split("|", 3)
        rows.append({
            "asset": asset,
            "marketType": market_type,
            "middleWidth": width_label.replace("-unit", ""),
            "costBucket": bucket,
            "resolved": stats["resolved"],
            "middles": stats["middles"],
            "middleRate": stats["middles"] / stats["resolved"],
            "avgCost": stats["cost_sum"] / stats["resolved"],
            "observedCostRoi": stats["pnl_sum"] / stats["cost_sum"] if stats["cost_sum"] else 0.0,
        })
    rows.sort(key=lambda item: item["observedCostRoi"], reverse=True)
    return rows


def aggregate_line_families(resolved: list[dict[str, Any]], *, min_n: int = 8) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = defaultdict(lambda: {"resolved": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})
    for sample in resolved:
        if sample.get("asset") not in SPORTS_ASSETS:
            continue
        cost = float(sample.get("packageCost", 0))
        payout = int(sample.get("resolvedPayout", 0))
        market_type = classify_market_type(sample)
        family = line_family(sample)
        if family == "?":
            continue
        key = f"{sample.get('asset')}|{market_type}|{family}"
        group = groups[key]
        group["resolved"] += 1
        group["middles"] += 1 if payout == 2 else 0
        group["cost_sum"] += cost
        group["pnl_sum"] += payout - cost

    rows = []
    for key, stats in groups.items():
        if stats["resolved"] < min_n:
            continue
        asset, market_type, family = key.split("|", 2)
        rows.append({
            "asset": asset,
            "marketType": market_type,
            "lineFamily": family,
            "resolved": stats["resolved"],
            "middles": stats["middles"],
            "middleRate": stats["middles"] / stats["resolved"],
            "avgCost": stats["cost_sum"] / stats["resolved"],
            "observedCostRoi": stats["pnl_sum"] / stats["cost_sum"] if stats["cost_sum"] else 0.0,
        })
    rows.sort(key=lambda item: (item["asset"], -item["observedCostRoi"]))
    return rows


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def roi(value: float) -> str:
    sign = "+" if value >= 0 else ""
    return f"{sign}{value * 100:.1f}%"


def write_packages_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = [
        "packageId", "bucket", "cost", "bestObserved", "firstObserved", "endDate",
        "eventSlug", "asset", "source", "gateOk", "availableSize", "minShares", "payoutMultiple",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def render_markdown(
    *,
    since: str,
    observed_range: list[str | None],
    baseline_stats: dict[str, Any],
    addendum_stats: dict[str, Any],
    combined_stats: dict[str, Any],
    addendum_shapes: list[dict[str, Any]],
    addendum_families: list[dict[str, Any]],
    middle_report: dict[str, Any],
    shadows_note: str,
    generated_at: str,
) -> str:
    lines: list[str] = []
    lines.append("# Soccer and MLB Monotonic Middle Strategy — Addendum")
    lines.append("")
    lines.append("## Addendum: Jun 23 – present")
    lines.append("")
    lines.append("This document extends `docs/SPORTS-MONOTONIC-SOCCER-MLB.md` without modifying the frozen Jun 16–22 baseline CSVs.")
    lines.append("")
    lines.append(f"- Generated: `{generated_at}`")
    lines.append(f"- Addendum window starts: `{since}`")
    lines.append(f"- Observed range: `{observed_range[0]}` → `{observed_range[1]}`")
    lines.append(f"- Source audit: `{middle_report.get('source')}`")
    lines.append(f"- Deduped against: `analysis/monotonic-chronological-packages-long.csv` ({middle_report.get('excludedBaselinePackageIds', 'n/a')} baseline packageIds skipped on re-observation)")
    lines.append(f"- Shadow ledger note: {shadows_note}")
    lines.append("")

    lines.append("## Three-way population summary (SOCCER + MLB, resolved only)")
    lines.append("")
    lines.append("| Population | Resolved | Middles | Middle rate | Observed-cost ROI |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for label, stats in [
        ("Baseline only (frozen Jun 16–22)", baseline_stats),
        ("Addendum only (Jun 23–present, deduped)", addendum_stats),
        ("Combined (baseline + addendum)", combined_stats),
    ]:
        lines.append(
            f"| {label} | {stats['resolvedPackages']} | {stats['middleHits']} | "
            f"{pct(stats['middleHits'] / stats['resolvedPackages'] if stats['resolvedPackages'] else 0)} | "
            f"{roi(stats['observedCostRoi'])} |"
        )
    lines.append("")

    lines.append("## Sport breakdown")
    lines.append("")
    lines.append("| Population | Sport | Resolved | Middles | Middle rate | Observed-cost ROI |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for pop_label, stats in [
        ("Baseline", baseline_stats),
        ("Addendum", addendum_stats),
        ("Combined", combined_stats),
    ]:
        for row in stats["bySport"]:
            if row["key"] not in SPORTS_ASSETS:
                continue
            lines.append(
                f"| {pop_label} | {row['key']} | {row['resolved']} | {row['middles']} | "
                f"{pct(row['middleRate'])} | {roi(row['observedCostRoi'])} |"
            )
    lines.append("")

    lines.append("## Cost bucket breakdown (ledger buckets)")
    lines.append("")
    lines.append("| Population | Bucket | Resolved | Middles | Middle rate | Observed-cost ROI |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for pop_label, stats in [
        ("Baseline", baseline_stats),
        ("Addendum", addendum_stats),
        ("Combined", combined_stats),
    ]:
        for row in sorted(stats["byCostBucket"], key=lambda item: item["key"]):
            lines.append(
                f"| {pop_label} | `{row['key']}` | {row['resolved']} | {row['middles']} | "
                f"{pct(row['middleRate'])} | {roi(row['observedCostRoi'])} |"
            )
    lines.append("")

    lines.append("## Addendum scan coverage (all assets, from middle audit)")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Unique scanned packages | {middle_report.get('uniqueScannedPackages')} |")
    lines.append(f"| Resolved packages | {middle_report.get('resolvedPackages')} |")
    lines.append(f"| Unknown / open | {middle_report.get('unknownOrOpenPackages')} |")
    lines.append(f"| Middle hits | {middle_report.get('middleHits')} |")
    lines.append(f"| Floor only | {middle_report.get('floorOnly')} |")
    lines.append(f"| Zero payout | {middle_report.get('zeroPayout')} |")
    lines.append("")

    lines.append("## Addendum shape tables (SOCCER + MLB, n ≥ 5)")
    lines.append("")
    if not addendum_shapes:
        lines.append("_No shape buckets met the minimum sample threshold in the addendum window._")
    else:
        lines.append("| Asset | Market type | Middle width | Cost bucket | Resolved | Middles | Hit rate | Avg cost | ROI |")
        lines.append("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |")
        for row in addendum_shapes[:20]:
            lines.append(
                f"| {row['asset']} | {row['marketType']} | {row['middleWidth']} | `{row['costBucket']}` | "
                f"{row['resolved']} | {row['middles']} | {pct(row['middleRate'])} | "
                f"{row['avgCost']:.3f} | {roi(row['observedCostRoi'])} |"
            )
    lines.append("")

    lines.append("## Addendum line families (SOCCER + MLB, n ≥ 8)")
    lines.append("")
    if not addendum_families:
        lines.append("_No line families met the minimum sample threshold in the addendum window._")
    else:
        lines.append("| Asset | Market type | Line family | Resolved | Middles | Hit rate | Avg cost | ROI |")
        lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |")
        for row in addendum_families[:25]:
            lines.append(
                f"| {row['asset']} | {row['marketType']} | `{row['lineFamily']}` | "
                f"{row['resolved']} | {row['middles']} | {pct(row['middleRate'])} | "
                f"{row['avgCost']:.3f} | {roi(row['observedCostRoi'])} |"
            )
    lines.append("")

    lines.append("## Live fills overlay (daemon ledger, not full scan universe)")
    lines.append("")
    lines.append("For **live execution evidence** since Jun 23 (actual fills, slippage, enforced gate buckets), run:")
    lines.append("")
    lines.append("```bash")
    lines.append("SPORTS_ARB_DATA_DIR=/var/lib/sports-arb/data npm run strategy:rebuild")
    lines.append("```")
    lines.append("")
    lines.append("That pipeline compares the frozen baseline CSV to resolved trades in `polymarket-live-packages.json`. It does **not** re-scan the full middle-audit universe.")
    lines.append("")
    lines.append("## Interpretation notes")
    lines.append("")
    lines.append("- **Baseline** numbers match the frozen Jun 16–22 CSV and the primary strategy doc.")
    lines.append("- **Addendum** is out-of-sample relative to the baseline build; packageIds already in the baseline CSV were excluded even if re-observed after Jun 22.")
    lines.append("- **Combined** merges resolved baseline rows with deduped addendum rows; use this for updated priors, but inspect addendum-only rows when gates tightened post-Jun 23.")
    lines.append("- Material ROI divergence between baseline and addendum on the same bucket usually means either regime shift or stricter live shape gates — not necessarily a broken model.")
    lines.append("")
    return "\n".join(lines)


def build_middle_report_from_samples(
    samples: dict[str, dict[str, Any]],
    meta: dict[str, Any],
    *,
    audit_path: str,
    since: str | None,
    excluded_baseline: int,
) -> dict[str, Any]:
    resolved, unknown = resolve_samples(samples)
    payout_counts = Counter(sample.get("resolvedPayout") for sample in resolved)
    from monotonic_middle_report import (
        clean_blocker_rows,
        coverage_rows,
        depth_rows,
        example_rows,
        spread_counterfactual_rows,
        wide_cost_rows,
    )
    return {
        "label": "Addendum: Jun 23 – present",
        "source": audit_path,
        "since": since,
        "excludedBaselinePackageIds": excluded_baseline,
        "observedRange": meta["range"],
        "observations": meta["observations"],
        "uniqueScannedPackages": len(samples),
        "resolvedPackages": len(resolved),
        "unknownOrOpenPackages": len(unknown),
        "middleHits": payout_counts.get(2, 0),
        "floorOnly": payout_counts.get(1, 0),
        "zeroPayout": payout_counts.get(0, 0),
        "coverageRows": coverage_rows(resolved, unknown),
        "cleanBlockerRows": clean_blocker_rows(samples, resolved),
        "spreadCounterfactualRows": spread_counterfactual_rows(resolved),
        "wideCostRows": wide_cost_rows(resolved),
        "depthRows": depth_rows(samples),
        "exampleRows": example_rows(resolved),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build monotonic backtest addendum artifacts.")
    parser.add_argument("--audit", default="/var/lib/sports-arb/data/monotonic-middle-audit.jsonl")
    parser.add_argument("--baseline-packages", default="analysis/monotonic-chronological-packages-long.csv")
    parser.add_argument("--since", default=ADDENDUM_SINCE_DEFAULT)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--skip-gamma", action="store_true", help="Skip Gamma resolution (debug only)")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    since = parse_ts(args.since)
    if since is None:
        raise SystemExit(f"Invalid --since timestamp: {args.since}")

    baseline_path = repo_root / args.baseline_packages
    if not baseline_path.exists():
        raise SystemExit(f"Missing baseline packages CSV: {baseline_path}")

    audit_path = Path(args.audit)
    if not audit_path.exists():
        raise SystemExit(f"Missing audit JSONL: {audit_path}")

    baseline_ids = load_baseline_package_ids(baseline_path)
    baseline_rows = load_baseline_rows(baseline_path)
    print(f"[addendum] baseline packageIds: {len(baseline_ids):,}", flush=True)

    samples, meta = stream_addendum_samples(audit_path, since, baseline_ids)
    print(
        f"[addendum] observations={meta['observations']:,} unique={len(samples):,} "
        f"range={meta['range'][0]}..{meta['range'][1]}",
        flush=True,
    )

    if args.skip_gamma:
        resolved, unknown = [], list(samples.values())
    else:
        print(f"[addendum] resolving {len(samples):,} packages via Gamma…", flush=True)
        resolved, unknown = resolve_samples(samples)
        print(f"[addendum] resolved={len(resolved):,} unknown/open={len(unknown):,}", flush=True)

    middle_report = build_middle_report_from_samples(
        samples,
        meta,
        audit_path=str(audit_path),
        since=args.since,
        excluded_baseline=len(baseline_ids),
    )

    addendum_csv_rows = [
        package_csv_row(sample, "middle_audit_addendum")
        for sample in sorted(resolved + unknown, key=lambda row: str(row.get("packageId")))
    ]
    for row in addendum_csv_rows:
        resolved_match = next((s for s in resolved if s.get("packageId") == row["packageId"]), None)
        if resolved_match is not None:
            row["payoutMultiple"] = str(int(resolved_match["resolvedPayout"]))

    addendum_packages_path = repo_root / "analysis/monotonic-chronological-packages-addendum.csv"
    combined_packages_path = repo_root / "analysis/monotonic-chronological-packages-combined.csv"
    middle_report_path = repo_root / "analysis/monotonic-middle-report.addendum.json"
    comparison_path = repo_root / "analysis/monotonic-backtest-comparison.json"
    markdown_path = repo_root / "docs/SPORTS-MONOTONIC-SOCCER-MLB-ADDENDUM.md"

    write_packages_csv(addendum_packages_path, addendum_csv_rows)
    write_packages_csv(combined_packages_path, baseline_rows + addendum_csv_rows)

    baseline_resolved = baseline_rows_to_resolved(baseline_rows)
    addendum_resolved = [dict(sample) for sample in resolved]
    combined_resolved = [
        row for row in baseline_resolved if row.get("asset") in SPORTS_ASSETS
    ] + [
        {
            "packageId": sample.get("packageId"),
            "asset": sample.get("asset"),
            "packageCost": float(sample.get("packageCost", 0)),
            "resolvedPayout": int(sample.get("resolvedPayout", 0)),
        }
        for sample in resolved
        if sample.get("asset") in SPORTS_ASSETS
    ]

    baseline_stats = aggregate_population(baseline_resolved, sports_only=True)
    addendum_stats = aggregate_population(addendum_resolved, sports_only=True)
    combined_stats = aggregate_population(combined_resolved, sports_only=True)

    addendum_shapes = aggregate_shapes(addendum_resolved)
    addendum_families = aggregate_line_families(addendum_resolved)

    comparison = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "since": args.since,
        "baseline": baseline_stats,
        "addendum": addendum_stats,
        "combined": combined_stats,
        "addendumShapes": addendum_shapes,
        "addendumLineFamilies": addendum_families,
        "middleReportSummary": {
            key: middle_report[key]
            for key in [
                "uniqueScannedPackages", "resolvedPackages", "unknownOrOpenPackages",
                "middleHits", "floorOnly", "zeroPayout", "observedRange",
            ]
        },
    }

    middle_report_path.parent.mkdir(parents=True, exist_ok=True)
    middle_report_path.write_text(json.dumps(middle_report, indent=2, sort_keys=True) + "\n")
    comparison_path.write_text(json.dumps(comparison, indent=2) + "\n")

    shadows_path = repo_root / "data/sports-arb-shadows.jsonl"
    shadows_note = (
        "`sports-arb-shadows.jsonl` was not present on production; shape tables were derived from "
        "`monotonic-middle-audit.jsonl` broad/narrow fields instead."
        if not shadows_path.exists()
        else "Shape tables prefer audit broad/narrow fields; shadow ledger was also available."
    )

    markdown = render_markdown(
        since=args.since,
        observed_range=meta["range"],
        baseline_stats=baseline_stats,
        addendum_stats=addendum_stats,
        combined_stats=combined_stats,
        addendum_shapes=addendum_shapes,
        addendum_families=addendum_families,
        middle_report=middle_report,
        shadows_note=shadows_note,
        generated_at=comparison["generatedAt"],
    )
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.write_text(markdown)

    print(f"[addendum] wrote {middle_report_path}")
    print(f"[addendum] wrote {addendum_packages_path}")
    print(f"[addendum] wrote {combined_packages_path}")
    print(f"[addendum] wrote {comparison_path}")
    print(f"[addendum] wrote {markdown_path}")


if __name__ == "__main__":
    main()
