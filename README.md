# Greeny Alpha — IoT + Cloudflare Edge Pipeline

**Live demo:** [greeie-spa.funconnect.workers.dev](https://greeie-spa.funconnect.workers.dev) (React SPA) · [iot-hub.funconnect.workers.dev](https://iot-hub.funconnect.workers.dev) (Worker + API)  
**AI agent:** `POST /api/chat` — asks "how are the plants?" and gets a real answer from live sensor data  
**Desktop agent:** Abu skill at `greeny-alpha/SKILL.md` — same API surface, same data

ESP32-WROOM-32E → Cloudflare Worker → Durable Object (WebSocket Hibernation + SQLite) → D1 → Dashboard + REST API + AI Agent. No MQTT. No EMQX. One protocol (WSS + JSON). Three consumers (browser, AI agent, Abu Desktop) speak the same language.

**Sensors live right now:** pH 7–8 (two-point calibrated), EC ~200 µS/cm / TDS ~100 ppm (calibrated against reference meter), Temp 21°C (DS18B20). 24,000+ telemetry rows in D1. Calibration survives replugs. WiFi configurable from the dashboard (scan, select, connect). WebSocket watchdog self-heals after Cloudflare deploys.

## What We Learned — Every Agent's Experience

### Agent Alpha (Architecture)
The two-tier storage model is the single most important decision. DO-local SQLite on the hot path — synchronous, same-thread, microsecond latency, zero `await` calls. D1 only in the alarm handler. The DO hibernates ~9.9 seconds out of every 10-second cycle. Casey's GREENY calls D1 on every telemetry (4-6 round trips), blocking hibernation. Our architecture doesn't. The WebSocket broadcast already reaches every consumer — the AI agent, the dashboard, Abu — all three see the same `{type:"state"}` message. No extra API calls, no polling, no quota burn. The relay queue pattern from GREENY moved from D1 to DO-local SQLite for zero-latency command delivery. Commands survive disconnections. The agent lives inside the pipeline, not beside it — same thread, same SQLite, same protocol. Watching is free. Reasoning costs tokens only when a user speaks.

### Agent Edge (Backend + DO)
The hibernation bug was the hardest thing to find. After every deploy, the DO constructor restored WebSocket connections from `ctx.getWebSockets()` + `deserializeAttachment()` — but `this.esp32ws` was null during the reconnect window, and dashboard commands silently dropped. The fix: queue commands regardless of connection state, drain on next telemetry. Calibrate commands can never queue — they're context-dependent (probe position matters). Replaying `CAL:PH:4` after a reboot when the probe is now in pH 9.18 buffer corrupts the calibration. QoS 0 for calibrate, QoS 1 for set_led. The D1 rows-read crisis came from an unbounded `telemetry_buffer WHERE flushed=1` scan in the alarm handler — without cleanup, a week of data would produce 86M rows read/day. DELETE old flushed rows after each alarm cycle, keep only the last 100. JWT expiry (24h), CORS headers, alert deduplication, Casey protocol compat layer — all ~20 lines each, all critical. The Worker's auth middleware blocked browser WebSocket connections because browsers can't set `Authorization` headers on WebSocket upgrades — token must come via `?token=` query param.

### Agent Firmware (ESP32)
The off-brand TDS board nearly broke us. It outputs voltage that DROPS with conductivity — inverted from every DFRobot spec. The standard cubic formula gave negative readings. It also needed 5V to drive analog output despite the datasheet saying 3.3–5.5V. The board worked on the pH pin row (5V column) but three different TDS GPIO pins (36, 34, 35) all read 0 at 3.3V. Fix: move to 5V column, flip formula to `(ecOffset - ecRaw)`, hardcode calibrated pair (kValue=0.088, ecOffset=201). The EEPROM validation bug was the stealth killer: `loadCalibration()` validated ecOffset to ±1000 but the board needed ~2275. Every boot reset it to 0. Worse, `EEPROM.get()` overwrites the variable BEFORE the validation check — hardcoded defaults got clobbered. The saved-pattern fix (save before read, restore if invalid) applied to all four calibration values. Nernst equation sign depends on the amplifier — many boards invert it. Default slope of 0.059 V/pH is wrong for amplified electrodes — ours needs ~0.164 V/pH. Two-point calibration is mandatory. Serial calibration doesn't work — CH340 auto-reset on port open. All calibration must go through WSS.

### Agent AI (Cloudflare Agent + Workers AI)
The architecture is self-reinforcing but the model is the bottleneck. Llama 3.2 3B is the only model available on this free-tier account — it can't do native function calling, hallucinates conversation continuations, and generates fake user messages. We built a multi-model router with fallback, a native function-calling loop, and a meta self-awareness path — all ready but gated on model availability. The pre-fetch pattern works: regex intent matching → fetch relevant data from DO-local SQLite → embed in prompt → let model interpret. But it's a puppet theater — the model never decides anything, it just wordsmiths. The calibration state machine tracks multi-step pH calibration in `ctx.storage.sql` and survives DO evictions. The domain knowledge is embedded and working — the model correctly diagnoses disconnected probes (pH=-10), temperature physics (EC rising 2%/°C), and persistent alerts. Watching is free, AI inference is metered — correct cost model. The 10,000 neurons/day free tier is generous for simple queries but the real value (function calling, planning) awaits capable models.

### Agent Beauty (React Dashboard)
Forked Casey's GREENY React SPA and adapted it to our backend. Replaced Recharts (340KB) with raw SVG sparklines. Stripped racks, crops, spectral/NDVI, 4-channel relay, i18n, WhatsApp — everything our hardware doesn't have. Kept every color hex, border-radius, shadow, spacing, and font from Casey's design system. The WebSocket data pipeline was the trickiest part — the DO broadcasts `{type:"state"}` with flat fields but Casey's code expected `{type:"telemetry_update"}` with nested `data.*`. Added a `normalizeReading()` adapter. The chart drain bug: WebSocket entries replaced HTTP-seeded entries but field names didn't match (`water_temp` vs `temp`, `ts_ms` vs `do_ms`) — useMemo merge at render time fixed it. Bundle size: 384KB JS (down from 1.9MB). Added WiFi settings page (scan, select, connect), toast notifications, animated KPI cards, trend arrows, GaugeCard abnormal pulse, sparkline hover tooltips, and persistent thresholds via localStorage.

### Half-Open WebSocket — The Pattern
Every Cloudflare deploy drops WebSocket connections. The ESP32 reconnects within 5 seconds and telemetry resumes — but the outgoing path (DO→ESP32) silently breaks while the incoming path (ESP32→DO) works. Commands appear to be forwarded but never arrive. The DO broadcasts `conn=true` because telemetry flows. Dashboards show live data. Everything looks healthy. The fix required two independent watchdogs: the ESP32 tracks `lastInboundMs` and reconnects if 30 seconds pass with no data from the DO. The DO verifies telemetry arrival in the alarm handler. Two sides, same problem, independent detection.

### WiFi Manager via WSS
Dashboard scans nearby networks, user picks one, enters password, ESP32 switches. No captive portal, no physical button, no recompile. Credentials saved to EEPROM. Falls back to compiled defaults on failure. 2.4GHz only — ESP32 hardware limitation auto-filtered by the scan list. The `wifi_ack` response is lost during the WiFi disconnect window, so the UI verifies success by watching for telemetry resumption rather than waiting for the ack.

### ESP-Claw — Hierarchical Intelligence
The ESP32 is too constrained for an LLM, but can run a classifier — a finite state machine. When connected, it relays telemetry and executes cloud agent commands. When disconnected (deploy, network outage), it becomes an isolated soldier: "I can't reach the server. Still monitoring. pH 5.2 stable. Temp 23°C. Buffering every reading." The cloud agent (GreenyAgent DO + Workers AI) handles heavy reasoning, history, calibration. The ESP32 handles sub-millisecond reflexes. Both speak WSS+JSON on the same surface. Fast/dumb at the edge, slow/smart in the cloud.

## Full Postmortems & Architecture Docs
[Project-wide details](README.md#architecture) · [Firmware deep-dive](firmware/POSTMORTEM.md) · [AI agent deep-dive](edge/AI-POSTMORTEM.md) · [System design](ARCHITECTURE.md) · [Wire protocol](PROTOCOL.md)

---

## Architecture

```
ESP32 (#2 Sensor Hub) ──WSS──▶ Cloudflare Worker (iot-hub)
  │  pH (GPIO 39), TDS (GPIO 35), Temp (GPIO 13), LED (GPIO 2)
  │
  ├── DeviceHub DO (per-device, hibernation, SQLite-backed)
  │   ├── Hot path: ctx.storage.sql.exec() — synchronous, µs latency
  │   │   ├── telemetry_buffer (INSERT on each message)
  │   │   ├── relay_queue (SELECT/DELETE for commands)
  │   │   ├── alert_buffer (INSERT on threshold breach)
  │   │   └── device_state (key-value for LED, calibration state)
  │   │
  │   ├── Alarm (every 60s): batch flush DO-local SQLite → D1
  │   └── Broadcast: {type:"state"} to all dashboard WebSockets
  │
  ├── GreenyAgent DO (Agents SDK + Workers AI)
  │   ├── Reads ctx.storage.sql on same thread (zero quota)
  │   ├── 5 tools: query_telemetry, check_alerts, toggle_led, get_history, calibrate
  │   └── POST /api/chat → streaming response
  │
  ├── D1 (greeny-db) — cold path, historical queries
  │   ├── telemetry (17,000+ rows and growing)
  │   ├── alerts (3,300+ rows)
  │   ├── devices (registry + status)
  │   ├── relay_log (audit trail)
  │   ├── users (auth)
  │   └── settings (key-value config)
  │
  ├── REST API (JWT-auth via HS256 Web Crypto)
  │   ├── POST /api/auth/login
  │   ├── GET /api/telemetry, /api/devices, /api/alerts
  │   ├── POST /api/relay (LED toggle, Casey protocol compat)
  │   └── POST /api/chat (AI agent)
  │
  └── Dashboard (two surfaces)
      ├── greeie-spa.funconnect.workers.dev — React SPA (forked from Casey's GREENY)
      └── iot-hub.funconnect.workers.dev — inline HTML (legacy)
```

**Two-tier storage — the central idea:**

| Tier | Where | Latency | Blocks hibernation? | Queryable by REST? |
|---|---|---|---|---|
| Hot path | DO-local SQLite (`ctx.storage.sql`) | Microseconds (same thread) | No — synchronous, no `await` | No (private to DO) |
| Cold path | D1 (`env.DB`) | 10–50ms (network) | Yes — `await` prevents hibernation | Yes |

The DO hibernates between telemetry messages. `webSocketMessage()` contains zero `await` calls — all storage is synchronous `ctx.storage.sql.exec()`. D1 is only touched in the alarm handler. This is the architectural insight that makes the pipeline viable at scale: Casey's GREENY calls D1 on every telemetry (4-6 round trips per message), blocking hibernation and burning quota. Our DO hibernates ~9.9 seconds out of every 10-second cycle. Verified: overnight benchmark (687 toggles, 0 failures, P50=577ms RTT).

---

## Hardware

### ESP32 #2 — Sensor Hub (Deployed)
- **Chip:** ESP32-D0WD-V3 rev v3.1, MAC `b0:cb:d8:c2:35:90`, 4MB flash
- **USB:** CH340 on COM3, 115200 baud
- **Sketch:** `firmware/esp32/esp32.ino` — unified (was two separate sketches, consolidated)
- **Pins:** LED=GPIO 2, DS18B20=GPIO 13, TDS=GPIO 35, pH=GPIO 39, OLED=GPIO 21/22
- **WiFi:** 2.4GHz — credentials in `wifi.env` (not committed)

### ESP32 #1 — LED Controller (Not connected)
- **Chip:** ESP32-D0WD-V3 rev v3.0, MAC `c0:49:ef:b4:79:6c`, 16MB flash
- **Sketch:** Available at `firmware/esp32-led/`

---

## Sensor Calibration

### EC/TDS — Inverted Board (Off-Brand)

**The problem:** Our replacement TDS board outputs voltage that DROPS with conductivity, opposite of the DFRobot SEN0244 spec (voltage RISES). The standard cubic formula produced negative readings in tap water and near-zero readings in distilled.

**What failed (6 attempts):**
1. CAL:EC:0 commands were silently dropped — QoS 0 for calibrate, ESP32 reconnecting after each flash
2. `loadCalibration()` validation range was ±1000 — our board needs ecOffset ~2275. Every boot reset it to 0
3. `EEPROM.get()` overwrites the variable BEFORE validation — hardcoded defaults were clobbered
4. CAL:EC:VALUE formula divides by `ecRawCubic` (the cubic polynomial), which is near-zero for inverted boards in tap water — kValue exploded to huge values, producing EC=-36,000
5. kValue validation minimum was 0.1 — our computed 0.094 was rejected and reset to 1.0
6. Repeated calibrate commands during reconnect windows corrupted EEPROM with partial two-point state

**What worked:** The saved-pattern for loadCalibration (save value before EEPROM read, restore if invalid), extended validation ranges (ecOffset up to 5000, kValue down to 0.001), flipped formula `(ecOffset - ecRaw)` for inverted output, and hardcoded calibration pair (kValue=0.088, ecOffset=201) forced in setup() with EEPROM write. The board needed 5V to drive analog output — 3V3 was insufficient.

**Lessons learned:**
- Off-brand sensor boards can invert the voltage-conductivity relationship. Verify with a multimeter.
- `EEPROM.get()` is destructive — it overwrites the variable before you can validate
- Calibration commands MUST be idempotent and replay-safe, or use QoS 0 (no queue)
- The cubic polynomial breaks down for inverted boards at low voltages — a linear approximation may be better
- Never calibrate against an unknown reference (bottled water ≠ distilled)

### pH — Two-Point Calibration

**Working:** pH 4.00 and 9.18 buffers used for two-point calibration. Slope and offset stored in EEPROM (addresses 24, 28, 32). Single-point also supported via CAL:PH:4, CAL:PH:7, CAL:PH:9. Slope validated to 0.010–0.300 V/pH.

**Issues:** The old pH amplifier board powered on (green LED) but analog output was dead — 0V on the signal pin regardless of probe position. Replacement board fixed it. pH probes need 30-60 minutes of soaking after dry storage to rehydrate the glass bulb and reference junction.

### Temperature (DS18B20)
Waterproof probe on GPIO 13. OneWire + DallasTemperature library. ±0.5°C factory accuracy. Working flawlessly throughout.

---

## Command Forwarding — The Hibernation Bug

**The bug:** Every Cloudflare Worker deploy restarts all DO instances, dropping WebSocket connections. The ESP32 reconnects within 5 seconds, but there's a window where `this.esp32ws` is null. During this window, the old code silently dropped dashboard commands:

```
dashboard → DO → "ESP32 not connected? Discard." → command lost forever
```

**The fix:** Commands are always queued in `relay_queue` (DO-local SQLite). `drainRelayQueue` runs on every telemetry and ping — it finds queued commands and forwards them when the ESP32 reconnects. This is Casey's relay queue pattern from GREENY, moved from D1 to DO-local SQLite for zero latency.

**Additional fix:** On ESP32 reconnect, the relay queue is purged for that device. Calibration commands are context-dependent (probe position matters) — replaying a CAL:PH:4 command after a reboot when the probe is now in pH 9.18 buffer corrupts the calibration. Calibrate commands are QoS 0 (direct forward, never queued). Set_led commands are QoS 1 (queued, replayed safely).

---

## Alert Deduplication

Without deduplication, a persistent condition (pH=34.95 from disconnected probe) generates one alert per telemetry message — 43 identical alerts in 7 minutes, flooding D1.

**Fix:** Before inserting into `alert_buffer`, check if an unflushed alert of same type+device already exists. If so, skip. Reduces alert rate from 1 per 10s telemetry to 1 per 60s alarm flush — still fires while condition persists, but at 1/6 the rate.

---

## Quota Safety

| Resource | Used (typical day) | Free limit | % |
|---|---|---|---|
| DO Requests | ~1,800 | 100,000/day | 1.8% |
| DO Duration | ~550s (70 GB-s) | 13,000 GB-s/day | 0.5% |
| D1 Rows Read | Varies with history queries | 5M/day | <5% |
| D1 Rows Written | ~1,500/day (alarm flush) | 100,000/day | 1.5% |
| D1 Storage | ~2 MB | 5 GB | <0.1% |
| Workers AI | ~50 neurons/interaction | 10,000/day | <5% |

**The rows-read crisis:** An earlier version caused D1 rows-read to spike toward 90% of quota. Root cause: the `devices.last_seen` query in the alarm handler scanned ALL rows in `telemetry_buffer WHERE flushed=1` — a table that grew unbounded. Without cleanup, a week of data would produce 60K rows × 1,440 alarm cycles = 86M rows read/day. **Fix:** DELETE old flushed rows after each alarm cycle, keeping only the last 100 for the `last_seen` query.

---

## AI Agent — Architectural Insight

The agent lives INSIDE the DO, not beside it. It reads `ctx.storage.sql` on the same thread — microsecond latency, zero quota, zero network hops. It only calls Workers AI when a user sends a message. Watching is free.

**System prompt philosophy:** The agent doesn't just report numbers. It knows failure signatures — pH=-10 means probe disconnected, not acid spill. EC rising 2%/°C is physics, not a problem. Warm tone, plant-focused language, translates sensor data into care instructions.

**Calibration state machine:** Tracks multi-step physical workflows in `ctx.storage.sql`. Walk user through 2-point pH calibration: "put probe in pH 7.0 buffer, say ready" → records → "rinse, put in pH 4.0, say ready" → computes slope and offset → grades probe health. Same pattern unlocks nutrient dosing, reservoir flushes, sensor maintenance.

**Abu Desktop integration:** Skill file at `C:\Users\sacl2\AppData\Local\Abu\builtin-skills\greeny-alpha\SKILL.md`. Six tools mapped to REST endpoints: check plants, get history, view alerts, LED on/off, device status, health check. Uses hardcoded JWT for auth.

---

## Key Design Decisions

1. **Per-device DO scope.** Casey uses per-office DO (one DO for all devices in an office). We use per-device (`idFromName("esp32-sensor")`). This isolates failures — one noisy device can't block others. For single-user deployment, this is correct. For multi-tenant, Casey's per-office scope is more efficient.

2. **Inline HTML → React SPA.** The original prototype used a 400-line inline HTML string inside the Worker — zero build step, single deploy. The React SPA (forked from Casey's GREENY) replaced it for the demo. The inline dashboard still exists as fallback. The REST API supports both.

3. **Bundled Worker over Pages Functions.** Casey splits WebSocket (Worker) from REST API (Pages Functions). We consolidated into one Worker — simpler deployment, fewer moving parts. Appropriate for single-user scale.

4. **Casey protocol compat layer.** The backend accepts both our native message format (`{command:"set_led", state:true}`) and Casey's (`{type:"relay", relay1:1}`). The DO broadcasts both `{type:"state"}` (our format) and `{type:"telemetry_update"}` (Casey's format). This allowed the React fork to work with minimal changes.

5. **Arduino over ESP-IDF.** Casey's firmware is ESP-IDF in C with OLED driver, WiFi Manager, and median filtering. We use Arduino — simpler toolchain, faster iteration, one-liner compile/upload. Tradeoff: less sophisticated filtering, no WiFi Manager.

---

## File Map

```
C:\Projects\Prototype\
├── ARCHITECTURE.md            # System architecture (Agent Alpha)
├── PROTOCOL.md                # Wire contract (all agents)
├── README.md                  # This file
├── firmware/                  # Agent Firmware domain
│   ├── FIRMWARE.md            # Firmware module spec
│   └── esp32/
│       └── esp32.ino          # Unified sketch (pH + TDS + temp + LED + OLED)
├── edge/                      # Agent Edge domain
│   ├── EDGE.md                # Edge module spec
│   ├── DASHBOARD.md           # Dashboard spec
│   ├── src/
│   │   ├── index.ts           # Worker: routes, dashboard HTML, REST API
│   │   ├── device-hub.ts      # DeviceHub DO: hot path, alarm, broadcast, relay
│   │   ├── agent.ts           # GreenyAgent DO: AI chat, calibration state machine
│   │   └── index.mjs          # Bundled ES module (esbuild output)
│   ├── db/
│   │   └── schema.sql         # D1 schema
│   ├── wrangler.jsonc
│   └── package.json
├── tools/                     # Shared utilities
│   ├── toggle-led.mjs         # Random LED toggler (overnight testing)
│   ├── graph-results.py       # Python chart generator
│   └── send-cal.py            # Serial calibration bridge (DEPRECATED)
├── aiot-control/              # Legacy MQTT firmware (archived)
└── ProjectFunConnect/         # Legacy firmware build outputs (archived)
```

## Deploy

```bash
# 1. Bundle Worker
cd edge
npx esbuild src/index.ts --bundle --format=esm --outfile=src/index.mjs --external:cloudflare:workers

# 2. Deploy Worker + DO + D1 (API multipart — wrangler has Windows junction issues)
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/758cece0f853404f97b17f0ff86b5190/workers/scripts/iot-hub" \
  -H "Authorization: Bearer <FunConnect token>" \
  -F 'metadata={"main_module":"index.mjs","compatibility_date":"2025-12-01","compatibility_flags":["nodejs_compat"],"bindings":[...]};type=application/json' \
  -F 'index.mjs=@src/index.mjs;type=application/javascript+module'

# 3. Flash ESP32
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32
esptool --chip esp32 --port COM3 --baud 921600 write-flash 0x10000 <build-path>/esp32.ino.bin
```

## Non-Negotiables

- `ctx.acceptWebSocket(server)` — never `server.accept()`. The latter prevents hibernation entirely.
- Zero `await` calls in `webSocketMessage()`. All hot-path storage is synchronous `ctx.storage.sql.exec()`.
- Constructor restores WebSocket connections from `ctx.getWebSockets().forEach()` + `deserializeAttachment()`. Must be zero-I/O.
- `finally { setAlarm }` — always reschedule, even on failure. Without this, 6 consecutive alarm failures permanently kill the alarm.
- Calibrate commands are QoS 0 (direct forward, never queued). set_led is QoS 1 (queued in relay_queue).
- All `loadCalibration()` values must use saved-pattern: save before `EEPROM.get()`, restore if invalid. Never trust EEPROM.
