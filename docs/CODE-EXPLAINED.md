# Greeny2 — 程式碼層級解說（CODE-EXPLAINED）

> **這是什麼**：一份「程式碼怎麼運作、為什麼這樣寫」的導讀——函式呼叫關係、設計取捨、
> 實際踩過的坑與修補原因。不是規格書，也不是操作手冊。
>
> | 想知道 | 看哪份 |
> |---|---|
> | 端點 request/response、WS 訊息格式、裝置協定 | [`docs/API.md`](./API.md) |
> | 系統總覽、權限、部署、SOP、疑難排解 | [`docs/GUIDE.md`](./GUIDE.md) |
> | **程式碼怎麼跑、為什麼這樣寫、哪裡容易改壞** | **本文件** |
>
> 本文件**不含任何憑證**（只寫存放位置）。不確定的地方標「（待確認）」，完整清單見附錄。
> 行號以本次閱讀的版本為準（LF 換行）。⟶ 行號若位移，請以**函式名稱**搜尋。
>
> ⚠️ `edge/EDGE.md` 與根目錄 `PROTOCOL.md` 是早期設計文件，與現工程式碼已有落差
> （`EDGE.md:189-206` 仍教人上傳已刪除的 `src/index.mjs`）。以本文件與 `edge/src/*.ts` 為準。

