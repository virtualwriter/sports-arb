#!/usr/bin/env python3
"""
Build monotonic middle report rollups from data/monotonic-middle-audit.jsonl.

The report intentionally resolves outcomes by winning token id rather than
winner label. Spread markets resolve to team names, while totals resolve to
Yes/No or Over/Under; token matching handles both without special cases.

Examples:
  python3 scripts/monotonic_middle_report.py \
    --audit data/monotonic-middle-audit.jsonl \
    --since 2026-06-15T23:02:00Z \
    --out .tmp/monotonic-middle-report.incremental.json

  python3 scripts/monotonic_middle_report.py --format ts
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


GAMMA_API = "https://gamma-api.polymarket.com"
USER_AGENT = "monotonic-middle-report/1.0"
EPS = 1e-9

COST_BUCKETS = [
    (float("-inf"), 0.9999999, "Sub-1 clean, cost < 1.000"),
    (0.9999999, 1.0050001, "Clean/near-clean, 1.000 <= cost <= 1.005"),
    (1.0050001, 1.02, "Wide, 1.005 < cost <= 1.02"),
    (1.02, 1.05, "Wide, 1.02 < cost <= 1.05"),
    (1.05, 1.10, "Wide, 1.05 < cost <= 1.10"),
    (1.10, 1.16, "Wide, 1.10 < cost <= 1.16"),
    (1.16, 1.25, "Wide, 1.16 < cost <= 1.25"),
    (1.25, float("inf"), "Wide, cost > 1.25"),
]

DEPTH_BUCKETS = [
    (float("-inf"), 0.9999999, "<1.000"),
    (0.9999999, 1.0050001, "1.000-1.005"),
    (1.0050001, 1.02, "1.005-1.02"),
    (1.02, 1.05, "1.02-1.05"),
    (1.05, 1.10, "1.05-1.10"),
    (1.10, 1.16, "1.10-1.16"),
    (1.16, 1.25, "1.16-1.25"),
    (1.25, float("inf"), ">1.25"),
]

WIDE_BUCKETS = [
    (float("-inf"), 0.9999999, "<1.000"),
    (0.9999999, 1.0050001, "1.000-1.005"),
    (1.0050001, 1.02, "1.005-1.02"),
    (1.02, 1.05, "1.02-1.05"),
    (1.05, 1.10, "1.05-1.10"),
    (1.10, 1.16, "1.10-1.16"),
    (1.16, 1.25, "1.16-1.25"),
    (1.25, float("inf"), ">1.25"),
]

SPREAD_THRESHOLDS = [0.02, 0.04, 0.06, 0.08, 0.10, 0.25, float("inf")]


def parse_ts(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


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


def fetch_json(url: str) -> Any:
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def fetch_event(slug: str) -> dict[str, Any] | None:
    data = fetch_json(f"{GAMMA_API}/events?{urllib.parse.urlencode({'slug': slug})}")
    if isinstance(data, list) and data:
        return data[0]
    return None


def winner_index(market: dict[str, Any] | None) -> int | None:
    if not market or not (market.get("closed") or market.get("resolvedBy")):
        return None
    prices = []
    for raw in parse_json_array(market.get("outcomePrices")):
        try:
            prices.append(float(raw))
        except (TypeError, ValueError):
            prices.append(None)
    finite = [price for price in prices if price is not None]
    if not finite or max(finite) < 0.99:
        return None
    return max(range(len(prices)), key=lambda idx: prices[idx] if prices[idx] is not None else -1)


def token_index(market: dict[str, Any] | None, token_id: str | None) -> int | None:
    if not market or token_id is None:
        return None
    tokens = [str(token) for token in parse_json_array(market.get("clobTokenIds"))]
    try:
        return tokens.index(str(token_id))
    except ValueError:
        return None


def token_won(market: dict[str, Any] | None, token_id: str | None) -> bool | None:
    resolved_winner = winner_index(market)
    token_pos = token_index(market, token_id)
    if resolved_winner is None or token_pos is None:
        return None
    return resolved_winner == token_pos


def bucket_label(cost: float, buckets: list[tuple[float, float, str]]) -> str:
    for low, high, label in buckets:
        if low < cost <= high:
            return label
    return buckets[-1][2]


def quantile(sorted_values: list[float], q: float) -> float:
    if not sorted_values:
        return 0.0
    idx = round((len(sorted_values) - 1) * q)
    return sorted_values[int(idx)]


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def cost(value: float) -> str:
    return f"{value:.3f}"


def money(value: float) -> str:
    return f"${value:,.2f}"


def load_best_samples(audit_path: Path, since: dt.datetime | None) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    best: dict[str, dict[str, Any]] = {}
    observations = 0
    min_ts: dt.datetime | None = None
    max_ts: dt.datetime | None = None

    with audit_path.open(errors="replace") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            observed_at = parse_ts(row.get("observedAt"))
            if observed_at is None or (since is not None and observed_at < since):
                continue
            observations += 1
            min_ts = observed_at if min_ts is None or observed_at < min_ts else min_ts
            max_ts = observed_at if max_ts is None or observed_at > max_ts else max_ts
            package_id = row.get("packageId")
            if not package_id:
                continue
            sample_cost = float(row.get("packageCost", 99))
            previous = best.get(package_id)
            if previous is None or sample_cost < float(previous.get("packageCost", 99)):
                best[package_id] = row

    return best, {
        "observations": observations,
        "range": [
            min_ts.isoformat().replace("+00:00", "Z") if min_ts else None,
            max_ts.isoformat().replace("+00:00", "Z") if max_ts else None,
        ],
    }


def resolve_samples(samples: dict[str, dict[str, Any]], sleep_every: int = 50) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    events: dict[str, dict[str, Any] | None] = {}
    for idx, slug in enumerate(sorted({str(row.get("eventSlug")) for row in samples.values()})):
        try:
            events[slug] = fetch_event(slug)
        except Exception:
            events[slug] = None
        if idx and idx % sleep_every == 0:
            time.sleep(0.3)

    resolved: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    for sample in samples.values():
        event = events.get(str(sample.get("eventSlug")))
        markets = {str(market.get("id")): market for market in (event or {}).get("markets", [])}
        broad = sample.get("broad", {})
        narrow = sample.get("narrow", {})
        broad_market = markets.get(str(broad.get("marketId")))
        narrow_market = markets.get(str(narrow.get("marketId")))
        broad_won = token_won(broad_market, broad.get("yesTokenId"))
        narrow_won = token_won(narrow_market, narrow.get("noTokenId"))
        enriched = dict(sample)
        if broad_won is None or narrow_won is None:
            unknown.append(enriched)
            continue
        payout = int(bool(broad_won)) + int(bool(narrow_won))
        enriched["resolvedPayout"] = payout
        enriched["broadWon"] = bool(broad_won)
        enriched["narrowWon"] = bool(narrow_won)
        resolved.append(enriched)
    return resolved, unknown


def coverage_rows(resolved: list[dict[str, Any]], unknown: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = {label: {"bucket": label, "floor": 0, "middle": 0, "unknown": 0} for _, _, label in COST_BUCKETS}
    for sample in resolved:
        label = bucket_label(float(sample.get("packageCost", 99)), COST_BUCKETS)
        if sample["resolvedPayout"] == 2:
            rows[label]["middle"] += 1
        elif sample["resolvedPayout"] == 1:
            rows[label]["floor"] += 1
        else:
            rows[label]["unknown"] += 1
    for sample in unknown:
        label = bucket_label(float(sample.get("packageCost", 99)), COST_BUCKETS)
        rows[label]["unknown"] += 1
    return [rows[label] for _, _, label in COST_BUCKETS]


def clean_blocker_rows(samples: dict[str, dict[str, Any]], resolved: list[dict[str, Any]]) -> list[list[Any]]:
    resolved_by_id = {sample.get("packageId"): sample for sample in resolved}
    counts: Counter[str] = Counter()
    middles: Counter[str] = Counter()
    for sample in samples.values():
        if float(sample.get("packageCost", 99)) > 1.0050001:
            continue
        blockers = sample.get("gate", {}).get("blockers") or []
        label = "Passed websocket gate" if not blockers else " + ".join(blockers)
        counts[label] += 1
        if resolved_by_id.get(sample.get("packageId"), {}).get("resolvedPayout") == 2:
            middles[label] += 1
    return [[label, count, str(middles[label])] for label, count in counts.most_common()]


def spread_counterfactual_rows(resolved: list[dict[str, Any]]) -> list[list[Any]]:
    out: list[list[Any]] = []
    for threshold in SPREAD_THRESHOLDS:
        subset = [
            sample for sample in resolved
            if float(sample.get("packageCost", 99)) <= 1.0050001
            and float(sample.get("maxSpread", 99)) <= threshold + EPS
            and sample.get("resolvedPayout") in (1, 2)
        ]
        middle = sum(1 for sample in subset if sample["resolvedPayout"] == 2)
        total_cost = sum(float(sample.get("packageCost", 0)) for sample in subset)
        roi = (
            sum(sample["resolvedPayout"] - float(sample.get("packageCost", 0)) for sample in subset) / total_cost
            if total_cost else 0
        )
        avg_cost = total_cost / len(subset) if subset else 0
        label = "All clean logged" if threshold == float("inf") else f"<= {int(threshold * 100)}c"
        out.append([label, len(subset), f"{middle} / {len(subset)}", pct(middle / len(subset)) if subset else "0.0%", cost(avg_cost), pct(roi)])
    return out


def wide_cost_rows(resolved: list[dict[str, Any]]) -> list[list[Any]]:
    out: list[list[Any]] = []
    for low, high, label in WIDE_BUCKETS:
        subset = [
            sample for sample in resolved
            if low < float(sample.get("packageCost", 99)) <= high
            and sample.get("resolvedPayout") in (1, 2)
        ]
        middle = sum(1 for sample in subset if sample["resolvedPayout"] == 2)
        total_cost = sum(float(sample.get("packageCost", 0)) for sample in subset)
        roi = (
            sum(sample["resolvedPayout"] - float(sample.get("packageCost", 0)) for sample in subset) / total_cost
            if total_cost else 0
        )
        avg_cost = total_cost / len(subset) if subset else 0
        assets = " + ".join(asset for asset, _ in Counter(str(sample.get("asset")) for sample in subset).most_common(3))
        out.append([label, len(subset), f"{middle} / {len(subset)}", pct(middle / len(subset)) if subset else "0.0%", cost(avg_cost), pct(roi), assets])
    return out


def depth_rows(samples: dict[str, dict[str, Any]]) -> list[list[Any]]:
    out: list[list[Any]] = []
    for low, high, label in DEPTH_BUCKETS:
        subset = [sample for sample in samples.values() if low < float(sample.get("packageCost", 99)) <= high]
        sizes = sorted(float(sample.get("availableSize", 0)) for sample in subset)
        notionals = sorted(float(sample.get("availableSize", 0)) * float(sample.get("packageCost", 0)) for sample in subset)
        if not subset:
            out.append([label, 0, "0.00", "$0.00", "0.00", "0.00", "0.00", "0", "0"])
            continue
        out.append([
            label,
            len(subset),
            f"{statistics.median(sizes):.2f}",
            money(statistics.median(notionals)),
            f"{quantile(sizes, 0.25):.2f}",
            f"{quantile(sizes, 0.75):.2f}",
            f"{quantile(sizes, 0.90):.2f}",
            str(sum(1 for size in sizes if size >= 100)),
            str(sum(1 for size in sizes if size >= 500)),
        ])
    return out


def example_rows(resolved: list[dict[str, Any]], limit: int = 12) -> list[list[str]]:
    examples = sorted(
        [sample for sample in resolved if sample.get("resolvedPayout") == 2],
        key=lambda sample: float(sample.get("packageCost", 99)),
    )[:limit]
    rows = []
    for sample in examples:
        broad = sample.get("broad", {}).get("question", "")
        narrow = sample.get("narrow", {}).get("question", "")
        rows.append([
            "True middle",
            f"{sample.get('asset')} {sample.get('eventSlug')}",
            f"{broad} / {narrow}",
            cost(float(sample.get("packageCost", 0))),
            "2x",
        ])
    return rows


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    since = parse_ts(args.since) if args.since else None
    samples, meta = load_best_samples(Path(args.audit), since)
    resolved, unknown = resolve_samples(samples)
    payout_counts = Counter(sample.get("resolvedPayout") for sample in resolved)
    return {
        "source": str(args.audit),
        "since": since.isoformat().replace("+00:00", "Z") if since else None,
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


def emit_ts(report: dict[str, Any]) -> str:
    """Emit constants that can be pasted into a Cursor canvas."""
    return "\n\n".join([
        f"const middleReportSummary = {json.dumps({k: report[k] for k in ['observations', 'uniqueScannedPackages', 'resolvedPackages', 'unknownOrOpenPackages', 'middleHits', 'floorOnly', 'zeroPayout']}, indent=2)};",
        f"const coverageRows = {json.dumps(report['coverageRows'], indent=2)};",
        f"const cleanBlockerRows = {json.dumps(report['cleanBlockerRows'], indent=2)};",
        f"const spreadCounterfactualRows = {json.dumps(report['spreadCounterfactualRows'], indent=2)};",
        f"const wideCostRows = {json.dumps(report['wideCostRows'], indent=2)};",
        f"const depthRows = {json.dumps(report['depthRows'], indent=2)};",
        f"const exampleRows = {json.dumps(report['exampleRows'], indent=2)};",
    ])


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate monotonic middle hit report data.")
    parser.add_argument("--audit", default="data/monotonic-middle-audit.jsonl", help="Path to monotonic-middle-audit.jsonl")
    parser.add_argument("--since", help="Only include observations at or after this timestamp, e.g. 2026-06-15T23:02:00Z")
    parser.add_argument("--out", help="Write output to this path instead of stdout")
    parser.add_argument("--format", choices=["json", "ts"], default="json", help="Output JSON or TypeScript constants")
    args = parser.parse_args()

    report = build_report(args)
    rendered = emit_ts(report) if args.format == "ts" else json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(rendered + "\n")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
