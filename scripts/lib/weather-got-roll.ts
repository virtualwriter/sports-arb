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
  /** Successful roll count for this city-day (opens do not increment). */
  rollsToday?: number;
};

export type RollPlan =
  | { action: "skip"; reason: string }
  | {
      action: "open";
      bin: string;
      ticker: string;
      contracts: number;
      limit: number;
      walk?: { maxSlip: number; tob: number; vwap: number; fillable: number };
    }
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
      /** Present when roll limits were walked past TOB. */
      walk?: {
        maxSlip: number;
        sellTob: number;
        sellVwap: number;
        sellFillable: number;
        buyTob: number;
        buyVwap: number;
      };
    };

export type BookLevel = [price: number, size: number];

export type WalkFill = {
  tob: number;
  limit: number;
  vwap: number;
  fillable: number;
  levelsTaken: BookLevel[];
};

/** YES ask ladder from Kalshi book (NO bids → YES asks at 1−p), best ask first. */
export function yesAskLevelsFromBook(book: {
  noBids: BookLevel[];
}): BookLevel[] {
  return book.noBids
    .map(([noBid, sz]) => [Number((1 - noBid).toFixed(4)), sz] as BookLevel)
    .filter(([p, s]) => p > 0 && p < 1 && s > 0)
    .sort((a, b) => a[0] - b[0]);
}

/** YES bid ladder, best bid first. */
export function yesBidLevelsFromBook(book: {
  yesBids: BookLevel[];
}): BookLevel[] {
  return [...book.yesBids]
    .filter(([p, s]) => p > 0 && p < 1 && s > 0)
    .sort((a, b) => b[0] - a[0]);
}

/**
 * Walk YES bids down to sell `wantContracts` within maxSlip of TOB.
 * Limit = worst (lowest) bid included — IOC ask at that price hits all better bids.
 */
export function planSellWalk(opts: {
  wantContracts: number;
  bidLevels: BookLevel[];
  maxSlip: number;
  minBid?: number;
}): WalkFill {
  const levels = [...opts.bidLevels].sort((a, b) => b[0] - a[0]);
  const tob = levels[0]?.[0] ?? 0;
  const floor = Math.max(opts.minBid ?? 0.01, Number((tob - opts.maxSlip).toFixed(4)));
  let left = Math.max(0, opts.wantContracts);
  let notional = 0;
  let fillable = 0;
  let limit = tob;
  const levelsTaken: BookLevel[] = [];
  for (const [px, sz] of levels) {
    if (left <= 1e-9) break;
    if (px + 1e-9 < floor) break;
    const take = Math.min(left, sz);
    if (take <= 0) continue;
    levelsTaken.push([px, take]);
    fillable += take;
    notional += take * px;
    left -= take;
    limit = px;
  }
  const vwap = fillable > 0 ? notional / fillable : tob;
  return {
    tob,
    limit: Number(limit.toFixed(4)),
    vwap: Number(vwap.toFixed(4)),
    fillable: Number(fillable.toFixed(2)),
    levelsTaken,
  };
}

/**
 * Spend up to `proceedsUsd` walking YES asks within maxSlip of TOB / maxAsk.
 * Limit = worst (highest) ask included — IOC bid at that price lifts all better asks.
 */
export function planBuyWalkForProceeds(opts: {
  proceedsUsd: number;
  askLevels: BookLevel[];
  maxSlip: number;
  minAsk: number;
  maxAsk: number;
}): WalkFill & { contracts: number } {
  const levels = [...opts.askLevels].sort((a, b) => a[0] - b[0]);
  const tob = levels[0]?.[0] ?? 0;
  const ceil = Math.min(
    opts.maxAsk,
    tob > 0 ? Number((tob + opts.maxSlip).toFixed(4)) : opts.maxAsk,
  );
  let budget = Math.max(0, opts.proceedsUsd);
  let contracts = 0;
  let notional = 0;
  let limit = tob;
  const levelsTaken: BookLevel[] = [];
  for (const [px, sz] of levels) {
    if (budget <= 1e-9) break;
    if (px + 1e-9 < opts.minAsk) continue;
    if (px > ceil + 1e-9) break;
    const maxByUsd = Math.floor(budget / px + 1e-9);
    const take = Math.min(sz, maxByUsd);
    if (take < 1) break;
    levelsTaken.push([px, take]);
    contracts += take;
    notional += take * px;
    budget -= take * px;
    limit = px;
  }
  const vwap = contracts > 0 ? notional / contracts : tob;
  return {
    tob,
    limit: Number((limit || tob).toFixed(4)),
    vwap: Number(vwap.toFixed(4)),
    fillable: contracts,
    contracts,
    levelsTaken,
  };
}

