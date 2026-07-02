// ../../Projects/Prototype/iot-hub/src/device-hub.ts
import { DurableObject } from "cloudflare:workers";
var DeviceHub = class extends DurableObject {
  esp32ws = null;
  browsers = /* @__PURE__ */ new Map();
  ledState = false;
  tds = 0;
  ec = 0;
  ph = 7;
  temp = 25;
  constructor(ctx, env) {
    super(ctx, env);
    ctx.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment();
      if (meta?.role === "esp32") {
        this.esp32ws = ws;
      } else if (meta?.role === "browser") {
        this.browsers.set(ws, meta);
      }
    });
    console.log(
      `[DO] constructor \u2014 esp32:${this.esp32ws ? "yes" : "no"}, browsers:${this.browsers.size}`
    );
  }
  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const role = url.pathname.includes("dashboard") ? "browser" : "esp32";
    const meta = { role, connectedAt: Date.now() };
    server.serializeAttachment(meta);
    if (role === "esp32") {
      this.esp32ws = server;
      console.log("[DO] ESP32 connected");
      server.send(
        JSON.stringify({
          type: "sync",
          led: this.ledState,
          doTs: Date.now()
        })
      );
    } else {
      this.browsers.set(server, meta);
      console.log(`[DO] Browser connected (${this.browsers.size} total)`);
      server.send(
        JSON.stringify({
          type: "state",
          led: this.ledState,
          connected: this.esp32ws !== null,
          doTs: Date.now()
        })
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    const meta = ws.deserializeAttachment();
    try {
      const msg = JSON.parse(raw);
      if (meta?.role === "esp32") {
        this.handleESP32Message(ws, msg);
      } else if (meta?.role === "browser") {
        this.handleBrowserMessage(msg);
      }
    } catch (err) {
      console.log("[DO] Invalid JSON from", meta?.role, err);
    }
  }
  handleESP32Message(ws, msg) {
    if (msg.type === "ack") {
      const led = msg.led;
      this.ledState = led;
      const ackTs = Date.now();
      console.log(`[DO] ESP32 ack: led=${led}, doTs=${ackTs}`);
      this.ctx.storage.put("ledState", led ? 1 : 0);
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: true,
        doTs: ackTs
      });
    } else if (msg.type === "telemetry") {
      this.tds = msg.tds;
      this.ec = msg.ec;
      this.ph = msg.ph;
      this.temp = msg.temp;
      this.ledState = msg.led;
      const ackTs = Date.now();
      this.ctx.storage.put("tds", msg.tds);
      this.ctx.storage.put("ec", msg.ec);
      this.ctx.storage.put("ph", msg.ph);
      this.ctx.storage.put("temp", msg.temp);
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: true,
        tds: this.tds,
        ec: this.ec,
        ph: this.ph,
        temp: this.temp,
        doTs: ackTs
      });
    } else if (msg.type === "ping") {
      ws.send(
        JSON.stringify({
          type: "pong",
          seq: msg.seq,
          echo: `[DO] received ping seq=${msg.seq}`
        })
      );
    }
  }
  handleBrowserMessage(msg) {
    if (msg.command === "calibrate" && this.esp32ws) {
      console.log(`[DO] browser command: calibrate ${msg.params?.type}`);
      this.esp32ws.send(JSON.stringify(msg));
    } else if (msg.command === "set_led" && this.esp32ws) {
      const state = msg.state;
      const clientTs = msg.ts;
      const doTs = Date.now();
      console.log(
        `[DO] browser command: set_led=${state}, clientTs=${clientTs}, doForwardTs=${doTs}`
      );
      this.esp32ws.send(
        JSON.stringify({
          command: "set_led",
          params: { state }
        })
      );
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    const meta = ws.deserializeAttachment();
    if (meta?.role === "esp32") {
      this.esp32ws = null;
      console.log("[DO] ESP32 disconnected");
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: false,
        doTs: Date.now()
      });
    } else {
      this.browsers.delete(ws);
      console.log(`[DO] Browser disconnected (${this.browsers.size} remain)`);
    }
    ws.close(code, reason);
  }
  async webSocketError(ws, error) {
    const meta = ws.deserializeAttachment();
    console.log(`[DO] WebSocket error on ${meta?.role}:`, error);
    if (meta?.role === "esp32") {
      this.esp32ws = null;
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: false,
        doTs: Date.now()
      });
    } else {
      this.browsers.delete(ws);
    }
  }
  broadcast(data) {
    const json = JSON.stringify(data);
    this.browsers.forEach((_, ws) => {
      try {
        ws.send(json);
      } catch {
        this.browsers.delete(ws);
      }
    });
  }
};

