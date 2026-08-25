#!/usr/bin/env python3
"""Nightly collector: append profitable softball patterns to the backtest repo.

Replays ladder recordings at a configurable offset from each scoring event
(default t0-7s, the pre-move quote):
  - over softballs: cheapest Kalshi next-line over with category filters
  - middle softballs: late delta-anchored packages repriced at the same offset

Appends rows to data/backtest/mlb-softball-samples.jsonl (idempotent) and a
per-day summary to data/backtest/mlb-softball-days.jsonl.

The 7s lead prices the book *before* the run scores, which is only reachable
if you know the run is coming — measured against the real book at the tap it
runs a median 11.5c cheap. Set SOFTBALL_LEAD_MS to reprice: 0 fills at the
tap, negative values fill after it (e.g. -250 for a quarter-second of
reaction). Any non-default lead writes to its own suffixed file so the two
price bases never mix.

Usage:
  python3 scripts/collect-mlb-softballs.py            # yesterday (ET)
  python3 scripts/collect-mlb-softballs.py 2026-07-19
  SOFTBALL_LEAD_MS=0 python3 scripts/collect-mlb-softballs.py 2026-07-19
"""
import importlib.util
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
COLLECTOR = ROOT / "scripts" / "collect-mlb-fire-samples.py"
spec = importlib.util.spec_from_file_location("collect", COLLECTOR)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

DATA_DIR = c.DATA_DIR
REPO_DIR = DATA_DIR / "backtest"
ET = ZoneInfo("America/New_York")
DEFAULT_LEAD_MS = 7_000
LEAD_MS = int(os.environ.get("SOFTBALL_LEAD_MS", DEFAULT_LEAD_MS))
if LEAD_MS == DEFAULT_LEAD_MS:
    SUFFIX = ""
elif LEAD_MS >= 0:
    SUFFIX = f"-lead{LEAD_MS}ms"
else:
    SUFFIX = f"-lag{-LEAD_MS}ms"
SAMPLES = REPO_DIR / f"mlb-softball-samples{SUFFIX}.jsonl"
DAYS = REPO_DIR / f"mlb-softball-days{SUFFIX}.jsonl"
MIDDLE_MAX_COST = 1.35

# Known-bad recordings (phantom scores from feed misbinding, fixed 2026-07-29):
# CLE@CIN game-2 doubleheader crossover, OAK@ARI missing StatsAPI baseline.
SKIP = {("2026-07-28", "mlb-cle-cin-2026-07-28")}
SKIP_PREFIX = ("mlb-oak-ari-",)

CAT_A = "multi_run_early"
CAT_B = "cheap_over_early"
CAT_C = "cheap_over_late"
CAT_M = "late_cheap_middle"


def target_date() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    return (datetime.now(ET).date() - timedelta(days=1)).isoformat()


def kfee(venue, p):
    return 0.07 * p * (1 - p) if venue == "kalshi" else 0.0


def parse_inning(period):
    """'Top 5th' / 'Bot 8' / 'Middle 3rd' -> (inning, half)."""
    if not period:
        return None, None
    s = str(period)
    m = re.search(r"(\d+)", s)
    if not m:
        return None, None
    low = s.lower()
    half = "top" if low.startswith("top") else ("bottom" if low.startswith("bot") else None)
    return int(m.group(1)), half


def repo_keys():
    keys = set()
    if SAMPLES.exists():
        with open(SAMPLES) as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                k = (o.get("day"), o.get("slug"), o.get("t0"), o.get("kind"))
                if o.get("kind") == "middle":
                    k = (*k, o.get("venue"), o.get("marketType"), o.get("lineFamily"))
                keys.add(k)
    return keys


