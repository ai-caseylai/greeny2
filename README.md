# IoT Hub — Edge-Native Agent Pipeline Prototype

ESP32-WROOM-32E → Cloudflare Worker → Durable Object (WebSocket Hibernation) → Dashboard + AI Agent API.

No MQTT. No EMQX. One protocol (WSS + JSON), one API surface, every consumer — browser, CLI script, future AI agent — speaks the same language.

## Reproduction from scratch

A step-by-step guide an AI agent or human can follow to reproduce this entire project on new hardware and a new Cloudflare account.

### Prerequisites

- ESP32-WROOM-32E (or any ESP32 dev board — 16MB flash, CH340 or CP2102 USB bridge)
- Arduino CLI 1.5+ with ESP32 board package 3.3+
- Node.js 22+ (for native WebSocket, toggle script)
- Python 3.10+ with matplotlib + numpy (for graphing)
- Git
- Cloudflare account with Workers Free plan + a domain (or workers.dev subdomain)

### Cloudflare API token scopes

Create at `dash.cloudflare.com` → API Tokens → Create Custom Token:

| Permission | Level |
|---|---|
| Account — Workers Scripts | Edit |
| Account — D1 | Edit |
| Account — Workers KV Storage | Edit |
| Account — Account Analytics | Read |
| Account — Account Settings | Read |
| Zone — Workers Routes | Edit |
| Zone — DNS | Edit |

(Workers Scripts — Edit also covers Durable Objects. No separate DO permission exists.)

### Arduino libraries

```bash
arduino-cli lib install WebSockets@2.7.2    # Links2004/arduinoWebSockets
arduino-cli lib install ArduinoJson@7.4.3   # bblanchon/ArduinoJson
```

### Wire protocol (WSS + JSON)

Every consumer — ESP32, browser, CLI script, AI agent — sends and receives the same JSON messages over WSS.

**ESP32 → DO:**
```json
{"type":"ping","seq":1}
{"type":"ack","command":"set_led","status":"ok","led":true,"esp32_ms":452381}
```

**DO → ESP32:**
```json
{"type":"pong","seq":1,"echo":"[DO] received ping seq=1"}
{"command":"set_led","params":{"state":true}}
{"type":"sync","led":false,"doTs":1782826120386}
```

**Browser/CLI → DO:**
```json
{"command":"set_led","state":true,"ts":1719000000000}
```

**DO → all browsers/CLI (broadcast):**
```json
{"type":"state","led":true,"connected":true,"doTs":1719000000450}
```

### 1. Deploy the Worker + DO

```bash
# Install wrangler + esbuild
cd iot-hub
npm install

# Bundle TypeScript → JavaScript
npx esbuild src/index.ts --bundle --format=esm \
  --outfile=src/index.mjs --external:cloudflare:workers

# Option A: wrangler deploy (if wrangler works on your machine)
set CLOUDFLARE_API_TOKEN=<your-token>
set WRANGLER_HOME=%CD%\.wrangler     # Windows workaround for junction permission
wrangler deploy

# Option B: Cloudflare API multipart upload (if wrangler has permission issues)
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/iot-hub" \
  -H "Authorization: Bearer <TOKEN>" \
  -F 'metadata={"main_module":"index.mjs","compatibility_date":"2025-12-01","compatibility_flags":["nodejs_compat"],"bindings":[{"name":"DEVICE_HUB","type":"durable_object_namespace","class_name":"DeviceHub"}],"migrations":{"tag":"v1","new_sqlite_classes":["DeviceHub"]}};type=application/json' \
  -F 'index.mjs=@src/index.mjs;type=application/javascript+module'
```

### 2. Bind a route to your domain

```bash
# A-record (proxied) so the domain resolves through Cloudflare
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"type":"A","name":"your-domain.com","content":"192.0.2.1","ttl":1,"proxied":true}'

# Worker route — catch all traffic
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/workers/routes" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"pattern":"your-domain.com/*","script":"iot-hub"}'
```

Or enable the workers.dev subdomain:
```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/scripts/iot-hub/subdomain" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"enabled":true}'
```

The Worker then serves at `iot-hub.<subdomain>.workers.dev`.

### 3. Flash the ESP32

Edit `WIFI_SSID`, `WIFI_PASS`, and `WS_HOST` in `esp32-sketch/esp32-sketch.ino`, then:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 esp32-sketch
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COM3 esp32-sketch
arduino-cli monitor -p COM3 -c baudrate=115200
```

The ESP32 boots → connects Wi-Fi → syncs NTP → opens WSS to the DO → sends ping every 10s.

### 4. Verify

```bash
# Health check
curl https://your-domain.com/health
# → {"status":"ok"}

