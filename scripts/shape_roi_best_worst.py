#!/usr/bin/env python3
"""Shape-level observed-cost ROI at best and worst seen price per package.

Uses resolved rows from monotonic-chronological-packages CSV (payoutMultiple 1|2).
Shape metadata comes from gamma-market-cache-v2.json via packageId market ids,
with audit/snapshot row fallback for newer markets.

When --audit/--snapshot paths are provided, min/max packageCost per packageId are
taken from those streams; otherwise best=worst=cost from the CSV.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Any

PACKAGE_RE = re.compile(r"::YES-(\d+)\+NO-(\d+)$")


def parse_package_id(package_id: str) -> tuple[str, str] | None:
    match = PACKAGE_RE.search(package_id)
    if not match:
        return None
    return match.group(1), match.group(2)


def load_gamma_cache(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    return data if isinstance(data, dict) else {}


def supplement_gamma_cache_for_events(
    cache: dict[str, dict[str, Any]],
    event_slugs: set[str],
    *,
    gamma_api: str = "https://gamma-api.polymarket.com",
) -> int:
    """Fetch missing market metadata for live event slugs (one API call per event)."""
    added = 0
    for slug in sorted(s for s in event_slugs if s):
        url = f"{gamma_api}/events?slug={slug}"
        req = urllib.request.Request(url, headers={"User-Agent": "sports-arb-sibling-cf/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = json.loads(resp.read().decode())
        except Exception:
            continue
        events = payload if isinstance(payload, list) else []
        for event in events:
            for market in event.get("markets") or []:
                market_id = str(market.get("id") or "")
                if not market_id or market_id in cache:
                    continue
                cache[market_id] = {
                    "id": market_id,
                    "question": market.get("question"),
                    "sportsMarketType": market.get("sportsMarketType"),
                    "line": market.get("line"),
                    "slug": market.get("slug") or slug,
                }
                added += 1
    return added


def market_meta(cache: dict[str, dict[str, Any]], market_id: str) -> dict[str, Any] | None:
    row = cache.get(market_id)
    if not row:
        return None
    line = row.get("line")
    try:
        strike = float(line) if line is not None else None
    except (TypeError, ValueError):
        strike = None
    smt = str(row.get("sportsMarketType") or "")
    question = str(row.get("question") or "").lower()
    return {"strike": strike, "sportsMarketType": smt, "question": question}


def classify_shape(
    asset: str,
    broad: dict[str, Any] | None,
    narrow: dict[str, Any] | None,
) -> tuple[str, str, int] | None:
    if not broad or not narrow:
        return None
    b_strike = broad.get("strike")
    n_strike = narrow.get("strike")
    if b_strike is None or n_strike is None:
        return None
    text = f"{broad.get('question', '')} {narrow.get('question', '')}".lower()
    if "team-total" in text or "team total" in text:
        market_type = "team_total"
    elif "spread" in text or broad.get("sportsMarketType") == "spreads":
        market_type = "spread"
    elif asset == "SOCCER":
        market_type = "match_total" if ("total" in text or "o/u" in text or "over/under" in text) else "unknown"
    elif asset == "MLB":
        market_type = "game_total" if ("total" in text or "o/u" in text or "over/under" in text) else "unknown"
    elif asset == "UFC":
        # Fight rounds totals: "O/U 2.5 Rounds"
        market_type = "game_total" if ("o/u" in text and "rounds" in text) else "unknown"
    else:
        market_type = "unknown"
    low = min(float(b_strike), float(n_strike))
    high = max(float(b_strike), float(n_strike))
    width = int(round(high - low))
    family = f"{low:g}-{high:g}"
    return market_type, family, width


def stream_cost_bounds(paths: list[Path]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in paths:
        if not path.exists():
            continue
        opener = gzip.open if str(path).endswith(".gz") else open
        with opener(path, "rt", errors="replace") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                package_id = row.get("packageId")
                if not package_id:
                    continue
                try:
                    cost = float(row.get("packageCost", 99))
                except (TypeError, ValueError):
                    continue
                slot = out.setdefault(package_id, {"min": cost, "max": cost, "sample": row})
                if cost < slot["min"]:
                    slot["min"] = cost
                    slot["sample"] = row
                if cost > slot["max"]:
                    slot["max"] = cost
    return out


def observed_day(row: dict[str, str]) -> str:
    for key in ("firstObserved", "bestObserved"):
        value = row.get(key) or ""
        if len(value) >= 10:
            return value[:10]
    return ""


def in_window(row: dict[str, str], since: str | None, until: str | None) -> bool:
    day = observed_day(row)
    if not day:
        return False
    if since and day < since:
        return False
    if until and day > until:
        return False
    return True


def classify_shape_from_audit(asset: str, row: dict[str, Any]) -> tuple[str, str, int] | None:
    broad = row.get("broad") or {}
    narrow = row.get("narrow") or {}
    fake_broad = {
        "strike": broad.get("strike"),
        "sportsMarketType": "",
        "question": str(broad.get("question") or ""),
    }
    fake_narrow = {
        "strike": narrow.get("strike"),
        "sportsMarketType": "",
        "question": str(narrow.get("question") or ""),
    }
    try:
        fake_broad["strike"] = float(fake_broad["strike"])
        fake_narrow["strike"] = float(fake_narrow["strike"])
    except (TypeError, ValueError):
        return None
    return classify_shape(asset, fake_broad, fake_narrow)


def load_packages(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def shape_key(asset: str, market_type: str, family: str, width: int) -> str:
    return f"{asset}|{market_type}|{family}|w{width}"


def aggregate(
    packages: list[dict[str, str]],
    cache: dict[str, dict[str, Any]],
    bounds: dict[str, dict[str, Any]],
    *,
    assets: set[str],
    min_n: int,
) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "resolved": 0,
        "middles": 0,
        "best_cost_sum": 0.0,
        "worst_cost_sum": 0.0,
        "best_pnl_sum": 0.0,
        "worst_pnl_sum": 0.0,
        "asset": "",
        "marketType": "",
        "lineFamily": "",
        "middleWidth": 0,
    })

    skipped = {"asset": 0, "unresolved": 0, "shape": 0}

    for row in packages:
        asset = row.get("asset", "")
        if asset not in assets:
            skipped["asset"] += 1
            continue
        payout_raw = row.get("payoutMultiple", "")
        if payout_raw not in {"1", "2"}:
            skipped["unresolved"] += 1
            continue
        payout = int(payout_raw)
        package_id = row.get("packageId", "")
        parsed = parse_package_id(package_id)
        if not parsed:
            skipped["shape"] += 1
            continue
        broad_id, narrow_id = parsed
        shape = classify_shape(asset, market_meta(cache, broad_id), market_meta(cache, narrow_id))
        if not shape:
            audit_row = bounds.get(package_id, {}).get("sample")
            if audit_row:
                shape = classify_shape_from_audit(asset, audit_row)
        if not shape:
            skipped["shape"] += 1
            continue
        market_type, family, width = shape
        csv_cost = float(row.get("cost") or 0)
        slot = bounds.get(package_id)
        best_cost = slot["min"] if slot else csv_cost
        worst_cost = slot["max"] if slot else csv_cost

        key = shape_key(asset, market_type, family, width)
        group = groups[key]
        group["asset"] = asset
        group["marketType"] = market_type
        group["lineFamily"] = family
        group["middleWidth"] = width
        group["resolved"] += 1
        group["middles"] += 1 if payout == 2 else 0
        group["best_cost_sum"] += best_cost
        group["worst_cost_sum"] += worst_cost
        group["best_pnl_sum"] += payout - best_cost
        group["worst_pnl_sum"] += payout - worst_cost

    rows: list[dict[str, Any]] = []
    for group in groups.values():
        if group["resolved"] < min_n:
            continue
        rows.append({
            **group,
            "middleRate": group["middles"] / group["resolved"],
            "bestAvgCost": group["best_cost_sum"] / group["resolved"],
            "worstAvgCost": group["worst_cost_sum"] / group["resolved"],
            "bestRoiPct": 100 * group["best_pnl_sum"] / group["best_cost_sum"] if group["best_cost_sum"] else 0.0,
            "worstRoiPct": 100 * group["worst_pnl_sum"] / group["worst_cost_sum"] if group["worst_cost_sum"] else 0.0,
        })

    rows.sort(key=lambda item: (-item["bestRoiPct"], -item["resolved"]))
    return rows, skipped


def print_table(rows: list[dict[str, Any]], *, positive_only: bool) -> None:
    filtered = [r for r in rows if (r["bestRoiPct"] > 0 or r["worstRoiPct"] > 0)] if positive_only else rows
    print(f"{'Asset':<7} {'Type':<12} {'Family':<10} {'W':>2} {'N':>4} {'Hit%':>6} {'Best$':>6} {'Worst$':>6} {'ROI@Best':>9} {'ROI@Worst':>9}")
    print("-" * 88)
    for r in filtered:
        print(
            f"{r['asset']:<7} {r['marketType']:<12} {r['lineFamily']:<10} {r['middleWidth']:>2} "
            f"{r['resolved']:>4} {100*r['middleRate']:>5.1f}% {r['bestAvgCost']:>6.3f} {r['worstAvgCost']:>6.3f} "
            f"{r['bestRoiPct']:>+8.1f}% {r['worstRoiPct']:>+8.1f}%"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packages", default="analysis/monotonic-chronological-packages-long.csv")
    parser.add_argument("--gamma-cache", default="analysis/gamma-market-cache-v2.json")
    parser.add_argument("--audit", action="append", default=[])
    parser.add_argument("--snapshot", action="append", default=[])
    parser.add_argument(
        "--data-dir",
        help="Glob monotonic-candidate-snapshots.jsonl* and monotonic-middle-audit.jsonl* "
        "from this directory (picks up rotated files automatically)",
    )
    parser.add_argument("--min-n", type=int, default=8)
    parser.add_argument("--asset", action="append", default=["SOCCER", "MLB", "UFC"])
    parser.add_argument("--positive-only", action="store_true")
    parser.add_argument("--since", help="Inclusive YYYY-MM-DD on firstObserved/bestObserved")
    parser.add_argument("--until", help="Inclusive YYYY-MM-DD on firstObserved/bestObserved")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    packages = [
        row for row in load_packages(Path(args.packages))
        if in_window(row, args.since, args.until)
    ]
    cache = load_gamma_cache(Path(args.gamma_cache))
    stream_paths = [Path(p) for p in [*args.audit, *args.snapshot]]
    if args.data_dir:
        data_dir = Path(args.data_dir)
        stream_paths += sorted(data_dir.glob("monotonic-candidate-snapshots.jsonl*"))
        stream_paths += sorted(data_dir.glob("monotonic-middle-audit.jsonl*"))
    bounds = stream_cost_bounds(stream_paths)
    assets = set(args.asset)

    window = f"{args.since or '...'}..{args.until or '...'}"
    for asset in sorted(assets):
        rows, skipped = aggregate(packages, cache, bounds, assets={asset}, min_n=args.min_n)
        print(
            f"\n=== {asset} window={window} min_n={args.min_n} "
            f"packages={len(packages)} audit_bounds={len(bounds)} skipped={skipped} ==="
        )
        print_table(rows, positive_only=args.positive_only)

    rows, skipped = aggregate(packages, cache, bounds, assets=assets, min_n=args.min_n)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps({"rows": rows, "skipped": skipped}, indent=2))


if __name__ == "__main__":
    main()
