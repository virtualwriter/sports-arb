"""Model-roll P&L + live book-aware bin filter for daily-high weather monitors.

Roll strategy (research — not live order routing):
  - Put $DAILY_STAKE into open.bin @ *same-row* mid (≥ MIN_BUY_MID).
  - On each model bin change: sell @ mid (same-row or last-known), buy @ same-row mid.
  - Never walk back for buys (stale mids invented fake dust fills).
  - Settle final held bin vs official/provisional high.

Dual streams (live monitor + report):
  - raw: predictor bin
  - book_aware / bin_book_aware: anti_thrash + sticky book_lead over the raw path
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from lib.weather_cities import get_city

DAILY_STAKE = 1000.0
MIN_BUY_MID = 0.05  # ignore dust bins; sub-nickel mids invent fake leverage
ANTI_THRASH_MIN_MID = 0.55
BOOK_LEAD_MIN_MID = 0.50
BOOK_LEAD_EDGE = 0.10

RollMode = Literal["model", "anti_thrash", "book_lead", "book_aware"]

# Used only to infer provisional settle when Kalshi DAILY_SETTLED is absent.
FLOOR_TRUSTED = frozenset({
    "synoptic_1m",
    "synoptic_station",
    "synoptic_1m_backfill",
    "synoptic_backfill",
    "nws_5min",
    "awc_metar",
    "awc_metar_backfill",
    "noaa_tgftp",
    "synoptic_metar",
    "human_knyc",
})

BIN_RANGE_RE = re.compile(r"(\d+)\s*-\s*(\d+)")


def _f(x: Any) -> float | None:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v


def market_fav(daily_implied: dict[str, Any] | None) -> tuple[str | None, float | None]:
    if not daily_implied:
        return None, None
    best_k, best_v = None, None
    for k, v in daily_implied.items():
        fv = _f(v)
        if fv is None:
            continue
        if best_v is None or fv > best_v:
            best_k, best_v = k, fv
    return best_k, best_v


def bin_hi(label: str | None) -> int | None:
    if not label:
        return None
    m = BIN_RANGE_RE.fullmatch(label.strip())
    if m:
        return int(m.group(2))
    if label.startswith("<="):
        try:
            return int(label[2:])
        except ValueError:
            return None
    if label.startswith(">="):
        try:
            return int(label[2:])
        except ValueError:
            return None
    if label.endswith("+"):
        try:
            return int(label[:-1])
        except ValueError:
            return None
    return None


def bin_lo(label: str | None) -> int | None:
    if not label:
        return None
    m = BIN_RANGE_RE.fullmatch(label.strip())
    if m:
        return int(m.group(1))
    if label.startswith("<="):
        return -999
    if label.startswith(">="):
        try:
            return int(label[2:])
        except ValueError:
            return None
    if label.endswith("+"):
        try:
            return int(label[:-1])
        except ValueError:
            return None
    return None


def bin_contains(label: str, temp_f: float) -> bool:
    lo, hi = bin_lo(label), bin_hi(label)
    if lo is None or hi is None:
        return False
    t = int(round(temp_f))
    if lo == -999:
        return t <= hi
    if label.startswith(">=") or label.endswith("+"):
        return t >= lo
    return lo <= t <= hi


@dataclass
class LegResult:
    name: str
    action: str
    detail: str
    entry: float | None
    stake_or_face: float
    won: bool | None
    pnl: float
    recv: str | None = None


@dataclass
class PolicyRoll:
    mode: RollMode
    pnl: float
    path: list[str] = field(default_factory=list)
    switches: int = 0
    held: str | None = None
    open_entry: float | None = None
    won: bool | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class CityFilterResult:
    """Roll result for one city/day. filter_* / baseline_* = raw model roll."""

    city: str
    day: str
    open_bin: str | None
    fav_bin: str | None
    daily_leg_bin: str | None  # final held bin after raw model roll
    settle_f: float | None
    baseline_pnl: float
    filter_pnl: float
    baseline_path: list[str] = field(default_factory=list)
    baseline_switches: int = 0
    legs: list[LegResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    policies: dict[str, PolicyRoll] = field(default_factory=dict)
    open_bin_aware: str | None = None
    aware_held: str | None = None
    aware_pnl: float = 0.0
    aware_path: list[str] = field(default_factory=list)
    aware_switches: int = 0

    @property
    def delta(self) -> float:
        return self.aware_pnl - self.baseline_pnl

    @property
    def pnl(self) -> float:
        return self.baseline_pnl


def _same_row_mid(di: dict[str, Any] | None, bin_label: str | None) -> float | None:
    """Mid from this prediction row only — never a stale walk-back."""
    if not di or not bin_label:
        return None
    px = _f(di.get(bin_label))
    if px is not None and px > 0:
        return px
    return None


def _sell_mid(
    preds: list[dict],
    bin_label: str,
    recv: str,
    di: dict[str, Any] | None = None,
) -> float | None:
    """Sell mark: prefer same-row mid; allow last-known if the held bin fell off the book."""
    px = _same_row_mid(di, bin_label)
    if px is not None:
        return px
    for rr in reversed(preds):
        if (rr.get("recv") or "") > recv:
            continue
        px = _f((rr.get("daily_implied") or {}).get(bin_label))
        if px is not None and px > 0:
            return px
    return None


@dataclass
class BookAwareBinTracker:
    """Live dual-stream filter: raw model bin + thrash/fat-book overlays.

    - book_lead: on fav flip, if fav mid ≥ BOOK_LEAD_MIN_MID and leads held by
      ≥ BOOK_LEAD_EDGE on *this row*, publish fav and stick until fav moves on.
    - anti_thrash: while published bin is still fav @ ≥ ANTI_THRASH_MIN_MID on
      this row, ignore raw model leaves.
    """

    held: str | None = None
    sticky_fav: bool = False
    prev_raw: str | None = None
    prev_fav: str | None = None
    anti_thrash_min_mid: float = ANTI_THRASH_MIN_MID
    book_lead_min_mid: float = BOOK_LEAD_MIN_MID
    book_lead_edge: float = BOOK_LEAD_EDGE

    def update(
        self,
        raw_bin: str | None,
        daily_implied: dict[str, Any] | None,
    ) -> tuple[str | None, list[str]]:
        notes: list[str] = []
        di = daily_implied or {}
        fav, fav_px = market_fav(di)

        if self.held is None:
            self.held = raw_bin
            self.prev_raw = raw_bin
            self.prev_fav = fav
            if raw_bin:
                notes.append(f"open raw {raw_bin}")
            return self.held, notes

        if fav and fav != self.prev_fav:
            held_px = _same_row_mid(di, self.held)
            decisive = (
                fav_px is not None
                and fav_px >= self.book_lead_min_mid
                and fav != self.held
                and (held_px is None or fav_px >= held_px + self.book_lead_edge)
            )
            if decisive:
                self.held = fav
                self.sticky_fav = True
                notes.append(f"book_lead → {fav} @{fav_px:.0%}")
            elif self.sticky_fav and fav != self.held:
                self.sticky_fav = False
                notes.append(f"book_lead unstick (fav now {fav})")
            self.prev_fav = fav

        if raw_bin and raw_bin != self.prev_raw:
            if self.sticky_fav:
                notes.append(f"book_lead sticky: ignore raw → {raw_bin}")
            else:
                held_px = _same_row_mid(di, self.held)
                if (
                    fav == self.held
                    and held_px is not None
                    and held_px >= self.anti_thrash_min_mid
                    and raw_bin != self.held
                ):
                    notes.append(
                        f"anti_thrash: ignore raw → {raw_bin} "
                        f"(held {self.held} still fav @{held_px:.0%})"
                    )
                else:
                    self.held = raw_bin
                    notes.append(f"follow raw → {raw_bin}")
            self.prev_raw = raw_bin

        return self.held, notes


def apply_book_aware_bins(preds: list[dict]) -> list[dict]:
    """Return prediction copies with bin_book_aware from BookAwareBinTracker.

    Always recomputed from raw bin + daily_implied so historical tapes (pre-dual
    stream) and live tapes score the same way.
    """
    tracker = BookAwareBinTracker()
    out: list[dict] = []
    for r in preds:
        row = dict(r)
        aware, notes = tracker.update(row.get("bin"), row.get("daily_implied") or {})
        row["bin_book_aware"] = aware
        if notes:
            row["book_aware_notes"] = notes
        out.append(row)
    return out


def preds_as_bin_stream(preds: list[dict], bin_key: str = "bin") -> list[dict]:
    """Projection: use bin_key as the roll's model bin."""
    out: list[dict] = []
    for r in preds:
        row = dict(r)
        b = row.get(bin_key) or row.get("bin")
        row["bin"] = b
        out.append(row)
    return out


