# Weather hourly market-making (CHI / LA)

Paper MM for Kalshi hourly temperature markets (`KXTEMPCHIH`, `KXTEMPLAXH`), built on the Brett Harrison five-component HFT MM lens (`hft-market-making-systems.md`).

## Strategy rules

1. **Anchor** — After each decisive `:51` METAR, that print is the starting fair value `μ` for the **next** hour’s event.
2. **Correct mid-hour** — When Synoptic (if leading) or SPECI/NWS temperature readings change, update `μ` and rebuild `pYes` on every strike.
3. **Last 10 minutes** — Widen half-spread (default 2¢ → 8¢).
4. **Last 3 minutes** — Pull liquidity (no resting quotes).
5. **TWC** — Logged as the named settlement publisher; sticky mid-hour TWC does **not** drive `μ`.

Fair value: `T ~ N(μ, σ²)`, half-up integer bins, `pYes = P(round(T) > floor)` (same as the NYC hourly desk). Default `σ = 0.7°F`.

## Synoptic leading-indicator gate

```bash
# One-shot score (needs SYNOPTIC_TOKEN for a real Synoptic verdict)
SYNOPTIC_TOKEN=... npm run weather:synoptic-lead

# Optional live window
WEATHER_LEAD_LIVE_MIN=20 SYNOPTIC_TOKEN=... npm run weather:synoptic-lead
```

Without a token the harness still scores NWS vs METAR and SPECI-vs-`:51`, and prints guidance to keep Synoptic **off** for fair-value corrections.

The paper MM follows Synoptic only when `SYNOPTIC_TOKEN` is set and `WEATHER_MM_USE_SYNOPTIC` is not disabled (`WEATHER_MM_SYNOPTIC_LEAD=on|auto|off`).

## Commands

| Script | npm | Role |
|--------|-----|------|
| `scripts/weather-synoptic-lead-test.ts` | `weather:synoptic-lead` | Lead-indicator test |
| `scripts/weather-hourly-mm-paper.ts` | `weather:mm-paper` | Paper (or post_only live) quoter |
| `scripts/weather-city-tracker.ts` | `weather:city-tracker` | Multi-city obs + book recorder |

```bash
# Paper MM on Chicago + LA (default cities)
KALSHI_API_KEY_ID=... KALSHI_API_PRIVATE_KEY_PATH=... npm run weather:mm-paper

# Follow Synoptic after a positive lead test
SYNOPTIC_TOKEN=... WEATHER_MM_USE_SYNOPTIC=1 npm run weather:mm-paper
```

Audit JSONL: `$SPORTS_ARB_DATA_DIR/weather/weather-mm-YYYY-MM-DD.jsonl`.

## City map

| Id | Series | ICAO | Notes |
|----|--------|------|-------|
| CHI | `KXTEMPCHIH` | KORD | Event hour labeled in ET |
| LAX | `KXTEMPLAXH` | KLAX | Event hour labeled in ET |
| NYC | `KXTEMPNYCH` | KNYC | Optional via `WEATHER_MM_CITIES` |

## Component mapping

| Harrison component | Here |
|--------------------|------|
| Market data | Kalshi WS books; METAR/SPECI; Synoptic; NWS; TWC |
| Fair value | `:51` anchor + mid-hour corrections → Gaussian ladder |
| Order placement | Two-sided quotes, inventory skew, widen/pull schedule |
| Exchange connectivity | Kalshi WS + optional `post_only` GTC |
| Offline training | Lead-test reports + MM JSONL for later σ/spread fits |
