import assert from "node:assert/strict";
import {
  contractsForStake,
  eventTickerFor,
  findMarketForBin,
  marketsFromKalshi,
  parseDailyHighSubtitle,
  planBuyWalkForProceeds,
  planGotRoll,
  planOpenWalk,
  planSellWalk,
  yesAskLevelsFromBook,
  yesBidLevelsFromBook,
} from "./weather-got-roll.js";

function testParseSubtitles(): void {
  assert.deepEqual(parseDailyHighSubtitle("82° to 83°"), {
    lo: 82,
    hi: 83,
    label: "82-83",
  });
  assert.deepEqual(parseDailyHighSubtitle("81° or below"), {
    lo: -999,
    hi: 81,
    label: "<=81",
  });
  assert.deepEqual(parseDailyHighSubtitle("90° or above"), {
    lo: 90,
    hi: 999,
    label: ">=90",
  });
}

function testMarketsAndPlan(): void {
  const markets = marketsFromKalshi([
    { ticker: "KXHIGHCHI-26AUG11-B88.5", yes_sub_title: "88° to 89°", status: "active" },
    { ticker: "KXHIGHCHI-26AUG11-B86.5", yes_sub_title: "86° to 87°", status: "active" },
    { ticker: "KXHIGHCHI-26AUG11-T89", yes_sub_title: "90° or above", status: "active" },
  ]);
  assert.equal(markets.length, 3);
  assert.equal(findMarketForBin(markets, "88-89")?.ticker, "KXHIGHCHI-26AUG11-B88.5");
  assert.equal(eventTickerFor("KXHIGHCHI", "26aug11"), "KXHIGHCHI-26AUG11");

  const open = planGotRoll({
    bin: "88-89",
    markets,
    held: null,
    day: "26AUG11",
    yesAsk: 0.4,
    yesBid: 0.35,
    newYesAsk: null,
    buyMid: 0.37,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05 },
  });
  assert.equal(open.action, "open");
  if (open.action === "open") {
    assert.equal(open.contracts, 50); // 20/0.4
    assert.equal(open.ticker, "KXHIGHCHI-26AUG11-B88.5");
  }

  // Paper dust filter: mid below minBuyMid → skip (no probe).
  const dust = planGotRoll({
    bin: "88-89",
    markets,
    held: null,
    day: "26AUG11",
    yesAsk: 0.04,
    yesBid: 0.02,
    newYesAsk: null,
    buyMid: 0.03,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05 },
  });
  assert.equal(dust.action, "skip");
  if (dust.action === "skip") assert.equal(dust.reason, "buy_below_min_mid");

  const roll = planGotRoll({
    bin: "86-87",
    markets,
    held: {
      day: "26AUG11",
      bin: "88-89",
      ticker: "KXHIGHCHI-26AUG11-B88.5",
      contracts: 50,
      avgEntry: 0.4,
      openedAt: "t0",
      lastActionAt: "t0",
    },
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.5,
    newYesAsk: 0.25,
    buyMid: 0.25,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05 },
  });
  assert.equal(roll.action, "roll");
  if (roll.action === "roll") {
    assert.equal(roll.buyContracts, 100);
    assert.equal(roll.toBin, "86-87");
  }

  // Roll into dust bin blocked (paper min_buy_mid).
  const intoDust = planGotRoll({
    bin: "86-87",
    markets,
    held: {
      day: "26AUG11",
      bin: "88-89",
      ticker: "KXHIGHCHI-26AUG11-B88.5",
      contracts: 50,
      avgEntry: 0.4,
      openedAt: "t0",
      lastActionAt: "t0",
    },
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.5,
    newYesAsk: 0.03,
    buyMid: 0.03,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05 },
  });
  assert.equal(intoDust.action, "skip");
  if (intoDust.action === "skip") assert.equal(intoDust.reason, "buy_below_min_mid");

  assert.equal(contractsForStake(20, 0.22), 90);
}

function testWalkHelpers(): void {
  const asks = yesAskLevelsFromBook({
    noBids: [[0.76, 10], [0.75, 40], [0.74, 100]],
  });
  assert.deepEqual(asks.map(([p]) => p), [0.24, 0.25, 0.26]);
  const bids = yesBidLevelsFromBook({
    yesBids: [[0.2, 5], [0.21, 13], [0.19, 50]],
  });
  assert.equal(bids[0][0], 0.21);

  const sell = planSellWalk({
    wantContracts: 54,
    bidLevels: [[0.21, 13], [0.2, 20], [0.19, 40], [0.15, 100]],
    maxSlip: 0.03,
  });
  assert.equal(sell.tob, 0.21);
  assert.equal(sell.limit, 0.19);
  assert.equal(sell.fillable, 54);

  const sellThin = planSellWalk({
    wantContracts: 54,
    bidLevels: [[0.21, 13], [0.2, 2]],
    maxSlip: 0.03,
  });
  assert.equal(sellThin.fillable, 15);

  const buy = planBuyWalkForProceeds({
    proceedsUsd: 13.45 * 0.24,
    askLevels: [[0.24, 10], [0.25, 50], [0.26, 50], [0.3, 100]],
    maxSlip: 0.03,
    minAsk: 0.05,
    maxAsk: 0.95,
  });
  assert.ok(buy.contracts >= 13);
  assert.ok(buy.limit <= 0.27);

  const openWalk = planOpenWalk({
    stakeUsd: 20,
    askLevels: [[0.08, 70], [0.09, 50], [0.1, 200]],
    maxSlip: 0.03,
    minAsk: 0.05,
    maxAsk: 0.95,
  });
  assert.ok(openWalk.contracts < contractsForStake(20, 0.08));
  assert.ok(openWalk.contracts >= 70);
}

