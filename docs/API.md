# Greeny2 — API 與裝置接入文件

> 依據 repo `ai-caseylai/greeny2` commit **`01943c2`** 的實際程式碼整理。
> 主要來源：`edge/src/index.ts`、`edge/src/device-hub.ts`、`edge/PROTOCOL.md`、`edge/EDGE.md`、`firmware/esp32/esp32.ino`、`firmware/FIRMWARE.md`、`spa/functions/**`。

---

## 0. 概觀

```
┌──────────┐   WSS (唯一通道)        ┌───────────────────────┐
│  ESP32   │ ──────────────────────▶ │ Worker iot-hub        │
│ 裝置     │ ◀────────────────────── │  └ Durable Object     │
└──────────┘   sync / command        │     DeviceHub         │
                                     │     ├ DO-local SQLite │
┌──────────┐   WSS                   │     └ alarm → D1      │
│ 瀏覽器   │ ◀─────────────────────▶ │                       │
│ / App    │   REST (JWT)            │  └ DO GreenyAgent(AI) │
└──────────┘                         └───────────┬───────────┘
                                                 │ 60 秒 alarm 批次寫入
┌──────────┐   REST (同源)                        ▼
│ SPA      │ ──────────────────────▶ ┌──────────────────────┐
│ Pages    │                         │ D1: greeny-db        │
└──────────┘                         └──────────────────────┘
```

### 服務端點

| 端點 | 內容 | 認證 |
|---|---|---|
| `https://iot-hub.ai-caseylai.workers.dev` | **裝置 WS**、即時 REST API、AI Chat | JWT（WS 與 `/health` 除外） |
| `https://greeny.techforliving.net` | SPA ＋ 管理 API（Cloudflare Pages Functions） | JWT |
| `https://greeny.pages.dev` | 同上（Pages 預設域名） | JWT |
| `https://greenie.techforliving.net` | 同上（同一 Pages 專案的別名域名） | JWT |
| `wss://greeny-ws.techforliving.net` | 舊版（aquagreen 世代）WS 通道，greeny2 未使用 | — |

> ✅ **端點已統一（2026-10-11 完成）**：SPA（`spa/src/lib/api.ts`、`useWebSocket.ts`、`ChatWidget.tsx`）與 ESP32 韌體（`firmware/esp32/esp32.ino` 的 `WS_HOST`）都已改指向 `iot-hub.ai-caseylai.workers.dev`（本帳號），遙測與管理資料統一存進 `greeny-db`。
> 舊的 Worker 位於**另一個 Cloudflare 帳號**的 `iot-hub.funconnect.workers.dev`；SPA 與裝置已不再使用它，但該台仍公開存在且**登入驗證有漏洞**（`$2` bcrypt 短路）——本帳號無權修改，建議停用或修補。

---

# Part A — ESP32 裝置接入（重點）

> 本節描述的是**協定本身**，任何語言的實作都適用。
> 現成實作：Arduino → [`firmware/esp32/esp32.ino`](../firmware/esp32/esp32.ino)；
> **MicroPython → [`firmware/esp32-micropython/main.py`](../firmware/esp32-micropython/main.py)**（見 F.5）。

## A.1 一句話總結

ESP32 只需要做**一件事：開一條 WSS 連線**。

- ❌ 沒有 HTTPS POST、沒有 MQTT、沒有 API key
- ❌ 韌體裡沒有 `HTTPClient`（已確認：`esp32.ino` 完全沒有 HTTP 請求程式碼）
- ✅ 連上後由 WebSocket **雙向**交換 JSON（遙測、指令、ACK）

## A.2 連線前必備條件（缺一不可）

| # | 條件 | 說明 |
|---|---|---|
| 1 | **2.4 GHz WiFi** | ESP32 硬體限制，看不到 5 GHz / WiFi 6 |
| 2 | **先做 NTP 對時** | ESP32 無電池 RTC，開機時間是 1970-01-01 → **TLS 憑證會被判定過期而連線失敗** |
| 3 | **用內建 CA bundle** | `beginSslWithBundle(..., NULL, 0, "")` 使用 ESP32 內建 77 KB CA bundle，不需自帶憑證 |
| 4 | 函式庫 | `WebSockets@2.7.2`、`ArduinoJson@7.4.3`、`OneWire@2.3.8`、`DallasTemperature@4.0.6` |

NTP 對時（必須在 WSS 之前）：

```cpp
configTime(0, 0, "pool.ntp.org", "time.nist.gov");
while (time(nullptr) < 8 * 3600 * 2) { delay(100); }   // 等到時鐘合理才繼續
```

