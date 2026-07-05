# Edge — Agent Edge Module Spec

**Owner:** Agent Edge  
**Read with:** `PROTOCOL.md` (message formats) + `DASHBOARD.md` (dashboard spec).  
**Do NOT load:** `firmware/*` files. Edge and Firmware communicate only through `PROTOCOL.md`.

---

## File Map

```
edge/
├── EDGE.md              ← This file
├── DASHBOARD.md          ← Dashboard spec
├── src/
│   ├── index.ts          ← Worker entry: routes, dashboard HTML, REST API
│   ├── device-hub.ts     ← DO class: hot path, alarm, broadcast
│   └── auth.ts           ← JWT sign/verify, PBKDF2 (Phase 3+)
├── db/
│   └── schema.sql        ← D1 full schema
├── wrangler.jsonc
├── package.json
└── .wrangler/            ← wrangler state (git-ignored)
```

---

## Worker Routes (`index.ts`)

| Method | Path | Handler | Auth | Phase |
|---|---|---|---|---|
| GET | `/` | Return `DASHBOARD_HTML` | No | 1 |
| GET | `/dashboard` | Redirect to `/` | No | 1 |
| GET | `/health` | `{"status":"ok"}` | No | 1 |
| GET | `/device/:id` | WebSocket upgrade → DO | No | 1 |
| GET | `/dashboard/:id` | WebSocket upgrade → DO | Token optional (Phase 3+) | 1 |
| POST | `/api/auth/login` | JWT issue | No (whitelist) | 3 |
| GET | `/api/auth/me` | User info | JWT required | 3 |
| GET | `/api/telemetry` | Query D1 | JWT required | 3 |
| GET | `/api/devices` | Device list + status | JWT required | 3 |
| GET | `/api/alerts` | Alert list | JWT required | 3 |
| POST | `/api/alerts/ack` | Acknowledge alert | JWT required | 3 |

---

## DO Class (`device-hub.ts`) — Non-Negotiables

### Constructor
```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  // Restore WebSocket connections from hibernation
  ctx.getWebSockets().forEach((ws) => {
    const meta = ws.deserializeAttachment() as Attachment | null;
    if (meta?.role === "esp32") {
      this.esp32ws = ws;
    } else if (meta?.role === "dashboard") {
      this.dashboards.set(ws, meta);
    }
  });
}
```
- **Must:** call `ctx.getWebSockets()` and `ws.deserializeAttachment()` to restore Maps
- **Must NOT:** do any storage reads, network calls, or `await` anything
- **Must NOT:** call `ctx.blockConcurrencyWhile()` (adds latency to wake)

### fetch() — WebSocket Upgrade
```ts
async fetch(request: Request): Promise<Response> {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  this.ctx.acceptWebSocket(server);  // HIBERNATION — never server.accept()
  server.serializeAttachment({ role, connectedAt: Date.now() });
  // Push initial state to new connection
  // Return 101 with client
}
```
- **Must:** `ctx.acceptWebSocket(server)` — never `server.accept()`
- **Must:** `serializeAttachment({role, connectedAt})` for every connection
- **Must:** Push initial state on connect (sync for ESP32, state for dashboard)

### webSocketMessage() — Hot Path
```ts
async webSocketMessage(ws: WebSocket, raw: string) {
  // ZERO awaits. All storage is synchronous ctx.storage.sql.exec().
  const msg = JSON.parse(raw);
  if (msg.type === "telemetry") {
    // Synchronous INSERT into telemetry_buffer (µs)
    this.ctx.storage.sql.exec(
      "INSERT INTO telemetry_buffer (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms) VALUES (?,?,?,?,?,?,?,?)",
      msg.device_id, msg.tds, msg.ec, msg.ph, msg.temp, msg.led ? 1 : 0, msg.esp32_ms, Date.now()
    );
    // Check relay_queue synchronously
    let cursor = this.ctx.storage.sql.exec(
      "SELECT id, command, params_json FROM relay_queue WHERE device_id = ? ORDER BY id ASC LIMIT 1",
      msg.device_id
    );
    // ... forward to ESP32, delete from queue
    // Check thresholds → INSERT alert_buffer synchronously
    // Broadcast to dashboards
  }
  // Same pattern for ack, ping, etc.
}
```
- **Must:** ZERO `await` calls in this method
- **Must:** All storage via `this.ctx.storage.sql.exec()` — synchronous
- **Must NOT:** call `this.env.DB.*` (D1) — that's for alarm handler only

### webSocketClose() & webSocketError()
Both clean up Maps, broadcast disconnect status. `webSocketError` handles the same cleanup as close — GREENY's original missed this.

### alarm() — Cold Path (D1 Sync)
```ts
async alarm() {
  // Flush telemetry_buffer → D1
  let cursor = this.ctx.storage.sql.exec(
    "SELECT * FROM telemetry_buffer WHERE flushed = 0"
  );
  const rows = [...cursor];
  for (const row of rows) {
    await this.env.DB.prepare(
      "INSERT INTO telemetry (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(row.device_id, row.tds, row.ec, row.ph, row.temp, row.led, row.esp32_ms, row.do_ms).run();
  }
  this.ctx.storage.sql.exec("UPDATE telemetry_buffer SET flushed = 1 WHERE flushed = 0");

  // Same pattern for alert_buffer → D1 alerts

  // Schedule next alarm
  await this.ctx.storage.setAlarm(Date.now() + 60_000);
}
```
- **Must:** `WHERE flushed = 0` for idempotency (alarm can fire more than once)
- **Must:** Wrap in transaction or accept at-least-once semantics
- **Must:** Reschedule alarm at end (even on error, to retry)

