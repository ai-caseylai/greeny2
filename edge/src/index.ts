/**
 * IoT Hub — Worker (Phase 3: Auth + REST API)
 *
 * Routes:
 *   GET  /                  → Dashboard HTML
 *   GET  /health            → Health check
 *   POST /api/auth/login    → JWT login (no auth required)
 *   GET  /api/auth/me       → Current user info (JWT required)
 *   GET  /api/telemetry     → Query D1 telemetry (JWT required)
 *   GET  /api/devices       → Device list + status (JWT required)
 *   GET  /api/alerts        → Alert list (JWT required)
 *   POST /api/alerts/ack    → Acknowledge alert (JWT required)
 *   POST /api/chat          → AI agent chat (JWT required)
 *   GET  /device/:id        → WebSocket upgrade → DO
 *   GET  /dashboard/:id     → WebSocket upgrade → DO
 */

import { DeviceHub } from "./device-hub";
import { GreenyAgent } from "./agent";
import { signJWT, verifyJWT, verifyPassword } from "./auth";

// ── JWT Secret Cache ──────────────────────────────────────────────────────

let cachedJWTSecret: string | null = null;

async function getJWTSecret(env: Env): Promise<string> {
  if (cachedJWTSecret) return cachedJWTSecret;
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'jwt_secret'"
  ).first<{ value: string }>();
  if (row) cachedJWTSecret = row.value;
  return cachedJWTSecret ?? "";
}

// ── JWT Middleware ────────────────────────────────────────────────────────
// Whitelist: paths that skip auth

const AUTH_WHITELIST = new Set([
  "GET:/",
  "GET:/dashboard",
  "GET:/health",
  "POST:/api/auth/login",
]);

function needsAuth(method: string, path: string): boolean {
  // WebSocket upgrade paths: browsers cannot set Authorization headers,
  // so token is passed as ?token= query param. Skip header-based auth.
  if (path.startsWith("/device/") || path.startsWith("/dashboard/")) return false;
  return !AUTH_WHITELIST.has(`${method}:${path}`);
}

async function authenticate(
  request: Request,
  env: Env
): Promise<Record<string, unknown> | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const secret = await getJWTSecret(env);
  if (!secret) return null;

  return verifyJWT(token, secret);
}

