// In-memory Kalshi orderbooks fed by WS snapshot + delta messages.

import type { KalshiOrderbook, KalshiOrderbookLevel } from "./kalshi-client.js";

function parseLevels(raw: unknown): KalshiOrderbookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: KalshiOrderbookLevel[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const price = Number(entry[0]);
    const size = Number(entry[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    out.push([price, size]);
  }
  return out;
}

function levelsToMap(levels: KalshiOrderbookLevel[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const [p, s] of levels) {
    if (s > 0) m.set(p, s);
  }
  return m;
}

function mapToLevels(m: Map<number, number>): KalshiOrderbookLevel[] {
  return [...m.entries()]
    .filter(([, s]) => s > 0)
    .map(([p, s]) => [p, s] as KalshiOrderbookLevel)
    .sort((a, b) => b[0] - a[0]);
}

export class KalshiBookStore {
  private readonly yes = new Map<string, Map<number, number>>();
  private readonly no = new Map<string, Map<number, number>>();
  private readonly updatedAt = new Map<string, number>();

  applySnapshot(marketTicker: string, msg: Record<string, unknown>): void {
    const yesRaw = msg.yes_dollars_fp ?? msg.yes_dollars ?? msg.yes;
    const noRaw = msg.no_dollars_fp ?? msg.no_dollars ?? msg.no;
    this.yes.set(marketTicker, levelsToMap(parseLevels(yesRaw)));
    this.no.set(marketTicker, levelsToMap(parseLevels(noRaw)));
    this.updatedAt.set(marketTicker, Date.now());
  }

  applyDelta(marketTicker: string, msg: Record<string, unknown>): void {
    const side = String(msg.side ?? "").toLowerCase();
    const price = Number(msg.price_dollars ?? msg.price);
    const delta = Number(msg.delta_fp ?? msg.delta);
    if (!Number.isFinite(price) || !Number.isFinite(delta)) return;
    const books = side === "no" ? this.no : this.yes;
    let levels = books.get(marketTicker);
    if (!levels) {
      levels = new Map();
      books.set(marketTicker, levels);
    }
    const next = (levels.get(price) ?? 0) + delta;
    if (next <= 1e-9) levels.delete(price);
    else levels.set(price, next);
    this.updatedAt.set(marketTicker, Date.now());
  }

  getBook(marketTicker: string): KalshiOrderbook | null {
    const y = this.yes.get(marketTicker);
    const n = this.no.get(marketTicker);
    if (!y && !n) return null;
    return {
      yesBids: mapToLevels(y ?? new Map()),
      noBids: mapToLevels(n ?? new Map()),
    };
  }

  lastUpdateMs(marketTicker: string): number | null {
    return this.updatedAt.get(marketTicker) ?? null;
  }

  tickers(): string[] {
    return [...new Set([...this.yes.keys(), ...this.no.keys()])];
  }
}
