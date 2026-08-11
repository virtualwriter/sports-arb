/**
 * Pure helpers for GOT → Kalshi daily-high directional rolls.
 * Open YES on GOT bin; on bin change, sell YES then buy the new bin.
 */

export type GotBinMarket = {
  ticker: string;
  label: string;
  lo: number;
  hi: number;
  subtitle: string;
};

const RANGE_RE = /(\d+)°\s+to\s+(\d+)°/i;
const BELOW_RE = /(\d+)°\s+or below/i;
const ABOVE_RE = /(\d+)°\s+or above/i;

/** Parse Kalshi daily-high subtitle into the same label space as city monitors. */
export function parseDailyHighSubtitle(
  subtitle: string,
): { lo: number; hi: number; label: string } | null {
  const s = subtitle.trim();
  let m = RANGE_RE.exec(s);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return { lo, hi, label: `${lo}-${hi}` };
  }
  m = BELOW_RE.exec(s);
  if (m) {
    const hi = Number(m[1]);
    return { lo: -999, hi, label: `<=${hi}` };
  }
  m = ABOVE_RE.exec(s);
  if (m) {
    const lo = Number(m[1]);
    return { lo, hi: 999, label: `>=${lo}` };
  }
  return null;
}

export function marketsFromKalshi(
  markets: Array<{
    ticker?: string;
    yes_sub_title?: string;
    subtitle?: string;
    status?: string;
  }>,
): GotBinMarket[] {
  const out: GotBinMarket[] = [];
  for (const m of markets) {
    if (!m.ticker) continue;
    if (m.status && !/open|active/i.test(m.status)) continue;
    const subtitle = m.yes_sub_title || m.subtitle || "";
    const parsed = parseDailyHighSubtitle(subtitle);
    if (!parsed) continue;
    out.push({
      ticker: m.ticker,
      label: parsed.label,
      lo: parsed.lo,
      hi: parsed.hi,
      subtitle,
    });
  }
  return out;
}

export function findMarketForBin(
  markets: GotBinMarket[],
  binLabel: string | null | undefined,
): GotBinMarket | null {
  if (!binLabel) return null;
  return markets.find((m) => m.label === binLabel) ?? null;
}

/** Contracts affordable at ask for a USD stake (floor). */
export function contractsForStake(stakeUsd: number, ask: number): number {
  if (!(stakeUsd > 0) || !(ask > 0) || ask >= 1) return 0;
  return Math.floor(stakeUsd / ask);
}

export function notionalUsd(contracts: number, price: number): number {
  return Math.max(0, contracts) * Math.max(0, price);
}

export type CityRollState = {
  day: string;
  bin: string;
  ticker: string;
  contracts: number;
  avgEntry: number;
  openedAt: string;
  lastActionAt: string;
};

export type RollPlan =
  | { action: "skip"; reason: string }
  | { action: "open"; bin: string; ticker: string; contracts: number; limit: number }
  | {
      action: "roll";
      fromBin: string;
      fromTicker: string;
      sellContracts: number;
      sellLimit: number;
      toBin: string;
      toTicker: string;
      buyContracts: number;
      buyLimit: number;
    };

/**
 * Plan open/roll for one city. Uses TOB ask for buys and TOB bid for sells.
 * Initial opens are capped at stakeUsd; rolls size the buy from sell proceeds
 * (contracts_sold * sellBid / buyAsk), floored.
 */
export function planGotRoll(opts: {
  bin: string | null | undefined;
  markets: GotBinMarket[];
  held: CityRollState | null;
  day: string;
  yesAsk: number | null;
  yesBid: number | null;
  /** For rolls onto a new bin. */
  newYesAsk: number | null;
  stakeUsd: number;
  minAsk: number;
  maxAsk: number;
}): RollPlan {
  const { bin, markets, held, day, stakeUsd, minAsk, maxAsk } = opts;
  if (!bin) return { action: "skip", reason: "no_bin" };
  const target = findMarketForBin(markets, bin);
  if (!target) return { action: "skip", reason: "bin_not_in_strip" };

  // New day → treat as flat even if stale state remains.
  if (held && held.day !== day) {
    // Fall through as open (caller should clear stale state).
  } else if (held && held.day === day && held.bin === bin && held.contracts > 0) {
    return { action: "skip", reason: "already_in_bin" };
  }

  if (!held || held.day !== day || held.contracts <= 0) {
    const ask = opts.yesAsk;
    if (ask == null) return { action: "skip", reason: "no_ask" };
    if (ask < minAsk) return { action: "skip", reason: "ask_below_min" };
    if (ask > maxAsk) return { action: "skip", reason: "ask_above_max" };
    const contracts = contractsForStake(stakeUsd, ask);
    if (contracts < 1) return { action: "skip", reason: "size_zero" };
    return {
      action: "open",
      bin,
      ticker: target.ticker,
      contracts,
      limit: ask,
    };
  }

  // Roll held → new bin.
  if (held.bin === bin) return { action: "skip", reason: "already_in_bin" };
  const bid = opts.yesBid;
  const newAsk = opts.newYesAsk;
  if (bid == null || bid <= 0) return { action: "skip", reason: "no_bid_to_sell" };
  if (newAsk == null) return { action: "skip", reason: "no_ask" };
  if (newAsk < minAsk) return { action: "skip", reason: "ask_below_min" };
  if (newAsk > maxAsk) return { action: "skip", reason: "ask_above_max" };
  const proceeds = held.contracts * bid;
  const buyContracts = Math.floor(proceeds / newAsk);
  if (buyContracts < 1) return { action: "skip", reason: "roll_size_zero" };
  return {
    action: "roll",
    fromBin: held.bin,
    fromTicker: held.ticker,
    sellContracts: held.contracts,
    sellLimit: bid,
    toBin: bin,
    toTicker: target.ticker,
    buyContracts,
    buyLimit: newAsk,
  };
}

export function eventTickerFor(series: string, day: string): string {
  return `${series}-${day.toUpperCase()}`;
}