// ../../Projects/Prototype/iot-hub/src/index.ts
var DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IoT Hub \u2014 Device Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh;
  }
  .card {
    background: #1e293b; border-radius: 16px; padding: 40px;
    width: 100%; max-width: 420px;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
  }
  .title { font-size: 1.2rem; color: #94a3b8; margin-bottom: 4px; }
  .device { font-size: 1.6rem; font-weight: 700; margin-bottom: 24px; }
  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; font-size: 0.95rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .dot-on { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .dot-off { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
  .led-display {
    display: flex; align-items: center; gap: 16px; margin-bottom: 28px;
  }
  .led-circle {
    width: 64px; height: 64px; border-radius: 50%;
    border: 3px solid #334155;
    transition: all 0.3s ease;
  }
  .led-circle.on {
    background: #eab308; border-color: #facc15;
    box-shadow: 0 0 30px rgba(234,179,8,0.6), 0 0 60px rgba(234,179,8,0.3);
  }
  .led-circle.off {
    background: #1e293b; border-color: #334155;
    box-shadow: none;
  }
  .led-label { font-size: 1.1rem; color: #94a3b8; }
  .btn-row { display: flex; gap: 12px; margin-bottom: 24px; }
  button {
    flex: 1; padding: 14px 0; border: none; border-radius: 10px;
    font-size: 1rem; font-weight: 600; cursor: pointer;
    transition: all 0.15s ease;
  }
  button:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn-on  { background: #16a34a; color: #fff; }
  .btn-on:hover:not(:disabled)  { background: #15803d; }
  .btn-off { background: #dc2626; color: #fff; }
  .btn-off:hover:not(:disabled) { background: #b91c1c; }
  .latency { font-size: 0.85rem; color: #64748b; text-align: center; }
  .latency span { color: #22d3ee; font-weight: 600; }
  .log {
    margin-top: 20px; padding: 12px; background: #0f172a;
    border-radius: 8px; font-family: 'Courier New', monospace;
    font-size: 0.78rem; color: #64748b;
    max-height: 160px; overflow-y: auto;
  }
  .log .line { padding: 2px 0; border-bottom: 1px solid #1e293b; }
  .log .line:last-child { border-bottom: none; }
  .sensors {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
    margin: 20px 0; padding: 16px; background: #0f172a;
    border-radius: 10px;
  }
  .sensor { text-align: center; }
  .sensor-label { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .sensor-value { font-size: 1.5rem; font-weight: 700; color: #e2e8f0; }
  .sensor-unit  { font-size: 0.75rem; color: #64748b; }
</style>
</head>
<body>
<div class="card">
  <div class="title">Device Dashboard</div>
  <div class="device" id="deviceId">esp32-01</div>

  <div class="status-row">
    <span class="dot dot-off" id="statusDot"></span>
    <span id="statusText">Connecting\u2026</span>
  </div>

  <div class="led-display">
    <div class="led-circle off" id="ledCircle"></div>
    <span class="led-label">LED \u2014 <strong id="ledLabel">OFF</strong></span>
  </div>

  <div class="btn-row">
    <button class="btn-on"  id="btnOn"  disabled>ON</button>
    <button class="btn-off" id="btnOff" disabled>OFF</button>
  </div>

  <div class="latency">
    Last RTT: <span id="rttVal">\u2014</span>
  </div>

  <div class="sensors">
    <div class="sensor">
      <div class="sensor-label">TDS</div>
      <div class="sensor-value" id="tdsVal">\u2014</div>
      <div class="sensor-unit">ppm</div>
    </div>
    <div class="sensor">
      <div class="sensor-label">EC</div>
      <div class="sensor-value" id="ecVal">\u2014</div>
      <div class="sensor-unit">\u03BCS/cm</div>
    </div>
    <div class="sensor">
      <div class="sensor-label">pH</div>
      <div class="sensor-value" id="phVal">\u2014</div>
      <div class="sensor-unit">pH</div>
    </div>
    <div class="sensor">
      <div class="sensor-label">Temp</div>
      <div class="sensor-value" id="tempVal">\u2014</div>
      <div class="sensor-unit">\xB0C</div>
    </div>
  </div>

  <div class="log" id="logBox"></div>
</div>

<script>
const DEVICE = "esp32-sensor";
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://")
              + location.host + "/dashboard/" + DEVICE;

let ws;
const $ = (id) => document.getElementById(id);

function log(msg) {
  const box = $("logBox");
  const now = new Date().toLocaleTimeString();
  box.innerHTML += '<div class="line">' + now + " " + msg + "</div>";
  box.scrollTop = box.scrollHeight;
}

function setConnected(c) {
  $("statusDot").className = "dot " + (c ? "dot-on" : "dot-off");
  $("statusText").textContent = c ? "Connected" : "Disconnected";
  $("btnOn").disabled = !c;
  $("btnOff").disabled = !c;
  log(c ? "Connected" : "Disconnected");
}

function setLED(on) {
  $("ledCircle").className = "led-circle " + (on ? "on" : "off");
  $("ledLabel").textContent = on ? "ON" : "OFF";
}

function sendCommand(state) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const ts = Date.now();
  ws.send(JSON.stringify({ command: "set_led", state, ts }));
  log((state ? "ON" : "OFF") + " \u2192 sent");
}

function connect() {
  log("Connecting to " + WS_URL + " \u2026");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    log("WSS open, waiting for state\u2026");
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") {
      setConnected(msg.connected);
      setLED(msg.led);
      if (msg.tds  !== undefined) $("tdsVal").textContent = msg.tds;
      if (msg.ec   !== undefined) $("ecVal").textContent = msg.ec;
      if (msg.ph   !== undefined) $("phVal").textContent = msg.ph;
      if (msg.temp !== undefined) $("tempVal").textContent = msg.temp;
      const ts = Date.now();
      if (msg.doTs) {
        $("rttVal").textContent = (ts - msg.doTs) + "ms";
      }
      log("State: LED=" + (msg.led ? "ON" : "OFF") + " EC=" + msg.ec + " pH=" + msg.ph);
    }
  };

  ws.onclose = () => {
    setConnected(false);
    log("WSS closed \u2014 reconnecting in 3s\u2026");
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    log("WSS error");
  };
}

$("btnOn").addEventListener("click", () => sendCommand(true));
$("btnOff").addEventListener("click", () => sendCommand(false));

connect();

// Track full RTT from click \u2192 state update
let clickTs = 0;
$("btnOn").addEventListener("click", () => { clickTs = Date.now(); });
$("btnOff").addEventListener("click", () => { clickTs = Date.now(); });
const origOnMsg = WebSocket.prototype.onmessage;
// We already handle this in ws.onmessage above \u2014 RTT is edge\u2192browser
// Full RTT would need DO to pass clientTs back, which we do via state.doTs
<\/script>
</body>
</html>`;
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/" || path === "/dashboard") {
      return new Response(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if (path === "/health") {
      return Response.json({
        status: "ok",
        uptime: Math.floor(performance.now() / 1e3)
      });
    }
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === "websocket") {
      const segments = path.split("/").filter(Boolean);
      const deviceId = segments.length >= 2 ? segments[1] : "unknown";
      const isBrowser = segments[0] === "dashboard";
      const doId = env.DEVICE_HUB.idFromName(deviceId);
      const stub = env.DEVICE_HUB.get(doId);
      return stub.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
export {
  DeviceHub,
  index_default as default
};
