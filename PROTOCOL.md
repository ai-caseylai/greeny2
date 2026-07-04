# Protocol — Wire Contract

Shared by ALL agents (Firmware, Edge, Dashboard). Every message over WSS follows this spec.
Changing a field name or message type here is a **breaking change** — all modules must agree.

---

## Connection URLs

```
ESP32 LED:      wss://<host>/device/esp32-led
ESP32 Sensor:   wss://<host>/device/esp32-sensor
Dashboard:      wss://<host>/dashboard/<device-id>
```

Dashboard passes `?token=<JWT>` query param when auth is enabled (Phase 3+).

---

## ESP32 → DO

### telemetry
```json
{
  "type": "telemetry",
  "device_id": "esp32-sensor",
  "tds": 707,
  "ec": 1413,
  "ph": 7.12,
  "temp": 25.3,
  "led": false,
  "esp32_ms": 452381
}
```
| Field | Type | Required | Notes |
|---|---|---|---|
| type | string | yes | `"telemetry"` |
| device_id | string | yes | Device identifier |
| tds | number | yes | TDS in ppm |
| ec | number | yes | EC in μS/cm |
| ph | number | yes | pH value |
| temp | number | yes | Water temperature in °C |
| led | boolean | no | Current LED state |
| esp32_ms | number | no | ESP32 millis() timestamp |

### ack
```json
{
  "type": "ack",
  "device_id": "esp32-sensor",
  "command": "set_led",
  "status": "ok",
  "led": true,
  "esp32_ms": 452381
}
```
| Field | Type | Notes |
|---|---|---|
| type | string | `"ack"` |
| device_id | string | Which device is acking |
| command | string | Command being acknowledged |
| status | string | `"ok"` or `"error"` |
| led | boolean | Current LED state after command (if applicable) |
| esp32_ms | number | ESP32 millis() |

### ping
```json
{"type": "ping", "device_id": "esp32-sensor", "seq": 42}
```

---

## DO → ESP32

### sync (sent on connect)
```json
{"type": "sync", "led": false, "doTs": 1719000000000}
```

### command (forwarded from browser)
```json
{"command": "set_led", "params": {"state": true}}
{"command": "calibrate", "params": {"type": "ec_zero"}}
```

### pong
```json
{"type": "pong", "seq": 42, "echo": "[DO] received ping seq=42"}
```

---

## Browser → DO

```json
{"command": "set_led", "device_id": "esp32-led", "state": true, "ts": 1719000000000}
{"command": "calibrate", "device_id": "esp32-sensor", "params": {"type": "ec_zero"}, "ts": 1719000000000}
```

---

## DO → Browser (broadcast)

### state
```json
{
  "type": "state",
  "device_id": "esp32-sensor",
  "led": true,
  "connected": true,
  "tds": 707,
  "ec": 1413,
  "ph": 7.12,
  "temp": 25.3,
  "doTs": 1719000000450
}
```
| Field | Type | Notes |
|---|---|---|
| type | string | `"state"` |
| device_id | string | Which device this state is for |
| led | boolean | Current LED state |
| connected | boolean | Whether ESP32 is connected |
| tds | number | TDS in ppm (sensor only) |
| ec | number | EC in μS/cm (sensor only) |
| ph | number | pH (sensor only) |
| temp | number | Water temp °C (sensor only) |
| doTs | number | DO timestamp (for RTT measurement) |

### alert (Phase 4+)
```json
{
  "type": "alert",
  "device_id": "esp32-sensor",
  "alert_type": "ec_high",
  "message": "EC 超出阈值: 2150 μS/cm",
  "severity": "warning",
  "doTs": 1719000000450
}
```

---

## REST API (Phase 3+)

```
POST /api/auth/login     {username, password} → {token, user}
GET  /api/auth/me        Authorization: Bearer <JWT> → user info
GET  /api/telemetry?device_id=X&limit=100  → telemetry rows from D1
GET  /api/devices                            → device list + status
GET  /api/alerts?device_id=X&limit=50        → alert list
POST /api/alerts/ack     {alert_id}          → acknowledge alert
```
