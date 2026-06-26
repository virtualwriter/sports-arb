#!/usr/bin/env tsx
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { PATHS, ensureParent, ensureStateDirs } from "./lib/paths.js";
import { readJson, writeJson } from "./lib/storage.js";

config({ path: "config.env" });
config({ path: ".env" });

const GAMMA_API = process.env.GAMMA_API ?? "https://gamma-api.polymarket.com";

type JsonRow = Record<string, any>;
type GammaMarket = {
  id?: string | number;
  closed?: boolean;
  resolvedBy?: string | null;
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
};
type GammaEvent = {
  markets?: GammaMarket[];
};
type ResolutionValue = {
  value: number;
  pnl: number;
  label: string;
};

type ReportRow = {
  createdAt: string;
  sport: string;
  marketType: string;
  packageLabel: string;
  result: string;
  shares: number;
  costPerShare: number;
  cost: number;
  value: number;
  pnl: number;
  status: string;
  orphan: boolean;
};

type Summary = {
  count: number;
  cost: number;
  value: number;
  pnl: number;
};

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function plainUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function marketType(row: JsonRow): string {
  const labels = Array.isArray(row.packageLegs)
    ? row.packageLegs.map((leg: JsonRow) => String(leg.instrumentLabel ?? "")).join(" ")
    : "";
  if (/1st Half|1H/i.test(labels)) return "1H Over/Under";
  if (/Team Total/i.test(labels)) return "Team Total O/U";
  if (/O\/U|Over\/Under/i.test(labels)) return "Over/Under";
  if (/Spread:/i.test(labels)) return "Spread";
  return String(row.direction ?? "Unknown");
}

function packageLabel(row: JsonRow): string {
  if (Array.isArray(row.packageLegs) && row.packageLegs.length > 0) {
    return row.packageLegs
      .map((leg: JsonRow) => String(leg.instrumentLabel ?? "").replace(/^.*? - (YES|NO) - /, ""))
      .join(" / ");
  }
  const broad = row.broadStrike ?? "?";
  const narrow = row.narrowStrike ?? "?";
  return `${row.eventSlug ?? row.packageId ?? "unknown"}: ${broad} / ${narrow}`;
}

function noBidFromYesAsk(yesAsk: unknown): number {
  const ask = num(yesAsk, NaN);
  return Number.isFinite(ask) ? Math.max(0, 1 - ask) : 0;
}

function markValue(row: JsonRow, shares: number): number {
  const legs = Array.isArray(row.packageLegs) ? row.packageLegs : [];
  const broad = legs.find((leg: JsonRow) => leg.role === "broad_yes") ?? {};
  const narrow = legs.find((leg: JsonRow) => leg.role === "narrow_no") ?? {};
  const broadBid = num(broad.yesBid);
  const narrowNoBid = noBidFromYesAsk(narrow.yesAsk);
  return shares * (broadBid + narrowNoBid);
}

function realizedValue(row: JsonRow, cost: number): { value: number; pnl: number; label: string } | null {
  const exit = row.exit && typeof row.exit === "object" ? row.exit : {};
  const realizedPnl = num(exit.realizedPnl, NaN);
  if (Number.isFinite(realizedPnl)) {
    return { value: cost + realizedPnl, pnl: realizedPnl, label: String(exit.reason ?? "realized_exit") };
  }
  const directPnl = num(row.realizedExitPnl, NaN);
  if (Number.isFinite(directPnl)) {
    return { value: cost + directPnl, pnl: directPnl, label: String(row.soldReason ?? "realized_exit") };
  }
  const proceeds = num(row.exitProceeds, NaN);
  if (Number.isFinite(proceeds)) {
    return { value: proceeds, pnl: proceeds - cost, label: String(row.soldReason ?? "sold") };
  }
  return null;
}

function floorValue(row: JsonRow, shares: number): number {
  return num(row.guaranteedFloor, shares);
}

function marketIdFromInstrumentId(value: unknown): string | null {
  const parts = String(value ?? "").split("::");
  return parts.length >= 2 && parts[1] ? parts[1] : null;
}

