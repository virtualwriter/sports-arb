#!/usr/bin/env python3
"""Daily MLB slate daemon sweep — launch/reap ladder-lag-race recorders.

Runs every ~30 min from systemd (sports-arb-mlb-slate-sweep.timer on the VPS)
or launchd (com.sports-arb.mlb-slate-sweep on a Mac). Each sweep:
  1. pulls today's (ET) StatsAPI schedule + open Kalshi KXMLBTOTAL events
  2. launches a recorder for any game starting within LEAD_MIN minutes
     (or already live) that isn't running yet — staggered to avoid Kalshi 429s
  3. kills recorders whose game is Final (recorders never self-exit)

Recorder logs -> $DATA_DIR/slate-logs/<slug>.log,
pids -> $RUNTIME_DIR/slate-pids/<slug>.pid
(supersedes scripts/launch-mlb-slate.sh for daily use).
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTS_ARB_DATA_DIR") or ROOT / "data")
RUNTIME_DIR = Path(os.environ.get("SPORTS_ARB_RUNTIME_DIR") or ROOT / ".runtime")
LOG_DIR = DATA_DIR / "slate-logs"
PID_DIR = RUNTIME_DIR / "slate-pids"
LEAD_MIN = int(os.environ.get("SWEEP_LEAD_MIN", "60"))
STAGGER_SEC = int(os.environ.get("SWEEP_STAGGER_SEC", "15"))
ET = ZoneInfo("America/New_York")
# On Linux the sweep is a timer-run oneshot whose cgroup dies with it, so
# recorders run as transient systemd units. On the Mac they are detached pids.
SYSTEMD = os.environ.get("SWEEP_SYSTEMD", "1" if sys.platform == "linux" else "0") == "1"
SYSTEMD_USER = os.environ.get("SWEEP_UNIT_USER", "sports-arb")
ENV_FILE = os.environ.get("SWEEP_ENV_FILE", "/etc/sports-arb.env")

PM_TEAM = {
    "ARI": "ari", "AZ": "ari", "ATH": "oak", "ATL": "atl", "BAL": "bal", "BOS": "bos",
    "CHC": "chc", "CHW": "cws", "CIN": "cin", "CLE": "cle", "COL": "col", "CWS": "cws",
    "DET": "det", "HOU": "hou", "KC": "kc", "KCR": "kc", "LAA": "laa", "LAD": "lad",
    "MIA": "mia", "MIL": "mil", "MIN": "min", "NYM": "nym", "NYY": "nyy", "OAK": "oak",
    "PHI": "phi", "PIT": "pit", "SD": "sd", "SDP": "sd", "SEA": "sea", "SF": "sf",
    "SFG": "sf", "STL": "stl", "TB": "tb", "TBR": "tb", "TEX": "tex", "TOR": "tor",
    "WSH": "wsh", "WSN": "wsh",
}
KALSHI_ALIAS = {"CHW": "CWS", "KCR": "KC", "SDP": "SD", "SFG": "SF", "TBR": "TB",
                "WSN": "WSH", "ARI": "AZ", "OAK": "ATH"}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "sports-arb-sweep"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def pm_team(code: str) -> str:
    return PM_TEAM.get(code.upper(), code.lower())


def load_kalshi_env() -> dict:
    """Kalshi WS auth, same lookup order as launch-mlb-slate.sh."""
    env = {}
    for p in (Path.home() / ".kalshi.env", ROOT / ".kalshi.env", Path("/etc/kalshi.env")):
        if p.is_file():
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
            break
    return env


def discover_today():
    """Today's games with slugs, start times, status, and Kalshi totals tickers."""
    today = datetime.now(ET).date()  # slate day is ET regardless of host tz
    iso = today.isoformat()
    sched = fetch_json(
        f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={today.strftime('%m/%d/%Y')}&hydrate=team"
    )

    kalshi_by_matchup = {}
    try:
        kevents = fetch_json(
            "https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXMLBGAME&status=open&limit=200"
        ).get("events") or []
        day_tag = f"{today.year % 100:02d}{today.strftime('%b').upper()}{today.day:02d}"
        for ev in kevents:
            ticker = str(ev.get("event_ticker") or "")
            if not ticker.startswith("KXMLBGAME-") or day_tag not in ticker:
                continue
            stamp = ticker[len("KXMLBGAME-"):]
            matchup = stamp[len(day_tag) + 4:]  # after date+HHMM
            game2 = matchup.endswith("G2")
            matchup = matchup.replace("G2", "").upper()
            kalshi_by_matchup[(matchup, 2 if game2 else 1)] = f"KXMLBTOTAL-{stamp}"
    except Exception as e:
        log(f"kalshi prefill skipped: {e}")

    games = []
    for day in sched.get("dates") or []:
        for game in day.get("games") or []:
            away = game["teams"]["away"]["team"]
            home = game["teams"]["home"]["team"]
            away_code = away.get("abbreviation") or away.get("fileCode") or ""
            home_code = home.get("abbreviation") or home.get("fileCode") or ""
            game_no = game.get("gameNumber", 1)
            slug = f"mlb-{pm_team(away_code)}-{pm_team(home_code)}-{iso}"
            if game.get("doubleHeader") == "Y" and game_no > 1:
                slug += f"-game-{game_no}"
            k_away = KALSHI_ALIAS.get(away_code.upper(), away_code.upper())
            k_home = KALSHI_ALIAS.get(home_code.upper(), home_code.upper())
            kalshi = kalshi_by_matchup.get((f"{k_away}{k_home}", game_no), "")
            start = datetime.fromisoformat(game["gameDate"].replace("Z", "+00:00"))
            games.append({
                "slug": slug,
                "gamePk": str(game["gamePk"]),
                "kalshiEvent": kalshi,
                "start": start,
                "state": str(game.get("status", {}).get("abstractGameState") or ""),
            })
    return games


