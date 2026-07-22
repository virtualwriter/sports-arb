#!/usr/bin/env python3
"""Nightly collector: append the day's wouldFire opportunities to the backtest repo.

For every real (non-phone) wouldFire package in the MLB paper logs for DATE:
  - replay the matching ladder recording to the fire timestamp
  - capture TOB ask price+size for both legs (YES lo / NO hi); fillable = min
  - settle vs StatsAPI final: middle pays $2 inside the band, $1 outside

Appends one JSON row per fire occurrence to data/backtest/mlb-fire-samples.jsonl
(idempotent — rows already in the repo are skipped) and a per-day summary to
data/backtest/mlb-fire-days.jsonl.

Each row also carries the post-score ms detail joined from the paper
mlb_paper_score_window record: scoreSignals (per-feed arrival offsets),
bookSignals (first book reprice ms), fireDtMs (fire vs first score signal),
and the package's 15s edge/cost path with persistence timers.

A second replay pass tracks each fired package's legs for up to 30 min after
the fire and stores edgeLife {move3cMs, halfGoneMs, goneMs, pulled, horizonMs,
censored} plus a cause label: "lag" (book repriced to our fair within 2 min —
stale-book money), "model" (quote persisted — market disagrees with pa_chain),
"quote" (sub-$1 package / >=35c edge / instantly pulled). This is computed at
collection time because raw recordings are pruned after COLLECT_RETAIN_DAYS.

After a successful collection the day's raw recordings + paper logs are
gzipped in place (COLLECT_COMPRESS=0 to disable). Ladder recording .gz older
than COLLECT_RETAIN_DAYS (default 21) are deleted; paper .gz are kept.

Usage:
  python3 scripts/collect-mlb-fire-samples.py            # yesterday (ET)
  python3 scripts/collect-mlb-fire-samples.py 2026-07-19 # explicit date
"""
import glob
import gzip
import json
import os
import re
import shutil
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTS_ARB_DATA_DIR") or ROOT / "data")
REPO_DIR = DATA_DIR / "backtest"
SAMPLES = REPO_DIR / "mlb-fire-samples.jsonl"
DAYS = REPO_DIR / "mlb-fire-days.jsonl"
ET = ZoneInfo("America/New_York")


def target_date() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    return (datetime.now(ET).date() - timedelta(days=1)).isoformat()


def parse_family(fam):
    """'7.5-12.5' -> (7.5, 12.5); spread '-4.5--2.5' -> (-4.5, -2.5)."""
    m = re.match(r"^(-?\d+\.5)-(-?\d+\.5)$", fam)
    if not m:
        raise ValueError(fam)
    return float(m.group(1)), float(m.group(2))


def jopen(path):
    """Open plain or gzipped JSONL transparently (post-collection archives)."""
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt")
    return open(path)


def head_kind(path, kind_field="kind"):
    """First few parsed lines of a JSONL file."""
    out = []
    with jopen(path) as fh:
        for _ in range(5):
            line = fh.readline()
            if not line:
                break
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


def paper_files_for(day: str):
    """Paper files whose init eventSlug is for `day` (UTC stamps can roll to day+1)."""
    d = date.fromisoformat(day)
    stamps = {day, (d + timedelta(days=1)).isoformat()}
    files = []
    for p in sorted(glob.glob(str(DATA_DIR / "mlb-middle-arb-paper-*.jsonl"))
                    + glob.glob(str(DATA_DIR / "mlb-middle-arb-paper-*.jsonl.gz"))):
        if not any(s in p for s in stamps):
            continue
        for o in head_kind(p):
            if o.get("kind") == "mlb_paper_init":
                if str(o.get("eventSlug") or "").find(day) >= 0:
                    files.append((p, str(o.get("eventSlug")), str(o.get("feedId"))))
                break
    return files


def recordings_for(day: str):
    """(slug, t_start, path) for recordings that could cover `day` games."""
    d = date.fromisoformat(day)
    stamps = {day, (d + timedelta(days=1)).isoformat()}
    recs = []
    for p in sorted(glob.glob(str(DATA_DIR / "ladder-lag-race-*.jsonl"))
                    + glob.glob(str(DATA_DIR / "ladder-lag-race-*.jsonl.gz"))):
        if not any(s in p for s in stamps):
            continue
        slug = None
        for o in head_kind(p):
            if o.get("kind") == "mlb_paper_init":
                slug = o.get("eventSlug")
                break
            if o.get("kind") == "target":
                slug = o.get("slug")
                break
        if not slug or day not in str(slug):
            continue
        with jopen(p) as fh:
            try:
                t0 = json.loads(fh.readline()).get("t") or 0
            except Exception:
                t0 = 0
        recs.append((slug, t0, p))
    return recs


