/**
 * Softball entry gates for crypto/weather monotonic packages.
 *
 * Tuned from the Jul 22–23 shadow tape: softballs were persistent
 * ~2–6¢ net locks with usable size; ghosts were sub-$0.20 baskets and
 * fee-scraped crumbs under 2¢ net.
 *
 * Dust: live YES baskets often still have 0.1¢ far-OTM bins. Those are not
 * settlement ghosts (packageCost can sit in [0.85,0.99]) but they are untradeable
 * junk for CLOB min-notional and not what we want to lift. Require every leg
 * ask ≥ SOFTBALL_MIN_LEG_ASK (default 1¢).
 *
 * Env overrides:
 *   SOFTBALL_MIN_NET_EDGE  (default 0.02)
 *   SOFTBALL_MIN_SIZE      (default 10)
 *   SOFTBALL_MIN_COST      (default 0.85)
 *   SOFTBALL_MAX_COST      (default 0.99)
 *   SOFTBALL_MIN_LEG_ASK   (default 0.01)
 */

export const SOFTBALL_MIN_NET_EDGE = Number(process.env.SOFTBALL_MIN_NET_EDGE ?? 0.02);
export const SOFTBALL_MIN_SIZE = Number(process.env.SOFTBALL_MIN_SIZE ?? 10);
export const SOFTBALL_MIN_COST = Number(process.env.SOFTBALL_MIN_COST ?? 0.85);
export const SOFTBALL_MAX_COST = Number(process.env.SOFTBALL_MAX_COST ?? 0.99);
export const SOFTBALL_MIN_LEG_ASK = Number(process.env.SOFTBALL_MIN_LEG_ASK ?? 0.01);

export type SoftballQuote = {
  packageCost: number;
  netLockedEdge: number;
  availableSize: number;
  /** Cheapest leg ask in the package; omit only for non-legged rows. */
  minLegAsk?: number;
};

export function isSoftball(q: SoftballQuote): boolean {
  const legOk = q.minLegAsk === undefined || q.minLegAsk >= SOFTBALL_MIN_LEG_ASK;
  return (
    Number.isFinite(q.packageCost)
    && Number.isFinite(q.netLockedEdge)
    && Number.isFinite(q.availableSize)
    && legOk
    && q.netLockedEdge >= SOFTBALL_MIN_NET_EDGE
    && q.availableSize >= SOFTBALL_MIN_SIZE
    && q.packageCost >= SOFTBALL_MIN_COST
    && q.packageCost <= SOFTBALL_MAX_COST
  );
}

export function softballGateLabel(): string {
  return (
    `net≥${(SOFTBALL_MIN_NET_EDGE * 100).toFixed(0)}c `
    + `size≥${SOFTBALL_MIN_SIZE} `
    + `cost∈[${SOFTBALL_MIN_COST},${SOFTBALL_MAX_COST}] `
    + `minLegAsk≥${(SOFTBALL_MIN_LEG_ASK * 100).toFixed(0)}c`
  );
}