---

## DO-Local SQLite Tables (created in constructor)

```sql
CREATE TABLE IF NOT EXISTS telemetry_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    tds REAL, ec REAL, ph REAL, temp REAL,
    led INTEGER DEFAULT 0,
    esp32_ms INTEGER, do_ms INTEGER,
    flushed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS relay_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    command TEXT NOT NULL,
    params_json TEXT,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS alert_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT DEFAULT 'warning',
    created_at INTEGER,
    flushed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS device_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
```

---

## Alert Thresholds (in webSocketMessage)

| Condition | Type | Severity |
|---|---|---|
| pH < 5.5 | `ph_low` | warning |
| pH > 8.5 | `ph_high` | warning |
| EC > 2000 | `ec_high` | warning |
| temp < 18 | `temp_low` | warning |
| temp > 30 | `temp_high` | warning |

---

## Deployment

```bash
# 1. Bundle
cd edge
npx esbuild src/index.ts --bundle --format=esm --outfile=src/index.mjs --external:cloudflare:workers

# 2. Deploy (API multipart — wrangler has Windows junction issues)
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/758cece0f853404f97b17f0ff86b5190/workers/scripts/iot-hub" \
  -H "Authorization: Bearer <FunConnect token>" \
  -F 'metadata={"main_module":"index.mjs","compatibility_date":"2025-12-01","compatibility_flags":["nodejs_compat"],"bindings":[{"name":"DEVICE_HUB","type":"durable_object_namespace","class_name":"DeviceHub"}],"migrations":{"tag":"v2","new_sqlite_classes":["DeviceHub"]}};type=application/json' \
  -F 'index.mjs=@src/index.mjs;type=application/javascript+module'

# 3. Or with wrangler (if Application Data permission fixed):
set WRANGLER_HOME=%CD%\.wrangler
npx wrangler deploy
```

---

## JWT Auth (`auth.ts`) — Phase 3+

```ts
// HS256 via Web Crypto API — zero npm dependencies
const encoder = new TextEncoder();

async function signJWT(payload: object, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({alg:"HS256",typ:"JWT"}));
  const body = btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`));
  return `${header}.${body}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyJWT(token: string, secret: string): Promise<object | null> { ... }

async function hashPassword(password: string, salt: string): Promise<string> {
  // PBKDF2 via crypto.subtle
}
```

JWT secret: stored in `settings` D1 table (key=`jwt_secret`) or wrangler secret. Whitelist: `POST /api/auth/login` (no auth). Middleware pattern: extract `Authorization: Bearer <token>` header, verify, attach `user` to request context or return 401.

---

## Phase-by-Phase File Changes

| Phase | Files Changed | What Changes |
|---|---|---|
| 1 | `device-hub.ts`, `index.ts`, `wrangler.jsonc` | Port to ctx.storage.sql, attachment restore, webSocketError, initial state push |
| 2 | `device-hub.ts` (alarm), `wrangler.jsonc` (D1 binding), `db/schema.sql` | Add alarm handler, D1 binding, create D1 schema |
| 3 | `index.ts`, `auth.ts` (new) | Add REST routes, JWT middleware, login endpoint |
| 4 | `index.ts` (DASHBOARD_HTML) | Auth UI, alert panel, gauge polish |

---

## New Features (2026-07-05)

### Generic Command Passthrough
`handleDashboardCommand` now has a catch-all for unknown `{command:"..."}` messages. Any command not matching `set_led` or `calibrate` is forwarded directly to the ESP32 via `this.esp32ws.send(JSON.stringify(msg))`. Used by `wifi_scan`, `wifi_set`, and future commands. No code changes needed to add new ESP32 commands — just implement the handler in firmware.

### WiFi Broadcast Relay
The DO broadcasts `{type:"wifi_list"}` and `{type:"wifi_ack"}` from the ESP32 to all dashboard connections. These are handled inside the main `if (meta?.role === "esp32")` block alongside telemetry, ack, and ping. Previously placed as `else if` branches after the block (unreachable bug — fixed by moving inside).

### Bidirectional Health Check
The DO tracks `this.lastTelemetryMs` — updated on every telemetry message. In the alarm handler, if `this.esp32ws` is non-null but `this.lastTelemetryMs` is still 0 (no telemetry received since connect), the WebSocket is closed. This detects half-open connections where ESP32→DO works but DO→ESP32 is broken — common after Worker deploys. The ESP32's firmware watchdog handles the other direction independently.

### GreenyAgent DO (AI Agent)
A second DO class (`GreenyAgent`) lives on the same Worker. It reads DeviceHub's DO-local SQLite via internal REST calls (`/do-telemetry`, `/do-alerts`) — same-colo, sub-millisecond, zero quota. Exposed at `POST /api/chat`. Uses Workers AI with pre-fetch pattern: regex intent matching → fetch relevant data → embed in prompt → model interprets. Calibration state machine stored in `ctx.storage.sql`.

### Relay Command Endpoint Extended
The `/relay-cmd` DO endpoint now supports both set_led (Casey protocol compat: `relay1` field) and calibrate (GreenyAgent: `command:"calibrate"` with params). HTTP `POST /api/relay` proxies through the Worker to this endpoint.
