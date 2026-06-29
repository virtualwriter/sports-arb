/**
 * One-shot helper to sell stranded naked YES legs that the daemon couldn't
 * auto-exit. Reads target positions from CLI args.
 *
 * Usage:
 *   tsx scripts/sell-orphan-legs.ts \
 *     --token <yesTokenId> --shares <n> --price <bid> --label "<asset desc>" \
 *     [--token ... --shares ... --price ... --label ...]
 *
 * Each leg is sold as a GTC limit at the supplied price (use current best bid
 * to cross immediately). The script prints the post-order response and the
 * resulting CLOB trade summary; it does NOT update the live package ledger
 * (do that manually once fills are confirmed).
 */
import { clobClient, postLimitSell } from "./polymarket-real-monotonic-executor.ts";

type Leg = { token: string; shares: number; price: number; label: string };

function parseArgs(argv: string[]): Leg[] {
  const legs: Leg[] = [];
  let cur: Partial<Leg> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--token") cur.token = v;
    else if (a === "--shares") cur.shares = Number(v);
    else if (a === "--price") cur.price = Number(v);
    else if (a === "--label") cur.label = v;
    if (cur.token && cur.shares != null && cur.price != null && cur.label) {
      legs.push(cur as Leg);
      cur = {};
    }
    if (["--token", "--shares", "--price", "--label"].includes(a)) i++;
  }
  return legs;
}

async function main() {
  const legs = parseArgs(process.argv.slice(2));
  if (legs.length === 0) {
    console.error("No legs supplied. See header comment for usage.");
    process.exit(1);
  }
  const { client } = await clobClient();
  for (const leg of legs) {
    console.log(`\n=== Selling ${leg.label} ===`);
    console.log(`  token=${leg.token} shares=${leg.shares} price=${leg.price}`);
    try {
      const resp = await postLimitSell(client, leg.token, leg.price, leg.shares);
      console.log("Response:", JSON.stringify(resp, null, 2));
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
