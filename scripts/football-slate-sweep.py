#!/usr/bin/env python3
"""Football slate sweep — launch/reap football-ladder-race recorders.

The NFL/NCAAF sibling of mlb-slate-sweep.py. Runs every ~15 min from a timer.
Each sweep:
  1. pulls the ESPN scoreboard for both leagues
  2. launches a recorder for any game kicking off within LEAD_MIN minutes
     (or already live) that isn't running yet — staggered to avoid Kalshi 429s
  3. reaps recorders whose game is final

Unlike baseball, football recorders self-exit a couple of minutes after the
final whistle, so reaping is a safety net rather than the normal path.

Kalshi lists a game's total ladder well before kickoff but does not quote it
until close to kick, so launching early costs little and guarantees we catch
the book opening — which is itself a sample worth having.

Recorder logs -> $DATA_DIR/slate-logs/<slug>.log
pids -> $RUNTIME_DIR/slate-pids/<slug>.pid
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTS_ARB_DATA_DIR") or ROOT / "data")
RUNTIME_DIR = Path(os.environ.get("SPORTS_ARB_RUNTIME_DIR") or ROOT / ".runtime")
LOG_DIR = DATA_DIR / "slate-logs"
PID_DIR = RUNTIME_DIR / "slate-pids"
LEAD_MIN = int(os.environ.get("FB_SWEEP_LEAD_MIN", "45"))
STAGGER_SEC = int(os.environ.get("FB_SWEEP_STAGGER_SEC", "10"))
# The VPS has ~3.8 GB and a capped recorder measures ~56 MB RSS. A full
# college Saturday collides with a full MLB slate, and MLB is the one making
# money, so football takes what is left rather than the other way round.
# MIN_FREE_MB is the real limiter; this is a backstop against a slate so large
# that the sweep thrashes. Recorders exit shortly after their game ends, so
# these slots turn over across the day's kickoff waves.
MAX_CONCURRENT = int(os.environ.get("FB_SWEEP_MAX_CONCURRENT", "12"))
# Hard floor that protects the live MLB daemon from an OOM kill.
MIN_FREE_MB = int(os.environ.get("FB_SWEEP_MIN_FREE_MB", "700"))
# The box has a single core. Measured, a recorder costs 1-6% of it, so a full
# slate fits — but MLB's edge is measured in milliseconds after a score, and a
# saturated run queue shows up as scheduling delay on exactly that path. Stop
# adding football once the core is contended, even if RAM is free.
MAX_LOAD = float(os.environ.get("FB_SWEEP_MAX_LOAD", str(2.0 * (os.cpu_count() or 1))))
LEAGUES = [x for x in (os.environ.get("FB_SWEEP_LEAGUES") or "nfl,ncaaf").split(",") if x]
ET = ZoneInfo("America/New_York")
SYSTEMD = os.environ.get("SWEEP_SYSTEMD", "1" if sys.platform == "linux" else "0") == "1"
SYSTEMD_USER = os.environ.get("SWEEP_UNIT_USER", "sports-arb")
ENV_FILE = os.environ.get("SWEEP_ENV_FILE", "/etc/sports-arb.env")

ESPN_PATH = {"nfl": "football/nfl", "ncaaf": "football/college-football"}
# ESPN's edge 403s unrecognised user agents but lets curl through.
ESPN_UA = os.environ.get("ESPN_USER_AGENT", "curl/8.7.1")


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": ESPN_UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def parse_espn_time(value: str) -> datetime:
    """ESPN emits `2026-09-03T19:00Z` — minute precision, no seconds."""
    text = str(value).replace("Z", "+0000")
    for fmt in ("%Y-%m-%dT%H:%M%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise ValueError(f"unrecognised ESPN timestamp: {value}")


def slugify(text: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in text.lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def slate_window() -> list:
    """ET dates worth scanning: yesterday (still-running night game) to tomorrow."""
    today = datetime.now(ET).date()
    return [(today + timedelta(days=n)).strftime("%Y%m%d") for n in (-1, 0, 1)]


def discover(league: str) -> list:
    # `dates=` is load-bearing. A bare scoreboard call returns a curated,
    # rolling subset of the week: on 2 Sep 2026 it listed 25 college games and
    # none of Thursday's eleven, and 17 of Saturday's 68. Asking for explicit
    # ET dates returns the full slate for each.
    events, seen = [], set()
    for stamp in slate_window():
        url = (f"https://site.api.espn.com/apis/site/v2/sports/{ESPN_PATH[league]}"
               f"/scoreboard?dates={stamp}")
        try:
            board = fetch_json(url)
        except Exception as exc:  # one bad day must not blank the slate
            log(f"{league} scoreboard {stamp} failed: {exc}")
            continue
        for event in board.get("events", []):
            if str(event.get("id")) in seen:
                continue
            seen.add(str(event.get("id")))
            events.append(event)

    games = []
    for event in events:
        comp = (event.get("competitions") or [{}])[0]
        if not comp:
            continue
        sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}
        home, away = sides.get("home") or {}, sides.get("away") or {}
        start = parse_espn_time(event["date"])
        away_abbr = (away.get("team") or {}).get("abbreviation") or ""
        home_abbr = (home.get("team") or {}).get("abbreviation") or ""
        date_et = start.astimezone(ET).date().isoformat()
        games.append({
            "league": league,
            "espn_id": str(event["id"]),
            "slug": f"{league}-{slugify(away_abbr)}-{slugify(home_abbr)}-{date_et}",
            "short": event.get("shortName") or "",
            "start": start,
            "state": (comp.get("status") or {}).get("type", {}).get("state", "pre"),
        })
    return games


def available_mb() -> int:
    """MemAvailable in MB, or a large number where /proc is unavailable."""
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 1 << 20


def unit_name(slug: str) -> str:
    return f"flr-{slug}.service"


def recorder_running(slug: str):
    if SYSTEMD:
        r = subprocess.run(["systemctl", "is-active", "--quiet", unit_name(slug)])
        return unit_name(slug) if r.returncode == 0 else None
    pid_file = PID_DIR / f"{slug}.pid"
    if not pid_file.exists():
        return None
    try:
        pid = int(pid_file.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (ValueError, OSError):
        pid_file.unlink(missing_ok=True)
        return None


def stop_recorder(slug: str, handle) -> None:
    if SYSTEMD:
        subprocess.run(["systemctl", "stop", unit_name(slug)])
        subprocess.run(["systemctl", "reset-failed", unit_name(slug)], stderr=subprocess.DEVNULL)
        return
    try:
        os.killpg(os.getpgid(handle), signal.SIGTERM)
    except OSError:
        try:
            os.kill(handle, signal.SIGTERM)
        except OSError:
            pass
    (PID_DIR / f"{slug}.pid").unlink(missing_ok=True)


def launch(game: dict) -> None:
    slug = game["slug"]
    log_file = LOG_DIR / f"{slug}.log"
    flr_env = {
        "FLR_LEAGUE": game["league"],
        "FLR_ESPN_EVENT": game["espn_id"],
        # Nineteen tickers and a write stream need nowhere near Node's default
        # heap, and the ceiling keeps a full slate inside the memory budget.
        "NODE_OPTIONS": "--max-old-space-size=96",
    }
    local_tsx = ROOT / "node_modules" / ".bin" / "tsx"
    recorder_cmd = ([str(local_tsx)] if local_tsx.exists() else ["npx", "tsx"]) \
        + ["scripts/football-ladder-race.ts"]

    if SYSTEMD:
        cmd = ["systemd-run", f"--unit={unit_name(slug)}", "--collect",
               f"--property=User={SYSTEMD_USER}",
               f"--property=WorkingDirectory={ROOT}",
               f"--property=EnvironmentFile={ENV_FILE}",
               f"--property=StandardOutput=append:{log_file}",
               f"--property=StandardError=append:{log_file}",
               # A full Saturday slate must not starve the MLB live daemon.
               "--property=CPUWeight=30",
               "--property=MemoryHigh=200M",
               "--property=MemoryMax=320M",
               "--property=Nice=10"]
        for k, v in flr_env.items():
            cmd.append(f"--setenv={k}={v}")
        cmd += recorder_cmd
        subprocess.run(cmd, check=True, capture_output=True)
        log(f"launched {slug} ({game['short']}) unit={unit_name(slug)}")
        return

    env = os.environ.copy()
    env.update(flr_env)
    with open(log_file, "a") as lf:
        p = subprocess.Popen(recorder_cmd, cwd=ROOT, env=env, stdout=lf, stderr=lf,
                             start_new_session=True)
    (PID_DIR / f"{slug}.pid").write_text(str(p.pid))
    log(f"launched {slug} pid={p.pid}")


def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PID_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)

    games = []
    for league in LEAGUES:
        for attempt in range(3):
            try:
                games += discover(league)
                break
            except OSError as e:
                log(f"{league} discover failed (attempt {attempt + 1}): {e}")
                time.sleep(20)
    log(f"sweep: {len(games)} games across {','.join(LEAGUES)}")

    running = sum(1 for g in games if recorder_running(g["slug"]))
    launched = 0
    for game in sorted(games, key=lambda g: g["start"]):
        slug = game["slug"]
        handle = recorder_running(slug)

        if game["state"] == "post":
            if handle:
                log(f"reaping {slug} (final)")
                stop_recorder(slug, handle)
                running -= 1
            continue
        if handle:
            continue

        mins_to_start = (game["start"] - now).total_seconds() / 60
        if game["state"] != "in" and mins_to_start > LEAD_MIN:
            continue
        if running >= MAX_CONCURRENT:
            log(f"at MAX_CONCURRENT={MAX_CONCURRENT}, deferring {slug}")
            continue
        free_mb = available_mb()
        if free_mb < MIN_FREE_MB:
            log(f"only {free_mb} MB available (floor {MIN_FREE_MB}), deferring {slug}")
            continue
        load1 = os.getloadavg()[0]
        if load1 > MAX_LOAD:
            log(f"load {load1:.2f} over {MAX_LOAD:.2f}, deferring {slug} to protect MLB")
            continue

        try:
            launch(game)
            running += 1
            launched += 1
            time.sleep(STAGGER_SEC)
        except subprocess.CalledProcessError as e:
            log(f"launch failed for {slug}: {(e.stderr or b'').decode()[:200]}")

    log(f"sweep done: {launched} launched, {running} recording")


if __name__ == "__main__":
    main()
