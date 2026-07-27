/**
 * Kalshi hourly temperature cities used by the weather MM stack.
 *
 * Event hours on KXTEMP* series are labeled in America/New_York (EDT/EST),
 * even for Chicago / LA. Settlement source is The Weather Company at the
 * station coordinates; practical tape follows the local ASOS :51 print.
 */

export type WeatherCityId = "CHI" | "LAX" | "NYC";

export type WeatherCity = {
  id: WeatherCityId;
  name: string;
  /** Kalshi hourly series ticker */
  series: string;
  /** ICAO / ASOS id for METAR + Synoptic */
  icao: string;
  /** IEM/ASOS short id when different from ICAO without K */
  asos: string;
  /** Local TZ for display; Kalshi event stamps stay on America/New_York */
  localTz: string;
  /** Event-ticker prefix, e.g. KXTEMPCHIH */
  eventPrefix: string;
};

export const WEATHER_CITIES: Record<WeatherCityId, WeatherCity> = {
  CHI: {
    id: "CHI",
    name: "Chicago",
    series: "KXTEMPCHIH",
    icao: "KORD",
    asos: "ORD",
    localTz: "America/Chicago",
    eventPrefix: "KXTEMPCHIH",
  },
  LAX: {
    id: "LAX",
    name: "Los Angeles",
    series: "KXTEMPLAXH",
    icao: "KLAX",
    asos: "LAX",
    localTz: "America/Los_Angeles",
    eventPrefix: "KXTEMPLAXH",
  },
  NYC: {
    id: "NYC",
    name: "New York",
    series: "KXTEMPNYCH",
    icao: "KNYC",
    asos: "NYC",
    localTz: "America/New_York",
    eventPrefix: "KXTEMPNYCH",
  },
};

export function parseCityList(raw: string | undefined, fallback: WeatherCityId[] = ["CHI", "LAX"]): WeatherCity[] {
  const ids = (raw ?? fallback.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) as WeatherCityId[];
  const out: WeatherCity[] = [];
  for (const id of ids) {
    const city = WEATHER_CITIES[id];
    if (city) out.push(city);
  }
  return out;
}

/** Kalshi event hour stamp parts in America/New_York. */
export function etParts(d = new Date()): {
  y: number;
  m: number;
  day: number;
  hour: number;
  minute: number;
  stamp: string;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const m = Number(parts.month);
  const day = Number(parts.day);
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const minute = Number(parts.minute);
  const yy = String(y).slice(2);
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][m - 1];
  return { y, m, day, hour, minute, stamp: `${yy}${mon}${String(day).padStart(2, "0")}` };
}

/** Event hour (0–23) from e.g. KXTEMPCHIH-26JUL2719 */
export function eventHourOf(eventTicker: string): number | null {
  const m = eventTicker.match(/-\d{2}[A-Z]{3}\d{2}(\d{2})$/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * Decisive ASOS :51 for an hourly event labeled hour H (ET):
 * the print at (H − 1):51 ET settles that hour.
 */
export function decisiveMetarEt(eventTicker: string): { hour: number; minute: number; label: string } {
  const eh = eventHourOf(eventTicker) ?? 0;
  const hour = (eh + 23) % 24;
  return { hour, minute: 51, label: `${String(hour).padStart(2, "0")}:51 ET` };
}

/** Minutes remaining until market close (ISO), or null. */
export function minutesToClose(closeTimeIso: string | undefined | null, now = Date.now()): number | null {
  if (!closeTimeIso) return null;
  const t = Date.parse(closeTimeIso);
  if (!Number.isFinite(t)) return null;
  return (t - now) / 60_000;
}

export function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

export function roundTempF(f: number, digits = 1): number {
  const m = 10 ** digits;
  return Math.round(f * m) / m;
}
