"""Execution-aware GOT roll simulator: real books, real spreads, real fees.

Faithful python port of the live daemon's planning logic
(scripts/lib/weather-got-roll.ts @ cursor/got-live-roll-1c51) driven by:
  - the GOT diurnal tape (bin decisions + daily_implied mids), and
  - the weather monitor tape's *order book* events (type:"book") for the
    daily-high strip tickers.

Buys walk real ask depth (NO bids -> YES asks), sells hit real YES bids,
both capped by the daemon's walk slip; Kalshi fee 0.07*p*(1-p) per contract
is charged on every fill. A bin with no resting YES bid cannot be sold —
exactly the no_bid_to_sell stuck state live hit.

Defaults mirror the deployed daemon env (weather-got-roll-exec.ts).
"""

from __future__ import annotations

import gzip
import json
import math
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

Level = tuple[float, float]  # (price, contracts)


@dataclass
class ExecOpts:
    stake_usd: float = 20.0
    min_ask: float = 0.01
    max_ask: float = 0.95
    min_buy_mid: float = 0.05
    roll_walk_slip: float = 0.03
    open_walk_slip: float = 0.03
    min_roll_notional_usd: float = 5.0
    min_sell_fill_frac: float = 0.95
    min_buy_to_sell_ratio: float = 0.5
    max_rolls_per_day: int = 0  # 0 = unlimited
    confirm_ticks: int = 1
    fee_rate: float = 0.07
    # Ignore book snapshots older than this at decision time. Live saw
    # real-time WS books; stale tape books (esp. penny MM walls on far-OTM
    # bins) invent fills live could never get.
    book_max_age_s: float = 600.0
    # Distrust books whose top-of-book is further than this from the
    # same-row GOT mid (stale far-OTM snapshots vs fresh NBBO). 0 disables.
    coherence_slack: float = 0.15
    # Require this many contracts of resting YES bid on the *target* bin
    # before opening/rolling into it (exit-ability gate). 0 disables.
    min_entry_bid_depth: float = 0.0


def fee_per_contract(price: float, rate: float = 0.07) -> float:
    return rate * price * (1.0 - price)


# ------------------------------------------------------------------ tickers

def ticker_for_bin(series: str, day: str, label: str) -> str | None:
    """Map monitor bin label to the Kalshi daily-high ticker.

    Empirical mapping from live fills: "a-b" -> B{(a+b)/2}; "<=x" -> T{x+1};
    ">=x" -> T{x-1}.
    """
    label = label.strip()
    prefix = f"{series}-{day.upper()}"
    if label.startswith("<="):
        return f"{prefix}-T{int(float(label[2:])) + 1}"
    if label.startswith(">="):
        return f"{prefix}-T{int(float(label[2:])) - 1}"
    if "-" in label:
        a, b = label.split("-", 1)
        mid = (float(a) + float(b)) / 2.0
        s = f"{mid:g}"
        return f"{prefix}-B{s}"
    return None


# -------------------------------------------------------------------- books

class BookTape:
    """Time-indexed order books for one day's daily-high strip."""

    def __init__(self) -> None:
        self._times: dict[str, list[str]] = {}
        self._epochs: dict[str, list[float]] = {}
        self._books: dict[str, list[tuple[list[Level], list[Level]]]] = {}

    @classmethod
    def from_weather_tape(cls, path: Path, series: str) -> "BookTape":
        bt = cls()
        needle = f'"{series}-'
        opener = gzip.open if str(path).endswith(".gz") else open
        with opener(path, "rt") as f:
            for line in f:
                if '"book"' not in line or needle not in line:
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if o.get("type") != "book":
                    continue
                tk = o.get("tk") or ""
                if not tk.startswith(series + "-"):
                    continue
                ob = o.get("ob") or {}
                yes_bids = _levels(ob.get("yes_dollars"))
                no_bids = _levels(ob.get("no_dollars"))
                recv = str(o.get("recv") or "")
                bt._times.setdefault(tk, []).append(recv)
                bt._epochs.setdefault(tk, []).append(_epoch(recv))
                bt._books.setdefault(tk, []).append((yes_bids, no_bids))
        return bt

    def at(
        self, ticker: str, recv: str, max_age_s: float = 0.0
    ) -> tuple[list[Level], list[Level]] | None:
        """Latest (yes_bids, no_bids) snapshot at or before `recv`.

        max_age_s > 0: return None when the snapshot is older than that
        (live had real-time books; a stale tape book is not tradeable).
        """
        times = self._times.get(ticker)
        if not times:
            return None
        i = bisect_right(times, recv) - 1
        if i < 0:
            return None
        if max_age_s > 0:
            now = _epoch(recv)
            snap_t = self._epochs[ticker][i]
            if now > 0 and snap_t > 0 and now - snap_t > max_age_s:
                return None
        return self._books[ticker][i]

    def yes_asks(self, ticker: str, recv: str, max_age_s: float = 0.0) -> list[Level]:
        snap = self.at(ticker, recv, max_age_s)
        if snap is None:
            return []
        out = [(round(1.0 - p, 4), s) for p, s in snap[1] if 0 < 1.0 - p < 1 and s > 0]
        return sorted(out)

    def yes_bids(self, ticker: str, recv: str, max_age_s: float = 0.0) -> list[Level]:
        snap = self.at(ticker, recv, max_age_s)
        if snap is None:
            return []
        out = [(p, s) for p, s in snap[0] if 0 < p < 1 and s > 0]
        return sorted(out, reverse=True)

    def tickers(self) -> list[str]:
        return list(self._times)