## A.3 連線 URL 與角色判定

```
wss://<host>:443/device/<device_id>      ← 裝置通道
wss://<host>:443/dashboard/<device_id>   ← 儀表板通道
```

韌體中的實際設定：

```cpp
const char*    WS_HOST = "iot-hub.ai-caseylai.workers.dev";
const uint16_t WS_PORT = 443;
const char*    WS_PATH = "/device/esp32-sensor";
```

**路由邏輯**（`edge/src/index.ts`）：
1. 只要請求帶 `Upgrade: websocket` header，Worker 就取路徑第 2 段當 `device_id`
2. `env.DEVICE_HUB.idFromName(device_id)` → 交給對應的 Durable Object
3. **角色由 DO 判定**：`url.pathname.includes("dashboard") ? "dashboard" : "esp32"`

> 也就是說 `/device/<id>` 與 `/dashboard/<id>` 進的是**同一個 DO**（同一個 `device_id`），只靠路徑字串區分角色。

## A.4 最小可運作程式碼骨架

```cpp
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

const char* WS_HOST = "iot-hub.ai-caseylai.workers.dev";
const uint16_t WS_PORT = 443;
const char* WS_PATH = "/device/esp32-sensor";        // ← 你的 device_id
WebSocketsClient webSocket;

void onWsEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:                            // 連上 → 等 DO 送 sync
      Serial.println("WSS connected");
      break;

    case WStype_TEXT: {                               // 收到雲端訊息
      JsonDocument doc;
      if (deserializeJson(doc, (char*)payload)) return;

      if (doc["type"] == "sync") {                    // 開機同步目前 LED 狀態
        digitalWrite(LED_PIN, doc["led"] ? HIGH : LOW);
      }
      else if (doc["command"] == "set_led") {         // 控制指令（注意參數在 params 內）
        bool state = doc["params"]["state"];
        digitalWrite(LED_PIN, state ? HIGH : LOW);
        // 必須回 ACK
        JsonDocument ack;
        ack["type"] = "ack"; ack["device_id"] = "esp32-sensor";
        ack["command"] = "set_led"; ack["status"] = "ok";
        ack["led"] = state; ack["esp32_ms"] = millis();
        String out; serializeJson(ack, out);
        webSocket.sendTXT(out);
      }
      break;
    }
    default: break;
  }
}

void setup() {
  Serial.begin(115200);

  WiFi.begin(SSID, PASS);                             // 2.4 GHz only
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) delay(200);

  configTime(0, 0, "pool.ntp.org", "time.nist.gov");  // ③ 必須
  while (time(nullptr) < 8 * 3600 * 2) delay(100);

  webSocket.beginSslWithBundle(WS_HOST, WS_PORT, WS_PATH, NULL, 0, "");
  webSocket.onEvent(onWsEvent);
  webSocket.setReconnectInterval(5000);               // 斷線 5 秒後重連
}

void loop() {
  webSocket.loop();

  static unsigned long lastSend = 0;
  if (millis() - lastSend >= 10000) {                 // 每 10 秒送一次遙測
    lastSend = millis();
    JsonDocument d;
    d["type"] = "telemetry";
    d["device_id"] = "esp32-sensor";
    d["tds"] = tds;  d["ec"] = ec;  d["ph"] = ph;  d["temp"] = temp;
    d["led"] = digitalRead(LED_PIN);
    d["esp32_ms"] = millis();
    String out; serializeJson(d, out);
    webSocket.sendTXT(out);
  }
}
```

## A.5 連線握手（裝置連上時發生什麼）

DO 在收到裝置連線時（`device-hub.ts` fetch）：

1. **清空該裝置的 `relay_queue`**（避免重開機後重放舊的校正指令，會污染校正狀態）
2. 若已有舊連線，先 `close(1000, "Replaced by new connection")`（避免殭屍 socket）
3. 記錄 `this.esp32ws = server`，重設健康檢查計數 `lastTelemetryMs = 0`
4. **送給裝置**：
   ```json
   {"type":"sync","led":false,"doTs":1719000000000}
   ```
5. **廣播給所有儀表板**：
   ```json
   {"type":"device_status","device_id":"esp32-sensor","status":"online"}
   ```

## A.6 裝置 → 雲端 訊息（ESP32 可送出的 5 種）

