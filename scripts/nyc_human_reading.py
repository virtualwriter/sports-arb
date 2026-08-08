#!/usr/bin/env python3
"""Append an on-site KNYC human temperature reading for the NYC monitor.

NYC-only. Optional. If you never run this, the NYC monitor keeps working on
Synoptic/METAR/NWS/TWC alone. When you do append readings, they are treated as
trusted floor updates (source=human_knyc), same as other obs feeds.

Usage:
  PYTHONPATH=scripts python3 scripts/nyc_human_reading.py 87.2
  PYTHONPATH=scripts python3 scripts/nyc_human_reading.py 87.2 --note "handheld at ASOS"
  npm run weather:nyc-human -- 87.2 --note "spot check"

Writes to .tmp/nyc-human-knyc-readings.jsonl (or NYC_HUMAN_SENSOR_PATH).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.nyc_human_sensor import append_reading, readings_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("temp_f", type=float, help="Observed temperature °F (e.g. 87.2)")
    ap.add_argument("--tenths", type=float, default=None, help="Override precise °F")
    ap.add_argument("--note", default="", help="Free-text context")
    ap.add_argument("--obs-ts", default=None, help="Observation timestamp ISO")
    ap.add_argument("--path", default=None, help="Override readings jsonl path")
    args = ap.parse_args()

    path = Path(args.path) if args.path else None
    row = append_reading(
        args.temp_f,
        tenths_f=args.tenths,
        note=args.note,
        obs_ts=args.obs_ts,
        path=path,
    )
    print(json.dumps({"ok": True, "path": str(path or readings_path()), "row": row}, indent=2))


if __name__ == "__main__":
    main()
