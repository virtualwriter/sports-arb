import { describe, expect, it } from "vitest";
import { parseBwinFootballScoreboard } from "./bwin-football-score.js";

/**
 * Captured verbatim from
 * football-ladder-race-ncaaf-akr-wake-2026-09-03, the two pushes bracketing
 * the extra point that took Wake Forest from 6 to 7.
 */
const BEFORE = '{"scoreboard":{"totalPoints":{"player1":{"1":0,"8":0,"255":0},'
  + '"player2":{"1":6,"8":6,"255":6}},"touchdowns":{"player1":{"1":0,"8":0,"255":0},'
  + '"player2":{"1":1,"8":1,"255":1}},"yardsToNextDown":8,"yardsDistance":27,'
  + '"activeDown":"3rd","sportId":11,"id":"6:43813","period":"Q1","periodId":1,'
  + '"points":[],"turn":"Player02","score":"0:6","timer":{"running":false,'
  + '"base":"2026-09-03T23:10:10Z","visible":true,"seconds":688},'
  + '"indicator":"\u2022 11:28","started":true},"fixtureId":"6:43813"}';

const AFTER = BEFORE.replace('"255":6}', '"255":7}').replace('"score":"0:6"', '"score":"0:7"');

describe("parseBwinFootballScoreboard", () => {
  it("reads the away/home split, clock and situation from a real push", () => {
    const s = parseBwinFootballScoreboard(BEFORE);
    expect(s).not.toBeNull();
    expect(s!.scoreAway).toBe(0);
    expect(s!.scoreHome).toBe(6);
    expect(s!.total).toBe(6);
    expect(s!.period).toBe(1);
    expect(s!.secondsLeftInPeriod).toBe(688);
    expect(s!.possession).toBe("home");
    expect(s!.down).toBe(3);
    expect(s!.distance).toBe(8);
    expect(s!.fixtureId).toBe("6:43813");
    expect(s!.started).toBe(true);
  });

  it("sees the point that the straddling pair brackets", () => {
    const before = parseBwinFootballScoreboard(BEFORE)!;
    const after = parseBwinFootballScoreboard(AFTER)!;
    expect(after.total - before.total).toBe(1);
  });

  it("accepts a decoded object and a bare scoreboard alike", () => {
    const envelope = JSON.parse(BEFORE);
    expect(parseBwinFootballScoreboard(envelope)!.total).toBe(6);
    expect(parseBwinFootballScoreboard(envelope.scoreboard)!.total).toBe(6);
  });

  it("maps bwin's odd period ids onto quarters", () => {
    const at = (periodId: number) =>
      parseBwinFootballScoreboard(
        JSON.stringify({ scoreboard: { score: "7:7", periodId } }),
      )!.period;
    expect([at(1), at(3), at(5), at(7)]).toEqual([1, 2, 3, 4]);
    expect(at(9)).toBe(5); // overtime
  });

  it("ignores the narrower buckets, which disagree with the running total", () => {
    // Only 255 tracks the full game; 1 and 8 are period-scoped.
    const s = parseBwinFootballScoreboard(JSON.stringify({
      scoreboard: {
        totalPoints: { player1: { 1: 3, 8: 3, 255: 24 }, player2: { 1: 0, 8: 7, 255: 31 } },
        score: "24:31",
      },
    }))!;
    expect([s.scoreAway, s.scoreHome, s.total]).toEqual([24, 31, 55]);
  });

  it("falls back to the score string when totalPoints is missing", () => {
    const s = parseBwinFootballScoreboard('{"scoreboard":{"score":"14:21"}}')!;
    expect([s.scoreAway, s.scoreHome]).toEqual([14, 21]);
  });

  it("returns null rather than inventing 0-0 for an unusable payload", () => {
    expect(parseBwinFootballScoreboard('{"scoreboard":{"period":"Q1"}}')).toBeNull();
    expect(parseBwinFootballScoreboard("not json")).toBeNull();
    expect(parseBwinFootballScoreboard(null)).toBeNull();
  });
});