### ① `telemetry` — 遙測（每 10 秒，核心訊息）

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

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `type` | string | ✅ | 固定 `"telemetry"` |
| `device_id` | string | ✅ | 裝置識別碼 |
| `tds` | number | ✅ | TDS，ppm |
| `ec` | number | ✅ | EC，μS/cm |
| `ph` | number | ✅ | pH（韌體 round 到小數 2 位） |
| `temp` | number | ✅ | 水溫 °C（round 到小數 1 位） |
| `led` | boolean | ⭕ | 目前 LED 狀態 |
| `esp32_ms` | number | ⭕ | ESP32 `millis()` |

### ② `ack` — 指令確認（**強烈建議實作**）

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

DO 收到後會寫入 `relay_log_buffer`（稽核軌跡）並向儀表板廣播最新 `state`。

### ③ `ping` — 心跳（選用）

```json
{"type":"ping","device_id":"esp32-sensor","seq":42}
```

DO 回 `pong`，**並順手清空 relay queue**（降低指令延遲）。注意：目前韌體用 `telemetry`（每 10 秒）當心跳，沒有實際送 `ping`。

### ④ `wifi_list` — WiFi 掃描結果（選用）

DO 直接原封不動轉發給所有儀表板：

```json
{"type":"wifi_list","device_id":"esp32-sensor","networks":[{"ssid":"MyWiFi","rssi":-52,"enc":1}]}
```

### ⑤ `wifi_ack` — WiFi 切換結果（選用）

```json
{"type":"wifi_ack","command":"wifi_set","status":"ok","ip":"192.168.1.42"}
{"type":"wifi_ack","command":"wifi_set","status":"error","msg":"Connection failed, reverted to previous network"}
```

## A.7 雲端 → 裝置 訊息

| 訊息 | 時機 | Payload |
|---|---|---|
| `sync` | 連線建立時 | `{"type":"sync","led":bool,"doTs":ms}` |
| `pong` | 回覆裝置 `ping` | `{"type":"pong","seq":42,"echo":"[DO] received ping seq=42"}` |
| `command` | 儀表板/API 下指令 | `{"command":"set_led","params":{"state":true}}` |

**⚠️ 重要陷阱：指令參數一律包在 `params` 裡。**
`set_led` 是 `{"command":"set_led","params":{"state":true}}`，**不是** `{"command":"set_led","state":true}`。（後者只在儀表板 → DO 那一層使用，DO 轉發給裝置時會重新包成 `params`。）

## A.8 指令參考（裝置端需實作的指令）

| 指令 | 參數 | 語意 | 傳遞保證 |
|---|---|---|---|
| `set_led` | `{"state": true\|false}` | 開/關 LED（GPIO 2，兼作繼電器） | **持久佇列**（離線也會補送） |
| `calibrate` | `{"type": "reset"}`、`{"type":"ec_zero"}`、`{"type":"ec_1413"}`、`{"type":"ec_value","value":200}`、`{"type":"ph_7"}`、`{"type":"ph_4"}`、`{"type":"ph_9"}` | 校正（寫入 EEPROM） | **QoS 0**（不排隊、離線即丟棄） |
| `wifi_scan` | `{}` | 掃描附近 WiFi → 回 `wifi_list` | 直送（離線即丟棄） |
| `wifi_set` | `{"ssid":"...","pass":"..."}` | 換 WiFi（寫 EEPROM → 重連）→ 回 `wifi_ack` | 直送（離線即丟棄） |
| 其他任意 `command` | 自訂 | **泛用轉發**：DO 不認識的指令會原樣轉給裝置 | 直送；新增指令**不需改雲端程式**，只要在韌體實作 |

### 傳遞語意（必讀，關係到可靠性）

| 情況 | 行為 |
|---|---|
| `set_led` 送出時裝置離線 | 寫入 DO-local `relay_queue`，**下次裝置送 telemetry/ping 時補送** |
| `set_led` 送出時裝置在線 | 同時寫佇列 + 立即轉發（佇列項在 ACK 後移除） |
| `calibrate` 送出時裝置離線 | **直接丟棄**（校正與探頭位置有關，重放會破壞校正）→ HTTP `/api/relay` 回 **503** |
| 裝置**重連**時 | DO **主動清空** `relay_queue`（避免重放過期指令） |
| 未知指令 | 在線才轉發，離線丟棄 |

## A.9 時序與自我修復

