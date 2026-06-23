# New Machine Live Trader Handoff

This runbook moves the live trader from the current VPS to a new machine that will be used for live trading, coding, and Cursor review.

Assumption for this runbook: the old VPS trader services have been stopped and disabled before the live state sync, so no state files are changing while you copy them.

## 1. Stop the old VPS first

Run this on the old VPS before copying live state:

```bash
sudo systemctl stop polymarket-trader.timer polymarket-trader.service
sudo systemctl stop polymarket-exit-scanner.timer polymarket-exit-scanner.service
sudo systemctl stop polymarket-daily-report.timer polymarket-daily-report.service
sudo systemctl stop polymarket-manual-shadow.service

sudo systemctl disable polymarket-trader.timer
sudo systemctl disable polymarket-exit-scanner.timer
sudo systemctl disable polymarket-daily-report.timer
sudo systemctl disable polymarket-manual-shadow.service

systemctl list-units 'polymarket*' --all --no-pager
systemctl list-unit-files 'polymarket*' --no-pager
```

Expected result: no `polymarket-*` unit should be `active/running`, and the timer/service unit files should not be enabled on the old VPS. This prevents split-brain trading.

## 2. Prepare the new machine

Install system packages:

```bash
sudo apt-get update
sudo apt-get install -y git curl rsync python3 python3-pip python3-venv build-essential
```

Install Node.js if it is not already installed. The repo currently expects a modern Node runtime compatible with TypeScript/tsx:

```bash
node --version
npm --version
```

If Node is missing, install it with your preferred Node manager or distro package before continuing.

## 3. Clone GitHub on the new machine

Use `/opt/polymarket-trader` for production so the copied systemd wrappers work without edits:

```bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
cd /opt
git clone git@github.com:virtualwriter/polymarket-trader.git
cd /opt/polymarket-trader
git status
git log -5 --oneline
npm ci
npm run build
```

Expected result: build passes and `git status` is clean.

## 4. Sync ignored files from the old VPS

From the new machine, inside `/opt/polymarket-trader`:

```bash
scripts/sync-runtime-state.sh root@96.30.198.111:/opt/polymarket-trader . --include-live-state
```

This copies:

- `config.env`
- `data/instrument-snapshots.jsonl`
- `data/instrument-snapshot-archives/`
- `data/daily-email-reports/`
- `/var/lib/polymarket-trader/portfolio-live.json` into `.runtime/portfolio-live.json`
- `/var/lib/polymarket-trader/pending-closed-trades.jsonl` into `.runtime/pending-closed-trades.jsonl`

The large file is `data/instrument-snapshots.jsonl`; it can be hundreds of MB. `rsync` is intentional because it can resume and verify the transfer better than manual copy.

## 5. Install production live state directory

The live services must read and write `/var/lib/polymarket-trader`, not `.runtime/`.

```bash
sudo mkdir -p /var/lib/polymarket-trader
sudo cp .runtime/portfolio-live.json /var/lib/polymarket-trader/portfolio-live.json
sudo cp .runtime/pending-closed-trades.jsonl /var/lib/polymarket-trader/pending-closed-trades.jsonl 2>/dev/null || sudo touch /var/lib/polymarket-trader/pending-closed-trades.jsonl
sudo chmod 700 /var/lib/polymarket-trader
sudo chmod 600 /var/lib/polymarket-trader/*
```

Verify:

```bash
ls -lah /var/lib/polymarket-trader
ls -lah .runtime
```

Production services should update files under `/var/lib/polymarket-trader`. `.runtime/` is only the local fallback and transfer staging area.

## 6. Install secrets and environment files

The repo includes `config.env.example`, but real secrets must stay outside GitHub.

Create `/etc/polymarket-trader.env` on the new machine with the real values from your secure source or from the old VPS:

```bash
sudo scp root@96.30.198.111:/etc/polymarket-trader.env /etc/polymarket-trader.env
sudo chmod 600 /etc/polymarket-trader.env
```

Current expected keys include:

```text
ANTHROPIC_API_KEY
TRADINGVIEW_OPTIONS_ENABLED
TRADINGVIEW_OPTIONS_MAX_ROWS
TRADINGVIEW_OPTIONS_COLLECTOR_TIMEOUT_MS
TRADINGVIEW_COOKIE
OPTIONS_COLLECTOR_MAX_BUFFER_BYTES
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ENABLE_MONOTONIC_ARB_REAL_PM
DISABLE_REAL_PM_TRADING
MONOTONIC_ARB_REAL_PM_DRY_RUN
MONOTONIC_ARB_REAL_PM_BUILD_ONLY
MONOTONIC_ARB_REAL_PM_SOURCE
MONOTONIC_ARB_REAL_PM_PACKAGE_ID
MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD
MONOTONIC_ARB_REAL_PM_MAX_DAILY_USD
MONOTONIC_ARB_REAL_PM_MAX_PER_RUN
MONOTONIC_ARB_REAL_PM_MIN_AVAILABLE_SHARES
POLYMARKET_RELAYER_TX_TYPE
POLYMARKET_PROXY_WALLET_ADDRESS
POLYMARKET_SIGNATURE_TYPE
POLYMARKET_FUNDER_ADDRESS
RELAYER_API_KEY
RELAYER_API_KEY_ADDRESS
POLY_BUILDER_CODE
POLY_BUILDER_API_KEY
POLY_BUILDER_PASSPHRASE
POLY_BUILDER_SECRET
```

For first real Polymarket monotonic-arb launch, keep the executor hard-disabled
until the relayer transaction builder has been reviewed:

```text
ENABLE_MONOTONIC_ARB_REAL_PM=0
DISABLE_REAL_PM_TRADING=1
MONOTONIC_ARB_REAL_PM_DRY_RUN=1
MONOTONIC_ARB_REAL_PM_BUILD_ONLY=0
MONOTONIC_ARB_REAL_PM_PACKAGE_ID=
MONOTONIC_ARB_REAL_PM_MIN_AVAILABLE_SHARES=10
MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD=20
MONOTONIC_ARB_REAL_PM_MAX_PACKAGE_USD_CEILING=20
MONOTONIC_ARB_REAL_PM_MAX_DAILY_USD=200
MONOTONIC_ARB_REAL_PM_MAX_PER_RUN=1
POLYMARKET_RELAYER_TX_TYPE=PROXY
POLYMARKET_PROXY_WALLET_ADDRESS=0x...
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_FUNDER_ADDRESS=0x... # same as proxy wallet unless intentionally overridden
```

If using the manual shadow endpoint, also copy its environment file:

```bash
sudo scp root@96.30.198.111:/etc/polymarket-manual-shadow.env /etc/polymarket-manual-shadow.env
sudo chmod 600 /etc/polymarket-manual-shadow.env
```

Expected keys:

```text
MANUAL_SHADOW_API_TOKEN
MANUAL_SHADOW_UI_TOKEN
MANUAL_SHADOW_HOST
MANUAL_SHADOW_PORT
```

For local CLI scripts that read `config.env`, keep the synced `/opt/polymarket-trader/config.env` in place. Do not commit it.

## 7. Install runner wrappers

Copy the production wrappers from the old VPS or recreate them exactly.

```bash
sudo scp root@96.30.198.111:/usr/local/bin/run-polymarket-trader /usr/local/bin/run-polymarket-trader
sudo scp root@96.30.198.111:/usr/local/bin/run-polymarket-exit-scanner /usr/local/bin/run-polymarket-exit-scanner
sudo scp root@96.30.198.111:/usr/local/bin/run-polymarket-daily-report /usr/local/bin/run-polymarket-daily-report
sudo chmod +x /usr/local/bin/run-polymarket-trader /usr/local/bin/run-polymarket-exit-scanner /usr/local/bin/run-polymarket-daily-report
```

Verify the trader and scanner wrappers contain this state-dir export:

```bash
grep POLYMARKET_TRADER_STATE_DIR /usr/local/bin/run-polymarket-trader
grep POLYMARKET_TRADER_STATE_DIR /usr/local/bin/run-polymarket-exit-scanner
```

Expected result:

```bash
export POLYMARKET_TRADER_STATE_DIR="$STATE_DIR"
```

Also verify `STATE_DIR` is `/var/lib/polymarket-trader`:

```bash
grep 'STATE_DIR=' /usr/local/bin/run-polymarket-trader /usr/local/bin/run-polymarket-exit-scanner
```

## 8. Install systemd units

Create these files on the new machine.

`/etc/systemd/system/polymarket-trader.timer`:

```ini
[Unit]
Description=Run Polymarket trader hourly at minute 27

[Timer]
OnCalendar=*-*-* *:27:00
Persistent=true
Unit=polymarket-trader.service

[Install]
WantedBy=timers.target
```

`/etc/systemd/system/polymarket-trader.service`:

```ini
[Unit]
Description=Polymarket trader hourly scan and trade
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/polymarket-trader
EnvironmentFile=/etc/polymarket-trader.env
ExecStart=/usr/local/bin/run-polymarket-trader
TimeoutStartSec=20m
```

`/etc/systemd/system/polymarket-exit-scanner.timer`:

```ini
[Unit]
Description=Run Polymarket exit scanner every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s
Persistent=true
Unit=polymarket-exit-scanner.service

[Install]
WantedBy=timers.target
```

`/etc/systemd/system/polymarket-exit-scanner.service`:

```ini
[Unit]
Description=Polymarket lightweight exit scanner
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/polymarket-trader
EnvironmentFile=/etc/polymarket-trader.env
ExecStart=/usr/local/bin/run-polymarket-exit-scanner
TimeoutStartSec=45s
```

`/etc/systemd/system/polymarket-daily-report.timer`:

```ini
[Unit]
Description=Run Polymarket trader daily email report after morning trade run

[Timer]
OnCalendar=*-*-* 07:40:00 America/New_York
Persistent=true
Unit=polymarket-daily-report.service

[Install]
WantedBy=timers.target
```

`/etc/systemd/system/polymarket-daily-report.service`:

```ini
[Unit]
Description=Polymarket trader daily email report
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/polymarket-trader
ExecStart=/usr/local/bin/run-polymarket-daily-report
```

Optional manual shadow endpoint, if you want heatmap clicks to keep working:

`/etc/systemd/system/polymarket-manual-shadow.service`:

```ini
[Unit]
Description=Polymarket manual shadow endpoint
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/polymarket-trader
EnvironmentFile=/etc/polymarket-manual-shadow.env
ExecStart=/usr/bin/python3 /opt/polymarket-trader/scripts/manual_shadow_endpoint.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Reload systemd:

```bash
sudo systemctl daemon-reload
```

## 9. Pre-flight verification before starting live services

Run these checks on the new machine:

```bash
cd /opt/polymarket-trader
git status --short --branch
npm run build
bash -n /usr/local/bin/run-polymarket-trader
bash -n /usr/local/bin/run-polymarket-exit-scanner
ls -lah /var/lib/polymarket-trader/portfolio-live.json
ls -lah /var/lib/polymarket-trader/pending-closed-trades.jsonl
systemctl list-units 'polymarket*' --all --no-pager
```

Confirm the old VPS is still stopped:

```bash
ssh root@96.30.198.111 "systemctl list-units 'polymarket*' --all --no-pager && systemctl list-unit-files 'polymarket*' --no-pager"
```

## 10. Start the new machine

Start the minute exit scanner first, then the hourly trader, then daily report/manual shadow if needed:

```bash
sudo systemctl enable --now polymarket-exit-scanner.timer
sudo systemctl enable --now polymarket-trader.timer
sudo systemctl enable --now polymarket-daily-report.timer
sudo systemctl enable --now polymarket-manual-shadow.service
```

If you do not need the manual shadow endpoint, skip the last command.

Watch the first run:

```bash
journalctl -u polymarket-exit-scanner.service -n 100 --no-pager
journalctl -u polymarket-trader.service -n 200 --no-pager
systemctl list-timers 'polymarket*' --all --no-pager
```

After a run, verify `/var/lib/polymarket-trader/portfolio-live.json` changed if positions or risk state changed. `.runtime/portfolio-live.json` should not be changing in production.

## 11. Cursor usage on the new machine

Open `/opt/polymarket-trader` in Cursor. Before coding, ask Cursor to check:

```text
Inspect this fresh production clone. Confirm git is clean, origin/main is current, systemd wrappers use POLYMARKET_TRADER_STATE_DIR=/var/lib/polymarket-trader, and no live state files are accidentally tracked by Git. Do not edit anything yet.
```

Normal rule: commit code and tracked data changes to GitHub, but never commit `config.env`, `.env`, `.runtime/`, `/var/lib/polymarket-trader`, `data/instrument-snapshots.jsonl`, generated reports, `node_modules/`, or `dist/`.

## Failure cases to avoid

- Two machines running live trader/scanner at the same time.
- Starting the new services before copying `/var/lib/polymarket-trader/portfolio-live.json`.
- Forgetting `pending-closed-trades.jsonl` and reprocessing/skipping scanner closes.
- Letting services fall back to `.runtime/` because `POLYMARKET_TRADER_STATE_DIR` was not set.
- Copying secrets into GitHub.
- Starting timers before `npm ci` and `npm run build` pass.
- Leaving old VPS timers enabled, then having them restart after a reboot.
