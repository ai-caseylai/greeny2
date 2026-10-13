# CODE-EXPLAINED 精簡版（結論與定位）

> 本檔是 [`docs/CODE-EXPLAINED.md`](./CODE-EXPLAINED.md)（2015 行，完整版說明「為什麼」與程式碼片段）的**精簡版**：只保留每個模組的一句話結論、設計取捨、陷阱清單、資料模型與待確認編號。**行號一律沿用完整版的引用**（LF 版本），若已位移請以**函式名稱**搜尋。
> 本檔不含任何憑證，只寫存放位置（`edge/src/index.ts` 讀 D1 `settings`；韌體憑證檔 `device_secrets.h` / `device_secrets.py` 由 `.gitignore:7-8` 排除；工具憑證走環境變數）。

## 我要找什麼 → 看哪裡

| 想知道 | 看哪份 |
|---|---|
| 端點 request/response、WS 訊息格式、裝置協定 | [`docs/API.md`](./API.md) |
| 系統總覽、權限、部署、SOP、疑難排解 | [`docs/GUIDE.md`](./GUIDE.md) |
| 程式碼怎麼跑、為什麼這樣寫、哪裡容易改壞 | [`docs/CODE-EXPLAINED.md`](./CODE-EXPLAINED.md) |
| 只要結論、陷阱速查、資料模型 | **本檔** |
| 架構鳥瞰 / 裝置協定 / 燒錄與校正 | `ARCHITECTURE.md` / `PROTOCOL.md` / `firmware/FIRMWARE.md` |

⚠️ `edge/EDGE.md` 與根目錄 `PROTOCOL.md` 是早期設計文件，與現工程式碼有落差（`EDGE.md:189-206` 仍教人上傳已刪除的 `src/index.mjs`）；以本檔、完整版與 `edge/src/*.ts` 為準。

## 1. 元件定位

| 元件 | 目錄 | 角色 |
|---|---|---|
| Worker `iot-hub` | `edge/` | 裝置 WS 入口、即時 REST API、兩個 Durable Object（`DeviceHub`、`GreenyAgent`） |
| Pages 專案 `greeny` | `spa/` | React SPA ＋ Pages Functions 管理 API |
| D1 `greeny-db` | — | 兩邊共用的持久層 |
| 韌體 | `firmware/` | Arduino 完整版／精簡版、MicroPython |

## 2. 資料流（三條）

| 方向 | 路徑 | 關鍵位置 |
|---|---|---|
| 遙測上行 | ESP32 `sendTelemetry()` → Worker `fetch()`（`/device/` 免 header 認證、WS 分支、比對 `?token=`）→ `DeviceHub`（accept、`serializeAttachment`、清 `relay_queue`、送 `sync`）→ 每 10 秒 `webSocketMessage()`→`handleTelemetry()`（同步 SQL、警報去重、drain、broadcast）→ 每 60 秒 `alarm()` 批次寫 D1 | `firmware/esp32/esp32.ino:729`、`edge/src/index.ts:503`、`:575`、`:42`、`:587`、`edge/src/device-hub.ts:113`、`:244`、`:292`、`:328`、`:531` |
| 指令下行 | SPA `toggleLed()` 先 REST `/api/relay`、失敗才 WS → `handleRelay()` → DO `/relay-cmd`（寫 `relay_queue`＋log）→ ESP32 `webSocketEvent()` → `ack` → `handleAck()` | `spa/src/hooks/useWebSocket.ts:107`、`:112`、`:127`、`edge/src/index.ts:736`、`edge/src/device-hub.ts:117`、`firmware/esp32/esp32.ino:472`、`edge/src/device-hub.ts:400` |
| 管理 CRUD | SPA `mgmtApiFetch()` → 同源 Pages Functions（檔案即路由） → `api/_middleware.ts` 驗 JWT → `c.data.user` → D1 | `spa/src/lib/api.ts:45`、`spa/functions/api/_middleware.ts:10` |

AI agent 走路徑與指令下行相同，只換入口：`POST /api/chat` → `handleChat()` → `GreenyAgent` → DeviceHub `/relay-cmd`（`edge/src/index.ts:723`、`edge/src/agent.ts:1047`）。`apiFetch()` 與 `mgmtApiFetch()` 打**兩台不同伺服器**，但共用同一把 JWT 密鑰（都讀 D1 `settings.jwt_secret`），所以 token 兩邊都通。

## 3. 每個模組的一句話結論