| 機制 | 數值 | 位置 |
|---|---|---|
| 遙測間隔 | **10 秒** | 韌體 `PING_INTERVAL_MS = 10000` |
| WebSocket 重連間隔 | **5 秒** | 韌體 `setReconnectInterval(5000)` |
| 韌體看門狗 | **30 秒**無 inbound → 強制斷線重連 | 韌體 loop（`lastInboundMs`） |
| DO 健康檢查 | 裝置在線但「連上後從未收到遙測」→ DO 主動關閉 WS | DO `alarm()` |
| DO 寫入 D1 | **60 秒** alarm 批次 flush `telemetry_buffer` → D1 | DO `alarm()` |
| WiFi 重連逾時 | 失敗會**回滾**到前一組網路 | 韌體 `wifi_set` 流程 |

> 雙向看門狗是刻意設計：Worker 重新部署後常出現「裝置→DO 正常、DO→裝置斷」的半開連線，兩端各自偵測、各自重連，不需人工重插電。

## A.10 硬體與接線（現行機台）

| 項目 | 內容 |
|---|---|
| 晶片 | ESP32-D0WD-V3 rev v3.1（4 MB flash） |
| 裝置 ID | `esp32-sensor` |
| LED | GPIO 2 |
| TDS（DFRobot SEN0244） | GPIO 36（ADC1） |
| pH 探頭 + 放大板 | GPIO 39（ADC1） |
| DS18B20 水溫 | GPIO 13（OneWire），位址 `281C6543D45E6759` |
| USB | CH340，COM3，115200 baud |

**注意**：只能用 **ADC1（GPIO 32–39）**；WiFi 開啟時 ADC2 不可用。

## A.11 疑難排解

| 症狀 | 原因 / 對策 |
|---|---|
| TLS 連線失敗、憑證過期 | 沒做 NTP 對時 → 時鐘停在 1970 |
| 連上又立刻斷 | 路徑寫錯（`/device/<id>`）；或 `device_id` 與 DO 不一致 |
| `set_led` 沒反應但遙測正常 | 指令參數沒包在 `params`（見 A.7） |
| 校正指令沒反應 | 裝置離線時 `calibrate` 會被丟棄（QoS 0），需在線時下 |
| EC 讀值 ~5000 | 探頭乾了或沒接上 SEN0244 板 |
| pH 固定 34.95（≈3.3 V） | 硬體問題：探頭未接或放大板缺失（韌體不需動） |
| 部署 Worker 後失聯 | 半開連線；兩端看門狗會在 30 秒內自動重連 |

---

# Part B — HTTP REST API（Worker）

**Base URL**：`https://iot-hub.ai-caseylai.workers.dev`

## B.1 認證

- 演算法：**HS256 JWT**（Web Crypto，無外部依賴）
- 密鑰來源：D1 `settings` 表、key = `jwt_secret`（**不從環境變數或硬編碼讀取**）
- 密碼雜湊：**PBKDF2**
- 標頭：`Authorization: Bearer <token>`

**免認證白名單**（`AUTH_WHITELIST`）：`GET /`、`GET /dashboard`、`GET /health`、`POST /api/auth/login`，以及所有 `/device/*`、`/dashboard/*` WebSocket 路徑。

## B.2 端點總表

| Method | Path | 認證 | 參數 / Body | 回應 |
|---|---|---|---|---|
| GET | `/health` | ❌ | — | `{"status":"ok","uptime":123}` |
| GET | `/` `GET /dashboard` | ❌ | — | 內建儀表板 HTML |
| POST | `/api/auth/login` | ❌ | `{"username","password"}` | `{"token","user":{"id","username","role"}}` |
| GET | `/api/auth/me` | ✅ | — | `{"user":{...}}` |
| GET | `/api/telemetry` | ✅ | `?device_id=&limit=`（上限 1000） | `{"telemetry":[...]}` |
| GET | `/api/devices` | ✅ | — | `{"devices":[...]}` |
| GET | `/api/alerts` | ✅ | `?device_id=&limit=`（上限 500） | `{"alerts":[...]}` |
| POST | `/api/alerts/ack` | ✅ | `{"alert_id":123}` | `{"success":true}` |
| POST | `/api/relay` | ✅ | 見 B.3 | `{"ok":true,"device_id","led"}` |
| POST | `/api/chat` | ✅ | `{"message":"..."}` | AI 回覆（Workers AI） |
| GET | `/device/<id>` | ❌ | `Upgrade: websocket` | 101 裝置通道 |
| GET | `/dashboard/<id>` | ⚠️ | `Upgrade: websocket`、`?token=` | 101 儀表板通道 |

## B.3 控制繼電器 / LED（最常用的整合點）

**方式一：`relay1`（Casey 舊協定相容）**

