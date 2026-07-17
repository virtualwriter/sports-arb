#!/usr/bin/env python3
"""Build the PA-chain transition kernel artifact for the live/paper MLB fair.

Source: analysis/per-plate-rbi-p-pa-rows.jsonl (cached StatsAPI plate
appearances, written by compare_pa_rbi_vs_strat2.py). Train window is the
2024 regular season — the same train split that beat the Strat2 Poisson on
2025 hold-out in analysis/per-plate-rbi-p-apples-to-apples.md.

Output: analysis/pa-chain-transitions-2024.json
  { meta, transitions: { "<outs>|<bases>": [[rbi, outsAfter, basesAfter, count], ...] } }

The TS consumer (scripts/lib/mlb-pa-chain.ts) Monte-Carlos remaining innings
with this kernel to price total/spread middle bands.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROWS = ROOT / "analysis" / "per-plate-rbi-p-pa-rows.jsonl"
OUT = ROOT / "analysis" / "pa-chain-transitions-2024.json"

TRAIN_YEAR = 2024


def main() -> None:
    counts: dict[str, dict[tuple[int, int, str], int]] = defaultdict(lambda: defaultdict(int))
    pas = 0
    dates: list[str] = []
    with ROWS.open() as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("year") != TRAIN_YEAR:
                continue
            key = f"{int(r['outs'])}|{r['bases']}"
            outcome = (int(r["rbi"]), min(int(r["outsAfter"]), 3), str(r["basesAfter"]))
            counts[key][outcome] += 1
            pas += 1
            d = r.get("date")
            if d:
                dates.append(d)

    transitions = {
        key: sorted([[rbi, oa, ba, n] for (rbi, oa, ba), n in outs.items()])
        for key, outs in sorted(counts.items())
    }
    meta = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trainYear": TRAIN_YEAR,
        "trainStart": min(dates) if dates else None,
        "trainEnd": max(dates) if dates else None,
        "plateAppearances": pas,
        "cells": len(transitions),
        "source": str(ROWS.relative_to(ROOT)),
        "validation": "analysis/per-plate-rbi-p-apples-to-apples.md (PA-chain beat Strat2 Poisson on all 7 bands, 2025 hold-out)",
    }
    OUT.write_text(json.dumps({"meta": meta, "transitions": transitions}, indent=1))
    print(f"wrote {OUT} pas={pas} cells={len(transitions)}")


if __name__ == "__main__":
    main()