def _epoch(recv: str) -> float:
    try:
        return datetime.fromisoformat(recv.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _levels(raw) -> list[Level]:
    out: list[Level] = []
    for lv in raw or []:
        try:
            px, sz = float(lv[0]), float(lv[1])
        except (TypeError, ValueError, IndexError):
            continue
        if px > 0 and sz > 0:
            out.append((px, sz))
    return out


# -------------------------------------------------------------------- walks
# Faithful ports of planSellWalk / planBuyWalkForProceeds / planOpenWalk.

def plan_sell_walk(want: float, bids: list[Level], max_slip: float) -> dict:
    levels = sorted(bids, reverse=True)
    tob = levels[0][0] if levels else 0.0
    floor = max(0.01, round(tob - max_slip, 4))
    left = max(0.0, want)
    notional = fillable = 0.0
    limit = tob
    for px, sz in levels:
        if left <= 1e-9 or px + 1e-9 < floor:
            break
        take = min(left, sz)
        if take <= 0:
            continue
        fillable += take
        notional += take * px
        left -= take
        limit = px
    vwap = notional / fillable if fillable > 0 else tob
    return {"tob": tob, "limit": limit, "vwap": vwap, "fillable": fillable}


def plan_buy_walk_for_proceeds(
    proceeds: float, asks: list[Level], max_slip: float, min_ask: float, max_ask: float
) -> dict:
    levels = sorted(asks)
    tob = levels[0][0] if levels else 0.0
    ceil = min(max_ask, round(tob + max_slip, 4) if tob > 0 else max_ask)
    budget = max(0.0, proceeds)
    contracts = notional = 0.0
    limit = tob
    for px, sz in levels:
        if budget <= 1e-9 or px > ceil + 1e-9:
            break
        if px + 1e-9 < min_ask:
            continue
        max_by_usd = math.floor(budget / px + 1e-9)
        take = min(sz, max_by_usd)
        if take < 1:
            break
        contracts += take
        notional += take * px
        budget -= take * px
        limit = px
    vwap = notional / contracts if contracts > 0 else tob
    return {"tob": tob, "limit": limit, "vwap": vwap, "contracts": contracts}


def plan_open_walk(
    stake: float, asks: list[Level], max_slip: float, min_ask: float, max_ask: float
) -> dict:
    levels = sorted(asks)
    tob = levels[0][0] if levels else 0.0
    if tob <= 0:
        return {"tob": 0.0, "vwap": 0.0, "contracts": 0.0}
    want = math.floor(stake / tob)
    ceil = min(max_ask, round(tob + max_slip, 4))
    left = float(want)
    notional = fillable = 0.0
    for px, sz in levels:
        if left <= 1e-9 or px > ceil + 1e-9:
            break
        if px + 1e-9 < min_ask:
            continue
        room = stake - notional
        if room <= 1e-9:
            break
        take = min(sz, left, math.floor(room / px + 1e-9))
        if take < 1:
            break
        fillable += take
        notional += take * px
        left -= take
    vwap = notional / fillable if fillable > 0 else tob
    return {"tob": tob, "vwap": vwap, "contracts": math.floor(fillable)}


# ---------------------------------------------------------------- simulator

@dataclass
class ExecResult:
    pnl: float = 0.0
    cash: float = 0.0
    fees: float = 0.0
    rolls: int = 0
    opens: int = 0
    spent: float = 0.0
    held_bin: str | None = None
    held_contracts: float = 0.0
    avg_entry: float = 0.0
    won: bool | None = None
    skips: dict[str, int] = field(default_factory=dict)
    path: list[str] = field(default_factory=list)

    def skip(self, reason: str) -> None:
        self.skips[reason] = self.skips.get(reason, 0) + 1


def simulate_exec_roll(
    got_stream: list[dict],
    books: BookTape,
    series: str,
    day: str,
    settle_f: float | None,
    opts: ExecOpts | None = None,
    settle_hit=None,
) -> ExecResult:
    """Replay the live daemon policy over GOT decisions with real books."""
    o = opts or ExecOpts()
    res = ExecResult()
    held_bin: str | None = None
    held_ticker: str | None = None
    contracts = 0.0
    pending_bin: str | None = None
    confirm = 0

    for row in got_stream:
        bin_label = row.get("bin")
        recv = str(row.get("recv") or "")
        di = row.get("daily_implied") or {}
        if not bin_label or not recv:
            continue
        ticker = ticker_for_bin(series, day, bin_label)
        if ticker is None or books.at(ticker, recv, o.book_max_age_s) is None:
            res.skip("bin_not_in_strip")
            continue

        if held_bin == bin_label:
            pending_bin, confirm = None, 0
            continue

        # Confirm ticks (live: acts when count reaches CONFIRM_TICKS).
        if held_bin is not None:
            if pending_bin == bin_label:
                confirm += 1
            else:
                pending_bin, confirm = bin_label, 1
            if confirm < o.confirm_ticks:
                continue

        mid = None
        raw = di.get(bin_label)
        if raw is not None:
            try:
                mid = float(raw)
            except (TypeError, ValueError):
                mid = None

        asks = books.yes_asks(ticker, recv, o.book_max_age_s)
        tob_ask = asks[0][0] if asks else None
        if (
            o.coherence_slack > 0
            and tob_ask is not None
            and mid is not None
            and abs(tob_ask - mid) > o.coherence_slack
        ):
            res.skip("book_incoherent_vs_mid")
            continue
        if o.min_entry_bid_depth > 0:
            tgt_bids = books.yes_bids(ticker, recv, o.book_max_age_s)
            if sum(s for _, s in tgt_bids) + 1e-9 < o.min_entry_bid_depth:
                res.skip("entry_bid_depth_thin")
                continue

        if held_bin is None:
            # ---- open
            if res.spent + 1e-9 >= o.stake_usd:
                res.skip("stake_spent")
                continue
            if tob_ask is None:
                res.skip("no_ask")
                continue
            if tob_ask < o.min_ask:
                res.skip("ask_below_min")
                continue
            if tob_ask > o.max_ask:
                res.skip("ask_above_max")
                continue
            decision_px = mid if mid and mid > 0 else tob_ask
            if o.min_buy_mid > 0 and decision_px + 1e-9 < o.min_buy_mid:
                res.skip("buy_below_min_mid")
                continue
            budget = min(o.stake_usd, o.stake_usd - res.spent)
            walk = plan_open_walk(budget, asks, o.open_walk_slip, o.min_ask, o.max_ask)
            if walk["contracts"] < 1:
                res.skip("size_zero")
                continue
            n, px = walk["contracts"], walk["vwap"]
            cost = n * px
            fee = n * fee_per_contract(px, o.fee_rate)
            res.cash -= cost + fee
            res.fees += fee
            res.spent += cost
            res.opens += 1
            held_bin, held_ticker, contracts = bin_label, ticker, float(n)
            res.avg_entry = px
            res.path.append(bin_label)
            pending_bin, confirm = None, 0
            continue

        # ---- roll
        if o.max_rolls_per_day > 0 and res.rolls >= o.max_rolls_per_day:
            res.skip("roll_cap")
            continue
        bids = books.yes_bids(held_ticker, recv, o.book_max_age_s)
        tob_bid = bids[0][0] if bids else None
        if tob_bid is None or tob_bid <= 0:
            res.skip("no_bid_to_sell")
            continue
        held_mid = None
        raw_held = di.get(held_bin)
        if raw_held is not None:
            try:
                held_mid = float(raw_held)
            except (TypeError, ValueError):
                held_mid = None
        if (
            o.coherence_slack > 0
            and held_mid is not None
            and abs(tob_bid - held_mid) > o.coherence_slack
        ):
            res.skip("book_incoherent_vs_mid")
            continue
        if tob_ask is None:
            res.skip("no_ask")
            continue
        if tob_ask < o.min_ask:
            res.skip("ask_below_min")
            continue
        if tob_ask > o.max_ask:
            res.skip("ask_above_max")
            continue
        decision_px = mid if mid and mid > 0 else tob_ask
        if o.min_buy_mid > 0 and decision_px + 1e-9 < o.min_buy_mid:
            res.skip("buy_below_min_mid")
            continue
        if o.min_roll_notional_usd > 0 and contracts * tob_bid + 1e-9 < o.min_roll_notional_usd:
            res.skip("min_roll_notional")
            continue

        sell = plan_sell_walk(contracts, bids, o.roll_walk_slip)
        if sell["fillable"] < 1:
            res.skip("no_bid_to_sell")
            continue
        if (
            o.min_sell_fill_frac > 0
            and sell["fillable"] + 1e-9 < contracts * o.min_sell_fill_frac
        ):
            res.skip("sell_depth_thin")
            continue
        proceeds = sell["vwap"] * sell["fillable"]
        buy = plan_buy_walk_for_proceeds(
            proceeds, asks, o.roll_walk_slip, o.min_ask, o.max_ask
        )
        if buy["contracts"] < 1:
            res.skip("roll_size_zero")
            continue
        if (
            o.min_buy_to_sell_ratio > 0
            and buy["contracts"] + 1e-9 < sell["fillable"] * o.min_buy_to_sell_ratio
        ):
            res.skip("roll_cliff")
            continue

        sell_fee = sell["fillable"] * fee_per_contract(sell["vwap"], o.fee_rate)
        buy_cost = buy["contracts"] * buy["vwap"]
        buy_fee = buy["contracts"] * fee_per_contract(buy["vwap"], o.fee_rate)
        res.cash += proceeds - sell_fee
        res.cash -= buy_cost + buy_fee
        res.fees += sell_fee + buy_fee
        res.rolls += 1
        # Unsold remainder is orphaned (live parity: daemon tracked new bin only).
        held_bin, held_ticker = bin_label, ticker
        contracts = buy["contracts"]
        res.avg_entry = buy["vwap"]
        res.path.append(bin_label)
        pending_bin, confirm = None, 0

    res.held_bin = held_bin
    res.held_contracts = contracts
    if held_bin is not None and settle_f is not None:
        hit = settle_hit(held_bin, settle_f) if settle_hit else _default_hit(held_bin, settle_f)
        res.won = bool(hit)
        res.pnl = res.cash + (contracts if hit else 0.0)
    else:
        res.pnl = res.cash
    return res


def _default_hit(label: str, settle: float) -> bool:
    label = label.strip()
    if label.startswith("<="):
        return settle <= float(label[2:]) + 0.49
    if label.startswith(">="):
        return settle >= float(label[2:]) - 0.49
    if "-" in label:
        a, b = label.split("-", 1)
        return float(a) - 0.49 <= settle <= float(b) + 0.49
    return False


def got_stream_from_tape(path: Path, poll_ms: int = 0) -> list[dict]:
    """GOT decisions (recv, bin, daily_implied) from a diurnal-got monitor tape.

    poll_ms > 0 emulates the live daemon's poll loop, which reads only the
    latest tape row every poll: keep the last row per poll window.
    """
    stream: list[dict] = []
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt") as f:
        for line in f:
            if '"bin"' not in line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            b = o.get("bin")
            di = o.get("daily_implied")
            if b and di:
                stream.append({"recv": o.get("recv"), "bin": b, "daily_implied": di})
    if poll_ms <= 0 or not stream:
        return stream
    out: list[dict] = []
    window = None
    for row in stream:
        recv = str(row.get("recv") or "")
        try:
            ts = datetime.fromisoformat(recv.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        w = int(ts * 1000) // poll_ms
        if window is not None and w == window:
            out[-1] = row
        else:
            out.append(row)
            window = w
    return out