```bash
curl -X POST https://iot-hub.ai-caseylai.workers.dev/api/relay \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"device_id":"esp32-sensor","relay1":1}'
```
→ `{"ok":true,"device_id":"esp32-sensor","led":true}`

**方式二：`state`（較清楚）**

```bash
-d '{"device_id":"esp32-sensor","state":false}'
```

**方式三：校正（QoS 0）**

```bash
-d '{"device_id":"esp32-sensor","command":"calibrate","params":{"type":"ph_7"}}'
```
→ 裝置離線時回 **503**：`{"ok":false,"error":"ESP32 not connected — calibrate is QoS 0, cannot queue"}`

**JavaScript 範例**

```js
const BASE = 'https://iot-hub.ai-caseylai.workers.dev';

async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return (await r.json()).token;
}

async function setLed(token, deviceId, on) {
  const r = await fetch(`${BASE}/api/relay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ device_id: deviceId, state: on }),
  });
  return r.json();     // { ok, device_id, led }
}
```

**Python 範例**

```python
import requests
BASE = "https://iot-hub.ai-caseylai.workers.dev"
tok = requests.post(f"{BASE}/api/auth/login",
                    json={"username": "u", "password": "p"}).json()["token"]
h = {"Authorization": f"Bearer {tok}"}
print(requests.post(f"{BASE}/api/relay", headers=h,
                    json={"device_id": "esp32-sensor", "state": True}).json())
print(requests.get(f"{BASE}/api/telemetry", headers=h,
                   params={"device_id": "esp32-sensor", "limit": 10}).json())
```

## B.4 CORS 與錯誤碼

- 所有回應帶 `Access-Control-Allow-Origin: *`；`OPTIONS` → **204**
- `400` 參數錯誤 / `401` 未認證或 token 無效 / `404` 路徑不存在 / `503` AI Agent 不可用、或校正指令時裝置離線

---

# Part C — WebSocket（儀表板 / App）

## C.1 連線

```js
const ws = new WebSocket(
  `wss://iot-hub.ai-caseylai.workers.dev/dashboard/${deviceId}?token=${jwt}`
);
```

連上後 DO 立刻推一份當前狀態：

```json
{"type":"state","device_id":"esp32-sensor","led":false,"connected":true,
 "tds":707,"ec":1413,"ph":7.12,"temp":25.3,"doTs":1719000000450}
```

## C.2 會收到的訊息

| `type` | 說明 | 主要欄位 |
|---|---|---|
| `state` | 狀態更新（遙測、ACK 後觸發） | `led` `connected` `tds` `ec` `ph` `temp` `doTs` |
| `telemetry_update` | 遙測增量 | 同上 |
| `device_status` | 裝置上下線 | `device_id` `status`（`online`/`offline`） |
| `alert` | 警報 | `alert_type` `message` `severity` |
| `wifi_list` | WiFi 掃描結果（裝置轉發） | `networks:[{ssid,rssi,enc}]` |
| `wifi_ack` | WiFi 切換結果 | `status` `ip` \| `msg` |
| `pong` | 心跳回覆 | `seq` `echo` |

## C.3 可發送的指令

| 送法 | 效果 |
|---|---|
| `{"type":"relay","device_id":"esp32-sensor","relay1":1}` | 舊協定 → 內部轉成 `set_led` |
| `{"command":"set_led","device_id":"esp32-sensor","state":true}` | 開 LED |
| `{"command":"calibrate","device_id":"esp32-sensor","params":{"type":"ph_7"}}` | 校正 |
| `{"command":"wifi_scan","device_id":"esp32-sensor","params":{}}` | 掃描 WiFi |
| `{"command":"wifi_set","params":{"ssid":"X","pass":"Y"}}` | 切換 WiFi |
| 任意 `{"command":"..."}` | 泛用轉發（需韌體實作） |

---

# Part D — 管理 API（Cloudflare Pages Functions）

**Base URL**：`https://greeny.techforliving.net`（同源，SPA 直接打 `/api/...`）

## D.1 路由總表

來源：`spa/functions/api/**`（檔案即路由；`index.ts` = 集合、`[id].ts` = 單筆）

