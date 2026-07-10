#!/usr/bin/env python3
"""Score Strat 1 (feed vs ladder re-coherence) from state-feed-shadow.jsonl.

Pass bars (per sport):
  - n >= 20 scoring events (interim reported earlier)
  - median residual window >= 5s
  - median residual discount >= 3¢
  - tradeable fraction >= 30%
  - ROI on tradeable clips > 0 → GO
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from monotonic_middle_report import parse_ts, resolve_samples

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SHADOW = Path(
    __import__("os").environ.get(
        "STATE_FEED_SHADOW_PATH",
        __import__("os").environ.get("SPORTS_ARB_DATA_DIR", str(ROOT / "data"))
        + "/state-feed-shadow.jsonl",
    )
)
JUMP_CENTS = 0.05
COHERE_CENTS = 0.02
POST_WINDOW_S = 60.0
MIN_AVAIL = 20.0
DUST_YES = 0.02
DUST_NO = 0.98


def median(xs: list[float]) -> float | None:
    return statistics.median(xs) if xs else None


def is_dust_pkg(pkg: dict[str, Any]) -> bool:
    bya = float(pkg.get("broadYesAsk") or 0)
    nna = float(pkg.get("narrowNoAsk") or 0)
    return bya <= DUST_YES or nna >= DUST_NO or bya <= 0 or nna <= 0


def tradeable(pkg: dict[str, Any]) -> bool:
    return (
        not is_dust_pkg(pkg)
        and float(pkg.get("availableSize") or 0) >= MIN_AVAIL
        and float(pkg.get("packageCost") or 99) < 1.50
    )


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open(errors="replace") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("schemaVersion") != 1:
                continue
            rows.append(row)
    rows.sort(key=lambda r: r.get("observedAt") or "")
    return rows


def ladder_map(row: dict[str, Any]) -> dict[float, float]:
    out: dict[float, float] = {}
    for leg in row.get("ladder") or []:
        try:
            strike = float(leg["strike"])
            ask = float(leg.get("yesAsk") or 0)
        except (TypeError, ValueError, KeyError):
            continue
        if ask > 0:
            out[strike] = ask
    return out


def best_tradeable_pkg(row: dict[str, Any]) -> dict[str, Any] | None:
    pkgs = [p for p in (row.get("packages") or []) if tradeable(p)]
    if not pkgs:
        return None
    return min(pkgs, key=lambda p: float(p.get("packageCost") or 99))


def detect_first_jump(
    snapshots: list[dict[str, Any]],
    t_feed: dt.datetime,
) -> tuple[dt.datetime | None, dict[str, Any] | None]:
    """First snapshot after t_feed where any strike yesAsk jumps >= JUMP_CENTS vs pre-feed."""
    pre = [s for s in snapshots if parse_ts(s.get("observedAt")) and parse_ts(s["observedAt"]) < t_feed]
    post = [s for s in snapshots if parse_ts(s.get("observedAt")) and parse_ts(s["observedAt"]) >= t_feed]
    if not pre or not post:
        return None, None
    base = ladder_map(pre[-1])
    if not base:
        return None, None
    for snap in post:
        asks = ladder_map(snap)
        for strike, ask in asks.items():
            prev = base.get(strike)
            if prev is None:
                continue
            if ask - prev >= JUMP_CENTS:
                return parse_ts(snap["observedAt"]), snap
        # also update base slowly? no — compare to pre-feed only for first move
    return None, None


def detect_cohere(
    snapshots: list[dict[str, Any]],
    t_feed: dt.datetime,
    lag_cost: float,
) -> tuple[dt.datetime | None, float | None]:
    """When package cost is no longer >= COHERE_CENTS below the post-window level."""
    post = [
        s
        for s in snapshots
        if (ts := parse_ts(s.get("observedAt")))
        and ts >= t_feed
        and (ts - t_feed).total_seconds() <= POST_WINDOW_S + 30
    ]
    costs: list[tuple[dt.datetime, float]] = []
    for snap in post:
        pkg = best_tradeable_pkg(snap)
        if not pkg:
            continue
        ts = parse_ts(snap["observedAt"])
        if ts:
            costs.append((ts, float(pkg["packageCost"])))
    if len(costs) < 2:
        return None, None
    # Post-cohere reference: median cost in last third of window
    late = [c for ts, c in costs if (ts - t_feed).total_seconds() >= POST_WINDOW_S * 0.5]
    if not late:
        late = [c for _, c in costs[-3:]]
    post_level = statistics.median(late)
    for ts, cost in costs:
        # cohered once cost is within COHERE of post_level AND no longer cheap vs post
        if cost >= post_level - COHERE_CENTS:
            return ts, post_level
    return costs[-1][0], post_level


def analyze_event(
    asset: str,
    slug: str,
    t_feed: dt.datetime,
    change_row: dict[str, Any],
    snapshots: list[dict[str, Any]],
) -> dict[str, Any] | None:
    event_snaps = [
        s
        for s in snapshots
        if s.get("eventSlug") == slug
        and s.get("kind") == "snapshot"
        and parse_ts(s.get("observedAt"))
    ]
    # Include change_row packages as t_feed book if present
    feed_pkg = best_tradeable_pkg(change_row)
    t_first, first_snap = detect_first_jump(event_snaps, t_feed)
    lag_cost = float(feed_pkg["packageCost"]) if feed_pkg else None
    if lag_cost is None and first_snap:
        fp = best_tradeable_pkg(first_snap)
        lag_cost = float(fp["packageCost"]) if fp else None
    if lag_cost is None:
        return {
            "asset": asset,
            "eventSlug": slug,
            "tFeed": t_feed.isoformat().replace("+00:00", "Z"),
            "tradeable": False,
            "reason": "no_tradeable_pkg_at_feed",
        }
    t_cohere, post_level = detect_cohere(event_snaps, t_feed, lag_cost)
    residual_s = (t_cohere - t_feed).total_seconds() if t_cohere else None
    discount = (post_level - lag_cost) if post_level is not None else None
    pkg = feed_pkg or (best_tradeable_pkg(first_snap) if first_snap else None)
    return {
        "asset": asset,
        "eventSlug": slug,
        "tFeed": t_feed.isoformat().replace("+00:00", "Z"),
        "tFirst": t_first.isoformat().replace("+00:00", "Z") if t_first else None,
        "tCohere": t_cohere.isoformat().replace("+00:00", "Z") if t_cohere else None,
        "residualWindowS": residual_s,
        "lagCost": lag_cost,
        "postLevel": post_level,
        "discount": discount,
        "tradeable": bool(pkg and tradeable(pkg)),
        "availableSize": float(pkg.get("availableSize") or 0) if pkg else 0,
        "package": {
            "packageId": pkg.get("packageId") if pkg else None,
            "lo": pkg.get("lo") if pkg else None,
            "hi": pkg.get("hi") if pkg else None,
            "packageCost": lag_cost,
            "availableSize": float(pkg.get("availableSize") or 0) if pkg else 0,
            "broad": {
                "marketId": pkg.get("broadMarketId") if pkg else None,
                "yesTokenId": pkg.get("broadYesTokenId") if pkg else None,
                "strike": pkg.get("lo") if pkg else None,
            },
            "narrow": {
                "marketId": pkg.get("narrowMarketId") if pkg else None,
                "noTokenId": pkg.get("narrowNoTokenId") if pkg else None,
                "strike": pkg.get("hi") if pkg else None,
            },
            "eventSlug": slug,
        }
        if pkg
        else None,
    }


def resolve_tradeable(events: list[dict[str, Any]]) -> dict[str, Any]:
    samples: dict[str, dict[str, Any]] = {}
    for ev in events:
        pkg = ev.get("package")
        if not ev.get("tradeable") or not pkg or not pkg.get("packageId"):
            continue
        # Shape expected by resolve_samples
        samples[pkg["packageId"]] = {
            "eventSlug": pkg["eventSlug"],
            "packageCost": pkg["packageCost"],
            "broad": pkg["broad"],
            "narrow": pkg["narrow"],
        }
    if not samples:
        return {"n": 0, "middles": 0, "roi": None, "resolved": 0, "unknown": 0}
    resolved, unknown = resolve_samples(samples)
    if not resolved:
        return {"n": len(samples), "middles": 0, "roi": None, "resolved": 0, "unknown": len(unknown)}
    pnl = 0.0
    stake = 0.0
    middles = 0
    for row in resolved:
        cost = float(row["packageCost"])
        payout = float(row["resolvedPayout"])
        pnl += payout - cost
        stake += cost
        if payout == 2:
            middles += 1
    roi = pnl / stake if stake > 0 else None
    return {
        "n": len(samples),
        "middles": middles,
        "middlePct": middles / len(resolved) if resolved else None,
        "roi": roi,
        "resolved": len(resolved),
        "unknown": len(unknown),
        "pnl": pnl,
        "stake": stake,
    }


def pass_bars(events: list[dict[str, Any]], resolved: dict[str, Any]) -> dict[str, Any]:
    tradeable_ev = [e for e in events if e.get("tradeable")]
    windows = [float(e["residualWindowS"]) for e in tradeable_ev if e.get("residualWindowS") is not None]
    discounts = [float(e["discount"]) for e in tradeable_ev if e.get("discount") is not None]
    n = len(events)
    tradeable_frac = len(tradeable_ev) / n if n else 0.0
    med_w = median(windows)
    med_d = median(discounts)
    roi = resolved.get("roi")
    checks = {
        "nGe20": n >= 20,
        "medianWindowGe5s": med_w is not None and med_w >= 5.0,
        "medianDiscountGe3c": med_d is not None and med_d >= 0.03,
        "tradeableFracGe30": tradeable_frac >= 0.30,
        "roiPositive": roi is not None and roi > 0,
    }
    # GO only when sample enough AND economics clear
    go = all(
        [
            checks["nGe20"],
            checks["medianWindowGe5s"],
            checks["medianDiscountGe3c"],
            checks["tradeableFracGe30"],
            checks["roiPositive"],
        ]
    )
    interim = n > 0 and not checks["nGe20"]
    return {
        "GO": go,
        "interim": interim,
        "checks": checks,
        "n": n,
        "tradeableN": len(tradeable_ev),
        "tradeableFrac": tradeable_frac,
        "medianResidualWindowS": med_w,
        "medianDiscount": med_d,
        "roi": roi,
    }


def write_md(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# Strat 1 lag score",
        "",
        f"Generated: {report['generatedAt']}",
        f"Shadow: `{report['shadowPath']}`",
        f"Scoring events: **{report['scoringEvents']}**",
        "",
    ]
    for sport, block in report.get("byAsset", {}).items():
        decision = "GO" if block["pass"]["GO"] else ("INTERIM" if block["pass"]["interim"] else "NO-GO")
        lines += [
            f"## {sport}: **{decision}**",
            "",
            f"- n={block['pass']['n']} tradeable={block['pass']['tradeableN']} "
            f"({(block['pass']['tradeableFrac'] or 0)*100:.0f}%)",
            f"- median residual window: {block['pass']['medianResidualWindowS']}",
            f"- median discount: {block['pass']['medianDiscount']}",
            f"- ROI: {block['pass']['roi']}",
            f"- checks: `{json.dumps(block['pass']['checks'])}`",
            "",
        ]
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shadow", type=Path, default=DEFAULT_SHADOW)
    ap.add_argument("--out", type=Path, default=ROOT / "analysis" / "strat1-lag-score.json")
    ap.add_argument("--md", type=Path, default=ROOT / "analysis" / "strat1-lag-score.md")
    args = ap.parse_args()

    rows = load_rows(args.shadow)
    snapshots = [r for r in rows if r.get("kind") == "snapshot"]
    changes = [
        r
        for r in rows
        if r.get("kind") == "score_change" and r.get("scoring")
    ]

    events: list[dict[str, Any]] = []
    for ch in changes:
        ts = parse_ts(ch.get("observedAt"))
        if not ts:
            continue
        asset = str(ch.get("asset") or "UNKNOWN")
        slug = str(ch.get("eventSlug") or "")
        ev = analyze_event(asset, slug, ts, ch, snapshots)
        if ev:
            events.append(ev)

    by_asset: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ev in events:
        by_asset[str(ev["asset"])].append(ev)

    report: dict[str, Any] = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "shadowPath": str(args.shadow),
        "scoringEvents": len(events),
        "byAsset": {},
        "events": events,
    }
    for asset, evs in sorted(by_asset.items()):
        resolved = resolve_tradeable(evs)
        report["byAsset"][asset] = {
            "pass": pass_bars(evs, resolved),
            "resolved": resolved,
        }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    write_md(args.md, report)
    print(json.dumps({k: report[k] for k in ("generatedAt", "scoringEvents", "byAsset")}, indent=2))
    print(f"wrote {args.out}")
    print(f"wrote {args.md}")


if __name__ == "__main__":
    main()