| 模組 | 一句話 | 位置 |
|---|---|---|
| Worker 路由 | 「預設要認證」的 fail-closed 閘門：沒明確放行的端點自動要求 JWT（`needsAuth()` 精確比對 `METHOD:path`，不用前綴） | `edge/src/index.ts:54-66`、`:503-604` |
| Worker 認證 | 密鑰放 D1 並在 isolate 內快取；**沒有「密鑰缺失就用預設值」的後路**（回 `""` → 401） | `edge/src/index.ts:24-33`、`:76-79` |
| Worker WS 閘門 | 認證在 Worker 層完成（不消耗 DO 喚醒成本），人用 JWT、機器用 device token，憑證走 `?token=`（雙方都無法設 header） | `edge/src/index.ts:574-601` |
| Worker REST | 全部很薄，Worker 保持無狀態，狀態都在 DO（`handleChat`/`handleRelay` 只做轉發）；`limit` 用 `Math.min` 夾住 | `edge/src/index.ts:609`、`:652`、`:723`、`:736` |
| `handleLogin()` | 只 SELECT 存在的欄位（**`users` 沒有 `salt`**），帳號不存在與密碼錯誤回同一個 401；⚠️ 未檢查 `active` | `edge/src/index.ts:619-635` |
| `DASHBOARD_HTML` | Phase 1 的內建登入＋儀表板，`GET /` 免認證；現在的主要價值是**不用部署 SPA 就能測 WS** | `edge/src/index.ts:84-477` |
| `DeviceHub` DO | 四條不可協商規則：只用 `acceptWebSocket()`、`webSocketMessage()` **零 `await`**、constructor 不讀 storage、D1 只在 `alarm()` 碰 | `edge/src/device-hub.ts:7-12` |
| DeviceHub 角色判定 | 用「路徑含 `dashboard`」決定角色，其餘一律當裝置（很寬鬆，安全性靠 Worker 閘門） | `edge/src/device-hub.ts:246` |
| DeviceHub 三種指令 | `set_led` 持久佇列（at-least-once）、`calibrate` QoS 0 不排隊（綁定當下物理狀態）、未知指令**原封轉發**（新增裝置指令不用改雲端，驗證責任推給裝置） | `edge/src/device-hub.ts:433-484` |
| DeviceHub `alarm()` | try/catch/finally 三明治：單列失敗不 rethrow、外層 catch、**finally 一定重排**（否則連續失敗 6 次會永久停用 alarm）；批次 flush 靠 `flushed` 旗標＋清理（否則 rows-read 配額爆炸） | `edge/src/device-hub.ts:531-642` |
| DeviceHub 看門狗 | 只偵測「連上後完全沒收到遙測」→ 強制重連；補的是 **DO→ESP32 方向**壞掉的半開連線 | `edge/src/device-hub.ts:534-543` |
| `broadcast()` | 只序列化一次、送失敗就從 Map 移除（自我修復，不依賴 close 事件） | `edge/src/device-hub.ts:695-700` |
| `GreenyAgent` DO | 「有狀態的對話與校正流程引擎，語言模型只是其中一個零件」；`idFromName("greeny")` 固定單一實例 | `edge/src/index.ts:725`、`edge/src/agent.ts:266-311` |
| Agent pre-fetch | 小模型不會 tool calling → 先用 regex 猜意圖、平行抓真實資料塞進 prompt，避免幻覺讀數；DO-to-DO 內部呼叫不計費是設計成立前提 | `edge/src/agent.ts:466-528`、`:636-691`、`:1017` |
| Agent 校正狀態機 | 跨對話回合、跨 DO 重啟的多步驟流程（`calibration_sessions`），可關掉瀏覽器隔天再回來 | `edge/src/agent.ts:192`、`:728`、`:872-974` |
| `auth.ts` | 手刻 JWT/PBKDF2、零 npm 依賴；**先驗簽章再解析 payload**；自描述 `pbkdf2:<iters>:<salt>:<hash>` 讓同一列密碼在 Worker 與 Pages 都能驗 | `edge/src/auth.ts:31-55`、`:59-105`、`:109-115`、`:155-166` |
| Pages middleware | 只有 4 個白名單放行；登入端點用**精確比對**（前綴寫法會造成真實 500）；密鑰 missing 回 500 不是預設值 | `spa/functions/api/_middleware.ts:14-47` |
| Pages `_lib/*` | 是 Worker 版的**複製**不是共用模組（改動必須同步兩邊）；`password.ts` 是 `$2` 認證繞過的歷史現場，註解就是防線 | `spa/functions/_lib/jwt.ts:3-16`、`spa/functions/_lib/password.ts:23-33` |
| Pages `telemetry.ts` | POST 同時接受 device token 或 JWT（裝置的 HTTPS 備援＋工具補資料）；`expected &&` 讓「沒設定 token」不會意外放行，比 Worker 的 WS 嚴格 | `spa/functions/api/telemetry.ts:18-46` |
| Pages `users/*` | 三層角色；`office_admin` 的權限用**改寫輸入**（靜默降成 `staff`）而非拒絕請求；DELETE 是軟刪除（`active = 0`） | `spa/functions/api/users/index.ts:9-12`、`[id].ts:25-53` |
| SPA `lib/api.ts` | 兩套 fetch 只差一行（絕對 Worker 網址 vs 同源）；**不統一是歷史結果不是設計**；`API_BASE` 硬編碼在三處；401 統一 `clearToken()`＋跳登入 | `spa/src/lib/api.ts:1`、`:26-56`、`spa/src/hooks/useWebSocket.ts:27,109` |
| SPA `useWebSocket.ts` | token 走 query（`encodeURIComponent` 不可省）；30 秒應用層 `ping` 同時保活、測 RTT 並**加速 DO drain 指令**；固定 5 秒重連無退避 | `spa/src/hooks/useWebSocket.ts:24-27`、`:34-39`、`:74-83` |
| SPA `useAuth.ts` | 初值從 `sessionStorage` 還原（避免閃爍），`sessionStorage` 讓關分頁即登出（共用終端合理）；登入打 **Worker** 端點 → 停用帳號仍可登入 | `spa/src/hooks/useAuth.ts:6-41` |
| SPA `useSensorData.ts` | 存在唯一理由是**後端格式不統一**；`normalizeReading()` 吃掉 HTTP/WS 兩種扁平格式與 `temp`/`water_temp`、`led` bool/int | `spa/src/hooks/useSensorData.ts:37-68` |
| SPA `useRacks.ts` | 管理 CRUD hook：沒有樂觀更新也沒有快取，每次寫入後重拉全部 → 多一趟往返換「前端狀態永遠等於後端」；空 catch 讓 403/500 使用者看不到 | `spa/src/hooks/useRacks.ts:22-34`、`:98-134` |
| SPA 路由 | `ProtectedRoute` 包整個 `DashboardLayout`（不是每頁各包），側邊欄只在 `/login` 不出現；`SettingsPage` 用 WS 送 WiFi 指令，走 DO 泛用轉發 | `spa/src/App.tsx:15-51`、`spa/src/pages/SettingsPage.tsx:145-151` |
| 韌體完整版 | 功能最完整（OLED、Captive Portal 未呼叫、序列埠校正實為死碼）；⚠️ `setup()` 每次開機覆蓋校正值、NTP 迴圈無 timeout | `firmware/esp32/esp32.ino:888-942`、`:897-902`、`:101` |
| 韌體精簡版 | 同協定、只留必要邏輯；修掉完整版的兩個易錯點（NTP timeout、不印 token）但**校正只回報不儲存**，且 EC/pH 公式符號與完整版相反 | `firmware/greeny2_sensor/greeny2_sensor.ino:1-61`、`:151`、`:405`、`:274-302` |
| 韌體 MicroPython | 自行實作 RFC 6455（120 行）避開套件版本地獄；⚠️ `TLS_VERIFY = False`（加密但不驗身分）是明示決定；主迴圈用例外做控制流 | `firmware/esp32-micropython/main.py:78-204`、`:52-56`、`:479-536` |
| 工具 `greeny_check.py` | 22 項端到端檢查、**預設唯讀**，`critical` 旗標決定 exit code → 同時是報表與監控探針；每個正向測試配一個負向測試 | `tools/greeny_check.py:58-135`、`:325` |
| 工具 `greeny_probe.py` | 更早的唯讀探針，價值在**認證繞過探針**：用故意錯誤的密碼登入，拿到 token 就繼續拿它讀管理 API 證明衝擊範圍 | `tools/greeny_probe.py:33-34`、`:126-131` |
| 工具 `toggle-led.mjs` | 用真實負載量 RTT 分佈並畫 ASCII 直方圖（無繪圖依賴、可貼上）；憑證只從環境變數讀 | `tools/toggle-led.mjs:12-14`、`:181-187`、`:25-113` |