def unit_name(slug: str) -> str:
    return f"plr-{slug}.service"


def recorder_running(slug: str):
    """Truthy handle if a recorder for slug is alive (pid or unit name)."""
    if SYSTEMD:
        r = subprocess.run(["systemctl", "is-active", "--quiet", unit_name(slug)])
        return unit_name(slug) if r.returncode == 0 else None
    pid_file = PID_DIR / f"{slug}.pid"
    try:
        pid = int(pid_file.read_text().strip())
    except Exception:
        return None
    try:
        os.kill(pid, 0)
        return pid
    except OSError:
        return None


def stop_recorder(slug: str, handle) -> None:
    if SYSTEMD:
        subprocess.run(["systemctl", "stop", unit_name(slug)])
        subprocess.run(["systemctl", "reset-failed", unit_name(slug)],
                       stderr=subprocess.DEVNULL)
        return
    try:
        os.killpg(os.getpgid(handle), signal.SIGTERM)
    except OSError:
        try:
            os.kill(handle, signal.SIGTERM)
        except OSError:
            pass
    (PID_DIR / f"{slug}.pid").unlink(missing_ok=True)


def launch(slug: str, kalshi_event: str, extra_env: dict) -> None:
    log_file = LOG_DIR / f"{slug}.log"
    plr_env = {
        "PLR_MODE": "mlb",
        "PLR_SLUG": slug,
        "PLR_MLB_PAPER_ALL_SHAPES": "1",
        "PLR_KALSHI": "1",
    }
    if kalshi_event:
        plr_env["PLR_KALSHI_EVENT"] = kalshi_event

    local_tsx = ROOT / "node_modules" / ".bin" / "tsx"
    recorder_cmd = (
        [str(local_tsx)] if local_tsx.exists() else ["npx", "tsx"]
    ) + ["scripts/ladder-lag-race.ts", "record"]

    if SYSTEMD:
        cmd = ["systemd-run", f"--unit={unit_name(slug)}", "--collect",
               f"--property=User={SYSTEMD_USER}",
               f"--property=WorkingDirectory={ROOT}",
               f"--property=EnvironmentFile={ENV_FILE}",
               f"--property=StandardOutput=append:{log_file}",
               f"--property=StandardError=append:{log_file}",
               # keep a full slate of recorders from starving the live daemon
               "--property=CPUWeight=50",
               "--property=MemoryHigh=300M",
               "--property=MemoryMax=500M",
               "--property=Nice=5"]
        for k, v in plr_env.items():
            cmd.append(f"--setenv={k}={v}")
        cmd += recorder_cmd
        subprocess.run(cmd, check=True, capture_output=True)
        log(f"launched {slug} unit={unit_name(slug)} kalshi={kalshi_event or '-'}")
        return

    env = os.environ.copy()
    env.update(extra_env)
    env.update(plr_env)
    env.pop("PLR_BWIN_FIXTURE", None)
    if not kalshi_event:
        env.pop("PLR_KALSHI_EVENT", None)
    cmd = recorder_cmd
    if sys.platform == "darwin":
        cmd = ["caffeinate", "-dims", *cmd]  # keep the Mac awake while recording
    with open(log_file, "a") as lf:
        p = subprocess.Popen(
            cmd, cwd=ROOT, env=env, stdout=lf, stderr=lf, start_new_session=True,
        )
    (PID_DIR / f"{slug}.pid").write_text(str(p.pid))
    log(f"launched {slug} pid={p.pid} kalshi={kalshi_event or '-'}")


def main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PID_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    # launchd fires missed jobs right after wake, before DNS is back — retry.
    games = None
    for attempt in range(4):
        try:
            games = discover_today()
            break
        except OSError as e:
            log(f"discover failed (attempt {attempt + 1}): {e}")
            time.sleep(30)
    if games is None:
        games = discover_today()
    log(f"sweep: {len(games)} games on today's slate")
    kalshi_env = load_kalshi_env()

    # Split doubleheaders (statsapi doubleHeader "S") share one PM slug, so
    # group per slug: one recorder covers the slug until every game is final.
    by_slug = defaultdict(list)
    for g in games:
        by_slug[g["slug"]].append(g)

    launched = 0
    for slug, group in by_slug.items():
        handle = recorder_running(slug)

        if all(g["state"] == "Final" for g in group):
            if handle:
                log(f"reaping {slug} ({handle}, all games final)")
                stop_recorder(slug, handle)
            continue

        if handle:
            continue  # already recording

        active = [g for g in group if g["state"] != "Final"]
        mins_to_start = min((g["start"] - now).total_seconds() / 60 for g in active)
        if all(g["state"] != "Live" for g in active) and mins_to_start > LEAD_MIN:
            continue  # too early

        kalshi = next((g["kalshiEvent"] for g in active if g["kalshiEvent"]), "")
        if launched > 0:
            time.sleep(STAGGER_SEC)  # avoid Kalshi rate limits on multi-launch
        try:
            launch(slug, kalshi, kalshi_env)
            launched += 1
        except Exception as e:
            log(f"launch failed for {slug}: {e}")

    # clean pid files whose process died (crash) so next sweep can relaunch
    if not SYSTEMD:
        for pf in PID_DIR.glob("mlb-*.pid"):
            slug = pf.stem
            if recorder_running(slug) is None:
                pf.unlink(missing_ok=True)

    log(f"sweep done ({launched} launched)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"sweep fatal: {e}")
        sys.exit(1)
