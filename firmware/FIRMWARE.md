# Firmware — Agent Firmware Module Spec

**Owner:** Agent Firmware  
**Read with:** `PROTOCOL.md` (for message formats) + `firmware/esp32/esp32.ino`.  
**Do NOT load:** `edge/src/*` files. Firmware and Edge communicate only through `PROTOCOL.md`.

---

## Hardware

- **Chip:** ESP32-D0WD-V3 rev v3.1, MAC `b0:cb:d8:c2:35:90`, 4MB flash
- **USB:** CH340 on COM3, 115200 baud
- **Pins:**
  - LED: GPIO 2
  - TDS (DFRobot SEN0244): GPIO 36 (ADC1)
  - pH probe + amplifier board: GPIO 39 (ADC1)
  - DS18B20 temp probe: GPIO 13 (OneWire)
- **Sketch:** `firmware/esp32/esp32.ino`
- **Device ID in protocol:** `esp32-sensor`
- **Behavior:** Connect WSS, read sensors every 10s, send telemetry, respond to `set_led` and `calibrate` commands. LED on GPIO 2 doubles as WSS smoke test.

### Older board (not connected)
- ESP32-D0WD-V3 rev v3.0, MAC `c0:49:ef:b4:79:6c`, 16MB flash
- Used for LED-only smoke testing. Fully superseded by current unified firmware.

### WiFi
- **WiFi:** Credentials in `wifi.env` (not committed). ESP32 supports 2.4GHz only.

---

## Toolchain

```bash
arduino-cli           v1.5.1  (%APPDATA%\Roaming\npm\bin_dir\arduino-cli.exe)
ESP32 board package   v3.3.10
esptool               v5.3.0

# Required libraries (install once):
arduino-cli lib install WebSockets@2.7.2
arduino-cli lib install ArduinoJson@7.4.3
arduino-cli lib install OneWire@2.3.8
arduino-cli lib install DallasTemperature@4.0.6
```

---

## Commands

```bash
# Compile
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32

# Upload (STOP monitor first — COM port is exclusive)
arduino-cli upload --fqbn esp32:esp32:esp32 -p COM3 firmware/esp32

# Direct esptool (if arduino-cli upload fails with "wrong boot mode"):
ESPT="C:/Users/sacl2/AppData/Local/Arduino15/packages/esp32/tools/esptool_py/5.3.0/esptool.exe"
SKETCH="C:/Users/sacl2/AppData/Local/arduino/sketches/<build-hash>"
HW="C:/Users/sacl2/AppData/Local/Arduino15/packages/esp32/hardware/esp32/3.3.10"
"$ESPT" --chip esp32 --before default-reset --after hard-reset write-flash \
  0x1000 "$SKETCH/esp32.ino.bootloader.bin" \
  0x8000 "$SKETCH/esp32.ino.partitions.bin" \
  0xe000 "$HW/tools/partitions/boot_app0.bin" \
  0x10000 "$SKETCH/esp32.ino.bin"

# Monitor (115200 baud)
arduino-cli monitor -p COM3 -c baudrate=115200
```

---

## Critical ESP32 Rules

### 1. NTP Sync Before WSS — MANDATORY
ESP32 has no battery-backed RTC. After power-on, clock = Jan 1 1970. TLS cert validation FAILS because every cert appears expired.

```cpp
configTime(0, 0, "pool.ntp.org", "time.nist.gov");
while (time(nullptr) < 8 * 3600 * 2) { delay(100); }
```

### 2. CA Bundle — Use Built-in
```cpp
webSocket.beginSslWithBundle(WS_HOST, WS_PORT, WS_PATH, NULL, 0, "");
// NULL, 0, "" → uses ESP32's built-in 77KB CA bundle.
```

### 3. ADC1 Only
ADC2 is unusable when WiFi is active. Use GPIO 32–39 (ADC1). Our TDS (36) and pH (39) are on ADC1 — correct.

### 4. CH340 Auto-Reset
Opening COM3 from any tool pulls RTS/DTR and resets the ESP32. **Serial calibration does not work.** Use WSS for all calibration commands.

### 5. WiFi Band
ESP32 is 2.4GHz only. Cannot see 5GHz or WiFi 6 networks.

---

## Sensor Physics

### TDS/EC — DFRobot SEN0244
- Range: 0–1000 ppm TDS (~0–2000 μS/cm)
- Accuracy: ±10% F.S. (±100 ppm)
- **No built-in temperature sensor** — requires external DS18B20
- Conversion (cubic polynomial from DFRobot datasheet):
  ```
  voltage = analogRead(TDS_PIN) / 4096.0 * 3.3
  ecRaw = (133.42*V³ - 255.86*V² + 857.39*V) * kValue
  ecComp = (ecRaw - ecOffset) / (1.0 + 0.02 * (temp - 25.0))
  tds = ecComp * 0.5
  ```
  **Order matters:** offset BEFORE temperature compensation.

### pH
- Nernst equation: `pH = 7.0 + (voltage - ph7Voltage) / 0.059`
- pH electrode has megaohm impedance — requires op-amp buffer board
- **Current status:** GPIO 39 reads 34.95 (= 3.3V = floating). HARDWARE ISSUE — probe disconnected or missing amplifier board. Do not touch in firmware.

### DS18B20 Temperature
- Address: `281C6543D45E6759`
- Accuracy: ±0.5°C factory-calibrated

