#!/usr/bin/env python3
"""
One-off settlement fix for monotonic_arb_shadow (pm_package) trades.

Background: the engine's mark-to-market for pm_package legs used live PM
bid/ask, which is stale or wrong once the market resolves. This script
re-settles each pm_package shadow whose expiry has passed using the actual
realized high/low of the underlying spot during the contract's calendar
month (the same logic that's now in scripts/trading-engine.ts as
`settleMonotonicArbPackage`).

Behavior:
  - Computes the high/low of the underlying spot column in
    data/daily-valuations.csv during the package's contract month
    (i.e., the calendar UTC month immediately preceding `expiryDate`).
  - Resolves each leg ("above": YES pays $1 if max >= strike; "below":
    YES pays $1 if min <= strike). NO leg = 1 - YES.
  - Computes shares = size / entryPrice, marketPnl = shares * (totalPayout - entryPrice).
  - For OPEN packages with expiry <= now: closes them with
    `closeReason: "expiry"` and `outcome` win/loss based on pnl.
  - For RESOLVED packages: overwrites the hypotheticalResult to reflect
    true realized P&L.

Usage:
  python3 scripts/fix_monotonic_arb_settlements.py --dry-run    # preview
  python3 scripts/fix_monotonic_arb_settlements.py              # write
"""

from __future__ import annotations
import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VALUATIONS = ROOT / "data" / "daily-valuations.csv"
BLOCKED_SIGNALS = ROOT / "data" / "blocked-signals.json"

ASSET_TO_COL = {
    "BTC": "btc_spot",
    "ETH": "eth_spot",
    "HYPE": "hype_spot",
    "GOLD": "gold_gc_spot",
    "AMZN": "amzn_stock",
    "SPY": "spy_spot",
    "OIL": "oil_wti_spot",
}


def parse_iso(s: str) -> datetime | None:
    if not s: return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def load_val_rows() -> list[dict]:
    with open(VALUATIONS) as f:
        return list(csv.DictReader(f))


def asset_extremes_in_month(rows: list[dict], asset: str, year: int, month: int) -> tuple[float | None, float | None]:
    col = ASSET_TO_COL.get(asset)
    if not col: return (None, None)
    hi, lo = float("-inf"), float("inf")
    target = f"{year:04d}-{month:02d}"
    for row in rows:
        ts = row.get("timestamp") or row.get("date") or ""
        if not ts.startswith(target): continue
        v = row.get(col)
        if not v: continue
        try:
            fv = float(v)
            if fv > 0:
                if fv > hi: hi = fv
                if fv < lo: lo = fv
        except (TypeError, ValueError):
            continue
    if hi == float("-inf") or lo == float("inf"):
        return (None, None)
    return (hi, lo)


def contract_period_for_expiry(expiry_dt: datetime) -> tuple[int, int]:
    """For an expiry like 2026-06-01T03:59:59Z (= 23:59:59 ET on May 31), the
    contract was "in May 2026". Step back 12 hours to land firmly inside the
    resolution month regardless of EDT/EST offset."""
    inside = expiry_dt.replace(tzinfo=timezone.utc) if expiry_dt.tzinfo is None else expiry_dt
    inside_ts = inside.timestamp() - 12 * 3600
    inside_dt = datetime.fromtimestamp(inside_ts, tz=timezone.utc)
    return (inside_dt.year, inside_dt.month)


