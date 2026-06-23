import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const PORT = Number(process.env.LIVE_PACKAGES_DASHBOARD_PORT ?? 4177);
const HOST = process.env.LIVE_PACKAGES_DASHBOARD_HOST ?? "127.0.0.1";
const REMOTE = process.env.LIVE_PACKAGES_REMOTE ?? "root@72.11.157.79";
const REMOTE_DIR = process.env.LIVE_PACKAGES_REMOTE_DIR ?? "/opt/sports-arb";
const HTML_PATH = resolve("live-packages-dashboard.html");

const remoteTs = `
import { readFileSync } from 'node:fs';
async function main() {
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST ?? 'https://clob.polymarket.com';
function bestLevel(levels:any[] | undefined, side:'bid'|'ask') {
  const rows = Array.isArray(levels) ? levels : [];
  const nums = rows.map((row:any) => ({ price: Number(row.price), size: Number(row.size) }))
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.size));
  if (nums.length === 0) return { price: 0, size: 0 };
  return nums.reduce((best, row) => side === 'bid'
    ? (row.price > best.price ? row : best)
    : (row.price < best.price ? row : best), nums[0]);
}
async function book(tokenId:string | undefined) {
  if (!tokenId) return { bid: 0, bidSize: 0 };
  const url = CLOB_HOST + '/book?' + new URLSearchParams({ token_id: tokenId });
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) return { bid: 0, bidSize: 0 };
  const json:any = await response.json();
  const bid = bestLevel(json.bids, 'bid');
  return { bid: bid.price, bidSize: bid.size };
}
const rows = JSON.parse(readFileSync('data/polymarket-live-packages.json', 'utf8'))
  .filter((r:any)=>r.status==='package_complete'&&(r.filledShares??0)>0&&(r.actualCost??0)>0)
  .sort((a:any,b:any)=>String(a.settlementWindow?.endDate??'').localeCompare(String(b.settlementWindow?.endDate??''))||String(a.eventSlug).localeCompare(String(b.eventSlug)));
const pkgs = [];
for (const r of rows) {
  let bb = 0, nb = 0;
  try {
    const [b,n] = await Promise.all([
      book(r.tokenIds?.broadYes),
      book(r.tokenIds?.narrowNo),
    ]);
    bb = b.bid;
    nb = n.bid;
  } catch {}
  const sh = +(r.filledShares ?? 0);
  const cost = +(r.actualCost ?? 0);
  const proceeds = sh * bb + sh * nb;
  const pnl = proceeds - cost;
  pkgs.push({
    id: r.packageId,
    a: r.asset,
    e: r.eventSlug,
    sh,
    cost: +cost.toFixed(4),
    pc: +(r.prices?.packageCost ?? 0).toFixed(3),
    bs: r.broadStrike,
    ns: r.narrowStrike,
    end: r.settlementWindow?.endDate ?? '',
    bb: +bb.toFixed(3),
    nb: +nb.toFixed(3),
    pro: +proceeds.toFixed(4),
    pnl: +pnl.toFixed(4),
    roi: +(cost ? 100 * pnl / cost : 0).toFixed(2),
    fr: r.failureReason ?? '',
  });
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), count: pkgs.length, packages: pkgs }));
}
main();
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fetchLivePackages(): Promise<string> {
  const command = [
    `cd ${shellQuote(REMOTE_DIR)}`,
    "set -a",
    "source /etc/sports-arb.env",
    "set +a",
    `npx tsx -e ${shellQuote(remoteTs)}`,
  ].join(" && ");

  return new Promise((resolvePromise, reject) => {
    execFile("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", REMOTE, command], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    if (url.pathname === "/" || url.pathname === "/live-packages-dashboard.html") {
      const html = await readFile(HTML_PATH, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/packages") {
      const json = await fetchLivePackages();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(json);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (error: any) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error?.message ?? String(error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Live packages dashboard: http://${HOST}:${PORT}/`);
});