**目錄**：1 [定位](#1-文件定位)｜2 [資料流](#2-整體資料流)｜3 [Worker](#3-workeredge逐檔解說)｜
4 [Pages Functions](#4-pages-functionsspafunctions逐檔解說)｜5 [SPA](#5-前端-spaspasrc)｜
6 [韌體](#6-韌體逐段解說)｜7 [工具](#7-工具)｜8 [資料模型](#8-資料模型)｜
9 [設計取捨](#9-關鍵設計決策與取捨)｜10 [陷阱彙整](#10-程式碼層面的陷阱彙整)

---

## 1. 文件定位

Greeny2（品牌 AquaGreen）是智慧水耕農場管理平台：

| 元件 | 目錄 | 角色 |
|---|---|---|
| Worker `iot-hub` | `edge/` | 裝置 WS 入口、即時 REST API、兩個 Durable Object |
| Pages 專案 `greeny` | `spa/` | React SPA ＋ Pages Functions 管理 API |
| D1 `greeny-db` | — | 兩邊共用的持久層 |
| 韌體 | `firmware/` | Arduino 完整版／精簡版、MicroPython |

本文件回答「讀程式碼時會冒出的問題」：為什麼 DO 的 `webSocketMessage()` 不能有 `await`？
為什麼 WS token 放 query string？為什麼有兩套 fetch？為什麼 `$2` 開頭就放行是災難？
規格看 `docs/API.md`、操作看 `docs/GUIDE.md`，本文件只做交叉引用。

---

## 2. 整體資料流

### 2.1 遙測上行

```
ESP32 sendTelemetry()                        firmware/esp32/esp32.ino:729
Worker fetch()                               edge/src/index.ts:503
  ├─ needsAuth() → false（/device/ 前綴）     :61
  ├─ Upgrade === "websocket" 分支             :575
  ├─ getDeviceToken() 比對 ?token=            :42、587
  └─ env.DEVICE_HUB.idFromName(deviceId)      :598
DeviceHub.fetch()                            edge/src/device-hub.ts:113
  ├─ ctx.acceptWebSocket(server)              :244
  ├─ serializeAttachment({role,...})          :252
  ├─ 清空 relay_queue（重連時）                :259
  └─ send({type:"sync", led, doTs})           :271
       ▼ 之後每 10 秒
webSocketMessage() → handleTelemetry()       :292、328
  ├─ INSERT telemetry_buffer（同步 SQL）       :339
  ├─ evaluateAlerts() → alert_buffer           :488、364
  ├─ drainRelayQueue()                         :508
  └─ broadcast(state / telemetry_update)       :378、387
       ▼ 每 60 秒
alarm()                                      :531
  └─ 批次 INSERT → D1 telemetry/alerts/relay_log ＋ UPDATE devices.last_seen
```

### 2.2 指令下行

```
SPA useWebSocket().toggleLed()               spa/src/hooks/useWebSocket.ts:107
  ├─ 優先：POST https://iot-hub.../api/relay   :112
  └─ 後備：WS send({command:"set_led",...})    :127
Worker handleRelay()                         edge/src/index.ts:736 → :744 relay-cmd
DeviceHub.fetch() → /relay-cmd               edge/src/device-hub.ts:117
  └─ INSERT relay_queue + relay_log_buffer，直接 send 給 esp32ws
ESP32 webSocketEvent() → WStype_TEXT         firmware/esp32/esp32.ino:472
  └─ set_led → setLED() → 回 ack              :486
handleAck()                                  edge/src/device-hub.ts:400
  └─ relay_log_buffer（status='acked'）＋ broadcast state
```

AI agent 走路徑完全一樣，只換入口：`POST /api/chat` → `handleChat()`
（`edge/src/index.ts:723`）→ `GreenyAgent`。它下 `toggle_led` 時也打 DeviceHub 的
`/relay-cmd`（`edge/src/agent.ts:1047`），**與瀏覽器共用同一條指令路徑**。

### 2.3 管理 CRUD

```
SPA mgmtApiFetch('/api/racks')               spa/src/lib/api.ts:45
  └─ fetch('/api/racks')   ← 同源，不跨到 Worker
Pages Functions 檔案即路由                    spa/functions/api/racks/index.ts
  ├─ api/_middleware.ts 驗 JWT                spa/functions/api/_middleware.ts:10
  └─ c.data.user 帶進 handler → D1 greeny-db
```

**`apiFetch()` 與 `mgmtApiFetch()` 打兩台不同伺服器**，但共用同一把 JWT 密鑰
（都讀 D1 `settings.jwt_secret`），所以 Worker 發的 token 在 Pages 也有效，反之亦然。

---

## 3. Worker（`edge/`）逐檔解說

### 3.1 `edge/src/index.ts` — 路由與認證閘門

**路由分派順序**（`fetch()`，`:503-604`）本身就是設計：

```
1. OPTIONS              → 204 + CORS_HEADERS        :509
2. GET / 或 /dashboard  → DASHBOARD_HTML            :514
3. GET /health          → {status:"ok", uptime}     :520
4. POST /api/auth/login → handleLogin()             :528
5. if (needsAuth(...))  → authenticate() → 401 或繼續 :533
6. WebSocket upgrade    → 認證 → DO stub            :574
7. 其他                 → 404                       :603
```

`needsAuth()` 是「**預設要認證**」的閘門，不是逐條白名單比對——任何新端點只要沒被
明確放行就會自動要求 JWT。這是 fail-closed 的路由設計：忘記加白名單的後果是
「新端點不能用」，不是「新端點裸奔」。

**`AUTH_WHITELIST` 與 `needsAuth()`**（`:54-66`）：

```ts
const AUTH_WHITELIST = new Set([
  "GET:/", "GET:/dashboard", "GET:/health", "POST:/api/auth/login",
]);
function needsAuth(method: string, path: string): boolean {
  // WebSocket upgrade paths: browsers cannot set Authorization headers,
  // so token is passed as ?token= query param. Skip header-based auth.
  if (path.startsWith("/device/") || path.startsWith("/dashboard/")) return false;
  return !AUTH_WHITELIST.has(`${method}:${path}`);
}
```

三個細節：(1) key 是 **`METHOD:path`** 完整字串，所以 `GET:/api/auth/login` 不在白名單
→ GET 打登入會落到第 7 步回 404（好事，登入只能 POST）。(2) 比對是**精確相等**
（`Set.has`）不是前綴，`POST:/api/auth/login` 不會連帶放行 `/api/auth/me`
——這個「不要用前綴」的教訓在 Pages 端又踩了一次（§4.1）。(3) `/device/`、`/dashboard/`
只是「跳過 header 式認證」，**不是免認證**，認證搬到下面的 WS 區塊用 `?token=` 做。

**`getJWTSecret()` 與 `getDeviceToken()`**：

```ts
// edge/src/index.ts:24-33
let cachedJWTSecret: string | null = null;
async function getJWTSecret(env: Env): Promise<string> {
  if (cachedJWTSecret) return cachedJWTSecret;
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'jwt_secret'").first<{ value: string }>();
  if (row) cachedJWTSecret = row.value;
  return cachedJWTSecret ?? "";
}
```

- **快取**是模組層級變數（同一 isolate 生命週期內有效，冷啟動只查一次 D1）。
- **回傳 `""` 而非拋錯**：`authenticate()`（`:76-79`）看到空字串就 `return null` → 401。
  **沒有「沒有密鑰就用預設值」的後路。**
- **為什麼放 D1 而不放 wrangler secret**：Worker 與 Pages 要共用同一把密鑰，D1 是兩邊
  唯一共用的儲存；且 `spa/wrangler.toml:12-13` 已刻意移除 `JWT_SECRET` 的公開預設值。
  代價是每次冷啟動多一次 D1 讀取。

`getDeviceToken()`（`:40-49`）語意**不同**：判斷式是 `cachedDeviceToken !== null`
（不是 truthy），所以**空字串也會被快取**。功能上無害，但 `getJWTSecret` 在密鑰缺失時
會每請求重查 D1，兩者不一致，容易誤讀。

**WebSocket 升級前的認證區塊**（`:574-601`）是 Phase 3 後最重要的修補：

```ts
const upgrade = request.headers.get("Upgrade");
if (upgrade === "websocket") {
  const segments = path.split("/").filter(Boolean);
  const deviceId = segments.length >= 2 ? segments[1] : "unknown";
  const token = url.searchParams.get("token") || "";

  if (path.startsWith("/dashboard/")) {          // 人：JWT
    const secret = await getJWTSecret(env);
    const payload = secret ? await verifyJWT(token, secret) : null;
    if (!payload) return corsJson({ error: "Unauthorized" }, { status: 401 });
  } else if (path.startsWith("/device/")) {      // 機器：device token
    const expected = await getDeviceToken(env);
    if (!expected) console.warn("[Worker] device_token not configured — device channel open");
    else if (token !== expected) return corsJson({ error: "Unauthorized device" }, { status: 401 });
  } else {
    return corsJson({ error: "Not found" }, { status: 404 });
  }
  const doId = env.DEVICE_HUB.idFromName(deviceId);
  return env.DEVICE_HUB.get(doId).fetch(request);
}
```

四個決策：

1. **認證在 Worker 層完成、不進 DO**：未通過的請求不消耗 DO 喚醒成本，DO 可完全信任
   進來的連線。
2. **兩個角色用兩把憑證**：dashboard 用 JWT（人）、device 用 device token（機器）。
   裝置不該有「使用者」身份概念，而且 JWT 會過期（24 小時），裝置不可能每天重登。
3. **憑證走 `?token=` query**：瀏覽器的 `WebSocket` 建構子**無法**設 `Authorization`
   header，ESP32 的 `WebSocketsClient` 也沒有；query 是唯一雙方都可行的通道。
   代價是 token 會進 access log（§9）。
4. **其他路徑的 WS 升級回 404**：舊的 `edge/src/index.mjs` 沒有這段，該檔已刪除。

⚠️ **`device_token` 未設定時裝置通道完全開放**（只印警告），讓機隊能逐步換 token。
`docs/GUIDE.md` §5.2 記載目前**已設定**（實務上是強制驗證）。意涵：**這是一個放在
資料庫裡的安全開關**——換 token 不用重新部署，但任何能寫 `settings` 表的人都能關掉
裝置認證。

`path.split("/").filter(Boolean)` 吃掉多餘斜線，讓 `segments[1]` 穩定是 device_id。

**REST handler**（都很薄）：

| 函式 | 位置 | 要點 |
|---|---|---|
| `handleLogin()` | `:609` | 見下方 |
| `handleGetTelemetry()` | `:652` | `limit` 用 `Math.min(..., 1000)` 夾住，避免撈爆 D1 配額 |
| `handleGetDevices()` | `:673` | `SELECT * FROM devices ORDER BY id ASC` |
| `handleGetAlerts()` | `:680` | 上限 500 |
| `handleAckAlert()` | `:701` | `UPDATE alerts SET acknowledged = 1` |
| `handleChat()` | `:723` | 轉給 `GREENY_AGENT` DO stub，失敗回 503 |
| `handleRelay()` | `:736` | 轉成 `https://device-hub/relay-cmd` |

`handleChat` 與 `handleRelay` 都是「Worker 只做路由、狀態都在 DO」的模式，
讓 Worker 保持無狀態。CORS 由 `CORS_HEADERS`（`:481`）與 `corsJson()`（`:493`）處理，
全部 `Allow-Origin: *`——因為認證走 header 或 query（不是 cookie），不需
`Allow-Credentials`，所以 `*` 可接受。

`handleLogin()`（`:619-635`）最能反映歷史坑：

```ts
// NOTE: no `salt` column — the salt is embedded in the self-describing
// `pbkdf2:<iters>:<salt>:<hash>` value of password_hash, so the same row
// works on the Worker and on Pages Functions.
const user = await env.DB.prepare(
  "SELECT id, username, password_hash, role FROM users WHERE username = ?"
).bind(body.username).first<{...}>();
if (!user) return corsJson({ error: "Invalid credentials" }, { status: 401 });
const valid = await verifyPassword(body.password, user.password_hash);
if (!valid) return corsJson({ error: "Invalid credentials" }, { status: 401 });
```

- **`SELECT ... salt` 是歷史錯誤**：`greeny-db` 的 `users` 表**沒有 `salt` 欄位**
  （`docs/GUIDE.md` §5.1 明載）。舊程式碼 SELECT 它會讓查詢直接失敗 → 登入 500。
- **帳號不存在與密碼錯誤回同一個訊息**（都是 401 `"Invalid credentials"`），
  不洩漏哪些 username 存在。
- ⚠️ **Worker 端沒有檢查 `active` 欄位**，Pages 端有（`AND active = 1`）——後果是被停用
  的帳號在 SPA 仍可登入（待確認是否要對齊）。

`DASHBOARD_HTML`（`:84-477`）是一個 400 行模板字串的內建登入＋儀表板 UI，Phase 1 的
產物（SPA 還沒好時驗證鏈路，`GET /` 免認證）。它自己的 WS 連線在 `:368` 帶了 JWT
——WS 認證上線後必須同步改的地方。現在的主要價值是**除錯工具**（不用部署 SPA 就能測 WS）。

### 3.2 `edge/src/device-hub.ts` — DeviceHub Durable Object

`:7-12` 就是這個類別的全部規則：

```
Non-negotiables:
 - ctx.acceptWebSocket(server) — NEVER server.accept()
 - ZERO awaits in webSocketMessage() — all storage via synchronous ctx.storage.sql.exec()
 - Constructor restores from deserializeAttachment() — no storage reads
 - All D1 access is in alarm() only, never in webSocketMessage()
```

**為什麼 constructor 不能 `await`**（`:51-104`）：**JavaScript 的 constructor 不能是
`async`**——語言限制，不是風格問題。而 DO 的 constructor 在**每次喚醒**（含從
WebSocket Hibernation 喚醒）都會跑一次。如果需要非同步工作只能用
`ctx.blockConcurrencyWhile()`，本專案**刻意不用**（`edge/EDGE.md:65`），因為它會拉高
喚醒延遲。解法是用**同步的** `ctx.storage.sql.exec()` 建五張表——同步、便宜、
`IF NOT EXISTS` 冪等，所以全部放在 constructor。

連線還原同樣必須同步：`ctx.getWebSockets()` + `ws.deserializeAttachment()`（`:97-104`）。
**這裡沒有從 storage 讀任何東西**——`ledState` 等欄位在喚醒後是預設值，要靠下一則
telemetry 或 `device_state` 表補回來。

**`fetch()` 如何用路徑判斷角色**（`:113-288`）：同時是三種入口——`/relay-cmd`（POST
下指令）、`/do-telemetry` 與 `/do-alerts`（GET，給 GreenyAgent 讀）、其他任何路徑
（GET + `Upgrade: websocket`，真正的 WS 升級）。角色判定只有一行（`:246`）：

```ts
const role: Attachment["role"] = url.pathname.includes("dashboard") ? "dashboard" : "esp32";
```

**用「路徑裡有沒有 `dashboard`」決定角色，其他一律當裝置。** 這很寬鬆，但安全性由
Worker 層的認證閘門保證。⚠️ **風險**：新增第三種 WS 路徑（如 `/service/`）會被當成
esp32，而且會**取代現有裝置連線**——新增 WS 路徑時務必同步改這裡。

裝置連線（`:255-274`）四個動作，順序有意義：

```ts
if (role === "esp32") {
  // Purge stale relay queue on reconnect — calibration commands are
  // context-dependent (probe position matters) and replaying them
  // after a reboot/flash corrupts calibration state.
  this.ctx.storage.sql.exec("DELETE FROM relay_queue WHERE device_id = ?", deviceId);
  // Fix 3: close existing connection before replacing (prevents zombie sockets)
  if (this.esp32ws) { try { this.esp32ws.close(1000, "Replaced by new connection"); } catch {} }
  this.esp32ws = server;
  this.lastTelemetryMs = 0;                       // reset health check
  server.send(JSON.stringify({ type: "sync", led: this.ledState, doTs: Date.now() }));
  this.broadcast({ type: "device_status", device_id: deviceId, status: "online" });
}
```

1. **清空 `relay_queue` 是刻意的資料遺失**：校正指令綁定探頭當下的位置，重開機後重放
   會寫入錯誤校正值。代價是離線期間排隊的 `set_led` 在裝置重連時被丟掉——`relay_queue`
   的保證是「**同一次連線內**的可靠傳遞」，不是跨重啟。
2. **先關舊連線再換新**：避免同一台裝置有兩個 socket，否則 `this.esp32ws` 只指到其中
   一個，另一個永遠收不到指令。
3. `lastTelemetryMs = 0` 重設健康檢查（§3.2.5）。
4. 立刻送 `sync`，裝置不必等下一輪。

`await this.ctx.storage.setAlarm(Date.now() + 60_000)`（`:286`）在**每次** WS 建立時都設
——等於把 alarm 當排程器的心跳：即使 alarm 因故沒被重排，下一次有人連線就救回來。

**`webSocketMessage()` 為什麼必須零 `await`**（`:290-324`）：方法宣告成 `async` 但
**內部零 `await`**，呼叫的三個 handler（`handleTelemetry`/`handleAck`/
`handleDashboardCommand`）全是同步 `private` 方法。三個理由：

- 裝置每 10 秒送遙測，**同一個 DO 的訊息是序列化處理的**。一旦在某則訊息裡 `await`
  一個網路呼叫（D1 延遲 5–50 ms），後面排隊的訊息全部被堵住。
- DO 是單執行緒語意：`await` 期間可插入其他事件（alarm、其他請求）。若 `await` 前後
  讀寫同一份記憶體狀態就會競態。零 `await` 讓這個方法成為**原子操作**。
- 所以 D1 存取被推到 `alarm()`（每 60 秒，`await` 完全沒問題），熱路徑只碰同步的
  `ctx.storage.sql.exec()`。

`ping` 分支還順手清佇列（`:304-306`，註解 "Fix 4: drain relay queue on ping for lower
latency"）：讓指令不必等下一則 telemetry 才送出。

**`handleTelemetry()`**（`:328-396`）：

```ts
private handleTelemetry(msg: Record<string, any>) {
  const deviceId = msg.device_id || "esp32-sensor";
  const now = Date.now();
  this.lastTelemetryMs = Date.now();
  this.tds = msg.tds; this.ec = msg.ec; this.ph = msg.ph; this.temp = msg.temp;
  if (typeof msg.led === "boolean") this.ledState = msg.led;
  this.ctx.storage.sql.exec(
    `INSERT INTO telemetry_buffer
       (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms) VALUES (?,?,?,?,?,?,?,?)`,
    deviceId, msg.tds, msg.ec, msg.ph, msg.temp, msg.led ? 1 : 0, msg.esp32_ms ?? 0, now);
  ...
}
```

- **記憶體欄位與 SQLite 並存**：記憶體供 dashboard 連上時不查 SQLite 就能推 state；
  SQLite 供 alarm 批次寫入與 GreenyAgent 查詢。
- `do_ms` 用 **DO 的 `Date.now()`**、`esp32_ms` 是裝置的 `millis()`。前端與
  `toggle-led.mjs` 用 `doTs` 算單向延遲。
- **警報去重**（`:352-373`）條件是「`flushed = 0` 的同型警報已存在就跳過」，
  實務效果是「每個 alarm 週期最多一則同型警報」（約 1 則/分鐘），不是每 10 秒一則。
- 結尾廣播**兩種格式**：自家的 `{type:"state"}`（`:378`）與舊 Casey 協定的
  `{type:"telemetry_update"}`（`:387`）。前端 `normalizeReading()`
  （`spa/src/hooks/useSensorData.ts:40`）就是為了吃掉兩種格式。

**`handleAck()`**（`:400-429`）：**ACK 不會去刪 `relay_queue` 的對應項**——佇列項在
`drainRelayQueue()` 送出時就刪掉了（`:519`）。所以兩張表分工明確：
`relay_queue` = 「還沒送出去的指令」、`relay_log_buffer` = 「送出去過的指令＋有沒有 ACK」
的稽核軌跡。即使 ACK 丟失也不會卡住佇列。另外它是**從裝置狀態反向修正雲端狀態**的地方
（裝置說 LED 是 `true` 就更新 `this.ledState`），處理「使用者在裝置離線時下 `set_led`，
裝置後來自行改變狀態」的漂移。

**`handleDashboardCommand()` — 三種指令語意**（`:433-484`）。三個分支代表三種不同的
可靠性保證：

**（1）`set_led` → 持久佇列（at-least-once）**

```ts
if (msg.command === "set_led") {
  const paramsJson = JSON.stringify({ state: msg.state });
  this.ctx.storage.sql.exec(
    `INSERT INTO relay_queue (device_id, command, params_json, created_at) VALUES (?,?,?,?)`,
    deviceId, "set_led", paramsJson, now);
  this.ctx.storage.sql.exec(
    `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
     VALUES (?,?,?,'sent',?)`, deviceId, "set_led", paramsJson, now);
  if (this.esp32ws) {
    this.esp32ws.send(JSON.stringify({ command: "set_led", params: { state: msg.state } }));
  }
}
```

先寫佇列、再（有連線時）立即送出。裝置離線時佇列項留著，下次 `drainRelayQueue()` 補送。
⚠️ **送給裝置的格式是 `{command, params:{state}}`——參數被重新包進 `params`**（`:452-454`），
這是韌體端最常見的錯誤來源（`docs/API.md` A.7 特別警告）。

**（2）`calibrate` → QoS 0（不排隊）**

```ts
} else if (msg.command === "calibrate") {
  // QoS 0 — calibrate is context-dependent (probe position matters).
  // Never queue in relay_queue. Forward directly if ESP32 connected,
  // drop if not. Audit trail still written to relay_log_buffer.
  const paramsJson = JSON.stringify(msg.params || {});
  this.ctx.storage.sql.exec(
    `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
     VALUES (?,?,?,?,?)`, deviceId, "calibrate", paramsJson,
    this.esp32ws ? "sent" : "dropped", now);
  if (this.esp32ws) {
    this.esp32ws.send(JSON.stringify({ command: "calibrate", params: msg.params || {} }));
  }
}
```

**刻意不寫 `relay_queue`**。校正的語意是「我現在把探頭放進 pH 7.0 緩衝液，請記下這個
讀值」——有效性綁定當下的物理狀態。離線排隊、兩小時後補送會把錯誤電壓寫進 EEPROM，
所以選擇**丟棄**，但仍寫一筆 `status='dropped'` 的稽核記錄（可觀測性不被犧牲）。
HTTP 側對應行為在 `/relay-cmd`：裝置離線回 **503**（`:141-143`），讓呼叫者知道沒送到。

**（3）未知指令 → 泛用轉發**

```ts
} else if (msg.command) {
  // Generic passthrough: forward any unknown command to ESP32 directly.
  // Used by wifi_scan, wifi_set, and future commands.
  if (this.esp32ws) { this.esp32ws.send(JSON.stringify(msg)); ... }
  else { console.log(`[DO] dropped ${msg.command} — ESP32 offline`); }
}
```

**原封不動轉發整個訊息**。這是「新增裝置指令不用改雲端」的關鍵——`wifi_scan`、
`wifi_set` 從來沒在雲端程式碼裡被特別處理過。代價是雲端無法對未知指令做驗證或整形，
**信任邊界被推到裝置端**，所以裝置必須自己驗參數（`firmware/esp32/esp32.ino:529`
有檢查 `ssid`/`pass` 是否為空）。

`webSocketMessage()` 對 dashboard 訊息還有一層舊協定轉換（`:314-316`）：
`{type:"relay", relay1:1}` 會被轉成 `{command:"set_led", state:true}`，
新舊兩種寫法收斂到同一條路徑。

**`evaluateAlerts()` 閾值**（`:488-504`）：

```ts
if (ph < 5.5)       alerts.push({ type: "ph_low",   message: `pH 过低: ${ph}`,           severity: "warning" });
else if (ph > 8.5)  alerts.push({ type: "ph_high",  message: `pH 过高: ${ph}`,           severity: "warning" });
if (ec > 2000)      alerts.push({ type: "ec_high",  message: `EC 超出阈值: ${ec} μS/cm`, severity: "warning" });
if (temp < 18)      alerts.push({ type: "temp_low", message: `温度过低: ${temp}°C`,       severity: "warning" });
else if (temp > 30) alerts.push({ type: "temp_high", message: `温度过高: ${temp}°C`,      severity: "warning" });
```

- **全部是 `warning`**：型別允許 `"critical"`（`:28`）、UI 也有 critical 樣式
  （`edge/src/index.ts:342`），但沒有任何規則用到它。
- **閾值硬編碼**。`settings` 表有一組 `ph_min/ph_max/ec_max/temp_min/temp_max`，但這個
  函式**沒有讀它們**——（待確認）是否有計畫改讀 D1。兩份閾值並存：DO 用硬編碼、
  前端顯示用 settings。
- **訊息字串是簡體中文**（`过低`、`阈值`），Pages 端是繁體
  （`spa/functions/api/telemetry.ts:99`：`pH值異常`）。`spa/src/hooks/useChineseText.ts`
  與 `spa/src/lib/chinese.ts` 就是為了轉換這種混雜。

**看門狗（`lastTelemetryMs`）**（`:534-543`）：

```ts
// If ESP32 connected within last 30s but zero telemetry received,
// the outgoing WebSocket path is broken (common after deploys).
// Close it — ESP32 will reconnect fresh in both directions.
if (this.esp32ws && this.lastTelemetryMs === 0) {
  console.log("[DO] health check FAILED — no telemetry since connect. Forcing reconnect.");
  try { this.esp32ws.close(1000, "Health check failed — reconnect"); } catch {}
  this.esp32ws = null;
  this.broadcast({ type: "device_status", device_id: "esp32-sensor", status: "offline" });
}
```

- 判定條件 `lastTelemetryMs === 0` 就是「**連上之後一則遙測都沒收到**」。該值在裝置連線
  時重設為 0（`:269`）、收到 telemetry 時設為 `Date.now()`（`:332`）。alarm 每 60 秒跑，
  所以最快 60 秒、最慢約 120 秒偵測到。
- **只偵測「完全沒有遙測」，不偵測「遙測停了」**（待確認是否改成 `Date.now() - lastTelemetryMs > N`）。
- 它處理 **DO → ESP32 方向**壞掉的半開連線（Cloudflare 部署後常見）；反方向由**裝置端
  看門狗**處理（`lastInboundMs`，`firmware/esp32/esp32.ino:992`）。兩端各自偵測、各自
  重連是刻意的——一方無法可靠偵測自己的送出方向。
- ⚠️ 廣播的 `device_id` 是**硬編碼 `"esp32-sensor"`**（`:542`），多裝置時會報錯裝置。

**`alarm()` — 如何批次把 DO-local SQLite 寫進 D1**（`:531-642`）。結構是 try/catch/finally
三明治，註解自己說明理由（`:524-529`）：

```
Cloudflare doc: if alarm() throws 6 times (exponential backoff),
it permanently stops. Without setAlarm(), it never fires again.
Non-negotiable: try/catch per row, outer try/catch, finally { setAlarm }
```

```ts
} finally {
  // NON-NEGOTIABLE: always reschedule, even if D1 is completely down.
  await this.ctx.storage.setAlarm(Date.now() + 60_000);
}
```

三層防護對應三種失敗模式：(1) **單列失敗**——`try` 包在 for 迴圈內（`:551-560`），
某列失敗就 `console.error` 後繼續，不 rethrow；(2) **整體失敗**——外層 `catch`（`:634`）；
(3) **無論如何重排**——`finally`（`:637`），即使 D1 全掛也要排下一次，避開「連續 6 次
失敗永久停用 alarm」。

批次 flush 三個目標，一律「先 SELECT `WHERE flushed = 0` → INSERT → 標記 `flushed = 1`」：
遙測（`:547`→`:562`）、警報（`:568`→`:581`）、指令稽核（`:587`→`:600`）。
⚠️ **「先 INSERT 全部、再 UPDATE 全部」不是原子操作**——中間 crash 會重送已插入的列，
D1 出現重複（`edge/EDGE.md:134` 明說 "accept at-least-once semantics"）。
DO-local SQLite 有 transaction API，這裡沒用（待確認是否刻意）。

`devices.last_seen` 更新（`:605-619`）用一個**依賴清理邏輯**的查詢：
`SELECT DISTINCT device_id, MAX(do_ms) as last_seen FROM telemetry_buffer WHERE flushed = 1
GROUP BY device_id`——它掃的是「剛標記 flushed=1」的列，而清理只留最近 100 筆，
所以實際掃的是最近 100 筆而非全表。接著 `UPDATE devices SET last_seen = ?,
status = 'online' WHERE device_id = ?`（`:613`）假設 D1 的 `devices` 有 `device_id`
欄位（見 §8.2）。

清理邏輯（`:621-633`）的註解解釋了為什麼非做不可：

```
D1 rows-read quota: every alarm cycle scans flushed rows.
Without cleanup, a week of telemetry = 60K rows × 1,440 cycles
= 86M rows read/day just for the devices.last_seen query.
```

保留最近 100 筆 flushed 遙測、警報與 relay_log 各 50 筆。
**`flushed = 0` 的列永遠不刪**（正確），但這也意味著 D1 長期不可用時 DO-local SQLite
會無限成長（待確認有無上限）。

**`webSocketClose()` / `webSocketError()` / `broadcast()`**：兩個清理方法（`:646`、`:677`）
幾乎一樣，差異是刻意的——`webSocketError` **不做 D1 寫入**，因為它常伴隨網路問題且通常
還會再收到一次 `close`。`edge/EDGE.md:110` 說「`webSocketError` handles the same cleanup
as close — GREENY's original missed this」，說明這是修補過的：早期版本沒有
`webSocketError`，異常斷線後 `this.esp32ws` 一直指向死掉的 socket，
**之後所有指令都送進黑洞**。

```ts
// edge/src/device-hub.ts:695-700
private broadcast(data: Record<string, unknown>) {
  const json = JSON.stringify(data);
  this.dashboards.forEach((_, ws) => {
    try { ws.send(json); } catch { this.dashboards.delete(ws); }
  });
}
```

**只序列化一次**，且**送失敗就從 Map 移除**（自我修復，不依賴 close 事件）。

### 3.3 `edge/src/agent.ts` — GreenyAgent Durable Object

`GreenyAgent` 用 `idFromName("greeny")` 固定成**單一實例**（`edge/src/index.ts:725`）。
它更準確的描述是「**一個有狀態的對話與校正流程引擎，語言模型只是其中一個零件**」。

**Pre-fetch 模式（核心設計）**。`classifyIntent()`（`:266-311`）用 regex 決定走哪條路：

```ts
private classifyIntent(msg: string): "action" | "complex" | "simple" | "meta" {
  // Actions — direct commands, no AI needed
  if (msg.match(/turn\s+(on|off)\s+(the\s+)?(led|light)/i)) return "action";
  if (msg.match(/^(calibrate|start calibration|run calibration|begin calibration)/i)) return "action";
  if (metaMarkers.some((m) => msg.includes(m))) return "meta";
  if (complexMarkers.some((m) => msg.includes(m))) return "complex";
  return "simple";
}
```

| 意圖 | 處理 | 模型 | 成本 |
|---|---|---|---|
| `action` | `handleActions()` → 直接執行 LED / 校正 | **不呼叫模型** | 0 neurons |
| `meta` | `chatMeta()` → 自我介紹 prompt | `MODEL_CHEAP` | ~500 neurons |
| `complex` | `chatWithTools()` → 原生 function calling | `MODEL_CAPABLE` | 高 |
| `simple` | `chatSimple()` → **regex 猜意圖 → 先抓資料 → 塞進 prompt** | `MODEL_CHEAP` | ~500 neurons |

`chatSimple()`（`:466-528`）是 pre-fetch 模式的本體：

```ts
const wantsTelemetry = msg.includes("plant") || msg.includes("how are") ||
  msg.includes("status") || msg.includes("sensor") || msg.includes("reading") ||
  ... || msg.includes("value");
const wantsAlerts = msg.includes("alert") || msg.includes("warning") || ...;
if (wantsTelemetry) dataFetches.push(this.tool_queryTelemetry(deviceId).then(r => ["telemetry", r]));
...
const dataContext = Object.fromEntries(await Promise.all(dataFetches));
const prompt = this.buildPrompt(userMessage, dataContext);
const aiResponse = await this.env.AI.run(GreenyAgent.MODEL_CHEAP, { prompt, max_tokens: 512 });
```

**為什麼要這樣做**：小模型（`llama-3.2-3b-instruct`）**不會用 tool calling**，
走 prompt-based 生成。如果只丟「使用者問了什麼」，它會**幻覺出感測器數值**。
所以流程被反過來：先用便宜的 regex 決定需要哪些資料 → 平行抓 → 把**真實數值**以文字
塞進 prompt（`buildPrompt()`，`:636-691`），並明令：

```
[REAL DATA — use ONLY these values, never make up readings]
[RULES]
- Use ONLY the sensor values provided above. Never make up numbers.
```

`buildPrompt()` 還處理「沒資料」的情況（`:685`：`If data shows "No data available,"
tell the user the sensors may be offline.`），讓模型不會硬掰讀數。`dataFetches` 用
`Promise.all` 平行執行（`:515`），每個 fetch 都是 DO-to-DO 內部呼叫
（`tool_queryTelemetry()`，`:1017`）——**同 colo、不計費**，所以「先抓再說」的成本幾乎
是零，這是整個設計成立的前提。

模型分層（`:259-261`）：`MODEL_CHEAP = "@cf/meta/llama-3.2-3b-instruct"`、
`MODEL_CAPABLE = "@cf/qwen/qwen3-30b-a3b-fp8"`、`MODEL_REASON = "@cf/qwen/qwq-32b"`
——**`MODEL_REASON` 宣告了但沒被使用**（`modelCandidates = [MODEL_CAPABLE]`，`:543`；
待確認是預留或遺漏）。

`TOOLS`（`:63`，OpenAI 格式，有 `function` 外層）與 `TOOLS_WAIChat`（`:128`，
Workers AI 扁平格式）**內容幾乎相同但重複定義**，因為 Workers AI 的兩個入口格式不同。
目前只有 `TOOLS_WAIChat` 被使用（`:552`、`:615`），`TOOLS` 未使用——**修改工具時兩份
都要改**（若將來啟用 `TOOLS`）。

`chatWithTools()`（`:532-633`）是標準 tool-calling 迴圈，三個防禦：
(1) **12 秒 timeout 競爭**（`:549-558`，`Promise.race` 對上 `setTimeout(reject, 12_000)`）
——註解說明理由：「if model doesn't respond by then, it's unlikely to be available on
this account」，模型不可用時**降級到 `chatSimple()`**（`:571`），不是回錯誤訊息；
(2) **最多 5 輪**（`:575`）避免無限迴圈；(3) **`arguments` 可能是字串或物件**
（`:597-602`），兩種都處理。

**校正狀態機（`calibration_sessions` 表）** 是 `GreenyAgent` 真正的價值：一個**跨對話
回合、跨 DO 重啟**的多步驟流程（狀態存 `ctx.storage.sql`，`:192`）：

```
（無 session）─ startCalibration() ─► awaiting_point1
   ├─ recordCalibrationPoint(1) ──► awaiting_point2
   │    └─ recordCalibrationPoint(2) ─► computing ─► finalizeCalibration() ─► complete
   └─ "cancel"/"stop"/"abort" ─────► cancelled
```

`getActiveCalibration()`（`:728`）用 `status NOT IN ('complete','cancelled')` 判斷，
所以**使用者可以關掉瀏覽器、隔天再回來繼續**。`recordCalibrationPoint()`（`:816`）
有一個誠實的已知限制寫在註解裡：

```ts
// Note: the ESP32 must support returning raw mV/adc for the probe.
// For now, we use the calibrated pH reading as a proxy and note
// that raw mV support needs firmware-side.
const telemetry = await this.tool_queryTelemetry(deviceId);
const measuredPh = t.ph as number;
```

記錄的是「裝置目前回報的 pH 值」而非原始電壓。`finalizeCalibration()`（`:872-974`）的公式
因此被扭曲但內部一致：`slope = (7.0 - 4.0) / (mv1 - mv2)`、`offset = 7.0 - slope * mv1`、
`slopePct = (slope / 59.16) * 100`（59.16 mV/pH 是 25°C 的理想斜率）。變數名仍叫
`mv1`/`mv2` 但存的是 pH 值——歷史包袱。`slopePct` 被轉譯成**探頭健康度建議**
（`:956-964`）：≥90% 極佳、≥80% 良好、≥70% 尚可、<70% 建議更換。防呆是兩點幾乎相同時
（`Math.abs(deltaMv) < 0.01`，`:899`）直接中止並給硬體檢查建議。

最後把結果送到裝置（`:931-952`）：打 `/relay-cmd`，`params` 為
`{ type: "ph", slope, offset, slope_pct }`。
⚠️ **`params.type = "ph"` 在韌體端沒有對應分支**——`esp32.ino` 的 `calibrate` 只認
`reset`/`ec_zero`/`ec_1413`/`ec_value`/`ph_7`/`ph_4`/`ph_9`（`:557-702`），所以它會走到
最後回一個 `status:"ok"` 的 ACK 但**什麼都沒做**（待確認是尚未實作）。
注意裝置端的 `calibrate`（量測並寫入）與 GreenyAgent 送出的 `calibrate`
（算好的 slope/offset）是**兩種不同的意義**。

### 3.4 `edge/src/auth.ts` — JWT 與 PBKDF2

`signJWT()`（`:31-55`）與 `verifyJWT()`（`:59-105`）用 `crypto.subtle` 手刻，
**零 npm 依賴**。`base64url()`（`:9-15`）從標準 base64 轉換（`+`→`-`、`/`→`_`、
去 padding），`base64urlDecode()`（`:17-22`）反向補 padding。

驗證順序很重要：**先驗簽章（`:83`）再解析 payload（`:94`）**——先 parse 再驗章會讓
惡意 payload 有機會觸發解析器漏洞。驗完才檢查 `exp`（`:97`）。
`expiresInSec = 86400`（24 小時）是預設值，`handleLogin()` 沒有覆寫。
⚠️ **沒有檢查 header 的 `alg`**：JWT 的經典漏洞是 `alg:"none"` 或演算法混淆。這裡沒讀
`alg` 就直接用 HMAC 驗，所以 `alg:"none"` 一樣驗不過（簽章驗不過）——**實務上安全**，
但缺少明確的 `if (header.alg !== "HS256") return null` 防禦（待確認／可強化）。

**PBKDF2 格式與 fail closed**：

```ts
// edge/src/auth.ts:109-115
// Self-describing hash format shared with Pages Functions:
//   pbkdf2:<iterations>:<hex salt>:<hex derived key>
// Keeping ONE format means a user row works identically on the Worker and on
// Pages Functions, and the row no longer depends on a separate `salt` column.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;

// :149-153
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${derived}`;
}
```

自描述格式的三個好處：(1) `iterations` 存在字串裡 → 將來提高迭代次數時舊密碼仍可驗證
（`verifyPassword()` 用 `parts[1]`，`:171`）；(2) `salt` 內嵌 → **不需要 `users.salt`
欄位**；(3) 兩個執行環境只要照這格式做，資料就互通。

```ts
// edge/src/auth.ts:155-166
// Fail closed: anything that is not a `pbkdf2:` hash is rejected.
// The old code path returned `true` for bcrypt (`$2...`) hashes, which let
// anyone log in with ANY password. Never reintroduce that shortcut — migrate
// legacy bcrypt rows to the pbkdf2 format instead.
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith("pbkdf2:")) return false;
  ...
}
```

第一行就是防線：**不是 `pbkdf2:` 開頭就回 `false`**，沒有寬容模式、沒有 fallback。
這句註解本身就是文件——它記錄了一個真實的認證繞過漏洞（§4.2）。

比較用**常數時間比較**（`:177-182`）：`diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i)`
而不是 `===`（`===` 會提前返回，洩漏前綴匹配長度）。長度檢查提前返回可接受
（長度不是秘密，都是固定 64 hex）。`randomHex()`/`randomSalt()`（`:187-195`）
目前**沒有被任何地方使用**。

### 3.5 DO-local SQLite 的表

`DeviceHub` 的 constructor 建五張表（`:54-94`）。**這些表存在 DO 的儲存裡，不在 D1**
——每個裝置一個 DO 實例，各有獨立一組。

| 表 | 用途 | 關鍵欄位 | 生命週期 |
|---|---|---|---|
| `telemetry_buffer` | 熱路徑遙測暫存，等 alarm 批次寫進 D1 | `flushed`、`do_ms`、`esp32_ms` | 留最近 100 筆 flushed；`flushed=0` 不刪 |
| `relay_queue` | **待送**指令佇列（只有 `set_led` 進來） | `command`、`params_json` | 送出即刪；裝置重連時全清 |
| `alert_buffer` | 閾值警報暫存＋去重依據 | `alert_type`、`severity`、`flushed` | 留最近 50 筆 flushed |
| `relay_log_buffer` | 指令**稽核軌跡**（sent / dropped / acked） | `status`、`params_json` | 留最近 50 筆 flushed |
| `device_state` | 單列 key-value（目前只存 `ledState`） | `key`（PK）、`value` | 永久（`INSERT OR REPLACE`） |

`flushed` 旗標就是兩層儲存之間的同步狀態機。`GreenyAgent` 另有兩張表
（`edge/src/agent.ts:192-212`）：`calibration_sessions` 與 `workflow_state`。

---

## 4. Pages Functions（`spa/functions/`）逐檔解說

### 4.1 `api/_middleware.ts` — 認證流程與白名單

```ts
// spa/functions/api/_middleware.ts:14-47（節錄）
  // 只有 login 免認證。舊版寫成 path.startsWith('/api/auth/') 會連
  // /api/auth/me 一起放行 → middleware 沒設 context.data.user → me.ts 讀
  // user.sub 時 TypeError → 500。
  if (path === '/api/auth/login') return context.next();
  if (path.startsWith('/api/wb/')) return context.next();
  // POST /api/telemetry 由 handler 自己驗證（device token 或 JWT），
  // 所以這裡跳過 header 式 JWT 中介層；未授權者會在 handler 內回 401。
  if (path === '/api/telemetry' && context.request.method === 'POST') return context.next();
  if (path === '/api/relay' && context.request.method === 'GET') return context.next();

  const token = extractBearerToken(context.request);
  if (!token) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, ... });

  // Read JWT secret from D1 (same source as Worker). No fallback to a default.
  const jwtSecret = await getJwtSecret(context.env);
  if (!jwtSecret) return new Response(JSON.stringify({ error: 'Server misconfigured: jwt_secret missing from D1 settings' }), { status: 500, ... });

  const payload = await verify(token, jwtSecret);
  if (!payload) return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401, ... });

  context.data.user = payload;
  return context.next();