function tokenIdForLeg(row: JsonRow, leg: JsonRow): string | null {
  if (typeof leg.tokenId === "string") return leg.tokenId;
  const tokenIds = row.tokenIds && typeof row.tokenIds === "object" ? row.tokenIds : {};
  if (leg.role === "broad_yes") return String(tokenIds.broadYes ?? "") || null;
  if (leg.role === "narrow_no") return String(tokenIds.narrowNo ?? "") || null;
  if (leg.role === "narrow_yes") return String(tokenIds.narrowYes ?? "") || null;
  return null;
}

function marketTokenPrices(market: GammaMarket | undefined): Map<string, number> | null {
  if (!market) return null;
  const tokens = parseJsonArray(market.clobTokenIds).map(String);
  const prices = parseJsonArray(market.outcomePrices).map((price) => num(price, NaN));
  if (tokens.length === 0 || prices.length === 0) return null;
  const out = new Map<string, number>();
  for (let idx = 0; idx < tokens.length; idx += 1) {
    if (tokens[idx] && Number.isFinite(prices[idx])) out.set(tokens[idx], prices[idx]);
  }
  return out.size > 0 ? out : null;
}

function gammaValue(row: JsonRow, cost: number, shares: number, event: GammaEvent | null | undefined): ResolutionValue | null {
  const markets = new Map<string, GammaMarket>();
  for (const market of event?.markets ?? []) {
    if (market.id != null) markets.set(String(market.id), market);
  }
  const legs = Array.isArray(row.packageLegs) ? row.packageLegs : [];
  if (legs.length === 0) return null;
  let payoutPerShare = 0;
  let allResolved = true;
  let resolvedLegs = 0;
  for (const leg of legs) {
    const marketId = marketIdFromInstrumentId(leg.instrumentId);
    const tokenId = tokenIdForLeg(row, leg);
    if (!marketId || !tokenId) return null;
    const market = markets.get(marketId);
    const tokenPrices = marketTokenPrices(market);
    const tokenPrice = tokenPrices?.get(tokenId);
    if (tokenPrice == null) return null;
    payoutPerShare += tokenPrice;
    allResolved = allResolved && Boolean(market?.closed || market?.resolvedBy) && [...(tokenPrices?.values() ?? [])].some((price) => price >= 0.99);
    resolvedLegs += 1;
  }
  const value = shares * payoutPerShare;
  return {
    value,
    pnl: value - cost,
    label: allResolved ? `RESOLVED ${payoutPerShare.toFixed(0)}/${resolvedLegs}` : "GAMMA MARK",
  };
}

