#!/usr/bin/env tsx
/**
 * Synoptic leading-indicator test for Kalshi hourly temp cities (CHI / LA / NYC).
 *
 * Question: does Synoptic (or NWS latest as public proxy) print a temperature
 * move *before* the corresponding METAR/SPECI hits aviationweather receiptTime?
 *
 * Modes:
 *   1) One-shot historical score (default): pull recent METAR + optional Synoptic
 *      timeseries; measure lead of Synoptic/NWS vs each METAR/SPECI receipt.
 *   2) Live sample window: WEATHER_LEAD_LIVE_MIN=N poll for N minutes and score.
 *
 * Env:
 *   WEATHER_MM_CITIES          CHI,LAX (default)
 *   SYNOPTIC_TOKEN             required for true Synoptic; without it we still
 *                              score NWS vs METAR and report SPECI lead vs :51
 *   WEATHER_LEAD_RECENT_MIN    Synoptic recent window (default 180)
 *   WEATHER_LEAD_LIVE_MIN      if >0, live-poll that many minutes
 *   WEATHER_LEAD_POLL_MS       live poll interval (default 15000)
 *   SPORTS_ARB_DATA_DIR        JSONL output dir
 *
 * Run: npm run weather:synoptic-lead
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseCityList,
  type WeatherCity,
} from "./lib/weather-cities.js";
import {
  fetchMetars,
  fetchNwsLatest,
  fetchSynopticLatest,
  fetchSynopticRecent,
  lastMetar51,
  synopticToken,
  type WeatherObs,
} from "./lib/weather-obs.js";

const CITIES = parseCityList(process.env.WEATHER_MM_CITIES);
const RECENT_MIN = Math.max(30, Number(process.env.WEATHER_LEAD_RECENT_MIN ?? 180));
const LIVE_MIN = Math.max(0, Number(process.env.WEATHER_LEAD_LIVE_MIN ?? 0));
const POLL_MS = Math.max(5_000, Number(process.env.WEATHER_LEAD_POLL_MS ?? 15_000));
const MATCH_F = Math.max(0.1, Number(process.env.WEATHER_LEAD_MATCH_F ?? 0.6));

const DATA_DIR = resolve(
  process.env.SPORTS_ARB_DATA_DIR
    ?? process.env.SPORTS_ARB_STATE_DIR
    ?? join(process.cwd(), "data"),
);

type LeadHit = {
  city: string;
  icao: string;
  metarTempF: number;
  metarObsMs: number | null;
  metarRecvMs: number;
  metarSource: string;
  is51: boolean;
  leadSource: "synoptic" | "nws";
  leadTempF: number;
  leadObsMs: number | null;
  leadRecvMs: number;
  /** Positive ⇒ lead obs time before METAR receipt */
  leadSecVsReceipt: number | null;
  /** Positive ⇒ lead obs time before METAR obs time */
  leadSecVsObs: number | null;
};

function log(msg: string): void {
  console.log(`[synoptic-lead ${new Date().toISOString()}] ${msg}`);
}