def settle_package(position: dict, val_rows: list[dict]) -> dict | None:
    legs = position.get("packageLegs") or []
    if len(legs) < 2: return None
    if position.get("instrumentType") != "pm_package": return None
    expiry = parse_iso(position.get("expiryDate", ""))
    if not expiry: return None
    now = datetime.now(timezone.utc)
    if expiry > now: return None  # not yet expired

    year, month = contract_period_for_expiry(expiry)
    asset = position.get("asset")
    hi, lo = asset_extremes_in_month(val_rows, asset, year, month)
    if hi is None or lo is None: return None

    total_payout = 0.0
    leg_details = []
    for leg in legs:
        direction = leg.get("direction")
        strike = leg.get("strike")
        if direction not in ("above", "below") or not isinstance(strike, (int, float)):
            return None
        if direction == "above":
            yes_resolves = hi >= strike
        else:
            yes_resolves = lo <= strike
        leg_payout = (1.0 if yes_resolves else 0.0) if leg.get("instrumentType") == "pm_yes" else (0.0 if yes_resolves else 1.0)
        total_payout += leg_payout
        leg_details.append({
            "role": leg.get("role"),
            "direction": direction,
            "strike": strike,
            "instrumentType": leg.get("instrumentType"),
            "yesResolves": yes_resolves,
            "legPayout": leg_payout,
        })

    entry_price = float(position["entryPrice"])
    size = float(position["size"])
    shares = size / entry_price
    market_pnl = shares * (total_payout - entry_price)
    pnl_pct = (market_pnl / size) * 100.0

    return {
        "asset": asset,
        "year": year,
        "month": month,
        "high": hi,
        "low": lo,
        "totalPayout": total_payout,
        "marketPnl": market_pnl,
        "pnlPct": pnl_pct,
        "legs": leg_details,
        "shares": shares,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Print planned changes without writing")
    args = ap.parse_args()

    val_rows = load_val_rows()
    with open(BLOCKED_SIGNALS) as f:
        shadows = json.load(f)
    if isinstance(shadows, dict):
        # Tolerate alternate shapes
        shadows_list = shadows.get("shadows") or shadows.get("blocked") or []
        wrapped = True
        wrapper = shadows
    else:
        shadows_list = shadows
        wrapped = False

    now_iso = datetime.now(timezone.utc).isoformat()
    fixed_resolved = 0
    fixed_opened = 0
    skipped = 0
    total_old_pnl = 0.0
    total_new_pnl = 0.0
    out_lines = []

    for s in shadows_list:
        if s.get("blockedReason") != "monotonic_arb_shadow": continue
        pos = s.get("position") or {}
        if pos.get("instrumentType") != "pm_package": continue
        settled = settle_package(pos, val_rows)
        if not settled:
            skipped += 1
            continue

        existing_hr = s.get("hypotheticalResult") or {}
        old_pnl = existing_hr.get("pnl", 0) if s.get("status") == "resolved" else 0
        new_pnl = round(settled["marketPnl"], 4)
        new_pnl_pct = round(settled["pnlPct"], 2)
        outcome = "win" if new_pnl >= 0 else "loss"
        verb = "RE-SETTLE" if s.get("status") == "resolved" else "CLOSE"
        legs_str = " / ".join(
            f"{l['role']}[{l['direction']} {l['strike']}: {'YES' if l['yesResolves'] else 'NO'}->{l['legPayout']:.0f}]"
            for l in settled["legs"]
        )
        out_lines.append(
            f"  {verb:10s} {s['id'][:18]:<19} {pos['asset']:<5} {settled['year']}-{settled['month']:02d} "
            f"[lo={settled['low']:.2f} hi={settled['high']:.2f}] "
            f"payout=${settled['totalPayout']:.2f}  "
            f"oldPnl=${old_pnl:.4f} -> newPnl=${new_pnl:+.4f} ({new_pnl_pct:+.2f}%)  {outcome}  | {legs_str}"
        )

        if not args.dry_run:
            s["status"] = "resolved"
            if not s.get("resolvedAt"):
                s["resolvedAt"] = now_iso
            s["hypotheticalResult"] = {
                "closeReason": "expiry",
                "exitPrice": round(settled["totalPayout"], 4),
                "pnl": new_pnl,
                "pnlPct": new_pnl_pct,
                "marketPnl": new_pnl,
                "fundingPnl": 0,
                "outcome": outcome,
                "settlementSource": "settleMonotonicArbPackage_oneoff",
            }
            pos["currentPrice"] = round(settled["totalPayout"], 4)

        if s.get("status") == "resolved" and existing_hr:
            fixed_resolved += 1
            total_old_pnl += float(old_pnl) if isinstance(old_pnl, (int, float)) else 0
        else:
            fixed_opened += 1
        total_new_pnl += new_pnl

    print(f"Monotonic arb pm_package shadows scanned (expired): {fixed_resolved + fixed_opened}")
    print(f"  previously resolved (PnL re-settled): {fixed_resolved}")
    print(f"  previously open    (now closed):      {fixed_opened}")
    print(f"  skipped (no data / not expired):      {skipped}")
    print()
    print(f"Realized P&L  (old):  ${total_old_pnl:+.4f}")
    print(f"Realized P&L  (new):  ${total_new_pnl:+.4f}")
    print(f"Delta:               ${total_new_pnl - total_old_pnl:+.4f}")
    print()
    print("Per-trade detail:")
    print()
    for line in out_lines:
        print(line)

    if args.dry_run:
        print()
        print("(DRY RUN — no changes written. Re-run without --dry-run to apply.)")
    else:
        if wrapped:
            wrapper["shadows" if "shadows" in wrapper else "blocked"] = shadows_list
            payload = wrapper
        else:
            payload = shadows_list
        with open(BLOCKED_SIGNALS, "w") as f:
            json.dump(payload, f, indent=2)
        print()
        print(f"Wrote updated {BLOCKED_SIGNALS}")


if __name__ == "__main__":
    main()
