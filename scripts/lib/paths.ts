import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

export const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
  ?? process.env.SPORTS_ARB_STATE_DIR
  ?? process.env.POLYMARKET_TRADER_STATE_DIR
  ?? join(REPO_ROOT, "data"),
);

export const RUNTIME_DIR = resolve(
  process.env.SPORTS_ARB_RUNTIME_DIR
  ?? process.env.SPORTS_ARB_STATE_DIR
  ?? process.env.POLYMARKET_TRADER_STATE_DIR
  ?? join(REPO_ROOT, ".runtime"),
);

export const REPORTS_DIR = resolve(process.env.SPORTS_ARB_REPORTS_DIR ?? join(DATA_DIR, "reports"));
export const BACKUP_DIR = resolve(process.env.SPORTS_ARB_BACKUP_DIR ?? join(DATA_DIR, "backups"));

export const PATHS = {
  livePackages: join(DATA_DIR, "sports-arb-live-packages.json"),
  liveOrders: join(DATA_DIR, "sports-arb-live-orders.json"),
  metadataCache: join(DATA_DIR, "sports-arb-market-metadata-cache.jsonl"),
  shadows: join(DATA_DIR, "sports-arb-shadows.jsonl"),
  resolvedShadows: join(DATA_DIR, "sports-arb-resolved-shadows.jsonl"),
  shadowBucketSummary: join(DATA_DIR, "sports-arb-shadow-bucket-summary.json"),
  stateFeedShadow: join(DATA_DIR, "state-feed-shadow.jsonl"),
  stateFeedEventMap: join(DATA_DIR, "state-feed-event-map.json"),
  /** Empirical PA RBI priors for MLB paper path (repo analysis artifact). */
  mlbPaRbiPriors: join(REPO_ROOT, "analysis", "per-plate-rbi-p-backtest.json"),
  mlbPaRbiApplesToApples: join(REPO_ROOT, "analysis", "per-plate-rbi-p-apples-to-apples.json"),
  /** PA-chain transition kernel (2024 train) for MLB band fair (build_pa_chain_transitions.py). */
  mlbPaChainTransitions: join(REPO_ROOT, "analysis", "pa-chain-transitions-2024.json"),
  pinnacleMlbOdds: join(DATA_DIR, "pinnacle-mlb-odds.jsonl"),
  pinnacleMlbOddsLatest: join(DATA_DIR, "pinnacle-mlb-odds-latest.json"),
  pinnacleScoreCompare: join(DATA_DIR, "pinnacle-score-compare.jsonl"),
  pinnaclePmPaired: join(DATA_DIR, "pinnacle-pm-paired.jsonl"),
  pinnaclePmPairedEvents: join(DATA_DIR, "pinnacle-pm-paired-events.jsonl"),
  pinnaclePmPairedStatus: join(DATA_DIR, "pinnacle-pm-paired-status.json"),
  tradesCsv: join(DATA_DIR, "sports-arb-trades.csv"),
  signalWeights: join(DATA_DIR, "sports-arb-signal-weights.json"),
  hypotheses: join(DATA_DIR, "sports-arb-hypotheses.json"),
  learningJournal: join(DATA_DIR, "sports-arb-learning-journal.md"),
  llmState: join(DATA_DIR, "sports-arb-llm-state.json"),
  health: join(DATA_DIR, "sports-arb-health.json"),
  orphanIncidents: join(DATA_DIR, "sports-arb-orphan-incidents.jsonl"),
  operatorActions: join(RUNTIME_DIR, "sports-arb-operator-actions.jsonl"),
  killSwitch: join(RUNTIME_DIR, "sports-arb-paused.json"),
  lockFile: join(RUNTIME_DIR, "sports-arb.lock"),
  daemonLivePackages: join(DATA_DIR, "polymarket-live-packages.json"),
  daemonLiveOrders: join(DATA_DIR, "polymarket-live-orders.json"),
  dailyMarkdown: join(REPORTS_DIR, "sports-arb-daily.md"),
  dailyCsv: join(REPORTS_DIR, "sports-arb-daily.csv"),
  excelManifest: join(REPORTS_DIR, "sports-arb-excel-manifest.json"),
  pnlReportHtml: join(REPORTS_DIR, "sports-pnl-report", "index.html"),
  pnlReportJson: join(REPORTS_DIR, "sports-pnl-report", "summary.json"),
  pnlReportTrades: join(REPORTS_DIR, "sports-pnl-report", "trades.json"),
};

export function ensureParent(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function ensureStateDirs(): void {
  for (const dir of [DATA_DIR, RUNTIME_DIR, REPORTS_DIR, BACKUP_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