---

## EEPROM Layout

| Address | Value | Size | Purpose |
|---|---|---|---|
| 0 | Not used | 8 | Reserved |
| 8 | kValue | 4 (float) | EC calibration multiplier |
| 16 | ecOffset | 4 (float) | EC zero-point offset |
| 24 | ph7Voltage | 4 (float) | pH 7.0 reference voltage |

**Defaults (after CAL:RESET):** kValue=1.0, ecOffset=0, ph7Voltage=1.65V

---

## Calibration (via WSS, NOT serial)

Send from browser/CLI → DO → ESP32:

```json
{"command":"calibrate","params":{"type":"ec_zero"}}    // Zero-point (needs REAL distilled water)
{"command":"calibrate","params":{"type":"ec_1413"}}    // Span (needs 1413 μS/cm standard)
{"command":"calibrate","params":{"type":"ph_4"}}       // pH 4.00 buffer (needs pH 4.00 standard)
{"command":"calibrate","params":{"type":"ph_7"}}       // pH 7.00 buffer (needs pH 7.00 standard)
{"command":"calibrate","params":{"type":"ph_9"}}       // pH 9.18 buffer (needs pH 9.18 standard)
{"command":"calibrate","params":{"type":"reset"}}      // Wipe to defaults
```

**pH calibration formulas:**

| Command | Formula (derives ph7Voltage from buffer voltage) |
|---------|--------------------------------------------------|
| CAL:PH:4 | `ph7Voltage = V + (7.0 - 4.0) × 0.059 = V + 0.177` |
| CAL:PH:7 | `ph7Voltage = V` (direct measurement at pH 7.00) |
| CAL:PH:9 | `ph7Voltage = V - (9.18 - 7.0) × 0.059 = V - 0.129` |

**Recommended calibration order:**
1. Probe in pH 4.00 buffer → send `CAL:PH:4`
2. Probe in pH 9.18 buffer → verify reading ~9.18
3. If 9.18 reads correctly, slope is good. If off, slope needs EEPROM storage (future enhancement).

**Required standards (user needs to buy):**
- 1413 μS/cm calibration solution (~$3-5)
- pH 7.0 buffer solution (~$3)
- Real distilled/deionized water (not bottled drinking water)

---

## Smoke Tests

Run after flashing to verify firmware is healthy.

### S1: Compile
```bash
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32
```

### S2: Upload
```bash
arduino-cli upload --fqbn esp32:esp32:esp32 -p COM3 firmware/esp32
```

### S3: Serial boot sequence
```bash
arduino-cli monitor -p COM3 -c baudrate=115200
```
Expected: WiFi connected → NTP synced → WSS connected → telemetry flowing.

### S4: LED toggle (WSS)
Send from dashboard:
```json
{"command":"set_led","device_id":"esp32-sensor","state":true}
```
Verify DO state broadcast shows `led: true`. Toggle back to false.

### S5: CAL:RESET (WSS)
```json
{"command":"calibrate","device_id":"esp32-sensor","params":{"type":"reset"}}
```
Verify serial shows `CAL:RESET → all calibration reset to defaults`.

### S6: Telemetry fields
DO state broadcasts must include: `device_id`, `ec`, `tds`, `ph`, `temp`, `esp32_ms`.

### S7: DS18B20 temperature
Serial shows `T=~24°C` (ambient). Dashboard state includes valid `temp`.

### S8: EC non-zero
With probe in tap water, EC reads ~100-300 μS/cm. If EC is ~5000, probe is dry or disconnected from SEN0244 board.

### S9: WiFi scan (WSS)
```json
{"command":"wifi_scan","device_id":"esp32-sensor","params":{}}
```
DO broadcasts `{type:"wifi_list","networks":[{ssid,rssi,enc},...]}`. Verify networks appear.

### S10: WiFi set (WSS)
```json
{"command":"wifi_set","params":{"ssid":"MyWiFi","pass":"my-password"}}
```
ESP32 saves to EEPROM, disconnects, reconnects to new network. DO broadcasts `{type:"wifi_ack","status":"ok"}` on success. Telemetry resumes within 15 seconds.

---

## New Features (2026-07-05)

### WiFi Manager via WSS
User scans networks from the dashboard, selects one, enters password, ESP32 switches. No captive portal, no physical button. Credentials saved to EEPROM (addresses 40-138: magic byte + SSID + password). Falls back to compiled defaults on failure. 2.4GHz only — ESP32 hardware limitation.

### WebSocket Watchdog
Detects half-open WebSocket connections (common after Cloudflare Worker deploys where DO→ESP32 path breaks while ESP32→DO telemetry still flows). If 30 seconds pass with zero inbound data from the DO, the ESP32 disconnects and reconnects fresh. Self-healing — no manual replug needed after deploys.

### Calibration Protection
All four calibration values (kValue, ecOffset, ph7Voltage, phSlope) use the saved-pattern in `loadCalibration()`: save compiled default before `EEPROM.get()`, restore if EEPROM value is invalid. This prevents `EEPROM.get()` from silently clobbering hardcoded defaults before validation runs.

Validation ranges adjusted for the inverted TDS board:
- `ecOffset`: 0 to 5000 (was ±1000)
- `tdsKValue`: 0.001 to 10.0 (was 0.1 minimum)
- `phSlope`: 0.010 to 0.300 (unchanged)