def extract_fires(paper_files, day):
    """Every real wouldFire occurrence, deduped per (slug, score, package),
    enriched with ms timing from the matching mlb_paper_score_window."""
    fires, seen = [], set()
    windows = {}  # (slug, eventId) -> score_window record
    for path, slug, feed_id in paper_files:
        with jopen(path) as fh:
            for line in fh:
                if '"mlb_paper_score_event"' in line:
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    if o.get("kind") != "mlb_paper_score_event":
                        continue
                    if o.get("source") == "phone_ping" or o.get("booksFrozenAtTap"):
                        continue  # synthetic phone tests
                    wf = o.get("wouldFire") or [
                        g for g in (o.get("topEdgeGains") or []) if g.get("screenOk")
                    ]
                    for g in wf:
                        key = (slug, o.get("scoreAway"), o.get("scoreHome"),
                               g.get("venue"), g.get("lineFamily"), g.get("marketType"))
                        if key in seen:
                            continue
                        seen.add(key)
                        fires.append({
                            "day": day, "slug": slug, "feedId": feed_id,
                            "t": o.get("t"),
                            "eventId": o.get("eventId"),
                            "scoreT0": o.get("t0"),
                            "fireDtMs": (o.get("t") - o.get("t0"))
                            if o.get("t") and o.get("t0") else None,
                            "scoreAway": o.get("scoreAway"), "scoreHome": o.get("scoreHome"),
                            "source": o.get("source"),
                            "venue": g.get("venue"),
                            "marketType": g.get("marketType"),
                            "lineFamily": g.get("lineFamily"),
                            "cost0": g.get("cost0") or g.get("cost"),
                            "postEdge": g.get("postEdge"),
                        })
                elif '"mlb_paper_score_window"' in line:
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    if o.get("kind") == "mlb_paper_score_window":
                        windows[(slug, o.get("eventId"))] = o

    # Attach the 15s post-score window: feed-race ms, book first-move ms, and
    # this package's edge/cost path + persistence within the window.
    for f in fires:
        w = windows.get((f["slug"], f.get("eventId")))
        if not w:
            continue
        f["scoreSignals"] = w.get("scoreSignals")
        f["bookSignals"] = w.get("bookSignals")
        for pkg in w.get("watched") or []:
            if (pkg.get("venue") == f["venue"]
                    and pkg.get("lineFamily") == f["lineFamily"]
                    and pkg.get("marketType") == f["marketType"]):
                f["window"] = {
                    "preEdge": pkg.get("preEdge"),
                    "postEdge": pkg.get("postEdge"),
                    "edgeGain": pkg.get("edgeGain"),
                    "timeEdgeGeMarginMs": pkg.get("timeEdgeGeMarginMs"),
                    "timeCostPlus3cMs": pkg.get("timeCostPlus3cMs"),
                    "finalEdge": pkg.get("finalEdge"),
                    "finalCost": pkg.get("finalCost"),
                    "path": pkg.get("path"),
                }
                break
    return fires