function testRollWalkPlan(): void {
  const markets = marketsFromKalshi([
    { ticker: "KXHIGHCHI-26AUG11-B80.5", yes_sub_title: "80° to 81°", status: "active" },
    { ticker: "KXHIGHCHI-26AUG11-B82.5", yes_sub_title: "82° to 83°", status: "active" },
  ]);
  const roll = planGotRoll({
    bin: "82-83",
    markets,
    held: {
      day: "26AUG11",
      bin: "80-81",
      ticker: "KXHIGHCHI-26AUG11-B80.5",
      contracts: 54,
      avgEntry: 0.37,
      openedAt: "t0",
      lastActionAt: "t0",
    },
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.4,
    newYesAsk: 0.24,
    buyMid: 0.24,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    sellBidLevels: [[0.4, 10], [0.39, 20], [0.38, 40]],
    buyAskLevels: [[0.24, 10], [0.25, 30], [0.26, 80]],
    rollMaxSlip: 0.03,
    guards: { minBuyMid: 0.05 },
  });
  assert.equal(roll.action, "roll");
  if (roll.action === "roll") {
    assert.equal(roll.sellLimit, 0.38);
    assert.ok(roll.walk);
    assert.equal(roll.walk?.sellFillable, 54);
    assert.ok(roll.buyContracts >= 1);
  }
}

function testGuards(): void {
  const markets = marketsFromKalshi([
    { ticker: "KXHIGHLAX-26AUG11-B76.5", yes_sub_title: "76° to 77°", status: "active" },
    { ticker: "KXHIGHLAX-26AUG11-B78.5", yes_sub_title: "78° to 79°", status: "active" },
  ]);
  const held = {
    day: "26AUG11",
    bin: "76-77",
    ticker: "KXHIGHLAX-26AUG11-B76.5",
    contracts: 45,
    avgEntry: 0.27,
    openedAt: "t0",
    lastActionAt: "t0",
    rollsToday: 0,
  };

  const cliff = planGotRoll({
    bin: "78-79",
    markets,
    held,
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.04,
    newYesAsk: 0.8,
    buyMid: 0.8,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    sellBidLevels: [[0.04, 100]],
    buyAskLevels: [[0.8, 100]],
    rollMaxSlip: 0.03,
    guards: { minBuyMid: 0.05, minBuyToSellRatio: 0.5, minSellFillFrac: 0.95, minRollNotionalUsd: 1 },
  });
  assert.equal(cliff.action, "skip");
  if (cliff.action === "skip") assert.equal(cliff.reason, "roll_cliff");

  const stub = planGotRoll({
    bin: "78-79",
    markets,
    held: { ...held, contracts: 2 },
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.5,
    newYesAsk: 0.5,
    buyMid: 0.5,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05, minRollNotionalUsd: 5 },
  });
  assert.equal(stub.action, "skip");
  if (stub.action === "skip") assert.equal(stub.reason, "min_roll_notional");

  const thin = planGotRoll({
    bin: "78-79",
    markets,
    held,
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.4,
    newYesAsk: 0.4,
    buyMid: 0.4,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    sellBidLevels: [[0.4, 10]],
    buyAskLevels: [[0.4, 100]],
    rollMaxSlip: 0.03,
    guards: { minBuyMid: 0.05, minSellFillFrac: 0.95, minBuyToSellRatio: 0.5 },
  });
  assert.equal(thin.action, "skip");
  if (thin.action === "skip") assert.equal(thin.reason, "sell_depth_thin");

  // Unlimited rolls when maxRolls=0 (paper).
  const uncapped = planGotRoll({
    bin: "78-79",
    markets,
    held: { ...held, contracts: 50, rollsToday: 99 },
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.5,
    newYesAsk: 0.5,
    buyMid: 0.5,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05, maxRollsPerCityDay: 0 },
  });
  assert.equal(uncapped.action, "roll");

  const capped = planGotRoll({
    bin: "78-79",
    markets,
    held: { ...held, contracts: 50, rollsToday: 5 },
    day: "26AUG11",
    yesAsk: null,
    yesBid: 0.5,
    newYesAsk: 0.5,
    buyMid: 0.5,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    guards: { minBuyMid: 0.05, maxRollsPerCityDay: 5 },
  });
  assert.equal(capped.action, "skip");
  if (capped.action === "skip") assert.equal(capped.reason, "roll_cap");

  const open = planGotRoll({
    bin: "76-77",
    markets,
    held: null,
    day: "26AUG11",
    yesAsk: 0.2,
    yesBid: 0.19,
    newYesAsk: null,
    buyMid: 0.2,
    stakeUsd: 20,
    minAsk: 0.01,
    maxAsk: 0.95,
    buyAskLevels: [[0.2, 30], [0.21, 20]],
    openMaxSlip: 0.03,
    guards: { minBuyMid: 0.05 },
  });
  assert.equal(open.action, "open");
  if (open.action === "open") {
    assert.equal(open.contracts, 50);
    assert.ok(open.walk);
  }
}

testParseSubtitles();
testMarketsAndPlan();
testWalkHelpers();
testRollWalkPlan();
testGuards();
console.log("ok");