```

四個白名單條目的理由：

| 放行條件 | 為什麼 |
|---|---|
| `path === '/api/auth/login'` | **精確比對，不是 `startsWith('/api/auth/')`**。前綴寫法會連 `/api/auth/me` 一起放行 → `me.ts` 讀 `context.data.user` 得到 `undefined` → `user.sub` 拋 TypeError → **500**。這是真實發生過的 bug（`docs/GUIDE.md` §11 第 3 項） |
| `path.startsWith('/api/wb/')` | WorkBuddy 端點有**自己的 API key 認證**（`api/wb/_middleware.ts:9` 比對 `env.WB_API_KEY`），不需 JWT |
| `POST /api/telemetry` | 裝置可能沒有 JWT（只有 device token），讓 handler 自己決定接受哪種憑證 |
| `GET /api/relay` | 裝置輪詢拉指令的舊路徑，**刻意保留免認證**（GUIDE §5.4 列為已知殘留風險） |

⚠️ **匯入層數**：`api/_middleware.ts` 用 `../_lib/`（`:1-2`），`api/auth/login.ts` 要
`../../_lib/`（`:1`），`api/wb/_middleware.ts` 要 `../../../_lib/`（`:1`）。
層數寫錯會建置失敗（§10.3）。

型別層面有個技巧（`:4-8`）：Pages 型別中 `data` 預設是 `any`，這裡用
**declaration merging** 擴充成有 `user`，讓下游 handler 寫 `c.data.user` 時有型別提示。

### 4.2 `_lib/jwt.ts` 與 `_lib/password.ts`

兩者是 Worker 版的「複製」，**不是共用模組**（Worker 與 Pages 是不同執行環境與結構，
無法直接 import）。代價是同套邏輯有兩份實作，**修改時必須同步改兩邊**。

```ts
// spa/functions/_lib/jwt.ts:11-16
export async function getJwtSecret(env: Env): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'jwt_secret'").first<{ value: string }>();
  return row?.value || '';
}
```

註解（`:3-10`）說明設計：「There is intentionally NO fallback to an environment variable
or a hardcoded default: this repo is public, so any committed default would be a publicly
known signing key.」**與 Worker 版的一個差異：Pages 版沒有快取**（每次查 D1）——
（待確認）是刻意或只是沒同步優化。

**`spa/functions/_lib/password.ts` 是歷史教訓的現場**：

```ts
// spa/functions/_lib/password.ts:23-33
/**
 * 驗證密碼。
 *
 * ⚠️ 安全注意：這裡**必須** fail closed。
 * 舊版本有一行 `if (storedHash.startsWith('$2')) return true;`，會讓任何
 * bcrypt 格式的帳號（admin / office1 / staff1 / office2）對**任意密碼**驗證
 * 成功 → 任何人可用 `admin` + 亂密碼取得 superadmin token。
 * bcrypt 已不再支援；舊資料必須先遷移成 `pbkdf2:` 格式。
 */
