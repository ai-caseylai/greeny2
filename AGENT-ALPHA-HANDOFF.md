# IoT Hub — Agent Alpha Handoff Document

**For:** My successor AI agent  
**Date:** July 2, 2026  
**Session context:** Extensive 2-day session building an IoT pipeline from scratch  
**Instructions:** Read this entire document before acting. It contains the user's vision, our collaboration history, everything that worked, everything that broke, and what remains unresolved.

---

## The User's Vision

The user is building a cyber-physical system for automated hydroponics/aquarium monitoring and control. The long-term vision:

1. **ESP32 sensors** (EC, pH, temperature, eventually motors, peristaltic pumps) stream data to Cloudflare's edge
2. **Durable Objects** receive telemetry, store state, run closed-loop control (threshold-based commands back to devices)
3. **AI agents** (future) monitor the pipeline, query device state, interact via the same WSS+JSON protocol
4. **No MQTT, no EMQX.** The entire pipeline is Cloudflare-native. One protocol, one API surface.
5. **Self-monitoring/self-healing** — the AI agent can query, diagnose, and intervene at any layer through the Cloudflare API

The user explicitly rejected:
- MQTT / EMQX as a broker (too limiting for AI agent access, another system to manage)
- HTTP polling (doesn't scale to thousands of devices with low latency)
- Complex dashboards (wants simple, functional, WebSocket-first)

The user values:
- **Hibernation safety** — terrified of DO quota burn. Every design decision considers cost.
- **Hardware honesty** — wants to understand limitations, not be sold solutions
- **Agent-accessible everything** — the AI should be able to query any primitive via the same token
- **Bounded error** — tracks sensor accuracy, calibration age, accumulated uncertainty

## Collaboration Style

The user is technically sophisticated (understands ESP32 hardware, Cloudflare architecture, physics of sensors) and directive. Key patterns:

- **"Don't do anything, just talk to me"** — wants thorough planning before execution. Use `submit_plan` or verbal discussion. Never jump to code without approval.
- **"Stop and just talk"** — requires explicit pauses. The user will re-steer if they disagree.
- **"Search the web"** — expects agents to research before answering. The user shared DFRobot documentation URLs and asked me to verify claims against data sheets.
- **"You are Agent Alpha"** — named me. Took this seriously. Wants the agent to remember its identity and role.
- **WiFi credentials are OK to extract** — the user allowed me to pull SSID/password from Windows `netsh wlan` commands. They'll also share credentials directly (phone hotspot).
- **"Comprehensive handoff"** — the user expects successors to pick up seamlessly. This document is their idea.
- **Pragmatic about calibration** — asked if bottled water could substitute for distilled (it can't), experimented with it anyway, accepted the failure, moved on. Not dogmatic.

The user is in Chengdu, Sichuan, China. Tap water is ~100-250 μS/cm (estimate, unverified). The phone hotspot is `Redmi 15 5G` / `alpha102938A!` (ESP32 couldn't connect — likely 5GHz). Home WiFi `MyWiFi` / `my-password` works at 2.4GHz.
- **Agent:** Agent Alpha
- **Role:** Higher-level architectural view, prototype smoke-testing, future AI agent coordination
- **Cloudflare API Token (FunConnect):** Active, all permissions (Workers Edit, D1 Edit, KV Edit, R2 Edit, Routes Edit, DNS Edit, Analytics Read)
- **Account:** Sacl2026@outlook.com's Account (`758cece0f853404f97b17f0ff86b5190`)
- **Zone:** `cyberpi.trade` (`5b853b891b613f488177657a4c9012a1`)

## Architecture
```
ESP32 ──WSS──▶ Cloudflare Worker ──▶ Durable Object (per-device, hibernation)
  │                │                       │
  │ telemetry      │ routes                │ canonical state
  │ LED control    │ dashboard HTML        │ SQLite storage
  │ calibration    │                       │ broadcast to all consumers
                   │                       │
Browser ──WSS──▶   │                       │
CLI script ──WSS─▶ │                       │
                          │
                   iot-hub.funconnect.workers.dev
                   cyberpi.trade (DNS A record proxied to 192.0.2.1, Worker route cyberpi.trade/*)
```

No MQTT. No EMQX. WebSocket + DO Hibernation is the universal protocol.

## Hardware

### ESP32 #1 — WROOM-32E (LED only)
- **Chip:** ESP32-D0WD-V3 revision v3.0, MAC `c0:49:ef:b4:79:6c`
- **USB bridge:** CH340, COM3 (115200 baud)
- **Flash:** 16MB
- **Status:** Working. Currently disconnected (user may reconnect). Runs WSS + LED ping/pong sketch.
- **Sketch:** `C:\Projects\Prototype\esp32-sketch\esp32-sketch.ino` — WSS to DO, LED on GPIO 2, ping/pong, set_led command

### ESP32 #2 — WROOM-32E (Sensor Hub)
- **Chip:** ESP32-D0WD-V3 revision v3.1, MAC `b0:cb:d8:c2:35:90`
- **USB bridge:** CH340, COM3 (same port — only one ESP32 at a time)
- **Flash:** 4MB
- **Original firmware:** GREENY (ESP-IDF v5.3.2 project `greeny-sensor`) — overridden with Arduino
- **Sensors attached:**
  - DFRobot SEN0244 TDS (Analog, on GPIO 36 — ADC1)
  - pH probe with amplifier board (on GPIO 39 — ADC1) — **POSSIBLY DISCONNECTED** (reads 34.95 = 3.3V = floating)
  - DS18B20 waterproof temp probe (OneWire on GPIO 13) — **WORKING** (addr `281C6543D45E6759`)
  - WS-001 display (not used in current sketch — screen stays dark)
- **WiFi:** Currently `MyWiFi` / `my-password` (2.4GHz). User wants `Redmi 15 5G` / `alpha102938A!` but ESP32 couldn't connect to phone hotspot (likely 5GHz or WiFi 6).
- **Sketch:** `C:\Projects\Prototype\esp32-sketch-sensor\esp32-sketch-sensor.ino`

## Sensor Details

### TDS/EC Sensor — DFRobot SEN0244
- **Product page:** https://wiki.dfrobot.com/sen0244/
- **Tutorial with code:** https://diyprojectslabs.com/arduino-tds-sensor-tutorial/
- **Library:** https://github.com/DFRobot/GravityTDS (LGPL-2.1, 2 commits, Arduino library)
- **Type:** Analog TDS sensor, 2-pin stainless waterproof probe
- **Signal board:** 3-pin (GND, VCC 3.3-5.5V, Analog Out 0-2.3V)
- **Range:** 0-1000 ppm TDS (~0-2000 μS/cm)
- **Accuracy:** ±10% F.S. (±100 ppm at 25°C)
- **Temperature sensor:** NONE built-in. Requires external DS18B20.
- **Conversion:** Cubic polynomial `ec = (133.42V³ - 255.86V² + 857.39V) × kValue`
- **Temperature compensation:** `ec25 = ec / (1.0 + 0.02 × (T - 25.0))`
- **TDS to EC:** `TDS = EC × 0.5` (industry standard conversion factor)
- **Connection:** GPIO 36 (ADC1 only — ADC2 is unusable with WiFi active)

### pH Sensor
- **Product:** Unspecified pH probe + amplifier board (likely DFRobot SEN0161 or similar)
- **Type:** Analog pH, 3-pin output (GND, VCC, Analog Out)
- **Expected output:** ~1.65V at pH 7.0 (midpoint), ~59mV per pH unit (Nernst slope)
- **Connection:** GPIO 39 (ADC1)
- **Current status:** **LIKELY DISCONNECTED** — reads 34.95 which = 3.3V = ADC pin floating at VCC
- **Required component:** Op-amp buffer board between probe and ESP32 (megaohm impedance matching)

### Temperature Sensor — DS18B20
- **Type:** Waterproof 1-Wire digital probe (stainless cylinder, no exposed pins)
- **Connection:** GPIO 13 (OneWire)
- **Address:** `281C6543D45E6759`
- **Library:** DallasTemperature v4.0.6 (with OneWire v2.3.8)
- **Accuracy:** ±0.5°C factory-calibrated
- **Status:** WORKING. Reads correct temperatures.

## Calibration History (Lessons Learned)

### Attempt 1: Serial-based calibration (FAILED)
- Added `CAL:EC:0`, `CAL:EC:1413`, `CAL:PH:7` commands that listen on `Serial.readStringUntil()`
- **Problem:** Opening COM3 via Python/pyserial or PowerShell resets the ESP32 (CH340 RTS/DTR auto-reset)
- `arduino-cli monitor` holds COM3 exclusively — can't write while it's reading
- `send-cal.py` Python bridge had same reset issue
- **Lesson:** Serial calibration is unreliable for this hardware. CH340 auto-reset is aggressive.

### Attempt 2: WSS-based calibration (WORKING)
- Added `{"command":"calibrate","params":{"type":"ec_zero"}}` to the ESP32's WSS handler
- DO forwards calibration commands from browser/CLI to ESP32
- **Successfully sent `CAL:STATUS`** — confirmed kValue=1.0, ecOffset=0, ph7Voltage=1.65V
- **Successfully sent `CAL:EC:0`** — ESP32 acknowledged
- **How to send:** Use Node.js native WebSocket:
  ```javascript
  const ws = new WebSocket('wss://iot-hub.funconnect.workers.dev/dashboard/esp32-sensor');
  ws.onopen = () => {
    ws.send(JSON.stringify({command:'calibrate',params:{type:'ec_zero'},ts:Date.now()}));
  };
  ```

### Attempt 3: EC zero-point calibration (PARTIALLY FAILED — corrupted EEPROM)
- **Mistake:** Calibrated `ec_zero` using Coca-Cola Ice Dew bottled water (not true distilled water)
- Ice Dew is purified drinking water with unknown mineral content (~10-50 μS/cm, not 0)
- Setting ecOffset to bottled water's value subtracted its own conductivity → all readings ≤ bottled water read 0
- Tap water also read 0 because offset consumed the signal
- **EC formula bug discovered:** `ecOffset` was applied AFTER temperature compensation, should be BEFORE
- Fixed formula: `(ecRaw - ecOffset) / (1.0 + 0.02 × (T-25.0))`
- **TDS bug discovered:** `readTDS()` duplicated the cubic formula independently of `readEC()`, so ecOffset wasn't applied to TDS
- Fixed: `readTDS(temp)` now simply calls `readEC(temp) × 0.5`
- **Lesson:** Never calibrate against an unknown reference. Always use known standards:
  - Distilled/deionized water (< 5 μS/cm) for zero-point
  - 1413 μS/cm calibration solution for span (kValue)

### Attempt 4: Temperature drift confusion
- User noticed EC readings drifting as water warmed
- **Cause:** The ecOffset-after-compensation bug meant temperature changes amplified the zero-point error
- After fixing the formula, recalibration needed

### EEPROM State (CORRUPTED — needs reset)
The calibration values stored in EEPROM are from the buggy formula era with bottled water as zero reference. All three values may be wrong. The `CAL:RESET` command (written but NOT YET FLASHED) will wipe to defaults: kValue=1.0, ecOffset=0, ph7Voltage=1.65V.

## Calibration Physics

### Why temperature compensation matters
Conductivity increases ~2% per °C because ion mobility increases as water viscosity drops. A reading at 30°C is ~10% higher than at 25°C for the SAME water chemistry. Without compensation, a warm day looks like a nutrient spike. This is physics, not sensor limitation.

### EC calibration formula
```
Step 1: ecRaw = cubic_polynomial(voltage) × kValue
Step 2: ecComp = (ecRaw - ecOffset) / (1.0 + 0.02 × (temp - 25.0))
Step 3: tds = ecComp × 0.5
```
Order matters: offset before temperature compensation. The ecOffset captures fixed circuit bias (ADC error, op-amp offset). Temperature affects real conductivity, not bias.

### pH calibration formula
```
pH = 7.0 + (voltage - ph7Voltage) / 0.059
```
Where 0.059 V/pH is the Nernst slope at 25°C. One-point calibration at pH 7.0 sets `ph7Voltage`. Two-point calibration (pH 4 + pH 7) corrects the slope. Without pH 7.0 buffer, the formula has no anchor.

### pH probe requirements
pH electrodes have megaohm output impedance. The ESP32 ADC cannot read them directly — signal collapses under load. Requires an op-amp buffer board with unity gain, high input impedance, and rail-to-rail output. The DFRobot SEN0161 or SEN0169 pH boards provide this.

### What's on the ESP32 right now (from last flash)
- **TDS formula fix:** `readTDS()` now correctly calls `readEC(temp) * 0.5`
- **EC formula fix:** `(ecRaw - ecOffset) / (1.0 + 0.02 * (temp - 25.0))` — offset before compensation (was buggy: compensated then subtracted)
- **EEPROM values are CORRUPTED:** ecOffset was set while probe was in bottled water (unknown EC), and also during old buggy formula era. Result: EC=0 for both tap and bottled water.
- **pH uncalibrated:** Reads 34.95 (probably disconnected — see hardware note above)

### What's in the sketch file but NOT flashed yet
- `CAL:RESET` command — resets kValue=1.0, ecOffset=0, ph7Voltage=1.65. Written to the `.ino` file, not yet compiled/flashed.

### Calibration commands (available via WSS)
Send from browser/CLI to the DO, DO forwards to ESP32:
```
{"command":"calibrate","params":{"type":"ec_zero"}}   — calibrate zero-point (needs REAL distilled water)
{"command":"calibrate","params":{"type":"ec_1413"}}   — calibrate kValue (needs 1413 μS/cm standard)
{"command":"calibrate","params":{"type":"ph_7"}}      — calibrate pH midpoint (needs pH 7.0 buffer)
{"command":"calibrate","params":{"type":"reset"}}     — wipe all calibration to defaults (NOT YET FLASHED)
```

### What the user needs to buy
- 1413 μS/cm calibration solution (~$3-5)
- pH 7.0 buffer solution (~$3)
- pH 4.0 buffer (optional, for two-point slope calibration)
- Real distilled/deionized water (not bottled drinking water)

## Cloudflare Deployment

### Worker: `iot-hub`
- Deployed at `iot-hub.funconnect.workers.dev`
- Route: `cyberpi.trade/*`
- DNS: A record `cyberpi.trade` → `192.0.2.1` (proxied)
- DO class: `DeviceHub` (SQLite-backed, hibernation)
- DO namespace ID: `537116d08a69409b9232aaee0fb779e5`

### Deploy method
**API multipart upload** (wrangler has Windows junction permission issues):
```bash
npx esbuild src/index.ts --bundle --format=esm --outfile=src/index.mjs --external:cloudflare:workers

curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/758cece0f853404f97b17f0ff86b5190/workers/scripts/iot-hub" \
  -H "Authorization: Bearer <TOKEN>" \
  -F 'metadata={"main_module":"index.mjs","compatibility_date":"2025-12-01","compatibility_flags":["nodejs_compat"],"bindings":[{"name":"DEVICE_HUB","type":"durable_object_namespace","class_name":"DeviceHub"}]};type=application/json' \
  -F 'index.mjs=@src/index.mjs;type=application/javascript+module'
```

**wrangler workaround** (if `Application Data` permission is fixed):
```bash
set CLOUDFLARE_API_TOKEN=<TOKEN>
set WRANGLER_HOME=%CD%\.wrangler
wrangler deploy
```

### wrangler issue
Legacy Windows junctions (`Application Data`, `Cookies`, `Local Settings`, etc.) have `Everyone:(DENY)(RD)`. Workaround: `WRANGLER_HOME=%CD%\.wrangler`. Or fix with admin: `icacls "path" /grant Everyone:R`.

## Project Directory Structure
```
C:\Projects\Prototype\          ← ALL project work lives here (convention)
├── README.md                   ← Comprehensive project README with reproduction guide
├── .gitignore
├── esp32-sketch/               ← ESP32 #1: WSS + LED ping/pong
│   └── esp32-sketch.ino
├── esp32-sketch-sensor/        ← ESP32 #2: WSS + TDS/pH/temp + calibration
│   └── esp32-sketch-sensor.ino
├── iot-hub/                    ← Cloudflare Worker + DO
│   ├── src/
│   │   ├── index.ts            ← Worker + dashboard HTML
│   │   ├── index.mjs           ← Bundled ES module (esbuild output for deploy)
│   │   └── device-hub.ts       ← DO class (hibernation, state, calibration forwarding)
│   ├── toggle-led.mjs          ← Node.js random LED toggler (overnight testing)
│   ├── toggle-log.jsonl        ← Toggle test data (JSON lines)
│   ├── graph-results.py        ← Python chart generator
│   ├── send-cal.py             ← Python serial bridge (DEPRECATED — resets ESP32)
│   ├── package.json
│   └── wrangler.jsonc          ← DO binding + SQLite migration config
├── aiot-control/               ← Legacy MQTT firmware project (archived)
├── ProjectFunConnect/          ← Legacy firmware build outputs (archived)
└── greeny-backup.bin           ← Partial dump of original GREENY firmware (4MB — incomplete)

C:\Projects\Demo\               ← Session handoff documents
└── AGENT-ALPHA-HANDOFF.md      ← THIS FILE
```

## Key Files

| File | Purpose |
|---|---|
| `C:\Projects\Prototype\iot-hub\src\index.ts` | Worker: routes, dashboard HTML (with sensor gauges) |
| `C:\Projects\Prototype\iot-hub\src\device-hub.ts` | DO class: state, commands, broadcast, calibration forwarding |
| `C:\Projects\Prototype\iot-hub\src\index.mjs` | Bundled ES module (esbuild output for deploy) |
| `C:\Projects\Prototype\iot-hub\wrangler.jsonc` | Wrangler config: DO binding, SQLite migration |
| `C:\Projects\Prototype\iot-hub\toggle-led.mjs` | Node.js random LED toggler (overnight testing, distributions) |
| `C:\Projects\Prototype\iot-hub\graph-results.py` | Python chart generator for toggle-log data |
| `C:\Projects\Prototype\esp32-sketch-sensor\esp32-sketch-sensor.ino` | Sensor hub sketch (needs CAL:RESET flashed) |
| `C:\Projects\Prototype\esp32-sketch\esp32-sketch.ino` | Basic WSS sketch for ESP32 #1 (LED only) |
| `C:\Projects\Prototype\README.md` | Project README (Wire protocol, architecture, reproduction guide) |

## Git
- **Repo:** `https://github.com/sacl2026-rgb/prototype` (private)
- **Branch:** `master` (local) → `main` (remote)
- **Push command:** `git push origin HEAD:main`

## Wire Protocol (WSS + JSON)

### ESP32 → DO
```json
{"type":"telemetry","tds":707,"ec":1413,"ph":7.12,"temp":25.3,"led":false}
{"type":"ack","command":"set_led","status":"ok","led":true,"esp32_ms":452381}
{"type":"ack","command":"calibrate","status":"ok","calType":"ec_zero"}
```

### DO → ESP32
```json
{"type":"sync","led":false,"doTs":1719000000000}
{"command":"set_led","params":{"state":true}}
{"command":"calibrate","params":{"type":"ec_zero"}}
```

### Browser/CLI → DO
```json
{"command":"set_led","state":true,"ts":1719000000000}
{"command":"calibrate","params":{"type":"ec_zero"},"ts":1719000000000}
```

### DO → Browser/CLI (broadcast)
```json
{"type":"state","led":true,"connected":true,"tds":707,"ec":1413,"ph":7.12,"temp":25.3,"doTs":1719000000450}
```

## DO Quota Safety
- Free tier: 100K req/day, 313K GB-s/day, 100K SQLite writes/day, 5 GB storage
- ESP32 at 1 telemetry/10s = ~8,640 wakes/day = ~0.6 billed requests/day (20:1 WS ratio)
- Each wake: ~2ms handler. Total ~17 seconds compute/day
- SQLite: 1 write per telemetry = 8,640 writes/day = 8.6% of free tier
- **Hibernation is working.** Constructor is zero-I/O (attachments only).

## Toolchain
- **arduino-cli** v1.5.1 (at `%APPDATA%\Roaming\npm\bin_dir\arduino-cli.exe`)
- **esptool** v5.3.0
- **wrangler** v4.100.0
- **Node.js** v24.16.0 (native WebSocket)
- **Python** 3.13 (matplotlib, numpy, pyserial)
- **ESP32 board package** v3.3.10
- **Arduino libs:** WebSockets v2.7.2, ArduinoJson v7.4.3, OneWire v2.3.8, DallasTemperature v4.0.6

## ESP32 Boards
- FQBN for flashing: `esp32:esp32:esp32`
- Compile: `arduino-cli compile --fqbn esp32:esp32:esp32 <sketch-dir>`
- Upload: `arduino-cli upload --fqbn esp32:esp32:esp32 -p COM3 <sketch-dir>`
- Monitor: `arduino-cli monitor -p COM3 -c baudrate=115200`
- **COM port is exclusive.** Stop monitor before uploading.
- **Serial commands don't work** (CH340 resets ESP32 on port open). Use WSS for calibration commands.

## Serial → WSS Calibration Bridge
The Python script `send-cal.py` (in Prototype folder) sends serial commands but resets the ESP32. Calibration is now done via WSS using Node.js WebSocket to the DO:
```javascript
const ws = new WebSocket('wss://iot-hub.funconnect.workers.dev/dashboard/esp32-sensor');
ws.onopen = () => {
  ws.send(JSON.stringify({command:'calibrate',params:{type:'ec_zero'},ts:Date.now()}));
};
```

## Immediate Next Steps (for successor agent)

1. **Flash the CAL:RESET-enabled sketch** to wipe corrupted calibration:
   - Compile: `arduino-cli compile --fqbn esp32:esp32:esp32 "C:\Projects\Prototype\esp32-sketch-sensor"`
   - Upload: `arduino-cli upload --fqbn esp32:esp32:esp32 -p COM3 "C:\Projects\Prototype\esp32-sketch-sensor"`
   - Send reset via WSS: `{"command":"calibrate","params":{"type":"reset"}}`

2. **After reset:** Verify EC reads different (non-zero) values for tap vs bottled water. If not, sensor may be disconnected.

3. **Diagnose pH:** 34.95 = 3.3V = probe likely disconnected from GPIO 39 or missing amplifier board. Physical inspection needed.

4. **When user gets 1413 μS/cm standard:** Run `CAL:EC:1413` via WSS. Then verify tap water reads in the 100-300 μS/cm range.

5. **When user gets pH 7.0 buffer:** Run `CAL:PH:7` via WSS. Verify pH reads near 7.0.

6. **WiFi:** User wants phone hotspot. ESP32 couldn't connect to `Redmi 15 5G`. Ensure 2.4GHz band is enabled on phone.

7. **Dashboard:** `https://iot-hub.funconnect.workers.dev/` shows sensor gauges (EC, TDS, pH, Temp) + LED control.

## ESP32 ADC Limitations (Hardware Knowledge)

The ESP32 ADC was extensively discussed. Here's what matters for water quality sensors:

| Issue | Severity | Impact on EC/pH | Fix |
|---|---|---|---|
| ADC2 + WiFi = dead | Critical | ADC2 (GPIO 0,2,4,12-15,25-27) unusable. Only ADC1 (32-39) works | Use GPIO 32-39 only |
| Noise floor ±6-12 LSBs | Low | ±3-6 ppm. 20-30× smaller than sensor accuracy | 16× oversampling + median filter |
| Nonlinearity (DNL) | Low | ±1-2 ppm non-cumulative | Oversampling distributes readings |
| Reference drift | Low | ~50-100 ppm over 10°C | esp_adc_cal_characterize() factory eFuse |
| No PGA | Medium | pH mV signals need external amplification | Op-amp buffer board required |

**The sensor accuracy (±10% F.S. = ±100 ppm) is the dominant error source, not the ADC.** The ESP32 ADC is capable of adequate precision for water quality monitoring. The bottleneck is the sensor itself and the lack of calibration.

## Benchmark Tests (Verified)

### Overnight LED Toggle Test (13 hours, 687 toggles)
- **RTT distribution:** P50=577ms, P90=870ms, P99=1459ms
- **Duration distribution:** 50% in 10s-1m bursts, 9% in 5-30m idle gaps
- **Reliability:** 0 failures. 1 disconnect/reconnect (5 seconds)
- **Quota:** < 700 WS messages after 20:1 ratio — negligible
- **Chart:** Generated via `graph-results.py` to `iot-hub-results.png` on Desktop
- **Data:** Stored in `toggle-log.jsonl`

### Quota Verification
Verified via Cloudflare GraphQL Analytics API after adding `Account Analytics — Read` to FunConnect token:
```bash
curl -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"query":"{ viewer { accounts(filter: {accountTag: \"ACCOUNT_ID\"}) { workersInvocationsAdaptive(...) { sum { requests duration } } } } }"}'
```
Result: ~14 seconds total DO compute over a full session. Hibernation confirmed — no background billing.

## Websites Referenced

| URL | Purpose |
|---|---|
| https://wiki.dfrobot.com/sen0244/ | DFRobot SEN0244 TDS sensor product page + specs |
| https://diyprojectslabs.com/arduino-tds-sensor-tutorial/ | Arduino TDS tutorial with calibration code (shared by user) |
| https://github.com/DFRobot/GravityTDS | Official DFRobot Arduino library (GravityTDS.h, GravityTDS.cpp) |
| https://github.com/Links2004/arduinoWebSockets | WebSocket client library for ESP32 (used for WSS) |
| https://developers.cloudflare.com/durable-objects/best-practices/websockets/ | DO WebSocket best practices + hibernation API |
| https://developers.cloudflare.com/durable-objects/platform/pricing/ | DO pricing + billing examples |

## Unresolved Issues (Open Work)

### Critical — Blocking
1. **Calibration corrupted.** EEPROM values are wrong. Must flash `CAL:RESET` sketch, then recalibrate with PROPER standards.
2. **No 1413 μS/cm standard.** User needs to buy calibration solution before EC can be accurate.
3. **No pH 7.0 buffer.** pH reads 34.95 (likely disconnected anyway). Need buffer solution AND verify physical connection.
4. **pH probe possibly disconnected.** Reading 34.95 = 3.3V = floating. Physical inspection of GPIO 39 wiring needed. May need pH amplifier board.

### Important — Architecture
5. **DO doesn't load sensor state from SQLite on wake.** After hibernation, `this.tds`, `this.ec`, `this.ph`, `this.temp` reset to defaults. Browser sees "—" until next telemetry (≤10s).
6. **DO initial browser welcome doesn't include sensor fields.** Even when class fields have values, they're not in the state broadcast. Fix: add sensor data to all state broadcasts.
7. **ESP32 sketch has no local display support.** The WS-001 display stays dark. GREENY firmware used it. Could be added later.
8. **WiFi credentials hardcoded.** The user wants phone hotspot. ESP32 can't connect. May need WiFi scanning + dynamic SSID, or a fallback list.

### Future — Design Decisions
9. **DO-based drift tracking.** The DO could track calibration history, estimate drift rate, widen error envelopes over time. Not implemented.
10. **Daily basin-drain recalibration.** The user suggested using the water basin's fill cycle as an automatic calibration trigger. Concept discussed, not implemented.
11. **LLM integration.** The user de-emphasized LLM for now ("post mortem only, strong NL capabilities"). The pipeline is ready for it — the DO broadcasts state that any consumer can read.
12. **Multiple device support.** Architecture supports it (one DO per device via `idFromName`). Only one ESP32 connected at a time currently.
13. **cyberpi.trade domain routing.** A record exists but user hasn't tested it. workers.dev subdomain works reliably.
14. **Two ESP32s, same COM3.** Only one can be connected at a time. The sensor hub (ESP32 #2) is the primary. ESP32 #1 (LED only) is disconnected.

### Known Bugs (Fixed but verify)
15. **TDS/EC formula bug** — verified fixed in sketch file but needs reflash with CAL:RESET.
16. **DO calibration forwarding** — added to device-hub.ts. Verified deployed.
17. **Dashboard device ID mismatch** — was `esp32-01`, fixed to `esp32-sensor`. Verified deployed.

## Session Timeline (Context for Successor)

1. **Architecture discussion** — established WSS + DO Hibernation, rejected MQTT/EMQX
2. **Cloudflare account cleanup** — deleted old Workers, D1 databases, routes, DNS records via API. Clean slate.
3. **API token upgrade** — user created FunConnect token with all permissions including Analytics and DNS Edit
4. **ESP32 #1 — WSS smoke test** — LED ping/pong. Proved TLS handshake works (NTP sync + CA bundle)
5. **Phase 3 — DO + Dashboard** — LED control via browser button over WSS. Overnight benchmark (687 toggles, 0 failures)
6. **GitHub repo** — `sacl2026-rgb/prototype`. Private. README with reproduction guide.
7. **ESP32 #2 — GREENY firmware** — discovered pre-loaded sensor firmware. Dumped (partial). Overwritten with Arduino.
8. **Sensor integration** — TDS, pH, DS18B20 connected to WSS sketch. Telemetry flows to dashboard.
9. **Calibration struggles** — Serial approach failed (CH340 reset). WSS approach worked but bottled water corrupted EEPROM.
10. **Handoff** — this document, at user's explicit request for comprehensive context.

## What Works End-to-End (Proven)

- ESP32 WSS to Cloudflare Worker (TLS with CA bundle, NTP sync, 115200 baud)
- DO WebSocket Hibernation (zero-I/O constructor, attachment-based state)
- Browser dashboard with WSS state updates (LED control, sensor gauges)
- Overnight reliability (13 hours, no failures, auto-reconnect)
- Quota safety (< 2% free tier for one device)
- Cloudflare API as agent control plane (Workers CRUD, DO namespaces, D1, DNS, routes, analytics)
- Temperature sensor (DS18B20 on GPIO 13, valid readings)
- TDS sensor responds to water changes (cubic conversion works, uncalibrated)

## What Does NOT Work Yet

- Accurate EC/TDS (needs 1413 standard calibration)
- pH (likely disconnected, needs buffer + hardware check)
- Phone hotspot WiFi
- wrangler deploy without `WRANGLER_HOME` workaround
- CAL:RESET command (in sketch but not yet flashed)

## Operating Philosophy
1. DO is canonical state. Device is implementation detail.
2. WSS + JSON is universal protocol. Every consumer speaks it.
3. ctx.acceptWebSocket() — never server.accept(). Hibernation is non-negotiable.
4. Constructor must be zero-I/O. Attachments < 16KB.
5. Cloudflare API is the agent's control plane. One token, one surface.
6. Measure, don't assume. wrangler tail, serial monitor, GraphQL analytics.
7. Never calibrate against unknown references. Only known standards (1413 μS/cm, pH 7.0, distilled water).
