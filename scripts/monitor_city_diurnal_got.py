#!/usr/bin/env python3
"""Standalone GOT diurnal shadow monitor — separate from active city monitors.

Follows the active city's weather tape (temps + NWP seeds on prediction rows)
and writes its own GOT tape. Does not touch live bins / book_aware.

Usage:
  PYTHONPATH=scripts python3 scripts/monitor_city_diurnal_got.py --city chicago
  PYTHONPATH=scripts python3 scripts/monitor_city_diurnal_got.py --city nyc --day 26AUG09

Output default:
  .tmp/{chi|city}-diurnal-got-{day}-monitor.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.diurnal_got import DiurnalGotTracker, sticky_bin_for_peak
from lib.weather_cities import get_city, list_cities
from lib.weather_hourly_hedge_filter import default_tape_path


def recv_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def default_got_tape_path(city_key: str, day: str) -> Path:
    city = get_city(city_key)
    day_lc = day.lower()
    if city.key == "chicago":
        return Path(f".tmp/chi-diurnal-got-{day_lc}-monitor.jsonl")
    return Path(f".tmp/{city.key}-diurnal-got-{day_lc}-monitor.jsonl")


def _parse_dt(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class GotFollower:
    """Replay/follow an active city tape into a GOT-only output tape."""

    def __init__(
        self,
        city_key: str,
        day: str,
        *,
        source_path: Path,
        out_path: Path,
        poll_s: float = 2.0,
        once: bool = False,
    ) -> None:
        self.city = get_city(city_key)
        self.day = day.upper()
        self.source_path = source_path
        self.out_path = out_path
        self.poll_s = poll_s
        self.once = once
        self.tz = ZoneInfo(self.city.local_tz)
        self.got = DiurnalGotTracker(
            lat=self.city.lat, lon=self.city.lon, local_tz=self.city.local_tz
        )
        self._offset = 0
        self._src_inode: int | None = None
        self._src_prefix: bytes | None = None
        self._prefix_n = 128
        self._seeded = False
        self._last_emit: dict | None = None
        self._held_bin: str | None = None
        self._last_daily_implied: dict = {}
        self._last_floor: float | None = None
        self._last_local: datetime | None = None
        self.out_path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, row: dict) -> None:
        with self.out_path.open("a") as f:
            f.write(json.dumps(row, default=str) + "\n")

    def _reset_tracker(self, *, why: str) -> None:
        """Full resync after source tape replace/truncate (rsync inode churn)."""
        self.got = DiurnalGotTracker(
            lat=self.city.lat, lon=self.city.lon, local_tz=self.city.local_tz
        )
        self._offset = 0
        self._src_prefix = None
        self._seeded = False
        self._last_emit = None
        self._held_bin = None
        self._last_daily_implied = {}
        self._last_floor = None
        self._last_local = None
        self.log(
            {
                "type": "source_rotated",
                "stream": "diurnal_got",
                "city": self.city.key,
                "day": self.day,
                "recv": recv_ts(),
                "why": why,
                "source_tape": str(self.source_path),
            }
        )

    def _should_emit(self, snap: dict) -> bool:
        if self._last_emit is None:
            return True
        return (
            self._last_emit.get("predicted_high_f") != snap.get("predicted_high_f")
            or self._last_emit.get("bin") != snap.get("bin")
            or self._last_emit.get("peak_method") != snap.get("peak_method")
            or self._last_emit.get("phase") != snap.get("phase")
        )

    def _emit(self, now_local: datetime, *, force: bool = False) -> None:
        if not self._seeded and self.got.params is None:
            return
        snap = self.got.snapshot(now_local, floor_f=self._last_floor)
        # Prefer continuous peak for the hold-band; fall back to rounded °F.
        peak_f = snap.get("predicted_peak_f")
        if peak_f is None:
            peak_f = snap.get("predicted_high_f")
        peak_i = snap.get("predicted_high_f")
        labels = list(self._last_daily_implied.keys())
        bin_label, bin_raw = sticky_bin_for_peak(
            float(peak_f) if peak_f is not None else None,
            labels,
            self._held_bin,
        )
        if bin_label is not None:
            self._held_bin = bin_label
        row = {
            "type": "prediction",
            "stream": "diurnal_got",
            "city": self.city.key,
            "day": self.day,
            "recv": recv_ts(),
            "predicted_high_f": peak_i,
            "bin": bin_label,
            "bin_raw": bin_raw,
            "floor_f": self._last_floor,
            "daily_implied": dict(self._last_daily_implied),
            "diurnal": snap,
            "peak_method": snap.get("peak_method"),
            "phase": snap.get("phase"),
            "source_tape": str(self.source_path),
        }
        if force or self._should_emit(row):
            self.log(row)
            self._last_emit = row

    def handle_row(self, r: dict) -> None:
        t = r.get("type")
        if t == "temp" or (t is None and r.get("source") and "temp_f" in r):
            src = r.get("source")
            if src not in ("synoptic_1m", "synoptic_station"):
                return
            dt = _parse_dt(r.get("obs_ts") or r.get("recv"))
            if dt is None:
                return
            tenths = r.get("tenths_f")
            if tenths is None:
                tenths = r.get("temp_f_precise")
            if tenths is None:
                tenths = r.get("temp_f")
            if tenths is None:
                return
            self.got.on_obs(dt, float(tenths))
            local = dt.astimezone(self.tz)
            self._last_local = local
            # Refresh call after obs when already seeded.
            if self._seeded:
                self._emit(local)
            return

        if t == "prediction" or (t is None and "predicted_high_f" in r):
            di = r.get("daily_implied")
            if isinstance(di, dict) and di:
                self._last_daily_implied = di
            if r.get("floor_f") is not None:
                try:
                    self._last_floor = float(r["floor_f"])
                except (TypeError, ValueError):
                    pass

            now = _parse_dt(r.get("recv")) or datetime.now(timezone.utc)
            local = now.astimezone(self.tz)
            self._last_local = local

            if r.get("forecast_peak_f") is not None:
                self.got.init_from_nwp(
                    now_local=local,
                    tmax_f=float(r["forecast_peak_f"]),
                    tmin_f=None,
                    tm_hour=float(r["forecast_peak_hour"])
                    if r.get("forecast_peak_hour") is not None
                    else None,
                )
                self._seeded = True

            if self._seeded:
                self._emit(local)

    def catch_up(self) -> None:
        if not self.source_path.exists():
            return
        st = self.source_path.stat()
        inode = int(getattr(st, "st_ino", 0) or 0)
        size = int(st.st_size)
        with self.source_path.open("rb") as bf:
            prefix = bf.read(min(self._prefix_n, size))
        rotated = False
        why = ""
        if self._src_inode is not None and inode != self._src_inode:
            rotated = True
            why = f"inode {self._src_inode}->{inode}"
        elif size < self._offset:
            rotated = True
            why = f"truncate size={size} offset={self._offset}"
        elif self._src_prefix is not None and prefix != self._src_prefix:
            # In-place rewrite (rsync/write) keeps inode but changes the head.
            rotated = True
            why = "prefix_changed"
        if rotated:
            self._reset_tracker(why=why)
        self._src_inode = inode
        if self._src_prefix is None:
            self._src_prefix = prefix
        with self.source_path.open() as f:
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
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self.handle_row(r)

    def run(self) -> None:
        self.log(
            {
                "type": "monitor_start",
                "stream": "diurnal_got",
                "city": self.city.key,
                "day": self.day,
                "recv": recv_ts(),
                "source_tape": str(self.source_path),
                "out": str(self.out_path),
            }
        )
        self.catch_up()
        if self.once:
            # Final snapshot at last tape time (not wall clock — avoids day-reset).
            if self._last_local is not None:
                self._emit(self._last_local, force=True)
            return
        while True:
            if self.source_path.exists():
                self.catch_up()
            time.sleep(self.poll_s)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--city", required=True, choices=list_cities())
    ap.add_argument("--day", help="YYMONDD (default: city's local today)")
    ap.add_argument("--source", help="Active city tape to follow")
    ap.add_argument("--out", help="GOT output tape path")
    ap.add_argument("--poll", type=float, default=2.0)
    ap.add_argument(
        "--once",
        action="store_true",
        help="Catch up source tape once and exit (offline replay)",
    )
    args = ap.parse_args()

    city = get_city(args.city)
    if args.day:
        day = args.day.upper()
    else:
        now = datetime.now(ZoneInfo(city.local_tz))
        months = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
        day = f"{str(now.year)[2:]}{months[now.month - 1]}{now.day:02d}"

    source = Path(args.source) if args.source else default_tape_path(args.city, day)
    out = Path(args.out) if args.out else default_got_tape_path(args.city, day)
    GotFollower(
        args.city,
        day,
        source_path=source,
        out_path=out,
        poll_s=args.poll,
        once=args.once,
    ).run()


if __name__ == "__main__":
    main()
