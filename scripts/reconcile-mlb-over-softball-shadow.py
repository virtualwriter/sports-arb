#!/usr/bin/env python3
"""Reconcile live shadow signals vs nightly early-over softballs.

Usage:
  python3 scripts/reconcile-mlb-over-softball-shadow.py [YYYY-MM-DD]

Reads:
  $SPORTS_ARB_DATA_DIR/mlb-over-softball-orders.jsonl  (signals)
  $SPORTS_ARB_DATA_DIR/backtest/mlb-softball-samples.jsonl (nightly)
"""
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DATA = Path(os.environ.get("SPORTS_ARB_DATA_DIR", "data"))


def target_day() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    return (datetime.now(ET).date() - timedelta(days=1)).isoformat()


def early(cats):
    return "multi_run_early" in cats or "cheap_over_early" in cats


def main():
    day = target_day()
    orders = DATA / "mlb-over-softball-orders.jsonl"
    samples = DATA / "backtest/mlb-softball-samples.jsonl"
    sig = []
    if orders.exists():
        for line in open(orders):
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("kind") != "mlb_over_softball_signal":
                continue
            # t0 is ms epoch
            t0 = o.get("t0")
            if t0 is None:
                continue
            d = datetime.fromtimestamp(t0 / 1000, ET).date().isoformat()
            if d != day:
                continue
            sig.append(o)

    nightly = []
    if samples.exists():
        for line in open(samples):
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("day") != day or o.get("kind") != "over":
                continue
            if not early(o.get("cats") or []):
                continue
            nightly.append(o)

    sig_keys = {(s.get("slug"), s.get("scoreAway"), s.get("scoreHome"), s.get("line")) for s in sig}
    night_keys = {
        (n.get("slug"), n.get("scoreAway"), n.get("scoreHome"), n.get("line")) for n in nightly
    }
    both = sig_keys & night_keys
    only_sig = sig_keys - night_keys
    only_night = night_keys - sig_keys
    print(f"day={day}")
    print(f"shadow_signals={len(sig_keys)}  nightly_early={len(night_keys)}  overlap={len(both)}")
    print(f"only_shadow={len(only_sig)}  only_nightly={len(only_night)}")
    for k in sorted(only_sig)[:12]:
        print(f"  only_shadow: {k}")
    for k in sorted(only_night)[:12]:
        print(f"  only_nightly: {k}")


if __name__ == "__main__":
    main()
