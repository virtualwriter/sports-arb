#!/usr/bin/env python3
"""Preview which shapes the daemon backtest gate will enforce live."""

import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "analysis/shape-roi-jun16-jul3-continuous.json"
MIN_RESOLVED = int(sys.argv[2]) if len(sys.argv) > 2 else 8
EV_MARGIN = float(sys.argv[3]) if len(sys.argv) > 3 else 0.03

ALLOWED = {"SOCCER": {"match_total", "spread"}, "MLB": {"game_total", "spread"}}

rows = json.load(open(PATH))["rows"]
header = f'{"shape":<36}{"n":>5}{"mid%":>6}{"roi@w":>7}{"worstAvg":>9}{"evCap":>7}{"liveCap":>8}'
print(header)
print("-" * len(header))
live = []
for r in sorted(rows, key=lambda x: -x.get("worstRoiPct", -99)):
    if r["marketType"] not in ALLOWED.get(r["asset"], set()):
        continue
    if r["resolved"] < MIN_RESOLVED or r.get("worstRoiPct", -99) <= 0:
        continue
    evcap = (1 + r["middleRate"]) / (1 + EV_MARGIN)
    cap = min(r["worstAvgCost"], evcap)
    live.append(r)
    shape = f'{r["asset"]}:{r["marketType"]}:{r["lineFamily"]}'
    print(f'{shape:<36}{r["resolved"]:>5}{r["middleRate"]*100:>6.0f}{r["worstRoiPct"]:>7.1f}{r["worstAvgCost"]:>9.3f}{evcap:>7.3f}{cap:>8.3f}')

n_soccer = sum(1 for r in live if r["asset"] == "SOCCER")
n_mlb = sum(1 for r in live if r["asset"] == "MLB")
print(f"\ntotal enforced-live shapes: {len(live)} (SOCCER={n_soccer}, MLB={n_mlb})")