## 4. 關鍵設計取捨（決策 → 理由 → 代價）

| # | 決策 | 理由 | 代價 |
|---|---|---|---|
| 1 | 裝置只走 WSS（無 HTTPS 輪詢、無 MQTT） | 一條連線同時承載上下行；ESP32 TLS 握手成本高，長連線免重複握手；不需 broker 基礎設施 | 斷線即完全失聯（靠兩端看門狗 30 秒內自癒）；狀態在 DO 記憶體，被驅逐要靠 attachment 還原；`POST /api/telemetry` 備援實際未用 |
| 2 | DO 熱路徑零 `await` | `webSocketMessage()` 成原子操作，不被其他事件插入、不被 D1 延遲堵住、避免競態 | 熱路徑只能用同步 API；非同步工作全推到 `alarm()`，最長延遲 60 秒 |
| 3 | D1 與 DO-local SQLite 兩層 | 每 10 秒直接寫 D1 會吃掉 rows-written/read 配額；DO-local 寫入微秒級且同 colo | 兩層之間是 at-least-once（極端情況 D1 有重複列）；需 `flushed` 旗標與清理邏輯；DO 被完全重設時未 flush 資料消失 |
| 4 | 指令分兩種可靠性（`set_led` 佇列 / `calibrate` QoS 0） | `set_led` 幂等無狀態，重放無害；`calibrate` 綁定當下物理狀態（探頭在緩衝液裡），補送會寫入錯誤校正值 | 使用者要理解「為何校正有時沒反應」；同一套 API 兩種語意需文件；佇列在裝置重連時被清空（跨重啟不保證） |
| 5 | JWT 密鑰放 D1 `settings` | 兩邊需同一把、D1 是唯一共用儲存；公開 repo 任何提交的預設值都是公開密鑰；輪換只需一個 UPDATE | 每次冷啟動多一次 D1 讀取；**任何能寫 `settings` 的人都能偽造 JWT**；兩邊對「密鑰缺失」處理不同（401 vs 500） |
| 6 | WS 憑證走 query 參數 | 瀏覽器 `WebSocket` 與 ESP32 `WebSocketsClient` 都無法設 `Authorization` header，query 是唯一共同通道 | token 進 access log／proxy log／瀏覽器歷史；不能用 `HttpOnly` cookie 保護；換 token 必須重建連線 |
| 7 | PBKDF2 單一自描述格式 | 同一筆 `users` 在兩邊都能驗；迭代次數存在字串裡可逐步提高；salt 內嵌故不需要 `salt` 欄位 | 舊 bcrypt 資料完全無法驗證，必須一次性遷移（期間要改密碼）；兩邊實作是複製的，必須手動同步 |
| 8 | Pages 不接 GitHub 自動部署（`source: null`） | 部署完全由 `wrangler pages deploy` 控制，沒有 CI 做未預期建置，可精確控制哪個 commit 上 production | **`git push` 不會部署**；沒有建置檢查，壞掉的程式碼可推到 `main` |
| 9 | AI agent 用 pre-fetch 而非純 tool calling | 便宜小模型不會 tool calling，直接問會幻覺出感測器數值；regex 判斷意圖＋先抓真實資料成本近零 | regex 意圖會漏（如「我的羅勒還好嗎」）；需維護 prompt 樣板與關鍵字清單；兩條路徑回答風格可能不一致 |
| 10 | WebSocket 認證在 Worker 層攔截、不進 DO | 未通過認證者完全不消耗 DO 喚醒成本；DO 不需重複驗證邏輯；攻擊者無法用 WS 讓 DO 產生費用 | Worker 需知道兩種憑證細節、職責變重；DO 無法區分「未認證」與「未連線」 |
| 11 | `GET /api/relay` 刻意免認證 | 讓裝置用最簡單方式輪詢指令（不需 JWT/device token），是舊 Casey 協定相容路徑 | 任何人可讀取待處理的繼電器指令（GUIDE §5.4 列為已知殘留風險） |
| 12 | `device_token` 未設定時裝置通道開放（只印警告） | 機隊可逐步遷移（先部署程式碼再逐台燒 token），不會一次全斷線 | **安全開關放在資料庫**：能寫 `settings` 的人可關閉裝置認證；模組層級快取使設定變更要等 isolate 回收才生效 |
| 13 | **不做**裝置 ID 的動態設定（`device_id` 硬編碼在韌體） | NVS/flash 設定檔會增加複雜度，而目前只有一台 | 新增裝置是「編譯＋燒錄」等級的操作；`esp32.ino:25`、`greeny2_sensor.ino:86` |
| 14 | **不做**告警升級（warning → critical） | 型別允許 `critical`、UI 也有樣式，但沒有規則會產生它 | 無法區分「剛超標」與「超標三小時」；`edge/src/device-hub.ts:28`、`edge/src/index.ts:342` |

