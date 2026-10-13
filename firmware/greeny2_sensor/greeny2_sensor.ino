/*
 * Greeny2 — ESP32 感測器客戶端（Arduino / 精簡版）
 * =================================================
 *
 * 與 `firmware/esp32/esp32.ino`（完整版，含 OLED 顯示、Captive Portal、EEPROM 校正）
 * 走**完全相同的協定**，但只保留必要邏輯，方便閱讀與修改。
 *
 * 行為
 * ----
 *   * 連線   wss://<WS_HOST>/device/<DEVICE_ID>?token=<WS_TOKEN>
 *   * 每 10 秒送一次 telemetry（tds / ec / ph / temp / led / esp32_ms）
 *   * 每 10 秒送一次 ping（心跳；DO 會回 pong）
 *   * 接收 sync / set_led / calibrate / wifi_scan / wifi_set，並回 ack
 *   * 30 秒沒有收到任何 inbound → 強制重連（修復 Worker 部署後的半開連線）
 *   * WiFi 斷線自動重連
 *
 * 憑證
 * ----
 *   WiFi 帳密與 device token 放在**同資料夾**的 `device_secrets.h`：
 *
 *       #define WIFI_SSID  "你的WiFi"
 *       #define WIFI_PASS  "你的密碼"
 *       #define WS_TOKEN   "D1_settings.device_token"
 *
 *   該檔已列入 .gitignore，**不要提交進 repo**。
 *   device token 必須與 D1 `settings` 表的 `device_token` 相同，否則 Worker 會回 401。
 *
 * 資料夾命名
 * ----------
 *   Arduino IDE 要求「資料夾名稱 = .ino 檔名」。請保持：
 *       greeny2_sensor/
 *         ├── greeny2_sensor.ino   ← 本檔
 *         └── device_secrets.h     ← 憑證（不上傳）
 *
 * 燒錄
 * ----
 *   arduino-cli compile --fqbn esp32:esp32:esp32 firmware/greeny2_sensor
 *   arduino-cli upload  --fqbn esp32:esp32:esp32 -p COM3 firmware/greeny2_sensor
 *   arduino-cli monitor -p COM3 -c baudrate=115200
 *
 *   需要的函式庫：
 *     arduino-cli lib install WebSockets@2.7.2
 *     arduino-cli lib install ArduinoJson@7.4.3
 *     arduino-cli lib install OneWire@2.3.8
 *     arduino-cli lib install DallasTemperature@4.0.6
 *
 * 硬體腳位
 * --------
 *   LED            GPIO 2
 *   TDS (SEN0244)  GPIO 35   （ADC1）
 *   pH + 放大板    GPIO 39   （ADC1）
 *   DS18B20        GPIO 13   （OneWire）
 *
 *   ⚠️ 只能用 ADC1（GPIO 32–39）—— WiFi 開啟時 ADC2 不可用。
 *
 * ✅ 已用 arduino-cli 1.5.1 + esp32 core 3.3.12 編譯通過：
 *      Sketch uses 1115705 bytes (85%) of program storage space.
 *      Global variables use 48456 bytes (14%) of dynamic memory.
 *    ⚠️ 尚未在實體硬體上執行過；邏輯與 API 用法取自已在實機運行的
 *       firmware/esp32/esp32.ino。
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ── 憑證（同資料夾的 device_secrets.h，已 gitignore）──────────────────────────
#if __has_include("device_secrets.h")
  #include "device_secrets.h"
#endif
#ifndef WIFI_SSID
  #define WIFI_SSID "YOUR_SSID"
#endif
#ifndef WIFI_PASS
  #define WIFI_PASS "YOUR_PASSWORD"
#endif
#ifndef WS_TOKEN
  #define WS_TOKEN "REPLACE_WITH_DEVICE_TOKEN"   // 佔位值：Worker 會回 401
#endif

// ── 連線設定 ────────────────────────────────────────────────────────────────
const char*    WS_HOST = "iot-hub.ai-caseylai.workers.dev";
const uint16_t WS_PORT = 443;
const char*    DEVICE_ID = "esp32-sensor";        // 對應 /device/<DEVICE_ID>

// ── 時序 ────────────────────────────────────────────────────────────────────
const uint32_t TELEMETRY_INTERVAL_MS = 10000;     // 遙測 + ping 間隔
const uint32_t WATCHDOG_MS           = 30000;     // 超過此時間無 inbound → 重連
const uint32_t SERIAL_BAUD           = 115200;

// ── 腳位 ────────────────────────────────────────────────────────────────────
const uint8_t LED_PIN      = 2;
const uint8_t TDS_PIN      = 35;                  // ADC1
const uint8_t PH_PIN       = 39;                  // ADC1
const uint8_t ONEWIRE_PIN  = 13;

// ── 校正常數（要持久化請參考完整版的 EEPROM 作法）────────────────────────────
float kValue     = 1.0;      // EC 斜率
float ecOffset   = 0.0;      // EC 零點偏移
float ph7Voltage = 1.65;     // pH 7.0 對應電壓
const float VREF = 3.3;

// ── 全域狀態 ────────────────────────────────────────────────────────────────
WebSocketsClient webSocket;
OneWire          oneWire(ONEWIRE_PIN);
DallasTemperature ds18b20(&oneWire);

uint32_t lastTelemetryMs = 0;
uint32_t lastInboundMs   = 0;     // 任何 inbound 都會更新（看門狗用）
bool     timeSynced      = false;
bool     ledState        = false;

// wifi_set 的回滾狀態
String   wifiCurSsid = WIFI_SSID;
String   wifiCurPass = WIFI_PASS;
String   wifiOldSsid, wifiOldPass;
bool     wifiReconnecting = false;
uint32_t wifiReconnectStart = 0;
const uint32_t WIFI_RECONNECT_TIMEOUT_MS = 20000;

// ─────────────────────────────────────────────────────────────────────────────
// WiFi / NTP
// ─────────────────────────────────────────────────────────────────────────────

bool connectWiFi(const char* ssid, const char* pass, uint32_t timeoutMs = 30000) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WiFi OK  IP=%s  RSSI=%d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
  }
  Serial.println("WiFi FAILED");
  return false;
}

void syncTime() {
  // ESP32 沒有電池 RTC，開機時間是 1970 → TLS 憑證會被當成「已過期」而握手失敗。
  // 一定要在連 WSS 之前完成對時。
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("NTP syncing");
  const uint32_t start = millis();
  while (time(nullptr) < 8 * 3600 * 2 && millis() - start < 20000) {
    delay(200);
    Serial.print(".");
  }
  timeSynced = (time(nullptr) > 8 * 3600 * 2);
  Serial.println(timeSynced ? " OK" : " FAILED");
}

// ─────────────────────────────────────────────────────────────────────────────
// 感測器
// ─────────────────────────────────────────────────────────────────────────────

inline float adcVoltage(uint8_t pin) {
  return analogRead(pin) / 4096.0f * VREF;
}

float readWaterTemp() {
  ds18b20.requestTemperatures();
  const float t = ds18b20.getTempCByIndex(0);
  return (t == DEVICE_DISCONNECTED_C) ? 25.0f : t;   // 沒接探頭時給合理值
}

// DFRobot SEN0244：三次多項式 → 先扣 offset，再做溫度補償（順序不可交換）
float readEC(float temp) {
  const float v  = adcVoltage(TDS_PIN);
  const float raw = (133.42f * v * v * v - 255.86f * v * v + 857.39f * v) * kValue;
  return (raw - ecOffset) / (1.0f + 0.02f * (temp - 25.0f));
}

float readTDS(float temp) { return readEC(temp) * 0.5f; }

float readPH() {
  // Nernst：pH = 7 + (V - V@pH7) / 0.059
  return 7.0f + (adcVoltage(PH_PIN) - ph7Voltage) / 0.059f;
}

// ─────────────────────────────────────────────────────────────────────────────
// 傳送
// ─────────────────────────────────────────────────────────────────────────────

void sendJson(JsonDocument& doc) {
  char buf[384];
  const size_t n = serializeJson(doc, buf, sizeof(buf));
  webSocket.sendTXT(buf, n);
}

void sendAck(const char* command, const char* status) {
  JsonDocument doc;
  doc["type"]      = "ack";
  doc["device_id"] = DEVICE_ID;
  doc["command"]   = command;
  doc["status"]    = status;
  doc["led"]       = ledState;
  doc["esp32_ms"]  = millis();
  sendJson(doc);
}

void sendTelemetry() {
  const float temp = readWaterTemp();
  const float ec   = readEC(temp);

  JsonDocument doc;
  doc["type"]      = "telemetry";
  doc["device_id"] = DEVICE_ID;
  doc["tds"]       = round(readTDS(temp));
  doc["ec"]        = round(ec);
  doc["ph"]        = round(readPH() * 100) / 100.0;
  doc["temp"]      = round(temp * 10) / 10.0;
  doc["led"]       = ledState;
  doc["esp32_ms"]  = millis();
  sendJson(doc);

  Serial.printf("TX  EC=%.0f TDS=%.0f pH=%.2f T=%.1f LED=%d\n",
                ec, readTDS(temp), readPH(), temp, ledState ? 1 : 0);
}

void sendPing() {
  JsonDocument doc;
  doc["type"]      = "ping";
  doc["device_id"] = DEVICE_ID;
  doc["seq"]       = millis() / 1000;
  sendJson(doc);
}

// ─────────────────────────────────────────────────────────────────────────────
// 指令處理
// ─────────────────────────────────────────────────────────────────────────────

void doWifiScan() {
  const int n = WiFi.scanNetworks();
  JsonDocument doc;
  doc["type"]      = "wifi_list";
  doc["device_id"] = DEVICE_ID;
  JsonArray nets = doc["networks"].to<JsonArray>();
  for (int i = 0; i < n; i++) {
    JsonObject o = nets.add<JsonObject>();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["enc"]  = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? 0 : 1;
  }
  sendJson(doc);
  Serial.printf("wifi_scan → %d networks\n", n);
  WiFi.scanDelete();
}

void doWifiSet(JsonObject params) {
  const char* ssid = params["ssid"] | "";
  const char* pass = params["pass"] | "";
  if (strlen(ssid) == 0) { sendAck("wifi_set", "error"); return; }

  wifiOldSsid = wifiCurSsid;
  wifiOldPass = wifiCurPass;
  wifiCurSsid = ssid;
  wifiCurPass = pass;

  Serial.printf("wifi_set → %s\n", ssid);
  WiFi.disconnect(true);
  delay(200);
  WiFi.begin(ssid, pass);
  wifiReconnecting  = true;
  wifiReconnectStart = millis();
}

void doCalibrate(JsonObject params) {
  const char* type = params["type"] | "";
  const float vTds = adcVoltage(TDS_PIN);
  const float vPh  = adcVoltage(PH_PIN);

  if (strcmp(type, "reset") == 0) {
    kValue = 1.0f; ecOffset = 0.0f; ph7Voltage = 1.65f;
    Serial.println("CAL:RESET → defaults");
    sendAck("calibrate", "ok");
    return;
  }

  // 本精簡版只回報量測電壓，不持久化：
  //   ph_7  → 把回報的 v_ph 寫進 ph7Voltage
  //   ec_zero / ec_1413 / ec_value → 依回報電壓推算 ecOffset / kValue
  JsonDocument out;
  out["type"]      = "ack";
  out["device_id"] = DEVICE_ID;
  out["command"]   = "calibrate";
  out["status"]    = "ok";
  out["esp32_ms"]  = millis();
  JsonObject p = out["params"].to<JsonObject>();
  p["type"]   = type;
  p["v_tds"]  = round(vTds * 10000) / 10000.0;
  p["v_ph"]   = round(vPh  * 10000) / 10000.0;
  p["note"]   = "value reported only - write it into the constants above";
  sendJson(out);
  Serial.printf("calibrate %s → v_tds=%.4f v_ph=%.4f\n", type, vTds, vPh);
}

void handleText(const char* payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) {
    Serial.println("bad json");
    return;
  }

  // 連線後 DO 會主動送 sync，告知目前的 LED 狀態
  if (doc["type"] == "sync") {
    ledState = doc["led"] | false;
    digitalWrite(LED_PIN, ledState ? HIGH : LOW);
    Serial.printf("sync  led=%d\n", ledState ? 1 : 0);
    return;
  }
  if (doc["type"] == "pong") return;          // 心跳回應

  const char* command = doc["command"] | "";
  if (strlen(command) == 0) return;

  // 注意：雲端 → 裝置的指令，參數一律包在 params 內
  JsonObject params = doc["params"].as<JsonObject>();

  if (strcmp(command, "set_led") == 0) {
    ledState = params["state"] | false;
    digitalWrite(LED_PIN, ledState ? HIGH : LOW);
    sendAck("set_led", "ok");
    Serial.printf("set_led → %d\n", ledState ? 1 : 0);
  } else if (strcmp(command, "wifi_scan") == 0) {
    doWifiScan();
  } else if (strcmp(command, "wifi_set") == 0) {
    doWifiSet(params);
  } else if (strcmp(command, "calibrate") == 0) {
    doCalibrate(params);
  } else {
    Serial.printf("unknown command: %s\n", command);
    sendAck(command, "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket 事件
// ─────────────────────────────────────────────────────────────────────────────

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("WSS connected");
      lastInboundMs = millis();
      break;

    case WStype_DISCONNECTED:
      Serial.println("WSS disconnected");
      break;

    case WStype_TEXT:
      lastInboundMs = millis();        // 看門狗：DO→裝置 這條路是活的
      handleText((const char*)payload);
      break;

    case WStype_ERROR:
      Serial.println("WSS error");
      break;

    default:
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// setup / loop
// ─────────────────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(300);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  analogReadResolution(12);
  analogSetPinAttenuation(TDS_PIN, ADC_11db);
  analogSetPinAttenuation(PH_PIN,  ADC_11db);

  ds18b20.begin();

  Serial.println();
  Serial.println("=== Greeny2 ESP32 sensor (lean) ===");
  Serial.printf("device_id = %s\n", DEVICE_ID);

  if (!connectWiFi(WIFI_SSID, WIFI_PASS)) {
    Serial.println("WiFi failed at boot — restarting in 5s");
    delay(5000);
    ESP.restart();
  }

  syncTime();

  // 憑證（device token）放在 query string
  char wsPath[192];
  snprintf(wsPath, sizeof(wsPath), "/device/%s?token=%s", DEVICE_ID, WS_TOKEN);

  Serial.printf("WSS: wss://%s:%u/device/%s?token=***\n", WS_HOST, WS_PORT, DEVICE_ID);

  // NULL, 0, "" → 使用 ESP32 內建 CA bundle（不要自己塞憑證）
  webSocket.beginSslWithBundle(WS_HOST, WS_PORT, wsPath, NULL, 0, "");
  webSocket.onEvent(onWsEvent);
  webSocket.setReconnectInterval(5000);

  const uint32_t now = millis();
  lastTelemetryMs = now;
  lastInboundMs   = now;
}

void loop() {
  webSocket.loop();

  // ── wifi_set 結果監看（非阻塞，失敗會回滾到前一組網路）──
  if (wifiReconnecting) {
    if (WiFi.status() == WL_CONNECTED) {
      wifiReconnecting = false;
      const String ip = WiFi.localIP().toString();
      Serial.printf("wifi_set OK  IP=%s\n", ip.c_str());
      JsonDocument doc;
      doc["type"]      = "wifi_ack";
      doc["command"]   = "wifi_set";
      doc["status"]    = "ok";
      doc["ip"]        = ip;
      sendJson(doc);
    } else if (millis() - wifiReconnectStart > WIFI_RECONNECT_TIMEOUT_MS) {
      wifiReconnecting = false;
      Serial.println("wifi_set FAILED — rolling back");
      wifiCurSsid = wifiOldSsid;
      wifiCurPass = wifiOldPass;
      WiFi.disconnect(true);
      delay(200);
      WiFi.begin(wifiCurSsid.c_str(), wifiCurPass.c_str());
      JsonDocument doc;
      doc["type"]    = "wifi_ack";
      doc["command"] = "wifi_set";
      doc["status"]  = "error";
      doc["msg"]     = "connection failed, reverted to previous network";
      sendJson(doc);
    }
  }

  // ── WiFi 掉了就重連 ──
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi(wifiCurSsid.c_str(), wifiCurPass.c_str(), 10000);
    return;
  }

  if (!webSocket.isConnected()) return;

  const uint32_t now = millis();

  // 看門狗：有送出去但 30 秒完全沒收到東西 → 半開連線（常見於 Worker 重新部署後）
  if (lastInboundMs > 0 && now - lastInboundMs > WATCHDOG_MS) {
    Serial.println("[WD] no inbound for 30s — reconnecting");
    webSocket.disconnect();
    lastInboundMs = now;              // 避免立刻又觸發
    return;
  }

  if (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    sendTelemetry();
    sendPing();
    lastTelemetryMs = now;
  }
}
