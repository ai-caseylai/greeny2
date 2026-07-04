# Dashboard — Agent Dashboard Module Spec

**Owner:** Agent Edge (dashboard lives inside the Worker as inline HTML).  
**Read with:** `PROTOCOL.md` (message formats).  
**Do NOT load:** `firmware/*` or `device-hub.ts` internals. Dashboard only talks to the DO via WebSocket JSON.

---

## Location

The dashboard is a constant string `DASHBOARD_HTML` inside `edge/src/index.ts`. It is served at `GET /`. No build step, no npm, no framework. Pure HTML + CSS + vanilla JS.

---

## UI Components

```
┌──────────────────────────────────┐
│  Device Dashboard                │
│  esp32-sensor                    │
│                                  │
│  ● Connected                     │
│                                  │
│  [LED circle — 64px]  LED: ON   │
│  [  ON  ] [ OFF ]               │
│                                  │
│  Last RTT: 577ms                │
│                                  │
│  ┌────────┬────────┐            │
│  │  TDS   │   EC   │            │
│  │  707   │  1413  │            │
│  │  ppm   │ μS/cm  │            │
│  ├────────┼────────┤            │
│  │   pH   │  Temp  │            │
│  │  7.12  │  25.3  │            │
│  │  pH    │   °C   │            │
│  └────────┴────────┘            │
│                                  │
│  ── Alerts ──────────────────   │
│  ⚠ EC 超出阈值: 2150 μS/cm      │
│  ───────────────────────────    │
│  14:32:01 Connected             │
│  14:32:05 State: LED=ON EC=1413 │
└──────────────────────────────────┘
```

---

## WebSocket Connection

```js
const DEVICE = "esp32-sensor";
const TOKEN = sessionStorage.getItem("jwt") || "";
const WS_URL = `wss://${location.host}/dashboard/${DEVICE}${TOKEN ? "?token=" + TOKEN : ""}`;

ws = new WebSocket(WS_URL);
// Auto-reconnect on close with 3s delay
```

---

## Message Handling

### Incoming: `{type: "state"}`
```js
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "state") {
    setConnected(msg.connected);
    setLED(msg.led);
    if (msg.tds  !== undefined) $("tdsVal").textContent  = msg.tds;
    if (msg.ec   !== undefined) $("ecVal").textContent   = msg.ec;
    if (msg.ph   !== undefined) $("phVal").textContent   = msg.ph;
    if (msg.temp !== undefined) $("tempVal").textContent = msg.temp;
    if (msg.doTs) $("rttVal").textContent = (Date.now() - msg.doTs) + "ms";
  }
};
```

### Incoming: `{type: "alert"}` (Phase 4+)
```js
if (msg.type === "alert") {
  addAlert(msg.alert_type, msg.message, msg.severity);
}
```

### Outgoing: Commands
```js
function sendCommand(cmd) {
  ws.send(JSON.stringify({
    command: "set_led",
    device_id: DEVICE,
    state: cmd === "on",
    ts: Date.now()
  }));
}
```

---

## Auth Flow (Phase 4)

```
1. Page loads → check sessionStorage for JWT
2. If no JWT → show login form (username + password)
3. Submit → POST /api/auth/login → store JWT in sessionStorage
4. Connect WebSocket with ?token=<JWT>
5. On 401 or WS auth failure → clear sessionStorage, show login
```

```html
<div id="loginBox">
  <input id="username" placeholder="Username" />
  <input id="password" type="password" placeholder="Password" />
  <button id="btnLogin">Login</button>
  <div id="loginError"></div>
</div>
<div id="dashboardBox" style="display:none">
  <!-- all dashboard content -->
</div>
```

---

## Design System

```css
/* Dark theme — no external CSS */
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0f172a;  /* slate-900 */
  color: #e2e8f0;       /* slate-200 */
}
.card {
  background: #1e293b;  /* slate-800 */
  border-radius: 16px;
  max-width: 420px;
  box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
}

/* LED circle */
.led-circle.on  { background: #eab308; box-shadow: 0 0 30px rgba(234,179,8,0.6); }
.led-circle.off { background: #1e293b; box-shadow: none; }

/* Status dot */
.dot-on  { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.dot-off { background: #ef4444; box-shadow: 0 0 8px #ef4444; }

/* Buttons */
.btn-on  { background: #16a34a; color: #fff; }
.btn-off { background: #dc2626; color: #fff; }
button:disabled { opacity: 0.35; cursor: not-allowed; }

/* Sensor gauges — 2×2 CSS grid */
.sensors { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.sensor-value { font-size: 1.5rem; font-weight: 700; }

/* Alert panel (Phase 4+) */
.alert { padding: 8px 12px; border-radius: 6px; margin: 4px 0; }
.alert-warning { background: #78350f; color: #fbbf24; }
.alert-critical { background: #7f1d1d; color: #fca5a5; }

/* Log box */
.log { max-height: 160px; overflow-y: auto; font-family: monospace; font-size: 0.78rem; }
```

---

## Device Selector (if multiple ESP32s)

```html
<select id="deviceSelect">
  <option value="esp32-sensor">Sensor Hub</option>
  <option value="esp32-led">LED Controller</option>
</select>
```

Switching devices: close current WS, connect to new `/dashboard/<id>`.

---

## Things the Dashboard Agent Must NOT Do

- Change the wire protocol (field names, message types) — those are in `PROTOCOL.md`
- Add npm dependencies (no React, no Tailwind, no build step)
- Read DO internals — the dashboard only sees `{type:"state", ...}` broadcasts
- Store passwords in localStorage (use sessionStorage, cleared on tab close)