## 5. 陷阱清單（陷阱 → 一句話 → 檔案:行號）

| # | 分類 | 陷阱 | 一句話（症狀／正確做法） | 位置 |
|---|---|---|---|---|
| 1 | 認證 | `/api/auth/` 前綴放行 | 放行 `/api/auth/me` → `context.data.user` 是 `undefined` → `user.sub` TypeError → 500；改精確比對 `path === '/api/auth/login'` | `spa/functions/api/_middleware.ts:17` |
| 2 | 認證 | `$2` bcrypt 短路 | `if (storedHash.startsWith('$2')) return true;` → 任何密碼都能登入；非 `pbkdf2:` 一律 `return false` | `spa/functions/_lib/password.ts:33`、`edge/src/auth.ts:166` |
| 3 | 認證 | SELECT 不存在的欄位 | Worker 登入 `SELECT ... salt` 但 `greeny-db` 沒這欄 → 查詢失敗 → 登入 500；salt 內嵌在 `password_hash` | `edge/src/index.ts:622` |
| 4 | 認證 | `needsAuth()` 是 fail-closed 閘門 | 新端點沒加白名單 → **自動要求 JWT**（不是自動開放）；正確行為，但新增公開端點必須加進 `AUTH_WHITELIST` | `edge/src/index.ts:54-66` |
| 5 | 認證 | 新 WS 路徑被當成 esp32 | `pathname.includes("dashboard")` 判角色 → 新路徑被當裝置並**踢掉現有裝置連線**；新增 WS 路徑必須同步改 | `edge/src/device-hub.ts:246` |
| 6 | 認證 | 登入的 `active` 檢查兩邊不一致 | Worker 不檢查、Pages 檢查 → 被停用帳號在 SPA 仍可登入 | `edge/src/index.ts:622` vs `spa/functions/api/auth/login.ts:18` |
| 7 | 認證 | `device_token` 未設定＝完全開放 | D1 沒有該 key 時裝置 WS 只印警告不拒絕；部署後確認 `settings.device_token` 存在 | `edge/src/index.ts:587-589` |
| 8 | 認證 | 兩個 secret 快取語意不同 | `getJWTSecret` 用 truthy、`getDeviceToken` 用 `!== null` → 密鑰缺失時 Worker 每請求都查 D1 | `edge/src/index.ts:27,43` |
| 9 | 訊息 | **`params` 包裝** | 雲端→裝置的參數一律包在 `params`：`{"command":"set_led","params":{"state":true}}`；寫錯時 LED 沒反應但遙測正常，極難查（API.md A.7） | `edge/src/device-hub.ts:452-454` |
| 10 | 訊息 | 韌體讀錯層級 | 應讀 `doc["params"]["state"]`；誤寫 `doc["state"]` 會永遠讀到 false；MicroPython 版同時容忍兩種 | `firmware/esp32/esp32.ino:486,487`、`firmware/greeny2_sensor/greeny2_sensor.ino:326`、`firmware/esp32-micropython/main.py:417,418` |
| 11 | 訊息 | `greeny_check.py` 狀態碼撈取是啟發式 | 例外訊息含 `500` 時可能誤判 HTTP 狀態；可接受 | `tools/greeny_check.py:111-132` |
| 12 | 訊息 | 警報訊息混雜簡繁 | DO 產生簡體（`过低`/`阈值`）、Pages 繁體；前端有轉換層，新增訊息注意用語 | `edge/src/device-hub.ts:434-438`、`spa/functions/api/telemetry.ts:99` |
| 13 | Pages | 相對匯入層數 | `api/x.ts` → `../_lib/`；`api/auth/x.ts` → `../../_lib/`；`api/wb/_middleware.ts` → `../../../_lib/`；錯 → `BuildFailure` | `spa/functions/api/_middleware.ts:1-2` |
| 14 | Pages | `c.params` 的兩種用法 | `offices/[id].ts:6` 用 `c.params.id`，`users/[id].ts:14` 自己切 pathname（尾斜線時 `pop()` 拿到空字串）；優先用官方 API | `spa/functions/api/offices/[id].ts:6`、`spa/functions/api/users/[id].ts:14` |
| 15 | Pages | `mgmtApiFetch` 不補 `/api` 前綴 | 傳 `'/crop-batches'` → 打同源 `/crop-batches` → 404（應為 `/api/crop-batches`）；目前是多處真實缺陷 | `spa/src/pages/CropManagementPage.tsx:88,175,527,541`、`spa/src/pages/UserManagementPage.tsx:62,179,197,206` |
| 16 | Pages | 兩套 fetch 打不同伺服器 | `apiFetch` 打 Worker（跨域）、`mgmtApiFetch` 打同源 Pages，用錯會 404 | `spa/src/lib/api.ts:1,45` |
| 17 | Pages | `useAlerts().acknowledge()` 打不存在的端點 | 呼叫 `PATCH /api/alerts/${id}`，但 Worker 只有 `POST /api/alerts/ack` → 落到 404 純文字 | `spa/src/hooks/useSensorData.ts:117-123`、`edge/src/index.ts:556` |
| 18 | Pages | middleware 白名單與端點路徑耦合 | 搬動端點路徑忘了改白名單 → 新端點落到需 JWT 的預設路徑，裝置反而不能用 | `spa/functions/api/_middleware.ts:14-47` |
| 19 | DO | 在 `webSocketMessage()` 加 `await` | 熱路徑被堵住、訊息延遲、可能競態；持久化用同步 `ctx.storage.sql.exec()`，非同步推到 `alarm()` | `edge/src/device-hub.ts:7-12` |
| 20 | DO | constructor 加 `await` 或 `blockConcurrencyWhile` | constructor 不能 async，`blockConcurrencyWhile` 拉高喚醒延遲；只用同步 API＋`deserializeAttachment()` | `edge/src/device-hub.ts:97-104` |
| 21 | DO | `alarm()` 忘記重新排程 | 連續失敗 6 次後 alarm **永久停止**，之後不再 flush；`finally { setAlarm }` 不可協商 | `edge/src/device-hub.ts:637-641` |
| 22 | DO | `alarm()` 逐列 try/catch 被移除 | 單列失敗導致整個 alarm 拋錯、加速消耗重試次數；內層 try 包每列 | `edge/src/device-hub.ts:551-560` |
| 23 | DO | 廣播的 `device_id` 硬編碼 | `device_status: offline` 寫死 `"esp32-sensor"` → 多裝置時報錯裝置；應從 attachment 取 | `edge/src/device-hub.ts:542` |
| 24 | DO | flush 不是原子操作 | 「先 INSERT 全部、再 UPDATE `flushed=1`」中間 crash → D1 重複列；目前接受 at-least-once | `edge/src/device-hub.ts:494-498` |
| 25 | DO | `relay_queue` 在裝置重連時被清空 | 離線期間排隊的 `set_led` 會遺失；這是刻意的（避免重放校正指令），**不要順手修掉** | `edge/src/device-hub.ts:259-261` |
| 26 | DO | `evaluateAlerts()` 用硬編碼閾值 | 改 `settings` 的 `ph_min` 等**不會改變警報行為**；閾值類 key 目前只有前端在用 | `edge/src/device-hub.ts:488-504` |
| 27 | 韌體 | NTP 必須在 WSS 之前 | 無電池 RTC → 時鐘是 1970 → 憑證被判「尚未生效」→ 握手失敗；須等 `time(nullptr) > 8*3600*2` | `firmware/esp32/esp32.ino:96-113`、`:101` |
| 28 | 韌體 | `beginSslWithBundle(..., NULL, 0, "")` 三參數不能省 | `NULL, 0, ""` = 用 ESP32 內建 CA bundle（完整驗證）；Core ≥ 3.0.4 多一個參數 | `firmware/esp32/esp32.ino:935-939` |
| 29 | 韌體 | ADC 只能用 ADC1（GPIO 32–39） | 用 ADC2 腳位在 WiFi 開啟時讀不到值；TDS = GPIO 35/36、pH = GPIO 39，新增感測器要確認腳位 | `firmware/esp32/esp32.ino`（ADC 讀取） |
| 30 | 韌體 | `setup()` 裡的「強制校正值」 | 每次開機覆蓋 `tdsKValue`/`ecOffset` 並寫回 EEPROM → **所有 WSS 校正指令重開機後失效**；要持久化必須移除那 5 行 | `firmware/esp32/esp32.ino:897-902` |
| 31 | 韌體 | 序列埠校正實際不可用 | CH340 一開序列埠就拉 RTS/DTR 重置 ESP32 → `handleSerialCalibration()` 是死碼；校正一律走 WSS | `firmware/esp32/esp32.ino:305-449`、`:553-714` |
| 32 | 韌體 | `wifi_set` 一定要非阻塞＋待送 ack | 切換必然斷線；事件處理器內等結果會凍結 WS，立刻送 ack 送不出去 → 存 `wifiPendingAckJson` 等 `WStype_CONNECTED` 補送 | `firmware/esp32/esp32.ino:950`、`:464-469` |
| 33 | 韌體 | `wifiReconnecting` 期間要抑制自動重連 | 否則 `wifiEvent()` 用**舊** SSID 立刻重連，覆蓋使用者的切換 | `firmware/esp32/esp32.ino:245-250` |
| 34 | 韌體 | 兩個 Arduino 版的 EC/pH 公式符號相反 | 完整版 inverted 板、精簡版標準；**校正參數不能互抄** | `firmware/esp32/esp32.ino:141,148`、`firmware/greeny2_sensor/greeny2_sensor.ino:173,184` |
| 35 | 韌體 | 校正常數運算順序 | DFRobot：**先扣 offset，再做溫度補償**，順序不可交換 | `firmware/greeny2_sensor/greeny2_sensor.ino:173,177` |
| 36 | 韌體 | `loadCalibration()` 的 saved-pattern | `EEPROM.get()` **直接覆寫**變數，不先備份就沒預設值可還原 | `firmware/esp32/esp32.ino:275-303` |
| 37 | 韌體 | 完整版 NTP 迴圈沒有 timeout | NTP 被封鎖（企業網路擋 UDP 123）時裝置**永遠卡在 `setup()`**；精簡版與 MicroPython 版有 timeout | `firmware/esp32/esp32.ino:101` |
| 38 | 韌體 | 完整版把 token 印到序列埠 | 印出完整 path（含 `?token=`）→ log 裡有憑證；精簡版已改 `token=***` | `firmware/esp32/esp32.ino:934`、`firmware/greeny2_sensor/greeny2_sensor.ino:405` |
| 39 | 韌體 | `read_uv()` 是新版 MicroPython 才有 | 舊固件只有 `read()`；fallback 用 `4095.0`（Arduino 用 `4096.0`） | `firmware/esp32-micropython/main.py:234-238` |
| 40 | 韌體 | MicroPython 的 `b2a_base64` 會加換行 | `Sec-WebSocket-Key` 帶 `\n` → 握手失敗；`.strip()` 移除 | `firmware/esp32-micropython/main.py:78-81` |
| 41 | 韌體 | WebSocket client 必須 mask | 未 mask 的 client frame 會被合規 server 立刻斷線（RFC 6455 §5.1）；`0x80 \| n` 的 `0x80` 就是 MASK bit | `firmware/esp32-micropython/main.py:149` |
| 42 | 韌體 | `time.ticks_ms()` 不能換成 `time.time()` | MicroPython ticks 系列處理計時器溢位；用 `time.ticks_diff()` | `firmware/esp32-micropython/main.py:502-508` |
| 43 | 韌體 | `is False` vs `== False` | `recv_text()` 用 `False`＝連線關閉、`None`＝timeout、`""`＝空訊息；寫 `== False` 會把空字串當關閉 | `firmware/esp32-micropython/main.py:512-517` |
| 44 | 環境 | PowerShell 5.1 不支援三元運算子與 `\|\|` | 語法錯誤；用 `if/else` 與 `-or`（GUIDE §10.3） | `docs/GUIDE.md` §10.3 |
| 45 | 環境 | 含 `[` `]` 的路徑被當萬用字元 | `Get-Content ...\users\[id].ts` 找不到檔案；用 `-LiteralPath`（`Test-Path`/`Get-ChildItem` 同理） | `spa/functions/api/users/[id].ts` |
| 46 | 環境 | `wrangler.cmd` shim 問題 | Windows 上傳參出錯（連 `--version` 都失敗）；直接跑 `node node_modules\wrangler\wrangler-dist\cli.js` | `docs/GUIDE.md` §8.2 |
| 47 | 環境 | PowerShell 輸出中文亂碼 | 設 `$env:PYTHONIOENCODING = "utf-8"`；工具內也有 `reconfigure(encoding="utf-8")` | `tools/greeny_check.py:45-48` |
| 48 | 環境 | 部署 token 權限不足 | 回 403 `Authentication error`；永久 token 缺 Pages:Write／Workers Scripts:Write，需臨時建一顆用完刪除 | `docs/GUIDE.md` §8.3 |
| 49 | 環境 | `git push` 不會部署 Pages | 改了程式碼線上沒變；必須手動 `wrangler pages deploy dist --project-name=greeny --branch=main` | `docs/GUIDE.md` §8.2 |
| 50 | 環境 | 憑證檔必須 gitignored | 裝置 token 曾一度寫進要提交的韌體原始碼；新增憑證檔要同步更新 `.gitignore` | `.gitignore:7-8` |
| 51 | 工具 | 用真 `device_id` 測裝置 WS | DO 只允許一個 esp32 連線 → **踢掉線上裝置**並清空其 `relay_queue`；用 `<device-id>-probe` | `tools/greeny_check.py:184`、`edge/src/device-hub.ts:255-268` |
| 52 | 工具 | `--write-test` 會寫入真實資料 | 在 `telemetry`/`devices` 留下測試列；預設不寫入，用了照工具印出的 `DELETE` 清理 | `tools/greeny_check.py:176-177,279-295` |
| 53 | 工具 | `toggle-led.mjs` 用的是 `esp32-01` | 不是 `esp32-sensor`（待確認刻意隔離或筆誤）；使用前確認 WS_URL | `tools/toggle-led.mjs:14` |
| 54 | 工具 | `toggle-led.mjs` 需要 `GREENY_TOKEN` | 沒設定會直接 `process.exit(1)`；先登入取得 JWT 再設環境變數 | `tools/toggle-led.mjs:12-13` |
| 55 | DB | `devices` 有 `id` 與 `device_id` 兩個欄位 | Worker alarm 用 `WHERE device_id = ?`、Pages 用 `WHERE d.id = ?`；寫新查詢前先確認用哪一個 | `edge/src/device-hub.ts:613`、`spa/functions/api/telemetry.ts:72-75` |
| 56 | DB | `telemetry` 有 `temp` 與 `water_temp` | Worker/DO 寫 `temp`、Pages 寫 `water_temp`；前端 `normalizeReading()` 處理，新查詢要涵蓋兩個欄位 | `spa/functions/api/telemetry.ts:78`、`spa/src/hooks/useSensorData.ts:40-68` |
| 57 | DB | `alerts` 有 `type` 與 `alert_type` | 同一模式；前端用 `a.alert_type \|\| a.type` 容忍兩種 | `edge/src/device-hub.ts:574`、`spa/functions/api/telemetry.ts:98`、`spa/src/hooks/useSensorData.ts:107` |
| 58 | DB | `relay_queue`／`relay_log` 同名不同表 | DO-local SQLite 與 D1 是**不同的表、不同 schema**；改動前確認自己在改哪一層 | `spa/functions/api/relay.ts:18,39`、`edge/src/device-hub.ts:593` |
| 59 | DB | `edge/db/schema.sql` 已過期 | 它寫著 `users.salt TEXT NOT NULL`，但線上沒有這欄；**不要拿它重建資料庫** | `edge/db/schema.sql:45`、`:4-13` |
| 60 | DB | `sqlite_sequence`／`_cf_KV` 是系統表 | 誤刪會造成 AUTOINCREMENT 異常或 D1 metadata 損壞；不要動 | D1 `greeny-db` |

