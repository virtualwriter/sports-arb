#!/usr/bin/env python3
"""Validate Oleg frozen vs one-step-ahead conditioned mode on real KNYC highs.

Replays Jan 1 2026 .. latest obs, comparing:
  - frozen:      bare Fourier curve (what the workbook backtest measured)
  - conditioned: ARMA(1,2) one-step-ahead on official daily highs

Usage:
  PYTHONPATH=scripts python3 scripts/oleg_backtest_validation.py
  PYTHONPATH=scripts python3 scripts/oleg_backtest_validation.py --store /tmp/highs.json
"""

from __future__ import annotations

import argparse
import math
from datetime import date
from pathlib import Path

from lib.oleg import (
    DEFAULT_HIGHS_STORE,
    forecast_conditioned,
    forecast_frozen,
    load_highs,
)


def _mae(errs: list[float]) -> float:
    return sum(abs(e) for e in errs) / len(errs)


def _rmse(errs: list[float]) -> float:
    return math.sqrt(sum(e * e for e in errs) / len(errs))


def score(days: list[date], highs: dict[date, float], label: str) -> None:
    fro, con = [], []
    for d in days:
        actual = highs[d]
        fro.append(forecast_frozen(d).mean_f - actual)
        con.append(forecast_conditioned(d, highs).mean_f - actual)
    n = len(days)
    print(f"\n{label} (n={n})")
    print(f"  {'':>12} {'MAE':>6} {'RMSE':>6} {'bias':>6} {'<=1F':>6} {'<=2F':>6} {'<=5F':>6}")
    for name, errs in (("frozen", fro), ("conditioned", con)):
        w1 = sum(1 for e in errs if abs(e) <= 1.0) / n
        w2 = sum(1 for e in errs if abs(e) <= 2.0) / n
        w5 = sum(1 for e in errs if abs(e) <= 5.0) / n
        print(
            f"  {name:>12} {_mae(errs):6.2f} {_rmse(errs):6.2f} "
            f"{sum(errs)/n:+6.2f} {w1:6.0%} {w2:6.0%} {w5:6.0%}"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--store", type=Path, default=DEFAULT_HIGHS_STORE)
    args = ap.parse_args()

    highs = load_highs(args.store)
    days_2026 = sorted(d for d in highs if d >= date(2026, 1, 1))
    if not days_2026:
        print("no 2026 obs in store; run fetch_central_park_daily_high.py first")
        return 1

    print(f"store: {args.store} ({len(highs)} days, latest {max(highs)})")
    score(days_2026, highs, "Jan 1 2026 .. latest")
    summer = [d for d in days_2026 if d >= date(2026, 6, 1)]
    if summer:
        score(summer, highs, "Jun 1 2026 .. latest")
    aug = [d for d in days_2026 if d >= date(2026, 8, 1)]
    if aug:
        score(aug, highs, "Aug 2026")

    # Empirical conditioned-innovation sigma (useful to calibrate bin probs
    # tighter than the model's full-year sigma≈6.7).
    errs = [forecast_conditioned(d, highs).mean_f - highs[d] for d in days_2026]
    sig_all = _rmse(errs)
    errs_summer = [forecast_conditioned(d, highs).mean_f - highs[d] for d in summer] if summer else []
    print(f"\nempirical conditioned sigma: full-2026={sig_all:.2f}F", end="")
    if errs_summer:
        print(f"  Jun-Aug={_rmse(errs_summer):.2f}F")
    else:
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
