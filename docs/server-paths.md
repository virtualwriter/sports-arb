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

## Dublin / Ireland

Dublin trading VPS identified by operator:

- Hostname: `GG112ICCETN89F88CYLA.tradingvps.io`
- IP: `72.11.157.79`

No file in the current repo explicitly names this Dublin server or a Dublin-specific deploy path. The only Ireland-related runtime reference found is `IE` / `Ireland` in `scripts/lib/VpnGuard.ts`, where Ireland is part of the allowed VPN country list.

If the Dublin machine uses the standard parent-trader layout from `docs/reference/new-machine-live-handoff.md`, the expected paths are the same generic production paths:

- Repo path: `/opt/polymarket-trader`
- Runtime state path: `/var/lib/polymarket-trader`
- Env file: `/etc/polymarket-trader.env`

The old VPS address referenced by the handoff doc is `root@96.30.198.111`, but it is not labeled as Dublin in the repo.