# Dashboard
open https://your-domain.com/
# → LED control page, shows "Connected" if ESP32 is online
```

### 5. Run overnight toggle test

```bash
node iot-hub/toggle-led.mjs
# Ctrl+C to stop
node iot-hub/toggle-led.mjs --stats
python iot-hub/graph-results.py   # saves chart to Desktop
```

## Architecture

```
ESP32 ──WSS──▶ Worker ──▶ Durable Object (per-device, hibernation)
  │                │              │
  │ ping/pong      │ route by     │ ledState, connected
  │ LED control    │ device ID    │ SQLite storage
  │ telemetry      │ dashboard    │ broadcast to all consumers
                   │              │
Browser ──WSS──▶   │              │
CLI script ──WSS─▶ │              │
AI agent ──WSS──▶  │              │
```

### Why no MQTT / EMQX

MQTT is a protocol for moving bytes between machines. For a system where an AI agent is the first-class consumer, you don't need a message broker — you need a programmable, queryable state machine at the edge. The Durable Object is that state machine.

- **Single protocol**: WSS + JSON. Every device, every dashboard, every script, every agent.
- **Single API surface**: The DO's HTTP endpoint + WSS pub/sub. One token, one domain.
- **Agent-native**: The AI agent queries the DO for state, sends commands through the DO, and monitors via `wrangler tail` — all through the same Cloudflare API token.

## Key design decisions

### WebSocket Hibernation — zero idle cost

The DO uses `ctx.acceptWebSocket()` (not `server.accept()`). Between messages, the DO hibernates — zero CPU billing. A WebSocket connection stays alive at Cloudflare's edge with no JavaScript running. When the ESP32 sends a message, the DO wakes, processes (~5ms), and hibernates again.

**Overnight test (13 hours, 687 toggles):** ~700 requests billed, ~85 seconds duration. < 2% of free tier.

### Constructor must be zero-I/O

The DO constructor runs on every wake (hibernation and cold start). Ours does only `deserializeAttachment()` — pure CPU, no storage reads, no network calls. This keeps cold starts under 500ms even after hours of idle.

### SerializeAttachment for per-connection state

Class fields (`this.ledState`) are lost on every hibernation wake. Only `ws.serializeAttachment()` and `ctx.storage` (SQLite) survive. Attachments are limited to 16 KB — use for device ID, role, timestamps. Use SQLite for durable state (LED state, telemetry history).

### Every deploy disconnects all WebSockets

`wrangler deploy` restarts the DO, disconnecting all clients. The ESP32 sketch uses the library's `setReconnectInterval(5000)` for automatic recovery. The dashboard and CLI script reconnect on `onclose`.

## Problems encountered and solved

### 1. ESP32 TLS handshake fails silently

**Symptom:** `[WS-Client] connect wss...` then nothing. No error message.

**Root cause:** ESP32 has no battery-backed RTC. After power-on, the clock reads January 1, 1970. TLS certificate validation fails because every cert appears expired.

**Solution:** Call `configTime()` with NTP servers, block until `time(nullptr) > 8*3600*2` (16 hours past epoch). Only then attempt WSS.

### 2. Certificate bundle: which CA does Cloudflare use?

**Symptom:** `certificate verify failed` even after NTP sync.

**Root cause:** `beginSSL()` uses a single fingerprint. `beginSslWithCA()` needs a PEM cert file. Neither works for Cloudflare's multi-CA edge (Let's Encrypt, Google Trust Services, DigiCert).

**Solution:** `beginSslWithBundle(host, port, path, NULL, 0, "")` with `NULL, 0` — uses ESP32's built-in 77 KB CA bundle. All Cloudflare edge CAs are included. No PEM embedding needed.

### 3. wrangler filesystem permission error on Windows

**Symptom:** `A permission error occurred while accessing the file system. Affected path: C:\Users\...\Application Data`

**Root cause:** Legacy Windows junction `Application Data` has `Everyone:(DENY)(RD)`.

**Solution A:** `icacls "C:\Users\<user>\Application Data" /grant Everyone:R` (needs admin).  
**Solution B:** `WRANGLER_HOME=%CD%\.wrangler` — keeps wrangler in the project directory.  
**Solution C:** Deploy via Cloudflare API multipart upload (used for this project).

### 4. DO class not recognized after deploy

**Symptom:** `Cannot apply new-class migration to class 'DeviceHub' that is not exported by script.`

**Root cause:** esbuild tree-shakes unused exports. The Worker imports `DeviceHub` but doesn't re-export it. Cloudflare requires DO classes to be exported from the main module.

**Solution:** Add `export { DeviceHub }` to the Worker's `index.ts`.

### 5. Serial monitor blocks COM port for other tools

**Symptom:** `Port monitor error: command 'open' failed: Serial port busy`

**Root cause:** `arduino-cli monitor` holds the COM port exclusively. Only one reader at a time.

**Solution:** Kill the monitor job before uploading or running another monitor. ESP32 WSS communication uses Wi-Fi, not the COM port — serial is debug-only.

### 6. RTT measurement inflation

**Symptom:** Script logs RTT = 1200-1400ms but actual click-to-LED is 500-600ms.

**Root cause:** RTT measures DO timestamp → script receipt (one leg). The DO's single-threaded event loop and `ctx.storage.put()` microtask scheduling add latency between the ESP32 ack and the broadcast. This is DO scheduling overhead, not network latency.

**Real measurement:** `digitalWrite()` → ack = 2ms on ESP32. Full round-trip: ~500ms from browser click to LED change (human-verified and serial-confirmed).

## File structure

```
C:\Projects\Prototype\
├── esp32-sketch/
│   └── esp32-sketch.ino      # Arduino sketch: WSS client, LED control, ping/pong
├── iot-hub/
│   ├── src/
│   │   ├── index.ts           # Cloudflare Worker: routes, dashboard HTML
│   │   ├── index.mjs          # Bundled ES module (esbuild output)
│   │   └── device-hub.ts      # Durable Object class: state, commands, broadcast
│   ├── toggle-led.mjs         # Node.js random LED toggler (overnight testing)
│   ├── graph-results.py       # Python: reads toggle-log.jsonl, produces charts
│   ├── package.json
│   └── wrangler.jsonc         # Wrangler config: DO binding + SQLite migration
├── aiot-control/              # Legacy MQTT firmware (archived)
└── ProjectFunConnect/         # Legacy firmware build outputs (archived)
```

## How to use

### 1. Deploy the Worker + DO

```bash
cd iot-hub
set CLOUDFLARE_API_TOKEN=<FunConnect token>
npx esbuild src/index.ts --bundle --format=esm --outfile=src/index.mjs --external:cloudflare:workers
# Then upload via Cloudflare API multipart, or:
set WRANGLER_HOME=%CD%\.wrangler
wrangler deploy
```

### 2. Flash the ESP32

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 esp32-sketch
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COM3 esp32-sketch
```

