/**
 * Canary: can we still place a sports order on Kalshi?
 *
 * Two things silently switch sports trading off, and neither is visible from
 * the balance or the order ledger until a real print is already lost:
 *
 *   1. API location verification expires weekly. Once it lapses every sports,
 *      elections and entertainment order comes back 403 with the "Nevada
 *      residents" code regardless of where the account or the caller is.
 *   2. Sports markets live on matching-engine shard 3, which holds its own
 *      collateral. If auto-rebalancing is off or the shard is drained, orders
 *      come back 404 `user_not_found`.
 *
 * So the only honest check is to actually place one. Rests a single contract
 * at 1c post-only — it cannot cross, and it is cancelled immediately — then
 * reports whether the exchange accepted it.
 *
 * Exit code 0 = tradeable, 1 = blocked, 2 = could not tell (no open markets).
 *
 * Usage: tsx scripts/kalshi-sports-access-canary.ts
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { KalshiClient, shardForTicker } from "./lib/kalshi-client.js";

const SERIES = process.env.KALSHI_CANARY_SERIES ?? "KXMLBTOTAL";
const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);
const LOG_PATH = join(DATA_DIR, "kalshi-sports-access-canary.jsonl");

type Verdict = "tradeable" | "blocked" | "unknown";

async function notify(text: string): Promise<void> {
  const token = process.env.SPORTS_ARB_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.SPORTS_ARB_TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error(`telegram notify failed: ${(err as Error).message}`);
  }
}

function record(row: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error(`canary log failed: ${(err as Error).message}`);
  }
}

/** The operator-facing reason, not the raw code. */
function diagnose(message: string): string {
  if (/Nevada_residents|Nevada residents/i.test(message)) {
    return "API location verification has lapsed — re-verify under Account & security → API keys.";
  }
  if (/user_not_found/i.test(message)) {
    return "No collateral on the sports shard — check target balance allocation.";
  }
  if (/market_not_found/i.test(message)) {
    return "Order routed to the wrong shard — the ticker→shard registry did not warm.";
  }
  return message.slice(0, 300);
}

async function main(): Promise<void> {
  const client = new KalshiClient();
  const observedAt = new Date().toISOString();

  // Listing warms the ticker→shard registry as a side effect.
  const { markets } = await client.listMarkets({ series_ticker: SERIES, status: "open", limit: 5 });
  const market = markets?.[0];
  if (!market?.ticker) {
    console.log(`canary: no open ${SERIES} markets — cannot test`);
    record({ observedAt, verdict: "unknown" satisfies Verdict, reason: "no_open_markets", series: SERIES });
    process.exit(2);
  }

  const shard = shardForTicker(market.ticker);
  const balance = await client.getBalance(shard >= 0 ? shard : undefined);
  const shardCash = (balance.balance ?? 0) / 100;

  let verdict: Verdict = "blocked";
  let detail = "";
  let orderId: string | undefined;
  const started = Date.now();
  try {
    const resp = await client.createOrderV2({
      ticker: market.ticker,
      side: "bid",
      count: 1,
      price: 0.01,
      time_in_force: "good_till_canceled",
      post_only: true,
      client_order_id: randomUUID(),
    });
    orderId = resp.order_id;
    verdict = "tradeable";
  } catch (err) {
    detail = diagnose((err as Error).message ?? String(err));
  }
  const rttMs = Date.now() - started;

  // Never leave the probe resting, even if the run is about to fail.
  let cancelled: string | undefined;
  if (orderId) {
    try {
      await client.cancelOrderV2(orderId, shard >= 0 ? shard : undefined);
      cancelled = "ok";
    } catch (err) {
      cancelled = (err as Error).message.slice(0, 200);
      await notify(`Kalshi canary could not cancel probe order ${orderId} on ${market.ticker}: ${cancelled}`);
    }
  }

  record({
    observedAt, verdict, series: SERIES, ticker: market.ticker,
    shard, shardCash, rttMs, orderId, cancelled, detail,
  });

  if (verdict === "tradeable") {
    console.log(`canary OK — ${market.ticker} shard ${shard}, $${shardCash.toFixed(2)} available (${rttMs}ms)`);
    if (shardCash < 100) {
      await notify(`Kalshi sports shard ${shard} is down to $${shardCash.toFixed(2)} — too thin for a full ticket.`);
    }
    process.exit(0);
  }

  console.error(`canary BLOCKED — ${detail}`);
  await notify(`Kalshi sports trading is BLOCKED.\n\n${detail}\n\nMarket ${market.ticker} (shard ${shard}), $${shardCash.toFixed(2)} on shard.`);
  process.exit(1);
}

main().catch(async (err) => {
  console.error(`canary failed: ${(err as Error).message}`);
  record({ observedAt: new Date().toISOString(), verdict: "unknown" satisfies Verdict, error: (err as Error).message });
  await notify(`Kalshi sports canary errored: ${(err as Error).message}`);
  process.exit(2);
});