async function fetchGammaEvent(slug: string): Promise<GammaEvent | null> {
  const response = await fetch(`${GAMMA_API}/events?${new URLSearchParams({ slug })}`, {
    headers: { Accept: "application/json", "User-Agent": "sports-pnl-report/1.0" },
  });
  if (!response.ok) throw new Error(`Gamma event fetch failed ${slug}: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data) && data.length > 0 ? data[0] as GammaEvent : null;
}

async function fetchEventMap(rows: JsonRow[]): Promise<Map<string, GammaEvent | null>> {
  const slugs = [...new Set(rows.map((row) => String(row.eventSlug ?? "")).filter(Boolean))];
  const events = new Map<string, GammaEvent | null>();
  await Promise.all(slugs.map(async (slug) => {
    try {
      events.set(slug, await fetchGammaEvent(slug));
    } catch {
      events.set(slug, null);
    }
  }));
  return events;
}

function readArchivedPackageRows(): JsonRow[] {
  const archiveDir = join(dirname(PATHS.daemonLivePackages), "archive");
  if (!existsSync(archiveDir)) return [];
  const rows: JsonRow[] = [];
  for (const name of readdirSync(archiveDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(archiveDir, name), "utf8"));
      const records = Array.isArray(parsed) ? parsed : [];
      for (const record of records) {
        if (!record || typeof record !== "object") continue;
        const packages = Array.isArray(record.packages) ? record.packages : [];
        for (const pkg of packages) {
          if (pkg && typeof pkg === "object") rows.push(pkg);
        }
      }
    } catch {
      // Ignore corrupt/partial archive files; the active ledger remains the source of truth.
    }
  }
  return rows;
}

function rowKey(row: JsonRow): string {
  return String(row.id ?? `${row.packageId ?? "unknown"}::${row.createdAt ?? ""}`);
}

function combineRows(activeRows: JsonRow[], archivedRows: JsonRow[]): JsonRow[] {
  const byKey = new Map<string, JsonRow>();
  for (const row of archivedRows) byKey.set(rowKey(row), row);
  for (const row of activeRows) byKey.set(rowKey(row), row);
  return [...byKey.values()];
}

function reportRow(row: JsonRow, now: Date, event: GammaEvent | null | undefined): ReportRow | null {
  if (row.dataQualityArtifact) return null;
  const sport = String(row.asset ?? row.sport ?? "UNKNOWN");
  if (!["MLB", "SOCCER", "NBA", "WNBA", "NFL", "NCAAF", "TENNIS", "WOMENS_TENNIS", "COLLEGE_BASEBALL"].includes(sport)) return null;

  const status = String(row.status ?? "unknown");
  const failureReason = String(row.failureReason ?? "");
  // Treat sub-dust naked residuals (e.g. naked_narrow_no=0.0155) as normal
  // cheap-first completions, not orphans. The daemon itself uses
  // SPORTS_ORPHAN_DUST_SHARES (default 0.01, governor sets to 1) and never
  // quarantines below that threshold.
  const ORPHAN_DUST_THRESHOLD = 1;
  const nakedMatch = /naked_(?:broad_yes|narrow_no)=([0-9.]+)/i.exec(failureReason);
  const nakedShares = nakedMatch ? Number(nakedMatch[1]) : 0;
  const hasMaterialNaked = /naked/i.test(failureReason) && nakedShares >= ORPHAN_DUST_THRESHOLD;
  const orphan =
    /orphan|unwind/i.test(status) || /orphan|unwind/i.test(failureReason) || hasMaterialNaked;
  const shares = num(row.filledShares);
  const cost = num(row.actualCost);
  if (cost <= 0 || (shares <= 0 && !orphan)) return null;

  const realized = realizedValue(row, cost);
  const gamma = realized ? null : gammaValue(row, cost, shares, event);
  const end = row.settlementWindow?.endDate ? new Date(String(row.settlementWindow.endDate)) : null;
  const isSettledWindow = end instanceof Date && Number.isFinite(end.getTime()) && end <= now;
  const value = realized?.value ?? gamma?.value ?? (isSettledWindow ? floorValue(row, shares) : markValue(row, shares));
  const pnl = realized?.pnl ?? gamma?.pnl ?? (value - cost);
  const result = realized?.label ?? (orphan ? "ORPHAN/UNWIND" : gamma?.label ?? (isSettledWindow ? "FLOOR/MARK" : "OPEN MARK"));

  return {
    createdAt: String(row.createdAt ?? row.updatedAt ?? ""),
    sport,
    marketType: marketType(row),
    packageLabel: packageLabel(row),
    result,
    shares,
    costPerShare: shares > 0 ? cost / shares : 0,
    cost,
    value,
    pnl,
    status,
    orphan,
  };
}

function summarize(rows: ReportRow[]): Summary {
  return rows.reduce<Summary>((acc, row) => {
    acc.count += 1;
    acc.cost += row.cost;
    acc.value += row.value;
    acc.pnl += row.pnl;
    return acc;
  }, { count: 0, cost: 0, value: 0, pnl: 0 });
}

function card(label: string, summary: Summary, detail: string): string {
  const cls = summary.pnl >= 0 ? "pos" : "neg";
  return `<div class="card"><span>${html(label)}</span><b class="${cls}">${fmtUsd(summary.pnl)}</b><small>${html(detail)}</small></div>`;
}

function table(rows: ReportRow[]): string {
  const total = summarize(rows);
  const totalCls = total.pnl >= 0 ? "pos" : "neg";
  const body = rows.map((row) => {
    const cls = row.pnl >= 0 ? "pos" : "neg";
    const created = row.createdAt ? new Date(row.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "";
    return `<tr><td>${html(created)}</td><td>${html(row.sport)}</td><td>${html(row.marketType)}</td><td class="event">${html(row.packageLabel)}</td><td>${html(row.result)}</td><td>${row.shares.toFixed(2)}</td><td>${row.costPerShare.toFixed(3)}</td><td>${plainUsd(row.cost)}</td><td>${plainUsd(row.value)}</td><td class="${cls}">${fmtUsd(row.pnl)}</td><td>${html(row.status)}</td></tr>`;
  }).join("");
  const footer = `<tfoot><tr><td colspan="5"><b>Total</b></td><td>${total.count}</td><td></td><td><b>${plainUsd(total.cost)}</b></td><td><b>${plainUsd(total.value)}</b></td><td class="${totalCls}"><b>${fmtUsd(total.pnl)}</b></td><td></td></tr></tfoot>`;
  return `<table><thead><tr><th>Created</th><th>Sport</th><th>Market Type</th><th>Package</th><th>Result</th><th>Shares</th><th>Cost/Sh</th><th>Cost</th><th>Value</th><th>P&L</th><th>Status</th></tr></thead><tbody>${body || `<tr><td colspan="11" class="muted">No rows</td></tr>`}</tbody>${footer}</table>`;
}

function render(args: {
  generatedAt: Date;
  dailyStart: Date;
  lifetimeStart: Date;
  today: ReportRow[];
  lifetime: ReportRow[];
  todayOrphans: ReportRow[];
  lifetimeOrphans: ReportRow[];
}): string {
  const todayMain = summarize(args.today);
  const todayOrphans = summarize(args.todayOrphans);
  const todayAll = summarize([...args.today, ...args.todayOrphans]);
  const lifetimeMain = summarize(args.lifetime);
  const lifetimeOrphans = summarize(args.lifetimeOrphans);
  const lifetimeAll = summarize([...args.lifetime, ...args.lifetimeOrphans]);
  const resolved = args.lifetime.filter((row) => /^(RESOLVED|sold|realized)/i.test(row.result));
  const open = args.lifetime.filter((row) => !/^(RESOLVED|sold|realized)/i.test(row.result));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sports Arb P&L Report</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:24px;line-height:1.35}h1{margin-bottom:4px}.meta,.muted{color:#777}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:12px 0 24px}.card{border:1px solid #bbb;border-radius:10px;padding:14px;background:Canvas}.card span{display:block;color:#777;font-size:13px}.card b{display:block;font-size:30px;margin:4px 0}.card small{color:#777}.pos{color:#137333}.neg{color:#b3261e}table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:28px}th,td{border:1px solid #ccc;padding:7px 8px;vertical-align:top}th{position:sticky;top:0;background:Canvas;text-align:left}tfoot td{background:Canvas;font-weight:600}.event{max-width:520px}section{margin-top:24px}.pill{display:inline-block;border:1px solid #aaa;border-radius:999px;padding:3px 8px;margin-right:6px;color:#555}</style></head><body>
<h1>Sports Arb P&L Report</h1><div class="meta">Generated ${html(args.generatedAt.toLocaleString())}. Daily window starts ${html(args.dailyStart.toISOString())}. Lifetime window starts ${html(args.lifetimeStart.toISOString())}.</div>
<p><span class="pill">Open = current ledger bid mark</span><span class="pill">Settled without explicit exit = guaranteed floor</span><span class="pill">Orphans shown separately</span></p>
<section><h2>Today</h2><div class="cards">${card("Excluding orphans", todayMain, `${todayMain.count} packages, cost ${plainUsd(todayMain.cost)}`)}${card("Orphans only", todayOrphans, `${todayOrphans.count} rows`)}${card("Including orphans", todayAll, `${todayAll.count} total packages`)}</div></section>
<section><h2>Lifetime Since New Daemon Start</h2><div class="cards">${card("Excluding orphans", lifetimeMain, `${lifetimeMain.count} packages, cost ${plainUsd(lifetimeMain.cost)}`)}${card("Orphans only", lifetimeOrphans, `${lifetimeOrphans.count} rows`)}${card("Including orphans", lifetimeAll, `${lifetimeAll.count} total packages`)}</div></section>
<section><h2>Resolved / Realized Trades With Result</h2>${table(resolved)}</section>
<section><h2>Open Marked Trades</h2>${table(open)}</section>
<section><h2>Orphans / Unwinds</h2>${table(args.lifetimeOrphans)}</section>
</body></html>`;
}

export async function buildSportsPnlReport() {
  ensureStateDirs();
  const now = new Date();
  const dailyStart = new Date(now);
  dailyStart.setHours(0, 0, 0, 0);
  const lifetimeStart = new Date(process.env.SPORTS_ARB_PNL_LIFETIME_START ?? "2026-06-23T21:50:00.000Z");
  const rawRows = combineRows(readJson<JsonRow[]>(PATHS.daemonLivePackages, []), readArchivedPackageRows());
  const eventMap = await fetchEventMap(rawRows);
  const rows = rawRows
    .map((row) => reportRow(row, now, eventMap.get(String(row.eventSlug ?? ""))))
    .filter((row): row is ReportRow => row !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lifetimeRows = rows.filter((row) => new Date(row.createdAt) >= lifetimeStart);
  const todayRows = lifetimeRows.filter((row) => new Date(row.createdAt) >= dailyStart);
  const lifetime = lifetimeRows.filter((row) => !row.orphan);
  const lifetimeOrphans = lifetimeRows.filter((row) => row.orphan);
  const today = todayRows.filter((row) => !row.orphan);
  const todayOrphans = todayRows.filter((row) => row.orphan);
  const htmlText = render({ generatedAt: now, dailyStart, lifetimeStart, today, lifetime, todayOrphans, lifetimeOrphans });
  ensureParent(PATHS.pnlReportHtml);
  writeFileSync(PATHS.pnlReportHtml, htmlText + "\n");
  const summary = {
    generatedAt: now.toISOString(),
    htmlPath: PATHS.pnlReportHtml,
    dailyStart: dailyStart.toISOString(),
    lifetimeStart: lifetimeStart.toISOString(),
    today: summarize(today),
    todayOrphans: summarize(todayOrphans),
    todayIncludingOrphans: summarize([...today, ...todayOrphans]),
    lifetime: summarize(lifetime),
    lifetimeOrphans: summarize(lifetimeOrphans),
    lifetimeIncludingOrphans: summarize([...lifetime, ...lifetimeOrphans]),
  };
  writeJson(PATHS.pnlReportJson, summary);
  return { html: htmlText, htmlPath: PATHS.pnlReportHtml, summary };
}

export async function sportsPnlTelegramText(): Promise<string> {
  const { summary } = await buildSportsPnlReport();
  return [
    "Sports Arb P&L Report",
    `Generated: ${summary.generatedAt}`,
    "",
    `Today excl. orphans: ${fmtUsd(summary.today.pnl)} (${summary.today.count} packages, cost ${plainUsd(summary.today.cost)})`,
    `Today incl. orphans: ${fmtUsd(summary.todayIncludingOrphans.pnl)} (${summary.todayIncludingOrphans.count} total)`,
    "",
    `Lifetime excl. orphans: ${fmtUsd(summary.lifetime.pnl)} (${summary.lifetime.count} packages, cost ${plainUsd(summary.lifetime.cost)})`,
    `Lifetime orphans: ${fmtUsd(summary.lifetimeOrphans.pnl)} (${summary.lifetimeOrphans.count} rows)`,
    `Lifetime incl. orphans: ${fmtUsd(summary.lifetimeIncludingOrphans.pnl)} (${summary.lifetimeIncludingOrphans.count} total)`,
    "",
    `HTML: ${summary.htmlPath}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await buildSportsPnlReport();
  console.log(`[pnl-report] html=${report.htmlPath} json=${PATHS.pnlReportJson}`);
}
