#!/usr/bin/env python3
"""Resolve tennis shadow entries against Polymarket settlement to produce
hit-rate / ROI per cost bucket and line family.

Reads `monotonic-middle-audit.jsonl` (which has full broad/narrow structural
fields), filters to TENNIS / WOMENS_TENNIS, keeps the best (lowest packageCost)
sample per packageId, fetches each unique event from Gamma, then matches
broad.yesTokenId + narrow.noTokenId to the resolved outcome prices to compute
payout (0 / 1 / 2). Same resolution logic as monotonic_middle_report.py.

Designed to stream the audit so we never load the whole 4GB+ file in memory.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

GAMMA_API = "https://gamma-api.polymarket.com"
USER_AGENT = "tennis-shadow-resolution/1.0"

COST_BUCKETS = [
    (float("-inf"), 1.0000001, "<=1.000"),
    (1.0000001, 1.05, "1.000-1.05"),
    (1.05, 1.10, "1.05-1.10"),
    (1.10, 1.16, "1.10-1.16"),
    (1.16, 1.22, "1.16-1.22"),
    (1.22, 1.35, "1.22-1.35"),
    (1.35, float("inf"), ">1.35"),
]

TENNIS_ASSETS = {"TENNIS", "WOMENS_TENNIS"}


def parse_ts(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.astimezone(dt.timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def parse_json_array(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def fetch_event(slug: str) -> dict[str, Any] | None:
    url = f"{GAMMA_API}/events?{urllib.parse.urlencode({'slug': slug})}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as res:
        data = json.load(res)
    return data[0] if isinstance(data, list) and data else None


def winner_index(market: dict[str, Any] | None) -> int | None:
    if not market or not (market.get("closed") or market.get("resolvedBy")):
        return None
    prices: list[float | None] = []
    for raw in parse_json_array(market.get("outcomePrices")):
        try:
            prices.append(float(raw))
        except (TypeError, ValueError):
            prices.append(None)
    finite = [p for p in prices if p is not None]
    if not finite or max(finite) < 0.99:
        return None
    return max(range(len(prices)), key=lambda i: prices[i] if prices[i] is not None else -1)


def token_index(market: dict[str, Any] | None, token_id: str | None) -> int | None:
    if not market or token_id is None:
        return None
    tokens = [str(t) for t in parse_json_array(market.get("clobTokenIds"))]
    try:
        return tokens.index(str(token_id))
    except ValueError:
        return None


def token_won(market: dict[str, Any] | None, token_id: str | None) -> bool | None:
    w = winner_index(market)
    t = token_index(market, token_id)
    return None if w is None or t is None else w == t


def bucket_for(cost: float) -> str:
    for lo, hi, label in COST_BUCKETS:
        if lo < cost <= hi:
            return label
    return COST_BUCKETS[-1][2]


_STRIKE_RE = re.compile(r"([0-9]+(?:\.[0-9]+)?)")


def line_family(sample: dict[str, Any]) -> str:
    try:
        b = float(sample["broad"]["strike"])
        n = float(sample["narrow"]["strike"])
    except (KeyError, TypeError, ValueError):
        return "?"
    return f"{b:g}-{n:g}"


def middle_width(sample: dict[str, Any]) -> int | None:
    try:
        b = float(sample["broad"]["strike"])
        n = float(sample["narrow"]["strike"])
    except (KeyError, TypeError, ValueError):
        return None
    return int(round(n - b))


def market_type(sample: dict[str, Any]) -> str:
    ladder = (sample.get("broad") or {}).get("marketId", "")
    q_broad = (sample.get("broad") or {}).get("question", "").lower()
    if "spread" in q_broad:
        return "spread"
    if "o/u" in q_broad or "over/under" in q_broad or "total" in q_broad:
        return "total"
    return "?"


def stream_tennis_samples(audit_path: Path, since: dt.datetime | None) -> dict[str, dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    seen = 0
    kept = 0
    with audit_path.open("r", errors="replace") as handle:
        for line in handle:
            seen += 1
            if seen % 500_000 == 0:
                print(f"  scanned {seen:,} rows; tennis kept {kept:,}; unique packages {len(best):,}", flush=True)
            # Cheap pre-filter to skip non-tennis quickly
            if '"TENNIS"' not in line and '"WOMENS_TENNIS"' not in line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("asset") not in TENNIS_ASSETS:
                continue
            observed_at = parse_ts(row.get("observedAt"))
            if since is not None and (observed_at is None or observed_at < since):
                continue
            kept += 1
            pid = row.get("packageId")
            if not pid:
                continue
            try:
                cost = float(row.get("packageCost", 99))
            except (TypeError, ValueError):
                continue
            prev = best.get(pid)
            if prev is None or cost < float(prev.get("packageCost", 99)):
                best[pid] = row
    print(f"final scan: rows={seen:,} tennis_rows={kept:,} unique_packages={len(best):,}", flush=True)
    return best


def resolve_samples(samples: dict[str, dict[str, Any]], sleep_every: int = 25, sleep_ms: int = 200) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    slugs = sorted({str(s.get("eventSlug")) for s in samples.values() if s.get("eventSlug")})
    print(f"fetching {len(slugs)} unique events from Gamma…", flush=True)
    events: dict[str, dict[str, Any] | None] = {}
    for idx, slug in enumerate(slugs):
        try:
            events[slug] = fetch_event(slug)
        except Exception as err:
            events[slug] = None
            if idx < 5:
                print(f"  fetch error {slug}: {err}", flush=True)
        if idx and idx % sleep_every == 0:
            time.sleep(sleep_ms / 1000.0)
        if idx and idx % 50 == 0:
            print(f"  fetched {idx}/{len(slugs)}", flush=True)

    resolved: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    for sample in samples.values():
        ev = events.get(str(sample.get("eventSlug")))
        markets = {str(m.get("id")): m for m in (ev or {}).get("markets", [])}
        broad = sample.get("broad") or {}
        narrow = sample.get("narrow") or {}
        broad_market = markets.get(str(broad.get("marketId")))
        narrow_market = markets.get(str(narrow.get("marketId")))
        bw = token_won(broad_market, broad.get("yesTokenId"))
        nw = token_won(narrow_market, narrow.get("noTokenId"))
        enriched = dict(sample)
        if bw is None or nw is None:
            unknown.append(enriched)
            continue
        payout = int(bool(bw)) + int(bool(nw))
        enriched["resolvedPayout"] = payout
        enriched["broadWon"] = bool(bw)
        enriched["narrowWon"] = bool(nw)
        resolved.append(enriched)
    return resolved, unknown


def aggregate(resolved: list[dict[str, Any]]) -> dict[str, Any]:
    by_bucket: dict[str, dict[str, Any]] = defaultdict(lambda: {"n": 0, "middles": 0, "floors": 0, "zeros": 0, "cost_sum": 0.0, "pnl_sum": 0.0})
    by_family: dict[str, dict[str, Any]] = defaultdict(lambda: {"n": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})
    by_asset: dict[str, dict[str, Any]] = defaultdict(lambda: {"n": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})
    by_width: dict[int, dict[str, Any]] = defaultdict(lambda: {"n": 0, "middles": 0, "cost_sum": 0.0, "pnl_sum": 0.0})

    for s in resolved:
        cost = float(s.get("packageCost", 0))
        payout = int(s.get("resolvedPayout", 0))
        pnl = payout - cost
        bucket = bucket_for(cost)
        fam = line_family(s)
        asset = str(s.get("asset"))
        width = middle_width(s)

        b = by_bucket[bucket]
        b["n"] += 1
        b["middles"] += 1 if payout == 2 else 0
        b["floors"] += 1 if payout == 1 else 0
        b["zeros"] += 1 if payout == 0 else 0
        b["cost_sum"] += cost
        b["pnl_sum"] += pnl

        f = by_family[fam]
        f["n"] += 1
        f["middles"] += 1 if payout == 2 else 0
        f["cost_sum"] += cost
        f["pnl_sum"] += pnl

        a = by_asset[asset]
        a["n"] += 1
        a["middles"] += 1 if payout == 2 else 0
        a["cost_sum"] += cost
        a["pnl_sum"] += pnl

        if width is not None:
            w = by_width[width]
            w["n"] += 1
            w["middles"] += 1 if payout == 2 else 0
            w["cost_sum"] += cost
            w["pnl_sum"] += pnl

    def finish(rows: dict[Any, dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for k, v in rows.items():
            n = v["n"]
            avg_cost = v["cost_sum"] / n if n else 0
            roi = v["pnl_sum"] / v["cost_sum"] if v["cost_sum"] else 0
            hit = v["middles"] / n if n else 0
            entry = {"key": k, "n": n, "middles": v["middles"], "hit_rate": hit, "avg_cost": avg_cost, "roi": roi}
            if "floors" in v:
                entry["floors"] = v["floors"]
                entry["zeros"] = v["zeros"]
            out.append(entry)
        out.sort(key=lambda r: r["n"], reverse=True)
        return out

    return {
        "by_bucket": finish(by_bucket),
        "by_family": finish(by_family),
        "by_asset": finish(by_asset),
        "by_width": finish(by_width),
    }


def print_report(report: dict[str, Any]) -> None:
    def fmt(rows: list[dict[str, Any]], key_label: str) -> None:
        if not rows:
            print("  (no data)")
            return
        print(f"  {key_label:>15} | {'n':>5} | {'middles':>7} | {'hit':>6} | {'avg_cost':>8} | {'roi':>7}")
        for r in rows:
            print(f"  {str(r['key']):>15} | {r['n']:>5} | {r['middles']:>7} | {r['hit_rate']*100:>5.1f}% | {r['avg_cost']:>8.4f} | {r['roi']*100:>+6.1f}%")

    summary = report.get("summary", {})
    print("\n=== Tennis shadow resolution ===")
    print(f"audit:               {summary.get('audit')}")
    print(f"since:               {summary.get('since')}")
    print(f"unique packages:     {summary.get('unique_packages')}")
    print(f"resolved packages:   {summary.get('resolved_packages')}")
    print(f"unknown / open:      {summary.get('unknown_packages')}")
    payout_counts = summary.get("payout_counts", {})
    print(f"middle hits / floor / zero: {payout_counts.get('2', 0)} / {payout_counts.get('1', 0)} / {payout_counts.get('0', 0)}")

    print("\nBy asset:")
    fmt(report["aggregate"]["by_asset"], "asset")
    print("\nBy cost bucket:")
    fmt(report["aggregate"]["by_bucket"], "bucket")
    print("\nBy middle width:")
    fmt(report["aggregate"]["by_width"], "width")
    print("\nBy line family (top 25):")
    fmt(report["aggregate"]["by_family"][:25], "family")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--audit", default="/var/lib/sports-arb/data/monotonic-middle-audit.jsonl")
    p.add_argument("--since", help="ISO timestamp; only include observations at/after this time")
    p.add_argument("--out", help="Write JSON report to this path")
    args = p.parse_args()

    since = parse_ts(args.since) if args.since else None
    samples = stream_tennis_samples(Path(args.audit), since)
    resolved, unknown = resolve_samples(samples)
    payouts = Counter(s.get("resolvedPayout") for s in resolved)
    aggregate_rows = aggregate(resolved)
    report = {
        "summary": {
            "audit": str(args.audit),
            "since": args.since,
            "unique_packages": len(samples),
            "resolved_packages": len(resolved),
            "unknown_packages": len(unknown),
            "payout_counts": {str(k): v for k, v in payouts.items()},
        },
        "aggregate": aggregate_rows,
    }
    print_report(report)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(report, indent=2, default=str) + "\n")
        print(f"\nReport written to {args.out}")


if __name__ == "__main__":
    main()
