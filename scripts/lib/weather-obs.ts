/**
 * Weather observation feeds for hourly MM:
 *   - METAR / SPECI (aviationweather.gov) — :51 settle prints + mid-hour SPECI
 *   - Synoptic Data API (token) — candidate leading indicator (1-min / latest)
 *   - NWS API — public station obs fallback
 *   - TWC Currents — named Kalshi settlement publisher (can lag mid-hour)
 */

import { cToF, roundTempF, type WeatherCity } from "./weather-cities.js";

export type ObsSource = "metar" | "speci" | "synoptic" | "nws" | "twc";

export type WeatherObs = {
  source: ObsSource;
  icao: string;
  tempF: number;
  tempC?: number | null;
  /** Observation time (station/report time) */
  obsTimeMs: number | null;
  /** When we received it */
  recvMs: number;
  raw?: string;
  isMetar51?: boolean;
  meta?: Record<string, unknown>;
};

const UA = "sports-arb-weather-mm/1.0";

export function parseMetarUtcMs(raw: string, obsTime?: unknown): number | null {
  const m = raw.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
  if (m) {
    const day = Number(m[1]);
    const utcH = Number(m[2]);
    const utcM = Number(m[3]);
    const now = new Date();
    let y = now.getUTCFullYear();
    let mo = now.getUTCMonth();
    const utcDay = now.getUTCDate();
    if (day > utcDay + 15) mo -= 1;
    if (day < utcDay - 15) mo += 1;
    return Date.UTC(y, mo, day, utcH, utcM, 0);
  }
  if (typeof obsTime === "number" && Number.isFinite(obsTime)) {
    return obsTime * 1000;
  }
  return null;
}

/** ET hour/minute from a METAR raw / obsTime. */
export function metarEtHourMinute(
  raw: string,
  obsTime?: unknown,
): { hour: number; minute: number } | null {
  const ms = parseMetarUtcMs(raw, obsTime);
  if (ms == null) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { hour, minute: Number(parts.minute) };
}

export async function fetchMetars(
  icao: string,
  hours = 6,
): Promise<WeatherObs[]> {
  const url = `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json&hours=${hours}`;
  const resp = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!resp.ok) throw new Error(`METAR HTTP ${resp.status}`);
  const data = (await resp.json()) as Array<Record<string, unknown>>;
  const out: WeatherObs[] = [];
  const recvMs = Date.now();
  for (const o of data) {
    const raw = String(o.rawOb ?? "");
    const tmpc = typeof o.temp === "number" ? o.temp : null;
    if (tmpc == null || !raw) continue;
    const isSpeci = /\bSPECI\b/.test(raw);
    const et = metarEtHourMinute(raw, o.obsTime);
    const receipt = o.receiptTime ? Date.parse(String(o.receiptTime)) : null;
    out.push({
      source: isSpeci ? "speci" : "metar",
      icao,
      tempC: tmpc,
      tempF: roundTempF(cToF(tmpc)),
      obsTimeMs: parseMetarUtcMs(raw, o.obsTime),
      recvMs: Number.isFinite(receipt as number) ? (receipt as number) : recvMs,
      raw,
      isMetar51: et?.minute === 51,
      meta: {
        reportTime: o.reportTime ?? null,
        receiptTime: o.receiptTime ?? null,
        etHour: et?.hour ?? null,
        etMinute: et?.minute ?? null,
        metarType: o.metarType ?? null,
      },
    });
  }
  // Oldest → newest
  out.sort((a, b) => (a.obsTimeMs ?? 0) - (b.obsTimeMs ?? 0));
  return out;
}

export async function fetchSynopticLatest(
  icao: string,
  token: string,
): Promise<WeatherObs | null> {
  const url =
    `https://api.synopticdata.com/v2/stations/latest?stid=${encodeURIComponent(icao)}` +
    `&vars=air_temp&units=temp|F&token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!resp.ok) throw new Error(`Synoptic HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    SUMMARY?: { RESPONSE_CODE?: number; RESPONSE_MESSAGE?: string };
    STATION?: Array<{
      STID?: string;
      OBSERVATIONS?: { air_temp_value_1?: { value?: number; date_time?: string } };
    }>;
  };
  if (data.SUMMARY?.RESPONSE_CODE && data.SUMMARY.RESPONSE_CODE !== 1) {
    throw new Error(`Synoptic: ${data.SUMMARY.RESPONSE_MESSAGE ?? data.SUMMARY.RESPONSE_CODE}`);
  }
  const st = data.STATION?.[0];
  const ob = st?.OBSERVATIONS?.air_temp_value_1;
  if (!ob || typeof ob.value !== "number") return null;
  const obsTimeMs = ob.date_time ? Date.parse(ob.date_time) : null;
  return {
    source: "synoptic",
    icao,
    tempF: roundTempF(ob.value),
    obsTimeMs: Number.isFinite(obsTimeMs as number) ? obsTimeMs : null,
    recvMs: Date.now(),
    meta: { date_time: ob.date_time ?? null },
  };
}