export async function verify(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('pbkdf2:')) return false;
```

#### 歷史教訓：`if (storedHash.startsWith('$2')) return true;`

1. **背景**：系統最早用 bcrypt 存密碼（`$2b$...`），後來改用 PBKDF2。
2. **錯誤的遷移策略**：為了「讓舊帳號還能登入」，有人加了一行短路——看到 bcrypt 格式
   就**無條件回 `true`**。原意可能是「bcrypt 驗證要額外套件，先跳過」，但在驗證函式裡
   回 `true` 的語意就是「**密碼正確**」。
3. **實際後果**：`users` 表 5 個帳號中有 4 個是 bcrypt 格式。任何人對
   `POST /api/auth/login` 送 `{"username":"admin","password":"隨便亂打"}` 都會拿到
   **superadmin 的 JWT**。這不是「繞過某個檢查」，而是**登入功能本身變成萬能鑰匙**。
4. **為什麼難發現**：正常登入流程「看起來正常運作」——正確密碼成功、錯誤密碼也
   「成功」。只有在測錯誤密碼時才會發現，而測試通常只測 happy path。
5. **修補**（2026-10-11）：移除短路改成 fail closed；把所有 bcrypt 帳號遷移成
   `pbkdf2:` 並換新密碼；**在程式碼裡留下上面那段註解**，把「為什麼不能這樣寫」
   寫進原始碼本身。
6. **留下的制度性防線**：`tools/greeny_probe.py:34` 把「故意錯誤的密碼」做成常數
   （`FAKE_PASSWORD = "WRONG-PASSWORD-DO-NOT-USE-1234"`），`:126-129` 在用錯誤密碼
   拿到 token 時印出告警；`tools/greeny_check.py:217-220` 把「錯誤密碼應被拒絕（401）」
   列為**固定的負向測試**（§7.1）。

`password.ts` 的 `ITERATIONS = 100000`、`KEY_LENGTH = 256`、`SALT_LENGTH = 16`（`:1-3`）
與 Worker 版一致，所以兩邊產生的 hash 可互相驗證。

### 4.3 `api/telemetry.ts` — 為什麼 POST 需要 device token 或 JWT

這個端點同時是「裝置的 HTTPS 備援路徑」與「前端查歷史遙測的路徑」，兩種方法認證策略不同。

```ts
// spa/functions/api/telemetry.ts:18-46（節錄）
if (c.request.method === 'POST') {
  // This endpoint writes telemetry (and can raise alerts), so it must
  // not be open to the internet. Accept either:
  //   1. the device token  → ?token=<device_token>  or  X-Device-Token
  //   2. a valid user JWT  → Authorization: Bearer <jwt>
  const expected = await getDeviceToken(db);
  const supplied = url.searchParams.get('token') ||
                   c.request.headers.get('X-Device-Token') || '';
  let authorized = false;
  if (expected && supplied === expected) {
    authorized = true;
  } else {
    const bearer = extractBearerToken(c.request);
    if (bearer) {
      const secret = await getJwtSecret(c.env);
      if (secret && (await verify(bearer, secret))) authorized = true;
    }
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized — device token or JWT required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
```

**為什麼兩種都接受**：**device token** 給裝置用——裝置若因 TLS／防火牆問題無法維持長
連線，可退回「定期 HTTPS POST 遙測」，憑證就是它已經有的 device token，不需另發 JWT
（兩種傳法都有，是因為 token 在 query 會進 log，所以提供 header 版給講究的實作）；
**JWT** 給人／工具用（測試腳本、未來的手動補資料介面）。

⚠️ **`if (expected && supplied === expected)` 的 `expected &&` 很重要**：D1 沒設定
`device_token` 時 `expected` 是空字串，條件不成立 → **不會因為「都是空字串」而意外
放行**。這比 Worker 端的裝置 WS 行為（未設定就開放）嚴格，兩邊不一致（§3.1）。

GET 與 POST 的差異：**POST 由 handler 自己驗**（middleware 白名單放行），
**GET 由 middleware 驗 JWT**。GET 用 **`JOIN`**（不是 `LEFT JOIN`，`:119`）
→ `devices` 沒有對應 `id` 的遙測不會出現；`alerts/index.ts` 卻用 `LEFT JOIN`
（待確認是否刻意）。POST 端的 `devices` 寫入（`:71-75`）用
`ON CONFLICT(id) DO UPDATE`，說明 D1 的 `devices` **以 `id` 為主鍵**
（`id` 就是 device_id 字串）。⚠️ 這與 `edge/src/device-hub.ts:613` 的
`WHERE device_id = ?` 不一致（§8.2）。原本這個端點**完全開放**，任何人都能灌假遙測，
401 是修補後的結果。

### 4.4 `api/users/index.ts` 與 `api/users/[id].ts` — 角色權限

三層角色：`superadmin` / `office_admin` / `staff`。

```ts
// spa/functions/api/users/index.ts:9-12、20-24、38-40
if (user.role === 'staff') return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, ... });
if (user.role === 'office_admin') { query += ' AND office_id = ?'; params.push(user.office_id); }
const role = user.role === 'office_admin' ? 'staff' : body.role || 'staff';
const officeId = user.role === 'office_admin' ? user.office_id : body.office_id || null;
```

**`office_admin` 的權限是用「改寫輸入」而不是「拒絕請求」實作的**：送出
`{role:"superadmin"}` 不會被擋，而是被**靜默改寫成 `staff`**。這是刻意的（防提權），
但從 API 使用者角度看是「不報錯卻不生效」，除錯時容易困惑。

單筆端點（`spa/functions/api/users/[id].ts`）：

```ts
// :13-23
const url = new URL(c.request.url);
const id = parseInt(url.pathname.split('/').pop()!);
const target = await db.prepare('SELECT id, office_id FROM users WHERE id = ?').bind(id).first<...>();
if (!target) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, ... });
if (user.role === 'office_admin' && target.office_id !== user.office_id) {
  return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, ... });
}
```

⚠️ **這裡不讀 `c.params.id`，而是自己從 pathname 切**。對照
`spa/functions/api/offices/[id].ts:6` 用的是 `c.params.id as string`。兩者都可行，但
`c.params.id` 是 Pages 的正式 API，自己切字串較脆弱（結尾有斜線時 `pop()` 會拿到空字串）。
（待確認）為何 users 用這種寫法——可能是早期 `c.params` 沒拿到值時的 workaround。

**PATCH 如何支援改密碼**（`:25-48`）：

```ts
if (body.display_name !== undefined) { updates.push('display_name = ?'); params.push(body.display_name); }
if (body.password) {
  updates.push('password_hash = ?');
  params.push(await hash(body.password));      // ← PBKDF2 雜湊，絕不存明文
}
if (user.role === 'superadmin') {
  if (body.role) { updates.push('role = ?'); params.push(body.role); }
  if (body.office_id !== undefined) { updates.push('office_id = ?'); params.push(body.office_id); }
}
if (body.active !== undefined) { updates.push('active = ?'); params.push(body.active); }
...
params.push(id);
await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
```

- **動態組 SQL 是安全的**：`updates` 裡的字串都是程式碼寫死的，**沒有使用者輸入被拼進
  SQL**；使用者輸入一律走 `.bind(...params)` 參數化查詢。這是動態 SQL 的正確寫法。
- **改密碼就是 `hash(body.password)`** → `pbkdf2:100000:<salt>:<hash>`。不需要舊密碼，
  是**管理員重設**語意。
- **`role` 與 `office_id` 只有 `superadmin` 能改**。
- **`if (body.password)` 是 truthy 判斷**：傳空字串不會觸發改密碼（合理）。

`DELETE`（`:50-53`）是**軟刪除**：`UPDATE users SET active = 0`。這解釋了為什麼登入查詢
有 `AND active = 1`（`spa/functions/api/auth/login.ts:18`）——停用帳號無法登入，
但保留稽核軌跡與外鍵完整性。

### 4.5 檔案即路由的規則

| 檔案 | 路由 |
|---|---|
| `functions/api/racks/index.ts` | `/api/racks`（集合） |
| `functions/api/racks/[id].ts` | `/api/racks/:id`（單筆） |
| `functions/api/automations/[id]/run.ts` | `/api/automations/:id/run`（巢狀動作） |
| `functions/api/_middleware.ts` | 所有 `/api/**` 之前執行 |
| `functions/_lib/*.ts` | **不是路由**（`_` 開頭的目錄被排除） |

1. **`index.ts` 是集合、`[id].ts` 是單筆**。集合支援 GET（列表）+ POST（新增）；
   單筆支援 GET / PUT / PATCH / DELETE。一個檔案就是一個端點家族，用
   `c.request.method` 分派。
2. **`_` 開頭的檔案與目錄不會變成路由**，所以 `_lib/` 可以放共用模組、
   `_middleware.ts` 可以是攔截器。
3. **相對匯入層數取決於深度**：`api/x.ts` → `../_lib/`；`api/auth/x.ts` → `../../_lib/`；
   `api/wb/_middleware.ts` → `../../../_lib/`。**層數寫錯會建置失敗**
   （`BuildFailure … api/xxx.ts:2`，見 GUIDE §10.3）——純粹的數目字問題，
   沒有型別系統會幫你。

`onRequest` 的型別是**陣列**（`PagesFunction<Env>[]`），允許把多個 handler 串成 chain
（前者不回 Response 就往下傳）。本專案每個檔案實際只有一個元素，**middleware 是用
`_middleware.ts` 做的，不是用陣列**。

⚠️ **handler 內的路徑與 middleware 白名單必須一致**：若把端點搬到 `/api/v2/telemetry`，
middleware 白名單不會跟著動，新端點會落到「需要 JWT」的預設路徑——**裝置端反而不能用**。

---

## 5. 前端 SPA（`spa/src/`）

### 5.1 `lib/api.ts` — 為什麼有兩套 fetch

```ts
// spa/src/lib/api.ts:1
const API_BASE = 'https://iot-hub.ai-caseylai.workers.dev'
// :26、28-34（apiFetch 內）
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, cache: 'no-store' })
  if (res.status === 401) {
    clearToken()
    if (window.location.pathname !== '/login') window.location.href = '/login'
    throw new Error('Unauthorized')
  }
// :45-56（mgmtApiFetch 內）
  const res = await fetch(path, { ...options, headers, cache: 'no-store' })
```

差異只有一行：**`fetch(\`${API_BASE}${path}\`)` vs `fetch(path)`**。

| | `apiFetch()` | `mgmtApiFetch()` |
|---|---|---|
| 目標 | Worker（跨域） | 同源（`greeny.techforliving.net/api/...`） |
| 涵蓋 | 登入、遙測、裝置、警報、AI chat | 據點、貨架、蔬菜層、環境、作物、用戶 |
| 需要 CORS | 是（Worker 回 `Allow-Origin: *`） | 否 |
| 需要絕對網址 | 是（硬編碼在 bundle 裡） | 否（相對路徑跟著部署域名走） |

**根本原因是功能分兩批長出來的**：Worker 先有即時遙測與裝置控制，Pages 後有管理 CRUD。
**不統一是歷史結果，不是設計。** 兩個後果：(1) **`API_BASE` 硬編碼**，換 Worker 網址
必須改 `api.ts` 並**重新建置部署 SPA**；同樣的字串也硬編碼在
`spa/src/hooks/useWebSocket.ts:27` 與 `:109`（**三處重複**）。(2) **兩邊的
`_middleware.ts` 不共用**——Worker 有自己的認證邏輯，「同一個 token 兩邊都能驗」是靠
「兩邊都讀 D1 `settings.jwt_secret`」。

**401 的處理兩套完全一樣**：`clearToken()` → 不在 `/login` 就跳轉 → throw。
這是**集中式的 session 過期處理**：任何 API 回 401，整個 SPA 被踢回登入頁。
`cache: 'no-store'` 是為了避開 CDN 快取（`useTelemetry` 甚至額外加 `_t` 時間戳）。

⚠️ **路徑前綴不一致（真實缺陷）**：`mgmtApiFetch` 不會自動補 `/api` 前綴。

| 呼叫端 | 傳入 | 實際請求 | 結果 |
|---|---|---|---|
| `spa/src/hooks/useRacks.ts:12` | `'/api/racks'` | `/api/racks` | ✅ |
| `spa/src/pages/racks/RackManagementPage.tsx:168` | `'/api/workbuddy/...'` | 同源 `/api/workbuddy/...` | ✅ |
| `spa/src/pages/CropManagementPage.tsx:88,175,527,541` | `'/crop-batches'`、`'/harvests'` | 同源 `/crop-batches` | ❌ **404** |
| `spa/src/pages/UserManagementPage.tsx:62,179,197,206` | `'/users...'` | 同源 `/users...` | ❌ **404** |

（待確認）是否有 SPA fallback 把它導到 index.html，讓症狀變成「回傳 HTML 解析失敗」
而不是 404。**修法是在 `mgmtApiFetch` 內補前綴，或在所有呼叫端加上 `/api`。**

`getToken()`/`setToken()`/`clearToken()`（`:3-14`）用 **`sessionStorage`**（不是
`localStorage`）：關掉分頁就登出。適合「共用電腦的農場終端」，代價是不能跨分頁共用登入狀態。

### 5.2 `hooks/useWebSocket.ts` — 連線、token 與重連

```ts
// spa/src/hooks/useWebSocket.ts:24-27
// Prototype format: token via query param (browsers can't set WS headers)
const token = getToken()
const tokenParam = token ? `?token=${encodeURIComponent(token)}` : ''
const wsUrl = `wss://iot-hub.ai-caseylai.workers.dev/dashboard/${deviceId}${tokenParam}`
```

- **token 放 query 是唯一選擇**，且 `encodeURIComponent()` **不能省**——JWT 用 base64url
  通常安全，但標準 base64 的 `+` `/` `=` 會壞掉。
- 沒有 token 時連線照樣發出 → 被 401 → `onclose` → 5 秒後重連 → 再 401，形成無窮重連
  迴圈。正常流程下 `ProtectedRoute`（`spa/src/App.tsx:15`）會先擋掉未登入者。

**心跳 ping**（`:34-39`）：每 30 秒送一次**應用層** `ping`（不是 WebSocket 協定層的
ping frame），DO 回 `pong` **並順手清 relay queue**（`edge/src/device-hub.ts:299-306`）。
所以這個心跳同時是保活、測 RTT、**加速指令送達**。`clearInterval` 掛在 `close` 上
（`{ once: true }`）；`onmessage` 收到 `pong` 不做任何事——心跳只為了觸發 DO 的 drain。

**斷線重連**（`:74-83`）：`ws.onclose` 設 5 秒後 `connect()`，`ws.onerror` 只是
`ws.close()`（讓錯誤統一走 `onclose` 的清理路徑，避免重複邏輯）。
**固定 5 秒、沒有指數退避**（Worker 掛掉時所有前端每 5 秒一起重試，這個規模可接受）。
`connect` 是 `useCallback(..., [deviceId])`，所以 `useEffect`（`:86-95`）在 `deviceId`
改變時重連，cleanup 負責關舊連線與清 timer。

**訊息分派**（`:62-70`）用 `Map<string, Set<handler>>` 做發布訂閱，對外是
`on(type, handler)`（`:97-105`，回傳 unsubscribe），支援 `'*'` 萬用訂閱。
`handlersRef`（不是 `useState`）是刻意的：handler 變動不該觸發重新渲染。

**`toggleLed()` 的雙路徑**（`:107-132`）：**優先走 REST，失敗才走 WS**。

```ts
  try {
    const res = await fetch(`${apiBase}/api/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: JSON.stringify({ device_id: devId, relay1 }),
    })
    const data = await res.json()
    if (data.ok) { setLedState(data.led === true || data.led === 1); return ... }
  } catch { /* fall through to WS */ }
```

REST 有明確的 `{ok:true, led:...}` 可確認；WS 送出就沒回音（除非等下一則 state 廣播）。
代價是「WS 明明正常卻多打一次 HTTP」。兩條路最後都進同一個 DO（`handleRelay` 與 WS
訊息都收斂到 `handleDashboardCommand`），語意一致。`data.led === true || data.led === 1`
同時容忍 boolean 與 0/1——因為 DO 的回應格式與舊協定不同（§8.2）。

### 5.3 `hooks/useAuth.ts`

```ts
// spa/src/hooks/useAuth.ts:6-9、17-24、33-41（節錄）
const [user, setUser] = useState<User | null>(() => {
  const stored = sessionStorage.getItem('user')
  return stored ? JSON.parse(stored) : null
})
const login = useCallback(async (username, password) => {
  const data = await apiFetch<LoginResponse>('/api/auth/login', { method: 'POST', body: ... })
  setToken(data.token); sessionStorage.setItem('user', JSON.stringify(data.user)); setUser(data.user)
  return data
}, [])
const logout = useCallback(() => { clearToken(); sessionStorage.removeItem('user'); setUser(null) }, [])
const isLoggedIn = !!getToken()
```

- **初值從 `sessionStorage` 還原**（lazy initializer），重新整理不會閃一下未登入狀態。
- **登入打 Worker 的 `/api/auth/login`**（透過 `apiFetch`），不是 Pages 的。兩邊都有登入
  端點但 SPA 用 Worker 的 → **被停用的帳號在 SPA 仍可登入**（因為 Worker 登入沒檢查
  `active`，§3.1）。
- **`isLoggedIn` 每次 render 重新計算**（不是 state），登入／登出時是 `setUser` 觸發
  重新渲染。
- **沒有 token 有效性檢查**，只看「有沒有 token」；過期由 `apiFetch` 的 401 攔截處理。

### 5.4 `hooks/useSensorData.ts` 與 `hooks/useRacks.ts`

**`useSensorData.ts` — 資料正規化層**。這個檔案存在的唯一理由是**後端回傳格式不統一**
（`:37-39`）：

```
// HTTP: { ph, ec, tds, temp, do_ms, created_at, led } — flat, temp not water_temp, do_ms for ts
// WS:   { type:"state", device_id, ph, tds, ec, temp, led:bool, connected, doTs, esp32_ms } — also flat
```

`normalizeReading(raw, source)`（`:40-68`）把兩個來源統一成 `Telemetry`：`ec`/`tds`
互相 fallback；`temp`/`water_temp` 兩邊都填；`ts_ms` 從 `do_ms ?? created_at * 1000`
（HTTP）或 `doTs ?? Date.now()`（WS）；`led` 從 boolean 轉成 `0/1`。
**為什麼 `led` 要正規化**：WS 送 boolean、D1 存 INTEGER，前端型別用 INTEGER。
**為什麼有 `temp` 與 `water_temp`**：Worker 的 `telemetry` 用 `temp`，Pages 用
`water_temp`（`spa/functions/api/telemetry.ts:78`）——**同一張表兩個欄位名**。

三個 hook：

| Hook | 位置 | 打哪裡 | 用途 |
|---|---|---|---|
| `useDashboardStats()` | `:5-35` | Worker `/api/telemetry?limit=200` | 儀表板 KPI。`:12` 註解：「Compute stats from telemetry since we don't have a dedicated stats endpoint」——**前端自己算** `avg_ph`/`avg_temp`/`avg_ec`，而不是打 Pages 的 `/api/dashboard/stats` |
| `useTelemetry(deviceId, limit)` | `:70-93` | Worker | 歷史遙測。`:79` 加 `_t: Date.now()` 破 CDN 快取 |
| `useAlerts(acknowledged)` | `:95-126` | Worker（GET 與 PATCH） | 警報清單 |

⚠️ `useAlerts().acknowledge()`（`:117-123`）打 `PATCH /api/alerts/${id}`，但 **Worker
沒有這個路由**——只有 `POST /api/alerts/ack`（`edge/src/index.ts:556`）。所以這個呼叫
會落到 `:603` 的 `404 "Not found"`（**純文字**）。（待確認）實際是否已失效——
**這是目前程式碼裡看起來壞掉的一條路徑**。

**`useRacks.ts` — 管理 CRUD 的 hook**。三個 hook（`useRacks` / `useRackVegetables` /
`useRackEnvironment`）＋`useAutomations()`（`:98-134`），全部用 `mgmtApiFetch` 打**同源
Pages**，模式一致：`useCallback` 抓資料 → `useEffect` 呼叫 → 每個寫入操作 `await` 後
呼叫 `fetchRacks()` **重新拉全部**（`:22-25`、`:28-30`、`:34`）。

沒有樂觀更新也沒有區域快取。代價是每次操作多一趟往返；好處是**前端狀態永遠等於後端
狀態**。在低頻的管理後台是合理取捨。`catch { /* */ }` 是空 catch——錯誤只由
`mgmtApiFetch` 內部的 401 處理；API 回 403（權限不足）或 500 時**使用者不會看到任何
錯誤訊息**（待確認是否有全域 toast 攔截）。

### 5.5 頁面與路由對應（`pages/` ↔ `App.tsx`）

`spa/src/App.tsx:25-51` 用 `BrowserRouter`；`/login` 包 `RedirectIfLoggedIn`，
其餘全部包在 `ProtectedRoute` ＋ `DashboardLayout` 之下。

| 路由 | 頁面 | 後端 | 用的 hook |
|---|---|---|---|
| `/login` | `LoginPage.tsx` | Worker（登入） | `useAuth` |
| `/` | `DashboardPage.tsx` | Worker（遙測＋WS `:130`） | `useDashboardStats`、`useWebSocket` |
| `/water-quality` | `WaterQualityPage.tsx` | Worker（WS `:133`） | `useTelemetry`、`useWebSocket` |
| `/device-control` | `DeviceControlPage.tsx` | Worker（REST＋WS `:77`） | `useWebSocket` |
| `/alerts` | `AlertsPage.tsx` | Worker | `useAlerts` |
| `/racks` | `racks/RackManagementPage.tsx` | Pages（同源） | `useRacks`、`useOffices` |
| `/racks/office/:officeId` | `racks/RackDetailPage.tsx` | Pages（同源） | `useRacks`、`useRackVegetables`、`useRackEnvironment` |
| `/crops` | `CropManagementPage.tsx` | Pages（**路徑缺 `/api`**） | `mgmtApiFetch` 直接呼叫 |
| `/users` | `UserManagementPage.tsx` | Pages（**路徑缺 `/api`**） | `mgmtApiFetch` 直接呼叫 |
| `/settings` | `SettingsPage.tsx` | Worker（WS 指令 `:36`） | `useWebSocket` |

兩個守衛元件（`spa/src/App.tsx:15-23`）：`ProtectedRoute` 用 `getToken()` 判斷、
`RedirectIfLoggedIn` 反之。`ProtectedRoute` 包住整個 `DashboardLayout`（不是每個頁面
各自包），所以側邊欄與頁首也只在不需登入的 `/login` 才不出現——這是正確的結構。

`SettingsPage` 用 `useWebSocket` 送 WiFi 指令，`sendCommand()`（`:145-151`）送任意 JSON。
所以 `wifi_scan`/`wifi_set` 是走**儀表板通道**送到 DO，再由 DO 的泛用轉發（§3.2）
送給裝置——整條路徑沒有雲端邏輯，只需裝置端實作，這正是泛用轉發的設計價值。

---

## 6. 韌體逐段解說

三個實作走**完全相同的協定**（`PROTOCOL.md`），差別在功能完整度與平台限制。

### 6.1 Arduino 完整版（`firmware/esp32/esp32.ino`，1004 行）

**開機流程：WiFi → NTP → WSS**（`setup()`，`:888-942`）：

```cpp
  EEPROM.begin(512);
  loadCalibration();
  // Force calibration for inverted board (override any EEPROM corruption)
  tdsKValue = 0.088;
  ecOffset = 201.0;
  EEPROM.put(EEPROM_K_ADDR, tdsKValue);
  EEPROM.put(EEPROM_EC_OFFSET_ADDR, ecOffset);
  EEPROM.commit();
  ...
  loadWiFiCredentials();
  wifiConnectBlocking();
  syncTime();                                    // NTP — 必須在 WSS 之前
  char wsPath[192];
  snprintf(wsPath, sizeof(wsPath), "%s?token=%s", WS_PATH, WS_TOKEN);
  USE_SERIAL.printf("WSS:  Connecting to wss://%s:%d%s\n", WS_HOST, WS_PORT, wsPath);