**已刪除的檔案（不要再引入）**：`edge/src/index.mjs`（舊 esbuild 產物，內含有漏洞的登入查詢與無認證 WS 升級）；`edge/EDGE.md:189-206` 的舊部署指示正是教人上傳它——部署一律用 `wrangler deploy`（bundle `src/index.ts`）。

## 6. 資料模型

D1 `greeny-db` 共 16 張表（盤點見 GUIDE §3，2026-10-13）。「關鍵欄位」是從程式碼 SQL 反推：repo 裡的 `edge/db/schema.sql` 是唯一 DDL，且**與線上實際結構不同**。

| # | 表 | 用途（關鍵欄位） |
|---|---|---|
| 1 | `users` | 帳號與角色（`id`、`username`、`password_hash`、`role`、`display_name`、`office_id`、`active`、`created_at`；**沒有 `salt`**） |
| 2 | `offices` | 據點（`id`、`name`、`contact_person`、`contact_phone`、`whatsapp_number`、`notes`、`active`、`created_at`） |
| 3 | `racks` | 貨架，可綁裝置（`id`、`name`、`office_id`、`device_id`、`location`、`status`、`layer_count`、`created_at`） |
| 4 | `rack_vegetables` | 貨架蔬菜層（`id`、`rack_id`、`layer_number`、`variety`、`quantity`、`planted_at`、`notes`、`created_at`） |
| 5 | `rack_environment` | 環境數據（`id`、`rack_id`、`temperature`、`humidity`、`light_level`、`ph`、`ec`、`source`、`recorded_at`、`created_at`） |
| 6 | `devices` | 裝置註冊與狀態（`id`（＝device_id 字串）、`device_id`、`name`、`floor`、`location`、`status`、`last_seen`、`hotel_id`、`created_at`） |
| 7 | `telemetry` | 遙測歷史。**兩套欄位並存**：`(device_id, tds, ec, ph, temp, led, esp32_ms, do_ms, created_at)`（Worker/DO）＋ `(ph, ec, water_temp, water_level, ndvi, spectral_*, relay1, relay2, ts_ms, hotel_id)`（Pages） |
| 8 | `alerts` | 警報（`id`、`device_id`、**`type` 與 `alert_type` 並存**、`message`、`severity`、`acknowledged`、`hotel_id`、`created_at`） |
| 9 | `crop_batches` | 作物批次（`id`、`office_id`、`batch_id`、`variety`、`quantity`、`planted_at`、`status`、`created_at`；欄位名待確認，目前 0 筆） |
| 10 | `harvest_logs` | 收成紀錄（`id`、`batch_id`、`quantity`、`harvested_at`、`notes`、`created_at`；欄位名待確認） |
| 11 | `automations` | 自動化規則（`id`、`name`、`type`、`cron_expr`、`config`、`office_id`、`rack_id`、`enabled`、`last_run_at`、`created_at`） |
| 12 | `relay_log` | 指令稽核（D1 端；`id`、`device_id`、`command`、`params_json`、`status`、`created_at`；⚠️ Pages `relay-logs.ts:14` 讀的是 `relay1, relay2, ph_cal`） |
| 13 | `relay_queue` | 待送指令（D1 端舊路徑：`device_id, relay1, relay2`；⚠️ DO-local 同名表用 `command`/`params_json`——**同名不同表**） |
| 14 | `settings` | 系統設定 key-value（`key`（PK）、`value`） |
| 15 | `sqlite_sequence` | SQLite 內部（`name`、`seq`）；**系統表，不要動** |
| 16 | `_cf_KV` | Cloudflare D1 內部 metadata；**系統表，不要動** |