| 路徑 | 方法 | 用途 |
|---|---|---|
| `/api/auth/login` | POST | 登入 |
| `/api/auth/me` | GET | 目前使用者 |
| `/api/telemetry` | **POST**（需 device token 或 JWT）、GET | 裝置寫入 / 查詢 |
| `/api/relay` | GET（白名單）、POST、OPTIONS | 繼電器 |
| `/api/relay-logs` | GET | 繼電器指令稽核日誌 |
| `/api/devices` | GET | 裝置清單 |
| `/api/devices/{id}` | GET、PUT、DELETE | 單一裝置 |
| `/api/alerts` | GET | 警報清單 |
| `/api/alerts/{id}` | PUT、PATCH | 更新 / 確認警報 |
| `/api/offices` | GET、POST | 據點 |
| `/api/offices/{id}` | PUT、DELETE | 單一據點 |
| `/api/racks` | GET、POST | 貨架 |
| `/api/racks/{id}` | GET、PUT、DELETE | 單一貨架 |
| `/api/rack-vegetables` | GET、POST | 貨架蔬菜層 |
| `/api/rack-vegetables/{id}` | PUT、DELETE | 單筆蔬菜 |
| `/api/rack-environment` | GET、POST | 環境數據 |
| `/api/crop-batches` | GET、POST | 作物批次 |
| `/api/crop-batches/{id}` | PATCH、DELETE | 單一批次 |
| `/api/harvests` | GET、POST | 收成紀錄 |
| `/api/automations` | GET、POST | 自動化規則 |
| `/api/automations/{id}` | PUT、DELETE | 單一規則 |
| `/api/automations/{id}/run` | POST | 立即執行 |
| `/api/tasks` | GET、POST | 任務 |
| `/api/tasks/{id}` | PATCH | 更新任務 |
| `/api/users` | GET、POST | 使用者 |
| `/api/users/{id}` | PATCH、DELETE | 單一使用者 |
| `/api/dashboard/stats` | GET | 儀表板統計 |
| `/api/reports/summary`、`/api/reports/usage` | GET | 報表 |
| `/api/notifications` | GET、POST | 通知 |
| `/api/personnel` | GET、POST | 人員 |
| `/api/filters` | GET、POST | 篩選器 |
| `/api/workbuddy/send-whatsapp` | POST | 送 WhatsApp |
| `/api/workbuddy/status` | GET | WhatsApp 狀態 |

## D.2 認證與白名單

`spa/functions/api/_middleware.ts`：

- 免 header 認證：`POST /api/auth/login`、`/api/wb/*`（另有自己的 `WB_API_KEY` 檢查）、`GET /api/relay`
- `POST /api/telemetry` 由 handler **自行驗證**（device token 或 JWT），見 Part F.4
- 其餘需 `Authorization: Bearer <JWT>`
- 密鑰同樣讀 D1 `settings.jwt_secret`（**與 Worker 同一把**，因此 Worker 發的 token 兩邊都通）

## D.3 實體欄位

以 `spa/src/types/index.ts` 為準，例如：

```ts
Office  { id, name, contact_person, contact_phone, whatsapp_number, notes, active, created_at }
Rack    { id, name, office_id, device_id, location, status, layer_count, created_at }
User    { id, username, role, office_id?, display_name? }
Telemetry { device_id, device_name?, ph, ec, tds, temp, led?, esp32_ms?, do_ms?, created_at }
Alert   { id, device_id, type, message, severity, acknowledged, created_at }
```

> 另提供 `GET /api/telemetry`（POST 供裝置寫入）作為**裝置走 HTTPS 的替代路徑**；但目前 ESP32 韌體只用 WSS，未使用此端點。

---

# Part E — 安全注意事項（請務必看）

| # | 問題 | 風險 | 建議 |
|---|---|---|---|
| 1 | **裝置 WS 無任何認證** | 任何人知道 `device_id` 就能冒充裝置送假遙測，或竊聽/控制 | 加入 device token（`?token=` 或首個 `auth` 訊息）並在 DO 驗證 |
| 2 | **儀表板 WS 的 `?token=` 未被驗證** | `device-hub.ts` 只讀 `device_id`，**完全沒有讀/驗 `token`** → `/dashboard/<id>` 目前等同公開，可即時看到遙測並下 `set_led` | 在 DO fetch 內用 `getJWTSecret` + `verifyJWT` 驗證 |
| 3 | ~~`/api/telemetry` POST 免認證~~ | ✅ **已修（2026-10-11）**：需 device token 或有效 JWT | — |
| 4 | 裝置 ID 是硬編碼 | 換機/多機需要改韌體 | 改為 EEPROM/NVS 設定 |
| 5 | `WB_API_KEY` 有公開預設值 | `wb/_middleware.ts` 比對 `context.env.WB_API_KEY`，`spa/wrangler.toml` 內是公開的 `greeny-wb-api-key-change-in-prod`；若部署時未覆蓋即可被繞過 | 在 Cloudflare 設成真實密鑰（不要留預設值） |