#if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 0, 4)
  webSocket.beginSslWithBundle(WS_HOST, WS_PORT, wsPath, NULL, 0, "");
#else
  webSocket.beginSslWithBundle(WS_HOST, WS_PORT, wsPath, NULL, "");
#endif
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
```

⚠️ **`:897-902` 把剛從 EEPROM 讀出的校正值直接蓋掉並寫回**——也就是說**在這一版韌體裡
EEPROM 的校正值完全無效**，每次開機都被重設為這兩個常數（「inverted board」指 TDS 模組
輸出電壓隨導電度**下降**的接法）。**這會讓所有透過 WSS 下的 `calibrate` 指令在下次
重開機後失效**——（待確認）是暫時的 bring-up 手段還是預期行為；若要讓校正持久化，
這 5 行必須移除。

**為什麼 NTP 一定要在 WSS 之前**（`syncTime()`，`:96-113`）：**ESP32 沒有電池供電的
RTC**，斷電後 `time(nullptr)` 回傳 **1970-01-01**。而 TLS 憑證驗證的核心檢查是「當前
時間是否在憑證有效期間內」——伺服器憑證有效期是 2025–2026，對一個認為現在是 1970 的
裝置來說**每張憑證都還沒生效**，握手失敗。`while (now < 8 * 3600 * 2)`（≈1970-01-01
16:00）就是「**等到時鐘明顯離開 epoch 0**」；NTP 一回應時間就跳到 2026，迴圈結束。
用固定門檻而不是「年份 > 2020」是因為不需要知道當前日期，只要能區分「還沒對時」與
「已對時」。⚠️ **這個迴圈沒有 timeout**——NTP 被封鎖（很多企業網路擋 UDP 123）時裝置會
**永遠卡在 `setup()`**；精簡版（`greeny2_sensor.ino:151`）與 MicroPython 版
（`main.py:296`）都有 timeout，完整版沒有（待確認是否要補）。

**`beginSslWithBundle(..., NULL, 0, "")` 為什麼用內建 CA bundle**：

- `bundle` 傳 `NULL`、長度傳 `0` → ESP32 Arduino Core 用**韌體內建的 CA bundle**
  （約 77 KB）→ TLS **完整驗證伺服器身分**（`docs/API.md` A.2 第 3 點）。
- 為什麼不用 `beginSsl()`（不驗證）或自帶憑證：自帶憑證要在程式碼嵌 PEM 字串（幾千行）
  且 Cloudflare 換憑證時要重燒；不驗證就失去防中間人保護。內建 bundle 由 ESP32 Core
  維護、跟隨上游更新，是唯一「零維護且完整驗證」的選項。
- `#if ESP_ARDUINO_VERSION >= 3.0.4` 是**函式庫 API 相容性**處理（WebSockets 在 Core
  3.0.4 之後多一個參數），不是邏輯分支。

**裝置 token 如何組進 URL**：`snprintf` 把 `WS_TOKEN` 接在 `WS_PATH` 後面成為
`?token=...`。⚠️ 但 `USE_SERIAL.printf` **把完整 path（含 token）印到序列埠**——實驗室
方便，正式部署等於**把憑證寫進 log**。精簡版已修正（`greeny2_sensor.ino:405`：只印
`token=***`）。

憑證從 gitignored 檔案讀（`:32-37`）：

```cpp
#if __has_include("device_secrets.h")
  #include "device_secrets.h"
#endif
#ifndef WS_TOKEN
  #define WS_TOKEN "REPLACE_WITH_DEVICE_TOKEN"   // 佔位值：Worker 會回 401
#endif
```

`__has_include` + `#ifndef` 的組合很聰明：**沒有憑證檔也能編譯**（用佔位值），連線會被
Worker 以 401 拒絕——這是**可見的失敗**，不是隱藏的不安全預設。`.gitignore:7-8` 排除
`device_secrets.h` / `device_secrets.py`。

**看門狗邏輯**（`:990-997`）：

```cpp
    // Watchdog: if DO→ESP32 path is broken (half-open after deploy),
    // we sent telemetry but received nothing back for 30s. Force reconnect.
    if (lastInboundMs > 0 && now - lastInboundMs > 30000) {
      USE_SERIAL.println("[WD] No inbound data for 30s — forcing reconnect");
      webSocket.disconnect();
      lastInboundMs = 0;
      return;
    }
```

`lastInboundMs` 只在收到 `WStype_TEXT` 時更新（`:473`）。**這是 DO 側看門狗的鏡像**：
DO 偵測「連上後從未收到遙測」，裝置偵測「送出去了但 30 秒沒收到任何東西」。
**為什麼裝置需要自己的看門狗**：Worker 重新部署時 **DO → 裝置的方向可能壞掉，而
裝置 → DO 仍正常**。此時 DO 看起來還在收遙測（以為一切正常），但所有指令都送不到；
裝置若不主動斷線重連，這個狀態會**永久持續**（TCP 沒有心跳偵測）。
`lastInboundMs = 0` 的重設是為了避免「斷線後立刻又觸發」。
⚠️ 一個隱含的循環依賴：DO 只在收到 telemetry 時才廣播 `state`
（`edge/src/device-hub.ts:378`），裝置每 10 秒送 telemetry → DO 每 10 秒回 state →
30 秒門檻安全。**但這意味著看門狗的有效性建立在「DO 對每則 telemetry 都回覆」上**。

**WiFi 切換與回滾**（`:525-552`）刻意**非阻塞**：存下舊憑證、存新憑證、`WiFi.begin`，
然後交給 `loop()` 處理結果。

```cpp
    // Save old credentials as fallback
    strncpy(wifiOldSsid, wifiSsid, 32);
    strncpy(wifiOldPass, wifiPass, 64);
    saveWiFiCredentials(newSsid, newPass);
    wifiReconnecting = true;
    wifiReconnectStart = millis();
    WiFi.disconnect(true);
    delay(200);
    WiFi.begin(newSsid, newPass);
    // Non-blocking: result handled in loop()
```

**為什麼不阻塞等待**：這是從 WebSocket 進來的指令。在 `webSocketEvent` 裡
`delay(15000)` 會凍結整條 WebSocket（包括 `webSocket.loop()` 的心跳維護）15 秒，
連線很可能就此斷掉。結果監控移到 `loop()`（`:950-985`）：成功就組 `wifi_ack` 存到
`wifiPendingAckJson`，逾時（`WIFI_RECONNECT_TIMEOUT_MS = 15000`，`:93`）就**回滾**
——先試 `wifiOldSsid`（執行期記下的前一組），為空才退回編譯期常數 `WIFI_SSID`
（`:971-975`，處理「第一次開機就 wifi_set」）。

**`wifiPendingAck` 機制是必要的細節**：切換成功時 **WebSocket 一定已經斷了**（換網路 =
換 IP = 舊 TCP 失效），ack 不能立刻送，要**存起來**等 `WStype_CONNECTED` 補送
（`:464-469`）：

```cpp
    case WStype_CONNECTED:
      if (wifiPendingAck) { wifiPendingAck = false; webSocket.sendTXT(wifiPendingAckJson); }
```

**沒有這幾行，使用者永遠不會知道 WiFi 切換成功還是失敗**——這是「非同步操作的結果要
跟隨連線生命週期」的經典模式。

`wifiEvent()`（`:236-255`）的自動重連有一個重要守衛：

```cpp
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
      uint8_t reason = info.wifi_sta_disconnected.reason;
      if (wifiReconnecting) {
        // wifi_set is in progress — don't auto-reconnect, let wifi_set handle it
      } else {
        WiFi.begin(wifiSsid, wifiPass);
      }
```

**在 `wifi_set` 進行中抑制自動重連**，否則事件處理器會用**舊的** `wifiSsid` 立刻重連，
把使用者的切換動作覆蓋掉——一個很容易漏掉的競態。

**EEPROM 校正**：`loadCalibration()`（`:275-303`）用「**先存預設值，讀到爛資料就還原**」
模式：

```cpp
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
    ecOffset = savedEcOffset;
  }
  ...
}
```

**為什麼要先存**：`EEPROM.get(addr, float)` **直接覆寫**傳入的變數。全新晶片的 EEPROM
是 `0xFF`，讀成 float 會是 NaN 或荒謬大數；不先備份就沒有預設值可還原
（`firmware/FIRMWARE.md:236` 稱之為 "saved-pattern"）。

校正儲存位址（`:56-63`）：`8` = `tdsKValue`、`16` = `ecOffset`、`24` = `ph7Voltage`、
`28` = `phSlope`、`32` = `CAL_V4`（pH 4.0 的電壓，兩點校正的中間狀態）、
`40` = WiFi 旗標（`0xAB`）、`41` = SSID、`74` = 密碼。`EEPROM.begin(512)` 配置 512 bytes，
最後位址 74+65=139 遠在範圍內。`0xAB` 這個 magic byte 是「這塊 EEPROM 已被本韌體寫過」
的標記，避免把未初始化的 `0xFF` 當成有效 SSID（`:205`、`:210`）。

⚠️ **CH340 自動重置問題**（`firmware/FIRMWARE.md:91-92`）：

> Opening COM3 from any tool pulls RTS/DTR and resets the ESP32.
> **Serial calibration does not work.** Use WSS for all calibration commands.

所以 `handleSerialCalibration()`（`:305-449`）雖然實作了完整的序列埠校正指令集
（`CAL:EC:0`、`CAL:PH:7`、`CAL:PH:4`、`CAL:PH:9`…），但**實際上無法使用**——一開序列埠
監看器 ESP32 就重置了。這也是校正功能後來被搬到 WebSocket（`calibrate` 指令，
`:553-714`）的原因。**兩套程式碼做同一件事，序列埠那套是死碼**（待確認是否移除；
保留的理由可能是無需網路即可校正的備援）。校正指令在三個地方用了不同的參數名：
序列埠 `CAL:EC:1413`（`:330`）、WSS `{"type":"ec_1413"}`（`:583`）、GreenyAgent
`{"type":"ph","slope":...}`（**沒有對應的處理分支**，§3.3）。

`ph_7`/`ph_4`/`ph_9` 的邏輯（`:622-702`）：`ph_7` 是單點（直接記錄電壓），
`ph_4` 與 `ph_9` 是**兩點校正的兩個方向**——兩者都檢查「另一次的電壓是否已在 EEPROM」，
有就計算斜率 `newSlope = (v4 - v9) / (9.18 - 4.00)`，沒有就退回單點。斜率算完用
`(0.010, 0.300)` 檢查合理性，不合理就單點 fallback 並印警告。`9.18 - 4.00` 對應
pH 4.00 與 pH 9.18 兩種標準緩衝液。

**Captive Portal（未使用）**：`startCaptivePortal()`（`:824`）與 `handleCaptivePortal()`
（`:830`）實作了一個極簡 HTTP 伺服器，讓裝置開熱點（`Greeny-Alpha-Setup`）供手機設定
WiFi。**但 `setup()` 完全沒有呼叫它們**——（待確認）是死碼或需手動加入呼叫。
`CP_HTML`（`:764`）用 `PROGMEM` 存字串以節省 RAM（ESP32 的標準做法）。
`handleCaptivePortal()` 內的手寫 HTTP 解析（`:862-865`）相當脆弱
（`indexOf('&', ss)` 回 -1 時 `substring` 行為異常），但有 `urlDecode()`（`:810`）處理
`%XX` 與 `+`。

### 6.2 Arduino 精簡版（`firmware/greeny2_sensor/greeny2_sensor.ino`，472 行）

檔案開頭（`:1-61`）說明定位：與完整版**走完全相同的協定**，但只保留必要邏輯方便閱讀與
修改；已用 arduino-cli 1.5.1 + esp32 core 3.3.12 **編譯通過**（1,115,705 bytes / 85%），
但**尚未在實體硬體上執行過**。

| 項目 | 完整版 | 精簡版 |
|---|---|---|
| 行數 | 1004 | 472 |
| OLED 顯示 / Captive Portal | ✅（Portal 未呼叫） | ❌ |
| EEPROM 校正持久化 | ✅（但被 `setup()` 覆蓋） | ❌（用常數，`:100-102`） |
| 序列埠校正 | ✅（實際不可用） | ❌ |
| NTP timeout | ❌ 無限等待（`:101`） | ✅ 20 秒（`:151`） |
| 印出 token | ⚠️ 完整 path（`:934`） | ✅ `token=***`（`:405`） |
| `ping` 訊息 | ❌ | ✅ `sendPing()`（`:227`） |
| 實機驗證 | ✅ 曾運行 | ⚠️ 僅編譯通過 |

**「同樣的協定」的具體證據**——兩邊的 telemetry 組裝欄位名稱、順序、round 位數完全一致
（完整版 `:739-747`、精簡版 `:212-221`）。**協定相容是靠人工同步維持的**（沒有共用的
header 或 schema 檔），所以 `PROTOCOL.md` 的存在很重要。

精簡版把兩個易錯點寫成註解：

```cpp
// :323-324
  // 注意：雲端 → 裝置的指令，參數一律包在 params 內
  JsonObject params = doc["params"].as<JsonObject>();

// :173、:177
// DFRobot SEN0244：三次多項式 → 先扣 offset，再做溫度補償（順序不可交換）
float readEC(float temp) {
  const float v  = adcVoltage(TDS_PIN);
  const float raw = (133.42f * v * v * v - 255.86f * v * v + 857.39f * v) * kValue;
  return (raw - ecOffset) / (1.0f + 0.02f * (temp - 25.0f));
}
```

⚠️ **注意這裡的符號與完整版相反**：精簡版是 `(raw - ecOffset) / comp`（標準邏輯），
完整版是 `(ecOffset - ecRaw) / comp`（`:141`，inverted 板）。pH 也相反：精簡版
`7.0f + (V - ph7Voltage) / 0.059`（`:184`）vs 完整版
`7.0 - (voltage - ph7Voltage) / phSlope`（`:148`）。**兩個版本的校正模型不同，
參數不能直接互抄。**

`doCalibrate()`（`:274-302`）**只回報不儲存**（`p["note"] = "value reported only -
write it into the constants above"`）：把「怎麼算」留給人——裝置量給你電壓，你算完
寫回程式碼再重燒。這是「示範用程式碼」的合理定位，但與完整版行為不同——**同一條指令在
兩個實作上結果不同**。精簡版的連線邏輯比完整版更完整（`:450-471`）：WiFi 掉了主動重連
（`connectWiFi(..., 10000)`）、**同時送 telemetry 與 ping**（`:468-469`）。

### 6.3 MicroPython（`firmware/esp32-micropython/main.py`，540 行）

**為什麼自行實作 WebSocket**：`firmware/esp32-micropython/README.md:14-15` 說明理由：
「不需要任何額外套件 —— WebSocket handshake 與 frame 編解碼都寫在 `main.py` 裡，
不依賴 `micropython-lib` 的 `websocket-client`（版本差異常導致 API 不相容）。」
三個具體理由：

1. **MicroPython 的套件管理很弱**：`mip`/`upip` 需要網路、需要套件在
   `micropython-lib` 上、且版本要與固件匹配。
2. **`websocket-client` 的 API 在不同版本間改過**（`ws.connect()` vs
   `websocket.connect()`、是否需要 `ssl` 參數包裝），一旦不匹配錯誤訊息非常難懂。
3. **自行實作只要 120 行**（`:78-204`）且完全可控（timeout 行為、mask 處理、close
   語意）。對一個只需「送 JSON、收 JSON」的客戶端，完整實作 RFC 6455 反而更簡單可控。

**Handshake**（`:121-138`）：客戶端送 16 bytes 隨機值 base64 編碼為
`Sec-WebSocket-Key`（RFC 6455 要求），然後讀到 `\r\n\r\n` 為止、檢查狀態行有沒有
`" 101"`。`_b64()`（`:78-81`）**特別處理 padding**：

```python
def _b64(data):
    """base64 編碼（MicroPython 的 binascii.b2a_base64 會多一個換行）。"""
    import binascii
    return binascii.b2a_base64(data).strip().decode()
```

MicroPython 的 `b2a_base64` 會附加 `\n`，`.strip()` 移除它——典型的「MicroPython 與
CPython 行為差異」陷阱。⚠️ 伺服器回應的驗證很寬鬆：只檢查 `" 101"`，**沒有驗證
`Sec-WebSocket-Accept`**（RFC 要求把 key + GUID 做 SHA1 後 base64 比對）。實務上可接受
（本來就是主動連到自己的伺服器），但少了「確認對方真的懂 WebSocket」的檢查。
`_read_until`（`:109-118`）有 4096 bytes 上限，避免握手回應異常時無限讀取。

**Frame 編解碼：masking 與對照組**。送出（client 必須 mask，`:145-161`）：

