#!/usr/bin/env python3
"""Score Strat 2 (state-locked middles) from state-feed-shadow.jsonl.

Uses feed score/clock — never ladder inference.
Pass bars (per sport):
  -/high-p (>=70%) calibration within ~15 pts of realized
  - terminal/late in-band ROI >= 0
  - selected ROI > 0 at some margin → GO
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from monotonic_middle_report import parse_ts, resolve_samples

ROOT = Path(__file__).resolve().parents[1]


def _default_shadow() -> Path:
    """Resolve the shadow file: env override first, then first existing known location."""
    import os

    override = os.environ.get("STATE_FEED_SHADOW_PATH")
    if override:
        return Path(override)
    candidates = []
    data_dir = os.environ.get("SPORTS_ARB_DATA_DIR")
    if data_dir:
        candidates.append(Path(data_dir) / "state-feed-shadow.jsonl")
    candidates.append(Path("/var/lib/sports-arb/data/state-feed-shadow.jsonl"))
    candidates.append(ROOT / "data" / "state-feed-shadow.jsonl")
    for cand in candidates:
        if cand.exists():
            return cand
    return candidates[0]


DEFAULT_SHADOW = _default_shadow()

MIN_AVAIL = 20.0
DUST_YES = 0.02
DUST_NO = 0.98
MARGINS = (0.05, 0.08, 0.12)
# Soccer: expected goals remaining Per 90 ~2.6 → λ_per_min
SOCCER_LAMBDA_PER_MIN = 2.6 / 90.0
SOCCER_MATCH_MIN = 90.0
# MLB: ~0.5 runs/inning remaining rough prior
MLB_RUNS_PER_INNING = 0.48


def poisson_pmf(k: int, lam: float) -> float:
    if lam < 0:
        return 0.0
    if lam == 0:
        return 1.0 if k == 0 else 0.0
    # stable recursive
    p = math.exp(-lam)
    if k == 0:
        return p
    for i in range(1, k + 1):
        p *= lam / i
    return p


def poisson_p_in_band(current: int, lo: float, hi: float, lam: float, max_extra: int = 20) -> float:
    """P(final total in (lo, hi]) where final = current + X, X~Poisson(lam).
    Middles are underlying > lo and <= hi for O/U lo/hi packages (YES broad over lo + NO narrow over hi).
    """
    # Target: current + X > lo and current + X <= hi
    # => X > lo - current and X <= hi - current
    low_x = math.floor(lo - current) + 1  # strict >
    high_x = math.floor(hi - current)
    if high_x < 0:
        return 0.0
    low_x = max(0, low_x)
    total = 0.0
    for x in range(low_x, min(high_x, max_extra) + 1):
        total += poisson_pmf(x, lam)
    return max(0.0, min(1.0, total))


def parse_soccer_minutes_left(feed: dict[str, Any]) -> float | None:
    clock = str(feed.get("clock") or "")
    period = str(feed.get("period") or "")
    status = str(feed.get("status") or "")
    if status in ("FT", "FINISHED") or "FT" in clock.upper():
        return 0.0
    # "45+2", "67'", "67", liveTime long forms
    m = re.search(r"(\d{1,3})", clock)
    if m:
        minute = int(m.group(1))
        return max(0.0, SOCCER_MATCH_MIN - minute)
    if period in ("1", "1H") or "1st" in period.lower():
        return 60.0  # crude mid-half default if clock missing
    if period in ("2", "2H", "HT") or "2nd" in period.lower() or period == "HT":
        return 25.0
    if feed.get("live"):
        return 45.0
    return None


def parse_mlb_innings_left(feed: dict[str, Any]) -> float | None:
    period = str(feed.get("period") or "")
    status = str(feed.get("status") or "").lower()
    if "final" in status:
        return 0.0
    # "Top 5" / "Bottom 7"
    m = re.search(r"(\d{1,2})", period)
    if not m:
        return 4.5 if feed.get("live") else None
    inning = int(m.group(1))
    half = period.lower()
    # Remaining full innings after current roughly
    left = max(0, 9 - inning)
    if "top" in half:
        left += 1.0  # rest of this + home half-ish; keep simple
    elif "bottom" in half:
        left += 0.5
    else:
        left += 0.75
    return float(left)


def is_dust(pkg: dict[str, Any]) -> bool:
    bya = float(pkg.get("broadYesAsk") or 0)
    nna = float(pkg.get("narrowNoAsk") or 0)
    return bya <= DUST_YES or nna >= DUST_NO or bya <= 0 or nna <= 0


def tradeable(pkg: dict[str, Any]) -> bool:
    return (
        not is_dust(pkg)
        and float(pkg.get("availableSize") or 0) >= MIN_AVAIL
        and 0.5 < float(pkg.get("packageCost") or 99) < 1.55
    )


def current_total(feed: dict[str, Any]) -> int | None:
    try:
        home = feed.get("scoreHome")
        away = feed.get("scoreAway")
        if home is None or away is None:
            return None
        return int(home) + int(away)
    except (TypeError, ValueError):
        return None


def p_middle(asset: str, feed: dict[str, Any], lo: float, hi: float) -> tuple[float | None, dict[str, Any]]:
    cur = current_total(feed)
    if cur is None:
        return None, {"reason": "no_score"}
    if asset == "SOCCER":
        mins = parse_soccer_minutes_left(feed)
        if mins is None:
            return None, {"reason": "no_clock"}
        lam = SOCCER_LAMBDA_PER_MIN * mins
        p = poisson_p_in_band(cur, lo, hi, lam)
        return p, {"currentTotal": cur, "minutesLeft": mins, "lambda": lam}
    if asset == "MLB":
        inn = parse_mlb_innings_left(feed)
        if inn is None:
            return None, {"reason": "no_inning"}
        lam = MLB_RUNS_PER_INNING * inn
        p = poisson_p_in_band(cur, lo, hi, lam)
        return p, {"currentTotal": cur, "inningsLeft": inn, "lambda": lam}
    return None, {"reason": "bad_asset"}


def load_snapshots(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    with path.open(errors="replace") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("schemaVersion") != 1 or row.get("kind") != "snapshot":
                continue
            rows.append(row)
    return rows


def select_candidates(rows: list[dict[str, Any]], margin: float) -> list[dict[str, Any]]:
    # Deduplicate: keep best (lowest cost among edge) per packageId per ~minute bucket
    best: dict[str, dict[str, Any]] = {}
    for row in rows:
        feed = row.get("feed") or {}
        if not feed.get("live") and str(feed.get("status") or "") not in ("FT", "Final", "FINAL"):
            # allow live primarily; still include late locked
            if not feed.get("live"):
                continue
        asset = str(row.get("asset") or "")
        for pkg in row.get("packages") or []:
            if not tradeable(pkg):
                continue
            lo = float(pkg.get("lo") or 0)
            hi = float(pkg.get("hi") or 0)
            cost = float(pkg.get("packageCost") or 99)
            p, meta = p_middle(asset, feed, lo, hi)
            if p is None:
                continue
            fair = 1.0 + p
            if cost > fair - margin:
                continue
            pid = str(pkg.get("packageId") or "")
            if not pid:
                continue
            # minute bucket for de-dupe
            ts = parse_ts(row.get("observedAt"))
            bucket = int(ts.timestamp() // 60) if ts else 0
            key = f"{pid}@{bucket}"
            cand = {
                "eventSlug": row.get("eventSlug"),
                "asset": asset,
                "observedAt": row.get("observedAt"),
                "packageId": pid,
                "packageCost": cost,
                "availableSize": pkg.get("availableSize"),
                "lo": lo,
                "pMiddle": p,
                "fair": fair,
                "edge": fair - cost,
                "margin": margin,
                "state": meta,
                "feed": {
                    "scoreHome": feed.get("scoreHome"),
                    "scoreAway": feed.get("scoreAway"),
                    "period": feed.get("period"),
                    "clock": feed.get("clock"),
                    "outs": feed.get("outs"),
                    "status": feed.get("status"),
                    "live": feed.get("live"),
                },
                "broad": {
                    "marketId": pkg.get("broadMarketId"),
                    "yesTokenId": pkg.get("broadYesTokenId"),
                    "strike": lo,
                },
                "narrow": {
                    "marketId": pkg.get("narrowMarketId"),
                    "noTokenId": pkg.get("narrowNoTokenId"),
                    "strike": hi,
                },
                "hi": hi,
            }
            prev = best.get(key)
            if prev is None or cost < float(prev["packageCost"]):
                best[key] = cand
    return list(best.values())


def calibration(resolved: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets = [
        (0.0, 0.2, "0-20"),
        (0.2, 0.4, "20-40"),
        (0.4, 0.6, "40-60"),
        (0.6, 0.7, "60-70"),
        (0.7, 1.01, "70-100"),
    ]
    out = []
    for lo, hi, label in buckets:
        rows = [r for r in resolved if lo <= float(r.get("pMiddle") or 0) < hi]
        if not rows:
            out.append({"bucket": label, "n": 0, "pred": None, "realized": None})
            continue
        pred = sum(float(r["pMiddle"]) for r in rows) / len(rows)
        realized = sum(1 for r in rows if r.get("resolvedPayout") == 2) / len(rows)
        out.append({"bucket": label, "n": len(rows), "pred": pred, "realized": realized, "gap": realized - pred})
    return out


def is_terminalish(cand: dict[str, Any]) -> bool:
    st = cand.get("state") or {}
    mins = st.get("minutesLeft")
    inns = st.get("inningsLeft")
    if mins is not None and mins <= 10:
        return True
    if inns is not None and inns <= 1.5:
        return True
    cur = st.get("currentTotal")
    lo, hi = cand.get("lo"), cand.get("hi")
    if cur is not None and lo is not None and hi is not None:
        # already inside middle band with little time → terminal lock slice
        if lo < cur <= hi and ((mins is not None and mins <= 20) or (inns is not None and inns <= 3)):
            return True
    return False


def score_margin(cands: list[dict[str, Any]], margin: float) -> dict[str, Any]:
    # Collapse duplicate packageIds keeping lowest cost
    unique: dict[str, dict[str, Any]] = {}
    for c in cands:
        pid = c["packageId"]
        if pid not in unique or float(c["packageCost"]) < float(unique[pid]["packageCost"]):
            unique[pid] = c
    sample_map = {
        pid: {
            "packageId": pid,
            "eventSlug": c["eventSlug"],
            "packageCost": c["packageCost"],
            "broad": c["broad"],
            "narrow": c["narrow"],
            "pMiddle": c["pMiddle"],
        }
        for pid, c in unique.items()
    }
    resolved, unknown = resolve_samples(sample_map) if sample_map else ([], [])
    # attach pMiddle / packageId via eventSlug+cost (resolve_samples preserves sample fields)
    for r in resolved:
        if r.get("pMiddle") is not None and r.get("packageId"):
            continue
        for pid, c in unique.items():
            if c["eventSlug"] == r.get("eventSlug") and abs(float(c["packageCost"]) - float(r["packageCost"])) < 1e-9:
                r["pMiddle"] = c["pMiddle"]
                r["packageId"] = pid
                break

    pnl = 0.0
    stake = 0.0
    middles = 0
    for r in resolved:
        cost = float(r["packageCost"])
        payout = float(r["resolvedPayout"])
        pnl += payout - cost
        stake += cost
        if payout == 2:
            middles += 1
    roi = pnl / stake if stake > 0 else None

    # terminal slice
    term_ids = {c["packageId"] for c in unique.values() if is_terminalish(c)}
    term_res = [r for r in resolved if r.get("packageId") in term_ids]
    term_pnl = sum(float(r["resolvedPayout"]) - float(r["packageCost"]) for r in term_res)
    term_stake = sum(float(r["packageCost"]) for r in term_res)
    term_roi = term_pnl / term_stake if term_stake > 0 else None

    cal = calibration(resolved)
    high = next((b for b in cal if b["bucket"] == "70-100"), None)
    high_ok = False
    if high and high["n"] and high["pred"] is not None and high["realized"] is not None:
        high_ok = abs(high["realized"] - high["pred"]) <= 0.15

    return {
        "margin": margin,
        "selectedN": len(unique),
        "resolved": len(resolved),
        "unknown": len(unknown),
        "middles": middles,
        "middlePct": middles / len(resolved) if resolved else None,
        "roi": roi,
        "pnl": pnl,
        "stake": stake,
        "terminal": {"n": len(term_res), "roi": term_roi},
        "calibration": cal,
        "highPCalibrated": high_ok,
        "highP": high,
    }


def pass_bars(by_margin: dict[str, dict[str, Any]]) -> dict[str, Any]:
    best = None
    for m, block in by_margin.items():
        if block.get("roi") is not None and (best is None or block["roi"] > best["roi"]):
            best = {**block, "margin": float(m)}
    checks = {
        "hasPositiveRoiMargin": best is not None and best.get("roi") is not None and best["roi"] > 0,
        "highPCalibrated": any(b.get("highPCalibrated") for b in by_margin.values()),
        "terminalRoiNonNeg": any(
            (b.get("terminal") or {}).get("roi") is not None and (b.get("terminal") or {}).get("roi") >= 0
            for b in by_margin.values()
            if (b.get("terminal") or {}).get("n", 0) >= 5
        )
        or all((b.get("terminal") or {}).get("n", 0) < 5 for b in by_margin.values()),
    }
    # If no terminal sample yet, don't fail that check (interim)
    go = checks["hasPositiveRoiMargin"] and checks["highPCalibrated"] and checks["terminalRoiNonNeg"]
    # Need some resolved volume
    any_n = sum(b.get("resolved") or 0 for b in by_margin.values())
    interim = any_n < 30
    if interim:
        go = False
    return {"GO": go, "interim": interim, "checks": checks, "best": best, "resolvedN": any_n}


def write_md(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# Strat 2 state score",
        "",
        f"Generated: {report['generatedAt']}",
        f"Shadow: `{report['shadowPath']}`",
        "",
    ]
    for sport, block in report.get("byAsset", {}).items():
        decision = "GO" if block["pass"]["GO"] else ("INTERIM" if block["pass"]["interim"] else "NO-GO")
        lines += [f"## {sport}: **{decision}**", "", f"- checks: `{json.dumps(block['pass']['checks'])}`", ""]
        for m, mb in block.get("byMargin", {}).items():
            lines.append(
                f"- margin {m}: n={mb.get('selectedN')} resolved={mb.get('resolved')} "
                f"ROI={mb.get('roi')} termROI={(mb.get('terminal') or {}).get('roi')} "
                f"highP={mb.get('highP')}"
            )
        lines.append("")
    path.write_text("\n".join(lines) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shadow", type=Path, default=DEFAULT_SHADOW)
    ap.add_argument("--out", type=Path, default=ROOT / "analysis" / "strat2-state-score.json")
    ap.add_argument("--md", type=Path, default=ROOT / "analysis" / "strat2-state-score.md")
    args = ap.parse_args()

    rows = load_snapshots(args.shadow)
    if not rows:
        import sys

        print(
            f"WARNING: no snapshot rows loaded from {args.shadow} "
            f"(exists={args.shadow.exists()}); check STATE_FEED_SHADOW_PATH/SPORTS_ARB_DATA_DIR",
            file=sys.stderr,
        )
    by_asset_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_asset_rows[str(row.get("asset") or "UNKNOWN")].append(row)

    report: dict[str, Any] = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "shadowPath": str(args.shadow),
        "snapshotRows": len(rows),
        "byAsset": {},
    }

    for asset, asset_rows in sorted(by_asset_rows.items()):
        by_margin: dict[str, dict[str, Any]] = {}
        for margin in MARGINS:
            cands = select_candidates(asset_rows, margin)
            by_margin[str(margin)] = score_margin(cands, margin)
        report["byAsset"][asset] = {
            "pass": pass_bars(by_margin),
            "byMargin": by_margin,
        }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    write_md(args.md, report)
    print(json.dumps({k: report[k] for k in ("generatedAt", "snapshotRows", "byAsset")}, indent=2)[:4000])
    print(f"wrote {args.out}")
    print(f"wrote {args.md}")


if __name__ == "__main__":
    main()
