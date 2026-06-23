// In-memory per-order inventory ledger for the 5m up/down maker runner.
//
// The runner posts entry bids, fires completion buys after one-sided fills,
// and exits naked legs with FAK sells. Each of those orders can land in an
// ambiguous state (archived after a full match, cancel racing a fill, post
// error while the order is actually matching). The ETH 2026-06-09 session
// showed the cost of guessing: a completion maker bid was matching while a
// follow-up FAK was rejected for balance, the code read the completion as
// zero, and the paired leg was nuked as naked.
//
// The ledger tracks one state per order, treats confirmed fills as a
// monotonic floor, and refuses to call a leg naked while any complement-side
// order's outcome is unknown. CLOB size_matched and the trades sweep feed it
// as audit evidence; they are never re-derived in the hot path.

export type LedgerSide = "up" | "down";
export type LedgerRole = "entry" | "completion";
export type LedgerOrderState =
  | "posted"            // accepted by the exchange, no confirmed fills yet
  | "partially_matched" // confirmed fills below the requested size, may still rest
  | "filled"            // confirmed fully matched
  | "canceled"          // terminal; matchedShares is the final fill
  | "rejected"          // never reached the book; definitively zero fill
  | "unresolved";       // ambiguous evidence; may be matching right now

export type LedgerOrder = {
  orderId: string;
  tokenId: string;
  side: LedgerSide;
  role: LedgerRole;
  requestedShares: number;
  matchedShares: number;
  state: LedgerOrderState;
  evidence: string[];
};

export type LegState = "flat" | "paired" | "naked" | "completion_in_flight";

export type NakedDecision = {
  state: LegState;
  filled: { up: number; down: number };
  matched: number;
  imbalance: number;
  imbalanceSide: LedgerSide | null;
  // Order ids whose unknown outcome blocks a naked classification.
  blockedBy: string[];
};

export type CancelResult = { ok?: boolean; error?: string; notCanceled?: unknown };

const SHARE_EPSILON = 1e-6;
const TERMINAL_STATES = new Set<LedgerOrderState>(["filled", "canceled", "rejected"]);

// Error messages proving the exchange never accepted the order. Anything else
// (timeouts, socket resets, 5xx) leaves open the possibility that the order
// reached the book and is matching right now.
const DEFINITIVE_REJECTION_RE =
  /not enough balance|allowance|invalid|minimum|min size|tick size|expired|signature|unauthorized|max.*size/i;

function roundShares(value: number): number {
  return Math.floor(Math.max(0, value) * 1_000_000) / 1_000_000;
}

// A cancel rejected because the order matched is the only reliable full-fill
// signal once the order is archived (getOrder returns nothing for it).
export function cancelIndicatesMatched(cancel: CancelResult | null | undefined): boolean {
  if (!cancel) return false;
  const reasons = [
    cancel.error ?? "",
    ...(cancel.notCanceled && typeof cancel.notCanceled === "object"
      ? Object.values(cancel.notCanceled as Record<string, unknown>).map(String)
      : []),
  ].join(" ");
  return /matched/i.test(reasons);
}

export class InventoryLedger {
  private orders = new Map<string, LedgerOrder>();
  private syntheticSeq = 0;

  private add(order: LedgerOrder): LedgerOrder {
    this.orders.set(order.orderId, order);
    return order;
  }

  private syntheticId(prefix: string): string {
    this.syntheticSeq += 1;
    return `${prefix}-${this.syntheticSeq}`;
  }

  order(orderId: string): LedgerOrder | undefined {
    return this.orders.get(orderId);
  }

  matchedShares(orderId: string): number {
    return this.orders.get(orderId)?.matchedShares ?? 0;
  }

  // Register a posted GTC/limit order from its post response status.
  trackPost(params: {
    orderId: string;
    tokenId: string;
    side: LedgerSide;
    role: LedgerRole;
    requestedShares: number;
    status?: string;
  }): LedgerOrder {
    const status = (params.status ?? "").toLowerCase();
    const matched = status === "matched" ? params.requestedShares : 0;
    const state: LedgerOrderState = status === "matched"
      ? "filled"
      : status === "live"
        ? "posted"
        : "unresolved";
    return this.add({
      orderId: params.orderId,
      tokenId: params.tokenId,
      side: params.side,
      role: params.role,
      requestedShares: params.requestedShares,
      matchedShares: roundShares(matched),
      state,
      evidence: [`post status=${status || "unknown"}`],
    });
  }

  // Register a FAK/FOK whose response is already terminal: it either bought
  // boughtShares or was killed; it can never rest and fill later.
  trackTakerResult(params: {
    orderId?: string;
    tokenId: string;
    side: LedgerSide;
    role: LedgerRole;
    requestedShares: number;
    boughtShares: number;
  }): LedgerOrder {
    const bought = roundShares(Math.max(0, params.boughtShares));
    return this.add({
      orderId: params.orderId ?? this.syntheticId("taker"),
      tokenId: params.tokenId,
      side: params.side,
      role: params.role,
      requestedShares: params.requestedShares,
      matchedShares: bought,
      state: bought + SHARE_EPSILON >= params.requestedShares ? "filled" : "canceled",
      evidence: [`fak terminal bought=${bought}`],
    });
  }