```python
    def _send_frame(self, opcode, payload=b""):
        n = len(payload)
        head = bytearray([0x80 | opcode])          # FIN + opcode
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126); head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127); head += struct.pack(">Q", n)
        mask = urandom(4)
        head += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i % 4]
        self.s.write(bytes(head) + bytes(masked))
```

逐項對照 RFC 6455 §5.2：`0x80 | opcode` = `FIN=1` + opcode（不支援分片，永遠 FIN，夠用）；
`0x80 | n` 的 **`0x80` 就是 MASK bit**——client 送出的 frame **必須**設為 1；
126/127 是延伸長度（126 → 2 bytes big-endian，127 → 8 bytes）；`mask = urandom(4)`
每次都要新的隨機值；XOR 迴圈 `payload[i] ^ mask[i % 4]` 讓金鑰循環使用。

**MASK bit 是 WebSocket 最容易寫錯的地方。** RFC 明文規定 client 送出的 frame 必須 mask、
server 送出的必須不 mask；伺服器若收到未 mask 的 client frame **必須立刻關閉連線**
（§5.1）。這是安全設計（防止快取污染攻擊），不是可選項。

接收（server 送來的不該 mask，但要能處理，`:163-204`）：

```python
    def recv_text(self, timeout_s=SOCK_TIMEOUT_S):
        """回傳一條文字訊息；逾時回 None；連線關閉回 False。"""
        self.s.settimeout(timeout_s)
        try:
            while True:
                chunk = self.s.read(2)
                ...
                opcode = b1 & 0x0F; masked = b2 & 0x80; ln = b2 & 0x7F
                if ln == 126:   ln = struct.unpack(">H", self._read_exact(2))[0]
                elif ln == 127: ln = struct.unpack(">Q", self._read_exact(8))[0]
                mask = self._read_exact(4) if masked else None
                data = self._read_exact(ln) if ln else b""
                if mask:
                    data = bytearray(data)
                    for i in range(len(data)):
                        data[i] ^= mask[i % 4]
                    data = bytes(data)
                if opcode == self.OP_PING:  self._send_frame(self.OP_PONG, data); continue
                if opcode == self.OP_PONG:  continue
                if opcode == self.OP_CLOSE: return False
                if opcode == self.OP_TEXT:  return data.decode(errors="replace")
        except OSError:
            return None                            # timeout —— 正常，交給主迴圈
```

**`if mask:` 這段是「對照組」**：接收端**理論上**不需要 unmask（server 不該 mask），
但程式碼仍然實作了——正確的防禦性程式設計。**這與送出端形成對照**：送出時**無條件**
mask（RFC 要求），接收時**有條件** unmask（合規 server 不需要，但支援）。

回傳值三重語意（docstring 就寫明了）：**字串** = 收到訊息；**`None`** = timeout
（正常，沒有訊息）；**`False`** = 連線關閉（收到 CLOSE frame 或讀到 EOF）。
**`None` 與 `False` 的區分是刻意的**，且靠 Python truthiness 判別（`main.py:512-517`）：
用 `if raw is False` 而不是 `== False`，是為了不讓 `""`（空字串）被當成關閉訊號。

`OP_PING` 的自動 `PONG` 回應（`:193-195`）是 RFC 要求的：收到 ping 必須回 pong 並帶
相同 payload。這讓 Cloudflare 連線層（可能有自己的 keepalive ping）能正常運作。
`_read_exact`（`:95-107`）處理 TCP 分段：`s.read(5)` 不保證回 5 bytes，所以用迴圈累積；
`if chunk is None: continue`（而不是 raise）是因為 MicroPython 的非阻塞 socket 在某些
情況 `read()` 會回 `None`（暫時沒資料），這與「回空 bytes 表示連線關閉」是不同事件。

**TLS 為何預設不驗證**：

```python
# main.py:52-56
# TLS 憑證驗證：
#   False = 加密但不驗證伺服器身分（MicroPython ESP32 沒有內建 CA bundle，
#           官方 Arduino 版用的是 ESP32 內建 CA bundle，MicroPython 沒有對應物）
#   True  = 需自行把 CA 憑證放到 flash 並確認固件支援 cadata/cert
TLS_VERIFY = False

# :444-450
    if TLS_VERIFY:
        sock = ssl.wrap_socket(raw, server_hostname=WS_HOST)
    else:
        try:
            sock = ssl.wrap_socket(raw, server_hostname=WS_HOST, cert_reqs=ssl.CERT_NONE)
        except TypeError:
            sock = ssl.wrap_socket(raw, server_hostname=WS_HOST)
```

三層解釋：(1) **Arduino 有內建 CA bundle，MicroPython 沒有**——官方 ESP32 固件的
`ssl` 模組沒有預設 CA store。(2) **所以只有兩個選項**：自己把 CA 憑證上傳到 flash 餵給
`ssl`（需要在部署流程多一步，CA 輪換時要重做），或者不驗證。(3) **不驗證的實際後果**：
連線**仍然加密**（無法被動竊聽），但**無法偵測中間人**（active MITM）。攻擊者若能控制
裝置的網路路徑（例如在農場 WiFi 上做 ARP spoofing）可以偽造伺服器。對一個傳感測器數值、
收 LED 指令的裝置來說風險可接受——**但這必須是明示的決定並寫在程式碼頂端**，
這份實作做到了。

`try/except TypeError` 是**固件版本相容性**處理：較新的 MicroPython 支援 `cert_reqs`，
較舊的會拋 `TypeError`。有這個 fallback 能跑在較廣的固件版本上（但會**靜默地不驗證**）。
`server_hostname=WS_HOST` 是 SNI，Cloudflare 需要它選憑證——**即使
`cert_reqs=CERT_NONE`，SNI 仍必須送**。

**與 Arduino 的差異表**：

| 項目 | Arduino 完整版 | Arduino 精簡版 | MicroPython |
|---|---|---|---|
| TLS 驗證 | ✅ 內建 CA bundle | ✅ 內建 CA bundle | ⚠️ `TLS_VERIFY = False` |
| 校正值儲存 | EEPROM（被 `setup()` 覆蓋） | 常數 | 常數（`calibrate` 只回報） |
| WiFi 憑證儲存 | EEPROM（可 WSS 切換） | 常數（切換不持久化） | `device_secrets.py`（不持久化） |
| WiFi 切換回滾 | ✅ 15 秒＋兩層 fallback | ✅ 20 秒＋回滾（`:432-446`） | ✅ 20 秒＋回滾（`:359-368`） |
| NTP timeout | ❌ 無 | ✅ 20 秒 | ✅ 3 次重試 |
| 看門狗 | ✅ 30 秒 | ✅ 30 秒 | ✅ 30 秒 |
| `ping` | ❌ | ✅ | ✅ |
| WebSocket 實作 | WebSockets 函式庫 | WebSockets 函式庫 | **自行實作 RFC 6455** |
| ADC 讀取 | `analogRead` + `analogSetPinAttenuation(ADC_11db)` | 同左（`:384-385`） | `adc.atten` + `adc.width`（`:216-217`） |
| 上機驗證 | ✅ | ⚠️ 未 | ⚠️ 未（僅 `py_compile`） |

MicroPython 的 ADC 讀取有版本相容處理（`:234-238`）：

```python
def _voltage(adc):
    try:
        return adc.read_uv() / 1_000_000.0     # 新版 MicroPython 有 read_uv
    except AttributeError:
        return adc.read() / 4095.0 * VREF
```

新版 MicroPython 提供 `read_uv()`（直接回微伏，已含衰減校正，更準確），舊版只有
`read()`。⚠️ fallback 用 `4095.0` 而 Arduino 版用 `4096.0`（`esp32.ino:135`）——1 LSB
差異造成約 0.02% 偏差，實務可忽略，但**兩份實作的數字不同是事實**。

`main()`（`:479-536`）的主迴圈與 Arduino 風格不同：Arduino 是事件驅動
（`webSocket.loop()` 內部處理非阻塞 I/O），MicroPython 是**顯式順序流程＋例外重連**——
`recv_text()` 回 `False` 或看門狗觸發就 `raise OSError`，全部收斂到一個 `except` 區塊
（關 socket、sleep 5、必要時重連 WiFi）。這是 Python 慣用的「用例外做控制流」風格，
比 Arduino 的「檢查每個狀態變數」更簡潔。`time.ticks_ms()`/`ticks_diff()` 是 MicroPython
特有 API（處理計時器溢位），**不能用 `time.time()` 取代**。

`check_wifi_set()` 的計時器有一個小瑕疵（`:519-522`）：`wifi_set` 的開始時間點是在
**下一輪迴圈**才記錄的（先傳入 `now`，再設定 `wifi_set_start`），所以 20 秒 timeout
實際是 20 秒 + 一輪（≈1 秒）。

---

## 7. 工具

### 7.1 `tools/greeny_check.py` — 22 項端到端檢查

設計目標（`:7-8`）：「一次驗證整條鏈路的每一段：Pages SPA → Pages 管理 API →
Worker REST → 兩個 WebSocket 通道 → （選用）裝置認證。**預設唯讀**：不會開關繼電器、
不會寫入遙測。」

結構是兩個全域容器（`RESULTS`/`CRITICAL_FAILS`，`:58-61`）＋三個輔助函式（`section`
`:70`、`line` `:75`、`timed` `:81`）＋兩個通用檢查器（`check_http` `:92`、
`check_ws` `:135`）。**`critical` 旗標決定 exit code**（`:325`：
`return 1 if CRITICAL_FAILS else 0`），所以同一份程式**同時當人看的報表與監控系統的
探針**（`:23-24`）。`_ws_probe()`（`:111-132`）的**狀態碼撈取**是實用技巧：不同版本的
`websockets` 把 HTTP 狀態碼放在 `e.response.status_code` 或只在例外訊息字串裡，所以先試
前者再從字串撈。**副作用**：例外訊息恰好含 `500` 時會誤判——可接受的啟發式。

**為什麼每個正向測試都配一個負向測試**：

| 區段 | 正向 | 負向 |
|---|---|---|
| 1. 基礎連線 | Worker `/health`、Pages `/` | — |
| 2. 登入 | Worker 登入、Pages 登入 | **Worker 錯誤密碼應被拒絕（401）**（`:217`） |
| 3. Worker REST | `/api/auth/me`、`/api/devices`、`/api/telemetry`、`/api/alerts` | **無 token 應被拒絕（401）**（`:237`） |
| 4. Pages 管理 API | `/api/auth/me`、`/api/offices`、`/api/racks`、`/api/users`、`/api/dashboard/stats` | **無 token 應被拒絕（401）**（`:249`） |
| 5. 儀表板 WS | 帶有效 JWT → 101 | **無 token → 401**、**假 token → 401**（`:256`、`:258`） |
| 6. 裝置 WS | 正確 device token → 101 | **無 token → 401**、**錯誤 token → 401**（`:270`、`:272`） |
| 7. 遙測寫入 | POST 帶 `X-Device-Token` | **無憑證 POST → 401**（`:289`） |

1. **這個專案的歷史就是「認證看起來有做，其實沒有」**：`$2` 短路讓錯誤密碼也能登入、
   WebSocket 完全沒認證、`POST /api/telemetry` 完全開放。這三個問題**都不會被正向測試
   發現**——它們的症狀是「功能正常運作」。
2. **正向測試只證明「合法請求能用」，不證明「非法請求不能用」**。一個完全沒有認證的
   端點，正向測試會**通過**。
3. **負向測試是唯一能防止「修好又被改壞」的機制**。`$2` 短路是「為了讓舊帳號能登入」
   而加的——這個動機隨時可能再出現（例如「為了讓某個舊裝置能連」）。有了固定的負向測試，
   這種改動會立刻被偵測。

負向測試**兩邊都測**（`:237`、`:249`），因為兩邊是不同程式碼、可能各自被改壞。

**為什麼裝置 WS 測試用 `<device-id>-probe` 而不是真 id**（`:173-175`、`:184`）：

```python
    ap.add_argument("--device-ws-id", default=None,
                    help="裝置 WS 測試用的 device_id。預設為 <device-id>-probe —— "
                         "刻意不碰真實裝置：DO 只允許一個 esp32 連線，用真 id 會把上線中的裝置踢掉")
...
    device_ws_id = args.device_ws_id or f"{args.device_id}-probe"
```

表面理由是「不佔用裝置的連線名額」；**真正理由**在 `edge/src/device-hub.ts:255-268`：
裝置連線時 DO 會**清空 `relay_queue`** 並**關掉現有連線**
（`close(1000, "Replaced by new connection")`）。所以測試腳本連上
`/device/esp32-sensor` 會**踢掉真正在線上的裝置**並**清空其待送指令佇列**——在一座運作
中的農場上跑測試會造成實際服務中斷。`<device-id>-probe` 建立**獨立的 DO 實例**
（`idFromName` 不同），完全隔離。

**這是「測試工具必須知道被測系統的副作用」的範例。** 預設安全、要用真 id 必須明確加
參數——**secure by default**。`--write-test`（`:176-177`、`:279-295`）同樣思路：預設不
寫入，要寫入必須明示，且**寫入後印出清理指令**，並用**時間戳造出唯一 `probe_id`**
（`:282`）不污染真實資料。憑證全部從**環境變數或參數**讀（`:170-172`），不寫死在程式碼
裡；`--json` 輸出（`:304-314`）也**不會**回印憑證。

### 7.2 `tools/greeny_probe.py`

`:5-6` 定位：「唯讀工具：只做 GET 讀取與 WebSocket 訂閱，**不會**切換繼電器或修改任何
資料。」是**更早的簡易版**（`docs/GUIDE.md` §13.4 說「保留備用」），價值在於 §4.2 提到
的**認證繞過探針**：

```python
# tools/greeny_probe.py:33-34、126-131
# 故意錯誤的密碼，用來測試 Pages 端是否錯誤地接受 bcrypt 帳號
FAKE_PASSWORD = "WRONG-PASSWORD-DO-NOT-USE-1234"
...
    pages_token = login(PAGES, "admin", FAKE_PASSWORD,
                        "Pages (greeny.techforliving.net)：故意使用『錯誤密碼』")
    if pages_token:
        print("\n  *** 注意：用錯誤密碼竟然拿到 token -> Pages 登入驗證有問題 ***")
        read_apis(PAGES, pages_token, "Pages API")
```

**用故意錯誤的密碼登入，拿到 token 就是漏洞**。它比 `greeny_check.py` 更積極：不只驗證
「回 401」，還**在意外成功時繼續用那個 token 去讀管理 API**，證明漏洞的實際衝擊範圍。
這是資安測試的正確心態——**不只確認防線存在，還要確認越過防線後能拿到什麼**。

`ws_test()`（`:97-116`）的隱私處理值得學習：

```python
    full = f"{url}?token={token}" if token else url
    shown = f"{url}?token={'<JWT>' if token else ''}" if token else url
    print(f"  連線: {shown}")
```

**實際連線用 `full`，印出的是 `shown`**——token 被替換成 `<JWT>`。工具輸出經常被貼到
issue 或聊天記錄，這個小細節避免憑證外洩。（`:133` 有一個舊註解提到
`iot-hub.funconnect...`，那是文件中已標示停用的舊 Worker，功能上不影響，因為實際用的是
`WORKER` 常數（`:29`）。）

### 7.3 `tools/toggle-led.mjs`

`:2-10`：「Connects to the IoT Hub DO via WSS, sends random set_led commands, logs
timestamps and RTT to toggle-log.jsonl.」**這是用真實負載量測延遲分佈的工具**，不是玩具。

**（1）憑證從環境變數讀**（`:12-14`）：

