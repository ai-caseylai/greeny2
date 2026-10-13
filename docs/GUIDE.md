# Greeny2 系統說明文件

> **適用版本**：repo `ai-caseylai/greeny2` @ `6360795`（`main`，37 commits）
> **最後更新**：2026-10-13
> **文件定位**：這是**系統總覽與操作手冊**。API 的完整規格（每個端點的 request/response、
> WebSocket 訊息格式、裝置協定）在 [`docs/API.md`](./API.md)，本文件不重複，只做導引。
>
> **⚠️ 本文件不含任何密碼或 token。** 憑證一律存在 D1 `settings` 表、Pages 環境變數、
> 或已 gitignore 的 `device_secrets.*` 檔案中，位置在本文件 §13 列出。

---

## 目錄

| 章節 | 內容 |
|---|---|
| §1 | [系統概觀](#1-系統概觀) |
| §2 | [架構與資料流](#2-架構與資料流) |
| §3 | [雲端資源清單](#3-雲端資源清單) |
| §4 | [帳號、角色與權限](#4-帳號角色與權限) |
| §5 | [認證與安全模型](#5-認證與安全模型) |
| §6 | [裝置接入（ESP32）](#6-裝置接入esp32) |
| §7 | [前端功能](#7-前端功能) |
| §8 | [部署與維運](#8-部署與維運) |
| §9 | [日常操作 SOP](#9-日常操作-sop) |
| §10 | [疑難排解](#10-疑難排解) |
| §11 | [安全修補歷史](#11-安全修補歷史) |
| §12 | [待辦與已知限制](#12-待辦與已知限制) |
| §13 | [附錄：憑證位置、檔案地圖、常用指令](#13-附錄) |

---

## 1. 系統概觀

**Greeny2**（品牌 **AquaGreen**，標語 *From Seed To Table*）是一套**智慧水耕農場管理平台**：
從 ESP32 感測器讀取水質與環境數據 → 上傳雲端 → 網頁儀表板即時顯示、可遠端控制設備、
並管理多個據點的貨架、作物批次、收成與人員。

### 它能做什麼

| 能力 | 說明 |
|---|---|
| **水質監控** | pH / EC / TDS / 水溫，每 10 秒更新；超過閾值自動產生警報 |
| **遠端控制** | 從網頁開關 LED／繼電器；指令具持久佇列（裝置離線也會補送） |
| **即時推播** | WebSocket 廣播遙測與狀態，不需輪詢 |
| **多據點管理** | 據點（Office）→ 貨架（Rack）→ 蔬菜層／環境數據 |
| **作物管理** | 作物批次、收成紀錄、任務指派 |
| **用戶與角色** | superadmin / office_admin / staff 三層權限 |
| **AI 助手** | Workers AI 的 `GreenyAgent` Durable Object，可查詢系統狀態 |
| **WiFi 遠端設定** | 從網頁掃描附近 AP、切換 ESP32 的 WiFi（失敗自動回滾） |
| **Captive Portal 備援** | 完整版韌體在 WiFi 連不上時自己開熱點 `Greeny-Alpha-Setup`，用手機設定（詳見 §6.1） |
| **WhatsApp 通知** | 對據點聯絡人發送訊息 |

### 關鍵設計取捨

- **裝置只走 WebSocket**，沒有 HTTPS 輪詢、沒有 MQTT。一條連線同時承載遙測與指令。
- **Durable Object 的熱路徑零 `await`**：遙測先進 DO-local SQLite，再由 alarm 每 60 秒批次寫入 D1。
  這讓感測器高頻寫入不會打爆 D1 配額。
- **指令分兩種可靠性**：`set_led` 走持久佇列；`calibrate` 是 QoS 0（探頭位置有關，重放會破壞校正）。

---

## 2. 架構與資料流

### 元件圖

```
                    ┌──────────────────────────────┐
   ESP32 裝置 ──WSS─▶│  Worker: iot-hub             │
   (Arduino 或       │  ├ Durable Object DeviceHub  │
    MicroPython)     │  │   ├ DO-local SQLite      │
                    │  │   │   ├ telemetry_buffer │
                    │  │   │   ├ relay_queue      │
                    │  │   │   ├ alert_buffer     │
                    │  │   │   └ relay_log_buffer │
                    │  │   └ alarm() 每 60s 批次寫入 │
                    │  └ Durable Object GreenyAgent│
                    │      └ Workers AI (/api/chat)│
                    └───────────────┬──────────────┘
                        ▲           │ D1 binding
        WSS(REST/WS)    │           ▼
                    ┌───┴──────────────────────────┐
   瀏覽器 / App ───▶│  D1: greeny-db               │
                    │  users / offices / racks /   │
                    │  telemetry / alerts / ...    │
                    └───▲──────────────────────────┘
                        │ D1 binding
                    ┌───┴──────────────────────────┐
   瀏覽器 ────────▶ │  Pages 專案: greeny          │
   (同源 /api/*)    │  ├ SPA (React, dist/)        │
                    │  └ Pages Functions (管理 API) │
                    └──────────────────────────────┘
```

### 三種資料流

| 流 | 路徑 | 認證 |
|---|---|---|
| **遙測上行** | ESP32 → WSS → Worker → DO-local SQLite →(60s alarm)→ D1 `telemetry` | device token |
| **指令下行** | 瀏覽器 → WSS/REST → Worker → DO → WSS → ESP32 → `ack` 回傳 | JWT（瀏覽器）／內部轉發 |
| **管理 CRUD** | 瀏覽器 → Pages Functions（同源 `/api/*`）→ D1 | JWT |

### ⚠️ 一個必須知道的資料現況

歷史上系統分裂成兩套並行的部署：

| | 本帳號（現行） | 舊帳號（已停用） |
|---|---|---|
| Worker | `iot-hub.ai-caseylai.workers.dev` ✅ 使用中 | `iot-hub.funconnect.workers.dev` ❌ WS 壞掉（HTTP 500） |
| D1 | **`greeny-db`**（管理資料 ＋ 遙測） | 另一個 DB（舊的 esp32-sensor 遙測） |

2026-10-13 已把 SPA 與韌體**全部切到本帳號**，因此：

- 管理資料（據點／貨架／用戶）與**新的**遙測都會進 `greeny-db`
- 但 `greeny-db` 現有的 426 筆遙測屬 **`WSD-001`**（aquagreen 時代的裝置）
- ESP32 **重新燒錄後**才會以 `esp32-sensor` 身分寫入 `greeny-db`

---

## 3. 雲端資源清單

**Cloudflare 帳號**：`Ai.caseylai@gmail.com's Account`（`3498e268169ccb1bd1ad614210804529`）

| 資源 | 識別 | 網址 / 綁定 | 說明 |
|---|---|---|---|
| **Pages 專案** | `greeny` | `greeny.techforliving.net`（主）<br>`greenie.techforliving.net`（別名）<br>`greeny.pages.dev` | SPA ＋ 管理 API |
| **Worker** | `iot-hub` | `iot-hub.ai-caseylai.workers.dev` | 裝置 WS、即時 REST、AI Chat |
| **D1 資料庫** | `greeny-db`<br>`7191a23e-c43b-4962-b3fb-96818ac2d07c` | Worker + Pages 共用 | 16 張表 |
| DNS | zone `techforliving.net` | 兩個域名 CNAME → `greeny.pages.dev`（proxied） | |

### Worker 綁定

```
ai:AI                              Workers AI（GreenyAgent 用）
d1:DB                    →         greeny-db
durable_object_namespace:DEVICE_HUB →  DeviceHub（每裝置一個實例）
durable_object_namespace:GREENY_AGENT → GreenyAgent（AI agent，單一實例 "greeny"）
compatibility_date: 2025-12-01
```

### 重要設定

| 項目 | 值 |
|---|---|
| Pages production branch | `main` |
| Pages Git 整合 | **無**（`source: null`；全部是 `ad_hoc` = `wrangler pages deploy` 直接上傳） |
| Pages 建立時間 | 2026-05-05 |
| 最新 Pages 部署 | `b3e00bf7`（2026-10-13） |

> 因為**沒有 Git 整合**，`git push` **不會**自動部署。改完程式一定要手動部署（見 §8）。

### D1 資料表現況（2026-10-13）

| 表 | 筆數 | 用途 |
|---|---|---|
| `users` | 5 | 登入帳號與角色 |
| `offices` | 4 | 據點 |
| `racks` | 1 | 貨架 |
| `rack_vegetables` | 0 | 貨架蔬菜層 |
| `rack_environment` | — | 環境數據（溫濕度／光照） |
| `devices` | 1 | 裝置註冊（目前為 `WSD-001`） |
| `telemetry` | 426 | 遙測歷史（皆為 `WSD-001`） |
| `alerts` | 300 | 警報 |
| `crop_batches` | 0 | 作物批次 |
| `harvest_logs` | — | 收成紀錄 |
| `automations` | — | 自動化規則 |
| `relay_log` / `relay_queue` | 3 | 指令稽核／待送佇列 |
| `settings` | 22 keys | 系統設定（含 `jwt_secret`、`device_token`） |

---

## 4. 帳號、角色與權限

### 帳號（`users` 表）

| 帳號 | 角色 | 說明 |
|---|---|---|
| `admin` | superadmin | 全部權限；可改任何人的角色／據點 |
| `office1` | office_admin | 只能管自己據點的人與資料 |
| `staff1` | staff | **唯讀**（寫入 API 回 403） |
| `office2` | office_admin | 第二個據點的管理者 |
| `caseylai` | superadmin | 種子帳號（密碼未記錄） |

> **密碼不在本文件**。全部為 PBKDF2 雜湊，無法還原；請以 `admin` 登入後到
> **「用戶管理」** 修改，或由維運人員重設（見 §9.2）。

### 角色權限矩陣

| 操作 | superadmin | office_admin | staff |
|---|---|---|---|
| 檢視儀表板／遙測／警報 | ✅ | ✅ | ✅ |
| 控制設備（LED／繼電器） | ✅ | ✅ | ✅ |
| 管理貨架／作物／任務 | ✅ | ✅（自己據點） | ❌ 403 |
| 管理用戶 | ✅ 全部 | ✅ 自己據點（不能改角色） | ❌ 403 |
| 管理據點 | ✅ | ❌ | ❌ |

---

## 5. 認證與安全模型

### 5.1 使用者認證（JWT）

| 項目 | 內容 |
|---|---|
| 演算法 | HS256（Web Crypto API，無 npm 依賴） |
| 密鑰來源 | **D1 `settings.jwt_secret`**（64 hex）— 不是環境變數、不是硬編碼 |
| 有效期 | 24 小時 |
| 傳遞 | `Authorization: Bearer <jwt>` |
| 密碼雜湊 | **`pbkdf2:<iterations>:<hex salt>:<hex hash>`**（PBKDF2-SHA256，100 000 次） |

**單一格式是刻意的**：Worker 與 Pages Functions 共用同一個自描述格式，因此同一筆
`users` 資料在兩邊都能驗證，且不需要額外的 `salt` 欄位（`greeny-db` 本來就沒有這欄）。

> ⚠️ 舊資料是 bcrypt（`$2b$…`）。任何「看到 `$2` 就放行」的程式碼都是**認證繞過**，
> 已於 2026-10-11 移除（見 §11）。

### 5.2 裝置認證（device token）

| 項目 | 內容 |
|---|---|
| 值 | D1 `settings.device_token`（48 hex） |
| 傳遞 | WebSocket：`/device/<id>?token=<device_token>`<br>HTTPS：`?token=` 或 header `X-Device-Token` |
| 裝置端存放 | Arduino：`firmware/esp32/device_secrets.h`（gitignored）<br>MicroPython：`firmware/esp32-micropython/device_secrets.py`（gitignored） |
| 未設定時 | Worker 允許連線並在 log 警告（方便逐步遷移）；**目前已設定 → 強制驗證** |

### 5.3 WebSocket 認證（在 Worker 層攔截，不進 DO）

| 路徑 | 憑證 | 失敗 |
|---|---|---|
| `/dashboard/<device_id>?token=<JWT>` | 使用者 JWT | **401** |
| `/device/<device_id>?token=<device_token>` | 裝置 token | **401** |
| 其他路徑的 WS 升級 | — | **404** |

> 為什麼用 query 參數：WebSocket handshake 無法設定 `Authorization` header。

### 5.4 對外攻擊面盤點（2026-10-13 狀態）

| 端點 | 認證 | 狀態 |
|---|---|---|
| `POST /api/auth/login` | 無（設計如此） | ✅ 已修（無繞過；PBKDF2 驗證） |
| `POST /api/telemetry` | device token 或 JWT | ✅ 已修（原本完全開放） |
| `wss://…/dashboard/*` | JWT | ✅ 已修（原本完全開放） |
| `wss://…/device/*` | device token | ✅ 已修（原本以 device_id 當身份） |
| 其餘 `/api/*`（Worker + Pages） | JWT | ✅ |
| `GET /api/relay`（Pages） | 無 | ⚠️ 刻意保留（裝置讀取用） |

### 5.5 已知殘留風險

| # | 風險 | 影響 | 建議 |
|---|---|---|---|
| 1 | `iot-hub.funconnect.workers.dev`（**另一帳號**）仍公開，且仍有 `$2` 登入繞過 | 任何人可用任何密碼取得該系統的 superadmin token | 停用該 Worker 或修補它（本帳號無權限） |
| 2 | 裝置 ID `esp32-sensor` 硬編碼在韌體 | 換機／多機需重編譯 | 改讀 NVS／flash 檔 |
| 3 | `GET /api/relay`（Pages）免認證 | 可讀取繼電器狀態 | 視需要加上 token |
| 4 | 曾出現於對話記錄的憑證 | GitHub PAT、Cloudflare token、`WB_API_KEY` | 建議輪換 |

---

## 6. 裝置接入（ESP32）

**只需要一件事：一條 WSS 連線。** 沒有 HTTPS POST、沒有 MQTT、沒有 API key。

```
wss://iot-hub.ai-caseylai.workers.dev:443/device/esp32-sensor?token=<device_token>
```

### 6.1 三個現成實作

協定完全相同，挑一個用即可。

| | Arduino 完整版 | **Arduino 精簡版** | MicroPython |
|---|---|---|---|
| 檔案 | `firmware/esp32/esp32.ino` | `firmware/greeny2_sensor/greeny2_sensor.ino` | `firmware/esp32-micropython/main.py` |
| 憑證檔 | `firmware/esp32/device_secrets.h` | `firmware/greeny2_sensor/device_secrets.h` | `firmware/esp32-micropython/device_secrets.py` |
| 說明文件 | `firmware/FIRMWARE.md` | 同目錄 `README.md` | `firmware/esp32-micropython/README.md` |
| 行數 | ~1150 | ~374 | ~540 |
| OLED 顯示 / Captive Portal / EEPROM 校正 | ✅ | ❌ | ❌ |
| TLS 驗證 | ✅ 內建 CA bundle | ✅ 內建 CA bundle | ⚠️ 預設 `TLS_VERIFY = False` |
| 校正值儲存 | EEPROM | 常數 | 常數 |
| 工具鏈 | arduino-cli 1.5.1 ＋ esp32 core 3.3.12 | 同左 | esptool + mpremote |
| 成熟度 | ✅ **曾在實機運行**；Captive Portal 已接通並編譯通過（1,182,090 B / 90%），⚠️ 該流程未上機 | ✅ **編譯通過**（1,115,705 B / 85%），⚠️ 未上機 | ⚠️ 未上機（已過 `py_compile`） |

> **選用建議**：上線 → 完整版（功能最齊）；要讀懂或改寫協定邏輯 → 精簡版或 MicroPython 版。
> Arduino IDE 要求「資料夾名稱 = .ino 名稱」，所以精簡版放在 `greeny2_sensor/` 而非與完整版同目錄。

### 6.2 連線前置條件（缺一不可）

1. **2.4 GHz WiFi**（ESP32 看不到 5 GHz）
2. **先做 NTP 對時** —— ESP32 無電池 RTC，開機是 1970 → **TLS 憑證會被判定失效**
3. TLS 用 ESP32 內建 CA bundle（Arduino）；MicroPython 需關閉驗證或自備 CA

> 若連第一項都不成立（現場換了 WiFi、密碼改了），完整版會自動開熱點讓人重新設定 → §6.4。

### 6.3 燒錄

```bash
# ── Arduino 版 ──
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COM3 firmware/esp32
arduino-cli monitor -p COM3 -c baudrate=115200

# ── MicroPython 版 ──
esptool.py --chip esp32 --port COM3 erase_flash
esptool.py --chip esp32 --port COM3 --baud 460800 write_flash -z 0x1000 ESP32_GENERIC-*.bin
mpremote connect COM3 fs cp firmware/esp32-micropython/device_secrets.py :device_secrets.py
mpremote connect COM3 fs cp firmware/esp32-micropython/main.py           :main.py
mpremote connect COM3 reset
```

### 6.4 Captive Portal（完整版備援：WiFi 連不上時）

完整版韌體（`firmware/esp32/esp32.ino`）在 **STA 連不上 WiFi** 時會自己開熱點，
讓手機在沒有網路、沒有序列埠的情況下重新設定：

1. 開機若 30 秒內連不上（EEPROM 或編譯期預設的）WiFi → 進入 AP 模式，
   熱點名稱 **`Greeny-Alpha-Setup`**（無密碼），手機連上後開 `http://192.168.4.1`。
2. 頁面可掃描附近 AP、輸入 SSID／密碼 → **Save & Reboot**：
   憑證寫入 EEPROM（`0xAB` 旗標 ＋ SSID ＋ 密碼）後 `ESP.restart()`，重開即以新憑證連線。
3. AP 模式期間**不送遙測、不連 WSS**；每 30 秒會試著連回原本的 WiFi，
   連上就自動收掉熱點、回到正常流程。
4. **逾時退路**：10 分鐘內沒設定、也沒連上 → 重啟裝置（避免永久卡在 AP 模式無法遠端救援）。
   重啟前會清掉 WiFi NVS 的 STA 憑證，所以下次開機仍會回到 AP 模式，不會無線重開機。
5. 連線中途掉線（非開機時）時，裝置仍以自動重連為主；只有持續連不上時才會走同一條 AP 模式流程。

> ⚠️ 這條流程已接通並通過編譯，但**尚未在實體硬體上驗證**（見 §6.1 成熟度欄）。
> 它與 §9.4 的 WSS `wifi_scan`／`wifi_set` 是**兩條獨立**的設定途徑：後者需要裝置已連上網路。

### 6.5 通訊協定摘要

| 方向 | 訊息 | 頻率 |
|---|---|---|
| 裝置 → 雲端 | `telemetry`（tds/ec/ph/temp/led/esp32_ms） | 每 10 秒 |
| 裝置 → 雲端 | `ping` | 每 10 秒（心跳） |
| 雲端 → 裝置 | `sync`（連線時，回報目前 LED 狀態） | 事件 |
| 雲端 → 裝置 | `{"command":"set_led","params":{"state":bool}}` | 事件 |
| 裝置 → 雲端 | `ack`（指令確認） | 事件 |

**完整訊息格式、所有指令與錯誤碼 → [`docs/API.md` Part A](./API.md#part-a--esp32-裝置接入重點)。**

> 🔴 **最常見的兩個錯誤**
> 1. 指令參數要包在 `params`：`{"command":"set_led","params":{"state":true}}`，
>    **不是** `{"command":"set_led","state":true}`。
> 2. `set_led`（持久佇列，離線補送）與 `calibrate`（QoS 0，離線丟棄）可靠性不同。

### 6.6 硬體

| 用途 | 腳位 |
|---|---|
| LED | GPIO 2 |
| TDS（DFRobot SEN0244） | GPIO 35（ADC1） |
| pH 探頭 + 放大板 | GPIO 39（ADC1） |
| DS18B20 水溫 | GPIO 13（OneWire） |

只能用 **ADC1（GPIO 32–39）** —— WiFi 開啟時 ADC2 不可用。

---

## 7. 前端功能

SPA（React 18 + TypeScript + Vite + Tailwind）由 Pages 服務：

| 路由 | 功能 |
|---|---|
| `/login` | 登入（AquaGreen 品牌） |
| `/` | 儀表板：KPI、趨勢圖、裝置狀態 |
| `/water-quality` | 水質儀表（pH/EC/TDS/水溫）＋歷史 |
| `/device-control` | 裝置卡片、LED 開關、即時 WS 狀態 |
| `/alerts` | 警報列表、篩選、確認 |
| `/racks` `/racks/office/:id` | 據點／貨架／蔬菜層／環境數據 |
| `/crops` | 作物批次、收成 |
| `/users` | 用戶管理（角色、密碼） |
| `/settings` | WiFi 掃描切換、維護閾值、系統資訊 |

語言：**🇬🇧 English / 🇭🇰 繁體中文 / 🇨🇳 简体中文**（右上角下拉切換，存 localStorage）。

### 前端呼叫哪個後端

| 用途 | 目標 | 程式位置 |
|---|---|---|
| 遙測、裝置、警報、登入、AI Chat | **Worker** | `spa/src/lib/api.ts` 的 `apiFetch()` |
| 管理 CRUD（貨架／作物／用戶） | **Pages Functions（同源）** | `mgmtApiFetch()` |
| 即時推播 | **Worker WSS** | `spa/src/hooks/useWebSocket.ts`（自動帶 `?token=`） |

---

## 8. 部署與維運

### 8.1 部署 Pages（SPA ＋ 管理 API）

```powershell
cd C:\Users\User\Documents\greeny2\spa
npm run build                                   # tsc -b && vite build → dist/

# 需要 Pages:Edit 權限的 token（見 8.3）
$env:CLOUDFLARE_API_TOKEN = "<pages-token>"
$env:CLOUDFLARE_ACCOUNT_ID = "3498e268169ccb1bd1ad614210804529"
node node_modules\wrangler\wrangler-dist\cli.js pages deploy dist --project-name=greeny --branch=main
```

### 8.2 部署 Worker

```powershell
cd C:\Users\User\Documents\greeny2\edge

# 需要 Workers Scripts:Write 權限的 token（見 8.3）
$env:CLOUDFLARE_API_TOKEN = "<workers-token>"
$env:CLOUDFLARE_ACCOUNT_ID = "3498e268169ccb1bd1ad614210804529"
node ..\spa\node_modules\wrangler\wrangler-dist\cli.js deploy
```

> ℹ️ 直接呼叫 `wrangler-dist\cli.js` 是刻意的：`node_modules\.bin\wrangler.cmd` 這類
> shim 在 Windows 上傳參會出錯（連 `--version` 都失敗）。

### 8.3 權限：為什麼要臨時 token

**永久 token（使用者環境變數 `CLOUDFLARE_API_TOKEN`）沒有 Pages 與 Workers 的寫入權限**，
部署時會 403。作法是透過 Cloudflare MCP（`cf-admin`）用 admin token 臨時建一顆：

| 需要 | 權限群組 |
|---|---|
| Pages 部署 / 改環境變數 | `Pages Read` + `Pages Write` |
| Worker 部署 | `Workers Scripts Read` + `Workers Scripts Write`（＋`Workers Tail Read`） |

**用完務必刪除**（`DELETE /user/tokens/<id>`）。長期解法：把 `Pages Write` 與
`Workers Scripts Write` 加進永久 token。

### 8.4 環境變數與密鑰

| 位置 | 變數 | 說明 |
|---|---|---|
| D1 `settings` | `jwt_secret` | JWT 簽章密鑰（Worker 與 Pages 共用） |
| D1 `settings` | `device_token` | 裝置認證 |
| D1 `settings` | `ph_min/ph_max/ec_max/temp_min/temp_max` | **警報閾值（權威來源）** —— DeviceHub 每個 alarm 週期讀取，改這裡就會改變警報行為。可透過 `GET`/`PUT /api/settings/thresholds` 或設定頁修改（<60 秒生效） |
| Pages 專案 | `WB_API_KEY` | **`secret_text`**（`/api/wb/*` 用；該路徑目前無端點） |
| Pages 專案 | `API_KEY`、`WORKBUDDY_*` | 空值（保留） |
| 本機 | `wifi.env`、`device_secrets.*` | 已 gitignore |

> ❌ `JWT_SECRET` 與 `WB_API_KEY` **刻意不放在 `spa/wrangler.toml`**，避免公開預設值
> 被提交，也避免 `wrangler pages deploy` 用 `[vars]` 覆蓋。

### 8.5 D1 變更

```powershell
# 查詢（Cloudflare API）
POST /accounts/3498e268169ccb1bd1ad614210804529/d1/database/7191a23e-c43b-4962-b3fb-96818ac2d07c/query
body: {"sql":"SELECT ...","params":[]}

# 或 wrangler
npx wrangler d1 execute greeny-db --remote --file db/migrations/00X_xxx.sql
```

### 8.6 監控與日誌

| 想看什麼 | 方法 |
|---|---|
| Worker 即時日誌 | `wrangler tail iot-hub` |
| Worker 錯誤 | 同上；WS 拒連會印 `rejected device <id>: bad device token` |
| Pages Functions 日誌 | Cloudflare dashboard → Pages → greeny → Deployments → Functions logs |
| 裝置是否在線 | `GET /api/devices`（需 JWT） |
| 最近遙測 | `GET /api/telemetry?device_id=esp32-sensor&limit=10` |
| 部署歷史 | `GET /accounts/<acct>/pages/projects/greeny/deployments` |

### 8.7 回滾

| 目標 | 作法 |
|---|---|
| Pages | Dashboard → Deployments → 選舊版本 → **Rollback to this deployment** |
| Worker | Dashboard → Workers → iot-hub → Deployments → 選舊版本 → Rollback |
| 程式碼 | `git revert <sha>` 或 `git reset --hard <sha>` 後重新部署（改歷史需 force push） |

---

## 9. 日常操作 SOP

### 9.1 登入

- 入口：**https://greeny.techforliving.net/**
- 帳號見 §4；**密碼請向維運人員索取，並於首次登入後更改**

### 9.2 新增／修改使用者、改密碼

1. 以 superadmin 登入 → 側欄 **「用戶管理」**
2. 新增或編輯使用者 → 設定 **密碼**（後端以 PBKDF2 雜湊存入）
3. 權限限制：`office_admin` 只能改自己據點的人、不能改角色；`staff` → 403

### 9.3 新增據點 / 貨架 / 作物

1. **據點**：貨架頁 → 新增據點（名稱、聯絡人、電話、WhatsApp）
2. **貨架**：進入據點 → 新增貨架（可綁定 `device_id`）
3. **蔬菜層**：貨架詳情 → 新增該層品種、數量、種植日期
4. **作物批次**：作物頁 → 新增批次（品種、數量、種植日）→ 收成時記錄

### 9.4 遠端切換 ESP32 的 WiFi

1. 設定頁 → **掃描網路** → 選 SSID → 輸入密碼 → 連線
2. 流程：瀏覽器送 `wifi_scan` → DO 轉發裝置 → 裝置回 `wifi_list`
3. 連線失敗時裝置會**自動回滾**到前一組網路並回報 `wifi_ack: error`

### 9.5 校正（重要：必須在裝置連線時做）

| 指令 | 需要材料 |
|---|---|
| `{"type":"ec_zero"}` | 真實蒸餾水（不是瓶裝飲用水） |
| `{"type":"ec_1413"}` | 1413 μS/cm 標準液 |
| `{"type":"ph_7"}` / `ph_4` / `ph_9` | 對應 pH 緩衝液 |
| `{"type":"reset"}` | —（回復預設值） |

> **`calibrate` 是 QoS 0**：裝置離線時指令會被丟棄（HTTP 回 503），不會補送。
> Arduino 版會寫入 EEPROM；MicroPython 版只回報量測值，需手動寫回程式常數。

### 9.6 更換 device token

1. 產生新值：`python -c "import secrets;print(secrets.token_hex(24))"`
2. 更新 D1：`UPDATE settings SET value='<新值>' WHERE key='device_token';`
3. 更新韌體憑證檔（`device_secrets.h` 或 `device_secrets.py`）
4. **重新燒錄裝置** —— 未更新前裝置會被 401 拒絕
5. 驗證：`wrangler tail iot-hub` 應看到裝置重新連上

### 9.7 新增一台裝置

1. 決定 `device_id`（例：`esp32-sensor-2`）
2. 複製憑證檔並改 `DEVICE_ID`（token 可共用或另發）
3. 燒錄 → 連上後 DO 會自動廣播 `device_status: online`
4. 在 `devices` 表／管理介面註冊該裝置，綁定到貨架
   （目前裝置 ID 硬編碼在韌體，多裝置需各自編譯 —— 見 §12）

### 9.8 緊急停用裝置

- 換掉 `device_token` → 所有舊裝置立即無法連線
- 或在 D1 把 `settings.device_token` 設為空字串（＝不驗證，**不建議**）

---

## 10. 疑難排解

### 10.1 網頁相關

| 症狀 | 原因 | 對策 |
|---|---|---|
| 登入後立刻跳回登入頁 | JWT 驗證失敗（Worker 與 Pages 密鑰不一致） | 確認 D1 `settings.jwt_secret` 存在且兩邊都讀同一個 |
| 頁面轉很久、資料沒更新 | SPA 指向的 Worker 不正確 | 檢查 bundle 內是否為 `iot-hub.ai-caseylai.workers.dev` |
| 看到舊版網頁 | CDN/瀏覽器快取 | `Ctrl+Shift+R`；或確認已重新部署 |
| 改了程式但線上沒變 | **Pages 沒有 Git 整合** | 必須手動 `wrangler pages deploy`（§8.1） |
| API 回 500 | Functions 拋錯 | Dashboard → Pages → Functions logs |

### 10.2 裝置相關

| 症狀 | 原因 | 對策 |
|---|---|---|
| WS 連線被 401 | device token 錯／未更新 | 比對 D1 `settings.device_token` 與韌體憑證檔 |
| WS 連線被 404 | 路徑不對 | 必須是 `/device/<id>` 或 `/dashboard/<id>` |
| TLS 握手失敗 | NTP 未同步（時鐘 1970） | 確認 `ntp_sync()` 成功；MicroPython 可設 `TLS_VERIFY=False` |
| 連上又馬上斷、一直重連 | 上述 401/404/TLS | 看裝置序列埠輸出與 `wrangler tail` |
| `set_led` 沒反應 | 參數沒包在 `params`（見 §6.5） | 改用 `{"command":"set_led","params":{"state":true}}` |
| 校正沒反應 | 裝置離線 → QoS 0 丟棄 | 確認裝置在線再下校正指令 |
| 有送遙測但收不到指令 | DO 沒把裝置登記為 `esp32ws` | 確認連的是 `/device/` 而非 `/dashboard/` |
| EC 讀值接近滿刻度 | 探頭乾掉或未接 SEN0244 | 檢查接線 |
| pH 固定讀 ~3.3 V | 硬體問題（缺放大板） | 檢查 pH 模組 |

### 10.3 部署相關

| 症狀 | 對策 |
|---|---|
| `wrangler.cmd` 說 `Unknown arguments` | 直接用 `node node_modules\wrangler\wrangler-dist\cli.js`（§8.2） |
| 部署回 403 `Authentication error` | token 缺 Pages:Write / Workers Scripts:Write（§8.3） |
| `BuildFailure … api/xxx.ts:2` | import 路徑層數錯了（`api/` 底下是 `../_lib/`，`api/auth/` 底下才是 `../../_lib/`） |
| PowerShell 語法錯誤 | 這個環境是 **PowerShell 5.1**：不支援 `? :` 三元運算子、`||`；含 `[` `]` 的路徑要用 `-LiteralPath` |

---

## 11. 安全修補歷史

### 2026-10-11 ~ 10-13 一輪完整修補

| # | 問題 | 嚴重性 | 修正 |
|---|---|---|---|
| 1 | **登入繞過**：`password.ts` 有 `if (storedHash.startsWith('$2')) return true;` → 任何密碼都能以 admin 登入 | 🔴 極高 | 移除短路，改 fail closed；統一為 `pbkdf2:` 格式 |
| 2 | Worker 登入查詢 `SELECT … salt`，但 `greeny-db` 沒有該欄位 | 🟡 | 移除 `salt`，改用自描述格式 |
| 3 | Pages `/api/auth/me` 回 500 | 🟡 | middleware 不再對整個 `/api/auth/` 前綴放行 |
| 4 | **WebSocket 完全無認證**：知道 device_id 就能看遙測、遙控繼電器 | 🔴 高 | `/dashboard` 驗 JWT、`/device` 驗 device token（Worker 層攔截） |
| 5 | **`POST /api/telemetry` 完全開放** → 可灌假遙測 | 🔴 高 | 需 device token 或 JWT |
| 6 | 5 個帳號仍是預設密碼 `admin123`，4 個是 bcrypt 格式 | 🔴 高 | 全數遷移為 PBKDF2 並換新密碼 |
| 7 | `JWT_SECRET` / `WB_API_KEY` 以公開預設值提交在 `wrangler.toml` | 🟡 中 | 移除；`WB_API_KEY` 改為 Pages 專案的 `secret_text` |
| 8 | 舊的 `edge/src/index.mjs` 打包產物仍在 repo，含**有漏洞的登入與無認證 WS** | 🟡 中 | `git rm`（部署改用 `wrangler deploy`） |
| 9 | SPA 與韌體指向**另一帳號**的 Worker（WS 壞、資料分裂） | 🟡 中 | 全部切到 `iot-hub.ai-caseylai.workers.dev` |
| 10 | 裝置 token 曾一度寫進要提交的韌體原始碼 | 🔴 高 | 移到 gitignored 的 `device_secrets.*` |

更早（同日）還處理了：repo 歷史中外洩的 WiFi 憑證（`git filter-repo` 改寫 ＋ 刪除重建 repo）。

> 詳細的技術紀錄（修補前後行為、驗證結果）見 [`docs/API.md` Part F](./API.md)。

---

## 12. 待辦與已知限制

### 未完成

| # | 項目 | 說明 |
|---|---|---|
| 1 | **ESP32 重新燒錄** | 唯一卡住的維運項：新 host ＋ device token 都要重燒才生效 |
| 2 | `iot-hub.funconnect.workers.dev`（另一帳號） | 仍公開且有相同登入繞過；本帳號無權處理 → 建議停用 |
| 3 | 裝置 ID 硬編碼 | 多裝置需各自編譯；建議改讀 NVS / flash 檔 |
| 4 | `GET /api/relay`（Pages）免認證 | 可讀繼電器狀態 |
| 5 | MicroPython 校正值不持久化 | 與 Arduino 的 EEPROM 行為不一致 |
| 6 | MicroPython 版 TLS 不驗證身分 | 可自備 CA 後開啟 `TLS_VERIFY` |
| 7 | Pages 永久 token 權限不足 | 每次部署都要臨時建 token |
| 8 | 沒有 CI | `git push` 不會部署；重要變更靠手動 |

### 已知資料狀況

- `greeny-db.telemetry` 的 426 筆全屬 **`WSD-001`**（aquagreen 時代裝置）
- ESP32（`esp32-sensor`）重燒後才會開始寫入 `greeny-db`
- `crop_batches`、`rack_vegetables` 目前為 0 筆（功能可用，尚無資料）

### 待輪換的憑證

GitHub PAT、3 顆 Cloudflare token、`WB_API_KEY`（皆曾以明文出現於對話記錄）

---

## 13. 附錄

### 13.1 憑證位置（**本文件不含值**）

| 憑證 | 存放位置 | 讀取方式 |
|---|---|---|
| JWT 密鑰 | D1 `settings.jwt_secret` | D1 query |
| 裝置 token | D1 `settings.device_token` | D1 query |
| 裝置 token（裝置端） | `firmware/esp32/device_secrets.h`<br>`firmware/esp32-micropython/device_secrets.py` | 本機檔案（gitignored） |
| `WB_API_KEY` | Cloudflare Pages → greeny → Settings → Environment variables | Dashboard（`secret_text`，API 讀不回） |
| WiFi 帳密 | `wifi.env`（AquaGreen 舊版）／裝置 EEPROM／`device_secrets.*` | 本機檔案 |
| Cloudflare 部署 token | 使用者環境變數 `CLOUDFLARE_API_TOKEN*` | 系統環境變數 |
| GitHub PAT | 使用者環境變數 `GITHUB_PERSONAL_ACCESS_TOKEN` | 系統環境變數 |

### 13.2 檔案地圖

```
greeny2/
├── README.md ARCHITECTURE.md PROTOCOL.md        # 原始設計文件
├── docs/
│   ├── GUIDE.md                                 # ← 本文件（系統總覽與操作）
│   └── API.md                                   # API 規格 ＋ 修補記錄（Part F）
├── edge/                                        # Cloudflare Worker
│   ├── EDGE.md DASHBOARD.md AI-POSTMORTEM.md
│   ├── wrangler.jsonc                           # name: iot-hub, bindings
│   └── src/
│       ├── index.ts        # 路由、REST、JWT/device token 認證、WS 攔截
│       ├── device-hub.ts   # DO：WS 握手、訊息分派、指令語意、alarm
│       ├── agent.ts        # DO：GreenyAgent（Workers AI）
│       └── auth.ts         # JWT 簽驗、PBKDF2
├── spa/                                         # 前端 + Pages Functions
│   ├── wrangler.toml                            # name: greeny, D1 binding
│   ├── src/                                     # React SPA
│   ├── functions/api/                           # 管理 API（檔案即路由）
│   └── dist/                                    # 建置產物（有進版控）
├── firmware/
│   ├── FIRMWARE.md POSTMORTEM.md smoke_test.py
│   ├── esp32/                # Arduino 版
│   │   ├── esp32.ino
│   │   └── device_secrets.h  # gitignored（憑證）
│   └── esp32-micropython/    # MicroPython 版
│       ├── main.py README.md
│       ├── device_secrets.example.py
│       └── device_secrets.py # gitignored（憑證）
└── tools/                                       # 輔助腳本（probe / toggle-led）
```

### 13.3 常用指令速查

```powershell
# 建置 + 部署前端
cd C:\Users\User\Documents\greeny2\spa ; npm run build ; node node_modules\wrangler\wrangler-dist\cli.js pages deploy dist --project-name=greeny --branch=main

# 部署 Worker
cd C:\Users\User\Documents\greeny2\edge ; node ..\spa\node_modules\wrangler\wrangler-dist\cli.js deploy

# 看 Worker 即時日誌
cd C:\Users\User\Documents\greeny2\edge ; node ..\spa\node_modules\wrangler\wrangler-dist\cli.js tail

# 查 D1
$sql = "SELECT * FROM users"
# POST /accounts/3498e268169ccb1bd1ad614210804529/d1/database/7191a23e-c43b-4962-b3fb-96818ac2d07c/query

# 健康檢查（免認證）
curl https://iot-hub.ai-caseylai.workers.dev/health
```

### 13.4 連線測試腳本

`tools/greeny_check.py` —— **端到端連線測試**，22 項檢查，涵蓋整條鏈路：

| 區段 | 檢查內容 |
|---|---|
| 1. 基礎連線 | Worker `/health`、Pages SPA 首頁 |
| 2. 使用者登入 | Worker 與 Pages 登入、**錯誤密碼必須被拒絕（401）** |
| 3. Worker REST | `/api/auth/me`、`/api/devices`、`/api/telemetry`、`/api/alerts`、**無 token 必須 401** |
| 4. Pages 管理 API | `/api/auth/me`、`/api/offices`、`/api/racks`、`/api/users`、`/api/dashboard/stats`、**無 token 必須 401** |
| 5. 儀表板 WS | 無 token／假 token → 401；有效 JWT → 101 並收到 `state` |
| 6. 裝置 WS | 無／錯 device token → 401；正確 token → 101 並收到 `sync` |
| 7.（選用） | `POST /api/telemetry` 寫入測試 ＋ 無憑證必須 401 |

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:GREENY_USER = "admin"
$env:GREENY_PASSWORD = "<密碼>"
$env:GREENY_DEVICE_TOKEN = "<device_token>"

python tools\greeny_check.py                 # 人看的輸出
python tools\greeny_check.py --json          # 給監控用（失敗時 exit code 1）
python tools\greeny_check.py --write-test     # 加測遙測寫入（會新增一筆資料）
```

**設計上的安全細節**：裝置 WS 測試預設用 `<device-id>-probe` 這個探測 id，而非真實
`device_id` —— 因為 Durable Object 只接受一個 `esp32` 連線，用真 id 會把**正在上線的
裝置踢下線**。要對真實裝置測請明確加 `--device-ws-id esp32-sensor`。

`tools/greeny_probe.py` 是較早的簡易版（保留備用）。

---

**文件維護**：改動架構、端點、認證或部署流程時，請同步更新本文件與
[`docs/API.md`](./API.md)；安全性相關請一併補進 §11 與 API.md Part F。
