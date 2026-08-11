import assert from "node:assert/strict";
import {
  contractsForStake,
  eventTickerFor,
  findMarketForBin,
  marketsFromKalshi,
  parseDailyHighSubtitle,
  planBuyWalkForProceeds,
  planGotRoll,
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
    stakeUsd: 20,
    minAsk: 0.05,
    maxAsk: 0.95,
  });
  assert.equal(open.action, "open");
  if (open.action === "open") {
    assert.equal(open.contracts, 50); // 20/0.4
    assert.equal(open.ticker, "KXHIGHCHI-26AUG11-B88.5");
  }

  const dust = planGotRoll({
    bin: "88-89",
    markets,
    held: null,
    day: "26AUG11",
    yesAsk: 0.04,
    yesBid: 0.03,
    newYesAsk: null,
    stakeUsd: 20,
    minAsk: 0.05,
    maxAsk: 0.95,
  });
  assert.equal(dust.action, "skip");

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
    stakeUsd: 20,
    minAsk: 0.05,
    maxAsk: 0.95,
  });
  assert.equal(roll.action, "roll");
  if (roll.action === "roll") {
    // proceeds 50*0.5=25 → buy 25/0.25=100
    assert.equal(roll.buyContracts, 100);
    assert.equal(roll.toBin, "86-87");
  }

  assert.equal(contractsForStake(20, 0.22), 90);
}

function testWalkHelpers(): void {
  const asks = yesAskLevelsFromBook({
    noBids: [[0.76, 10], [0.75, 40], [0.74, 100]], // → asks 0.24, 0.25, 0.26
  });
  assert.deepEqual(asks.map(([p]) => p), [0.24, 0.25, 0.26]);
  const bids = yesBidLevelsFromBook({
    yesBids: [[0.2, 5], [0.21, 13], [0.19, 50]],
  });
  assert.equal(bids[0][0], 0.21);

  // Thin TOB (13 @ 0.21) — 3¢ walk should reach 0.19 and fill 54.
  const sell = planSellWalk({
    wantContracts: 54,
    bidLevels: [[0.21, 13], [0.2, 20], [0.19, 40], [0.15, 100]],
    maxSlip: 0.03,
  });
  assert.equal(sell.tob, 0.21);
  assert.equal(sell.limit, 0.19);
  assert.equal(sell.fillable, 54);
  assert.ok(sell.vwap < 0.21);

  // Without enough depth inside slip, stop early.
  const sellThin = planSellWalk({
    wantContracts: 54,
    bidLevels: [[0.21, 13], [0.2, 2]],
    maxSlip: 0.03,
  });
  assert.equal(sellThin.fillable, 15);
  assert.equal(sellThin.limit, 0.2);

  // Buy walk spends proceeds across asks within slip.
  const buy = planBuyWalkForProceeds({
    proceedsUsd: 13.45 * 0.24, // ~3.228
    askLevels: [[0.24, 10], [0.25, 50], [0.26, 50], [0.3, 100]],
    maxSlip: 0.03,
    minAsk: 0.05,
    maxAsk: 0.95,
  });
  assert.ok(buy.contracts >= 13); // more than TOB-only floor(3.228/0.24)=13
  assert.ok(buy.limit <= 0.27);
  assert.ok(buy.vwap >= 0.24);
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
    stakeUsd: 20,
    minAsk: 0.05,
    maxAsk: 0.95,
    sellBidLevels: [[0.4, 10], [0.39, 20], [0.38, 40]],
    buyAskLevels: [[0.24, 10], [0.25, 30], [0.26, 80]],
    rollMaxSlip: 0.03,
  });
  assert.equal(roll.action, "roll");
  if (roll.action === "roll") {
    assert.equal(roll.sellLimit, 0.38); // walked to fill 54
    assert.ok(roll.walk);
    assert.equal(roll.walk?.maxSlip, 0.03);
    assert.equal(roll.walk?.sellFillable, 54);
    // TOB-only would buy floor(54*0.40/0.24)=90; walk sell VWAP is lower so
    // buy count may dip, but buy limit may step past 0.24 for depth.
    assert.ok(roll.buyContracts >= 1);
    assert.ok(roll.buyLimit >= 0.24 && roll.buyLimit <= 0.27);
  }
}

testParseSubtitles();
testMarketsAndPlan();
testWalkHelpers();
testRollWalkPlan();
console.log("ok");
