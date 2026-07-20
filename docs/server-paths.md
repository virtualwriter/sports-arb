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