> 這是目前程式碼的**實際狀態**，不是理論風險 —— 請依用途評估是否在對外開放前補上認證。

---

## 附錄：文件維護

```powershell
# 本文件依據的程式碼位置
edge/src/index.ts          # Worker 路由、REST handler、認證白名單
edge/src/device-hub.ts     # DO：WS 握手、訊息分派、指令語意、alarm
edge/PROTOCOL.md           # 訊息格式（跨模組契約）
edge/EDGE.md               # Edge 模組規格
firmware/esp32/esp32.ino   # 裝置端實作（連線、指令、看門狗）
firmware/FIRMWARE.md       # 硬體、校正、工具鏈
spa/functions/api/**       # 管理 API
```

---

# Part F — 修補記錄（2026-10-11）

## F.1 WebSocket 認證（本次新增）

WebSocket handshake 無法設定 `Authorization` header，因此憑證一律走 `?token=` query 參數，
並且**在 Worker 層就攔下**（`edge/src/index.ts`）——未通過者不會進到 Durable Object。

| 通道 | 憑證 | 來源 | 失敗回應 |
|---|---|---|---|
| `wss://<host>/dashboard/<device_id>?token=<JWT>` | 登入取得的 JWT | D1 `settings.jwt_secret` 簽發 | **401** `{"error":"Unauthorized"}` |
| `wss://<host>/device/<device_id>?token=<DEVICE_TOKEN>` | 裝置 token | D1 `settings.device_token` | **401** `{"error":"Unauthorized device"}` |

- 非 `/device/`、非 `/dashboard/` 的 WebSocket 升級請求 → **404**
- 若 D1 沒有 `device_token`（未設定）→ 裝置通道維持開放並在 log 警告（方便逐步遷移）；
  **目前已設定 `device_token`，所以是強制驗證**
- 實測 6/6 通過：無 token／假 token → 401；正確憑證 → 101

### 裝置端必須帶 token（需重新燒錄）

```cpp
const char* WS_TOKEN = "<device_token>";          // 與 D1 settings.device_token 相同
char wsPath[192];
snprintf(wsPath, sizeof(wsPath), "%s?token=%s", WS_PATH, WS_TOKEN);
webSocket.beginSslWithBundle(WS_HOST, WS_PORT, wsPath, NULL, 0, "");
```

> ⚠️ **未重新燒錄的 ESP32 會被 401 拒絕**，不會再有遙測。

### 前端（已自動帶，無需改動）

```ts
// spa/src/hooks/useWebSocket.ts
const tokenParam = token ? `?token=${encodeURIComponent(token)}` : ''
const wsUrl = `wss://iot-hub.ai-caseylai.workers.dev/dashboard/${deviceId}${tokenParam}`
```

未登入時沒有 token → 連線被 401 拒絕（正確行為）。

## F.2 同日其他修補

| 項目 | 內容 |
|---|---|
| 登入繞過 | `spa/functions/_lib/password.ts` 移除 `if (storedHash.startsWith('$2')) return true;`；`edge/src/auth.ts` 統一為 `pbkdf2:<iters>:<salt>:<hash>` 自描述格式 |
| 密碼遷移 | admin / office1 / staff1 / office2 改為 `pbkdf2:100000` + 新密碼；舊 `admin123` 失效 |
| 端點統一 | SPA 與韌體全部改指 `iot-hub.ai-caseylai.workers.dev`（本帳號），該 Worker 綁 `greeny-db` → 遙測與管理資料同庫 |
| Pages `/api/auth/me` 500 | `api/_middleware.ts` 不再對整個 `/api/auth/` 前綴放行（`/me` 因此拿不到 `context.data.user`） |
| Worker `/api/devices` 500 | 原為 funconnect 部署問題；改用本帳號 Worker 後正常 |

## F.3 仍未處理

- `iot-hub.funconnect.workers.dev`（**另一個 Cloudflare 帳號**）仍公開存在，且仍有相同的登入繞過漏洞
- 裝置 ID（`esp32-sensor`）仍硬編碼於韌體
- ~~`WB_API_KEY` 仍為公開預設值~~ → ✅ **已修**（改為 Pages 專案的 `secret_text`，且從 `wrangler.toml` 移除；見 F.5）
- 曾出現於對話中的憑證建議輪換（GitHub PAT、3 顆 Cloudflare token）


## F.4 `POST /api/telemetry` 認證（2026-10-11）

此端點會寫入 `devices` / `telemetry` 並可能觸發 `alerts`，原本**完全免認證**，任何人可灌假遙測。
現在 handler 內自行驗證，接受任一種憑證：

| 憑證 | 送法 |
|---|---|
| 裝置 token | `?token=<device_token>` 或 header `X-Device-Token: <device_token>` |
| 使用者 JWT | `Authorization: Bearer <jwt>` |

未通過 → **401** `{"error":"Unauthorized — device token or JWT required"}`。
`device_token` 取自 D1 `settings.device_token`，與裝置 WebSocket 用的是同一個值。

```bash
# 裝置（HTTPS 備援路徑）
curl -X POST https://greeny.techforliving.net/api/telemetry \
  -H "Content-Type: application/json" \
  -H "X-Device-Token: <device_token>" \
  -d '{"device_id":"esp32-sensor","ph":6.8,"ec":1200,"water_temp":24.5}'