  // Register a post attempt that threw. A definitive exchange rejection means
  // zero fill; an ambiguous transport error means the order may be matching.
  trackFailedPost(params: {
    tokenId: string;
    side: LedgerSide;
    role: LedgerRole;
    requestedShares: number;
    error: string;
  }): LedgerOrder {
    const definitive = DEFINITIVE_REJECTION_RE.test(params.error);
    return this.add({
      orderId: this.syntheticId("failed-post"),
      tokenId: params.tokenId,
      side: params.side,
      role: params.role,
      requestedShares: params.requestedShares,
      matchedShares: 0,
      state: definitive ? "rejected" : "unresolved",
      evidence: [`post failed (${definitive ? "definitive" : "ambiguous"}): ${params.error.slice(0, 200)}`],
    });
  }

  // Raise the confirmed fill floor. Fills are monotonic: no later read may
  // lower them (archived orders and lagging feeds legitimately return less).
  recordMatched(orderId: string, shares: number, evidence: string) {
    const order = this.orders.get(orderId);
    if (!order || !(shares > order.matchedShares + SHARE_EPSILON)) return;
    order.matchedShares = roundShares(Math.min(shares, order.requestedShares));
    order.evidence.push(`${evidence} matched=${order.matchedShares}`);
    if (TERMINAL_STATES.has(order.state)) return;
    order.state = order.matchedShares + SHARE_EPSILON >= order.requestedShares
      ? "filled"
      : "partially_matched";
  }

  // getOrder size_matched. Zero is NOT evidence of no fill: fully matched
  // orders are archived and read back as nothing.
  recordOrderLookup(orderId: string, matchedShares: number, evidence: string) {
    if (matchedShares > 0) this.recordMatched(orderId, matchedShares, evidence);
  }

  recordCancelResult(orderId: string, cancel: CancelResult) {
    const order = this.orders.get(orderId);
    if (!order) return;
    if (cancelIndicatesMatched(cancel)) {
      order.evidence.push("cancel rejected as matched");
      order.matchedShares = order.requestedShares;
      order.state = "filled";
      return;
    }
    if (cancel.ok) {
      order.evidence.push("cancel ok");
      if (!TERMINAL_STATES.has(order.state)) order.state = "canceled";
      return;
    }
    order.evidence.push(`cancel failed: ${(cancel.error ?? "").slice(0, 200)}`);
    if (!TERMINAL_STATES.has(order.state)) order.state = "unresolved";
  }

  // Audit gave up finding any further fill (getOrder + trades sweep both
  // silent); close the order at its confirmed floor so decisions can proceed.
  resolveNoFurtherFill(orderId: string, evidence: string) {
    const order = this.orders.get(orderId);
    if (!order || TERMINAL_STATES.has(order.state)) return;
    order.evidence.push(evidence);
    order.state = "canceled";
  }

  nonTerminalOrders(): LedgerOrder[] {
    return [...this.orders.values()].filter((order) => !TERMINAL_STATES.has(order.state));
  }

  hasNonTerminalOrders(): boolean {
    return this.nonTerminalOrders().length > 0;
  }

  confirmedFilled(): { up: number; down: number } {
    const filled = { up: 0, down: 0 };
    for (const order of this.orders.values()) filled[order.side] += order.matchedShares;
    return { up: roundShares(filled.up), down: roundShares(filled.down) };
  }

  // Orders whose unknown outcome forbids calling `nakedSide` naked: anything
  // non-terminal on the complement side (entry or completion) may already
  // have paired the leg.
  blockingOrders(nakedSide: LedgerSide): LedgerOrder[] {
    const complement: LedgerSide = nakedSide === "up" ? "down" : "up";
    return this.nonTerminalOrders().filter((order) => order.side === complement);
  }

  nakedDecision(dustShares: number): NakedDecision {
    const filled = this.confirmedFilled();
    const matched = Math.min(filled.up, filled.down);
    const imbalance = roundShares(Math.abs(filled.up - filled.down));
    if (imbalance < dustShares) {
      return {
        state: matched >= dustShares ? "paired" : "flat",
        filled,
        matched,
        imbalance,
        imbalanceSide: null,
        blockedBy: [],
      };
    }
    const imbalanceSide: LedgerSide = filled.up > filled.down ? "up" : "down";
    const blockedBy = this.blockingOrders(imbalanceSide).map((order) => order.orderId);
    return {
      state: blockedBy.length ? "completion_in_flight" : "naked",
      filled,
      matched,
      imbalance,
      imbalanceSide,
      blockedBy,
    };
  }

  snapshot(): LedgerOrder[] {
    return [...this.orders.values()].map((order) => ({ ...order, evidence: order.evidence.slice() }));
  }
}