def attach_tob(fires, recs):
    """Replay each recording to the fire timestamps and attach TOB legs."""
    def recording_for(slug, t):
        cands = [r for r in recs if r[0] == slug and r[1] <= t]
        return max(cands, key=lambda r: r[1])[2] if cands else None

    by_rec = defaultdict(list)
    for f in fires:
        rp = recording_for(f["slug"], f["t"])
        if rp:
            by_rec[rp].append(f)
        else:
            f["skip"] = "no recording"

    def resolve(f, book):
        lo, hi = parse_family(f["lineFamily"])
        venue = "kalshi" if f["venue"] == "kalshi" else "pm"
        if f["marketType"] == "game_total":
            f["legs"] = {"yes_lo": book.get((venue, "total", "", lo, "yes")),
                         "no_hi": book.get((venue, "total", "", hi, "no"))}
        else:  # spread: identify team by matching package cost at fire time
            best = None
            teams = {kk[2] for kk in book if kk[0] == venue and kk[1] == "spread"}
            for tm in teams:
                yes = book.get((venue, "spread", tm, hi, "yes"))
                no = book.get((venue, "spread", tm, lo, "no"))
                if yes and no:
                    d = abs(yes[0] + no[0] - (f["cost0"] or 0))
                    if best is None or d < best[0]:
                        best = (d, tm, yes, no)
            if best:
                f["team"] = best[1]
                f["legs"] = {"yes_lo": best[2], "no_hi": best[3]}

    for rp, fl in by_rec.items():
        fl.sort(key=lambda f: f["t"])
        tmax = fl[-1]["t"] + 1000
        book, idx = {}, 0
        with jopen(rp) as fh:
            for line in fh:
                if '"kind":"kalshi_ladder"' not in line and '"kind":"ladder"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                t = o.get("t") or 0
                while idx < len(fl) and t > fl[idx]["t"]:
                    resolve(fl[idx], book)
                    idx += 1
                if idx >= len(fl) and t > tmax:
                    break
                venue = "kalshi" if o.get("kind") == "kalshi_ladder" else "pm"
                klass = o.get("klass")
                if klass not in ("total", "spread"):
                    continue
                ln, side, ask = o.get("line"), o.get("side"), o.get("bestAsk")
                if ln is None or side not in ("yes", "no") or ask is None:
                    continue
                book[(venue, klass, o.get("teamKey") or "", float(ln), side)] = (
                    float(ask), float(o.get("bestAskSize") or 0))
            while idx < len(fl):
                resolve(fl[idx], book)
                idx += 1


EDGE_LIFE_HORIZON_MS = 30 * 60 * 1000


def package_leg_keys(f):
    """Book keys for the two legs of a fired package (matches attach_tob)."""
    lo, hi = parse_family(f["lineFamily"])
    venue = "kalshi" if f["venue"] == "kalshi" else "pm"
    if f["marketType"] == "game_total":
        return ((venue, "total", "", lo, "yes"), (venue, "total", "", hi, "no"))
    tm = f.get("team") or ""
    return ((venue, "spread", tm, hi, "yes"), (venue, "spread", tm, lo, "no"))


def attach_edge_life(fires, recs):
    """Replay each recording past the fire timestamps: how long did the fired
    edge survive at top-of-book before the package repriced to fair?"""
    def recording_for(slug, t):
        cands = [r for r in recs if r[0] == slug and r[1] <= t]
        return max(cands, key=lambda r: r[1])[2] if cands else None

    by_rec = defaultdict(list)
    for f in fires:
        if f.get("costFill") is None:
            continue
        rp = recording_for(f["slug"], f["t"])
        if rp:
            by_rec[rp].append(f)

    for rp, fl in by_rec.items():
        keys = set()
        for f in fl:
            keys.update(package_leg_keys(f))
        ticks, last_t = [], 0
        with jopen(rp) as fh:
            for line in fh:
                if '"kind":"kalshi_ladder"' not in line and '"kind":"ladder"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                t = o.get("t") or 0
                last_t = max(last_t, t)
                if o.get("klass") not in ("total", "spread"):
                    continue
                ln, side = o.get("line"), o.get("side")
                if ln is None or side not in ("yes", "no"):
                    continue
                venue = "kalshi" if o.get("kind") == "kalshi_ladder" else "pm"
                k = (venue, o.get("klass"), o.get("teamKey") or "", float(ln), side)
                if k in keys:
                    ask = o.get("bestAsk")
                    ticks.append((t, k, float(ask) if ask is not None else None))

        for f in fl:
            yes_k, no_k = package_leg_keys(f)
            cost0, edge = f["costFill"], f.get("postEdge") or 0
            asks = {}
            res = {"move3cMs": None, "halfGoneMs": None, "goneMs": None,
                   "pulled": False}
            t_fire = f["t"]
            t_end = t_fire + EDGE_LIFE_HORIZON_MS
            for t, k, ask in ticks:
                if t > t_end:
                    break
                if t <= t_fire:
                    asks[k] = ask
                    continue
                if k not in (yes_k, no_k):
                    continue
                asks[k] = ask
                dt = t - t_fire
                ya, na = asks.get(yes_k), asks.get(no_k)
                if ya is None or na is None:
                    # a leg's TOB ask was pulled: the fired liquidity is gone
                    res["pulled"] = True
                    if res["goneMs"] is None:
                        res["goneMs"] = dt
                    break
                cost = ya + na
                if res["move3cMs"] is None and cost >= cost0 + 0.03 - 1e-9:
                    res["move3cMs"] = dt
                if res["halfGoneMs"] is None and cost >= cost0 + edge / 2 - 1e-9:
                    res["halfGoneMs"] = dt
                if res["goneMs"] is None and cost >= cost0 + edge - 1e-9:
                    res["goneMs"] = dt
                    break
            res["horizonMs"] = min(last_t, t_end) - t_fire
            res["censored"] = res["goneMs"] is None
            f["edgeLife"] = res
            f["cause"] = classify_cause(f)


