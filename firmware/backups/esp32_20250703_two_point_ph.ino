/*
 * IoT Hub — Sensor Hub
 * ESP32-WROOM-32E + DFRobot TDS + pH + DS18B20 + WSS → Cloudflare DO
 * 
 * Pins: LED=GPIO2, DS18B20=GPIO13, TDS=GPIO36(ADC1), pH=GPIO39(ADC1)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <EEPROM.h>

// ── CONFIG ──────────────────────────────────────
const char* WIFI_SSID     = "CMHK-ECch";
const char* WIFI_PASS     = "gt5cqu69";

const char* WS_HOST       = "iot-hub.funconnect.workers.dev";
const uint16_t WS_PORT    = 443;
const char* WS_PATH       = "/device/esp32-sensor";

#define LED_PIN             2
#define ONEWIRE_PIN         13
#define TDS_PIN             36    // ADC1 — VP on most dev boards
#define PH_PIN              39    // ADC1 — VN on most dev boards

#define PING_INTERVAL_MS    10000
#define USE_SERIAL          Serial

// ── TDS conversion constants (DFRobot calibration curve) ──
#define TDS_ADC_RANGE       4096.0   // ESP32 12-bit ADC
#define TDS_VREF            3.3      // ESP32 ADC reference
#define TDS_FACTOR          0.5      // TDS = EC / 2
#define EEPROM_K_ADDR        8        // kValue storage address
#define EEPROM_EC_OFFSET_ADDR  16    // EC zero-point offset
#define EEPROM_PH7_ADDR         24    // pH 7.0 reference voltage
#define EEPROM_PH_SLOPE_ADDR    28    // pH slope (V/pH), default 0.059
#define EEPROM_CAL_V4_ADDR      32    // temp: voltage at pH 4.00 (for 2-pt cal)
// ─────────────────────────────────────────────────

WiFiMulti wifiMulti;
WebSocketsClient webSocket;
OneWire oneWire(ONEWIRE_PIN);
DallasTemperature ds18b20(&oneWire);

unsigned long lastPingMs = 0;
uint32_t pingSeq = 0;
bool timeSynced = false;
float tdsKValue = 1.0;   // calibration multiplier, loaded from EEPROM
float ecOffset = 0;       // EC zero-point offset (μS/cm), loaded from EEPROM
float ph7Voltage = 1.65;  // voltage at pH 7.0, loaded from EEPROM (default: 3.3/2)
float phSlope = 0.059;    // pH slope in V/pH, loaded from EEPROM (default: 0.059)

// ── NTP time sync ───────────────────────────────
void syncTime() {
  USE_SERIAL.print("NTP: Syncing... ");
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  time_t now = time(nullptr);
  int dots = 0;
  while (now < 8 * 3600 * 2) {
    delay(500);
    USE_SERIAL.print(".");
    if (++dots % 20 == 0) USE_SERIAL.println();
    now = time(nullptr);
  }
  timeSynced = true;
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  USE_SERIAL.println();
  USE_SERIAL.print("NTP: Synced — ");
  USE_SERIAL.print(asctime(&timeinfo));
}

// ── LED control ─────────────────────────────────
void setLED(bool on) {
  digitalWrite(LED_PIN, on ? HIGH : LOW);
}

// ── Helper ──────────────────────────────────────
float readDS18B20() {
  ds18b20.requestTemperatures();
  float t = ds18b20.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C || t < -50 || t > 125) return 25.0;
  return t;
}

// ── TDS / EC conversion (inlined from DFRobot GravityTDS) ──
float readTDS(float temp) {
  return readEC(temp) * TDS_FACTOR;  // TDS = EC / 2
}

float readEC(float temp) {
  int raw = analogRead(TDS_PIN);
  float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
  float ecRaw = (133.42 * voltage * voltage * voltage
               - 255.86 * voltage * voltage
               + 857.39 * voltage) * tdsKValue;
  // ecOffset corrects fixed bias BEFORE temperature compensation
  return (ecRaw - ecOffset) / (1.0 + 0.02 * (temp - 25.0));
}

float readPH() {
  int raw = analogRead(PH_PIN);
  float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
  // pH = 7.0 - (V - ph7Voltage) / phSlope   (Nernst: V decreases as pH increases)
  float ph = 7.0 - (voltage - ph7Voltage) / phSlope;
  return ph;
}

// ── EEPROM helpers ──────────────────────────────
void loadCalibration() {
  EEPROM.get(EEPROM_K_ADDR, tdsKValue);
  if (isnan(tdsKValue) || tdsKValue < 0.1 || tdsKValue > 10.0) {
    tdsKValue = 1.0;
    EEPROM.put(EEPROM_K_ADDR, tdsKValue);
    EEPROM.commit();
  }

  EEPROM.get(EEPROM_EC_OFFSET_ADDR, ecOffset);
  if (isnan(ecOffset) || ecOffset < -1000 || ecOffset > 1000) {
    ecOffset = 0;
    EEPROM.put(EEPROM_EC_OFFSET_ADDR, ecOffset);
    EEPROM.commit();
  }

  EEPROM.get(EEPROM_PH7_ADDR, ph7Voltage);
  if (isnan(ph7Voltage) || ph7Voltage < 0.1 || ph7Voltage > 3.2) {
    ph7Voltage = 1.65;
    EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
    EEPROM.commit();
  }

  EEPROM.get(EEPROM_PH_SLOPE_ADDR, phSlope);
  if (isnan(phSlope) || phSlope < 0.010 || phSlope > 0.300) {
    phSlope = 0.059;
    EEPROM.put(EEPROM_PH_SLOPE_ADDR, phSlope);
    EEPROM.commit();
  }

  USE_SERIAL.printf("Calibration: k=%.4f  ecOff=%.0f  ph7V=%.3f  slope=%.3f\n",
                    tdsKValue, ecOffset, ph7Voltage, phSlope);
}

void handleSerialCalibration() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  cmd.toUpperCase();

  if (cmd == "CAL:EC:0") {
    // Zero-point: user dipped probe in distilled water
    float temp = 25.0;
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t > -50 && t < 125) temp = t;

    int raw = analogRead(TDS_PIN);
    float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
    float ecRaw = (133.42 * voltage * voltage * voltage
                 - 255.86 * voltage * voltage
                 + 857.39 * voltage) * tdsKValue;
    float ecComp = ecRaw / (1.0 + 0.02 * (temp - 25.0));
    ecOffset = ecComp;  // in distilled water, EC should be 0
    EEPROM.put(EEPROM_EC_OFFSET_ADDR, ecOffset);
    EEPROM.commit();
    USE_SERIAL.printf("CAL:EC:0 → ecOffset=%.1f (raw compensated EC was %.1f)\n",
                      ecOffset, ecComp);
  }
  else if (cmd == "CAL:EC:1413") {
    // Span: user dipped probe in 1413 μS/cm standard
    float temp = 25.0;
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t > -50 && t < 125) temp = t;

    int raw = analogRead(TDS_PIN);
    float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
    float ecRawCubic = (133.42 * voltage * voltage * voltage
                      - 255.86 * voltage * voltage
                      + 857.39 * voltage);
    // Back-calculate: 1413 = ecRawCubic * kValue / compensation - ecOffset
    float comp = 1.0 + 0.02 * (temp - 25.0);
    float targetEc = 1413.0 + ecOffset;  // undo offset for kValue calc
    tdsKValue = (targetEc * comp) / ecRawCubic;

    if (tdsKValue > 0.25 && tdsKValue < 4.0) {
      EEPROM.put(EEPROM_K_ADDR, tdsKValue);
      EEPROM.commit();
      USE_SERIAL.printf("CAL:EC:1413 → kValue=%.4f\n", tdsKValue);
    } else {
      tdsKValue = 1.0;
      USE_SERIAL.printf("CAL:EC:1413 FAILED — kValue=%.4f out of range (0.25-4.0). Check probe.\n", tdsKValue);
    }
  }
  else if (cmd == "CAL:PH:7") {
    // Single-point: ph7V = V (direct measurement at pH 7.0)
    int raw = analogRead(PH_PIN);
    ph7Voltage = raw / TDS_ADC_RANGE * TDS_VREF;
    if (ph7Voltage > 0.1 && ph7Voltage < 3.2) {
      EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
      float nanVal = NAN;
      EEPROM.put(EEPROM_CAL_V4_ADDR, nanVal);  // clear pending 2-pt
      EEPROM.commit();
      USE_SERIAL.printf("CAL:PH:7 → ph7Voltage=%.3fV (slope=%.4f)\n", ph7Voltage, phSlope);
    } else {
      USE_SERIAL.printf("CAL:PH:7 FAILED — voltage %.3fV out of range. Check probe.\n", ph7Voltage);
    }
  }
  else if (cmd == "CAL:PH:4") {
    // Two-point: store V4; if V9 known (from current cal), compute slope
    // pH = 7 - (V - ph7V) / phSlope  →  ph7V = V4 - 3*phSlope
    int raw = analogRead(PH_PIN);
    float v4 = raw / TDS_ADC_RANGE * TDS_VREF;
    EEPROM.put(EEPROM_CAL_V4_ADDR, v4);
    EEPROM.commit();
    USE_SERIAL.printf("CAL:PH:4 → V4=%.3fV stored\n", v4);

    // Back-calc V9 from current cal: ph7V = V9 + 2.18*phSlope → V9 = ph7V - 2.18*phSlope
    float v9 = ph7Voltage - (9.18 - 7.0) * phSlope;
    if (v9 > 0.1 && v9 < 3.2) {
      float newSlope = (v4 - v9) / (9.18 - 4.00);  // positive: V4 > V9
      if (newSlope > 0.010 && newSlope < 0.300) {
        phSlope = newSlope;
        ph7Voltage = v4 - 3.0 * phSlope;
        EEPROM.put(EEPROM_PH_SLOPE_ADDR, phSlope);
        EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
        EEPROM.commit();
        USE_SERIAL.printf("CAL:PH:4 → 2-pt: V4=%.3f V9=%.3f slope=%.4f ph7V=%.3f\n",
                          v4, v9, phSlope, ph7Voltage);
      } else {
        USE_SERIAL.printf("CAL:PH:4 → slope=%.4f out of range (0.010-0.300). Single-pt fallback.\n", newSlope);
        ph7Voltage = v4 - 3.0 * phSlope;
        EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
        EEPROM.commit();
      }
    } else {
      USE_SERIAL.printf("CAL:PH:4 → single-pt (no prior V9). V4=%.3f stored. Send CAL:PH:9 next.\n", v4);
    }
  }
  else if (cmd == "CAL:PH:9") {
    // Two-point: check if V4 was stored from prior CAL:PH:4
    // pH = 7 - (V - ph7V) / phSlope  →  ph7V = V9 + 2.18*phSlope
    int raw = analogRead(PH_PIN);
    float v9 = raw / TDS_ADC_RANGE * TDS_VREF;

    float storedV4;
    EEPROM.get(EEPROM_CAL_V4_ADDR, storedV4);

    if (!isnan(storedV4) && storedV4 > 0.1 && storedV4 < 3.2) {
      float newSlope = (storedV4 - v9) / (9.18 - 4.00);  // positive: V4 > V9
      if (newSlope > 0.010 && newSlope < 0.300) {
        phSlope = newSlope;
        ph7Voltage = storedV4 - 3.0 * phSlope;
        EEPROM.put(EEPROM_PH_SLOPE_ADDR, phSlope);
        EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
        float nanVal = NAN;
        EEPROM.put(EEPROM_CAL_V4_ADDR, nanVal);
        EEPROM.commit();
        USE_SERIAL.printf("CAL:PH:9 → 2-pt: V4=%.3f V9=%.3f slope=%.4f ph7V=%.3f\n",
                          storedV4, v9, phSlope, ph7Voltage);
      } else {
        USE_SERIAL.printf("CAL:PH:9 → slope=%.4f out of range (0.010-0.300). Single-pt fallback.\n", newSlope);
        ph7Voltage = v9 + 2.18 * phSlope;
        EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
        EEPROM.commit();
      }
    } else {
      // Single-point: no prior V4
      ph7Voltage = v9 + 2.18 * phSlope;
      if (ph7Voltage > 0.1 && ph7Voltage < 3.2) {
        EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
        EEPROM.commit();
        USE_SERIAL.printf("CAL:PH:9 → single-pt: V9=%.3f ph7V=%.3f slope=%.4f\n",
                          v9, ph7Voltage, phSlope);
      } else {
        USE_SERIAL.printf("CAL:PH:9 FAILED — ph7Voltage %.3fV out of range\n", ph7Voltage);
      }
    }
  }
  else if (cmd == "CAL:STATUS") {
    USE_SERIAL.printf("kValue=%.4f  ecOffset=%.1f  ph7Voltage=%.3fV\n",
                      tdsKValue, ecOffset, ph7Voltage);
  }
  else if (cmd.length() > 0) {
    USE_SERIAL.printf("Unknown: %s\n", cmd.c_str());
    USE_SERIAL.println("Commands: CAL:EC:0  CAL:EC:1413  CAL:PH:4  CAL:PH:7  CAL:PH:9  CAL:STATUS");
  }
}

// ── WebSocket event handler ─────────────────────
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      USE_SERIAL.println("[WS] Disconnected");
      setLED(false);
      break;

    case WStype_CONNECTED:
      USE_SERIAL.printf("[WS] Connected → %s\n", payload);
      setLED(true);
      pingSeq = 1;
      lastPingMs = millis();
      break;

    case WStype_TEXT: {
      USE_SERIAL.printf("MSG  ← %s\n", (char*)payload);
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, (char*)payload);
      if (!err) {
        const char* type = doc["type"];
        const char* command = doc["command"];

        if (type && strcmp(type, "sync") == 0) {
          bool led = doc["led"];
          setLED(led);
          USE_SERIAL.printf("SYNC ← led=%s\n", led ? "ON" : "OFF");
        }
        else if (command && strcmp(command, "set_led") == 0) {
          bool state = doc["params"]["state"];
          setLED(state);
          unsigned long espMs = millis();
          USE_SERIAL.printf("CMD  ← set_led → %s (ms=%lu)\n",
                            state ? "ON" : "OFF", espMs);

          JsonDocument ack;
          ack["type"] = "ack";
          ack["device_id"] = "esp32-sensor";
          ack["command"] = "set_led";
          ack["status"] = "ok";
          ack["led"] = state;
          ack["esp32_ms"] = espMs;
          char buf[128];
          serializeJson(ack, buf);
          webSocket.sendTXT(buf);
        }
        else if (command && strcmp(command, "calibrate") == 0) {
          const char* calType = doc["params"]["type"];
          USE_SERIAL.printf("CMD  ← calibrate: %s\n", calType);

          if (strcmp(calType, "reset") == 0) {
            tdsKValue = 1.0;
            ecOffset = 0;
            ph7Voltage = 1.65;
            phSlope = 0.059;
            float nanVal = NAN;
            EEPROM.put(EEPROM_K_ADDR, tdsKValue);
            EEPROM.put(EEPROM_EC_OFFSET_ADDR, ecOffset);
            EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
            EEPROM.put(EEPROM_PH_SLOPE_ADDR, phSlope);
            EEPROM.put(EEPROM_CAL_V4_ADDR, nanVal);  // clear pending calibration
            EEPROM.commit();
            USE_SERIAL.println("CAL:RESET → all calibration reset to defaults");
          }
          else if (strcmp(calType, "ec_zero") == 0) {
            float temp = readDS18B20();
            int raw = analogRead(TDS_PIN);
            float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
            float ecRaw = (133.42 * voltage * voltage * voltage
                         - 255.86 * voltage * voltage
                         + 857.39 * voltage) * tdsKValue;
            ecOffset = ecRaw;  // raw EC in distilled water = 0 after correction
            EEPROM.put(EEPROM_EC_OFFSET_ADDR, ecOffset);
            EEPROM.commit();
            USE_SERIAL.printf("CAL:EC:0 → ecOffset=%.1f\n", ecOffset);
          }
          else if (strcmp(calType, "ec_1413") == 0) {
            float temp = readDS18B20();
            int raw = analogRead(TDS_PIN);
            float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
            float ecRawCubic = (133.42 * voltage * voltage * voltage
                              - 255.86 * voltage * voltage
                              + 857.39 * voltage);
            float comp = 1.0 + 0.02 * (temp - 25.0);
            float targetEc = 1413.0 + ecOffset;
            tdsKValue = (targetEc * comp) / ecRawCubic;
            if (tdsKValue > 0.25 && tdsKValue < 4.0) {
              EEPROM.put(EEPROM_K_ADDR, tdsKValue);
              EEPROM.commit();
              USE_SERIAL.printf("CAL:EC:1413 → kValue=%.4f\n", tdsKValue);
            }
          }
          else if (strcmp(calType, "ph_7") == 0) {
            // Single-point: ph7V = V (direct measurement at pH 7.0)
            int raw = analogRead(PH_PIN);
            ph7Voltage = raw / TDS_ADC_RANGE * TDS_VREF;
            EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
            float nanVal = NAN;
            EEPROM.put(EEPROM_CAL_V4_ADDR, nanVal);  // clear pending 2-pt state
            EEPROM.commit();
            USE_SERIAL.printf("CAL:PH:7 → ph7Voltage=%.3fV (slope=%.4f)\n", ph7Voltage, phSlope);
          }
          else if (strcmp(calType, "ph_4") == 0) {
            // Two-point: store V4; if V9 known (from current cal), compute slope
            // pH = 7 - (V - ph7V) / phSlope  →  ph7V = V4 - 3*phSlope
            int raw = analogRead(PH_PIN);
            float v4 = raw / TDS_ADC_RANGE * TDS_VREF;
            EEPROM.put(EEPROM_CAL_V4_ADDR, v4);
            EEPROM.commit();
            USE_SERIAL.printf("CAL:PH:4 → V4=%.3fV stored\n", v4);

            // Back-calc V9 from current calibration: ph7V = V9 + 2.18*phSlope → V9 = ph7V - 2.18*phSlope
            float v9 = ph7Voltage - (9.18 - 7.0) * phSlope;
            if (v9 > 0.1 && v9 < 3.2) {
              float newSlope = (v4 - v9) / (9.18 - 4.00);  // positive: V4 > V9 at higher pH
              if (newSlope > 0.010 && newSlope < 0.300) {
                phSlope = newSlope;
                ph7Voltage = v4 - 3.0 * phSlope;  // anchor from pH 4
                EEPROM.put(EEPROM_PH_SLOPE_ADDR, phSlope);
                EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
                EEPROM.commit();
                USE_SERIAL.printf("CAL:PH:4 → 2-pt: V4=%.3f V9=%.3f slope=%.4f ph7V=%.3f\n",
                                  v4, v9, phSlope, ph7Voltage);
              } else {
                USE_SERIAL.printf("CAL:PH:4 → slope=%.4f out of range (0.010-0.300). Single-pt fallback.\n", newSlope);
                ph7Voltage = v4 - 3.0 * phSlope;  // single-pt with current slope
                EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
                EEPROM.commit();
              }
            } else {
              USE_SERIAL.printf("CAL:PH:4 → single-pt (no prior V9). V4=%.3f stored, send CAL:PH:9 next.\n", v4);
            }
          }
          else if (strcmp(calType, "ph_9") == 0) {
            // Two-point: check if V4 was stored from prior CAL:PH:4
            // pH = 7 - (V - ph7V) / phSlope  →  ph7V = V9 + 2.18*phSlope
            int raw = analogRead(PH_PIN);
            float v9 = raw / TDS_ADC_RANGE * TDS_VREF;

            float storedV4;
            EEPROM.get(EEPROM_CAL_V4_ADDR, storedV4);

            if (!isnan(storedV4) && storedV4 > 0.1 && storedV4 < 3.2) {
              float newSlope = (storedV4 - v9) / (9.18 - 4.00);  // positive: V4 > V9
              if (newSlope > 0.010 && newSlope < 0.300) {
                phSlope = newSlope;
                ph7Voltage = storedV4 - 3.0 * phSlope;  // anchor from pH 4
                EEPROM.put(EEPROM_PH_SLOPE_ADDR, phSlope);
                EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
                float nanVal = NAN;
                EEPROM.put(EEPROM_CAL_V4_ADDR, nanVal);  // clear pending
                EEPROM.commit();
                USE_SERIAL.printf("CAL:PH:9 → 2-pt: V4=%.3f V9=%.3f slope=%.4f ph7V=%.3f\n",
                                  storedV4, v9, phSlope, ph7Voltage);
              } else {
                USE_SERIAL.printf("CAL:PH:9 → slope=%.4f out of range (0.010-0.300). Single-pt fallback.\n", newSlope);
                ph7Voltage = v9 + 2.18 * phSlope;  // single-pt with current slope
                EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
                EEPROM.commit();
              }
            } else {
              // Single-point: no prior V4, compute ph7V from V9 at current slope
              ph7Voltage = v9 + 2.18 * phSlope;
              if (ph7Voltage > 0.1 && ph7Voltage < 3.2) {
                EEPROM.put(EEPROM_PH7_ADDR, ph7Voltage);
                EEPROM.commit();
                USE_SERIAL.printf("CAL:PH:9 → single-pt: V9=%.3f ph7V=%.3f slope=%.4f\n",
                                  v9, ph7Voltage, phSlope);
              } else {
                USE_SERIAL.printf("CAL:PH:9 FAILED — ph7Voltage %.3fV out of range\n", ph7Voltage);
              }
            }
          }

          JsonDocument ack;
          ack["type"] = "ack";
          ack["device_id"] = "esp32-sensor";
          ack["command"] = "calibrate";
          ack["status"] = "ok";
          ack["calType"] = calType;
          ack["esp32_ms"] = millis();
          char buf[128];
          serializeJson(ack, buf);
          webSocket.sendTXT(buf);
        }
      }
      break;
    }

    case WStype_ERROR:
      USE_SERIAL.println("[WS] ERROR");
      break;

    default:
      break;
  }
}

// ── Send telemetry ──────────────────────────────
void sendTelemetry() {
  float temp = readDS18B20();

  float tds = readTDS(temp);
  float ec  = readEC(temp);
  float ph  = readPH();
  bool  led = digitalRead(LED_PIN);

  unsigned long espMs = millis();

  JsonDocument doc;
  doc["type"]      = "telemetry";
  doc["device_id"] = "esp32-sensor";
  doc["tds"]       = round(tds);
  doc["ec"]        = round(ec);
  doc["ph"]        = round(ph * 100) / 100.0;
  doc["temp"]      = round(temp * 10) / 10.0;
  doc["led"]       = led;
  doc["esp32_ms"]  = espMs;

  char buf[256];
  serializeJson(doc, buf);
  webSocket.sendTXT(buf);

  int tdsRaw = analogRead(TDS_PIN);
  int phRaw  = analogRead(PH_PIN);
  USE_SERIAL.printf("DATA → TDS=%.0f EC=%.0f pH=%.2f T=%.1f°C LED=%d  [ADC tds=%d ph=%d]\n",
                    tds, ec, ph, temp, led, tdsRaw, phRaw);
}

// ── Setup ───────────────────────────────────────
void setup() {
  USE_SERIAL.begin(115200);
  USE_SERIAL.setDebugOutput(true);

  pinMode(LED_PIN, OUTPUT);
  setLED(false);

  EEPROM.begin(512);
  loadCalibration();

  ds18b20.begin();
  USE_SERIAL.print("DS18B20: ");
  int nSensors = ds18b20.getDS18Count();
  USE_SERIAL.printf("%d sensor(s) found\n", nSensors);
  if (nSensors > 0) {
    DeviceAddress addr;
    ds18b20.getAddress(addr, 0);
    USE_SERIAL.print("  Addr: ");
    for (int i = 0; i < 8; i++) {
      USE_SERIAL.printf("%02X", addr[i]);
    }
    USE_SERIAL.println();
  }

  USE_SERIAL.println();
  USE_SERIAL.println("=== IoT Hub — Sensor Hub ===");
  USE_SERIAL.println();

  // Wi-Fi
  wifiMulti.addAP(WIFI_SSID, WIFI_PASS);
  USE_SERIAL.printf("WiFi: Connecting to %s...\n", WIFI_SSID);
  while (wifiMulti.run() != WL_CONNECTED) {
    delay(500);
    USE_SERIAL.print(".");
  }
  USE_SERIAL.println();
  USE_SERIAL.printf("WiFi: Connected. IP = %s\n", WiFi.localIP().toString().c_str());

  // NTP
  syncTime();

  // WebSocket
  USE_SERIAL.printf("WSS:  Connecting to wss://%s:%d%s\n", WS_HOST, WS_PORT, WS_PATH);
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 4)
  webSocket.beginSslWithBundle(WS_HOST, WS_PORT, WS_PATH, NULL, 0, "");
#else
  webSocket.beginSslWithBundle(WS_HOST, WS_PORT, WS_PATH, NULL, "");
#endif
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

// ── Loop ────────────────────────────────────────
void loop() {
  webSocket.loop();
  handleSerialCalibration();

  if (timeSynced && webSocket.isConnected()) {
    unsigned long now = millis();
    if (now - lastPingMs >= PING_INTERVAL_MS) {
      sendTelemetry();
      lastPingMs = now;
    }
  }
}