function outPath(name: string): string {
  const dir = join(DATA_DIR, "weather");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function appendJsonl(path: string, row: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ ...row, recv: new Date().toISOString() })}\n`);
}

/** Find the latest lead obs at or before metar receipt whose temp matches. */
function matchLead(
  leads: WeatherObs[],
  metar: WeatherObs,
  source: "synoptic" | "nws",
): LeadHit | null {
  const receipt = metar.recvMs;
  const candidates = leads
    .filter((o) => o.source === source || (source === "synoptic" && o.source === "synoptic"))
    .filter((o) => Math.abs(o.tempF - metar.tempF) <= MATCH_F)
    .filter((o) => (o.obsTimeMs ?? o.recvMs) <= receipt + 5_000);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.obsTimeMs ?? b.recvMs) - (a.obsTimeMs ?? a.recvMs));
  const lead = candidates[0]!;
  const leadT = lead.obsTimeMs ?? lead.recvMs;
  return {
    city: "",
    icao: metar.icao,
    metarTempF: metar.tempF,
    metarObsMs: metar.obsTimeMs,
    metarRecvMs: metar.recvMs,
    metarSource: metar.source,
    is51: Boolean(metar.isMetar51),
    leadSource: source,
    leadTempF: lead.tempF,
    leadObsMs: lead.obsTimeMs,
    leadRecvMs: lead.recvMs,
    leadSecVsReceipt: (receipt - leadT) / 1000,
    leadSecVsObs:
      metar.obsTimeMs != null && lead.obsTimeMs != null
        ? (metar.obsTimeMs - lead.obsTimeMs) / 1000
        : null,
  };
}

function summarize(hits: LeadHit[], label: string): void {
  if (hits.length === 0) {
    log(`${label}: no matched hits`);
    return;
  }
  const leads = hits
    .map((h) => h.leadSecVsReceipt)
    .filter((x): x is number => x != null && Number.isFinite(x));
  const positive = leads.filter((x) => x > 15); // >15s before receipt
  const median = [...leads].sort((a, b) => a - b)[Math.floor(leads.length / 2)] ?? null;
  const mean = leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null;
  log(
    `${label}: n=${hits.length} matched  lead>15s=${positive.length}` +
      ` (${hits.length ? ((100 * positive.length) / hits.length).toFixed(0) : 0}%)` +
      `  medianLeadSec=${median != null ? median.toFixed(0) : "n/a"}` +
      `  meanLeadSec=${mean != null ? mean.toFixed(0) : "n/a"}`,
  );
  const verdict =
    positive.length >= Math.max(2, Math.ceil(hits.length * 0.55)) && (median ?? 0) > 30
      ? "LEADING"
      : positive.length > 0 && (median ?? 0) > 0
        ? "WEAK_LEAD"
        : "NOT_LEADING";
  log(`${label}: verdict=${verdict}`);
}

async function scoreCity(city: WeatherCity): Promise<{
  hitsSyn: LeadHit[];
  hitsNws: LeadHit[];
  speciVs51: Array<{ speciF: number; metar51F: number; minutesBefore51: number }>;
  synopticOk: boolean;
  note: string;
}> {
  const metars = await fetchMetars(city.icao, Math.ceil(RECENT_MIN / 60) + 2);
  const token = synopticToken();
  let synSeries: WeatherObs[] = [];
  let synopticOk = false;
  let note = "";
  if (token) {
    try {
      synSeries = await fetchSynopticRecent(city.icao, token, RECENT_MIN);
      const latest = await fetchSynopticLatest(city.icao, token);
      if (latest) synSeries.push(latest);
      synopticOk = synSeries.length > 0;
      note = `synoptic points=${synSeries.length}`;
    } catch (err) {
      note = `synoptic error: ${(err as Error).message.slice(0, 120)}`;
    }
  } else {
    note = "SYNOPTIC_TOKEN unset — scoring NWS proxy + SPECI-vs-:51 only";
  }

  let nwsSeries: WeatherObs[] = [];
  try {
    const n = await fetchNwsLatest(city.icao);
    if (n) nwsSeries = [n];
  } catch {
    /* ignore */
  }

  const hitsSyn: LeadHit[] = [];
  const hitsNws: LeadHit[] = [];
  for (const m of metars) {
    if (synopticOk) {
      const h = matchLead(synSeries, m, "synoptic");
      if (h) {
        h.city = city.id;
        hitsSyn.push(h);
      }
    }
    const hn = matchLead(nwsSeries, m, "nws");
    if (hn) {
      hn.city = city.id;
      hitsNws.push(hn);
    }
  }

  // SPECI that precede the next :51 — mid-hour information content
  const speciVs51: Array<{ speciF: number; metar51F: number; minutesBefore51: number }> = [];
  const prints51 = metars.filter((m) => m.isMetar51 && m.obsTimeMs != null);
  for (const p51 of prints51) {
    const spes = metars.filter(
      (m) =>
        m.source === "speci" &&
        m.obsTimeMs != null &&
        m.obsTimeMs < (p51.obsTimeMs as number) &&
        m.obsTimeMs >= (p51.obsTimeMs as number) - 60 * 60_000,
    );
    for (const s of spes) {
      speciVs51.push({
        speciF: s.tempF,
        metar51F: p51.tempF,
        minutesBefore51: ((p51.obsTimeMs as number) - (s.obsTimeMs as number)) / 60_000,
      });
    }
  }

  const last51 = lastMetar51(metars);
  log(
    `${city.id} ${city.icao}: metars=${metars.length} :51=${prints51.length}` +
      ` last51=${last51 ? `${last51.tempF}°F` : "n/a"}  ${note}`,
  );
  summarize(
    hitsSyn,
    `${city.id} Synoptic→METAR`,
  );
  summarize(hitsNws, `${city.id} NWS→METAR`);
  if (speciVs51.length) {
    const moved = speciVs51.filter((x) => Math.abs(x.speciF - x.metar51F) >= 1);
    log(
      `${city.id} SPECI before :51: n=${speciVs51.length} with |Δ|≥1°F vs final :51: ${moved.length}` +
        (moved[0]
          ? `  e.g. SPECI ${moved[0].speciF}→:51 ${moved[0].metar51F} (${moved[0].minutesBefore51.toFixed(0)}m early)`
          : ""),
    );
  }

  return { hitsSyn, hitsNws, speciVs51, synopticOk, note };
}

async function livePoll(city: WeatherCity, minutes: number, jsonl: string): Promise<void> {
  const end = Date.now() + minutes * 60_000;
  const token = synopticToken();
  log(`${city.id}: live poll ${minutes}m every ${POLL_MS}ms (synoptic=${token ? "on" : "off"})`);
  while (Date.now() < end) {
    const row: Record<string, unknown> = { type: "live_sample", city: city.id, icao: city.icao };
    try {
      const metars = await fetchMetars(city.icao, 2);
      const latest = metars[metars.length - 1];
      row.metar = latest
        ? {
            tempF: latest.tempF,
            source: latest.source,
            is51: latest.isMetar51,
            obs: latest.obsTimeMs,
            recv: latest.recvMs,
            raw: latest.raw?.slice(0, 120),
          }
        : null;
    } catch (err) {
      row.metarErr = (err as Error).message.slice(0, 120);
    }
    if (token) {
      try {
        const s = await fetchSynopticLatest(city.icao, token);
        row.synoptic = s
          ? { tempF: s.tempF, obs: s.obsTimeMs, recv: s.recvMs }
          : null;
      } catch (err) {
        row.synopticErr = (err as Error).message.slice(0, 120);
      }
    }
    try {
      const n = await fetchNwsLatest(city.icao);
      row.nws = n ? { tempF: n.tempF, obs: n.obsTimeMs, recv: n.recvMs } : null;
    } catch (err) {
      row.nwsErr = (err as Error).message.slice(0, 120);
    }
    appendJsonl(jsonl, row);
    const syn = row.synoptic as { tempF?: number; obs?: number } | null | undefined;
    const met = row.metar as { tempF?: number; recv?: number } | null | undefined;
    if (syn?.tempF != null && met?.tempF != null && syn.obs != null && met.recv != null) {
      const lead = (met.recv - syn.obs) / 1000;
      log(
        `${city.id} live  syn=${syn.tempF}°F  metar=${met.tempF}°F  leadSec≈${lead.toFixed(0)}`,
      );
    } else {
      log(`${city.id} live sample written`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function main(): Promise<void> {
  if (CITIES.length === 0) throw new Error("No cities in WEATHER_MM_CITIES");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = outPath(`synoptic-lead-${stamp}.json`);
  const jsonl = outPath(`synoptic-lead-${stamp}.jsonl`);

  log(`cities=${CITIES.map((c) => c.id).join(",")}  token=${synopticToken() ? "yes" : "NO"}`);
  const report: Record<string, unknown> = {
    started: new Date().toISOString(),
    cities: CITIES.map((c) => c.id),
    synopticToken: Boolean(synopticToken()),
    matchF: MATCH_F,
    results: {} as Record<string, unknown>,
  };

  for (const city of CITIES) {
    const scored = await scoreCity(city);
    (report.results as Record<string, unknown>)[city.id] = {
      note: scored.note,
      synopticOk: scored.synopticOk,
      synopticHits: scored.hitsSyn,
      nwsHits: scored.hitsNws,
      speciVs51: scored.speciVs51.slice(0, 40),
    };
    for (const h of [...scored.hitsSyn, ...scored.hitsNws]) {
      appendJsonl(jsonl, { type: "lead_hit", ...h });
    }
  }

  if (LIVE_MIN > 0) {
    for (const city of CITIES) {
      await livePoll(city, LIVE_MIN, jsonl);
    }
  }

  // Overall guidance for the MM loop
  const results = report.results as Record<
    string,
    { synopticOk?: boolean; synopticHits?: LeadHit[]; nwsHits?: LeadHit[] }
  >;
  const anySyn = Object.values(results).some(
    (r) => r.synopticOk && (r.synopticHits?.length ?? 0) > 0,
  );
  const synHits = Object.values(results).flatMap((r) => r.synopticHits ?? []);
  const nwsHits = Object.values(results).flatMap((r) => r.nwsHits ?? []);
  const pos = synHits.filter((h) => (h.leadSecVsReceipt ?? 0) > 15);
  const nwsPos = nwsHits.filter((h) => (h.leadSecVsReceipt ?? 0) > 15);
  const nwsLead =
    nwsPos.length >= Math.max(1, Math.ceil(Math.max(1, nwsHits.length) * 0.55));
  let guidance: string;
  if (!synopticToken()) {
    guidance = nwsLead
      ? "SYNOPTIC_TOKEN unset — cannot score Synoptic. NWS latest led METAR receipt in this window: paper MM may correct μ off NWS/SPECI after the :51 anchor; still widen/pull in the last 10 minutes. Set SYNOPTIC_TOKEN to test whether Synoptic leads further."
      : "Set SYNOPTIC_TOKEN to measure true Synoptic lead. Until then MM should anchor on last :51 METAR and correct off SPECI (and NWS if it starts leading); do not treat Synoptic as leading.";
  } else if (pos.length >= Math.max(2, Math.ceil(synHits.length * 0.55))) {
    guidance =
      "Synoptic appears to lead METAR receipt often enough to follow mid-hour: correct μ off Synoptic deltas after the :51 anchor; still pull/widen in the last 10 minutes.";
  } else if (anySyn) {
    guidance =
      "Synoptic matched temps but lead is weak/inconsistent — keep :51 METAR as primary fair value; treat Synoptic as confirming only.";
  } else {
    guidance =
      "No Synoptic↔METAR matches in window — keep Synoptic disabled for fair-value corrections.";
  }
  report.guidance = guidance;
  report.finished = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`guidance: ${guidance}`);
  log(`wrote ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
