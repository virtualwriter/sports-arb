#!/usr/bin/env python3
"""Side-by-side: backtest shape packages vs live fills for one line family."""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
from pathlib import Path
from typing import Any

from shape_roi_best_worst import (
    classify_shape,
    classify_shape_from_audit,
    in_window,
    load_gamma_cache,
    load_packages,
    market_meta,
    parse_package_id,
    stream_cost_bounds,
)

PACKAGE_RE = re.compile(r"::YES-(\d+)\+NO-(\d+)$")


def event_slug(package_id: str) -> str:
    return package_id.split("::", 1)[0] if "::" in package_id else package_id


def load_live(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else []


def live_fill_cost(pkg: dict[str, Any]) -> float | None:
    pricing = pkg.get("pricing") or {}
    exec_q = pricing.get("executionQuote") or {}
    for key in ("actualPairCost", "freshCost", "wsCost", "packageCost"):
        val = exec_q.get(key) if key != "packageCost" else pricing.get(key)
        if val is not None:
            try:
                return float(val)
            except (TypeError, ValueError):
                continue
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packages", default="analysis/monotonic-chronological-packages-continuous.csv")
    parser.add_argument("--gamma-cache", default="analysis/gamma-market-cache-v2.json")
    parser.add_argument("--audit", action="append", default=[])
    parser.add_argument("--snapshot", action="append", default=[])
    parser.add_argument("--live", default="/var/lib/sports-arb/data/polymarket-live-packages.json")
    parser.add_argument("--asset", default="SOCCER")
    parser.add_argument("--market-type", default="match_total")
    parser.add_argument("--line-family", default="3.5-5.5")
    parser.add_argument("--since", default="2026-06-16")
    parser.add_argument("--until", default="2026-07-03")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    cache = load_gamma_cache(Path(args.gamma_cache))
    bounds = stream_cost_bounds([Path(p) for p in args.audit + args.snapshot])
    packages = load_packages(Path(args.packages))

    backtest_rows: list[dict[str, Any]] = []
    for row in packages:
        if row.get("asset") != args.asset:
            continue
        if not in_window(row, args.since, args.until):
            continue
        payout_raw = row.get("payoutMultiple", "")
        if payout_raw not in {"1", "2"}:
            continue
        package_id = row.get("packageId", "")
        parsed = parse_package_id(package_id)
        if not parsed:
            continue
        broad_id, narrow_id = parsed
        shape = classify_shape(args.asset, market_meta(cache, broad_id), market_meta(cache, narrow_id))
        if not shape:
            slot = bounds.get(package_id, {}).get("sample")
            if slot:
                shape = classify_shape_from_audit(args.asset, slot)
        if not shape:
            continue
        market_type, family, width = shape
        if market_type != args.market_type or family != args.line_family:
            continue

        csv_cost = float(row.get("cost") or 0)
        slot = bounds.get(package_id)
        best_cost = slot["min"] if slot else csv_cost
        worst_cost = slot["max"] if slot else csv_cost
        payout = int(payout_raw)
        backtest_rows.append({
            "packageId": package_id,
            "event": event_slug(package_id),
            "day": (row.get("firstObserved") or row.get("bestObserved") or "")[:10],
            "csvCost": csv_cost,
            "bestObserved": best_cost,
            "worstObserved": worst_cost,
            "hasStreamBounds": slot is not None,
            "outcome": "middle" if payout == 2 else "floor",
            "payout": payout,
        })

    backtest_rows.sort(key=lambda r: (r["day"], r["event"], r["packageId"]))
    backtest_ids = {r["packageId"] for r in backtest_rows}

    live_rows: list[dict[str, Any]] = []
    for pkg in load_live(Path(args.live)):
        strat = pkg.get("strategy") or {}
        if strat.get("lineFamily") != args.line_family:
            continue
        if strat.get("marketType") != args.market_type:
            continue
        sport = (pkg.get("sport") or {}).get("sportId", "")
        if sport != args.asset:
            continue
        res = pkg.get("resolution") or {}
        if res.get("status") != "resolved":
            continue
        package_id = pkg.get("packageId", "")
        fill = live_fill_cost(pkg)
        quote = (pkg.get("pricing") or {}).get("executionQuote") or {}
        live_rows.append({
            "packageId": package_id,
            "event": event_slug(package_id),
            "submittedAt": (pkg.get("timestamps") or {}).get("submitted") or pkg.get("createdAt"),
            "gateCost": float((pkg.get("pricing") or {}).get("packageCost") or 0),
            "fillCost": fill,
            "wsCost": quote.get("wsCost"),
            "freshCost": quote.get("freshCost"),
            "actualPairCost": quote.get("actualPairCost"),
            "slippageCents": quote.get("fillSlippageCents"),
            "comparisonGroup": strat.get("comparisonGroup"),
            "outcome": "middle" if res.get("payoutPerShare") == 2 else "floor",
            "pnlUsd": res.get("pnlUsd"),
            "roiPct": res.get("roiPct"),
            "inBacktestUniverse": package_id in backtest_ids,
        })

    live_rows.sort(key=lambda r: str(r.get("submittedAt") or ""))

    matched = [r for r in live_rows if r["inBacktestUniverse"]]
    unmatched_live = [r for r in live_rows if not r["inBacktestUniverse"]]
    live_ids = {r["packageId"] for r in live_rows}
    backtest_only = [r for r in backtest_rows if r["packageId"] not in live_ids]

    print(f"\n=== {args.asset} {args.market_type} {args.line_family} {args.since}..{args.until} ===")
    print(f"Backtest universe: {len(backtest_rows)} packages")
    print(f"Live resolved fills: {len(live_rows)}")
    print(f"Matched (same packageId): {len(matched)}")
    print(f"Live-only (not in backtest 43): {len(unmatched_live)}")
    print(f"Backtest-only (you did not trade): {len(backtest_only)}")

    if backtest_rows:
        hits = sum(1 for r in backtest_rows if r["outcome"] == "middle")
        print(
            f"Backtest hit={hits/len(backtest_rows)*100:.1f}% "
            f"csvAvg={sum(r['csvCost'] for r in backtest_rows)/len(backtest_rows):.3f} "
            f"bestAvg={sum(r['bestObserved'] for r in backtest_rows)/len(backtest_rows):.3f} "
            f"worstAvg={sum(r['worstObserved'] for r in backtest_rows)/len(backtest_rows):.3f}"
        )
    if live_rows:
        fills = [r["fillCost"] or r["gateCost"] for r in live_rows]
        hits = sum(1 for r in live_rows if r["outcome"] == "middle")
        print(
            f"Live hit={hits/len(live_rows)*100:.1f}% "
            f"fillAvg={sum(fills)/len(fills):.3f} "
            f"gateAvg={sum(r['gateCost'] for r in live_rows)/len(live_rows):.3f}"
        )

    print("\n--- LIVE FILLS ---")
    print(f"{'event':<42} {'fill':>6} {'gate':>6} {'worstObs':>8} {'in43':>5} {'out':>6} {'pnl':>7}")
    for live in live_rows:
        bt = next((b for b in backtest_rows if b["packageId"] == live["packageId"]), None)
        worst = f"{bt['worstObserved']:.3f}" if bt else "n/a"
        fill = live["fillCost"] or live["gateCost"]
        flag = "yes" if live["inBacktestUniverse"] else "NO"
        pnl = live.get("pnlUsd")
        pnl_s = f"{pnl:+.2f}" if pnl is not None else "n/a"
        ev = live["event"][:42]
        print(f"{ev:<42} {fill:6.3f} {live['gateCost']:6.3f} {worst:>8} {flag:>5} {live['outcome']:>6} {pnl_s:>7}")

    print("\n--- BACKTEST UNIVERSE (all 43) ---")
    print(f"{'day':<12} {'event':<38} {'csv':>6} {'best':>6} {'worst':>6} {'live':>5} {'out':>6}")
    for bt in backtest_rows:
        traded = "YES" if bt["packageId"] in live_ids else ""
        ev = bt["event"][:38]
        print(
            f"{bt['day']:<12} {ev:<38} {bt['csvCost']:6.3f} {bt['bestObserved']:6.3f} "
            f"{bt['worstObserved']:6.3f} {traded:>5} {bt['outcome']:>6}"
        )

    over_worst = []
    for live in live_rows:
        bt = next((b for b in backtest_rows if b["packageId"] == live["packageId"]), None)
        if not bt:
            continue
        fill = live["fillCost"] or live["gateCost"]
        if fill > bt["worstObserved"] + 0.0005:
            over_worst.append((live, bt, fill - bt["worstObserved"]))

    print(f"\n--- Live fills ABOVE that package's backtest worst-observed: {len(over_worst)} ---")
    for live, bt, delta in over_worst:
        fill = live["fillCost"] or live["gateCost"]
        print(
            f"  {live['event']}: fill={fill:.3f} worstObs={bt['worstObserved']:.3f} "
            f"+{delta*100:.1f}¢  outcome={live['outcome']}"
        )

    if args.json_out:
        out = {
            "backtest": backtest_rows,
            "live": live_rows,
            "matched": matched,
            "backtestOnly": backtest_only,
            "liveOnly": unmatched_live,
            "liveAboveWorstObserved": [
                {
                    "packageId": live["packageId"],
                    "fillCost": live["fillCost"] or live["gateCost"],
                    "worstObserved": bt["worstObserved"],
                    "deltaCents": round((live["fillCost"] or live["gateCost"] - bt["worstObserved"]) * 100, 2),
                }
                for live, bt, _ in over_worst
            ],
        }
        Path(args.json_out).write_text(json.dumps(out, indent=2))
        print(f"\nWrote {args.json_out}")


if __name__ == "__main__":
    main()