def simulate_model_roll(
    preds: list[dict],
    settle_f: float | None,
    stake: float = DAILY_STAKE,
) -> tuple[float, list[str], int, list[str], str | None, float | None, bool | None]:
    """Open on first bin; switch capital on each model bin update; settle held bin."""
    pol = simulate_roll_policy(preds, settle_f, mode="model", stake=stake)
    return (
        pol.pnl,
        pol.path,
        pol.switches,
        pol.notes,
        pol.held,
        pol.open_entry,
        pol.won,
    )


def simulate_roll_policy(
    preds: list[dict],
    settle_f: float | None,
    *,
    mode: RollMode = "model",
    stake: float = DAILY_STAKE,
    anti_thrash_min_mid: float = ANTI_THRASH_MIN_MID,
    book_lead_min_mid: float = BOOK_LEAD_MIN_MID,
    book_lead_edge: float = BOOK_LEAD_EDGE,
    min_buy_mid: float = MIN_BUY_MID,
) -> PolicyRoll:
    """Simulate model roll and optional book-aware overlays.

    Modes
    -----
    model: plain model-bin roll
    anti_thrash: ignore model leaves while held is still fav @ ≥ anti_thrash_min_mid
    book_lead: sticky switch onto decisive fav flips; ignore model while sticky
    book_aware: anti_thrash + book_lead

    Buys require a *same-row* mid ≥ min_buy_mid (no stale walk-back).
    """
    notes: list[str] = []
    if not preds:
        return PolicyRoll(mode=mode, pnl=0.0, notes=["roll: no preds"])

    use_anti = mode in ("anti_thrash", "book_aware")
    use_lead = mode in ("book_lead", "book_aware")

    held: str | None = None
    contracts = 0.0
    path: list[str] = []
    switches = 0
    open_entry: float | None = None
    sticky_fav = False
    prev_model: str | None = None
    prev_fav: str | None = None

    def try_switch(new_bin: str, di: dict[str, Any], recv: str, why: str) -> bool:
        nonlocal held, contracts, switches, open_entry, sticky_fav
        if not new_bin or new_bin == held:
            return False
        # Buys: same-row mid only (stale walk-back invented the NYC ≤88 dust fill).
        buy_px = _same_row_mid(di, new_bin)
        if buy_px is None or buy_px < min_buy_mid:
            notes.append(
                f"{why}: skip → {new_bin} "
                f"({'dust' if buy_px is not None else 'no same-row mid'}"
                f"{f' @{buy_px:.0%}' if buy_px is not None else ''})"
            )
            return False
        if held is None:
            contracts = stake / buy_px
            held = new_bin
            open_entry = buy_px
            path.append(new_bin)
            notes.append(f"{why}: open {new_bin} @{buy_px:.0%}")
            return True
        sell_px = _sell_mid(preds, held, recv, di)
        if sell_px is None or sell_px <= 0:
            notes.append(f"{why}: skip → {new_bin} (no sell px for {held})")
            return False
        contracts = (contracts * sell_px) / buy_px
        held = new_bin
        path.append(new_bin)
        switches += 1
        notes.append(f"{why}: → {new_bin} buy@{buy_px:.0%} sell@{sell_px:.0%}")
        return True

    for i, r in enumerate(preds):
        di = r.get("daily_implied") or {}
        b = r.get("bin")
        recv = r.get("recv") or ""
        fav, fav_px = market_fav(di)

        if i == 0:
            if b:
                try_switch(b, di, recv, "open")
            prev_model = b
            prev_fav = fav
            continue

        # --- sticky book-lead on fav flip ---
        if use_lead and fav and fav != prev_fav:
            held_px = _same_row_mid(di, held) if held else None
            decisive = (
                fav_px is not None
                and fav_px >= book_lead_min_mid
                and fav != held
                and (held_px is None or fav_px >= held_px + book_lead_edge)
            )
            if decisive:
                if try_switch(fav, di, recv, "book_lead"):
                    sticky_fav = True
            elif sticky_fav and fav != held:
                sticky_fav = False
                notes.append(f"book_lead: unstick (fav now {fav})")
            prev_fav = fav

        # --- model bin change ---
        if b and b != prev_model:
            if sticky_fav and use_lead:
                notes.append(f"book_lead sticky: ignore model → {b}")
            elif (
                use_anti
                and held is not None
                and fav == held
            ):
                held_px = _same_row_mid(di, held)
                if held_px is not None and held_px >= anti_thrash_min_mid and b != held:
                    notes.append(
                        f"anti_thrash: ignore model → {b} (held {held} still fav @{held_px:.0%})"
                    )
                else:
                    try_switch(b, di, recv, "model")
                    sticky_fav = False
            else:
                try_switch(b, di, recv, "model")
                if use_lead:
                    sticky_fav = False
            prev_model = b

    if held is None or settle_f is None:
        notes.append("roll: unresolved (no held bin or settle)")
        return PolicyRoll(
            mode=mode,
            pnl=0.0,
            path=path,
            switches=switches,
            held=held,
            open_entry=open_entry,
            won=None,
            notes=notes,
        )

    won = bin_contains(held, settle_f)
    pnl = contracts * (1.0 if won else 0.0) - stake
    return PolicyRoll(
        mode=mode,
        pnl=pnl,
        path=path,
        switches=switches,
        held=held,
        open_entry=open_entry,
        won=won,
        notes=notes,
    )


