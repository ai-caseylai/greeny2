# Architecture — Greeny Alpha

**Owner:** Agent Alpha  
**Read by:** All agents for context, but only Agent Alpha may modify.

---

## System Diagram

```
ESP32 (#1 LED, #2 Sensor Hub)
  │  WSS + JSON (PROTOCOL.md)
  ▼
Cloudflare Worker (edge/src/index.ts)
  │  routes by path
  ├─ /, /dashboard       → DASHBOARD_HTML
  ├─ /health             → {"status":"ok"}
  ├─ /device/:id         → DO (ESP32 upgrade)
  ├─ /dashboard/:id      → DO (browser upgrade)
  └─ /api/*              → REST (JWT-gated, Phase 3+)
  │
  ▼
DeviceDO (edge/src/device-hub.ts) — per-device, hibernation
  │
  ├── DO-LOCAL SQLITE (hot path, synchronous, NO awaits)
  │   ├── telemetry_buffer   ← INSERT on each telemetry (µs)
  │   ├── relay_queue        ← SELECT/DELETE on telemetry (µs)
  │   ├── alert_buffer       ← INSERT on threshold breach (µs)
  │   └── device_state       ← key-value for ledState, calibration
  │
  ├── ALARM (every 60s, cold path, awaited)
  │   └── flush telemetry_buffer + alert_buffer → D1 (batch)
  │
  └── BROADCAST → all dashboard WebSockets (immediate)
  │
  ▼
D1 (greeny-db) — managed SQLite, cold path, queryable via REST
  ├── telemetry   (historical, all devices)
  ├── devices     (registry + online status)
  ├── alerts      (historical, acknowledged flag)
  ├── users       (auth)
  ├── settings    (key-value config)
  └── relay_log   (audit trail for commands)
```

---

## Two-Tier Storage — The Central Idea

| Tier | Where | Latency | Blocks hibernation? | Queryable by REST? |
|---|---|---|---|---|
| Hot path | DO-local SQLite (`ctx.storage.sql`) | Microseconds (same thread) | No — synchronous, no `await` | No (private to DO) |
| Cold path | D1 (`env.DB`) | 10–50ms (network) | Yes — `await` prevents hibernation | Yes (REST API, wrangler, AI agents) |

**Rule:** `webSocketMessage()` must contain ZERO `await` calls. All storage in the hot path uses `ctx.storage.sql.exec()` which is synchronous. D1 writes happen only in the alarm handler, which is allowed to await.

---

## Hibernation Non-Negotiables

Per Cloudflare lifecycle docs — a DO is hibernateable only when ALL are true:

1. **Constructor is fast.** Restore from `ctx.getWebSockets()` + `deserializeAttachment()` only. No storage reads, no network.
2. **No awaited I/O in message handlers.** No `await fetch()`, no `await env.DB.*`. All D1 access is deferred to alarm.
3. **`ctx.acceptWebSocket(server)` — never `server.accept()`.** The latter prevents hibernation entirely.
4. **No `setTimeout` / `setInterval`.** Use alarms for scheduled work.
5. **No outbound WebSocket or TCP connections.** The DO is a server only.

The runtime hibernates the DO after 10 seconds of idle post-handler.

---

## Module Boundaries

```
PROTOCOL.md  ← shared contract, all agents read, Agent Alpha owns
│
├── firmware/         ← Agent Firmware
│   ├── FIRMWARE.md   (module spec)
│   ├── esp32-led/    (Arduino sketch, ESP32 #1)
│   └── esp32-sensor/ (Arduino sketch, ESP32 #2)
│
├── edge/             ← Agent Edge
│   ├── EDGE.md       (module spec)
│   ├── DASHBOARD.md  (dashboard spec, read by Dashboard agent)
│   ├── src/
│   │   ├── index.ts       (Worker: routes, dashboard HTML, REST API)
│   │   ├── device-hub.ts  (DO class: hot-path handler, alarm, broadcast)
│   │   └── auth.ts        (JWT sign/verify, PBKDF2 hash)
│   ├── db/
│   │   └── schema.sql     (D1 tables)
│   ├── wrangler.jsonc
│   └── package.json
│
├── tools/            ← Shared utilities (no agent owns exclusively)
│   ├── toggle-led.mjs
│   ├── toggle-log.jsonl
│   ├── graph-results.py
│   └── send-cal.py
│
└── ARCHITECTURE.md   ← This file (Agent Alpha)
```