```

實測 5/5 通過（無憑證／錯 token → 401；正確 device token（query 與 header）／有效 JWT → 200）。
`GET /api/telemetry` 不受影響。

> 註：`POST` 路徑目前沒有用戶端在使用（韌體走 WSS），保留是為了讓裝置可走 HTTPS 備援。


## F.5 憑證清理與 MicroPython 客戶端（2026-10-11）

### WB_API_KEY

| 項目 | 前 | 後 |
|---|---|---|
| Pages 專案（production + preview） | `greeny-wb-api-key-change-in-prod`（公開預設） | **`secret_text`**（API 也讀不回） |
| `spa/wrangler.toml` | 明文寫著預設值 | **已移除**，只留註解 |

設為 `secret_text` 是刻意的：`wrangler pages deploy` 不會用 `[vars]` 覆蓋它，
API 也無法讀出值。換 key 請到 Cloudflare → Pages → greeny → Settings → Environment variables。

> ℹ️ `spa/functions/api/wb/` 底下**目前只有 `_middleware.ts`、沒有任何端點** ——
> 這道鎖現在守著空氣，先把洞補上，避免將來加了端點就變成後門。

### 移除舊的 `edge/src/index.mjs`

該檔是舊的打包產物且被提交進 repo，內容包含**舊版有漏洞的登入查詢（`SELECT … salt`）與
無認證的 WebSocket 升級區塊**，而 `edge/EDGE.md` 的舊部署指示正是教人上傳它。已 `git rm`。
部署請一律用 `wrangler deploy`（bundle `src/index.ts`）。

### 裝置憑證不再進版控

Arduino 與 MicroPython 版的 device token 都改為從 gitignored 檔案讀取：

| 版本 | 憑證檔 | 範本 |
|---|---|---|
| Arduino | `firmware/esp32/device_secrets.h` | — |
| MicroPython | `firmware/esp32-micropython/device_secrets.py` | `device_secrets.example.py` |

`esp32.ino` 用 `#if __has_include("device_secrets.h")`，沒有憑證檔時會退回佔位值
（`REPLACE_WITH_DEVICE_TOKEN`，連線會被 401 拒絕）。

### 新增：ESP32 MicroPython 客戶端

`firmware/esp32-micropython/main.py` —— 與 Arduino 版行為一致的完整實作：

- **自行實作 WebSocket handshake 與 frame 編解碼**，不依賴 `micropython-lib` 的
  `websocket-client`（避免版本 API 差異）
- WiFi / NTP / WSS 連線，憑證走 `?token=`
- 每 10 秒送 `telemetry` + `ping`
- 處理 `sync` / `set_led` / `calibrate` / `wifi_scan` / `wifi_set`，並回 `ack`
- 30 秒無 inbound → 強制重連（看門狗）
- 讀 DFRobot SEN0244（ADC 三次多項式 + 溫度補償）、DS18B20、pH 探頭

已知差異（詳見該目錄 README）：

| 項目 | Arduino | MicroPython |
|---|---|---|
| TLS 驗證 | ESP32 內建 CA bundle（完整驗證） | **預設 `TLS_VERIFY = False`**（仍加密，但不驗證伺服器身分） |
| 校正值 | 存 EEPROM | 不持久化（`calibrate` 只量測回報，需寫回常數） |
| WiFi 憑證 | 存 EEPROM | 執行期可切換並回滾，重開機回到 `device_secrets.py` |

> ⚠️ MicroPython 版**未在實體硬體上驗證過**（開發環境無 ESP32）；已通過 `py_compile` 語法檢查。