另有 `tasks`、`personnel`、`filters`、`notifications`、`reports/*` 端點，但這四張表不在 16 張清單裡（待確認）。

**線上結構與程式碼不一致（最易改錯處）**：
1. `devices` 兩個識別欄位：DO alarm 用 `device_id`（`edge/src/device-hub.ts:613`）、Pages 一面倒用 `d.id`（`spa/functions/api/telemetry.ts:72-75`、`devices/index.ts:13`、`racks/index.ts:11`）；兩者要同時存在才兩邊都能跑，若 `device_id` 不存在則 `last_seen` 更新每次失敗（被 catch 吞掉）。
2. `telemetry` 兩套欄位命名——這就是 `normalizeReading()` 存在的理由；新增欄位要想清楚給哪條路徑。
3. `alerts` 的 `type` vs `alert_type`：前端 `type: a.alert_type || a.type` 是「已知不一致」的證據。
4. `relay_queue` 在 DO-local 與 D1 是兩個完全不同的表（名字一樣、schema 不同、不同資料庫）。
5. `relay_log` 同樣兩套欄位（DO：`command/params_json`；Pages：`relay1/relay2/ph_cal`）。
6. `edge/db/schema.sql` 已過期（`:45` 仍寫 `salt TEXT NOT NULL`）：程式碼已改、repo schema 檔沒改，兩份 schema 不能同時是對的。

