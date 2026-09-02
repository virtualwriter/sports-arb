# Server Paths

## Sports Arb Host

The sports-arb repo owns the always-on websocket sports monotonic-arb daemon.

- Production repo path: `/opt/sports-arb`
- Runtime state path: `/var/lib/sports-arb`
- Env file: `/etc/sports-arb.env`
- Systemd unit: `sports-arb-daemon.service`
- Systemd unit source in this extraction: `deploy/sports-arb-daemon.service`
- Production wrapper path: `/usr/local/bin/run-sports-arb-daemon`
- Wrapper source in this extraction: `scripts/run-sports-arb-daemon.sh`
- Governing script: `scripts/govern-sports-middle-daemon.sh`

## Polymarket Trader Host

The parent polymarket-trader repo keeps its own automatic trader path. The
sports-arb daemon governance script must not disable these units.

- Production repo path: `/opt/polymarket-trader`
- Runtime state path: `/var/lib/polymarket-trader`
- Env file: `/etc/polymarket-trader.env`
- Hourly trader unit: `polymarket-trader.service`
- Hourly trader timer: `polymarket-trader.timer`
- Production wrapper path: `/usr/local/bin/run-polymarket-trader`

## Kalshi NYC weather recorder (VPS)

Always-on WS + REST tape for `KXTEMPNYCH` hourlies and `KXHIGHNY` /
`KXLOWNY` dailies (books with quote sizes, taker/maker trades, METAR, TWC):

- Script: `scripts/kalshi-nyc-weather-tracker.ts` (`npm run weather:kalshi-nyc`)
- Unit: `deploy/kalshi-nyc-weather-tracker.service` → `kalshi-nyc-weather-tracker.service`
- Data: `/var/lib/sports-arb/data/weather/weather-kalshi-nyc-YYYY-MM-DD.jsonl`
- Env: `/etc/sports-arb.env` + `/etc/kalshi.env` (WS needs Kalshi API key)

Interactive **current-hour desk** (SSH/tmux — live books, METAR/TWC/:51
alerts, thermometer → +EV recos, confirm-to-trade):

- Script: `scripts/kalshi-nyc-hourly-desk.ts` (`npm run weather:hourly-desk`)
- Launch (root loads `/etc/sports-arb.env`, then drops to `sports-arb`):
  `sudo bash /opt/sports-arb/scripts/launch-hourly-desk.sh`
- Live orders: `sudo WEATHER_HOURLY_LIVE=1 bash /opt/sports-arb/scripts/launch-hourly-desk.sh`
  (still prompts `y/N` before each send; default is dry-run)
- Order log: `/var/lib/sports-arb/data/weather/hourly-desk-orders-YYYY-MM-DD.jsonl`
- Commands: `temp 74.2`, `books`, `buy 1`, `size 10`, `sigma 0.7`, `bias 0`, `status`

## MLB daily recorder pipeline (VPS)

Runs on the Dublin VPS (`root@72.11.157.79`), isolated from the live daemon
checkout so deploys/restarts don't interact:

- Repo path: `/opt/sports-arb-recorder` (rsynced `scripts/` + model JSONs from
  `analysis/`, own `node_modules`; not a git checkout)
- Data: `/var/lib/sports-arb-recorder/data` (recordings, paper logs,
  `slate-logs/`, `backtest/mlb-fire-samples.jsonl` + `backtest/mlb-fire-days.jsonl`)
- Env file: `/etc/sports-arb-recorder.env` (data dirs + Kalshi API key)
- `sports-arb-mlb-slate-sweep.timer` — every 30 min (:05/:35), launches one
  `plr-<slug>.service` transient unit per game within 60 min of first pitch
  (user `sports-arb`, CPUWeight=50, MemoryMax=500M) and reaps final games
- `sports-arb-mlb-fire-collect.timer` — 08:30 UTC (4:30 ET), settles
  yesterday's wouldFire samples into the backtest repo, then gzips that day's
  raw JSONL (21-day retention for `.gz`)
