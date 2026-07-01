/*
 * IoT Hub — Phase 2: ESP32 WSS Smoke Test
 * Connects to Cloudflare Worker via WSS, sends ping, prints pong.
 * 
 * Wiring: D2 (GPIO 2) = onboard blue LED
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ── CONFIG ──────────────────────────────────────
const char* WIFI_SSID     = "YOUR_SSID";      // ← change before flashing
const char* WIFI_PASS     = "YOUR_PASSWORD";  // ← change before flashing

const char* WS_HOST       = "iot-hub.funconnect.workers.dev";
const uint16_t WS_PORT    = 443;
const char* WS_PATH       = "/device/esp32-01";

#define LED_PIN            2
#define PING_INTERVAL_MS   10000   // 10 seconds between pings
#define USE_SERIAL         Serial
// ─────────────────────────────────────────────────

WiFiMulti wifiMulti;
WebSocketsClient webSocket;

unsigned long lastPingMs = 0;
uint32_t pingSeq = 0;
bool timeSynced = false;

// ── NTP time sync ───────────────────────────────
void syncTime() {
  USE_SERIAL.print("NTP: Syncing... ");
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  time_t now = time(nullptr);
  int dots = 0;
  while (now < 8 * 3600 * 2) {  // wait until time > 16 hours past epoch
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
      // Send first ping immediately
      pingSeq = 1;
      {
        JsonDocument doc;
        doc["type"] = "ping";
        doc["seq"] = pingSeq;
        char buf[128];
        serializeJson(doc, buf);
        webSocket.sendTXT(buf);
        USE_SERIAL.printf("PING → seq=%u\n", pingSeq);
        lastPingMs = millis();
      }
      break;

    case WStype_TEXT: {
      USE_SERIAL.printf("MSG  ← %s\n", (char*)payload);
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, (char*)payload);
      if (!err) {
        const char* type = doc["type"];
        const char* command = doc["command"];

        if (type && strcmp(type, "pong") == 0) {
          uint32_t seq = doc["seq"];
          USE_SERIAL.printf("PONG ✓ seq=%u\n", seq);
        }
        else if (command && strcmp(command, "set_led") == 0) {
          bool state = doc["params"]["state"];
          setLED(state);
          unsigned long espMs = millis();
          USE_SERIAL.printf("CMD  ← set_led → %s (esp32_ms=%lu)\n",
                            state ? "ON" : "OFF", espMs);

          // Send ack
          JsonDocument ack;
          ack["type"] = "ack";
          ack["command"] = "set_led";
          ack["status"] = "ok";
          ack["led"] = state;
          ack["esp32_ms"] = espMs;
          char buf[128];
          serializeJson(ack, buf);
          webSocket.sendTXT(buf);
          USE_SERIAL.printf("ACK  → %s\n", buf);
        }
        else if (type && strcmp(type, "sync") == 0) {
          // DO pushed initial state on connect
          bool led = doc["led"];
          setLED(led);
          USE_SERIAL.printf("SYNC ← led=%s\n", led ? "ON" : "OFF");
        }
      }
      break;
    }

    case WStype_ERROR:
      USE_SERIAL.println("[WS] ERROR");
      break;

    case WStype_PING:
      USE_SERIAL.println("[WS] PING (protocol)");
      break;

    case WStype_PONG:
      USE_SERIAL.println("[WS] PONG (protocol)");
      break;

    default:
      break;
  }
}

// ── Setup ───────────────────────────────────────
void setup() {
  USE_SERIAL.begin(115200);
  USE_SERIAL.setDebugOutput(true);  // show TLS handshake debug

  pinMode(LED_PIN, OUTPUT);
  setLED(false);

  USE_SERIAL.println();
  USE_SERIAL.println("=== IoT Hub — ESP32 WSS Smoke Test ===");
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

  // WebSocket — WSS with built-in CA bundle
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

  // Periodic ping
  if (timeSynced && webSocket.isConnected()) {
    unsigned long now = millis();
    if (now - lastPingMs >= PING_INTERVAL_MS) {
      pingSeq++;
      JsonDocument doc;
      doc["type"] = "ping";
      doc["seq"] = pingSeq;
      char buf[128];
      serializeJson(doc, buf);
      webSocket.sendTXT(buf);
      USE_SERIAL.printf("PING → seq=%u\n", pingSeq);
      lastPingMs = now;
    }
  }
}