/** Recent Synoptic timeseries (minutes). */
export async function fetchSynopticRecent(
  icao: string,
  token: string,
  recentMinutes = 180,
): Promise<WeatherObs[]> {
  const url =
    `https://api.synopticdata.com/v2/stations/timeseries?stid=${encodeURIComponent(icao)}` +
    `&vars=air_temp&units=temp|F&recent=${recentMinutes}&token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!resp.ok) throw new Error(`Synoptic ts HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    SUMMARY?: { RESPONSE_CODE?: number; RESPONSE_MESSAGE?: string };
    STATION?: Array<{
      OBSERVATIONS?: { date_time?: string[]; air_temp_set_1?: number[] };
    }>;
  };
  if (data.SUMMARY?.RESPONSE_CODE && data.SUMMARY.RESPONSE_CODE !== 1) {
    throw new Error(`Synoptic ts: ${data.SUMMARY.RESPONSE_MESSAGE ?? data.SUMMARY.RESPONSE_CODE}`);
  }
  const obs = data.STATION?.[0]?.OBSERVATIONS;
  const times = obs?.date_time ?? [];
  const temps = obs?.air_temp_set_1 ?? [];
  const out: WeatherObs[] = [];
  const recvMs = Date.now();
  for (let i = 0; i < Math.min(times.length, temps.length); i++) {
    const t = temps[i];
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    const ms = Date.parse(times[i]!);
    out.push({
      source: "synoptic",
      icao,
      tempF: roundTempF(t),
      obsTimeMs: Number.isFinite(ms) ? ms : null,
      recvMs,
      meta: { date_time: times[i] },
    });
  }
  return out;
}

export async function fetchNwsLatest(icao: string): Promise<WeatherObs | null> {
  const url = `https://api.weather.gov/stations/${encodeURIComponent(icao)}/observations/latest`;
  const resp = await fetch(url, {
    headers: { accept: "application/geo+json", "user-agent": UA },
  });
  if (!resp.ok) throw new Error(`NWS HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    properties?: {
      timestamp?: string;
      temperature?: { value?: number | null };
      rawMessage?: string;
    };
  };
  const p = data.properties;
  const c = p?.temperature?.value;
  if (typeof c !== "number") return null;
  const obsTimeMs = p?.timestamp ? Date.parse(p.timestamp) : null;
  return {
    source: "nws",
    icao,
    tempC: c,
    tempF: roundTempF(cToF(c)),
    obsTimeMs: Number.isFinite(obsTimeMs as number) ? obsTimeMs : null,
    recvMs: Date.now(),
    raw: p?.rawMessage,
    meta: { timestamp: p?.timestamp ?? null },
  };
}

export async function fetchTwc(icao: string, apiKey: string): Promise<WeatherObs | null> {
  const url =
    `https://api.weather.com/v3/wx/observations/current?icaoCode=${encodeURIComponent(icao)}` +
    `&units=e&language=en-US&format=json&apiKey=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!resp.ok) throw new Error(`TWC HTTP ${resp.status}`);
  const d = (await resp.json()) as Record<string, unknown>;
  const temp = d.temperature;
  if (typeof temp !== "number") return null;
  return {
    source: "twc",
    icao,
    tempF: roundTempF(temp),
    obsTimeMs: d.validTimeLocal ? Date.parse(String(d.validTimeLocal)) : null,
    recvMs: Date.now(),
    meta: {
      validTimeLocal: d.validTimeLocal ?? null,
      wx: d.wxPhraseLong ?? d.wxPhraseMedium ?? null,
    },
  };
}

/** Latest :51 METAR at or before `beforeMs` (default now). */
export function lastMetar51(obs: WeatherObs[], beforeMs = Date.now()): WeatherObs | null {
  let best: WeatherObs | null = null;
  for (const o of obs) {
    if (!o.isMetar51) continue;
    if (o.obsTimeMs != null && o.obsTimeMs > beforeMs) continue;
    if (!best || (o.obsTimeMs ?? 0) > (best.obsTimeMs ?? 0)) best = o;
  }
  return best;
}

export function synopticToken(): string | null {
  const t = process.env.SYNOPTIC_TOKEN?.trim() || process.env.SYNOPTIC_API_TOKEN?.trim();
  return t || null;
}

export function twcKey(): string {
  return process.env.TWC_API_KEY?.trim() || "e1f10a1e78da46f5b10a1e78da96f525";
}

export async function pollCityObs(city: WeatherCity): Promise<{
  metars: WeatherObs[];
  synoptic: WeatherObs | null;
  nws: WeatherObs | null;
  twc: WeatherObs | null;
  synopticError?: string;
}> {
  const metars = await fetchMetars(city.icao, 8);
  let synoptic: WeatherObs | null = null;
  let synopticError: string | undefined;
  const token = synopticToken();
  if (token) {
    try {
      synoptic = await fetchSynopticLatest(city.icao, token);
    } catch (err) {
      synopticError = (err as Error).message.slice(0, 160);
    }
  } else {
    synopticError = "SYNOPTIC_TOKEN unset";
  }
  let nws: WeatherObs | null = null;
  try {
    nws = await fetchNwsLatest(city.icao);
  } catch {
    /* optional */
  }
  let twc: WeatherObs | null = null;
  try {
    twc = await fetchTwc(city.icao, twcKey());
  } catch {
    /* optional */
  }
  return { metars, synoptic, nws, twc, synopticError };
}