- Unit sources in this repo: `deploy/sports-arb-mlb-slate-sweep.*`,
  `deploy/sports-arb-mlb-fire-collect.*`
- Redeploy: rsync `scripts/`, `package.json`, and the two model JSONs, then
  `npm install --omit=dev` in `/opt/sports-arb-recorder`

## Football recorder pipeline (VPS)

NFL + college football total-points ladders, recorded to find a football
analogue of the MLB next-line over. Shares the recorder checkout and data dir
with the MLB pipeline.

- Recorder: `scripts/football-ladder-race.ts`, one process per game
  (`FLR_LEAGUE=nfl|ncaaf`, `FLR_ESPN_EVENT=<espn id>`)
- Kalshi series: `KXNFLTOTAL` / `KXNCAAFTOTAL`, matched to a game by event
  title; football sits on **exchange shard 0**, not the sports shard 3
- Game state: ESPN scoreboard (no key). Its edge 403s unknown user agents, so
  callers claim to be `curl/8.7.1`; responses are cached to
  `$TMPDIR/sports-arb-espn` for 2.5s so co-located recorders share one fetch
- Odds/fast score: bwin **sportId 11** (American Football)
- Data: `/var/lib/sports-arb-recorder/data/football-ladder-race-<slug>-<ts>.jsonl`,
  slug `<league>-<away>-<home>-<date>` (e.g. `ncaaf-uapb-miz-2026-09-03`)
- `sports-arb-football-slate-sweep.timer` — every 15 min, launches one
  `flr-<slug>.service` per game within 45 min of kickoff. Capped by
  `FB_SWEEP_MAX_CONCURRENT` (12) and a `FB_SWEEP_MIN_FREE_MB` (700) floor that
  protects the MLB daemon; recorders run with a 96 MB Node heap (~56 MB RSS)
- `sports-arb-football-compact.timer` — 09:30 UTC, gzips finished captures and
  prunes archives older than `FOOTBALL_RETAIN_DAYS` (45)
- Recorders self-exit ~2 min after the final whistle; the sweep reaps stragglers

## Dublin / Ireland

Dublin trading VPS identified by operator:

- Hostname: `GG112ICCETN89F88CYLA.tradingvps.io`
- IP: `72.11.157.79`

### Pinnacle MLB odds feed (local broker → VPS)

Pinnacle guest odds are scraped on a residential Mac via Playwright
(`npm run pinnacle:mlb-broker`), then optionally rsynced to the VPS:

```bash
# Terminal A — normal Chrome (solve CF checkbox once)
npm run pinnacle:chrome

# Terminal B — attach + poll (do not relaunch Chrome)
PINNACLE_CDP_URL=http://127.0.0.1:9222 \
PINNACLE_VPS_HOST=root@72.11.157.79 \
PINNACLE_VPS_PUSH=1 \
npm run pinnacle:mlb-broker
```

Playwright-launched browsers tend to loop Cloudflare challenges; CDP attach avoids that.

SSH: use `root@72.11.157.79` (key auth already works). `sports-arb@` currently has no authorized key from this Mac.

Remote landing path (shadow feed only; daemon hot path unchanged):

- `/var/lib/sports-arb/data/pinnacle-mlb-odds-latest.json`
- `/var/lib/sports-arb/data/pinnacle-mlb-odds.jsonl` (if `PINNACLE_PUSH_JSONL=1`)

No file in the current repo explicitly names this Dublin server or a Dublin-specific deploy path. The only Ireland-related runtime reference found is `IE` / `Ireland` in `scripts/lib/VpnGuard.ts`, where Ireland is part of the allowed VPN country list.

If the Dublin machine uses the standard parent-trader layout from `docs/reference/new-machine-live-handoff.md`, the expected paths are the same generic production paths:

- Repo path: `/opt/polymarket-trader`
- Runtime state path: `/var/lib/polymarket-trader`
- Env file: `/etc/polymarket-trader.env`

The old VPS address referenced by the handoff doc is `root@96.30.198.111`, but it is not labeled as Dublin in the repo.
