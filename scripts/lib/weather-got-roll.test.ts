import assert from "node:assert/strict";
import {
  contractsForStake,
  eventTickerFor,
  findMarketForBin,
  marketsFromKalshi,
  parseDailyHighSubtitle,
  planGotRoll,
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

testParseSubtitles();
testMarketsAndPlan();
console.log("ok");