def _parse_tape(path: Path) -> dict[str, Any]:
    preds: list[dict] = []
    temps: list[dict] = []
    summaries: list[dict] = []
    daily_settle: dict | None = None
    day = None
    with path.open() as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = r.get("type")
            msg = r.get("msg")
            if t == "milestone" and msg == "MONITOR_START" and day is None:
                day = r.get("day")
            if t == "prediction" and r.get("bin"):
                preds.append(r)
            if t == "temp":
                temps.append(r)
            if t == "summary":
                summaries.append(r)
            if t == "milestone" and msg == "DAILY_SETTLED":
                daily_settle = r
            if t == "milestone" and msg == "HOURLY_SETTLED":
                summaries.append({**r, "type": "hourly_settled"})
    return {
        "day": day,
        "preds": preds,
        "temps": temps,
        "summaries": summaries,
        "daily_settle": daily_settle,
    }


def _settle_temp_f(tape: dict[str, Any], preds: list[dict]) -> float | None:
    ds = tape.get("daily_settle")
    if ds and ds.get("expiration_value") is not None:
        return _f(ds["expiration_value"])
    # Provisional: max trusted feed tenths/temp (matches prior research scorer).
    best = None
    for r in tape.get("temps") or []:
        if r.get("source") not in FLOOR_TRUSTED:
            continue
        tenths = _f(r.get("tenths_f"))
        tf = _f(r.get("temp_f"))
        score = tenths if tenths is not None else tf
        if score is None:
            continue
        if best is None or score > best:
            best = score
    if best is not None:
        return best
    if preds:
        return _f(preds[-1].get("floor_f") or preds[-1].get("predicted_high_f"))
    return None