```js
const TOKEN = process.env.GREENY_TOKEN || "";
if (!TOKEN) { console.error("需要 GREENY_TOKEN 環境變數（登入取得的 JWT）"); process.exit(1); }
const WS_URL = `wss://iot-hub.ai-caseylai.workers.dev/dashboard/esp32-01?token=${encodeURIComponent(TOKEN)}`;
```

⚠️ 用的是 `esp32-01`，**不是** `esp32-sensor`。（待確認）是刻意（測試用不同 DO 實例，
與 `greeny_check.py` 的 `-probe` 策略一致）還是筆誤——但 `esp32-01` 不像一個明顯的
「測試 id」。**使用前應確認。**

**（2）隨機間隔產生真實分佈**（`:181-187`）：60% 落在 2–30 秒、20% 落在 1–5 分鐘、
15% 落在 10–30 分鐘、5% 落在 1–6 小時。這**模擬真實使用行為**：大部分操作間隔很短
（人在測試），少部分是長時間間隔（LED 開著過夜）。這讓量到的 `durationMs`
（LED 維持同一狀態多久）具有實際參考價值。

**（3）RTT 從 `doTs` 算**（`:141-155`）：收到 `msg.type === "state"` 時
`rttMs = Date.now() - msg.doTs`，並用 `lastLed`/`lastChangeTs` 追蹤狀態持續時間。
`doTs` 是 DO 產生廣播時的 `Date.now()`（`edge/src/device-hub.ts:383`），所以這是
「**DO → 瀏覽器的單向延遲**」（不是完整 RTT，但因為是同一個 DO 處理，誤差可忽略）。

`--stats` 模式（`:25-113`）做完整分位數（p50/p90/p99，`:48-50`）並畫 **ASCII 直方圖**
（`:52-70`）——不需任何繪圖依賴，在 SSH / CI 環境也能讀。這是「量測工具應該能產生可貼上
的輸出」的良好實踐。⚠️ `:84-86` 有一段**沒有作用的迴圈**（`onOff` 從未被使用，三元運算
兩分支都回 `""`），是重構後的殘留，**無害但應清除**。日誌寫到 `toggle-log.jsonl`
（JSON Lines 格式，`:18`、`:123-127`），每行一筆獨立記錄，適合串流處理與 `jq` 查詢；
`.gitignore:4` 排除它。

---

## 8. 資料模型

### 8.1 D1 `greeny-db` 的表

依據 `docs/GUIDE.md` §3 的盤點（2026-10-13），D1 有 16 張表。**以下「關鍵欄位」是從
程式碼中的 SQL 語句反推的**——repo 裡只有 `edge/db/schema.sql` 這一份 DDL，而且它
**與線上實際結構不同**（§8.2）。

| # | 表 | 用途 | 程式碼中的關鍵欄位 |
|---|---|---|---|
| 1 | `users` | 登入帳號與角色 | `id`、`username`、`password_hash`、`role`、`display_name`、`office_id`、`active`、`created_at`。**沒有 `salt`** |
| 2 | `offices` | 據點 | `id`、`name`、`contact_person`、`contact_phone`、`whatsapp_number`、`notes`、`active`、`created_at` |
| 3 | `racks` | 貨架（可綁裝置） | `id`、`name`、`office_id`、`device_id`、`location`、`status`、`layer_count`、`created_at` |
| 4 | `rack_vegetables` | 貨架蔬菜層 | `id`、`rack_id`、`layer_number`、`variety`、`quantity`、`planted_at`、`notes`、`created_at` |
| 5 | `rack_environment` | 環境數據 | `id`、`rack_id`、`temperature`、`humidity`、`light_level`、`ph`、`ec`、`source`、`recorded_at`、`created_at` |
| 6 | `devices` | 裝置註冊與狀態 | `id`（＝device_id 字串）、`device_id`、`name`、`floor`、`location`、`status`、`last_seen`、`hotel_id`、`created_at` |
| 7 | `telemetry` | 遙測歷史 | **兩套欄位並存**：`(device_id, tds, ec, ph, temp, led, esp32_ms, do_ms, created_at)`（Worker/DO）＋ `(ph, ec, water_temp, water_level, ndvi, spectral_*, relay1, relay2, ts_ms, hotel_id)`（Pages） |
| 8 | `alerts` | 警報 | `id`、`device_id`、**`type` 與 `alert_type` 並存**、`message`、`severity`、`acknowledged`、`hotel_id`、`created_at` |
| 9 | `crop_batches` | 作物批次 | `id`、`office_id`、`batch_id`、`variety`、`quantity`、`planted_at`、`status`、`created_at`（欄位名待確認；目前 0 筆） |
| 10 | `harvest_logs` | 收成紀錄 | `id`、`batch_id`、`quantity`、`harvested_at`、`notes`、`created_at`（欄位名待確認） |
| 11 | `automations` | 自動化規則 | `id`、`name`、`type`、`cron_expr`、`config`、`office_id`、`rack_id`、`enabled`、`last_run_at`、`created_at` |
| 12 | `relay_log` | 指令稽核（D1 端） | `id`、`device_id`、`command`、`params_json`、`status`、`created_at`（⚠️ Pages 的 `relay-logs.ts:14` 讀的是 `relay1, relay2, ph_cal`） |
| 13 | `relay_queue` | 待送指令（D1 端，舊路徑） | ⚠️ Pages 用 `(device_id, relay1, relay2)`；DO 用的是 **DO-local** 的 `relay_queue`（`command`/`params_json`）。**同名不同表** |
| 14 | `settings` | 系統設定 key-value | `key`（PK）、`value` |
| 15 | `sqlite_sequence` | SQLite 內部（AUTOINCREMENT 用） | `name`、`seq`。**系統表，不要動** |
| 16 | `_cf_KV` | Cloudflare D1 內部 metadata | **系統表，不要動** |

`spa/functions/api/` 下另有 `tasks`、`personnel`、`filters`、`notifications`、
`reports/*` 的端點，但這四張表**不在 16 張清單裡**（待確認）——可能是清單只列部分，
或這些端點目前無對應表而會失敗。

### 8.2 D1 線上結構與程式碼不一致的地方（重要）

這是本專案最容易改錯的地方。以下都是**從程式碼可證實的不一致**：

**（1）`devices` 有兩個識別欄位，兩個模組用不同的**

| 模組 | 語句 | 位置 |
|---|---|---|
| Worker DO alarm | `UPDATE devices SET last_seen = ?, status = 'online' WHERE device_id = ?` | `edge/src/device-hub.ts:613` |
| Pages telemetry POST | `INSERT INTO devices (id, name, floor, location, status, last_seen) ... ON CONFLICT(id) DO UPDATE ...` | `spa/functions/api/telemetry.ts:72-75` |
| Pages devices GET | `... FROM devices d ORDER BY d.id` | `spa/functions/api/devices/index.ts:13` |
| Pages racks JOIN | `LEFT JOIN devices d ON r.device_id = d.id` | `spa/functions/api/racks/index.ts:11` |

Pages 一面倒用 `d.id`（且 `id = device_id` 字串），Worker 的 alarm 用 `device_id` 欄位。
**兩者要同時存在才兩邊都能跑。**（待確認）`devices` 是否真有 `device_id` 欄位——如果
沒有，DO 的 `last_seen` 更新會**每次都失敗**（被 `catch` 吞掉，`:615-617`，
所以不會爆但也不會生效）。

**（2）`telemetry` 有兩套欄位命名**：Worker/DO 寫 `temp`/`do_ms`/`tds`/`led`；Pages 寫
`water_temp`/`ts_ms`/（無 tds）/`relay1`，另有 `spectral_*`、`ndvi`、`water_level`。
這就是 `normalizeReading()` 存在的理由。**新增遙測欄位時必須想清楚是給哪一條路徑用的。**

**（3）`alerts` 有 `type` 與 `alert_type`**：Worker DO alarm 寫 `alert_type`
（`edge/src/device-hub.ts:574`）；Pages 寫 `type`（`spa/functions/api/telemetry.ts:98`）；
前端 `type: a.alert_type || a.type`（`spa/src/hooks/useSensorData.ts:107`）**同時容忍兩個
欄位名**——這是「已經知道兩邊不一致」的證據。

**（4）`relay_queue` 是兩個完全不同的表**：DO-local SQLite 用
`(id, device_id, command, params_json, created_at)`；D1 用 `(id, device_id, relay1, relay2)`
（`spa/functions/api/relay.ts:18,39`）。**名字一樣、schema 不同、在不同資料庫。**

**（5）`relay_log` 同樣兩套欄位**：Worker DO alarm 寫
`(device_id, command, params_json, status, created_at)`（`edge/src/device-hub.ts:593`）；
Pages `relay-logs.ts:14` 讀 `(id, relay1, relay2, ph_cal, status, created_at)`。

**（6）`edge/db/schema.sql` 已過期**：`:45` 仍寫著 `salt TEXT NOT NULL`，但
`docs/GUIDE.md` §5.1 明載「`greeny-db` 本來就沒有這欄」，且 `edge/src/index.ts:619-621`
的註解也說「no `salt` column」。**這是「程式碼已經改了，但 repo 裡的 schema 檔沒改」的
典型漂移。** 若有人拿這份 schema 重建資料庫，會建出與現工程式碼不相容的結構
（待確認是否要更新）。同樣地 `edge/db/schema.sql:4-13` 的 `devices` 用
`device_id TEXT NOT NULL UNIQUE` 為主鍵、有 `firmware_version`，但 Pages 用 `id` 為主鍵
——**兩份 schema 不能同時是對的**。

### 8.3 `settings` 表的重要 key

| Key | 讀取位置 | 用途 |
|---|---|---|
| `jwt_secret` | `edge/src/index.ts:29`、`spa/functions/_lib/jwt.ts:13` | JWT HS256 簽章與驗證密鑰。**Worker 與 Pages 共用同一把**，這是 token 兩邊都通的原因 |
| `device_token` | `edge/src/index.ts:45`（WS）、`spa/functions/api/telemetry.ts:8`（POST） | 裝置憑證，同一個值用在 WS handshake 與 HTTPS 備援 |
| `ph_min` / `ph_max` / `ec_max` / `temp_min` / `temp_max` | （待確認）程式碼中沒有讀取 | 警報閾值類，`docs/GUIDE.md` §8.4 標為「顯示用」 |

**關鍵觀察：閾值類的 key 目前「只有前端在用」**，後端的 `evaluateAlerts()`
（`edge/src/device-hub.ts:490-502`）用的是硬編碼的 `5.5/8.5/2000/18/30`。
也就是說**改了 `settings` 的閾值不會改變實際的警報行為**（待確認是否為已知問題）
——GUIDE §8.4 的措辭「警報閾值（顯示用）」其實已經承認了這一點。
GUIDE §3 記錄 `settings` 有 22 個 key，但程式碼只讀 7 個，**其餘 15 個的用途（待確認）。**

**為什麼密鑰放 `settings` 而不是環境變數**：三個理由合起來才成立——(1) Worker 與 Pages
需要同一把密鑰，而 D1 是唯一共用的儲存；(2) 這是公開 repo，任何提交進去的預設值都是
公開的簽章密鑰；(3) 放 D1 讓「輪換密鑰」變成一個 UPDATE，不需動兩個部署設定
（代價是所有已發出的 JWT 立即失效，因為兩邊都會讀到新值）。

---

## 9. 關鍵設計決策與取捨

| # | 決策 | 理由 | 代價 |
|---|---|---|---|
| 1 | **裝置只走 WSS**（無 HTTPS 輪詢、無 MQTT） | 一條連線同時承載遙測上行與指令下行；ESP32 的 TLS 握手成本高（CPU／記憶體／時間），長連線避免重複握手；不需 broker 基礎設施（MQTT 要多一台伺服器） | 連線斷了就完全失聯（靠兩端看門狗 30 秒內自癒）；狀態在 DO 記憶體裡，被驅逐要靠 attachment 還原；`POST /api/telemetry` 只是備援，實際未使用 |
| 2 | **DO 熱路徑零 `await`** | `webSocketMessage()` 是原子操作，不受其他事件插入影響；不會因 D1 延遲堵住後續訊息；避免 `await` 前後的競態 | 熱路徑只能用**同步** API，不能用 `fetch`/D1/KV；需要非同步的工作都得推到 `alarm()`，最長延遲 60 秒 |
| 3 | **D1 與 DO-local SQLite 兩層** | 每 10 秒寫一次若直接打 D1，rows-written/read 配額會被高頻小寫入吃掉；DO-local SQLite 寫入是微秒級且同 colo | 兩層之間是 **at-least-once**（不是 exactly-once），極端情況 D1 會有重複列；需要 `flushed` 旗標與清理邏輯；DO 被完全重設時未 flush 的資料會消失 |
| 4 | **指令分兩種可靠性**（`set_led` 佇列 / `calibrate` QoS 0） | `set_led` 是**幂等且無狀態**的（重放無害），排隊補送合理；`calibrate` **綁定當下物理狀態**（探頭在 pH 7.0 緩衝液裡），離線排隊後補送會寫入錯誤校正值 | 使用者必須理解「為什麼有時校正沒反應」；同一套 API 有兩種可靠性語意，需文件說明；`set_led` 佇列在裝置重連時被清空（跨重啟不保證） |
| 5 | **JWT 密鑰放 D1 `settings`** | Worker 與 Pages 需同一把密鑰，D1 是唯一共用儲存；公開 repo 中任何提交的預設值都是公開密鑰；輪換只需一個 UPDATE | 每次 isolate 冷啟動多一次 D1 讀取；**任何能寫 `settings` 表的人都能偽造任意 JWT**；兩邊對「密鑰缺失」的處理不同（401 vs 500） |
| 6 | **WS 憑證走 query 參數** | 瀏覽器的 `WebSocket` 建構子**無法**設 `Authorization` header，ESP32 的 `WebSocketsClient` 也沒有；query 是唯一雙方都可行的通道 | token 會出現在 **access log、proxy log、瀏覽器歷史**；不能設 `HttpOnly` cookie 的保護；換 token 必須重建連線（沒有重新認證機制） |
| 7 | **PBKDF2 單一自描述格式** | 同一筆 `users` 資料在 Worker 與 Pages 都能驗證；迭代次數存在字串裡所以能逐步提高；salt 內嵌所以**不需要 `salt` 欄位** | 舊的 bcrypt 資料**完全無法驗證**，必須一次性遷移（遷移期間使用者要改密碼）；兩邊實作是複製的，必須手動同步 |
| 8 | **Pages 不接 GitHub 自動部署**（`source: null`） | 部署完全由 `wrangler pages deploy` 控制，沒有 CI 做未預期的建置；可精確控制「哪個 commit 上了 production」 | **`git push` 不會部署**——改了程式碼而忘記手動部署是常見的「線上沒變」原因；沒有建置檢查，壞掉的程式碼可以推到 `main` |
| 9 | **AI agent 用 pre-fetch 而非純 tool calling** | 便宜的小模型不會用 tool calling，直接問會**幻覺出感測器數值**；先用 regex 判斷意圖再抓真實資料塞進 prompt，成本幾乎為零（DO-to-DO 內部呼叫不計費）且不會編數字 | regex 意圖判斷會漏（例如「我的羅勒還好嗎」不一定命中關鍵字）；需維護 prompt 樣板與關鍵字清單；兩條路徑行為不同，使用者可能感受到回答風格不一致 |
| 10 | **WebSocket 認證在 Worker 層攔截**，不進 DO | 未通過認證的請求完全不消耗 DO 喚醒成本；DO 不需重複驗證邏輯；攻擊者無法透過 WS 讓 DO 產生費用 | Worker 必須知道兩種憑證的細節，職責稍微變重；DO 無法區分「未認證」與「未連線」 |
| 11 | **`GET /api/relay` 刻意免認證** | 讓裝置用最簡單的方式輪詢指令（不需 JWT 或 device token），是舊版 Casey 協定的相容路徑 | 任何人可讀取待處理的繼電器指令（GUIDE §5.4 列為已知殘留風險） |
| 12 | **`device_token` 未設定時裝置通道開放**（只印警告） | 讓機隊可逐步遷移（先部署程式碼、再逐台燒 token），不會一次全部斷線 | **安全開關放在資料庫**：能寫 `settings` 的人可以關閉裝置認證；`cachedDeviceToken` 的模組層級快取意味著**設定變更後要等 isolate 回收才生效**（待確認實際時間） |

**兩個「不做」的決策**：

- **不做裝置 ID 的動態設定**：`device_id` 硬編碼在韌體（`esp32.ino:25`、
  `greeny2_sensor.ino:86`）。多台裝置需各自編譯。理由是 NVS／flash 設定檔的讀取會增加
  複雜度，而目前只有一台。**代價**：新增裝置是「編譯＋燒錄」等級的操作。
- **不做告警升級**（warning → critical）：型別允許 `critical`、UI 也有樣式，但沒有規則
  會產生它，也沒有「持續超標 N 次就升級」的邏輯。**代價**：無法區分「剛超標」與
  「超標三小時」。

---

## 10. 程式碼層面的陷阱彙整

### 10.1 認證與路由

| # | 陷阱 | 症狀 | 正確做法 | 位置 |
|---|---|---|---|---|
| 1 | **`/api/auth/` 前綴放行** | `/api/auth/me` 被放行但 `context.data.user` 是 `undefined` → `user.sub` 拋 TypeError → **500** | 精確比對 `path === '/api/auth/login'` | `spa/functions/api/_middleware.ts:17` |
| 2 | **`$2` bcrypt 短路** | `if (storedHash.startsWith('$2')) return true;` → **任何密碼都能登入** | 非 `pbkdf2:` 一律 `return false`；舊資料先遷移 | `spa/functions/_lib/password.ts:33`、`edge/src/auth.ts:166` |
| 3 | **SELECT 不存在的欄位** | Worker 登入 `SELECT ... salt`，但 `greeny-db` 沒這欄 → 查詢失敗 → 登入 500 | 只 SELECT 存在的欄位；salt 內嵌在 `password_hash` | `edge/src/index.ts:622` |
| 4 | **`needsAuth()` 是 fail-closed 閘門** | 新端點沒加白名單 → **自動要求 JWT**（不是自動開放） | 這是正確行為；新增公開端點必須明確加進 `AUTH_WHITELIST`（精確字串） | `edge/src/index.ts:54-66` |
| 5 | **新 WS 路徑被當成 esp32** | DO 用 `pathname.includes("dashboard")` 判角色 → 新路徑會被當裝置並**踢掉現有裝置連線** | 新增 WS 路徑時同步改角色判定 | `edge/src/device-hub.ts:246` |
| 6 | **登入的 `active` 檢查兩邊不一致** | Worker 不檢查、Pages 檢查 → 被停用帳號在 SPA 仍可登入 | （待確認）是否對齊 | `edge/src/index.ts:622` vs `spa/functions/api/auth/login.ts:18` |
| 7 | **`device_token` 未設定＝完全開放** | D1 沒有該 key 時裝置 WS 只印警告不拒絕 | 部署後確認 `settings.device_token` 存在 | `edge/src/index.ts:587-589` |
| 8 | **兩個 secret 快取語意不同** | `getJWTSecret` 用 truthy（空字串不快取）、`getDeviceToken` 用 `!== null`（會快取）→ 密鑰缺失時 Worker 每請求都查 D1 | 改任一處時注意兩者不同 | `edge/src/index.ts:27,43` |

### 10.2 訊息格式

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 9 | **`params` 包裝** | 雲端 → 裝置的**指令參數一律包在 `params` 內**：`{"command":"set_led","params":{"state":true}}`，**不是** `{"command":"set_led","state":true}`。寫錯的話裝置收不到指令、LED 沒反應但遙測正常 → 非常難查 | 前端 → DO 那層用直接欄位（DO 會重新包裝）；DO → 裝置那層用 `params`。詳見 `docs/API.md` A.7 |
| 10 | **韌體讀錯層級** | 完整版讀 `doc["params"]["state"]`（`:487`，正確）；誤寫成 `doc["state"]` 會永遠讀到 false | 三個實作的分支見 `esp32.ino:486`、`greeny2_sensor.ino:326`、`main.py:417`。**MicroPython 版同時容忍兩種**（`:418`） |
| 11 | **`greeny_check.py` 的狀態碼撈取是啟發式** | 例外訊息含數字時可能誤判 HTTP 狀態 | 知道即可，不影響正常情況 |
| 12 | **警報訊息混雜簡繁** | DO 產生的是簡體（`过低`/`阈值`），Pages 的是繁體 | 前端有轉換層（`useChineseText` / `lib/chinese.ts`）；新增訊息時注意用語 |

### 10.3 Pages Functions

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 13 | **相對匯入層數** | `api/x.ts` → `../_lib/`；`api/auth/x.ts` → `../../_lib/`；`api/wb/_middleware.ts` → `../../../_lib/`。**層數錯誤 → 建置失敗** `BuildFailure … api/xxx.ts:2` | 數清楚 `..` 個數（GUIDE §10.3） |
| 14 | **`c.params` 的兩種用法** | `offices/[id].ts:6` 用 `c.params.id`；`users/[id].ts:14` 自己切 pathname | 優先用 `c.params.id`（官方 API）。（待確認）users 為何不用 |
| 15 | **`mgmtApiFetch` 不補 `/api` 前綴** | 傳 `'/crop-batches'` → 打同源 `/crop-batches` → **404**（應為 `/api/crop-batches`）。**目前是多處的真實缺陷** | 呼叫端寫完整路徑，或統一在 `mgmtApiFetch` 內補前綴 |
| 16 | **兩套 fetch 打不同伺服器** | `apiFetch` 打 Worker（跨域）、`mgmtApiFetch` 打同源 Pages。**用錯會 404** | 遙測／裝置／警報／登入／chat → `apiFetch`；據點／貨架／作物／用戶 → `mgmtApiFetch` |
| 17 | **`useAlerts().acknowledge()` 打不存在的端點** | 呼叫 `PATCH /api/alerts/${id}`，但 Worker 只有 `POST /api/alerts/ack` → 404 | （待確認）改用 `POST /api/alerts/ack` 或新增 Worker 路由 |
| 18 | **middleware 白名單與端點路徑耦合** | 搬動端點路徑忘了改白名單 → 裝置突然不能用 | 兩處必須同步修改 |

### 10.4 Worker / DO

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 19 | **在 `webSocketMessage()` 加 `await`** | 熱路徑被堵住、訊息延遲、可能競態 | 持久化用**同步** `ctx.storage.sql.exec()`；非同步工作推到 `alarm()`（規則見 `edge/src/device-hub.ts:7-12`） |
| 20 | **constructor 加 `await` 或 `blockConcurrencyWhile`** | constructor 不能 async；`blockConcurrencyWhile` 會拉高喚醒延遲 | 只用同步 API；`ctx.getWebSockets()` + `deserializeAttachment()` 還原狀態（`:97-104`） |
| 21 | **`alarm()` 忘記重新排程** | 連續失敗 6 次後 alarm **永久停止**，之後完全不再 flush | `finally { await this.ctx.storage.setAlarm(Date.now() + 60_000) }`（`:637-641`）**不可協商** |
| 22 | **`alarm()` 逐列 try/catch 被移除** | 單列失敗導致整個 alarm 拋錯 → 加速消耗重試次數 | 內層 `try` 包每列（`:551-560`）、外層一個 `try`、`finally` 一定重排 |
| 23 | **廣播的 `device_id` 硬編碼** | `device_status: offline` 寫死 `"esp32-sensor"`（`:542`）→ 多裝置時報錯裝置 | （待確認）應從 attachment 取 |
| 24 | **flush 不是原子操作** | 「先 INSERT 全部、再 UPDATE flushed=1」中間 crash 會造成 D1 重複列 | 目前接受 at-least-once；要 exactly-once 需用 transaction |
| 25 | **`relay_queue` 在裝置重連時被清空** | 離線期間排隊的 `set_led` 會遺失 | 這是刻意的（避免重放校正指令）；**不要「順手修掉」**（`:259-261`） |
| 26 | **`evaluateAlerts()` 用硬編碼閾值** | 改 `settings` 的 `ph_min` 等**不會改變警報行為** | （待確認）是否有計畫改讀 D1 |

### 10.5 韌體

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 27 | **NTP 必須在 WSS 之前** | 沒有電池 RTC → 時鐘是 1970 → **憑證被判定「尚未生效」** → 握手失敗 | `configTime(...)` 且等到 `time(nullptr) > 8*3600*2` 才連 WSS |
| 28 | **`beginSslWithBundle(..., NULL, 0, "")` 三個參數不能省** | 傳自己的憑證或改參數會失去內建 CA bundle 的完整驗證 | `NULL, 0, ""` = 用 ESP32 內建 CA bundle。**Core ≥ 3.0.4 多一個參數**（`esp32.ino:935-939` 有分支） |
| 29 | **ADC 只能用 ADC1（GPIO 32–39）** | 用 ADC2 腳位在 WiFi 開啟時**讀不到值**（硬體限制） | TDS = GPIO 35/36、pH = GPIO 39 都在 ADC1；新增感測器時確認腳位 |
| 30 | **`setup()` 裡的「強制校正值」** | `esp32.ino:897-902` 每次開機覆蓋 `tdsKValue`/`ecOffset` 並寫回 EEPROM → **所有 WSS 校正指令在重開機後失效** | 若要讓校正持久化，**必須移除那 5 行** |
| 31 | **序列埠校正實際不可用** | CH340 一開序列埠就拉 RTS/DTR 重置 ESP32 → `handleSerialCalibration()` 是死碼 | 所有校正走 WSS（`:305-449` 保留但不要指望） |
| 32 | **`wifi_set` 一定要非阻塞＋待送 ack** | 切換 WiFi 必然斷線；在事件處理器裡等結果會凍結 WS；立刻送 ack 會送不出去 | 結果監控放 `loop()`（`:950`），ack 存 `wifiPendingAckJson` 等 `WStype_CONNECTED` 補送（`:464-469`） |
| 33 | **`wifiReconnecting` 期間要抑制自動重連** | 否則 `wifiEvent()` 會用**舊** SSID 立刻重連，覆蓋使用者的切換 | `esp32.ino:245-250` 的 `if (wifiReconnecting) { /* 不重連 */ }` |
| 34 | **兩個 Arduino 版的 EC/pH 公式符號相反** | 完整版是 inverted 板（`(ecOffset - ecRaw)`、`7.0 - (V-V7)/slope`），精簡版是標準（`(raw - ecOffset)`、`7.0 + (V-V7)/slope`）。**校正參數不能互抄** | 看清楚是哪塊板子 |
| 35 | **校正常數運算順序** | DFRobot：**先扣 offset，再做溫度補償**（不可交換） | `(raw - offset) / (1 + 0.02*(temp-25))` |
| 36 | **`loadCalibration()` 的 saved-pattern** | `EEPROM.get()` **直接覆寫**變數；不先備份就沒預設值可還原 | 先 `float savedX = x;`，驗證失敗再還原（`:275-303`） |
| 37 | **完整版 NTP 迴圈沒有 timeout** | NTP 被封鎖時裝置**永遠卡在 `setup()`** | 精簡版與 MicroPython 版有 timeout；完整版沒有（`:101`）（待確認是否要補） |
| 38 | **完整版把 token 印到序列埠** | `esp32.ino:934` 印出完整 path（含 `?token=`）→ log 裡有憑證 | 精簡版已改為 `token=***`（`greeny2_sensor.ino:405`） |
| 39 | **`read_uv()` 是新版 MicroPython 才有** | 舊固件只有 `read()` | `main.py:234-238` 的 `try/except AttributeError`。fallback 用 `4095.0`（Arduino 用 `4096.0`） |
| 40 | **MicroPython 的 `b2a_base64` 會加換行** | `Sec-WebSocket-Key` 帶 `\n` → 握手失敗 | `.strip()`（`main.py:78-81`） |
| 41 | **WebSocket client 必須 mask** | 未 mask 的 client frame 會被合規 server 立刻斷線（RFC 6455 §5.1） | `head.append(0x80 \| n)` 的 `0x80` 就是 MASK bit（`main.py:149`） |
| 42 | **`time.ticks_ms()` 不能換成 `time.time()`** | MicroPython 的 ticks 系列處理計時器溢位 | 用 `time.ticks_diff()` 算差值（`main.py:502-508`） |
| 43 | **`is False` vs `== False`** | `recv_text()` 用 `False` 表示連線關閉、`None` 表示 timeout、`""` 是空訊息 | 必須 `if raw is False`，否則空字串會被當成關閉訊號（`main.py:512-517`） |

### 10.6 環境與工具鏈（Windows）

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 44 | **PowerShell 5.1 不支援三元運算子與 `\|\|`** | 語法錯誤 | 這個環境是 **PowerShell 5.1**：不支援 `? :`、不支援 `\|\|`；用 `if/else` 與 `-or`（GUIDE §10.3） |
| 45 | **含 `[` `]` 的路徑被當萬用字元** | `Get-Content spa\functions\api\users\[id].ts` 找不到檔案或行為怪異 | 用 **`-LiteralPath`**：`Get-Content -LiteralPath '...\users\[id].ts'`。`Test-Path`/`Get-ChildItem` 同理 |
| 46 | **`wrangler.cmd` shim 問題** | `node_modules\.bin\wrangler.cmd` 在 Windows 上傳參會出錯（**連 `--version` 都失敗**） | 直接呼叫 `node node_modules\wrangler\wrangler-dist\cli.js`（GUIDE §8.2） |
| 47 | **PowerShell 輸出中文亂碼** | 工具輸出變問號 | 設 `$env:PYTHONIOENCODING = "utf-8"`；`greeny_check.py:45-48` 也有 `sys.stdout.reconfigure(encoding="utf-8")` |
| 48 | **部署 token 權限不足** | 部署回 403 `Authentication error` | 永久 token 沒有 Pages:Write / Workers Scripts:Write，需臨時建一顆並**用完刪除**（GUIDE §8.3） |
| 49 | **`git push` 不會部署 Pages** | 改了程式碼但線上沒變 | 必須手動 `wrangler pages deploy dist --project-name=greeny --branch=main` |
| 50 | **憑證檔必須 gitignored** | 裝置 token 曾一度寫進要提交的韌體原始碼 | `.gitignore:7-8` 排除 `device_secrets.h`/`device_secrets.py`。**新增憑證檔時同步更新 `.gitignore`** |

### 10.7 已刪除的檔案（不要再引入）

`edge/src/index.mjs`：舊的 esbuild 打包產物被提交進 repo，內容包含**有漏洞的登入查詢
（`SELECT … salt`）與無認證的 WebSocket 升級區塊**。而 `edge/EDGE.md:189-206` 的舊部署
指示正是教人上傳它。部署請一律用 `wrangler deploy`（bundle `src/index.ts`）。
⚠️ `edge/EDGE.md` 的部署章節仍描述這個已刪除的流程（含把 token 放進 curl 的範例），
閱讀時請忽略該節，以 `docs/GUIDE.md` §8.2 為準。

### 10.8 測試工具相關

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 51 | **用真 `device_id` 測裝置 WS** | DO 只允許一個 esp32 連線 → **踢掉線上裝置**並**清空其 relay_queue** | 用 `<device-id>-probe`（`greeny_check.py:184` 的預設值）；要測真裝置必須明確加 `--device-ws-id` |
| 52 | **`--write-test` 會寫入真實資料** | 在 `telemetry`/`devices` 留下測試列 | 預設不寫入；用了之後照工具印出的 `DELETE` 指令清理 |
| 53 | **`toggle-led.mjs` 用的是 `esp32-01`** | 不是 `esp32-sensor`（待確認是刻意隔離還是筆誤） | 使用前確認 WS_URL 指向預期的裝置（`toggle-led.mjs:14`） |
| 54 | **`toggle-led.mjs` 需要 `GREENY_TOKEN`** | 沒設定會直接 `process.exit(1)` | 先登入取得 JWT 再設環境變數（`toggle-led.mjs:12-13`） |

### 10.9 資料庫

| # | 陷阱 | 症狀 | 正確做法 |
|---|---|---|---|
| 55 | **`devices` 有 `id` 與 `device_id` 兩個欄位** | Worker 的 alarm 用 `WHERE device_id = ?`，Pages 用 `WHERE d.id = ?` | 寫新查詢前先確認要用哪一個（§8.2） |
| 56 | **`telemetry` 有 `temp` 與 `water_temp`** | Worker/DO 寫 `temp`，Pages 寫 `water_temp` | 前端 `normalizeReading()` 處理；新查詢要涵蓋兩個欄位 |
| 57 | **`alerts` 有 `type` 與 `alert_type`** | 同上模式 | 前端用 `a.alert_type \|\| a.type` |
| 58 | **`relay_queue`/`relay_log` 同名不同表** | DO-local SQLite 的 `relay_queue` 與 D1 的 `relay_queue` 是**不同的表** | 改動前確認自己在改哪一層 |
| 59 | **`edge/db/schema.sql` 已過期** | 它寫著 `users.salt TEXT NOT NULL`，但線上沒有這欄 | **不要拿它重建資料庫**；以線上實際結構與 `spa/src/types/index.ts` 為準 |
| 60 | **`sqlite_sequence`/`_cf_KV` 是系統表** | 誤刪會造成 AUTOINCREMENT 異常或 D1 metadata 損壞 | 不要動 |

---

## 附錄：撰寫依據與待確認清單

**實際閱讀的檔案**（行號引用以此版本為準）：

```
edge/src/{index,device-hub,agent,auth}.ts  edge/wrangler.jsonc  edge/EDGE.md  edge/db/schema.sql
spa/functions/api/_middleware.ts  spa/functions/_lib/{jwt,password,types}.ts
spa/functions/api/telemetry.ts  spa/functions/api/auth/{login,me}.ts
spa/functions/api/users/{index,[id]}.ts  spa/functions/api/offices/{index,[id]}.ts
spa/functions/api/racks/{index,[id]}.ts  spa/functions/api/relay.ts
spa/functions/api/wb/_middleware.ts  spa/wrangler.toml  spa/vite.config.ts
spa/src/lib/api.ts  spa/src/hooks/{useWebSocket,useAuth,useSensorData,useRacks}.ts
spa/src/App.tsx  spa/src/types/index.ts
firmware/esp32/esp32.ino  firmware/greeny2_sensor/greeny2_sensor.ino
firmware/esp32-micropython/main.py  firmware/esp32-micropython/README.md  firmware/FIRMWARE.md
tools/{greeny_check,greeny_probe}.py  tools/toggle-led.mjs
docs/{API,GUIDE}.md  ARCHITECTURE.md  PROTOCOL.md  .gitignore
```

**標記「（待確認）」的項目**（15 處）：

1. Worker 登入未檢查 `active`、Pages 有——是否對齊（§3.1、§10.1 #6）
2. `evaluateAlerts()` 未讀 `settings` 閾值——是否已知問題（§3.2、§8.3、§10.4 #26）
3. DO 看門狗只偵測「完全沒有遙測」而非「遙測停了」（§3.2）
4. `device_status: offline` 廣播的 `device_id` 硬編碼（§3.2、§10.4 #23）
5. `alarm()` flush 未用 transaction——是否刻意接受 at-least-once（§3.2）
6. DO-local SQLite 的 `flushed = 0` 列無上限——是否有成長上限（§3.2）
7. `MODEL_REASON` 宣告未使用——預留或遺漏（§3.3）
8. `TOOLS`（OpenAI 格式）未使用——是否移除或補上使用（§3.3）
9. GreenyAgent 送的 `{"type":"ph","slope","offset"}` 韌體無對應分支（§3.3）
10. `useAlerts().acknowledge()` 打的 `PATCH /api/alerts/:id` 在 Worker 不存在（§5.4、§10.3 #17）
11. `mgmtApiFetch` 缺 `/api` 前綴的多處呼叫——是否有 SPA fallback 掩蓋症狀（§5.1、§10.3 #15）
12. `spa/functions/api/users/[id].ts` 為何不用 `c.params.id`（§4.4、§10.3 #14）
13. Captive Portal 相關函式未被 `setup()` 呼叫（§6.1）
14. `esp32.ino:897-902` 強制覆蓋校正值——暫時手段或預期行為（§6.1、§10.5 #30）
15. `toggle-led.mjs:14` 用 `esp32-01` 而非 `esp32-sensor`（§7.3、§10.8 #53）

**三項結構性待確認**（無法從 repo 內檔案確定）：

- **D1 線上實際 schema**：本文件的表結構是從程式碼中的 SQL 反推。
  `edge/db/schema.sql` 已過期，且環境中沒有可用的 D1 唯讀憑證直接匯出 `sqlite_master`
  （Cloudflare API 回 `Authentication error`）。`crop_batches`/`harvest_logs`/
  `rack_vegetables`/`rack_environment` 的完整欄位定義只能從 `spa/src/types/index.ts` 推斷。
- **`settings` 表的 22 個 key**：程式碼只讀 7 個，其餘 15 個用途不明（§8.3）。
- **`tasks`/`personnel`/`filters`/`notifications` 四張表**：有對應端點但不在 GUIDE 的
  16 張表清單中（§8.1）。

---

**維護提醒**：改動架構、端點、認證或資料模型時，請同步更新本文件與
[`docs/API.md`](./API.md)。引用行號若已位移，請以**函式名稱**搜尋取代。
