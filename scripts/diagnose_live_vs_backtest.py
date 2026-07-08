#!/usr/bin/env python3
"""Diagnose why live execution underperforms the backtest.

Joins resolved live fills (trades.json) against backtest records
(ev-lookup.json: per-package best/worst scanned costs + shape) and quantifies
each loss source:
  1. Entry-price gap: live fill cost vs the scanned best/worst for the SAME package.
  2. Shape mix: capital weighted into shapes whose backtest ROI@worst is negative.
  3. Cost-above-breakeven: fills priced above shape breakeven (middleRate + 1).
  4. Orphan/unwind drag.
  5. Incident losses (compounded re-entries, fat-finger rows).
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

TRADES = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/lib/sports-arb/data/reports/sports-pnl-report/trades.json")
EV = Path(sys.argv[2] if len(sys.argv) > 2 else "/var/lib/sports-arb/data/ev-lookup.json")
SHAPES = Path(sys.argv[3] if len(sys.argv) > 3 else "/opt/sports-arb/analysis/shape-roi-jun16-jul3-continuous.json")


def main() -> None:
    payload = json.loads(TRADES.read_text())
    rows = payload["trades"] if isinstance(payload, dict) else payload
    ev = json.loads(EV.read_text())
    recs = {r["packageId"]: r for r in ev["records"]}
    shape_rows = json.loads(SHAPES.read_text())["rows"]
    shapes = {
        (r["asset"], r["marketType"], r["lineFamily"]): r
        for r in shape_rows
    }

    resolved = [r for r in rows if str(r.get("result", "")).startswith("RESOLVED")]
    orphans = [r for r in rows if r.get("orphan")]
    open_rows = [r for r in rows if not r.get("orphan") and not str(r.get("result", "")).startswith("RESOLVED")]

    print("=== P&L DECOMPOSITION (lifetime, deduped ledger) ===")
    for label, group in (("resolved", resolved), ("orphans", orphans), ("open/mark", open_rows)):
        c = sum(r["cost"] for r in group)
        p = sum(r["pnl"] for r in group)
        print(f"{label:>10}: n={len(group):3d} cost=${c:8.2f} pnl={p:+8.2f}")

    print()
    print("=== RESOLVED: JOIN TO BACKTEST RECORDS ===")
    n_join = 0
    over_best_usd = 0.0
    over_worst_usd = 0.0
    middles = 0
    per_shape = defaultdict(lambda: {"n": 0, "cost": 0.0, "pnl": 0.0, "mid": 0, "over_best": 0.0})
    unjoined_cost = 0.0
    unjoined_pnl = 0.0
    for r in resolved:
        pid = r["packageId"]
        cps = r["costPerShare"]
        sh = r["shares"]
        is_mid = str(r["result"]).startswith("RESOLVED 2/2")
        middles += is_mid
        rec = recs.get(pid)
        if not rec:
            unjoined_cost += r["cost"]
            unjoined_pnl += r["pnl"]
            continue
        n_join += 1
        over_best_usd += max(0.0, cps - rec["bestCost"]) * sh
        over_worst_usd += max(0.0, cps - rec["worstCost"]) * sh
        key = f'{rec["asset"]}:{rec["marketType"]}:{rec["lineFamily"]}'
        s = per_shape[key]
        s["n"] += 1
        s["cost"] += r["cost"]
        s["pnl"] += r["pnl"]
        s["mid"] += is_mid
        s["over_best"] += max(0.0, cps - rec["bestCost"]) * sh

    print(f"joined {n_join}/{len(resolved)} resolved fills (unjoined: cost=${unjoined_cost:.0f} pnl={unjoined_pnl:+.2f})")
    print(f"live middle rate: {middles}/{len(resolved)} = {middles / max(1, len(resolved)) * 100:.1f}%")
    print(f"overpayment vs BEST scanned cost of same package:  ${over_best_usd:.2f}")
    print(f"overpayment vs WORST scanned cost of same package: ${over_worst_usd:.2f}")

    print()
    print("=== RESOLVED P&L BY SHAPE (live) vs BACKTEST EXPECTATION ===")
    hdr = f'{"shape":<38}{"n":>4}{"liveMid%":>9}{"btMid%":>8}{"livePnL":>9}{"cost":>8}{"overBest$":>10}{"btROI@w":>9}{"btN":>5}'
    print(hdr)
    print("-" * len(hdr))
    for key, s in sorted(per_shape.items(), key=lambda kv: kv[1]["pnl"]):
        asset, mt, fam = key.split(":")
        bt = shapes.get((asset, mt, fam))
        bt_mid = f'{bt["middleRate"] * 100:.0f}%' if bt else "—"
        bt_roi = f'{bt["worstRoiPct"]:+.1f}%' if bt else "—"
        bt_n = str(bt["resolved"]) if bt else "—"
        live_mid = f'{s["mid"] / s["n"] * 100:.0f}%'
        print(f'{key:<38}{s["n"]:>4}{live_mid:>9}{bt_mid:>8}{s["pnl"]:>+9.2f}{s["cost"]:>8.0f}{s["over_best"]:>10.2f}{bt_roi:>9}{bt_n:>5}')

    print()
    print("=== COST-VS-BREAKEVEN AT ENTRY (resolved, joined) ===")
    # Breakeven cost for a shape = 1 + middleRate (expected payout).
    above_be_cost = 0.0
    above_be_pnl = 0.0
    below_be_cost = 0.0
    below_be_pnl = 0.0
    for r in resolved:
        rec = recs.get(r["packageId"])
        if not rec:
            continue
        bt = shapes.get((rec["asset"], rec["marketType"], rec["lineFamily"]))
        if not bt:
            continue
        breakeven = 1.0 + bt["middleRate"]
        if r["costPerShare"] > breakeven:
            above_be_cost += r["cost"]
            above_be_pnl += r["pnl"]
        else:
            below_be_cost += r["cost"]
            below_be_pnl += r["pnl"]
    print(f"entries ABOVE shape breakeven (1+middleRate): cost=${above_be_cost:.0f} pnl={above_be_pnl:+.2f}")
    print(f"entries AT/BELOW shape breakeven:             cost=${below_be_cost:.0f} pnl={below_be_pnl:+.2f}")

    print()
    print("=== WORST 12 RESOLVED LOSERS ===")
    for r in sorted(resolved, key=lambda x: x["pnl"])[:12]:
        rec = recs.get(r["packageId"])
        shape = f'{rec["asset"]}:{rec["marketType"]}:{rec["lineFamily"]}' if rec else "?"
        best = f'{rec["bestCost"]:.3f}' if rec else "—"
        print(f'{str(r["createdAt"])[:10]} {shape:<34} paid={r["costPerShare"]:.3f} best={best} sh={r["shares"]:6.1f} pnl={r["pnl"]:+7.2f} {r["packageId"][-26:]}')

    print()
    print("=== ORPHAN DRAG ===")
    for r in sorted(orphans, key=lambda x: x["pnl"])[:10]:
        print(f'{str(r["createdAt"])[:10]} {r["sport"]:<7} cost={r["cost"]:7.2f} pnl={r["pnl"]:+7.2f} {r["packageId"][-30:]}')


if __name__ == "__main__":
    main()
