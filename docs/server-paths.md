# Server Paths

## Japan Monotonic Host

The repo contains explicit Japan references for the always-on websocket monotonic-arb daemon.

- Production repo path: `/opt/polymarket-trader`
- Runtime state path: `/var/lib/polymarket-trader`
- Primary monotonic env file: `/etc/polymarket-pm-executor.env`
- Legacy/shared env file: `/etc/polymarket-trader.env`
- Systemd unit: `polymarket-arb-daemon.service`
- Systemd unit source in this extraction: `deploy/polymarket-arb-daemon.service`
- Production wrapper path: `/usr/local/bin/run-polymarket-arb-daemon`
- Wrapper source in this extraction: `scripts/run-polymarket-arb-daemon.sh`
- Governing script: `scripts/govern-sports-middle-daemon.sh`

## Dublin / Ireland

Dublin trading VPS identified by operator:

- Hostname: `GG112ICCETN89F88CYLA.tradingvps.io`
- IP: `72.11.157.79`

No file in the current repo explicitly names this Dublin server or a Dublin-specific deploy path. The only Ireland-related runtime reference found is `IE` / `Ireland` in `scripts/lib/VpnGuard.ts`, where Ireland is part of the allowed VPN country list.

If the Dublin machine uses the standard VPS layout from `docs/reference/new-machine-live-handoff.md`, the expected paths are the same generic production paths:

- Repo path: `/opt/polymarket-trader`
- Runtime state path: `/var/lib/polymarket-trader`
- Env file: `/etc/polymarket-trader.env`

The old VPS address referenced by the handoff doc is `root@96.30.198.111`, but it is not labeled as Dublin in the repo.
