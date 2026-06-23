export interface ReportingPosition {
  id?: string;
  asset?: string;
  venue?: string;
  direction?: string;
  entryPrice: number;
  currentPrice?: number;
  entryUnderlyingPrice?: number;
  currentUnderlyingPrice?: number;
  size: number;
  leverage?: number;
  instrumentType?: string;
  instrumentId?: string;
  instrumentLabel?: string;
  packageLegs?: Array<{
    role?: string;
    strike?: number;
  }>;
}

export function positionUnrealizedPnl(position: ReportingPosition): number | null {
  if (!Number.isFinite(position.entryPrice) || position.entryPrice === 0 || !Number.isFinite(position.currentPrice)) return null;
  const currentPrice = position.currentPrice as number;

  // Polymarket YES/NO rows represent owned shares. A short thesis can map to
  // buying NO, so token P&L still rises when the NO token price rises.
  const isOwnedPolymarketToken =
    position.instrumentType === "pm_yes" ||
    position.instrumentType === "pm_no" ||
    position.instrumentType === "pm_package";

  const rawMove = position.direction === "short" && !isOwnedPolymarketToken
    ? (position.entryPrice - currentPrice) / position.entryPrice
    : (currentPrice - position.entryPrice) / position.entryPrice;
  const size = Number.isFinite(position.size) ? position.size : 1;
  const leverage = position.instrumentType === "hl_perp" && Number.isFinite(position.leverage)
    ? (position.leverage as number)
    : 1;
  return rawMove * size * leverage;
}

export function positionUnrealizedPnlPct(position: ReportingPosition): number | null {
  const pnl = positionUnrealizedPnl(position);
  if (pnl === null) return null;
  const size = Number.isFinite(position.size) && position.size !== 0 ? position.size : 1;
  return (pnl / size) * 100;
}

export function marketDetail(position?: ReportingPosition): string {
  if (!position) return "";
  const parts = [
    position.instrumentLabel ? `market=${position.instrumentLabel}` : "",
    position.instrumentType ? `instrument_type=${position.instrumentType}` : "",
    position.instrumentId ? `instrument_id=${position.instrumentId}` : "",
    Number.isFinite(position.entryPrice) ? `entry=${position.entryPrice}` : "",
    Number.isFinite(position.currentPrice) ? `current=${position.currentPrice}` : "",
    Number.isFinite(position.entryUnderlyingPrice) ? `entry_underlying=${position.entryUnderlyingPrice}` : "",
    Number.isFinite(position.currentUnderlyingPrice) ? `current_underlying=${position.currentUnderlyingPrice}` : "",
  ];
  return parts.filter(Boolean).join("; ");
}

const MONTH_NAMES: Record<string, string> = {
  jan: "January",
  january: "January",
  feb: "February",
  february: "February",
  mar: "March",
  march: "March",
  apr: "April",
  april: "April",
  may: "May",
  jun: "June",
  june: "June",
  jul: "July",
  july: "July",
  aug: "August",
  august: "August",
  sep: "September",
  sept: "September",
  september: "September",
  oct: "October",
  october: "October",
  nov: "November",
  november: "November",
  dec: "December",
  december: "December",
};

export function formatStrike(value: string): string {
  const normalized = value.replace(/,/g, "");
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return value;
  return `$${numeric.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

export function extractStrikePrice(position?: ReportingPosition): string {
  if (!position) return "";
  if (position.instrumentType === "pm_package" && Array.isArray(position.packageLegs)) {
    const broad = position.packageLegs.find((leg) => leg.role === "broad_yes");
    const narrow = position.packageLegs.find((leg) => leg.role === "narrow_no");
    if (typeof broad?.strike === "number" && typeof narrow?.strike === "number") {
      return `${formatStrike(String(broad.strike))} / ${formatStrike(String(narrow.strike))}`;
    }
  }

  const label = position.instrumentLabel ?? "";
  const packageMatch = label.match(/monotonic arb package\s+—\s+YES\s+([\d,.]+)\s*\/\s*NO\s+([\d,.]+)/i);
  if (packageMatch) return `${formatStrike(packageMatch[1])} / ${formatStrike(packageMatch[2])}`;

  const dollarMatches = [...label.matchAll(/\$([\d,]+(?:\.\d+)?)/g)];
  if (dollarMatches.length > 0) return formatStrike(dollarMatches[dollarMatches.length - 1][1]);

  return "";
}

export function extractExpiryMonth(position?: ReportingPosition): string {
  if (!position) return "";
  const source = `${position.instrumentLabel ?? ""} ${position.instrumentId ?? ""}`;
  const slugMonthMatch = source.match(/(?:^|[-\s])(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:[-\s]|$)/i);
  if (slugMonthMatch) return MONTH_NAMES[slugMonthMatch[1].toLowerCase()] ?? "";

  const phraseMonthMatch = source.match(/\b(?:in|by end of|end of|by)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (phraseMonthMatch) return MONTH_NAMES[phraseMonthMatch[1].toLowerCase()] ?? "";

  return "";
}