def classify_cause(f):
    """lag = stale-book reprice within 2 min; model = market persistently
    disagrees with pa_chain; quote = pricing error (pulled fast / absurd)."""
    el = f.get("edgeLife") or {}
    gone = el.get("goneMs")
    if el.get("pulled") and gone is not None and gone <= 60_000:
        return "quote"
    if (f.get("costFill") or 9) < 1.0 or (f.get("postEdge") or 0) >= 0.35:
        return "quote"
    if gone is not None and gone <= 120_000:
        return "lag"
    if gone is not None or (el.get("horizonMs") or 0) >= 120_000:
        return "model"
    return None  # not enough tape after the fire to judge


def fetch_finals(day: str):
    d = date.fromisoformat(day)
    url = (f"https://statsapi.mlb.com/api/v1/schedule?sportId=1"
           f"&date={d.strftime('%m/%d/%Y')}&hydrate=team,linescore")
    req = urllib.request.Request(url, headers={"User-Agent": "sports-arb-collect"})
    data = json.load(urllib.request.urlopen(req, timeout=20))
    finals = {}
    for dd in data.get("dates") or []:
        for g in dd.get("games") or []:
            a, h = g["teams"]["away"], g["teams"]["home"]
            finals[str(g["gamePk"])] = {
                "state": g["status"]["abstractGameState"],
                "away": a.get("score"), "home": h.get("score"),
                "homeName": h["team"]["name"], "awayName": a["team"]["name"],
            }
    return finals


def settle(fires, finals):
    for f in fires:
        legs = f.get("legs") or {}
        yes, no = legs.get("yes_lo"), legs.get("no_hi")
        fin = finals.get(f["feedId"])
        f["finalAway"] = fin and fin["away"]
        f["finalHome"] = fin and fin["home"]
        if not yes or not no:
            f.setdefault("skip", "missing legs")
            continue
        f["askYesLo"], f["sizeYesLo"] = yes
        f["askNoHi"], f["sizeNoHi"] = no
        f["costFill"] = round(yes[0] + no[0], 3)
        f["size"] = round(min(yes[1], no[1]), 1)
        if not fin or fin["state"] != "Final":
            f.setdefault("skip", "no final")
            continue
        lo, hi = parse_family(f["lineFamily"])
        if f["marketType"] == "game_total":
            total = (fin["away"] or 0) + (fin["home"] or 0)
            inside = lo < total < hi
        else:
            tm = f.get("team", "")
            home_key = fin["homeName"].lower().replace(" ", "-").replace(".", "")
            if tm and tm in home_key:
                margin = (fin["home"] or 0) - (fin["away"] or 0)
            else:
                margin = (fin["away"] or 0) - (fin["home"] or 0)
            s_lo, s_hi = abs(hi), abs(lo)
            inside = s_lo < margin < s_hi
        payout = 2.0 if inside else 1.0
        f["inside"] = inside
        f["pnlPer"] = round(payout - f["costFill"], 3)
        f["pnlTob"] = round((payout - f["costFill"]) * f["size"], 2)


def repo_keys():
    keys = set()
    if SAMPLES.exists():
        with open(SAMPLES) as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                keys.add((o.get("slug"), o.get("t"), o.get("venue"),
                          o.get("marketType"), o.get("lineFamily"),
                          o.get("scoreAway"), o.get("scoreHome")))
    return keys


