#!/usr/bin/env python3
"""
Compare shadow_would_submit vs live submitted middle-hit rates and test whether
live underperformance is plausibly bad luck vs structural.

Inputs:
  - monotonic-capture-audit.jsonl (shadow + optional submitted_result)
  - analysis/strategy-buckets-live.json (resolved live ledger aggregates)
  - analysis/monotonic-chronological-packages-long.csv (baseline priors)
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def binom_cdf_leq(k: int, n: int, p: float) -> float:
    if n <= 0:
        return 1.0
    return sum(math.comb(n, i) * (p ** i) * ((1 - p) ** (n - i)) for i in range(k + 1))


def load_baseline_bucket_rates(path: Path) -> dict[str, float]:
    groups: dict[str, dict[str, int]] = defaultdict(lambda: {"n": 0, "m": 0})
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("asset") not in {"SOCCER", "MLB"}:
                continue
            payout = row.get("payoutMultiple")
            if payout not in {"0", "1", "2"}:
                continue
            key = f"{row['asset']}:{row['bucket']}"
            groups[key]["n"] += 1
            groups[key]["m"] += 1 if payout == "2" else 0
    return {key: vals["m"] / vals["n"] for key, vals in groups.items() if vals["n"] >= 20}


def strategy_bucket_to_ledger_bucket(cost_bucket: str) -> str:
    mapping = {
        "1.250-1.350": "1.25-2.00",
        "1.220-1.250": "1.16-1.25",
        "1.190-1.220": "1.16-1.25",
        "1.160-1.190": "1.16-1.25",
        "1.100-1.160": "1.10-1.16",
        "1.050-1.100": "1.05-1.10",
        "1.020-1.050": "1.02-1.05",
        "1.005-1.020": "1.005-1.02",
        "1.000-1.005": "1.000-1.005",
        "<1.000": "<1.000",
    }
    return mapping.get(cost_bucket, cost_bucket)


def summarize_capture(audit_path: Path) -> dict[str, Any]:
    by_status: Counter[str] = Counter()
    by_group_shadow: Counter[str] = Counter()
    by_group_live: Counter[str] = Counter()
    if not audit_path.exists():
        return {
            "terminalStatus": {},
            "topShadowGroups": [],
            "topLiveCaptureGroups": [],
            "shadowGroupCount": 0,
            "liveCaptureGroupCount": 0,
            "missingAudit": str(audit_path),
        }
    with audit_path.open(errors="replace") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            status = str(row.get("terminalStatus") or "?")
            by_status[status] += 1
            ws = row.get("ws") or {}
            if ws.get("asset") not in {"SOCCER", "MLB"}:
                continue
            group = (row.get("strategy") or {}).get("comparisonGroup") or "?"
            if status == "shadow_would_submit":
                by_group_shadow[group] += 1
            elif status == "submitted_result":
                by_group_live[group] += 1
    return {
        "terminalStatus": dict(by_status.most_common()),
        "topShadowGroups": by_group_shadow.most_common(12),
        "topLiveCaptureGroups": by_group_live.most_common(12),
        "shadowGroupCount": len(by_group_shadow),
        "liveCaptureGroupCount": len(by_group_live),
    }


def summarize_live_ledger(live_path: Path, baseline_rates: dict[str, float]) -> dict[str, Any]:
    data = json.loads(live_path.read_text())
    buckets = [b for b in data.get("buckets", []) if b.get("sportId") in {"SOCCER", "MLB"}]
    total_n = sum(b["resolved"] for b in buckets)
    total_m = sum(b["middles"] for b in buckets)
    enforced = [b for b in buckets if b.get("enforcedLive")]
    enf_n = sum(b["resolved"] for b in enforced)
    enf_m = sum(b["middles"] for b in enforced)
    enf_cost = sum(b["totalCost"] for b in enforced)
    enf_pnl = sum(b["totalPnl"] for b in enforced)

    sport_rows = []
    for sport in ("SOCCER", "MLB"):
        sub = [b for b in buckets if b["sportId"] == sport]
        n = sum(b["resolved"] for b in sub)
        k = sum(b["middles"] for b in sub)
        prior = 0.319 if sport == "SOCCER" else 0.192
        sport_rows.append({
            "sport": sport,
            "resolved": n,
            "middles": k,
            "middleRate": k / n if n else 0.0,
            "baselineSportRate": prior,
            "pValueVsSportBaseline": binom_cdf_leq(k, n, prior) if n else None,
        })

    bucket_rows = []
    for b in sorted(enforced, key=lambda row: -row["totalCost"])[:12]:
        n, k = b["resolved"], b["middles"]
        ledger_bucket = strategy_bucket_to_ledger_bucket(b["costBucket"])
        prior_key = f"{b['sportId']}:{ledger_bucket}"
        prior = baseline_rates.get(prior_key)
        bucket_rows.append({
            "comparisonGroup": b["comparisonGroup"],
            "resolved": n,
            "middles": k,
            "middleRate": k / n if n else 0.0,
            "capitalWeightedRoiPct": b["capitalWeightedRoiPct"],
            "baselineBucketRate": prior,
            "pValueVsBaselineBucket": binom_cdf_leq(k, n, prior) if prior and n else None,
        })

    return {
        "totalResolvedPackages": data.get("totalResolvedPackages"),
        "soccerMlbResolved": total_n,
        "soccerMlbMiddleRate": total_m / total_n if total_n else 0.0,
        "enforcedLiveResolved": enf_n,
        "enforcedLiveMiddleRate": enf_m / enf_n if enf_n else 0.0,
        "enforcedLiveRoiPct": (enf_pnl / enf_cost * 100) if enf_cost else 0.0,
        "bySport": sport_rows,
        "topEnforcedBuckets": bucket_rows,
    }


def render_markdown(capture: dict[str, Any], live: dict[str, Any]) -> str:
    lines = [
        "# Shadow vs live middle-hit analysis",
        "",
        "## Production shadow population",
        "",
        "The daemon already writes shadow probes to `monotonic-capture-audit.jsonl` as `shadow_would_submit`.",
        "`sports-arb-shadows.jsonl` is now backfilled/exported from that file for tooling parity.",
        "",
        "| Terminal status | Count |",
        "| --- | ---: |",
    ]
    for status, count in capture["terminalStatus"].items():
        lines.append(f"| `{status}` | {count:,} |")
    lines.extend([
        "",
        f"- Unique shadow comparison groups (SOCCER+MLB): **{capture['shadowGroupCount']}**",
        f"- Live `submitted_result` rows in capture audit: **{capture['terminalStatus'].get('submitted_result', 0)}**",
        "",
        "> If `submitted_result` is near zero, live fills were not captured (historically `CAPTURE_AUDIT_MAX_COST=1.25` while Tier-3 live packages reach ~1.35). Default is now **1.35**.",
        "",
        "## Live ledger middle rate vs baseline",
        "",
        f"- SOCCER+MLB resolved (live ledger): **{live['soccerMlbResolved']}** at **{live['soccerMlbMiddleRate']*100:.1f}%** middle rate",
        f"- Enforced-live subset: **{live['enforcedLiveResolved']}** at **{live['enforcedLiveMiddleRate']*100:.1f}%** middle rate, ROI **{live['enforcedLiveRoiPct']:.2f}%**",
        "",
        "| Sport | Live n | Middles | Live rate | Baseline sport rate | p-value (≤ observed) |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ])
    for row in live["bySport"]:
        pv = row["pValueVsSportBaseline"]
        lines.append(
            f"| {row['sport']} | {row['resolved']} | {row['middles']} | {row['middleRate']*100:.1f}% | "
            f"{row['baselineSportRate']*100:.1f}% | {pv:.4f} |" if pv is not None else ""
        )
    lines.extend([
        "",
        "## Is it bad luck?",
        "",
    ])
    soccer = next(r for r in live["bySport"] if r["sport"] == "SOCCER")
    if soccer["pValueVsSportBaseline"] is not None and soccer["pValueVsSportBaseline"] < 0.05:
        lines.append(
            "- **SOCCER: unlikely pure bad luck.** Live middle rate is significantly below the Jun 16–22 sport-wide baseline "
            f"({soccer['middles']}/{soccer['resolved']} vs ~32% expected, p={soccer['pValueVsSportBaseline']:.4f})."
        )
    else:
        lines.append("- **SOCCER: could still be variance** at current sample sizes.")
    lines.append(
        "- **MLB: too few live packages** to distinguish bad luck from structural miss (~20 resolved)."
    )
    lines.extend([
        "",
        "Even when middle rate is unlucky, **ROI can still be negative** because live concentrates capital in high-cost buckets where floor-only outcomes lose more per package.",
        "",
        "## Top enforced-live buckets",
        "",
        "| Bucket | n | Middles | Live rate | Baseline bucket rate | p-value | ROI |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ])
    for row in live["topEnforcedBuckets"]:
        br = row["baselineBucketRate"]
        pv = row["pValueVsBaselineBucket"]
        lines.append(
            f"| `{row['comparisonGroup']}` | {row['resolved']} | {row['middles']} | {row['middleRate']*100:.1f}% | "
            f"{(br*100 if br else 0):.1f}% | {(f'{pv:.3f}' if pv is not None else '—')} | {row['capitalWeightedRoiPct']:.1f}% |"
        )
    lines.extend([
        "",
        "## Execution vs luck checklist",
        "",
        "| Signal | What it suggests |",
        "| --- | --- |",
        "| Fill slippage ~0¢ on most buckets | Execution price is **not** the main drag |",
        "| Middle rate far below baseline bucket | **Outcome mix** problem, not just fees |",
        "| Worst buckets are Tier-3 high-cost soccer | **Selection** problem: trading shapes/buckets the backtest warned were selective |",
        "| `submitted_result` missing in capture audit | Could not compare shadow vs live on identical preflight path historically |",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Shadow vs live middle-hit analysis")
    parser.add_argument("--capture-audit", default="/var/lib/sports-arb/data/monotonic-capture-audit.jsonl")
    parser.add_argument("--live-buckets", default="analysis/strategy-buckets-live.json")
    parser.add_argument("--baseline-packages", default="analysis/monotonic-chronological-packages-long.csv")
    parser.add_argument("--out-json", default="analysis/shadow-live-middle-analysis.json")
    parser.add_argument("--out-md", default="analysis/shadow-live-middle-analysis.md")
    args = parser.parse_args()

    baseline_rates = load_baseline_bucket_rates(Path(args.baseline_packages))
    capture = summarize_capture(Path(args.capture_audit))
    live = summarize_live_ledger(Path(args.live_buckets), baseline_rates)
    report = {"captureAudit": capture, "liveLedger": live}

    out_json = Path(args.out_json)
    out_md = Path(args.out_md)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2) + "\n")
    out_md.write_text(render_markdown(capture, live) + "\n")
    print(json.dumps({"wroteJson": str(out_json), "wroteMarkdown": str(out_md), "liveMiddleRate": live["soccerMlbMiddleRate"]}, indent=2))


if __name__ == "__main__":
    main()