// ── Dashboard HTML (Phase 3: unchanged, Phase 4 will enhance) ─────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Greeny — Smart Hydroponics</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; padding: 16px;
  }
  .card {
    background: #1e293b; border-radius: 16px; padding: 28px;
    width: 100%; max-width: 440px;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
  }
  .title { font-size: 1.1rem; color: #94a3b8; margin-bottom: 2px; }
  .device { font-size: 1.4rem; font-weight: 700; margin-bottom: 12px; }

  /* Status dot + connection */
  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 0.9rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; transition: all 0.3s; }
  .dot-on    { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .dot-stale { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; animation: pulse 2s infinite; }
  .dot-off   { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* LED toggle switch (Fix 5) */
  .led-row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
  .led-circle {
    width: 56px; height: 56px; border-radius: 50%; border: 3px solid #334155;
    transition: all 0.3s ease; flex-shrink: 0;
  }
  .led-circle.on {
    background: #eab308; border-color: #facc15;
    box-shadow: 0 0 30px rgba(234,179,8,0.6), 0 0 60px rgba(234,179,8,0.3);
  }
  .led-circle.off { background: #1e293b; border-color: #334155; box-shadow: none; }
  .toggle { position: relative; display: inline-block; width: 48px; height: 26px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; cursor: pointer; top:0;left:0;right:0;bottom:0; background:#334155; border-radius:26px; transition:0.3s; }
  .toggle-slider:before { position:absolute; content:""; height:18px; width:18px; left:4px; bottom:4px; background:white; border-radius:50%; transition:0.3s; }
  input:checked + .toggle-slider { background: #eab308; }
  input:checked + .toggle-slider:before { transform: translateX(22px); }
  .led-label { font-size: 1rem; color: #94a3b8; }

  /* RTT + last updated */
  .meta-row { display: flex; justify-content: space-between; font-size: 0.8rem; color: #64748b; margin-bottom: 14px; }
  .meta-row span { color: #22d3ee; font-weight: 600; }

  /* Sensor gauge arcs (Fix 10) */
  .gauges { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
  .gauge { position: relative; width: 100%; aspect-ratio: 1; max-width: 140px; margin: 0 auto; }
  .gauge-arc {
    width: 100%; height: 100%; border-radius: 50%;
    position: relative; overflow: hidden;
  }
  .gauge-bg {
    position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(
      #22c55e 0deg var(--gauge-pct, 0deg),
      #334155 var(--gauge-pct, 0deg) 360deg
    );
  }
  .gauge-center {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: 70%; height: 70%; border-radius: 50%; background: #0f172a;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .gauge-value { font-size: 1.2rem; font-weight: 700; line-height: 1; }
  .gauge-value.sensor-normal  { color: #22c55e; }
  .gauge-value.sensor-warning { color: #f59e0b; }
  .gauge-value.sensor-danger  { color: #ef4444; }
  .gauge-unit  { font-size: 0.65rem; color: #64748b; margin-top: 2px; }
  .gauge-label { text-align: center; font-size: 0.68rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

  /* Device info (Fix 9) */
  .device-info { font-size: 0.72rem; color: #475569; text-align: center; margin-bottom: 12px; min-height: 16px; }

  /* Toast container (Fix 7) */
  #toastContainer { position: fixed; top: 16px; right: 16px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; max-width: 340px; }
  .toast { padding: 10px 14px; border-radius: 8px; color: #fff; font-size: 0.82rem; animation: slideIn 0.3s ease; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
  .toast-warning  { background: #b45309; }
  .toast-critical { background: #dc2626; }
  .toast-msg { flex: 1; }
  .toast-close { cursor: pointer; font-size: 1rem; opacity: 0.7; line-height: 1; }
  .toast-close:hover { opacity: 1; }
  @keyframes slideIn  { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }

  /* Login */
  .login-box { text-align: center; }
  .login-box input {
    width: 100%; padding: 12px; margin-bottom: 10px; border-radius: 8px;
    border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 1rem;
  }
  .login-box input:focus { outline: none; border-color: #3b82f6; }
  .login-box button {
    width: 100%; padding: 12px; border-radius: 8px; border: none;
    font-size: 1rem; font-weight: 600; cursor: pointer; background: #3b82f6; color: #fff;
  }
  .login-box button:hover { background: #2563eb; }
  .login-error { color: #fca5a5; font-size: 0.85rem; margin-top: 8px; min-height: 20px; }
  .logout-link { font-size: 0.8rem; color: #64748b; cursor: pointer; text-align: right; margin-bottom: 8px; }
  .logout-link:hover { color: #ef4444; }

  /* Device selector */
  .device-select {
    width: 100%; padding: 8px 12px; margin-bottom: 12px; border-radius: 8px;
    border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 0.95rem;
  }

  /* Log */
  .log {
    margin-top: 14px; padding: 10px; background: #0f172a; border-radius: 8px;
    font-family: 'Courier New', monospace; font-size: 0.72rem; color: #64748b;
    max-height: 140px; overflow-y: auto;
  }
  .log .line { padding: 2px 0; border-bottom: 1px solid #1e293b; }
  .log .line:last-child { border-bottom: none; }
</style>
</head>
<body>

<!-- Toast container -->
<div id="toastContainer"></div>

<!-- Login Panel -->
<div class="card login-box" id="loginBox">
  <div class="title">Greeny IoT Hub</div>
  <div class="device" style="margin-bottom:24px">Login</div>
  <input id="username" type="text" placeholder="Username" autocomplete="username" />
  <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
  <button id="btnLogin">Sign In</button>
  <div class="login-error" id="loginError"></div>
</div>

<!-- Dashboard Panel -->
<div class="card" id="dashboardBox" style="display:none">
  <div class="logout-link" id="btnLogout">Logout</div>
  <div class="title">Device Dashboard</div>
  <select class="device-select" id="deviceSelect">
    <option value="esp32-sensor">esp32-sensor</option>
    <option value="esp32-led">esp32-led</option>
  </select>
  <div class="device" id="deviceId">esp32-sensor</div>

  <div class="device-info" id="deviceInfo"></div>

  <div class="status-row">
    <span class="dot dot-off" id="statusDot"></span>
    <span id="statusText">Connecting…</span>
  </div>

  <div class="led-row">
    <div class="led-circle off" id="ledCircle"></div>
    <span class="led-label">LED</span>
    <label class="toggle">
      <input type="checkbox" id="ledToggle" disabled />
      <span class="toggle-slider"></span>
    </label>
  </div>

  <div class="meta-row">
    <span>RTT: <b id="rttVal">—</b></span>
    <span id="lastUpdate" style="color:#64748b">—</span>
  </div>

  <div class="gauges">
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="tdsArc"></div><div class="gauge-center"><div class="gauge-value" id="tdsVal">—</div><div class="gauge-unit">ppm</div></div></div></div>
      <div class="gauge-label">TDS</div>
    </div>
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="ecArc"></div><div class="gauge-center"><div class="gauge-value" id="ecVal">—</div><div class="gauge-unit">μS/cm</div></div></div></div>
      <div class="gauge-label">EC</div>
    </div>
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="phArc"></div><div class="gauge-center"><div class="gauge-value" id="phVal">—</div><div class="gauge-unit">pH</div></div></div></div>
      <div class="gauge-label">pH</div>
    </div>
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="tempArc"></div><div class="gauge-center"><div class="gauge-value" id="tempVal">—</div><div class="gauge-unit">°C</div></div></div></div>
      <div class="gauge-label">Temp</div>
    </div>
  </div>

  <div class="log" id="logBox"></div>
</div>

<script>
// ── Globals ──
const $ = (id) => document.getElementById(id);
let ws, currentDevice = "esp32-sensor", JWT = sessionStorage.getItem("jwt") || "";
let lastUpdateTs = 0, connected = false, updateTimer = 0;

// ── Log ──
function log(msg) {
  const box = $("logBox"); if (!box) return;
  const now = new Date().toLocaleTimeString();
  box.innerHTML += '<div class="line">' + now + " " + msg + "</div>";
  box.scrollTop = box.scrollHeight;
}

// ── Sensor color thresholds (Fix 4) ──
function sensorClass(value, ranges) {
  if (!value && value !== 0) return "";
  const [loN,hiN,loW,hiW] = ranges;
  if (value >= loN && value <= hiN) return "sensor-normal";
  if (value >= loW && value <= hiW) return "sensor-warning";
  return "sensor-danger";
}

function updateSensor(elId, arcId, value, ranges, unit) {
  const elV = $(elId); if (!elV) return;
  elV.textContent = value != null ? value : "—";
  elV.className = "gauge-value " + sensorClass(value, ranges);
  // Update conic-gradient arc
  const arc = $(arcId); if (!arc || value == null) return;
  const maxVal = ranges[3]; // top of warning = full scale
  const pct = Math.min((value / maxVal) * 360, 360);
  arc.style.setProperty("--gauge-pct", pct + "deg");
}

function updateLastUpdate() {
  const el = $("lastUpdate"); if (!el) return;
  if (!connected) { el.textContent = "—"; el.style.color = "#64748b"; return; }
  const s = Math.floor((Date.now() - lastUpdateTs) / 1000);
  el.textContent = "Updated " + s + "s ago";
  el.style.color = s > 30 ? "#ef4444" : s > 15 ? "#f59e0b" : "#22c55e";
}

// ── Connection state (Fix 8: amber stale) ──
function setConnectionState(c, hasRecentData) {
  connected = c;
  const dot = $("statusDot"), txt = $("statusText"), tog = $("ledToggle");
  if (c) {
    if (!hasRecentData) {
      dot.className = "dot dot-on";
      txt.textContent = "Connected";
    } else {
      dot.className = "dot dot-stale";
      txt.textContent = "Connected (stale)";
    }
  } else {
    dot.className = "dot dot-off";
    txt.textContent = "Disconnected";
  }
  if (tog) tog.disabled = !c;
}

// ── Toast alerts (Fix 7) ──
function showToast(type, message, severity) {
  const container = $("toastContainer"); if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast " + (severity === "critical" ? "toast-critical" : "toast-warning");
  toast.innerHTML = '<span class="toast-msg">' + message + '</span><span class="toast-close">✕</span>';
  toast.querySelector(".toast-close").addEventListener("click", () => {
    toast.style.animation = "slideOut 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  });
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.animation = "slideOut 0.3s ease";
      setTimeout(() => { if (toast.parentElement) toast.remove(); }, 300);
    }
  }, 10000);
}

// ── Commands ──
function sendCommand(state) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ command: "set_led", state, device_id: currentDevice, ts: Date.now() }));
  log(state ? "ON → sent" : "OFF → sent");
}

// ── WebSocket ──
function connectWS() {
  if (!JWT) { showLogin(); return; }
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const WS_URL = proto + location.host + "/dashboard/" + currentDevice + "?token=" + JWT;
  log("Connecting to " + currentDevice + " …");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => { log("WSS open"); };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }

    if (msg.type === "state") {
      if (msg.connected !== undefined) setConnectionState(msg.connected, false);
      if (typeof msg.led === "boolean") {
        $("ledCircle").className = "led-circle " + (msg.led ? "on" : "off");
        const tog = $("ledToggle");
        if (tog) { tog.checked = msg.led; tog.disabled = !connected; }
      }

      // Update gauges with color thresholds + arcs (Fixes 4 + 10)
      updateSensor("tdsVal",  "tdsArc",  msg.tds,  [0,750,750,1500],  "ppm");
      updateSensor("ecVal",   "ecArc",   msg.ec,   [0,1500,1500,3000], "μS/cm");
      updateSensor("phVal",   "phArc",   msg.ph,   [6.0,7.0,5.5,8.5],  "pH");
      updateSensor("tempVal", "tempArc", msg.temp, [20,28,18,30],       "°C");

      if (msg.doTs) { const el = $("rttVal"); if (el) el.textContent = (Date.now() - msg.doTs) + "ms"; }

      // Device info (Fix 9)
      if (msg.esp32_ms !== undefined) {
        const el = $("deviceInfo");
        if (el) el.textContent = "ESP32 uptime: " + Math.floor(msg.esp32_ms / 1000) + "s · " + (msg.device_id || currentDevice);
      }

      lastUpdateTs = Date.now();
      updateLastUpdate();
      setConnectionState(true, true);
    }

    if (msg.type === "alert") {
      showToast(msg.alert_type, msg.message, msg.severity);
      log("[ALERT] " + msg.alert_type + ": " + msg.message);
    }
  };

  ws.onclose = () => {
    setConnectionState(false, false);
    log("WSS closed — reconnecting in 3s…");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => { log("WSS error"); };
}

// ── Auth ──
function showLogin() {
  $("loginBox").style.display = "block";
  $("dashboardBox").style.display = "none";
  if (ws) { try { ws.close(); } catch(e) {} ws = null; }
  JWT = ""; sessionStorage.removeItem("jwt");
  connected = false;
  if (updateTimer) { clearInterval(updateTimer); updateTimer = 0; }
}

function showDashboard() {
  $("loginBox").style.display = "none";
  $("dashboardBox").style.display = "block";
  $("deviceId").textContent = currentDevice;
  updateTimer = setInterval(updateLastUpdate, 1000);
  connectWS();
}

async function doLogin() {
  const username = $("username").value.trim();
  const password = $("password").value;
  const errEl = $("loginError");
  if (!username || !password) { errEl.textContent = "Enter username and password"; return; }
  errEl.textContent = "";
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.token) { errEl.textContent = data.error || "Login failed"; return; }
    JWT = data.token;
    sessionStorage.setItem("jwt", JWT);
    log("Logged in as " + data.user.username);
    showDashboard();
  } catch (err) { errEl.textContent = "Network error — try again"; }
}

function doLogout() { showLogin(); log("Logged out"); }

// ── Device Switching ──
function switchDevice(id) {
  currentDevice = id; $("deviceId").textContent = id;
  if (ws) { try { ws.close(); } catch(e) {} ws = null; }
  connectWS(); log("Switched to " + id);
}

// ── Init ──
$("btnLogin").addEventListener("click", doLogin);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("btnLogout").addEventListener("click", doLogout);
$("ledToggle").addEventListener("change", () => sendCommand($("ledToggle").checked));
$("deviceSelect").addEventListener("change", (e) => switchDevice(e.target.value));

if (JWT) { showDashboard(); } else { showLogin(); }
</script>
</body>
</html>`;

// ── CORS Helper ───────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: BodyInit | null, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

function corsJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}

// ── Worker ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // --- OPTIONS preflight (Fix 1) ---
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --- Public routes (no auth) ---
    if (method === "GET" && (path === "/" || path === "/dashboard")) {
      return corsResponse(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (method === "GET" && path === "/health") {
      return corsJson({
        status: "ok",
        uptime: Math.floor(performance.now() / 1000),
      });
    }

    // --- Auth: POST /api/auth/login ---
    if (method === "POST" && path === "/api/auth/login") {
      return handleLogin(request, env);
    }

    // --- Auth middleware for protected routes ---
    if (needsAuth(method, path)) {
      const user = await authenticate(request, env);
      if (!user) {
        return corsJson({ error: "Unauthorized" }, { status: 401 });
      }

      // --- Protected REST routes ---
      if (method === "GET" && path === "/api/auth/me") {
        return corsJson({ user });
      }

      if (method === "GET" && path === "/api/telemetry") {
        return handleGetTelemetry(url, env);
      }

      if (method === "GET" && path === "/api/devices") {
        return handleGetDevices(env);
      }

      if (method === "GET" && path === "/api/alerts") {
        return handleGetAlerts(url, env);
      }

      if (method === "POST" && path === "/api/alerts/ack") {
        return handleAckAlert(request, env);
      }

      if (method === "POST" && path === "/api/relay") {
        return handleRelay(request, env);
      }

      if (method === "POST" && path === "/api/chat") {
        return handleChat(request, env);
      }
    }

    // --- WebSocket upgrade → route to DO ---
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === "websocket") {
      const segments = path.split("/").filter(Boolean);
      const deviceId = segments.length >= 2 ? segments[1] : "unknown";

      const doId = env.DEVICE_HUB.idFromName(deviceId);
      const stub = env.DEVICE_HUB.get(doId);
      return stub.fetch(request);
    }

    return corsResponse("Not found", { status: 404 });
  },
};

// ── Route Handlers ────────────────────────────────────────────────────────

async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body: { username?: string; password?: string } = await request.json();
    if (!body.username || !body.password) {
      return corsJson({ error: "username and password required" }, { status: 400 });
    }

    const user = await env.DB.prepare(
      "SELECT id, username, password_hash, salt, role FROM users WHERE username = ?"
    ).bind(body.username).first<{
      id: number; username: string; password_hash: string; salt: string; role: string;
    }>();

    if (!user) {
      return corsJson({ error: "Invalid credentials" }, { status: 401 });
    }

    const valid = await verifyPassword(body.password, user.salt, user.password_hash);
    if (!valid) {
      return corsJson({ error: "Invalid credentials" }, { status: 401 });
    }

    const secret = await getJWTSecret(env);
    const token = await signJWT(
      { sub: user.username, id: user.id, role: user.role, iat: Math.floor(Date.now() / 1000) },
      secret
    );

    return corsJson({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
}

async function handleGetTelemetry(
  url: URL,
  env: Env
): Promise<Response> {
  const deviceId = url.searchParams.get("device_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1000);

  let rows;
  if (deviceId) {
    rows = await env.DB.prepare(
      "SELECT * FROM telemetry WHERE device_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(deviceId, limit).all();
  } else {
    rows = await env.DB.prepare(
      "SELECT * FROM telemetry ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all();
  }

  return corsJson({ telemetry: rows.results });
}

async function handleGetDevices(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT * FROM devices ORDER BY id ASC"
  ).all();
  return corsJson({ devices: rows.results });
}

async function handleGetAlerts(
  url: URL,
  env: Env
): Promise<Response> {
  const deviceId = url.searchParams.get("device_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);

  let rows;
  if (deviceId) {
    rows = await env.DB.prepare(
      "SELECT * FROM alerts WHERE device_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(deviceId, limit).all();
  } else {
    rows = await env.DB.prepare(
      "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all();
  }

  return corsJson({ alerts: rows.results });
}

async function handleAckAlert(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body: { alert_id?: number } = await request.json();
    if (!body.alert_id) {
      return corsJson({ error: "alert_id required" }, { status: 400 });
    }

    await env.DB.prepare(
      "UPDATE alerts SET acknowledged = 1 WHERE id = ?"
    ).bind(body.alert_id).run();

    return corsJson({ success: true });
  } catch (err) {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
}

// ── Chat (AI Agent) ────────────────────────────────────────────────────────

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const doId = env.GREENY_AGENT.idFromName("greeny");
    const stub = env.GREENY_AGENT.get(doId);
    return stub.fetch(request);
  } catch (err) {
    console.error("[Worker] handleChat error:", err);
    return corsJson({ error: "Agent unavailable" }, { status: 503 });
  }
}

// ── Relay (Casey protocol compat) ─────────────────────────────────────────

async function handleRelay(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { device_id?: string; relay1?: number; relay2?: number };
    if (!body.device_id) return corsJson({ error: "device_id required" }, { status: 400 });

    const doId = env.DEVICE_HUB.idFromName(body.device_id);
    const stub = env.DEVICE_HUB.get(doId);
    // Forward to DO's relay-cmd endpoint
    return stub.fetch(new Request("https://device-hub/relay-cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  } catch {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
}

// ── Env ───────────────────────────────────────────────────────────────────

interface Env {
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  GREENY_AGENT: DurableObjectNamespace<GreenyAgent>;
  DB: D1Database;
  AI: Ai;
}

export { DeviceHub, GreenyAgent };
