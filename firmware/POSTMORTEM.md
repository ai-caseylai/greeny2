# Firmware Postmortem — Greeny Alpha

## Successes

### Sketch Consolidation
Two sketches (`esp32-sensor`, `esp32-led`) merged into `firmware/esp32/esp32.ino`. LED control, sensor reading, calibration, and OLED all in one firmware. Old directories removed.

### PROTOCOL Compliance
`device_id` and `esp32_ms` added to all telemetry and ack messages. Matches `PROTOCOL.md` exactly.

### pH Calibration — Two-Point with Slope Storage
Formula corrected from `pH = 7.0 + (V - ph7V) / slope` to `pH = 7.0 - (V - ph7V) / slope`. The voltage decreases as pH increases on this electrode. Slope stored in EEPROM (addr 28), computed from real electrode measurements, validated to 0.010–0.300 V/pH. Commands: CAL:PH:4, CAL:PH:7, CAL:PH:9. Verified: pH 4.00 buffer reads 3.99, pH 9.18 buffer reads 9.18.

### OLED Display
SSD1306 128×64 via I2C (GPIO 21/22). Shows pH, TDS, EC, temp, LED state, WiFi/WSS status, IP, uptime. Libraries: Adafruit SSD1306 + Adafruit GFX.

### LED Control
GPIO 2 toggles via WSS set_led commands, confirmed through DO state broadcasts and serial debug output.

### DO QoS 0
Calibrate commands are fire-and-forget — no queue, no replay after reboot. This fixed the calibration corruption bug where stale commands replayed after flash and overwrote good EEPROM values.

### Smoke Test Script
`firmware/smoke_test.py` — reusable WSS test battery.

### EEPROM Layout

| Address | Value | Size |
|---|---|---|
| 8 | kValue (EC calibration multiplier) | 4 bytes (float) |
| 16 | ecOffset (EC zero-point offset) | 4 bytes (float) |
| 24 | ph7Voltage (pH 7.0 reference) | 4 bytes (float) |
| 28 | phSlope (pH slope in V/pH) | 4 bytes (float) |
| 32 | calV4 (temp: voltage at pH 4.00 for 2-pt cal) | 4 bytes (float) |

---

## Failures / Blocked

### EC/TDS (Resolved)
ADC consistently 0 across three GPIO pins (36, 34, 35), two SEN0244 boards, and multiple probes. Board lights up (blue LED) but outputs no signal at 3.3V.

**Root cause:** The off-brand replacement board requires 5V to drive analog output. The standard TDS pin row only provides 3.3V. The board works when powered from the 5V column. Additionally, the board outputs voltage that DROPS with conductivity (inverted from DFRobot SEN0244 spec), requiring a flipped formula and special calibration handling.

**Resolution:** Moved TDS to GPIO 35 on 5V column. Formula flipped to `(ecOffset - ecRaw)`. kValue (0.088) and ecOffset (201) forced in setup() with EEPROM write. Validation ranges extended in loadCalibration(). Saved-pattern prevents EEPROM corruption on boot.

### DO Command Forwarding — Intermittent
Commands from dashboard sometimes don't reach the ESP32. Worked after initial fix, broke again after deploys, worked again. QoS 0 for calibrate commands was the permanent fix. The relay queue now purges on ESP32 reconnect to prevent stale command replay.

### Wrong Boot Mode on Flash
`arduino-cli upload` fails ~70% of the time when WiFi is active. Workaround: use `esptool` directly with retry loop. CH340 auto-reset timing issue — not a firmware bug.

---

## Lessons Learned

1. **Nernst sign depends on the amplifier.** Many pH amp boards invert the signal. Always verify with two known buffers before assuming the formula sign.

2. **Default slope (0.059) is wrong for amplified electrodes.** Our board has ~2.8× gain (real slope ~0.164 V/pH). Two-point calibration is mandatory — single-point with theoretical slope gives exponentially worse readings as you move away from the calibration point.

3. **DO command queuing + stateful calibration = corruption.** If the DO replays CAL:PH:4 after reboot but the probe is in a different buffer, the calibration is destroyed. QoS 0 (forward-only, no queue) is the correct behavior for calibration commands.

4. **Serial calibration doesn't work.** CH340 resets the ESP32 on port open. All calibration must go through WSS.

5. **ADC pins die silently.** GPIO 36 read 0 in all conditions while GPIO 39 worked fine on the same ESP32. Always verify a "dead" sensor by testing the pin with a known voltage source before debugging firmware.

6. **Off-brand sensor boards can invert output.** The replacement TDS board outputs voltage that DROPS with conductivity. Verify with a multimeter before assuming signal direction.

7. **EEPROM validation ranges must accommodate all possible values.** The original ±1000 range for ecOffset was too narrow for the inverted board (needs ~2275). The minimum kValue of 0.1 rejected our computed 0.088.

8. **`EEPROM.get()` is destructive.** It overwrites the variable before validation can run. Always save the compiled default before reading EEPROM.

9. **3.3V is not always enough for analog sensor boards.** The SEN0244 datasheet says 3.3–5.5V, but in practice the analog output circuit may need 5V headroom. Test at both voltages before declaring a board dead.