def extract_score_events(paper_files, day):
    events = []
    for path, slug, feed_id in paper_files:
        if (day, slug) in SKIP or any(slug.startswith(p) for p in SKIP_PREFIX):
            continue
        with c.jopen(path) as fh:
            for line in fh:
                if '"mlb_paper_score_event"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("kind") != "mlb_paper_score_event":
                    continue
                if o.get("source") == "phone_ping" or o.get("booksFrozenAtTap"):
                    continue
                t0 = o.get("t0") or o.get("t")
                pa, ph = o.get("prevAway"), o.get("prevHome")
                a, h = o.get("scoreAway"), o.get("scoreHome")
                if None in (t0, pa, ph, a, h):
                    continue
                da, dh = a - pa, h - ph
                runs_delta = da + dh
                if runs_delta <= 0:
                    continue
                # Require a single scoring side: both totals moving at once is a
                # poll merge across half-innings, not one scoring play (the
                # backtest that defined these slices excluded those).
                if da > 0 and dh > 0:
                    continue
                period = (o.get("feed") or {}).get("period")
                inning, half = parse_inning(period)
                events.append({
                    "day": day,
                    "slug": slug,
                    "feedId": str(feed_id) if feed_id else None,
                    "t0": t0,
                    "inning": inning,
                    "half": half,
                    "runsDelta": runs_delta,
                    "scoreAway": a,
                    "scoreHome": h,
                    "curTotal": a + h,
                    "wouldFireDelta": o.get("wouldFireDelta") or [],
                })
    # One opportunity per unique score change: duplicate score events (same
    # slug + new score from multiple feeds) collapse to the earliest, matching
    # the backtest that defined the softball slices.
    seen = set()
    uniq = []
    for e in sorted(events, key=lambda x: x["t0"]):
        key = (e["slug"], e["scoreAway"], e["scoreHome"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)
    return uniq


def load_kalshi_total_ticks(rp):
    """Kalshi total yes/no ticks keyed by (line, side) -> [(t, ask, sz)]."""
    ticks = defaultdict(list)
    with c.jopen(rp) as fh:
        for line in fh:
            if '"kind":"kalshi_ladder"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("klass") != "total":
                continue
            side, ask, t = o.get("side"), o.get("bestAsk"), o.get("t")
            ln = o.get("line")
            if side not in ("yes", "no") or ask is None or t is None or ln is None:
                continue
            ticks[(float(ln), side)].append(
                (t, float(ask), float(o.get("bestAskSize") or 0)))
    for k in ticks:
        ticks[k].sort()
    return ticks


def load_leg_ticks(rp):
    """All total/spread ladder ticks -> [(t, key, ask, sz)]."""
    ticks = []
    with c.jopen(rp) as fh:
        for line in fh:
            if '"kind":"kalshi_ladder"' not in line and '"kind":"ladder"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("klass") not in ("total", "spread"):
                continue
            ln, side = o.get("line"), o.get("side")
            if ln is None or side not in ("yes", "no"):
                continue
            venue = "kalshi" if o.get("kind") == "kalshi_ladder" else "pm"
            k = (venue, o.get("klass"), o.get("teamKey") or "", float(ln), side)
            ask = o.get("bestAsk")
            ticks.append((o.get("t") or 0, k,
                          float(ask) if ask is not None else None,
                          float(o.get("bestAskSize") or 0)))
    ticks.sort(key=lambda x: x[0])
    return ticks


def quote_at(tick_list, t_cut):
    """Last sized ask at/before t_cut -> (ask, size) or (None, None)."""
    best_ask, best_sz = None, None
    for t, ask, sz in tick_list:
        if t > t_cut:
            break
        if sz and sz > 0 and ask is not None and 0 < ask < 1:
            best_ask, best_sz = ask, sz
    return best_ask, best_sz


def leg_quote_at(ticks, key, t_cut):
    """Last sized ask for a package leg key at/before t_cut."""
    best_ask, best_sz = None, None
    for t, k, ask, sz in ticks:
        if t > t_cut:
            break
        if k != key:
            continue
        if sz and sz > 0 and ask is not None and 0 < ask < 1:
            best_ask, best_sz = ask, sz
    return best_ask, best_sz


def over_categories(inning, runs_delta, ask):
    cats = []
    # Early softballs: innings 1–5 only (6th+ not treated as early/cheap).
    if inning is not None and runs_delta >= 2 and inning <= 5:
        cats.append(CAT_A)
    if inning is not None and 0.50 <= ask < 0.80 and inning <= 5:
        cats.append(CAT_B)
    if inning is not None and ask < 0.65 and inning >= 7:
        cats.append(CAT_C)
    return cats


def spread_team_keys(book, venue, lo, hi, cost_hint):
    """Match spread package team by cost at quote time (attach_tob pattern)."""
    teams = {kk[2] for kk in book if kk[0] == venue and kk[1] == "spread"}
    best = None
    for tm in teams:
        yes = book.get((venue, "spread", tm, hi, "yes"))
        no = book.get((venue, "spread", tm, lo, "no"))
        if yes and no:
            d = abs(yes[0] + no[0] - (cost_hint or 0))
            if best is None or d < best[0]:
                best = (d, tm)
    return best[1] if best else ""


def build_book_at(ticks, t_cut):
    """Book state at t_cut from sorted leg ticks."""
    book = {}
    for t, k, ask, sz in ticks:
        if t > t_cut:
            break
        if sz and sz > 0 and ask is not None and 0 < ask < 1:
            book[k] = (ask, sz)
    return book


def package_legs(g, book, t_cut):
    """Resolve yes_lo / no_hi leg keys for a wouldFireDelta package."""
    lo, hi = c.parse_family(g["lineFamily"])
    venue = "kalshi" if g.get("venue") == "kalshi" else "pm"
    if g.get("marketType") == "game_total":
        return (
            (venue, "total", "", lo, "yes"),
            (venue, "total", "", hi, "no"),
        )
    cost_hint = g.get("cost0") if g.get("cost0") is not None else g.get("cost")
    tm = spread_team_keys(book, venue, lo, hi, cost_hint)
    return (
        (venue, "spread", tm, hi, "yes"),
        (venue, "spread", tm, lo, "no"),
    )


def settle_middle(g, fin, ya, na, venue):
    lo, hi = c.parse_family(g["lineFamily"])
    if g.get("marketType") == "game_total":
        total = (fin["away"] or 0) + (fin["home"] or 0)
        inside = lo < total < hi
    else:
        tm = g.get("_team") or ""
        home_key = fin["homeName"].lower().replace(" ", "-").replace(".", "")
        if tm and tm in home_key:
            margin = (fin["home"] or 0) - (fin["away"] or 0)
        else:
            margin = (fin["away"] or 0) - (fin["home"] or 0)
        s_lo, s_hi = abs(hi), abs(lo)
        inside = s_lo < margin < s_hi
    payout = 2.0 if inside else 1.0
    cost = ya + na
    fee = kfee(venue, ya) + kfee(venue, na) if venue == "kalshi" else 0.0
    pnl = round(payout - cost - fee, 4)
    return inside, fee, pnl


def process_day(day, finals, recs, existing):
    rows = []
    paper = c.paper_files_for(day)
    events = extract_score_events(paper, day)

    def rec_for(slug, t):
        cands = [r for r in recs if r[0] == slug and r[1] <= t]
        return max(cands, key=lambda r: r[1])[2] if cands else None

    by_rec = defaultdict(list)
    for e in events:
        rp = rec_for(e["slug"], e["t0"])
        if rp:
            by_rec[rp].append(e)

    for rp, group in by_rec.items():
        total_ticks = load_kalshi_total_ticks(rp)

        has_middles = any(e["wouldFireDelta"] for e in group)
        leg_ticks = load_leg_ticks(rp) if has_middles else []

        for e in group:
            fin = finals.get(str(e["feedId"])) if e["feedId"] else None
            if not fin or fin.get("state") != "Final":
                continue
            if fin.get("away") is None or fin.get("home") is None:
                continue
            ftot = fin["away"] + fin["home"]
            t_fill = e["t0"] - LEAD_MS
            cur = e["curTotal"]

            # --- over softball ---
            overs = []
            for (ln, side), arr in total_ticks.items():
                if side != "yes":
                    continue
                dist = ln - cur
                if not (0 < dist <= 1):
                    continue
                ask, ask_sz = quote_at(arr, t_fill)
                # The fill is the book state at t_fill; a >=0.95 quote means no
                # trade (do NOT fall back to older cheaper ticks).
                if ask is None or ask >= 0.95 or ask <= 0.05:
                    continue
                overs.append((ask, ln, ask_sz))
            if overs:
                ask, ln, ask_sz = min(overs)
                cats = over_categories(e["inning"], e["runsDelta"], ask)
                if cats:
                    won = ftot > ln
                    fee = round(kfee("kalshi", ask), 4)
                    gross = (1.0 - ask) if won else -ask
                    pnl = round(gross - fee, 4)
                    key = (day, e["slug"], e["t0"], "over")
                    if key not in existing:
                        rows.append({
                            "day": day,
                            "slug": e["slug"],
                            "kind": "over",
                            "t0": e["t0"],
                            "inning": e["inning"],
                            "half": e["half"],
                            "runsDelta": e["runsDelta"],
                            "scoreAway": e["scoreAway"],
                            "scoreHome": e["scoreHome"],
                            "curTotal": cur,
                            "line": ln,
                            "ask": ask,
                            "askSize": ask_sz,
                            "cats": cats,
                            "won": won,
                            "fee": fee,
                            "pnl": pnl,
                            "finalAway": fin["away"],
                            "finalHome": fin["home"],
                        })
                        existing.add(key)

            # --- middle softballs ---
            if e["inning"] is None or e["inning"] < 7:
                continue
            book_at = build_book_at(leg_ticks, t_fill)
            seen_pkg = set()
            for g in e["wouldFireDelta"]:
                pkg_key = (g.get("venue"), g.get("marketType"), g.get("lineFamily"))
                if pkg_key in seen_pkg:
                    continue
                seen_pkg.add(pkg_key)
                try:
                    yes_k, no_k = package_legs(g, book_at, t_fill)
                except Exception:
                    continue
                venue = yes_k[0]
                ya, _ = leg_quote_at(leg_ticks, yes_k, t_fill)
                na, _ = leg_quote_at(leg_ticks, no_k, t_fill)
                if ya is None or na is None:
                    for v2 in ("kalshi", "pm"):
                        if v2 == venue:
                            continue
                        yk = (v2, yes_k[1], yes_k[2], yes_k[3], yes_k[4])
                        nk = (v2, no_k[1], no_k[2], no_k[3], no_k[4])
                        ya = ya or leg_quote_at(leg_ticks, yk, t_fill)[0]
                        na = na or leg_quote_at(leg_ticks, nk, t_fill)[0]
                        if ya is not None and na is not None:
                            venue = v2
                            yes_k, no_k = yk, nk
                            break
                if ya is None or na is None:
                    continue
                cost7s = round(ya + na, 4)
                if cost7s >= MIDDLE_MAX_COST:
                    continue
                g_copy = dict(g)
                g_copy["_team"] = yes_k[2]
                inside, fee, pnl = settle_middle(g_copy, fin, ya, na, venue)
                row_key = (day, e["slug"], e["t0"], "middle",
                           g.get("venue"), g.get("marketType"), g.get("lineFamily"))
                if row_key in existing:
                    continue
                cost_at_fire = g.get("cost0") if g.get("cost0") is not None else g.get("cost")
                delta_edge = g.get("deltaEdge")
                rows.append({
                    "day": day,
                    "slug": e["slug"],
                    "kind": "middle",
                    "t0": e["t0"],
                    "inning": e["inning"],
                    "venue": g.get("venue"),
                    "marketType": g.get("marketType"),
                    "lineFamily": g.get("lineFamily"),
                    "cost7s": cost7s,
                    "costAtFire": cost_at_fire,
                    "deltaEdge": delta_edge,
                    "won": inside,
                    "fee": round(fee, 4),
                    "pnl": pnl,
                    "finalAway": fin["away"],
                    "finalHome": fin["home"],
                    "cats": [CAT_M],
                })
                existing.add(row_key)

    return rows, len(events), len({s for _, s, _ in paper})


def summarize(day, games, score_events, rows):
    cats = [CAT_A, CAT_B, CAT_C, CAT_M]
    softballs = {}
    for cat in cats:
        matched = [r for r in rows if cat in r.get("cats", [])]
        softballs[cat] = {
            "n": len(matched),
            "pnl": round(sum(r["pnl"] for r in matched), 2),
            "hits": sum(1 for r in matched if r.get("won")),
        }
    over_union = [r for r in rows
                  if r.get("kind") == "over"
                  and (CAT_A in r.get("cats", []) or CAT_B in r.get("cats", []))]
    softballs["overUnion"] = {
        "n": len(over_union),
        "pnl": round(sum(r["pnl"] for r in over_union), 2),
        "hits": sum(1 for r in over_union if r.get("won")),
    }
    return {
        "day": day,
        "leadMs": LEAD_MS,
        "games": games,
        "scoreEvents": score_events,
        "softballs": softballs,
        "totalPnl": round(sum(r["pnl"] for r in rows), 2),
    }


def print_summary(summary, added):
    day = summary["day"]
    print(f"\n{day} softball summary, lead {LEAD_MS}ms ({added} new rows):")
    print(f"  games={summary['games']} scoreEvents={summary['scoreEvents']}")
    for cat in (CAT_A, CAT_B, CAT_C, CAT_M, "overUnion"):
        s = summary["softballs"][cat]
        print(f"  {cat:20s} n={s['n']:3d}  pnl={s['pnl']:+.2f}  hits={s['hits']}")
    print(f"  totalPnl={summary['totalPnl']:+.2f}")


def main():
    day = target_date()
    REPO_DIR.mkdir(parents=True, exist_ok=True)

    paper = c.paper_files_for(day)
    if not paper:
        print(f"{day}: no paper files found — nothing to collect")
        return

    try:
        finals = c.fetch_finals(day)
    except Exception as e:
        print(f"{day}: finals fetch failed: {e}")
        return

    recs = c.recordings_for(day)
    existing = repo_keys()
    before = len(existing)

    rows, score_events, games = process_day(day, finals, recs, existing)
    added = len(rows)

    if rows:
        with open(SAMPLES, "a") as out:
            for r in rows:
                out.write(json.dumps(r) + "\n")

    # Day summary includes all rows for this day (existing + new)
    all_day_rows = []
    if SAMPLES.exists():
        with open(SAMPLES) as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("day") == day:
                    all_day_rows.append(o)

    summary = summarize(day, games, score_events, all_day_rows)
    day_logged = False
    if DAYS.exists():
        with open(DAYS) as fh:
            day_logged = any(
                f'"day": "{day}"' in ln or f'"day":"{day}"' in ln for ln in fh)
    if added > 0 or not day_logged:
        with open(DAYS, "a") as out:
            out.write(json.dumps(summary) + "\n")

    print_summary(summary, added)
    print(f"{day}: repo keys {before} -> {len(existing)} (+{added})")


if __name__ == "__main__":
    main()