**`settings` 的重要 key**：`jwt_secret`（Worker 與 Pages 共用同一把，token 兩邊都通；`edge/src/index.ts:29`、`spa/functions/_lib/jwt.ts:13`）、`device_token`（WS handshake 與 HTTPS 備援同一個值；`edge/src/index.ts:45`、`spa/functions/api/telemetry.ts:8`）、`ph_min`/`ph_max`/`ec_max`/`temp_min`/`temp_max`（**程式碼中沒有讀取**，只有前端顯示用——改它們不會改變警報行為）。共 22 個 key，程式碼只讀 7 個。

## 7. 待確認清單（完整說明見 CODE-EXPLAINED.md 附錄）

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
14. `firmware/esp32/esp32.ino:897-902` 強制覆蓋校正值——暫時手段或預期行為（§6.1、§10.5 #30）
15. `tools/toggle-led.mjs:14` 用 `esp32-01` 而非 `esp32-sensor`（§7.3、§10.8 #53）

**三項結構性待確認**（無法從 repo 內檔案確定）：(a) D1 線上實際 schema——本文表結構是從 SQL 反推，`edge/db/schema.sql` 已過期，環境中沒有可用的 D1 唯讀憑證匯出 `sqlite_master`；(b) `settings` 表的 22 個 key 中 15 個用途不明；(c) `tasks`/`personnel`/`filters`/`notifications` 四張表有端點但不在 16 張清單中。

**維護提醒**：改動架構、端點、認證或資料模型時，同步更新完整版與 [`docs/API.md`](./API.md)；行號位移請以**函式名稱**搜尋。
