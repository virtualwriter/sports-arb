import { describe, expect, it } from "vitest";
import { cancelIndicatesMatched, InventoryLedger } from "./inventory-ledger.js";

const UP = "111111111111111111111111111111111111111111111111111111111111111111111111111111";
const DOWN = "222222222222222222222222222222222222222222222222222222222222222222222222222222";
const ENTRY_DOWN = "0xentry-down";
const COMP_UP = "0xcompletion-up";
const DUST = 0.01;

function entryDownFilled(ledger: InventoryLedger, shares = 50) {
  ledger.trackPost({ orderId: ENTRY_DOWN, tokenId: DOWN, side: "down", role: "entry", requestedShares: shares, status: "live" });
  ledger.recordMatched(ENTRY_DOWN, shares, "user_ws_fill");
  ledger.recordCancelResult(ENTRY_DOWN, { ok: true, notCanceled: { [ENTRY_DOWN]: "matched orders can't be canceled" } });
}

describe("ETH reactive-error-while-matching scenario (2026-06-09)", () => {
  // Replays the exact event sequence the runner saw: the DOWN entry filled,
  // the completion maker bid for UP at 0.56 matched on the exchange, but
  // getOrder read back nothing (archived), the cancel was rejected as
  // matched, and the follow-up FAK failed on balance because the matching
  // bid had consumed it. The old code summed the completion as zero and
  // fired the nuclear stop on the paired DOWN leg.
  it("classifies the leg as paired, not naked", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);

    // Reactive completion maker bid posts and rests.
    ledger.trackPost({ orderId: COMP_UP, tokenId: UP, side: "up", role: "completion", requestedShares: 50, status: "live" });
    // Wait-loop polls: the order matched and was archived, so getOrder
    // returns nothing. Zero must not count as no-fill evidence.
    ledger.recordOrderLookup(COMP_UP, 0, "get_order_poll");
    expect(ledger.order(COMP_UP)?.state).toBe("posted");

    // Cancel rejected: the order is fully matched.
    ledger.recordCancelResult(COMP_UP, { ok: true, notCanceled: { [COMP_UP]: "matched orders can't be canceled" } });
    expect(ledger.order(COMP_UP)?.state).toBe("filled");
    expect(ledger.matchedShares(COMP_UP)).toBe(50);

    // Stage-3 FAK rejected for balance (funds tied up by the matching bid).
    // A definitive rejection means that order bought nothing - but it says
    // nothing about the maker bid, which the ledger already settled.
    ledger.trackFailedPost({ tokenId: UP, side: "up", role: "completion", requestedShares: 50, error: "not enough balance / allowance" });

    const decision = ledger.nakedDecision(DUST);
    expect(decision.state).toBe("paired");
    expect(decision.filled).toEqual({ up: 50, down: 50 });
    expect(decision.imbalance).toBe(0);
    expect(decision.blockedBy).toEqual([]);
  });

  it("old-code equivalent (ignoring the cancel rejection) would have read the leg as naked", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);
    ledger.trackPost({ orderId: COMP_UP, tokenId: UP, side: "up", role: "completion", requestedShares: 50, status: "live" });
    ledger.recordOrderLookup(COMP_UP, 0, "get_order_poll");
    // Without the cancel evidence the order stays non-terminal, so the
    // ledger refuses the naked classification instead of guessing.
    const decision = ledger.nakedDecision(DUST);
    expect(decision.state).toBe("completion_in_flight");
    expect(decision.blockedBy).toEqual([COMP_UP]);
  });
});

