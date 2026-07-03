#!/usr/bin/env python3
"""Build a continuous Jun 16–Jul 3 package universe for backtest analysis.

Sources:
  - Frozen baseline CSV (Jun 16–22 middle/snapshot audit, best cost per package)
  - Candidate snapshots + middle audit streams (Jun 23–Jul 3, daily coverage)

Writes:
  - analysis/monotonic-chronological-packages-continuous.csv
  - analysis/monotonic-continuous-scan.meta.json
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import json
from pathlib import Path
from typing import Any

from build_monotonic_backtest_addendum import (
    baseline_rows_to_resolved,
    load_baseline_rows,
    package_csv_row,
    resolve_samples,
    write_packages_csv,
)
from monotonic_middle_report import parse_ts

WINDOW_START = "2026-06-16"
WINDOW_END = "2026-07-03"
SNAPSHOT_CUTOVER = "2026-06-23"


def observed_day(row: dict[str, str]) -> str:
    for key in ("firstObserved", "bestObserved"):
        value = row.get(key) or ""
        if len(value) >= 10:
            return value[:10]
    return ""


def baseline_in_window(rows: list[dict[str, str]], start: str, end: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for row in rows:
        day = observed_day(row)
        if day and start <= day <= end and day < SNAPSHOT_CUTOVER:
            out.append(row)
    return out


def iter_jsonl(paths: list[Path]):
    for path in paths:
        if not path.exists():
            continue
        opener = gzip.open if str(path).endswith(".gz") else open
        with opener(path, "rt", errors="replace") as handle:
            for line in handle:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def stream_post_baseline_samples(
    paths: list[Path],
    *,
    since: dt.datetime,
    until: dt.datetime,
    exclude_ids: set[str],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    bounds: dict[str, dict[str, float]] = {}
    observations = 0
    skipped_baseline = 0
    min_ts: dt.datetime | None = None
    max_ts: dt.datetime | None = None

    for row in iter_jsonl(paths):
        observed_at = parse_ts(row.get("observedAt"))
        if observed_at is None or observed_at < since or observed_at > until:
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
        try:
            sample_cost = float(row.get("packageCost", 99))
        except (TypeError, ValueError):
            continue
        slot = bounds.setdefault(package_id, {"min": sample_cost, "max": sample_cost})
        if sample_cost < slot["min"]:
            slot["min"] = sample_cost
        if sample_cost > slot["max"]:
            slot["max"] = sample_cost
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
        "costBounds": bounds,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build continuous Jun16-Jul3 package CSV.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--baseline-packages", default="analysis/monotonic-chronological-packages-long.csv")
    parser.add_argument("--data-dir", default="/var/lib/sports-arb/data")
    parser.add_argument("--skip-gamma", action="store_true")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    data_dir = Path(args.data_dir)
    baseline_path = repo_root / args.baseline_packages
    if not baseline_path.exists():
        raise SystemExit(f"Missing baseline CSV: {baseline_path}")

    baseline_rows = baseline_in_window(
        load_baseline_rows(baseline_path),
        WINDOW_START,
        WINDOW_END,
    )
    baseline_ids = {row["packageId"] for row in baseline_rows if row.get("packageId")}
    print(f"[continuous] baseline Jun16-22 rows: {len(baseline_rows):,}", flush=True)

    stream_paths = [
        data_dir / "monotonic-candidate-snapshots.jsonl",
        data_dir / "monotonic-candidate-snapshots.jsonl.dublin-postcutover-backup",
        data_dir / "monotonic-middle-audit.jsonl",
        data_dir / "monotonic-middle-audit.jsonl.1",
        data_dir / "monotonic-middle-audit.jsonl.2.gz",
    ]
    since = parse_ts(f"{SNAPSHOT_CUTOVER}T00:00:00Z")
    until = parse_ts(f"{WINDOW_END}T23:59:59Z")
    if since is None or until is None:
        raise SystemExit("Invalid continuous window timestamps")

    samples, meta = stream_post_baseline_samples(
        stream_paths,
        since=since,
        until=until,
        exclude_ids=baseline_ids,
    )
    print(
        f"[continuous] post-baseline observations={meta['observations']:,} "
        f"unique={len(samples):,} range={meta['range'][0]}..{meta['range'][1]}",
        flush=True,
    )

    if args.skip_gamma:
        resolved, unknown = [], list(samples.values())
    else:
        print(f"[continuous] resolving {len(samples):,} post-baseline packages via Gamma…", flush=True)
        resolved, unknown = resolve_samples(samples)
        print(f"[continuous] resolved={len(resolved):,} unknown/open={len(unknown):,}", flush=True)

    post_csv_rows = [
        package_csv_row(sample, "continuous_snapshot_audit")
        for sample in sorted(resolved + unknown, key=lambda row: str(row.get("packageId")))
    ]
    for row in post_csv_rows:
        match = next((s for s in resolved if s.get("packageId") == row["packageId"]), None)
        if match is not None:
            row["payoutMultiple"] = str(int(match["resolvedPayout"]))

    continuous_rows = baseline_rows + post_csv_rows
    out_path = repo_root / "analysis/monotonic-chronological-packages-continuous.csv"
    write_packages_csv(out_path, continuous_rows)

    # coverage by day
    from collections import Counter

    by_day = Counter()
    resolved_ct = 0
    for row in continuous_rows:
        day = observed_day(row)
        if day:
            by_day[day] += 1
        if row.get("payoutMultiple") in {"1", "2"}:
            resolved_ct += 1

    meta_out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "window": [WINDOW_START, WINDOW_END],
        "baselineRows": len(baseline_rows),
        "postBaselineUnique": len(samples),
        "totalRows": len(continuous_rows),
        "resolvedRows": resolved_ct,
        "packagesByDay": dict(sorted(by_day.items())),
        "postBaselineStream": meta,
        "sources": {
            "baseline": str(baseline_path),
            "streams": [str(p) for p in stream_paths if p.exists()],
        },
    }
    meta_path = repo_root / "analysis/monotonic-continuous-scan.meta.json"
    meta_path.write_text(json.dumps(meta_out, indent=2) + "\n")
    print(f"[continuous] wrote {out_path}", flush=True)
    print(f"[continuous] wrote {meta_path}", flush=True)
    print(f"[continuous] packages by day: {dict(sorted(by_day.items()))}", flush=True)


if __name__ == "__main__":
    main()
