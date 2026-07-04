/*
 * AIoT Control - CyberPi Firmware
 * Controls built-in RGB LED via MQTT
 * 
 * Topics:
 *   Subscribe: cmd/led
 *   Publish:   tele/led/status
 */

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <FastLED.h>

// WiFi credentials
const char* WIFI_SSID = "YourWiFi";
const char* WIFI_PASS = "YourPassword";

// MQTT broker
const char* MQTT_HOST = "broker.emqx.io";
const int   MQTT_PORT = 1883;
const char* MQTT_USER = "";
const char* MQTT_PASS = "";
const char* CLIENT_ID = "cyberpi_led";

// Topics
const char* TOPIC_CMD  = "cmd/led";
const char* TOPIC_TELE = "tele/led/status";

// LED config - CyberPi built-in RGB is usually GPIO 18
#define LED_PIN      18
#define NUM_LEDS      1
#define COLOR_ORDER  GRB

CRGB leds[NUM_LEDS];
WiFiClient wifi_client;
PubSubClient mqtt(wifi_client);

unsigned long last_reconnect = 0;
const unsigned long RECONNECT_INTERVAL = 5000;

void setup() {
  Serial.begin(115200);
  delay(100);
  
  Serial.println("\n=== AIoT CyberPi LED Controller ===");
  
  // Init LED
  FastLED.addLeds<WS2812, LED_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setBrightness(50);
  
  // Boot indicator: green flash
  leds[0] = CRGB::Green;
  FastLED.show();
  delay(300);
  leds[0] = CRGB::Black;
  FastLED.show();
  
  // Connect WiFi
  Serial.printf("Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nWiFi connected. IP: %s\n", WiFi.localIP().toString().c_str());
  
  // MQTT setup
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(callback);
  
  connectMQTT();
  
  // Boot ready: blue flash
  leds[0] = CRGB::Blue;
  FastLED.show();
  delay(200);
  leds[0] = CRGB::Black;
  FastLED.show();
}

void loop() {
  if (!mqtt.connected()) {
    unsigned long now = millis();
    if (now - last_reconnect > RECONNECT_INTERVAL) {
      last_reconnect = now;
      connectMQTT();
    }
  } else {
    mqtt.loop();
  }
}

void connectMQTT() {
  Serial.print("Connecting MQTT...");
  if (mqtt.connect(CLIENT_ID, MQTT_USER, MQTT_PASS, TOPIC_TELE, 1, true, "offline")) {
    Serial.println(" connected!");
    mqtt.subscribe(TOPIC_CMD);
    mqtt.publish(TOPIC_TELE, "online");
    
    // Connection confirmed: purple flash
    leds[0] = CRGB::Purple;
    FastLED.show();
    delay(200);
    leds[0] = CRGB::Black;
    FastLED.show();
  } else {
    Serial.printf(" failed (rc=%d)\n", mqtt.state());
    
    // Error: red flash
    leds[0] = CRGB::Red;
    FastLED.show();
    delay(100);
    leds[0] = CRGB::Black;
    FastLED.show();
  }
}

void callback(char* topic, byte* payload, unsigned int length) {
  char msg[length + 1];
  memcpy(msg, payload, length);
  msg[length] = '\0';
  
  Serial.printf("MQTT message: [%s] %s\n", topic, msg);
  
  // Parse command
  String cmd = String(msg);
  cmd.trim();
  cmd.toLowerCase();
  
  CRGB color = CRGB::Black;
  const char* status = "unknown";
  
  if (cmd == "red") {
    color = CRGB::Red;
    status = "red";
  } else if (cmd == "green") {
    color = CRGB::Green;
    status = "green";
  } else if (cmd == "blue") {
    color = CRGB::Blue;
    status = "blue";
  } else if (cmd == "yellow") {
    color = CRGB::Yellow;
    status = "yellow";
  } else if (cmd == "cyan") {
    color = CRGB::Cyan;
    status = "cyan";
  } else if (cmd == "magenta" || cmd == "purple") {
    color = CRGB::Magenta;
    status = "magenta";
  } else if (cmd == "white") {
    color = CRGB::White;
    status = "white";
  } else if (cmd == "off" || cmd == "black") {
    color = CRGB::Black;
    status = "off";
  } else if (cmd.startsWith("#")) {
    // Hex color support: #FF0000
    uint32_t hex = strtol(cmd.c_str() + 1, NULL, 16);
    color = CRGB(hex >> 16, hex >> 8, hex);
    status = cmd.c_str();
  } else {
    // Try as RGB: "rgb(255,0,0)" or "255,0,0"
    int r, g, b;
    if (sscanf(cmd.c_str(), "rgb(%d,%d,%d)", &r, &g, &b) == 3 ||
        sscanf(cmd.c_str(), "%d,%d,%d", &r, &g, &b) == 3) {
      color = CRGB(constrain(r,0,255), constrain(g,0,255), constrain(b,0,255));
      status = cmd.c_str();
    } else {
      status = "error: unknown command";
    }
  }
  
  // Set LED
  leds[0] = color;
  FastLED.show();
  
  // Publish status
  if (strcmp(status, "error") != 0) {
    mqtt.publish(TOPIC_TELE, status);
  }
}