/**
 * Size an open to stake, capped by visible ask depth within maxSlip of TOB.
 */
export function planOpenWalk(opts: {
  stakeUsd: number;
  askLevels: BookLevel[];
  maxSlip: number;
  minAsk: number;
  maxAsk: number;
}): WalkFill & { contracts: number } {
  const levels = [...opts.askLevels].sort((a, b) => a[0] - b[0]);
  const tob = levels[0]?.[0] ?? 0;
  if (!(tob > 0)) {
    return { tob: 0, limit: 0, vwap: 0, fillable: 0, contracts: 0, levelsTaken: [] };
  }
  const want = contractsForStake(opts.stakeUsd, tob);
  const ceil = Math.min(opts.maxAsk, Number((tob + opts.maxSlip).toFixed(4)));
  let left = want;
  let notional = 0;
  let fillable = 0;
  let limit = tob;
  const levelsTaken: BookLevel[] = [];
  for (const [px, sz] of levels) {
    if (left <= 1e-9) break;
    if (px + 1e-9 < opts.minAsk) continue;
    if (px > ceil + 1e-9) break;
    const roomUsd = opts.stakeUsd - notional;
    if (roomUsd <= 1e-9) break;
    const maxByUsd = Math.floor(roomUsd / px + 1e-9);
    const take = Math.min(sz, left, maxByUsd);
    if (take < 1) break;
    levelsTaken.push([px, take]);
    fillable += take;
    notional += take * px;
    left -= take;
    limit = px;
  }
  const vwap = fillable > 0 ? notional / fillable : tob;
  return {
    tob,
    limit: Number(limit.toFixed(4)),
    vwap: Number(vwap.toFixed(4)),
    fillable: Number(fillable.toFixed(2)),
    contracts: Math.floor(fillable),
    levelsTaken,
  };
}

export type GotRollGuardOpts = {
  /**
   * Paper `MIN_BUY_MID`: skip open/roll when decision buy price (mid, else ask)
   * is below this. Matches research GOT roll dust filter.
   */
  minBuyMid?: number;
  /** Skip roll when held mark (contracts×bid) is below this (live stub guard). */
  minRollNotionalUsd?: number;
  /** Require planned sell depth ≥ this fraction of held (live IOC guard). */
  minSellFillFrac?: number;
  /** Require buyContracts ≥ sellContracts × ratio after walk (live cliff). */
  minBuyToSellRatio?: number;
  /** Max successful rolls per city-day (0 = unlimited, matching paper). */
  maxRollsPerCityDay?: number;
};