**Context isolation:** Agent Firmware loads `PROTOCOL.md` + `FIRMWARE.md` + one `.ino`. Never loads `device-hub.ts` or `index.ts`. Agent Edge loads `PROTOCOL.md` + `EDGE.md` + `DASHBOARD.md` + source files. Never loads `.ino` files.

---

## DO-Local SQLite Schema

```sql
-- Hot path: written synchronously in webSocketMessage
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
    command TEXT NOT NULL,        -- 'set_led', 'calibrate'
    params_json TEXT,             -- JSON string
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

## D1 Schema (greeny-db)

```sql
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'offline',
    last_seen INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    tds REAL, ec REAL, ph REAL, temp REAL,
    led INTEGER DEFAULT 0,
    esp32_ms INTEGER, do_ms INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, created_at);

CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    severity TEXT DEFAULT 'warning',
    acknowledged INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE relay_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    command TEXT NOT NULL,
    params_json TEXT,
    status TEXT DEFAULT 'sent',
    created_at INTEGER DEFAULT (unixepoch())
);
```

---

## Alarm Handler Pseudocode

```
alarm():
  BEGIN TRANSACTION
  rows = SELECT * FROM telemetry_buffer WHERE flushed = 0
  for each row:
    await DB.prepare("INSERT INTO telemetry (...) VALUES (...)").run()
  UPDATE telemetry_buffer SET flushed = 1 WHERE flushed = 0

  alerts = SELECT * FROM alert_buffer WHERE flushed = 0
  for each alert:
    await DB.prepare("INSERT INTO alerts (...) VALUES (...)").run()
  UPDATE alert_buffer SET flushed = 1 WHERE flushed = 0

  COMMIT
  setAlarm(Date.now() + 60_000)
```

---

## Known Risks

| Risk | Mitigation |
|---|---|
| Alarm fires twice (at-least-once) | `WHERE flushed = 0` ensures idempotent flush |
| Alarm fires during message handler | Alarm is queued, runs after handler returns |
| DO storage > 1GB | Alarm flush keeps buffer at ~10 rows; `device_state` is tiny |
| D1 unavailable during alarm flush | Alarm will retry on next cycle; DO-local buffer accumulates until D1 recovers |
| Deploy disconnects all WebSockets | ESP32 auto-reconnects (5s interval); dashboard reconnects in JS |
| Half-open WebSocket after deploy | ESP32 firmware watchdog (30s no inbound → reconnect); DO health check (alarm verifies telemetry arrival) |

---

## Cloudflare API as Agent Control Plane

The FunConnect API token grants access to the entire Cloudflare surface. An AI agent can inspect the pipeline at every layer with a single credential:

```
GET  /accounts/.../workers/scripts    → deployed Workers, bindings
GET  /accounts/.../d1/database        → D1 schema, row counts, storage
POST /accounts/.../graphql            → quota usage, request counts
PUT  /accounts/.../workers/scripts    → deploy new code
```

Combined with the REST API (`/api/telemetry`, `/api/devices`, `/api/alerts`) and WebSocket broadcasts, an agent has complete visibility — firmware health via telemetry, edge state via DO-local SQLite, data history via D1, deployment status via Cloudflare API, billing via GraphQL. One token, one surface, no dashboard required.

---

## ESP-Claw — Hierarchical Intelligence

The ESP32 is too constrained for an LLM, but can run a classifier — a finite state machine that handles:

| Connected (Cloud Agent available) | Disconnected (Isolated Soldier) |
|---|---|
| Relay mode — forward telemetry | Emergency reflexes — threshold enforcement |
| Execute commands from DO | "Server is down" status reporting |
| Stream buffered data on reconnect | Local data buffering |

The cloud agent (GreenyAgent DO + Workers AI) handles heavy reasoning, history queries, calibration guidance, and user communication. The ESP32 handles sub-millisecond reflexes and survives disconnections gracefully. Together they form a hierarchy — fast/dumb at the edge, slow/smart in the cloud. Both speak WSS+JSON on the same API surface.

---

## Deploy Topology

---

## Deploy Topology

| Resource | Name | Notes |
|---|---|---|
| Worker | `iot-hub` | Existing name kept for continuity |
| DO namespace | `DEVICE_HUB` → `DeviceHub` | SQLite-backed (`new_sqlite_classes`) |
| D1 database | `greeny-db` | Created in Phase 2 |
| Domain | `cyberpi.trade` | A-record 192.0.2.1 proxied, route `cyberpi.trade/*` |
| workers.dev | `iot-hub.funconnect.workers.dev` | Fallback |
| API token | FunConnect | Full scope (Workers, DO, D1, KV, R2, Routes, DNS) |
