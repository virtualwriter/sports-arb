"""Durable Chicago daily-high predictor accuracy ledger.

Tracks each Kalshi day stamp's opening prediction, material prediction path,
final pre-settle call, and NWS/Kalshi settlement for hit-rate analysis.

Ledger file (repo-relative): analysis/chi-high-predictor-ledger.json
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

LOCAL_TZ = "America/Chicago"
ANALYSIS_DIR = Path(__file__).resolve().parents[2] / "analysis"
DEFAULT_LEDGER = ANALYSIS_DIR / "chi-high-predictor-ledger.json"


def ledger_path_for_city(city_key: str) -> Path:
    key = (city_key or "chicago").strip().lower()
    if key in ("chicago", "chi"):
        return DEFAULT_LEDGER  # preserve existing CHI ledger path
    return ANALYSIS_DIR / f"{key}-high-predictor-ledger.json"

MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}
DAY_RE = re.compile(r"^(\d{2})([A-Z]{3})(\d{2})$")


def day_to_local_date(day: str) -> str | None:
    m = DAY_RE.match(day.upper())
    if not m:
        return None
    yy, mon, dd = m.group(1), m.group(2), m.group(3)
    month = MONTHS.get(mon)
    if month is None:
        return None
    return f"20{yy}-{month:02d}-{int(dd):02d}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _pred_snapshot(pred: dict) -> dict[str, Any]:
    keys = (
        "recv",
        "predicted_high_f",
        "bin",
        "bin_book_aware",
        "book_aware_notes",
        "floor_f",
        "forecast_peak_f",
        "forecast_peak_hour",
        "phase",
        "synoptic_slope_f_per_hr",
        "daily_implied",
        "hourly_implied",
        "twc_high_f",
        "twc_unconfirmed_high_f",
        "rationale",
        "is_edge",
        "diurnal",
    )
    out = {k: pred.get(k) for k in keys if k in pred or k in (
        "predicted_high_f", "bin", "bin_book_aware", "floor_f", "phase",
        "forecast_peak_f", "forecast_peak_hour",
    )}
    if not out.get("recv"):
        out["recv"] = _now_iso()
    return out


def _path_key(snap: dict) -> tuple:
    d = snap.get("diurnal") or {}
    return (
        snap.get("bin"),
        snap.get("bin_book_aware"),
        snap.get("predicted_high_f"),
        snap.get("floor_f"),
        snap.get("phase"),
        snap.get("forecast_peak_f"),
        d.get("predicted_high_f"),
        d.get("predicted_peak_hour"),
    )


def settle_high_from_daily_result(daily_result: dict | None) -> tuple[int | None, str | None]:
    """Return (settle_high_f, settle_bin_label) from Kalshi daily_result blob."""
    if not daily_result:
        return None, None
    exp = daily_result.get("expiration_value")
    high: int | None = None
    if exp not in (None, ""):
        try:
            high = int(round(float(exp)))
        except (TypeError, ValueError):
            high = None
    results = daily_result.get("results") or {}
    # Winning YES ticker suffix is often like B85.5 / T85 — best-effort label.
    yes_labels = [k for k, v in results.items() if str(v).lower() == "yes"]
    bin_label = yes_labels[0] if len(yes_labels) == 1 else None
    return high, bin_label


def _score(pred_bin: str | None, pred_f: int | None, settle_f: int | None, settle_bin: str | None) -> dict:
    out: dict[str, Any] = {
        "bin_hit": None,
        "abs_err_f": None,
        "settle_f": settle_f,
        "settle_bin": settle_bin,
    }
    if settle_f is not None and pred_f is not None:
        out["abs_err_f"] = abs(int(pred_f) - int(settle_f))
    if pred_bin and settle_bin and pred_bin == settle_bin:
        out["bin_hit"] = True
    elif pred_bin and settle_f is not None:
        # Infer hit from even-pair style "85-86" / "<=78" / ">=87" when Kalshi
        # only gave a numeric expiration.
        out["bin_hit"] = _bin_contains(pred_bin, int(settle_f))
    elif pred_bin and settle_bin:
        out["bin_hit"] = False
    return out


def _bin_contains(bin_label: str, temp_f: int) -> bool | None:
    label = bin_label.strip()
    m = re.match(r"^(\d+)-(\d+)$", label)
    if m:
        return int(m.group(1)) <= temp_f <= int(m.group(2))
    m = re.match(r"^<=(\d+)$", label)
    if m:
        return temp_f <= int(m.group(1))
    m = re.match(r"^>=(\d+)$", label)
    if m:
        return temp_f >= int(m.group(1))
    return None


class AccuracyLedger:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path else DEFAULT_LEDGER

    def load(self) -> dict:
        if not self.path.exists():
            return {"version": 1, "updated": None, "days": {}}
        with self.path.open() as f:
            data = json.load(f)
        if "days" not in data:
            data = {"version": 1, "updated": None, "days": data}
        return data

    def save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data["updated"] = _now_iso()
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w") as f:
            json.dump(data, f, indent=2, sort_keys=False)
            f.write("\n")
        tmp.replace(self.path)

    def _day_row(self, data: dict, day: str) -> dict:
        days = data.setdefault("days", {})
        row = days.get(day)
        if row is None:
            row = {
                "day": day,
                "local_date": day_to_local_date(day),
                "open": None,
                "final_pred": None,
                "pred_path": [],
                "settlement": None,
                "scores": {},
            }
            days[day] = row
        return row

    def record_prediction(self, day: str, pred: dict, *, opening: bool = False) -> dict:
        """Upsert prediction. First snapshot of the day is kept as open (never overwritten)."""
        data = self.load()
        row = self._day_row(data, day)
        snap = _pred_snapshot(pred)
        # Preserve the true morning open across mid-day restarts.
        if row.get("open") is None:
            row["open"] = snap
        row["final_pred"] = snap
        path = row.setdefault("pred_path", [])
        if not path or _path_key(path[-1]) != _path_key(snap):
            path.append(snap)
            # Cap path length so restarts don't blow the file.
            if len(path) > 64:
                row["pred_path"] = path[-64:]
        self._recompute_scores(row)
        self.save(data)
        return row

    def record_settlement(
        self,
        day: str,
        *,
        high_f: int | None,
        bin_label: str | None = None,
        source: str = "kalshi",
        raw: dict | None = None,
        recv: str | None = None,
    ) -> dict:
        data = self.load()
        row = self._day_row(data, day)
        row["settlement"] = {
            "recv": recv or _now_iso(),
            "high_f": high_f,
            "bin": bin_label,
            "source": source,
            "raw": raw or {},
        }
        self._recompute_scores(row)
        self.save(data)
        return row

    def record_daily_result(self, day: str, daily_result: dict, *, recv: str | None = None) -> dict:
        high, bin_label = settle_high_from_daily_result(daily_result)
        return self.record_settlement(
            day,
            high_f=high,
            bin_label=bin_label,
            source="kalshi_expiration_value",
            raw=daily_result,
            recv=recv,
        )

    def _recompute_scores(self, row: dict) -> None:
        settle = row.get("settlement") or {}
        settle_f = settle.get("high_f")
        settle_bin = settle.get("bin")
        open_p = row.get("open") or {}
        final_p = row.get("final_pred") or {}
        row["scores"] = {
            "open": _score(open_p.get("bin"), open_p.get("predicted_high_f"), settle_f, settle_bin),
            "final": _score(final_p.get("bin"), final_p.get("predicted_high_f"), settle_f, settle_bin),
        }

    def summary_rows(self) -> list[dict]:
        data = self.load()
        rows = []
        for day, row in sorted(data.get("days", {}).items(), key=lambda kv: kv[1].get("local_date") or kv[0]):
            open_p = row.get("open") or {}
            final_p = row.get("final_pred") or {}
            settle = row.get("settlement") or {}
            scores = row.get("scores") or {}
            rows.append({
                "day": day,
                "local_date": row.get("local_date"),
                "open_bin": open_p.get("bin"),
                "open_pred": open_p.get("predicted_high_f"),
                "final_bin": final_p.get("bin"),
                "final_pred": final_p.get("predicted_high_f"),
                "settle_f": settle.get("high_f"),
                "settle_bin": settle.get("bin"),
                "open_hit": (scores.get("open") or {}).get("bin_hit"),
                "final_hit": (scores.get("final") or {}).get("bin_hit"),
                "open_err": (scores.get("open") or {}).get("abs_err_f"),
                "final_err": (scores.get("final") or {}).get("abs_err_f"),
            })
        return rows