Edit `WIFI_SSID` and `WIFI_PASS` in the sketch before compiling.

### 3. Open the dashboard

```
https://iot-hub.funconnect.workers.dev/
```

Buttons toggle the ESP32 LED. Latency displayed. Connection status live.

### 4. Run random toggle test

```bash
node iot-hub/toggle-led.mjs
# Ctrl+C to stop
node iot-hub/toggle-led.mjs --stats   # distribution charts
```

### 5. Watch logs

```bash
set WRANGLER_HOME=%CD%\.wrangler
wrangler tail iot-hub --format pretty
```

### 6. Check quota

```bash
curl -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer <token>" \
  -d '{"query":"{ viewer { accounts(filter: {accountTag: \"...\"}) { workersInvocationsAdaptive(...) { sum { requests duration } } } } }"}'
```

## Quota safety

| Operation | Cost | Free tier limit |
|---|---|---|
| WebSocket message (incoming) | 1/20 request | 100K req/day |
| DO duration (handler CPU) | GB-s | 313K GB-s/day |
| DO storage (SQLite) | GB-month | 5 GB total |
| SQLite row write | 1 write | 100K writes/day |

One ESP32 at 1 ping/10s + occasional commands = ~2% of free tier per day.

## Overnight test data

13 hours, 687 toggles:
- **RTT:** P50=577ms, P90=870ms, P99=1459ms (no very-cold spikes > 2s)
- **Duration:** 50% in 10s-1m bursts, 9% in 5-30m idle gaps
- **Reliability:** 0 failures, 1 disconnect/reconnect (5 seconds)
- **Quota:** Negligible (< 700 WS messages after 20:1 ratio)

## Operating philosophy

1. **DO is the canonical state.** The real state lives in the Durable Object, not the device. Every consumer reads from the DO, never from the device directly.
2. **WSS + JSON is the universal protocol.** Every consumer speaks it. No adapters.
3. **Hibernation is non-negotiable.** `ctx.acceptWebSocket()`, zero-I/O constructor, no pending promises.
4. **The Cloudflare API is the agent's control plane.** Workers, DO, D1, DNS, routes, analytics — one token.
5. **Measure, don't assume.** Overnight tests, serial timestamps, `wrangler tail`, GraphQL analytics.
