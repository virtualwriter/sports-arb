"""Optional on-site KNYC human sensor feed (NYC monitor only).

Contract
--------
- NYC-only. Other cities ignore this module.
- Readings are **optional extra data points**. If none are provided, the NYC
  monitor continues unchanged on Synoptic/METAR/NWS/TWC.
- When present, each reading does two things in the predictor:
  1. **Floor** — trusted obs (`human_knyc` ∈ FLOOR_TRUSTED_SOURCES); a hotter
     print raises the day-high floor like Synoptic/METAR.
  2. **Ceiling** — human-only high-water mark. During NYC `peak_hour` /
     `post_peak`, if the latest human reading is fresh (~25 min), the
     predictor caps at `human_high_f` so NWP/hourly books cannot stay on
     89–90 when courtside never printed above e.g. 87. Pre-peak does not
     hard-cap (morning spot checks must not kill an afternoon ramp).
- Absence of the file, or an empty file, is a no-op (not an error).

Append format (one JSON object per line), written by
`scripts/nyc_human_reading.py` or any producer:

  {
    "temp_f": 87,                 # required (int or float; used for floor/ceiling)
    "tenths_f": 87.2,             # optional precise °F
    "obs_ts": "2026-08-08T16:05:00-04:00",  # optional; default = now UTC
    "note": "peak check; never hit 89",
    "kind": "ceiling_check",      # optional analytics tag
    "source": "human_knyc"        # optional; forced to human_knyc on ingest
  }

Default path (override with NYC_HUMAN_SENSOR_PATH):
  .tmp/nyc-human-knyc-readings.jsonl
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SOURCE = "human_knyc"
DEFAULT_PATH = Path(".tmp/nyc-human-knyc-readings.jsonl")


def readings_path() -> Path:
    env = (os.environ.get("NYC_HUMAN_SENSOR_PATH") or "").strip()
    return Path(env) if env else DEFAULT_PATH


def _f(x: Any) -> float | None:
    if x is None:
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def normalize_reading(row: dict[str, Any]) -> dict[str, Any] | None:
    """Convert a raw JSONL row into a monitor observation dict, or None if invalid."""
    tenths = _f(row.get("tenths_f"))
    temp = _f(row.get("temp_f"))
    if tenths is None and temp is None:
        return None
    if tenths is None:
        tenths = temp
    assert tenths is not None
    rounded = int(round(temp if temp is not None else tenths))
    obs_ts = row.get("obs_ts") or row.get("recv") or datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    )
    out = {
        "source": SOURCE,
        "obs_ts": obs_ts,
        "temp_f": rounded,
        "temp_f_precise": tenths,
        "tenths_f": tenths,
        "note": row.get("note") or row.get("comment") or "",
        "tgroup": {"temp_f_round": rounded, "temp_f": tenths},
        "human": True,
    }
    kind = row.get("kind")
    if kind:
        out["kind"] = str(kind)
    return out


class NycHumanSensorCursor:
    """Tail the human readings file; return only newly appended valid rows."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or readings_path()
        self._offset = 0
        self._inode: int | None = None

    def poll_new(self) -> list[dict[str, Any]]:
        path = self.path
        if not path.exists():
            return []
        try:
            st = path.stat()
        except OSError:
            return []
        inode = getattr(st, "st_ino", None)
        if self._inode is not None and inode != self._inode:
            # File replaced/truncated — reread from start.
            self._offset = 0
        self._inode = inode
        if st.st_size < self._offset:
            self._offset = 0

        out: list[dict[str, Any]] = []
        try:
            with path.open("r") as f:
                f.seek(self._offset)
                while True:
                    line = f.readline()
                    if not line:
                        break
                    self._offset = f.tell()
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(row, dict):
                        continue
                    ob = normalize_reading(row)
                    if ob:
                        out.append(ob)
        except OSError:
            return []
        return out


def poll_nyc_human_sensor(cursor: NycHumanSensorCursor) -> dict[str, Any] | None:
    """Return the newest newly-appended reading, or None if no new human data."""
    new = cursor.poll_new()
    if not new:
        return None
    return new[-1]


def append_reading(
    temp_f: float,
    *,
    tenths_f: float | None = None,
    note: str = "",
    obs_ts: str | None = None,
    kind: str | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    """Append one human reading to the NYC sensor file. Returns the written row."""
    p = path or readings_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    row: dict[str, Any] = {
        "recv": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "obs_ts": obs_ts or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "temp_f": float(temp_f),
        "tenths_f": float(tenths_f) if tenths_f is not None else float(temp_f),
        "note": note,
        "source": SOURCE,
    }
    if kind:
        row["kind"] = str(kind)
    with p.open("a") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")
    return row