/**
 * Plan open/roll for one city.
 *
 * Policy matches paper GOT research roll (`simulate_roll_policy` mode=model):
 * follow GOT bin; skip buys when mid/ask &lt; minBuyMid; full stake otherwise.
 * Execution differs only in sizing: live walks the ask/bid book within slip
 * instead of assuming a full mid fill.
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
  /**
   * Paper same-row mid for the *target* bin (from GOT daily_implied).
   * Used for minBuyMid gate; execution still walks the ask.
   */
  buyMid?: number | null;
  stakeUsd: number;
  /** Absolute ask floor for book walks. */
  minAsk: number;
  maxAsk: number;
  /** YES ask ladder on target (opens + roll buys). */
  buyAskLevels?: BookLevel[] | null;
  /** YES bid ladder on the held ticker (best first). Enables roll sell walk. */
  sellBidLevels?: BookLevel[] | null;
  /** Max absolute price walk past TOB on roll legs (default 0 = TOB only). */
  rollMaxSlip?: number;
  /** Max absolute price walk on opens when ask levels provided. */
  openMaxSlip?: number;
  guards?: GotRollGuardOpts;
}): RollPlan {
  const { bin, markets, held, day, stakeUsd, minAsk, maxAsk } = opts;
  const guards = opts.guards ?? {};
  const minBuyMid = Math.max(0, Number(guards.minBuyMid ?? 0) || 0);
  const minRollNotional = Math.max(0, Number(guards.minRollNotionalUsd ?? 0) || 0);
  const minSellFillFrac = Math.min(
    1,
    Math.max(0, Number(guards.minSellFillFrac ?? 0) || 0),
  );
  const minBuyToSell = Math.max(0, Number(guards.minBuyToSellRatio ?? 0) || 0);
  const maxRolls = Math.max(0, Math.floor(Number(guards.maxRollsPerCityDay ?? 0) || 0));

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
    // Paper dust filter: decision price is same-row mid when present, else ask.
    const decisionPx = opts.buyMid != null && opts.buyMid > 0 ? opts.buyMid : ask;
    if (minBuyMid > 0 && decisionPx + 1e-9 < minBuyMid) {
      return { action: "skip", reason: "buy_below_min_mid" };
    }

    const openSlip = Math.max(0, Number(opts.openMaxSlip ?? 0) || 0);
    if (openSlip > 0 && opts.buyAskLevels && opts.buyAskLevels.length > 0) {
      const openWalk = planOpenWalk({
        stakeUsd,
        askLevels: opts.buyAskLevels,
        maxSlip: openSlip,
        minAsk,
        maxAsk,
      });
      if (openWalk.contracts < 1) return { action: "skip", reason: "size_zero" };
      return {
        action: "open",
        bin,
        ticker: target.ticker,
        contracts: openWalk.contracts,
        limit: openWalk.limit,
        walk: {
          maxSlip: openSlip,
          tob: openWalk.tob,
          vwap: openWalk.vwap,
          fillable: openWalk.fillable,
        },
      };
    }

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
  if (maxRolls > 0 && (held.rollsToday ?? 0) >= maxRolls) {
    return { action: "skip", reason: "roll_cap" };
  }

  const bid = opts.yesBid;
  const newAsk = opts.newYesAsk;
  if (bid == null || bid <= 0) return { action: "skip", reason: "no_bid_to_sell" };
  if (newAsk == null) return { action: "skip", reason: "no_ask" };
  if (newAsk < minAsk) return { action: "skip", reason: "ask_below_min" };
  if (newAsk > maxAsk) return { action: "skip", reason: "ask_above_max" };
  const decisionPx = opts.buyMid != null && opts.buyMid > 0 ? opts.buyMid : newAsk;
  if (minBuyMid > 0 && decisionPx + 1e-9 < minBuyMid) {
    return { action: "skip", reason: "buy_below_min_mid" };
  }

  const mark = held.contracts * bid;
  if (minRollNotional > 0 && mark + 1e-9 < minRollNotional) {
    return { action: "skip", reason: "min_roll_notional" };
  }

  const maxSlip = Math.max(0, Number(opts.rollMaxSlip ?? 0) || 0);
  const canWalk =
    maxSlip > 0
    && opts.sellBidLevels
    && opts.sellBidLevels.length > 0
    && opts.buyAskLevels
    && opts.buyAskLevels.length > 0;

  let sellContracts = held.contracts;
  let sellLimit = bid;
  let buyContracts = 0;
  let buyLimit = newAsk;
  let walkMeta: Extract<RollPlan, { action: "roll" }>["walk"];

  if (canWalk) {
    const sellWalk = planSellWalk({
      wantContracts: held.contracts,
      bidLevels: opts.sellBidLevels!,
      maxSlip,
      minBid: 0.01,
    });
    if (sellWalk.fillable < 1) return { action: "skip", reason: "no_bid_to_sell" };
    if (
      minSellFillFrac > 0
      && sellWalk.fillable + 1e-9 < held.contracts * minSellFillFrac
    ) {
      return { action: "skip", reason: "sell_depth_thin" };
    }
    const proceeds = sellWalk.vwap * sellWalk.fillable;
    const buyWalk = planBuyWalkForProceeds({
      proceedsUsd: proceeds,
      askLevels: opts.buyAskLevels!,
      maxSlip,
      minAsk,
      maxAsk,
    });
    if (buyWalk.contracts < 1) return { action: "skip", reason: "roll_size_zero" };
    sellContracts = held.contracts;
    sellLimit = sellWalk.limit;
    buyContracts = buyWalk.contracts;
    buyLimit = buyWalk.limit;
    walkMeta = {
      maxSlip,
      sellTob: sellWalk.tob,
      sellVwap: sellWalk.vwap,
      sellFillable: sellWalk.fillable,
      buyTob: buyWalk.tob,
      buyVwap: buyWalk.vwap,
    };
  } else {
    const proceeds = held.contracts * bid;
    buyContracts = Math.floor(proceeds / newAsk);
    if (buyContracts < 1) return { action: "skip", reason: "roll_size_zero" };
  }

  if (
    minBuyToSell > 0
    && buyContracts + 1e-9 < sellContracts * minBuyToSell
  ) {
    return { action: "skip", reason: "roll_cliff" };
  }

  return {
    action: "roll",
    fromBin: held.bin,
    fromTicker: held.ticker,
    sellContracts,
    sellLimit,
    toBin: bin,
    toTicker: target.ticker,
    buyContracts,
    buyLimit,
    walk: walkMeta,
  };
}

export function eventTickerFor(series: string, day: string): string {
  return `${series}-${day.toUpperCase()}`;
}
