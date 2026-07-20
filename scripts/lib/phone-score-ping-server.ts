/**
 * Mobile score-ping server for stadium latency tests.
 *
 * Serves a one-tap UI and POST /ping that injects phone_ping into the MLB paper
 * sidecar so it races pm_score / bwin_score / statsapi on the same wall clock.
 *
 * Path latency is measured on the **phone clock** as RTT (tDone - tClient).
 * Never treat phone Date.now() vs Mac Date.now() as path lag — that is clock skew.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";

export type PhoneScorePingPaper = {
  onPhonePing: (
    away: number,
    home: number,
    t?: number,
    meta?: Record<string, unknown>,
  ) => void;
  resetScoreToFeed?: () => Promise<{ away: number; home: number; period: string | null }>;
  getScoreState: () => {
    away: number;
    home: number;
    seen: boolean;
    phoneLock?: null | { away: number; home: number; remainingMs: number };
    track: null | {
      t0: number;
      scoreAway: number;
      scoreHome: number;
      firstSource: string;
      bySource: Record<string, number>;
      bookSignals: Record<string, number | null>;
      ageMs: number;
    };
  };
};

export type PhoneScorePingOpts = {
  port: number;
  bind?: string;
  token?: string;
  awayLabel?: string;
  homeLabel?: string;
  slug?: string;
  /** Optional VPS-local probe port (same host, no tunnel) for LTE→VPS RTT. */
  vpsProbePort?: number;
  log?: (msg: string) => void;
  onEmit?: (row: Record<string, unknown>) => void;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(raw);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function pageHtml(opts: {
  token: string;
  awayLabel: string;
  homeLabel: string;
  slug: string;
  vpsProbePort: number;
}): string {
  const { token, awayLabel, homeLabel, slug, vpsProbePort } = opts;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <title>Score Ping · ${awayLabel}@${homeLabel}</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0f14; --card:#151b24; --fg:#f2f5f8; --muted:#8b98a8;
      --away:#5b9fd4; --home:#e85d4c; --ok:#3dce7c; --warn:#f0c14b; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg); color: var(--fg); min-height: 100dvh; padding: 16px; padding-bottom: 32px;
      touch-action: manipulation; user-select: none; -webkit-user-select: none; }
    h1 { font-size: 1.1rem; font-weight: 650; margin: 0 0 4px; letter-spacing: .02em; }
    .sub { color: var(--muted); font-size: .85rem; margin-bottom: 16px; }
    .score { font-variant-numeric: tabular-nums; font-size: 3.2rem; font-weight: 700;
      text-align: center; padding: 18px; background: var(--card); border-radius: 16px; margin-bottom: 12px; }
    .score span { color: var(--muted); font-weight: 500; font-size: 2rem; margin: 0 .2em; }
    .labels { display:flex; justify-content: space-between; color: var(--muted); font-size: .8rem;
      margin: -4px 4px 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    button { appearance: none; border: 0; border-radius: 18px; padding: 28px 12px; font-size: 1.25rem;
      font-weight: 700; color: #fff; cursor: pointer; width: 100%;
      touch-action: manipulation; user-select: none; -webkit-user-select: none; }
    button:active { transform: scale(.98); filter: brightness(1.08); }
    .conn { position: fixed; top: 8px; right: 12px; font-size: .7rem; font-weight: 700;
      padding: 3px 8px; border-radius: 999px; background: #243041; color: var(--muted); }
    .conn.ws { background: #12331f; color: var(--ok); }
    .away { background: linear-gradient(180deg, #6aafdf, var(--away)); }
    .home { background: linear-gradient(180deg, #f07868, var(--home)); }
    .ping { background: linear-gradient(180deg, #4ad88a, var(--ok)); margin-bottom: 12px; padding: 22px; font-size: 1.1rem; }
    .sync { background: #243041; color: var(--fg); font-weight: 600; font-size: 1rem; padding: 16px; margin-bottom: 14px; }
    .race { background: var(--card); border-radius: 14px; padding: 14px; min-height: 110px; font-size: .9rem; }
    .race h2 { margin: 0 0 8px; font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
    .win { color: var(--ok); font-weight: 700; }
    .late { color: var(--warn); font-weight: 700; }
    .row { display:flex; justify-content: space-between; gap: 8px; margin: 3px 0; }
    .err { color: #ff7b7b; margin-top: 8px; font-size: .85rem; }
    .okflash { outline: 3px solid var(--ok); }
    .lat { background: var(--card); border-radius: 14px; padding: 12px 14px; margin-bottom: 12px; font-size: .88rem; }
    .lat .big { font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <div class="conn" id="conn">HTTP</div>
  <h1>${awayLabel} @ ${homeLabel}</h1>
  <div class="sub">${slug} · tap when you see the run</div>
  <div class="score" id="score">–<span>–</span>–</div>
  <div class="labels"><span>${awayLabel}</span><span>${homeLabel}</span></div>
  <div class="lat" id="lat">
    <div class="row"><span>path RTT (phone clock)</span><span class="big" id="rtt">–</span></div>
    <div class="row"><span>LTE→VPS RTT (est.)</span><span id="vpsRtt">–</span></div>
    <div class="row"><span>one-way path est. (RTT/2)</span><span id="oneWay">–</span></div>
    <div class="row" style="color:var(--muted);font-size:.75rem;margin-top:6px">
      <span>cross-clock skew is NOT lag — ignored</span><span></span>
    </div>
  </div>
  <div class="grid">
    <button class="away" id="bumpAway">+1 ${awayLabel}</button>
    <button class="home" id="bumpHome">+1 ${homeLabel}</button>
  </div>
  <button class="ping" id="pingSame">PING current score</button>
  <button class="sync" id="sync">Refresh from feed</button>
  <div class="race">
    <h2>Last race</h2>
    <div id="race">Waiting for a tap…</div>
    <div class="err" id="err"></div>
  </div>
<script>
const TOKEN = ${JSON.stringify(token)};
const VPS_PROBE_PORT = ${JSON.stringify(vpsProbePort)};
let away = 0, home = 0, seen = false;
let lastRttMs = null;
let lastVpsRttMs = null;

async function api(path, opts) {
  const url = path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---- WebSocket transport (persistent pipe; falls back to HTTP fetch) ----
let ws = null;
let wsOpen = false;
let wsSeq = 0;
const wsPending = new Map(); // seq -> { resolve, reject, tClient }

function setConnBadge() {
  const el = document.getElementById("conn");
  el.textContent = wsOpen ? "WS" : "HTTP";
  el.classList.toggle("ws", wsOpen);
}

function wsConnect() {
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws?token=" + encodeURIComponent(TOKEN));
    ws.onopen = () => { wsOpen = true; setConnBadge(); };
    ws.onclose = () => {
      wsOpen = false; setConnBadge();
      for (const p of wsPending.values()) p.reject(new Error("ws closed"));
      wsPending.clear();
      setTimeout(wsConnect, 1000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const p = wsPending.get(msg.seq);
      if (p) {
        wsPending.delete(msg.seq);
        const rttMs = Date.now() - p.tClient; // phone clock both ends — real path RTT
        p.resolve({ msg, rttMs });
      }
    };
  } catch (_) {
    setTimeout(wsConnect, 2000);
  }
}

function wsRequest(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!wsOpen || !ws || ws.readyState !== 1) { reject(new Error("ws not open")); return; }
    const seq = ++wsSeq;
    const tClient = Date.now();
    wsPending.set(seq, { resolve, reject, tClient });
    ws.send(JSON.stringify({ ...payload, seq, tClient }));
    setTimeout(() => {
      if (wsPending.has(seq)) { wsPending.delete(seq); reject(new Error("ws timeout")); }
    }, timeoutMs || 4000);
  });
}

// Heartbeat keeps the LTE radio in CONNECTED state and refreshes the RTT display.
setInterval(async () => {
  if (!wsOpen) return;
  try {
    const { rttMs } = await wsRequest({ kind: "hb" }, 3000);
    lastRttMs = rttMs;
    renderLat();
  } catch (_) {}
}, 5000);

function renderScore() {
  document.getElementById("score").innerHTML = away + "<span>–</span>" + home;
}

function renderLat() {
  document.getElementById("rtt").textContent = lastRttMs == null ? "–" : (lastRttMs + " ms");
  document.getElementById("vpsRtt").textContent = lastVpsRttMs == null ? "–" : (lastVpsRttMs + " ms");
  document.getElementById("oneWay").textContent =
    lastRttMs == null ? "–" : (Math.round(lastRttMs / 2) + " ms");
}

function renderRace(state) {
  const el = document.getElementById("race");
  const t = state.track;
  if (!t) { el.textContent = "No active score window."; return; }
  const rows = Object.entries(t.bySource || {}).sort((a,b) => a[1]-b[1])
    .map(([src, dt]) => "<div class=row><span>" + src + "</span><span>" + (dt===0 ? "FIRST" : ("+" + dt + " ms")) + "</span></div>")
    .join("");
  const phoneFirst = t.firstSource === "phone_ping";
  const headline = phoneFirst
    ? "<div class=win>PHONE FIRST — feeds trailing</div>"
    : "<div class=late>Feed first (" + t.firstSource + ") — phone " +
      ((t.bySource.phone_ping != null) ? ("+" + t.bySource.phone_ping + " ms") : "not in window") + "</div>";
  const books = t.bookSignals || {};
  const bookRow = ["totalFirstMoveMs","kalshiTotalFirstMoveMs","moneylineFirstMoveMs"]
    .filter(k => books[k] != null)
    .map(k => "<div class=row><span>" + k + "</span><span>+" + books[k] + " ms</span></div>")
    .join("");
  el.innerHTML = headline + rows + (bookRow ? ("<div style=margin-top:8px>" + bookRow + "</div>") : "")
    + "<div class=row style=margin-top:8px><span>window age</span><span>" + t.ageMs + " ms</span></div>";
}

async function refresh() {
  const s = await api("/state");
  away = s.away; home = s.home; seen = s.seen;
  renderScore();
  renderRace(s);
}

/** VPS-local probe (no SSH tunnel). Same host, different port. */
async function probeVps() {
  if (!VPS_PROBE_PORT) return null;
  const host = location.hostname;
  if (!host || host === "127.0.0.1" || host === "localhost") return null;
  const url = location.protocol + "//" + host + ":" + VPS_PROBE_PORT + "/probe";
  const t0 = Date.now();
  const res = await fetch(url, { cache: "no-store" });
  const rtt = Date.now() - t0;
  if (!res.ok) throw new Error("vps probe " + res.status);
  return rtt;
}

async function reportTiming(payload) {
  try {
    await api("/timing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_) { /* non-fatal */ }
}

/**
 * Fire a score ping. bump ("away"|"home"|null) uses server-side atomic increment,
 * so rapid-fire taps compound correctly even with requests in flight.
 * Local score is bumped optimistically at tap time; server state wins on response.
 */
async function ping(bump, note) {
  document.getElementById("err").textContent = "";
  if (navigator.vibrate) navigator.vibrate(40);
  // Optimistic local render — instant feedback, correct compounding for rapid taps.
  if (bump === "away") away += 1;
  else if (bump === "home") home += 1;
  renderScore();
  const scoreEl = document.getElementById("score");
  scoreEl.classList.add("okflash");
  setTimeout(() => scoreEl.classList.remove("okflash"), 250);

  const tClient = Date.now();
  const vpsP = probeVps().catch(() => null);
  try {
    let s, rttMs;
    if (wsOpen) {
      const r = await wsRequest({ kind: "ping", bump, away, home, note }, 4000);
      s = r.msg; rttMs = r.rttMs;
    } else {
      s = await api("/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bump, away, home, tClient, note }),
      });
      rttMs = Date.now() - tClient;
    }
    const vpsRttMs = await vpsP;
    lastRttMs = rttMs;
    lastVpsRttMs = vpsRttMs;
    renderLat();
    away = s.away; home = s.home;
    renderScore();
    renderRace(s);
    await reportTiming({
      tClient,
      rttMs,
      vpsRttMs,
      oneWayPathEstMs: Math.round(rttMs / 2),
      lteToVpsOneWayEstMs: vpsRttMs == null ? null : Math.round(vpsRttMs / 2),
      note,
      away,
      home,
      transport: wsOpen ? "ws" : "http",
    });
  } catch (e) {
    document.getElementById("err").textContent = String(e.message || e);
    refresh().catch(() => {});
  }
}

// pointerdown fires on finger contact (not lift) — saves ~80-120ms per tap
// and never gets eaten by double-tap gesture heuristics.
function onTap(id, fn) {
  const el = document.getElementById(id);
  if (window.PointerEvent) {
    el.addEventListener("pointerdown", (ev) => { ev.preventDefault(); fn(); });
    // suppress the synthetic click that follows pointerdown to avoid double-fire
    el.addEventListener("click", (ev) => ev.preventDefault());
  } else {
    el.addEventListener("click", () => fn());
  }
}
onTap("bumpAway", () => ping("away", "bump_away"));
onTap("bumpHome", () => ping("home", "bump_home"));
onTap("pingSame", () => ping(null, "ping_same"));
onTap("sync", () => refresh().catch(e => {
  document.getElementById("err").textContent = String(e.message || e);
}));
wsConnect();
refresh().catch(e => { document.getElementById("err").textContent = String(e.message || e); });
// Warm path + show baseline latency without changing score.
(async () => {
  try {
    const t0 = Date.now();
    await api("/state");
    lastRttMs = Date.now() - t0;
    lastVpsRttMs = await probeVps().catch(() => null);
    renderLat();
    await reportTiming({
      tClient: t0,
      rttMs: lastRttMs,
      vpsRttMs: lastVpsRttMs,
      oneWayPathEstMs: Math.round(lastRttMs / 2),
      lteToVpsOneWayEstMs: lastVpsRttMs == null ? null : Math.round(lastVpsRttMs / 2),
      note: "warmup",
    });
  } catch (_) {}
})();
setInterval(() => refresh().catch(() => {}), 1500);
</script>
</body>
</html>`;
}

export function startPhoneScorePingServer(
  paper: PhoneScorePingPaper,
  opts: PhoneScorePingOpts,
): { server: Server; url: string; token: string; close: () => void } {
  const port = opts.port;
  const bind = opts.bind ?? "0.0.0.0";
  const token = opts.token || process.env.PLR_SCORE_PING_TOKEN || randomBytes(12).toString("hex");
  const awayLabel = opts.awayLabel ?? "AWAY";
  const homeLabel = opts.homeLabel ?? "HOME";
  const slug = opts.slug ?? "";
  const vpsProbePort = opts.vpsProbePort ?? Number(process.env.PLR_SCORE_PING_VPS_PROBE_PORT ?? 8792);
  const log = opts.log ?? console.log;

  const authed = (req: IncomingMessage, url: URL): boolean => {
    const q = url.searchParams.get("token");
    const h = req.headers["x-score-ping-token"];
    const got = q || (Array.isArray(h) ? h[0] : h);
    return !!got && got === token;
  };

  /** Shared ping logic for HTTP POST /ping and WS {kind:"ping"}. Returns state or an error string. */
  const applyPing = (
    body: any,
    tRecv: number,
    transport: "http" | "ws",
  ): { ok: true; state: ReturnType<PhoneScorePingPaper["getScoreState"]>; clockSkewMs: number | null } | { ok: false; error: string } => {
    const state0 = paper.getScoreState();
    let away = Number(body.away);
    let home = Number(body.home);
    const bump = String(body.bump || "");
    // bump = server-side atomic increment; rapid-fire safe even with requests in flight.
    if (bump === "away") {
      away = state0.away + 1;
      home = state0.home;
    } else if (bump === "home") {
      away = state0.away;
      home = state0.home + 1;
    }
    if (!Number.isFinite(away) || !Number.isFinite(home)) {
      return { ok: false, error: "away/home required" };
    }
    const tClient = Number(body.tClient);
    // clockSkewMs is phone_clock vs mac_clock — NOT path latency. Keep for forensics only.
    const clockSkewMs = Number.isFinite(tClient) ? tRecv - tClient : null;
    paper.onPhonePing(away, home, tRecv, {
      tClient: Number.isFinite(tClient) ? tClient : null,
      note: body.note ?? null,
      clockSkewMs,
      // legacy field name was misleading; keep null so old readers don't treat it as lag
      recvSkewMs: null,
    });
    opts.onEmit?.({
      kind: "phone_ping",
      away,
      home,
      tRecv,
      tClient: Number.isFinite(tClient) ? tClient : null,
      clockSkewMs,
      note: body.note ?? null,
      transport,
    });
    return { ok: true, state: paper.getScoreState(), clockSkewMs };
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,x-score-ping-token",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        if (!authed(req, url)) {
          sendHtml(
            res,
            `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
             <body style="font-family:system-ui;background:#111;color:#eee;padding:24px">
             <p>Add <code>?token=…</code> from the recorder log.</p>`,
          );
          return;
        }
        sendHtml(res, pageHtml({ token, awayLabel, homeLabel, slug, vpsProbePort }));
        return;
      }

      if (!authed(req, url)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/state") {
        sendJson(res, 200, paper.getScoreState());
        return;
      }

      if (req.method === "POST" && url.pathname === "/reset") {
        if (!paper.resetScoreToFeed) {
          sendJson(res, 501, { error: "reset not supported" });
          return;
        }
        const state = await paper.resetScoreToFeed();
        opts.onEmit?.({ kind: "phone_score_reset", ...state });
        sendJson(res, 200, { ok: true, ...state, ...paper.getScoreState() });
        return;
      }

      // Instant probe through the full tunnel path (for RTT without mutating score).
      if (req.method === "GET" && url.pathname === "/probe") {
        sendJson(res, 200, { ok: true, tRecv: Date.now(), hop: "mac_via_tunnel" });
        return;
      }

      // Phone reports same-clock RTT after /ping or warmup.
      if (req.method === "POST" && url.pathname === "/timing") {
        const raw = await readBody(req);
        let body: any = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        const rttMs = Number(body.rttMs);
        const vpsRttMs = body.vpsRttMs == null ? null : Number(body.vpsRttMs);
        const oneWay = Number.isFinite(rttMs) ? Math.round(rttMs / 2) : null;
        const lteOneWay =
          vpsRttMs != null && Number.isFinite(vpsRttMs) ? Math.round(vpsRttMs / 2) : null;
        log(
          `phone-score-ping PATH_RTT ${Number.isFinite(rttMs) ? rttMs : "?"}ms` +
            ` oneWayEst=${oneWay ?? "?"}ms` +
            ` vpsRtt=${vpsRttMs != null && Number.isFinite(vpsRttMs) ? vpsRttMs : "?"}ms` +
            ` lteToVpsOneWayEst=${lteOneWay ?? "?"}ms` +
            ` note=${body.note ?? ""}`,
        );
        opts.onEmit?.({
          kind: "phone_ping_timing",
          t: Date.now(),
          tClient: Number.isFinite(Number(body.tClient)) ? Number(body.tClient) : null,
          rttMs: Number.isFinite(rttMs) ? rttMs : null,
          vpsRttMs: vpsRttMs != null && Number.isFinite(vpsRttMs) ? vpsRttMs : null,
          oneWayPathEstMs: oneWay,
          lteToVpsOneWayEstMs: lteOneWay,
          note: body.note ?? null,
          away: body.away ?? null,
          home: body.home ?? null,
          transport: body.transport ?? null,
          // Explicit: do not use cross-device Date.now() delta as path lag.
          clockSkewMsIgnored: true,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/ping") {
        const tRecv = Date.now();
        const raw = await readBody(req);
        let body: any = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: "invalid json" });
          return;
        }
        if (!body.bump && url.searchParams.get("bump")) body.bump = url.searchParams.get("bump");
        const r = applyPing(body, tRecv, "http");
        if (!r.ok) {
          sendJson(res, 400, { error: r.error });
          return;
        }
        // Respond immediately — do not wait for score-track open (that inflated RTT).
        sendJson(res, 200, {
          ...r.state,
          timing: {
            tRecv,
            note: "Measure RTT on the phone (same clock). clockSkewMs is not path lag.",
            clockSkewMs: r.clockSkewMs,
          },
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 500, { error: String(e).slice(0, 200) });
    }
  });

  // Persistent WS pipe: a tap is one small frame on an open connection — no TCP/HTTP
  // handshake per ping. Heartbeats every ~5s keep the LTE radio in CONNECTED state.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws" || !authed(req, url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      log(`phone-score-ping WS connected`);
      ws.on("message", (data) => {
        const tRecv = Date.now();
        let body: any;
        try {
          body = JSON.parse(String(data));
        } catch {
          return;
        }
        const seq = body.seq ?? null;
        if (body.kind === "hb") {
          ws.send(JSON.stringify({ kind: "hb", seq, tRecv }));
          return;
        }
        if (body.kind === "ping") {
          const r = applyPing(body, tRecv, "ws");
          if (!r.ok) {
            ws.send(JSON.stringify({ kind: "error", seq, error: r.error }));
            return;
          }
          ws.send(
            JSON.stringify({
              kind: "pong",
              seq,
              ...r.state,
              timing: { tRecv, clockSkewMs: r.clockSkewMs },
            }),
          );
          return;
        }
        if (body.kind === "state") {
          ws.send(JSON.stringify({ kind: "state", seq, ...paper.getScoreState() }));
        }
      });
      ws.on("close", () => log(`phone-score-ping WS disconnected`));
    });
  });

  server.listen(port, bind, () => {
    log(`phone-score-ping listening http://${bind}:${port}/?token=${token}`);
    log(`phone-score-ping open that URL on your phone (tunnel/Tailscale if remote)`);
    log(`phone-score-ping latency = phone-clock RTT; ignore cross-clock skew`);
    log(`phone-score-ping WS pipe at ws://${bind}:${port}/ws (taps use it automatically)`);
  });

  return {
    server,
    url: `http://${bind}:${port}/?token=${token}`,
    token,
    close: () => {
      try {
        for (const c of wss.clients) c.terminate();
        wss.close();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}
