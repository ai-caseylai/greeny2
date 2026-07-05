/*
 * IoT Hub — Sensor Hub
 * ESP32-WROOM-32E + DFRobot TDS + pH + DS18B20 + WSS → Cloudflare DO
 * 
 * Pins: LED=GPIO2, DS18B20=GPIO13, TDS=GPIO36(ADC1), pH=GPIO39(ADC1)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <EEPROM.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ── CONFIG ──────────────────────────────────────
const char* WIFI_SSID     = "YOUR_SSID";
const char* WIFI_PASS     = "YOUR_PASSWORD";

const char* WS_HOST       = "iot-hub.funconnect.workers.dev";
const uint16_t WS_PORT    = 443;
const char* WS_PATH       = "/device/esp32-sensor";

#define LED_PIN             2
#define ONEWIRE_PIN         13
#define TDS_PIN             35    // ADC1 — GPIO 35, blue LED lit
#define PH_PIN              39    // ADC1 — 5V column
#define OLED_SDA            21
#define OLED_SCL            22
#define OLED_WIDTH          128
#define OLED_HEIGHT         64
#define OLED_ADDR           0x3C

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
#define EEPROM_WIFI_FLAG_ADDR   40    // 0xAB = custom WiFi stored
#define EEPROM_WIFI_SSID_ADDR   41    // 33 bytes SSID
#define EEPROM_WIFI_PASS_ADDR   74    // 65 bytes password
// ─────────────────────────────────────────────────

WebSocketsClient webSocket;
WiFiServer captiveServer(80);
bool inAPMode = false;

OneWire oneWire(ONEWIRE_PIN);
DallasTemperature ds18b20(&oneWire);
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

unsigned long lastPingMs = 0;
unsigned long lastInboundMs = 0;    // watchdog: last time DO sent us anything
uint32_t pingSeq = 0;
bool timeSynced = false;
float tdsKValue = 0.094;   // inverted board: 200/2126 ratio from tap water
float ecOffset = 2275.0;     // EC zero-point — calibrated for inverted board in distilled
float ph7Voltage = 1.65;  // voltage at pH 7.0, loaded from EEPROM (default: 3.3/2)
float phSlope = 0.059;    // pH slope in V/pH, loaded from EEPROM (default: 0.059)

// ── WiFi credential storage ──────────────────────
char wifiSsid[33] = "";
char wifiPass[65] = "";
bool wifiProvisioned = false;
bool wifiReconnecting = false;
char wifiOldSsid[33] = "";
char wifiOldPass[65] = "";
unsigned long wifiReconnectStart = 0;
bool wifiPendingAck = false;
char wifiPendingAckJson[128] = "";
#define WIFI_RECONNECT_TIMEOUT_MS 15000

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
  // Board outputs voltage that DROPS with conductivity (inverted).
  // ecOffset captured at distilled (highest V) → EC = V_drop.
  return (ecOffset - ecRaw) / (1.0 + 0.02 * (temp - 25.0));
}

float readPH() {
  int raw = analogRead(PH_PIN);
  float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
  // pH = 7.0 - (V - ph7Voltage) / phSlope   (Nernst: V decreases as pH increases)
  float ph = 7.0 - (voltage - ph7Voltage) / phSlope;
  return ph;
}

// ── OLED display ────────────────────────────────
void oledInit() {
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    USE_SERIAL.println("OLED: not found");
    return;
  }
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("  GREENY SENSOR");
  display.println("   Booting...");
  display.display();
  USE_SERIAL.println("OLED: initialized");
}

void oledUpdate(float ph, float ec, float tds, float temp, bool led,
                bool wifiOk, bool wssOk, const char* ip) {
  static unsigned long lastOledMs = 0;
  // Throttle to 1s to avoid I2C blocking telemetry
  if (millis() - lastOledMs < 1000) return;
  lastOledMs = millis();

  display.clearDisplay();
  display.setCursor(0, 0);

  display.print("GREENY esp32-sensor");
  display.setCursor(0, 10);
  display.printf("pH:%05.2f TDS:%04.0f", ph, tds);
  display.setCursor(0, 20);
  display.printf("EC:%.0f uS/cm", ec);
  display.setCursor(0, 30);
  display.printf("Temp: %05.1f C", temp);
  display.setCursor(0, 40);
  display.printf("LED:%s WiFi:%s WSS:%s",
                 led ? "ON " : "OFF", wifiOk ? "OK" : "--", wssOk ? "OK" : "--");
  display.setCursor(0, 50);
  display.print(ip);

  // Uptime on last row
  unsigned long uptimeSec = millis() / 1000;
  display.setCursor(0, 57);
  display.printf("UP:%02lu:%02lu:%02lu",
                 uptimeSec / 3600, (uptimeSec % 3600) / 60, uptimeSec % 60);

  display.display();
}

// ── WiFi credential helpers ─────────────────────-
void loadWiFiCredentials() {
  uint8_t flag;
  EEPROM.get(EEPROM_WIFI_FLAG_ADDR, flag);
  wifiProvisioned = (flag == 0xAB);
  if (wifiProvisioned) {
    EEPROM.get(EEPROM_WIFI_SSID_ADDR, wifiSsid);
    EEPROM.get(EEPROM_WIFI_PASS_ADDR, wifiPass);
    // Validate
    if (wifiSsid[0] == '\0' || strlen(wifiSsid) > 32 || wifiSsid[0] == (char)0xFF) {
      wifiProvisioned = false;
    }
  }
  if (wifiProvisioned) {
    USE_SERIAL.printf("WiFi: Using EEPROM credentials: %s\n", wifiSsid);
  } else {
    strcpy(wifiSsid, WIFI_SSID);
    strcpy(wifiPass, WIFI_PASS);
    USE_SERIAL.printf("WiFi: Using compiled defaults: %s\n", wifiSsid);
  }
}

void saveWiFiCredentials(const char* ssid, const char* pass) {
  strncpy(wifiSsid, ssid, 32); wifiSsid[32] = '\0';
  strncpy(wifiPass, pass, 64); wifiPass[64] = '\0';
  wifiProvisioned = true;
  uint8_t flag = 0xAB;
  EEPROM.put(EEPROM_WIFI_FLAG_ADDR, flag);
  EEPROM.put(EEPROM_WIFI_SSID_ADDR, wifiSsid);
  EEPROM.put(EEPROM_WIFI_PASS_ADDR, wifiPass);
  EEPROM.commit();
  USE_SERIAL.printf("WiFi: Saved credentials: %s\n", wifiSsid);
}

// ── WiFi event handler (non-blocking) ────────────
void wifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      USE_SERIAL.printf("WiFi: Got IP = %s\n", WiFi.localIP().toString().c_str());
      wifiReconnecting = false;
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
      uint8_t reason = info.wifi_sta_disconnected.reason;
      USE_SERIAL.printf("WiFi: Disconnected (reason=%d)\n", reason);
      if (wifiReconnecting) {
        // wifi_set is in progress — don't auto-reconnect, let wifi_set handle it
      } else {
        USE_SERIAL.println("WiFi: Auto-reconnecting...");
        WiFi.begin(wifiSsid, wifiPass);
      }
      break;
    }
    default: break;
  }
}

void wifiConnectBlocking() {
  WiFi.onEvent(wifiEvent);
  WiFi.begin(wifiSsid, wifiPass);
  USE_SERIAL.printf("WiFi: Connecting to %s...\n", wifiSsid);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 30000) {
    delay(500);
    USE_SERIAL.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    USE_SERIAL.println();
    USE_SERIAL.printf("WiFi: Connected. IP = %s\n", WiFi.localIP().toString().c_str());
  } else {
    USE_SERIAL.println("\nWiFi: FAILED to connect");
  }
}

// ── EEPROM helpers ──────────────────────────────
void loadCalibration() {
  float savedK = tdsKValue;
  EEPROM.get(EEPROM_K_ADDR, tdsKValue);
  if (isnan(tdsKValue) || tdsKValue < 0.001 || tdsKValue > 10.0) {
    tdsKValue = savedK;  // restore compiled default
  }

  float savedEcOffset = ecOffset;
  EEPROM.get(EEPROM_EC_OFFSET_ADDR, ecOffset);
  // Inverted board: ecOffset can be up to 5000. 0 = uncalibrated.
  if (isnan(ecOffset) || ecOffset == 0 || ecOffset < -1000 || ecOffset > 5000) {
    ecOffset = savedEcOffset;  // restore compiled default
  }

  float savedPH7 = ph7Voltage;
  EEPROM.get(EEPROM_PH7_ADDR, ph7Voltage);
  if (isnan(ph7Voltage) || ph7Voltage < 0.1 || ph7Voltage > 3.2) {
    ph7Voltage = savedPH7;
  }

  float savedSlope = phSlope;
  EEPROM.get(EEPROM_PH_SLOPE_ADDR, phSlope);
  if (isnan(phSlope) || phSlope < 0.010 || phSlope > 0.300) {
    phSlope = savedSlope;
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
      // Flush any pending wifi_ack
      if (wifiPendingAck) {
        wifiPendingAck = false;
        webSocket.sendTXT(wifiPendingAckJson);
        USE_SERIAL.printf("WIFI_ACK → %s\n", wifiPendingAckJson);
      }
      break;

    case WStype_TEXT: {
      lastInboundMs = millis();  // watchdog: DO→ESP32 path is alive
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
        else if (command && strcmp(command, "wifi_scan") == 0) {
          USE_SERIAL.println("CMD  ← wifi_scan");
          // DO passthrough format: {"command":"wifi_scan","device_id":"...","params":{...},"ts":...}
          // params.action optionally "async" to return immediately
          int n = WiFi.scanNetworks(false, true);
          JsonDocument list;
          list["type"] = "wifi_list";
          list["device_id"] = "esp32-sensor";
          JsonArray nets = list["networks"].to<JsonArray>();
          for (int i = 0; i < n && i < 20; i++) {
            JsonObject net = nets.add<JsonObject>();
            net["ssid"] = WiFi.SSID(i);
            net["rssi"] = WiFi.RSSI(i);
            net["enc"]  = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
          }
          WiFi.scanDelete();
          char buf[1024];
          serializeJson(list, buf);
          webSocket.sendTXT(buf);
          USE_SERIAL.printf("WIFI_SCAN: found %d networks, sent wifi_list\n", n);
        }
        else if (command && strcmp(command, "wifi_set") == 0) {
          const char* newSsid = doc["params"]["ssid"];
          const char* newPass = doc["params"]["pass"];
          USE_SERIAL.printf("CMD  ← wifi_set: %s\n", newSsid ? newSsid : "(null)");
          if (!newSsid || !newPass || strlen(newSsid) == 0) {
            JsonDocument ack;
            ack["type"] = "wifi_ack";
            ack["command"] = "wifi_set";
            ack["status"] = "error";
            ack["msg"] = "Missing ssid or pass";
            char buf[128];
            serializeJson(ack, buf);
            webSocket.sendTXT(buf);
          } else {
            // Save old credentials as fallback
            strncpy(wifiOldSsid, wifiSsid, 32);
            strncpy(wifiOldPass, wifiPass, 64);
            // Store and try new credentials
            saveWiFiCredentials(newSsid, newPass);
            USE_SERIAL.printf("WiFi: Switching to %s...\n", newSsid);
            wifiReconnecting = true;
            wifiReconnectStart = millis();
            WiFi.disconnect(true);
            delay(200);
            WiFi.begin(newSsid, newPass);
            // Non-blocking: result handled in loop()
          }
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
            // Inverted board: EC = (ecOffset - ecRawCubic * kValue) / comp
            // → kValue = (ecOffset - 1413 * comp) / ecRawCubic
            tdsKValue = (ecOffset - 1413.0 * comp) / ecRawCubic;
            if (tdsKValue > 0.001 && tdsKValue < 10.0) {
              EEPROM.put(EEPROM_K_ADDR, tdsKValue);
              EEPROM.commit();
              USE_SERIAL.printf("CAL:EC:1413 → kValue=%.4f\n", tdsKValue);
            }
          }
          else if (strcmp(calType, "ec_value") == 0) {
            // Generic span calibration with user-supplied reference value.
            // Send: {"command":"calibrate","params":{"type":"ec_value","value":200}}
            // Inverted board: EC = (ecOffset - ecRawCubic * kValue) / comp
            // → kValue = (ecOffset - targetEC * comp) / ecRawCubic
            float refValue = doc["params"]["value"];
            if (refValue > 0) {
              float temp = readDS18B20();
              int raw = analogRead(TDS_PIN);
              float voltage = raw / TDS_ADC_RANGE * TDS_VREF;
              float ecRawCubic = (133.42 * voltage * voltage * voltage
                                - 255.86 * voltage * voltage
                                + 857.39 * voltage);
              float comp = 1.0 + 0.02 * (temp - 25.0);
              tdsKValue = (ecOffset - refValue * comp) / ecRawCubic;
              if (tdsKValue > 0.001 && tdsKValue < 10.0) {
                EEPROM.put(EEPROM_K_ADDR, tdsKValue);
                EEPROM.commit();
                USE_SERIAL.printf("CAL:EC:VALUE(%.0f) → kValue=%.4f\n", refValue, tdsKValue);
              }
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

  oledUpdate(ph, ec, tds, temp, led,
             WiFi.status() == WL_CONNECTED, webSocket.isConnected(),
             WiFi.localIP().toString().c_str());
}

// ── Captive Portal HTML (dark theme, matches dashboard) ──
static const char CP_HTML[] PROGMEM =
"<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
"<title>Greeny Alpha — WiFi Setup</title>"
"<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;"
"display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}"
"form{background:#1e293b;padding:30px;border-radius:12px;width:360px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5)}"
"h2{color:#38bdf8;text-align:center;margin-bottom:20px}"
"label{display:block;margin-top:14px;font-size:13px;color:#94a3b8}"
"input,select{width:100%;padding:10px;margin-top:4px;border:1px solid #334155;border-radius:8px;"
"background:#0f172a;color:#e2e8f0;font-size:14px;box-sizing:border-box}"
"button{width:100%;padding:12px;margin-top:18px;background:#00a65a;border:none;border-radius:8px;"
"color:#fff;font-size:15px;cursor:pointer;font-weight:600}"
"button:hover{background:#00954f}"
"button.scan{background:#334155;margin-top:6px;font-size:12px;padding:8px}"
"button.scan:hover{background:#475569}"
".msg{text-align:center;font-size:12px;margin-top:12px;color:#64748b}"
"</style></head><body><form method='POST' action='/save'>"
"<h2>Greeny Alpha WiFi</h2>"
"<label>Network</label>"
"<input id='ssid' name='ssid' list='ssid-list' placeholder='Select network...' required>"
"<datalist id='ssid-list'></datalist>"
"<button type='button' class='scan' onclick='scanWiFi()'>Scan Networks</button>"
"<label>Password</label><input name='pass' id='pass' type='password' placeholder='WiFi password'>"
"<button type='submit'>Save &amp; Reboot</button>"
"<p class='msg'>ESP32 will restart with new WiFi settings</p>"
"</form>"
"<script>"
"async function scanWiFi(){"
"var b=document.querySelector('.scan');b.textContent='Scanning...';b.disabled=true;"
"try{"
"var r=await fetch('/scan');var data=await r.json();"
"var list=document.getElementById('ssid-list');list.innerHTML='';"
"data.forEach(function(s){var o=document.createElement('option');o.value=s;list.appendChild(o);});"
"var sel=document.getElementById('ssid');if(data.length>0){sel.value=data[0];sel.focus();}"
"}catch(e){}"
"b.textContent='Scan Networks';b.disabled=false;}"
"scanWiFi();"
"</script></body></html>";

static const char CP_OK[] PROGMEM =
"<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
"<title>Saved</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
"background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}"
"div{text-align:center}h2{color:#00a65a}p{color:#94a3b8}</style></head>"
"<body><div><h2>WiFi Saved!</h2><p>ESP32 is rebooting...</p></div></body></html>";

static String urlDecode(String s) {
  String r;
  for (unsigned i = 0; i < s.length(); i++) {
    if (s[i] == '%' && i+2 < s.length()) {
      char hi = s[++i], lo = s[++i];
      int h = (hi >= 'A') ? (hi & 0xDF) - 'A' + 10 : hi - '0';
      int l = (lo >= 'A') ? (lo & 0xDF) - 'A' + 10 : lo - '0';
      r += (char)((h << 4) | l);
    } else if (s[i] == '+') r += ' ';
    else r += s[i];
  }
  return r;
}

void startCaptivePortal() {
  WiFi.softAP("Greeny-Alpha-Setup");
  USE_SERIAL.println("AP: Greeny-Alpha-Setup started — 192.168.4.1");
  captiveServer.begin();
}

void handleCaptivePortal() {
  WiFiClient client = captiveServer.accept();
  if (!client) return;

  // Read request with timeout
  String req = "";
  unsigned long t = millis();
  while (client.connected() && millis() - t < 3000) {
    while (client.available()) {
      char c = client.read();
      req += c;
    }
    if (req.indexOf("\r\n\r\n") >= 0) break;
  }
  if (req.length() == 0) { client.stop(); return; }

  if (req.indexOf("GET /scan") >= 0) {
    int n = WiFi.scanComplete();
    if (n <= 0) { WiFi.scanNetworks(true, true, false); client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[]"); }
    else {
      String json = "[";
      for (int i = 0; i < n; i++) {
        if (i) json += ",";
        json += "\"" + WiFi.SSID(i) + "\"";
      }
      WiFi.scanDelete();
      client.print("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n" + json + "]");
    }
  }
  else if (req.indexOf("POST /save") >= 0) {
    // Read body
    while (client.available()) { req += (char)client.read(); }
    int ss = req.indexOf("ssid="), ps = req.indexOf("pass=");
    if (ss >= 0 && ps >= 0) {
      String sid = req.substring(ss+5, req.indexOf('&', ss));
      String pw = req.substring(ps+5, req.indexOf('&', ps) > 0 ? req.indexOf('&', ps) : req.length());
      sid = urlDecode(sid); pw = urlDecode(pw);
      if (sid.length() > 0 && sid.length() < 33) {
        client.print("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n" + String(CP_OK));
        client.stop();
        sid.toCharArray(wifiSsid, 33); pw.toCharArray(wifiPass, 65);
        EEPROM.put(EEPROM_WIFI_FLAG_ADDR, (uint8_t)0xAB);
        EEPROM.put(EEPROM_WIFI_SSID_ADDR, wifiSsid);
        EEPROM.put(EEPROM_WIFI_PASS_ADDR, wifiPass);
        EEPROM.commit();
        delay(1500);
        ESP.restart();
      }
    }
  }
  else {
    client.print("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n" + String(CP_HTML));
  }
  delay(100);
  client.stop();
}

// ── Setup ───────────────────────────────────────
void setup() {
  USE_SERIAL.begin(115200);
  USE_SERIAL.setDebugOutput(true);

  pinMode(LED_PIN, OUTPUT);
  setLED(false);

  EEPROM.begin(512);
  loadCalibration();
  // Force calibration for inverted board (override any EEPROM corruption)
  tdsKValue = 0.088;
  ecOffset = 201.0;
  EEPROM.put(EEPROM_K_ADDR, tdsKValue);
  EEPROM.put(EEPROM_EC_OFFSET_ADDR, ecOffset);
  EEPROM.commit();

  oledInit();

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

  // Wi-Fi — load credentials from EEPROM or use compiled defaults
  loadWiFiCredentials();
  wifiConnectBlocking();

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

  // ── wifi_set result monitoring (non-blocking) ──
  if (wifiReconnecting) {
    if (WiFi.status() == WL_CONNECTED) {
      wifiReconnecting = false;
      String newIp = WiFi.localIP().toString();
      USE_SERIAL.printf("WiFi: Reconnected! IP = %s\n", newIp.c_str());
      JsonDocument ack;
      ack["type"] = "wifi_ack";
      ack["command"] = "wifi_set";
      ack["status"] = "ok";
      ack["ip"] = newIp;
      serializeJson(ack, wifiPendingAckJson);
      wifiPendingAck = true;
    } else if (millis() - wifiReconnectStart > WIFI_RECONNECT_TIMEOUT_MS) {
      wifiReconnecting = false;
      USE_SERIAL.println("WiFi: New network FAILED — falling back to previous");
      if (wifiOldSsid[0] != '\0') {
        saveWiFiCredentials(wifiOldSsid, wifiOldPass);
        WiFi.disconnect(true);
        delay(200);
        WiFi.begin(wifiOldSsid, wifiOldPass);
      } else {
        strcpy(wifiSsid, WIFI_SSID);
        strcpy(wifiPass, WIFI_PASS);
        WiFi.disconnect(true);
        delay(200);
        WiFi.begin(WIFI_SSID, WIFI_PASS);
      }
      JsonDocument ack;
      ack["type"] = "wifi_ack";
      ack["command"] = "wifi_set";
      ack["status"] = "error";
      ack["msg"] = "Connection failed, reverted to previous network";
      serializeJson(ack, wifiPendingAckJson);
      wifiPendingAck = true;
    }
  }

  if (timeSynced && webSocket.isConnected()) {
    unsigned long now = millis();

    // Watchdog: if DO→ESP32 path is broken (half-open after deploy),
    // we sent telemetry but received nothing back for 30s. Force reconnect.
    if (lastInboundMs > 0 && now - lastInboundMs > 30000) {
      USE_SERIAL.println("[WD] No inbound data for 30s — forcing reconnect");
      webSocket.disconnect();
      lastInboundMs = 0;
      return;
    }

    if (now - lastPingMs >= PING_INTERVAL_MS) {
      sendTelemetry();
      lastPingMs = now;
    }
  }
}
