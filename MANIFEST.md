# Sports Arb Extraction Manifest

| Path | Why included |
|------|--------------|
| `scripts/polymarket-arb-daemon.ts` | Always-on websocket monotonic-arb daemon; includes sports MLB/SOCCER discovery and execution gates. |
| `scripts/polymarket-real-monotonic-executor.ts` | Hourly/real Polymarket monotonic executor and shared execution helper exports used by the daemon and Up/Down tools. |
| `scripts/lib/monotonic-arb-core.ts` | Shared monotonic candidate discovery and pair evaluation core. |
| `scripts/govern-sports-middle-daemon.sh` | Japan sports monotonic-middle env governance for MLB/SOCCER daemon mode. |
| `scripts/run-sports-arb-daemon.sh` | Production wrapper deployed as `/usr/local/bin/run-sports-arb-daemon` for the sports-arb daemon. |
| `deploy/sports-arb-daemon.service` | Systemd service for the sports-arb always-on daemon. |
| `docs/SPORTS-MONOTONIC-SOCCER-MLB.md` | Soccer and MLB monotonic-middle strategy and ROI evidence. |
| `scripts/monotonic_middle_report.py` | Sports middle audit report generator. |
| `scripts/monotonic_capture_report.py` | Daemon capture/conversion audit summarizer. |
| `scripts/fix_monotonic_arb_settlements.py` | Legacy one-off settlement fixer for monotonic pm_package shadows. |
| `scripts/updown-5m-book-collector.ts` | Japan-only Up/Down collector and optional live attempt tool. |
| `scripts/updown-5m-maker-guess-test.ts` | Up/Down maker-guess experimental runner using monotonic executor helpers. |
| `scripts/updown-5m-market-ws-test.ts` | Up/Down market websocket test utility. |
| `scripts/ranked-sports-test.ts` | Sports package ranking/execution test copied from .tmp. |
| `scripts/lib/polygon-rpc.ts` | Polygon RPC failover helper required by the executor. |
| `scripts/lib/VpnGuard.ts` | VPN/country guard required by executor and daemon; includes JP and IE allowlist entries. |
| `scripts/lib/updown/*` | Up/Down persistence and inventory ledger helpers/tests. |
| `analysis/*` | Monotonic chronological ledger, package, ROI projection, and Gamma cache evidence files. |
| `reference/legacy/trading-engine.ts` | Broad parent trader file containing older MONOTONIC_ARB shadow and settlement logic; reference only. |
| `docs/reference/*` | Parent repo deployment/cleanup references that mention Japan/monotonic paths and guardrails. |
| `cursor-rules/sports-arb-event-lifecycle.mdc` | Cursor rule for sports arb event lifecycle behavior. |
| `cursor-rules/hft-market-making-systems.mdc` | Brett Harrison HFT MM five-component design lens. |
| `cursor-rules/weather-hourly-mm.mdc` | CHI/LA hourly weather MM rules (:51 anchor, Synoptic gate, last-10m widen/pull). |
| `docs/reference/hft-market-making-systems.md` | Short HFT MM reference + sports-arb mapping. |
| `docs/reference/weather-hourly-mm.md` | Weather hourly MM strategy, Synoptic lead test, commands. |
| `scripts/lib/weather-cities.ts` | CHI/LA/NYC Kalshi hourly city config + ET event helpers. |
| `scripts/lib/weather-fair-value.ts` | Gaussian hourly temp fair value + mid-hour corrections. |
| `scripts/lib/weather-mm-quotes.ts` | Two-sided weather MM quotes with widen/pull schedule. |
| `scripts/lib/weather-obs.ts` | METAR/SPECI, Synoptic, NWS, TWC observation feeds. |
| `scripts/weather-synoptic-lead-test.ts` | Synoptic leading-indicator harness for hourly cities. |
| `scripts/weather-hourly-mm-paper.ts` | Paper (optional post_only live) weather MM for CHI/LA. |
| `scripts/weather-city-tracker.ts` | Multi-city weather book + obs recorder. |
| `deploy/weather-hourly-mm-paper.service` | Systemd unit for paper weather MM. |
| `reference/helpers/polymarket-clob-book.ts` | CLOB depth utility noted as needed for monotonic arb depth checks. |
| `reference/helpers/reporting-position.ts` | Reporting parser that recognizes monotonic arb package labels. |
| `reference/legacy/market-scanner.ts` | Broad market scanner reference with spot-column dependency for monotonic settlement. |
| `reference/legacy/prod-verify.ts` | Production verifier reference that flags frozen Japan/monotonic cleanup paths. |
| `docs/reference/quant-model-roadmap.md` | Broad quant roadmap reference mentioning monotonic arb as a signal family. |
| `reference/data/trades-detailed.csv` | Historical trader records containing MONOTONIC_ARB live/package rows. |
| `reference/data/operationally-tainted-trades.json` | Data-quality exclusions for early monotonic package migration artifacts. |