describe("completion-in-flight guard", () => {
  it("blocks naked classification on an ambiguous completion post failure", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);
    const failed = ledger.trackFailedPost({ tokenId: UP, side: "up", role: "completion", requestedShares: 50, error: "fetch failed: socket hang up" });
    expect(failed.state).toBe("unresolved");

    const decision = ledger.nakedDecision(DUST);
    expect(decision.state).toBe("completion_in_flight");
    expect(decision.blockedBy).toEqual([failed.orderId]);

    // Audit found no fill evidence; the leg is then genuinely naked.
    ledger.resolveNoFurtherFill(failed.orderId, "audit_exhausted_no_fill_evidence");
    const resolved = ledger.nakedDecision(DUST);
    expect(resolved.state).toBe("naked");
    expect(resolved.imbalanceSide).toBe("down");
    expect(resolved.imbalance).toBe(50);
  });

  it("does not block on a definitive balance rejection alone", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);
    ledger.trackFailedPost({ tokenId: UP, side: "up", role: "completion", requestedShares: 50, error: "not enough balance / allowance" });
    const decision = ledger.nakedDecision(DUST);
    expect(decision.state).toBe("naked");
    expect(decision.imbalanceSide).toBe("down");
  });

  it("counts a partial completion fill confirmed by the audit", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);
    ledger.trackPost({ orderId: COMP_UP, tokenId: UP, side: "up", role: "completion", requestedShares: 50, status: "live" });
    ledger.recordCancelResult(COMP_UP, { ok: false, error: "timeout" });
    expect(ledger.nakedDecision(DUST).state).toBe("completion_in_flight");

    ledger.recordOrderLookup(COMP_UP, 12.5, "audit_trades_sweep_0");
    ledger.resolveNoFurtherFill(COMP_UP, "audit_exhausted_no_fill_evidence");
    const decision = ledger.nakedDecision(DUST);
    expect(decision.state).toBe("naked");
    expect(decision.filled).toEqual({ up: 12.5, down: 50 });
    expect(decision.imbalance).toBe(37.5);
  });
});

describe("fill floors are monotonic", () => {
  it("never lowers a confirmed fill on a later empty read", () => {
    const ledger = new InventoryLedger();
    ledger.trackPost({ orderId: COMP_UP, tokenId: UP, side: "up", role: "completion", requestedShares: 50, status: "live" });
    ledger.recordMatched(COMP_UP, 20, "post_response");
    ledger.recordOrderLookup(COMP_UP, 0, "get_order_archived");
    expect(ledger.matchedShares(COMP_UP)).toBe(20);
    expect(ledger.order(COMP_UP)?.state).toBe("partially_matched");
  });

  it("keeps the floor and terminal state after a clean cancel", () => {
    const ledger = new InventoryLedger();
    ledger.trackPost({ orderId: COMP_UP, tokenId: UP, side: "up", role: "completion", requestedShares: 50, status: "live" });
    ledger.recordMatched(COMP_UP, 20, "get_order_poll");
    ledger.recordCancelResult(COMP_UP, { ok: true });
    expect(ledger.order(COMP_UP)?.state).toBe("canceled");
    // A fill that raced the cancel still raises the floor without reopening.
    ledger.recordMatched(COMP_UP, 25, "audit_trades_sweep_0");
    expect(ledger.matchedShares(COMP_UP)).toBe(25);
    expect(ledger.order(COMP_UP)?.state).toBe("canceled");
  });
});

describe("taker (FAK) results are terminal", () => {
  it("never blocks a naked decision", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);
    ledger.trackTakerResult({ orderId: "0xfak-up", tokenId: UP, side: "up", role: "completion", requestedShares: 50, boughtShares: 0 });
    expect(ledger.order("0xfak-up")?.state).toBe("canceled");
    expect(ledger.nakedDecision(DUST).state).toBe("naked");
  });

  it("records partial taker fills", () => {
    const ledger = new InventoryLedger();
    entryDownFilled(ledger);
    ledger.trackTakerResult({ orderId: "0xfak-up", tokenId: UP, side: "up", role: "completion", requestedShares: 50, boughtShares: 50 });
    expect(ledger.order("0xfak-up")?.state).toBe("filled");
    expect(ledger.nakedDecision(DUST).state).toBe("paired");
  });
});

describe("cancelIndicatesMatched", () => {
  it("detects matched rejections in notCanceled and in thrown errors", () => {
    expect(cancelIndicatesMatched({ ok: true, notCanceled: { a: "matched orders can't be canceled" } })).toBe(true);
    expect(cancelIndicatesMatched({ ok: false, error: "order is matched and cannot be canceled" })).toBe(true);
    expect(cancelIndicatesMatched({ ok: true })).toBe(false);
    expect(cancelIndicatesMatched({ ok: false, error: "timeout" })).toBe(false);
    expect(cancelIndicatesMatched(null)).toBe(false);
  });
});