def main():
    day = target_date()
    REPO_DIR.mkdir(parents=True, exist_ok=True)

    paper = paper_files_for(day)
    if not paper:
        print(f"{day}: no paper files found — nothing to collect")
        return
    print(f"{day}: {len(paper)} paper sessions across "
          f"{len({s for _, s, _ in paper})} games")

    fires = extract_fires(paper, day)
    print(f"{day}: {len(fires)} deduped wouldFire occurrences")
    recs = recordings_for(day)
    attach_tob(fires, recs)
    settle(fires, fetch_finals(day))
    attach_edge_life(fires, recs)

    # first-fire flag per unique package (the fill-once backtest view)
    first_seen = set()
    for f in sorted(fires, key=lambda f: f["t"] or 0):
        key = (f["slug"], f["venue"], f["marketType"], f["lineFamily"], f.get("team", ""))
        f["firstFire"] = key not in first_seen
        first_seen.add(key)

    existing = repo_keys()
    added = pending = 0
    with open(SAMPLES, "a") as out:
        for f in fires:
            if f.get("skip") == "no final":
                pending += 1  # game still live — pick it up on the next run
                continue
            key = (f["slug"], f["t"], f["venue"], f["marketType"], f["lineFamily"],
                   f["scoreAway"], f["scoreHome"])
            if key in existing:
                continue
            f["collectedAt"] = datetime.now().isoformat(timespec="seconds")
            out.write(json.dumps(f) + "\n")
            added += 1

    settled = [f for f in fires if "pnlTob" in f]
    uniq = [f for f in settled if f["firstFire"]]
    summary = {
        "day": day,
        "collectedAt": datetime.now().isoformat(timespec="seconds"),
        "games": len({s for _, s, _ in paper}),
        "fires": len(fires),
        "rowsAdded": added,
        "settled": len(settled),
        "pendingNoFinal": pending,
        "skipped": len(fires) - len(settled) - pending,
        "uniquePackages": len(uniq),
        "causes": {c: sum(1 for f in settled if f.get("cause") == c)
                   for c in ("lag", "model", "quote")},
        "pnlTobAllFires": round(sum(f["pnlTob"] for f in settled), 2),
        "pnlTobFirstFire": round(sum(f["pnlTob"] for f in uniq), 2),
        "notionalFirstFire": round(sum(f["costFill"] * f["size"] for f in uniq), 2),
    }
    day_logged = False
    if DAYS.exists():
        with open(DAYS) as fh:
            day_logged = any(f'"day": "{day}"' in ln or f'"day":"{day}"' in ln for ln in fh)
    if added > 0 or not day_logged:
        with open(DAYS, "a") as out:
            out.write(json.dumps(summary) + "\n")
    print(json.dumps(summary, indent=2))

    if pending == 0 and os.environ.get("COLLECT_COMPRESS", "1") != "0":
        compress_day(day)


def compress_day(day: str) -> None:
    """Gzip the collected day's raw JSONL and prune old archives (disk hygiene)."""
    d = date.fromisoformat(day)
    stamps = {day, (d + timedelta(days=1)).isoformat()}
    for pat in ("ladder-lag-race-*.jsonl", "mlb-middle-arb-paper-*.jsonl"):
        for p in glob.glob(str(DATA_DIR / pat)):
            if not any(s in p for s in stamps):
                continue
            if datetime.now().timestamp() - os.path.getmtime(p) < 3600:
                continue  # still being written by a live recorder
            try:
                with open(p, "rb") as src, gzip.open(p + ".gz", "wb", compresslevel=6) as dst:
                    shutil.copyfileobj(src, dst)
                os.remove(p)
            except Exception as e:
                print(f"compress failed for {p}: {e}")
    # Prune only the bulky ladder recordings (~200MB/day gz). Paper archives
    # (~1MB/day gz) are kept forever — they hold the score/window ms detail.
    retain = int(os.environ.get("COLLECT_RETAIN_DAYS", "21"))
    cutoff = (datetime.now(ET) - timedelta(days=retain)).timestamp()
    for p in glob.glob(str(DATA_DIR / "ladder-lag-race-*.jsonl.gz")):
        if os.path.getmtime(p) < cutoff:
            os.remove(p)


if __name__ == "__main__":
    main()
