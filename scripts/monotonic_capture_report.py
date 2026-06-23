#!/usr/bin/env python3
"""Summarize daemon candidate-capture conversion audit rows.

Input is data/monotonic-capture-audit.jsonl, emitted by
scripts/polymarket-arb-daemon.ts. Unlike monotonic-middle-audit.jsonl (which says
"a clean pair existed"), this answers whether the daemon converted that moment
into preflight, sizing, submit, paired fill, or a specific terminal miss reason.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median
from typing import Any


BUCKETS = [
    (float("-inf"), 1.000, "<1.000"),
    (1.000, 1.005, "1.000-1.005"),
    (1.005, 1.020, "1.005-1.02"),
    (1.020, 1.050, "1.02-1.05"),
    (1.050, 1.100, "1.05-1.10"),
    (1.100, 1.160, "1.10-1.16"),
    (1.160, 1.250, "1.16-1.25"),
    (1.250, float("inf"), ">1.25"),
]


def bucket_for(cost: float) -> str:
    for lo, hi, label in BUCKETS:
        if lo <= cost <= hi:
            return label
    return "unknown"


def pct(num: int | float, den: int | float) -> float:
    return 0.0 if den == 0 else float(num) / float(den)


def q50(values: list[float]) -> float | None:
    return None if not values else float(median(values))


def parse_ts(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def tail_lines(path: Path, limit: int) -> list[str]:
    if limit <= 0:
        raise SystemExit("--last-lines must be positive")
    chunk_size = 1024 * 1024
    chunks: list[bytes] = []
    newline_count = 0
    with path.open("rb") as handle:
        handle.seek(0, 2)
        position = handle.tell()
        while position > 0 and newline_count <= limit:
            read_size = min(chunk_size, position)
            position -= read_size
            handle.seek(position)
            chunk = handle.read(read_size)
            chunks.append(chunk)
            newline_count += chunk.count(b"\n")
    data = b"".join(reversed(chunks))
    return data.decode(errors="replace").splitlines()[-limit:]


def load_rows(path: Path, last_lines: int | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    lines = tail_lines(path, last_lines) if last_lines else path.open(errors="replace")
    try:
        for line in lines:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    finally:
        if not isinstance(lines, list):
            lines.close()
    return rows


def filter_since(rows: list[dict[str, Any]], since: str | None) -> list[dict[str, Any]]:
    if not since:
        return rows
    since_ts = parse_ts(since)
    if since_ts is None:
        raise SystemExit(f"invalid --since timestamp: {since}")
    filtered: list[dict[str, Any]] = []
    for row in rows:
        row_ts = parse_ts(row.get("terminalAt") or row.get("observedAt"))
        if row_ts is not None and row_ts >= since_ts:
            filtered.append(row)
    return filtered


def grouped_window_summary(rows: list[dict[str, Any]], window_sec: int) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        ws = row.get("ws") or {}
        package_id = str(ws.get("packageId") or row.get("captureId") or "?")
        try:
            cost = float(ws.get("cost", 99))
        except (TypeError, ValueError):
            continue
        row_ts = parse_ts(row.get("observedAt") or row.get("terminalAt"))
        if row_ts is None:
            continue
        window_start = int(row_ts // window_sec) * window_sec
        groups[(bucket_for(cost), package_id, window_start)].append(row)

    by_bucket: dict[str, list[list[dict[str, Any]]]] = defaultdict(list)
    for (bucket, _package_id, _window_start), grouped_rows in groups.items():
        by_bucket[bucket].append(grouped_rows)

    result: list[dict[str, Any]] = []
    for _, _, label in BUCKETS:
        grouped = by_bucket.get(label, [])
        if not grouped:
            continue
        would_submit = [g for g in grouped if any(r.get("terminalStatus") == "shadow_would_submit" for r in g)]
        sizing_rejected = [g for g in grouped if any(r.get("terminalStatus") == "shadow_sizing_rejected" for r in g)]
        gate_blocked = [g for g in grouped if any(r.get("terminalStatus") == "shadow_gate_blocked" for r in g)]
        submitted = [g for g in grouped if any(r.get("terminalStatus") == "submitted_result" for r in g)]
        package_ids = {str(((g[0].get("ws") or {}).get("packageId")) or "?") for g in grouped}
        would_submit_assets = Counter(
            str((r.get("ws") or {}).get("asset") or "?")
            for g in would_submit
            for r in g
            if r.get("terminalStatus") == "shadow_would_submit"
        )
        non_submit_reasons = Counter(
            str(r.get("reason"))
            for g in grouped
            if not any(row.get("terminalStatus") == "shadow_would_submit" for row in g)
            for r in g
            if str(r.get("terminalStatus")).startswith("shadow_")
        )
        result.append({
            "bucket": label,
            "windowSec": window_sec,
            "dedupedWindows": len(grouped),
            "uniquePackages": len(package_ids),
            "shadowWouldSubmitWindows": len(would_submit),
            "shadowWouldSubmitRate": pct(len(would_submit), len(grouped)),
            "submittedWindows": len(submitted),
            "shadowSizingRejectedWindows": len(sizing_rejected),
            "shadowGateBlockedWindows": len(gate_blocked),
            "wouldSubmitAssets": dict(would_submit_assets.most_common()),
            "topNonSubmitReasons": dict(non_submit_reasons.most_common(8)),
        })
    return result


def summarize(rows: list[dict[str, Any]], window_sec: int, since: str | None) -> dict[str, Any]:
    rows = filter_since(rows, since)
    by_bucket: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_asset: Counter[str] = Counter()
    for row in rows:
        ws = row.get("ws") or {}
        cost = float(ws.get("cost", 99))
        by_bucket[bucket_for(cost)].append(row)
        by_asset[str(ws.get("asset") or "?")] += 1

    bucket_rows: list[dict[str, Any]] = []
    for _, _, label in BUCKETS:
        subset = by_bucket.get(label, [])
        if not subset:
            continue
        submitted = [r for r in subset if r.get("terminalStatus") == "submitted_result"]
        paired = [r for r in submitted if ((r.get("execution") or {}).get("matched") or 0) > 0]
        orphaned = [r for r in submitted if ((r.get("execution") or {}).get("nakedShares") or 0) > 0]
        no_fill = [r for r in submitted if ((r.get("execution") or {}).get("matched") or 0) <= 0]
        actual_pair_costs = [
            float((r.get("execution") or {}).get("actualPairCost"))
            for r in paired
            if (r.get("execution") or {}).get("actualPairCost") is not None
        ]
        slippages = [
            float((r.get("execution") or {}).get("actualPairCost")) - float((r.get("ws") or {}).get("cost", 0))
            for r in paired
            if (r.get("execution") or {}).get("actualPairCost") is not None
        ]
        elapsed = [float(r.get("elapsedMs")) for r in subset if isinstance(r.get("elapsedMs"), (int, float))]
        terminal_counts = Counter(str(r.get("terminalStatus")) for r in subset)
        miss_reasons = Counter(
            str(r.get("reason"))
            for r in subset
            if r.get("terminalStatus") != "submitted_result"
        )
        bucket_rows.append({
            "bucket": label,
            "captures": len(subset),
            "submitted": len(submitted),
            "pairedFilled": len(paired),
            "submittedNoFill": len(no_fill),
            "orphaned": len(orphaned),
            "submitRate": pct(len(submitted), len(subset)),
            "pairedFillRate": pct(len(paired), len(subset)),
            "orphanRateOfSubmitted": pct(len(orphaned), len(submitted)),
            "medianActualPairCost": q50(actual_pair_costs),
            "medianSlippageVsWsCost": q50(slippages),
            "medianElapsedMs": q50(elapsed),
            "terminalStatus": dict(terminal_counts.most_common()),
            "topMissReasons": dict(miss_reasons.most_common(8)),
        })

    submitted_all = [r for r in rows if r.get("terminalStatus") == "submitted_result"]
    paired_all = [r for r in submitted_all if ((r.get("execution") or {}).get("matched") or 0) > 0]
    return {
        "rows": len(rows),
        "since": since,
        "dedupedWindowSec": window_sec,
        "dedupedBuckets": grouped_window_summary(rows, window_sec),
        "buckets": bucket_rows,
        "terminalStatus": dict(Counter(str(r.get("terminalStatus")) for r in rows).most_common()),
        "assets": dict(by_asset.most_common()),
        "submitted": len(submitted_all),
        "pairedFilled": len(paired_all),
        "submitRate": pct(len(submitted_all), len(rows)),
        "pairedFillRate": pct(len(paired_all), len(rows)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize monotonic capture audit conversion.")
    parser.add_argument("--audit", default="data/monotonic-capture-audit.jsonl")
    parser.add_argument("--window-sec", type=int, default=5, help="Dedup package/window rows over this many seconds.")
    parser.add_argument("--since", help="Only include rows at or after this ISO timestamp.")
    parser.add_argument("--last-lines", type=int, help="Only parse the last N JSONL rows for faster live reports.")
    parser.add_argument("--out")
    args = parser.parse_args()

    if args.window_sec <= 0:
        raise SystemExit("--window-sec must be positive")
    report = summarize(load_rows(Path(args.audit), args.last_lines), args.window_sec, args.since)
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