def evaluate_city_day(
    city_key: str,
    tape_path: Path,
    *,
    daily_stake: float = DAILY_STAKE,
) -> CityFilterResult | None:
    city = get_city(city_key)
    if not tape_path.exists():
        return None
    tape = _parse_tape(tape_path)
    preds: list[dict] = tape["preds"]
    if not preds:
        return None
    day = tape["day"] or "unknown"
    open_p = preds[0]
    open_bin = open_p.get("bin")
    di = open_p.get("daily_implied") or {}
    fav, _fav_px = market_fav(di)
    settle_f = _settle_temp_f(tape, preds)

    # Dual streams: raw model bin vs live/recomputed book-aware bin.
    enriched = apply_book_aware_bins(preds)
    raw_roll = simulate_roll_policy(
        preds_as_bin_stream(enriched, "bin"), settle_f, mode="model", stake=daily_stake
    )
    aware_roll = simulate_roll_policy(
        preds_as_bin_stream(enriched, "bin_book_aware"),
        settle_f,
        mode="model",
        stake=daily_stake,
    )

    # Also keep policy overlays on the raw stream for research.
    policies: dict[str, PolicyRoll] = {
        "model": raw_roll,
        "book_aware_stream": aware_roll,
    }
    for mode in ("anti_thrash", "book_lead", "book_aware"):
        policies[mode] = simulate_roll_policy(
            preds, settle_f, mode=mode, stake=daily_stake
        )

    notes = [
        f"raw: {' → '.join(raw_roll.path) if raw_roll.path else '—'} "
        f"({raw_roll.switches} sw) pnl={raw_roll.pnl:+.0f}",
        f"aware: {' → '.join(aware_roll.path) if aware_roll.path else '—'} "
        f"({aware_roll.switches} sw) pnl={aware_roll.pnl:+.0f}",
    ]
    for m in ("anti_thrash", "book_lead", "book_aware"):
        p = policies[m]
        notes.append(
            f"{m}: {' → '.join(p.path) if p.path else '—'} "
            f"({p.switches} sw) pnl={p.pnl:+.0f}"
        )

    legs: list[LegResult] = []
    if raw_roll.held is not None and settle_f is not None:
        legs.append(
            LegResult(
                name="model_roll_raw",
                action="ROLL",
                detail=" → ".join(raw_roll.path) if raw_roll.path else raw_roll.held,
                entry=raw_roll.open_entry,
                stake_or_face=daily_stake,
                won=raw_roll.won,
                pnl=raw_roll.pnl,
                recv=open_p.get("recv"),
            )
        )
    if aware_roll.held is not None and settle_f is not None:
        legs.append(
            LegResult(
                name="model_roll_aware",
                action="ROLL",
                detail=" → ".join(aware_roll.path) if aware_roll.path else aware_roll.held,
                entry=aware_roll.open_entry,
                stake_or_face=daily_stake,
                won=aware_roll.won,
                pnl=aware_roll.pnl,
                recv=open_p.get("recv"),
            )
        )

    return CityFilterResult(
        city=city.key,
        day=day,
        open_bin=open_bin,
        fav_bin=fav,
        daily_leg_bin=raw_roll.held,
        settle_f=settle_f,
        baseline_pnl=raw_roll.pnl,
        filter_pnl=aware_roll.pnl,
        baseline_path=raw_roll.path,
        baseline_switches=raw_roll.switches,
        legs=legs,
        notes=notes,
        policies=policies,
        open_bin_aware=enriched[0].get("bin_book_aware"),
        aware_held=aware_roll.held,
        aware_pnl=aware_roll.pnl,
        aware_path=aware_roll.path,
        aware_switches=aware_roll.switches,
    )


def default_tape_path(city_key: str, day: str) -> Path:
    """day like 26AUG05 → .tmp/{chi|city}-weather-26aug05-monitor.jsonl"""
    city = get_city(city_key)
    day_lc = day.lower()
    if city.key == "chicago":
        return Path(f".tmp/chi-weather-{day_lc}-monitor.jsonl")
    return Path(f".tmp/{city.key}-weather-{day_lc}-monitor.jsonl")


def evaluate_day(
    day: str,
    cities: list[str] | None = None,
    root: Path | None = None,
) -> list[CityFilterResult]:
    root = root or Path(".")
    keys = cities or ["chicago", "nyc", "miami", "austin", "la"]
    out: list[CityFilterResult] = []
    for key in keys:
        path = root / default_tape_path(key, day)
        res = evaluate_city_day(key, path)
        if res:
            out.append(res)
    return out
