#!/usr/bin/env python3
"""Fit an empirical calibration for the Strat 2 state model.

Unlike score_strat2_state.py (which only scores packages the model wanted to
buy, baking in winner's-curse selection bias), this fits on EVERY package
observation with valid books, weighting each package equally regardless of how
many snapshots it appeared in. Outcomes cluster within a game (all packages in
one game share the final total), so the report also counts unique games as the
honest effective-sample floor.

The fit is a single lambda-scale factor k per asset: replace lambda with
k * lambda in the Poisson band probability and pick k by weighted log-loss.
That keeps probabilities coherent across bands (unlike scaling p directly).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from monotonic_middle_report import parse_ts, resolve_samples
from score_strat2_state import (
    _default_shadow,
    is_dust,
    load_snapshots,
    p_middle,
    poisson_p_in_band,
)

ROOT = Path(__file__).resolve().parents[1]
K_GRID = [round(0.2 + 0.05 * i, 2) for i in range(33)]  # 0.20 .. 1.80
EPS = 1e-6
BUCKETS = [
    (0.0, 0.1, "0-10"),
    (0.1, 0.2, "10-20"),
    (0.2, 0.4, "20-40"),
    (0.4, 0.6, "40-60"),
    (0.6, 1.01, "60-100"),
]


def observation_valid(pkg: dict[str, Any]) -> bool:
    try:
        cost = float(pkg.get("packageCost") or 99)
    except (TypeError, ValueError):
        return False
    return not is_dust(pkg) and 0.5 < cost < 1.9


def collect_observations(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """asset -> list of per-(packageId, minute) observations with state for refit."""
    by_key: dict[tuple[str, str, int], dict[str, Any]] = {}
    for row in rows:
        feed = row.get("feed") or {}
        if not feed.get("live"):
            continue
        asset = str(row.get("asset") or "")
        if asset not in ("MLB", "SOCCER"):
            continue
        ts = parse_ts(row.get("observedAt"))
        bucket = int(ts.timestamp() // 60) if ts else 0
        for pkg in row.get("packages") or []:
            if not observation_valid(pkg):
                continue
            pid = str(pkg.get("packageId") or "")
            if not pid:
                continue
            try:
                lo = float(pkg.get("lo"))
                hi = float(pkg.get("hi"))
            except (TypeError, ValueError):
                continue
            p, meta = p_middle(asset, feed, lo, hi)
            if p is None:
                continue
            lam = meta.get("lambda")
            cur = meta.get("currentTotal")
            if lam is None or cur is None:
                continue
            by_key[(asset, pid, bucket)] = {
                "asset": asset,
                "packageId": pid,
                "eventSlug": row.get("eventSlug"),
                "p": p,
                "lambda": float(lam),
                "currentTotal": int(cur),
                "lo": lo,
                "hi": hi,
                "packageCost": float(pkg.get("packageCost") or 0),
                "broad": {
                    "marketId": pkg.get("broadMarketId"),
                    "yesTokenId": pkg.get("broadYesTokenId"),
                },
                "narrow": {
                    "marketId": pkg.get("narrowMarketId"),
                    "noTokenId": pkg.get("narrowNoTokenId"),
                },
            }
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for obs in by_key.values():
        out[obs["asset"]].append(obs)
    return out


def resolve_outcomes(observations: list[dict[str, Any]]) -> dict[str, bool]:
    """packageId -> middle hit, for packages that resolved."""
    samples: dict[str, dict[str, Any]] = {}
    for obs in observations:
        pid = obs["packageId"]
        if pid not in samples:
            samples[pid] = {
                "packageId": pid,
                "eventSlug": obs["eventSlug"],
                "packageCost": obs["packageCost"],
                "broad": obs["broad"],
                "narrow": obs["narrow"],
            }
    if not samples:
        return {}
    resolved, _unknown = resolve_samples(samples)
    return {str(r["packageId"]): float(r["resolvedPayout"]) == 2 for r in resolved}


def weighted_obs(observations: list[dict[str, Any]], outcomes: dict[str, bool]) -> list[dict[str, Any]]:
    counts: dict[str, int] = defaultdict(int)
    usable = [o for o in observations if o["packageId"] in outcomes]
    for o in usable:
        counts[o["packageId"]] += 1
    for o in usable:
        o["y"] = 1.0 if outcomes[o["packageId"]] else 0.0
        o["weight"] = 1.0 / counts[o["packageId"]]
    return usable


def log_loss(obs: list[dict[str, Any]], k: float) -> float:
    total = 0.0
    wsum = 0.0
    for o in obs:
        p = poisson_p_in_band(o["currentTotal"], o["lo"], o["hi"], k * o["lambda"])
        p = min(1 - EPS, max(EPS, p))
        total += o["weight"] * (o["y"] * math.log(p) + (1 - o["y"]) * math.log(1 - p))
        wsum += o["weight"]
    return -total / wsum if wsum else float("inf")


def calibration_table(obs: list[dict[str, Any]], k: float | None) -> list[dict[str, Any]]:
    rows = []
    for lo, hi, label in BUCKETS:
        sel = []
        for o in obs:
            p = o["p"] if k is None else poisson_p_in_band(o["currentTotal"], o["lo"], o["hi"], k * o["lambda"])
            if lo <= p < hi:
                sel.append((p, o["y"], o["weight"]))
        wsum = sum(w for _, _, w in sel)
        if not sel or wsum <= 0:
            rows.append({"bucket": label, "n": 0})
            continue
        rows.append(
            {
                "bucket": label,
                "n": len(sel),
                "weight": round(wsum, 1),
                "pred": round(sum(p * w for p, _, w in sel) / wsum, 4),
                "realized": round(sum(y * w for _, y, w in sel) / wsum, 4),
            }
        )
    return rows


def fit_asset(observations: list[dict[str, Any]]) -> dict[str, Any]:
    outcomes = resolve_outcomes(observations)
    obs = weighted_obs(observations, outcomes)
    packages = {o["packageId"] for o in obs}
    games = {o["eventSlug"] for o in obs}
    middles = sum(1 for pid in packages if outcomes[pid])
    result: dict[str, Any] = {
        "observations": len(obs),
        "packagesResolved": len(packages),
        "packagesUnresolved": len({o["packageId"] for o in observations}) - len(packages),
        "games": len(games),
        "middlesHit": middles,
        "rawLogLoss": round(log_loss(obs, 1.0), 4) if obs else None,
        "rawCalibration": calibration_table(obs, None),
    }
    # A lambda fit needs enough independent outcomes; games are the honest unit.
    if len(games) < 8 or len(packages) < 30:
        result["fit"] = None
        result["note"] = "insufficient sample (need >=8 games and >=30 resolved packages)"
        return result
    best_k = min(K_GRID, key=lambda k: log_loss(obs, k))
    result["fit"] = {
        "lambdaScale": best_k,
        "fittedLogLoss": round(log_loss(obs, best_k), 4),
        "fittedCalibration": calibration_table(obs, best_k),
    }
    return result


def write_md(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# Strat 2 calibration fit",
        "",
        f"Generated: {report['generatedAt']}",
        f"Shadow: `{report['shadowPath']}`",
        "",
        "Fit on ALL observed packages with valid books (not just model-selected ones),",
        "each package weighted equally. `lambdaScale` rescales the Poisson rate;",
        "k < 1 means the raw model overestimates remaining scoring.",
        "",
    ]
    for asset, block in report.get("byAsset", {}).items():
        lines += [
            f"## {asset}",
            "",
            f"- observations={block['observations']} resolvedPackages={block['packagesResolved']} "
            f"games={block['games']} middlesHit={block['middlesHit']}",
            f"- raw log-loss: {block['rawLogLoss']}",
        ]
        fit = block.get("fit")
        if fit:
            lines.append(f"- **lambdaScale k = {fit['lambdaScale']}** (log-loss {fit['fittedLogLoss']})")
        else:
            lines.append(f"- fit: {block.get('note')}")
        lines.append("")
        for label, key in (("raw", "rawCalibration"), ("fitted", "fittedCalibration")):
            table = fit.get(key) if (fit and key == "fittedCalibration") else block.get(key) if key == "rawCalibration" else None
            if not table:
                continue
            lines.append(f"### {label} calibration")
            lines.append("")
            lines.append("| bucket | n | weight | predicted | realized |")
            lines.append("|---|---|---|---|---|")
            for row in table:
                if not row.get("n"):
                    continue
                lines.append(
                    f"| {row['bucket']} | {row['n']} | {row.get('weight')} | {row.get('pred')} | {row.get('realized')} |"
                )
            lines.append("")
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shadow", type=Path, default=_default_shadow())
    ap.add_argument("--out", type=Path, default=ROOT / "analysis" / "strat2-calibration.json")
    ap.add_argument("--md", type=Path, default=ROOT / "analysis" / "strat2-calibration.md")
    args = ap.parse_args()

    rows = load_snapshots(args.shadow)
    if not rows:
        import sys

        print(
            f"WARNING: no snapshot rows loaded from {args.shadow} (exists={args.shadow.exists()})",
            file=sys.stderr,
        )
    by_asset = collect_observations(rows)

    report: dict[str, Any] = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "shadowPath": str(args.shadow),
        "snapshotRows": len(rows),
        "byAsset": {},
    }
    for asset, observations in sorted(by_asset.items()):
        report["byAsset"][asset] = fit_asset(observations)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    write_md(args.md, report)
    print(json.dumps({k: report[k] for k in ("generatedAt", "snapshotRows", "byAsset")}, indent=2)[:4000])
    print(f"wrote {args.out}")
    print(f"wrote {args.md}")


if __name__ == "__main__":
    main()
