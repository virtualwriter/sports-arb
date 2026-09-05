/**
 * bwin `ScoreboardSlim` → football game state.
 *
 * bwin pushes this blob over the same websocket that carries odds, and it
 * arrives well before ESPN's scoreboard poll reflects the same points. Across
 * the 3 Sep 2026 college slate bwin reached a given score first on 195 of 241
 * matched score states, with a median lead of 15.7s, so this is the fast score
 * channel for football the way `bwin_score` is for baseball.
 *
 * Shape, verified against 5,727 pushes from that slate:
 *
 *   {"scoreboard":{
 *      "totalPoints":{"player1":{"1":0,"8":0,"255":0},
 *                     "player2":{"1":7,"8":7,"255":7}},
 *      "score":"0:7","periodId":1,"period":"Q1","turn":"Player02",
 *      "activeDown":"3rd","yardsToNextDown":8,
 *      "timer":{"seconds":688,...},"started":true},
 *    "fixtureId":"6:43813"}
 *
 * Two details are load-bearing and were established empirically rather than
 * assumed:
 *
 * - `player1` is the **away** side. Matching totals against ESPN agreed with
 *   that reading 5,404 times and with the reverse only 687, and every one of
 *   those 687 is a tied score, where both readings agree anyway.
 * - The `1` / `8` / `255` buckets are **not** copies of each other; they
 *   disagreed on 4,306 of 5,727 pushes. Only `255` tracks the running
 *   full-game total, so the narrower buckets must never be summed.
 */

export type BwinFootballScore = {
  fixtureId: string | null;
  scoreAway: number;
  scoreHome: number;
  total: number;
  /** Quarter, 5+ for overtime, null when bwin has not started the clock. */
  period: number | null;
  /** Seconds left in the quarter, as bwin's timer reports it. */
  secondsLeftInPeriod: number | null;
  possession: "away" | "home" | null;
  down: number | null;
  /** Yards to the next first down. */
  distance: number | null;
  started: boolean;
};

const DOWNS: Record<string, number> = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4 };

/** The full-game bucket; `1` and `8` are narrower and disagree with it. */
const TOTAL_BUCKET = "255";

function asRecord(value: unknown): Record<string, any> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, any>) : null;
}

function intOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * bwin numbers the periods with the breaks in between, so the quarters land on
 * the odd values: 1 = Q1, 3 = Q2, 5 = Q3, 7 = Q4, 9 = first overtime. An even
 * id is a break (halftime and the like) and reports the quarter just played.
 */
function quarterOf(periodId: number | null, period: unknown): number | null {
  if (periodId != null && periodId > 0) return Math.floor((periodId + 1) / 2);
  const text = typeof period === "string" ? period : "";
  const m = text.match(/^Q(\d)$/i);
  if (m) return Number(m[1]);
  if (/^ot/i.test(text)) return 5;
  return null;
}

/**
 * Parse a `ScoreboardSlim` payload. Accepts the raw JSON string we record, the
 * decoded envelope, or the inner `scoreboard` object. Returns null when the
 * blob carries no usable score rather than guessing a 0-0.
 */
export function parseBwinFootballScoreboard(payload: unknown): BwinFootballScore | null {
  const outer = asRecord(payload);
  if (!outer) return null;
  const sb = asRecord(outer.scoreboard) ?? outer;

  const points = asRecord(sb.totalPoints);
  const away = asRecord(points?.player1);
  const home = asRecord(points?.player2);
  let scoreAway = intOrNull(away?.[TOTAL_BUCKET]);
  let scoreHome = intOrNull(home?.[TOTAL_BUCKET]);

  // `score` is "away:home" and agreed with the 255 buckets on every push we
  // have; it is the fallback when totalPoints is absent from a partial update.
  if (scoreAway == null || scoreHome == null) {
    const text = typeof sb.score === "string" ? sb.score : "";
    const m = text.match(/^(\d+)\s*:\s*(\d+)$/);
    if (!m) return null;
    scoreAway = Number(m[1]);
    scoreHome = Number(m[2]);
  }

  const turn = typeof sb.turn === "string" ? sb.turn : "";
  const timer = asRecord(sb.timer);

  return {
    fixtureId: typeof outer.fixtureId === "string" ? outer.fixtureId
      : typeof sb.id === "string" ? sb.id : null,
    scoreAway,
    scoreHome,
    total: scoreAway + scoreHome,
    period: quarterOf(intOrNull(sb.periodId), sb.period),
    secondsLeftInPeriod: intOrNull(timer?.seconds),
    possession: /player0?1/i.test(turn) ? "away" : /player0?2/i.test(turn) ? "home" : null,
    down: DOWNS[String(sb.activeDown ?? "").toLowerCase()] ?? null,
    distance: intOrNull(sb.yardsToNextDown),
    started: sb.started === true,
  };
}
