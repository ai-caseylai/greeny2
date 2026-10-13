# Greeny2 更新文檔（Changelog）

> **本文件記錄系統的實際變更** —— 修了什麼、為什麼、怎麼驗證的。
> 三份文件的用途區分：
>
> | 文件 | 回答什麼 |
> |---|---|
> | [GUIDE.md](./GUIDE.md) | 系統怎麼運作、怎麼操作 |
> | [API.md](./API.md) | 每個端點與裝置協定的規格 |
> | [CODE-EXPLAINED.md](./CODE-EXPLAINED.md) | 程式碼為什麼這樣寫 + [精簡版](./CODE-EXPLAINED-SHORT.md) |
> | **本文件** | **最近改了什麼、影響是什麼、驗證到什麼程度** |

---

## 0. 摘要

### 三個最重要的發現

1. 🔴 **裝置資料從來沒有進到資料庫。**
   `DeviceHub` Durable Object 寫入 D1 的欄位名稱與實際 schema 不符（`temp` vs `water_temp`、
   `alert_type` vs `type`、以及多個不存在的欄位），而 D1 **強制外鍵完整性**，
   未註冊的裝置也被拒絕。結果：**遙測、警報、指令稽核全部靜默失敗**。
   資料庫裡 426 筆遙測全是 2026 年 7 月以前走另一條 HTTPS 路徑留下的舊資料。

2. 🔴 **登入可以繞過、WebSocket 完全沒有認證。**
   密碼驗證函式裡有一行 `if (storedHash.startsWith('$2')) return true;` ——
   **任何密碼都能以 superadmin 登入**（已在線上實際重現）。
   同時儀表板與裝置兩條 WebSocket 都無需任何憑證。

3. 🟠 **警報閾值改了不會生效。**
   Durable Object 用硬編碼數值，設定頁只寫進瀏覽器 `localStorage`，
   後端從不讀取 —— 三處數值還各不相同。

### 目前線上版本

| 元件 | 版本 / 識別 | 說明 |
|---|---|---|
| **Worker** | `242f8603` | `iot-hub.ai-caseylai.workers.dev` |
| **Pages** | `ca9571a7` | `greeny.techforliving.net` |
| **D1** | `greeny-db` | 已新增 4 個欄位（見 §5） |
| **Repo** | `f6a6034`，48 commits，`main` | 已推送 GitHub |

### 變更總表

| 嚴重度 | 項目 | 狀態 |
|---|---|---|
| 🔴 極高 | 登入繞過（任何密碼可登入 superadmin） | ✅ 已修 |
| 🔴 極高 | 裝置遙測從未寫入 D1 | ✅ 已修＋實測 |
| 🔴 極高 | 裝置警報從未寫入 D1 | ✅ 已修＋實測 |
| 🔴 極高 | 指令稽核（relay_log）從未寫入 D1 | ✅ 已修＋實測 |
| 🔴 高 | WebSocket（儀表板／裝置）完全無認證 | ✅ 已修＋實測 |
| 🔴 高 | `POST /api/telemetry` 完全開放 | ✅ 已修 |
| 🔴 高 | 5 個帳號使用預設密碼、bcrypt 格式 | ✅ 已遷移 |
| 🔴 高 | AI 謊稱校正已寫入裝置 | ✅ 已修 |
| 🟠 中高 | 警報閾值改了不生效 | ✅ 已修＋實測 |
| 🟠 中高 | 寫入失敗仍被標記已處理 → 資料永久遺失 | ✅ 已修＋實證 |
| 🟠 中高 | 看門狗無法偵測「遙測中途停止」 | ✅ 已修 |
| 🟠 中 | 警報確認按鈕無效（打了不存在的端點） | ✅ 已修＋實測 |
| 🟠 中 | 警報篩選（待確認／已確認）無效 | ✅ 已修＋實測 |
| 🟠 中 | 兩套登入簽發的 JWT 內容不一致 → office_admin 一律 403 | ✅ 已修＋實測 |
| 🟠 中 | 「確認警報」後同一警報每分鐘重複生成 | ✅ 已修 |
| 🟡 低 | 使用者／作物管理頁全空（11 處 API 路徑缺前綴） | ✅ 已修 |
| 🟡 低 | 辦公室角色鎖定完全失效（讀錯 storage） | ✅ 已修 |
| 🟡 低 | 指令重複派送、佇列無上限 | ✅ 已修 |
| 🟡 低 | 韌體每次開機覆蓋 EEPROM 校正值 | ✅ 已修（待重燒） |
| 🟡 低 | `toggle-led.mjs` 指向已淘汰的裝置 ID | ✅ 已修 |
| — | Captive Portal 死碼 | ⏳ 進行中 |

---

## 1. 資料管線修補（最嚴重）

### 1.1 裝置遙測從未寫入 D1

**根因**：`edge/src/device-hub.ts` 的 `alarm()` 執行

```sql
INSERT INTO telemetry (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms)
```

但 D1 的 `telemetry` 表實際欄位是 `water_temp`（**沒有 `temp`**）、**沒有 `led`**、
**沒有 `esp32_ms` / `do_ms`**。除此之外：

- D1 **強制外鍵完整性**（`telemetry.device_id REFERENCES devices(id)`），
  未在 `devices` 表註冊的裝置一律被拒
- 寫入失敗後，程式碼仍執行 `UPDATE telemetry_buffer SET flushed = 1 WHERE flushed = 0`
  → **失敗的資料被標記為已處理，永久遺失**

**修法**：
- 欄位正確映射：`temp → water_temp`、`led → relay1`、`ts_ms`（NOT NULL）取 `do_ms`
- 寫入前先 `INSERT ... ON CONFLICT(id) DO UPDATE` 註冊裝置（含正確的 `last_seen` 秒數）
- D1 補上 `esp32_ms`、`do_ms` 兩個欄位
- **改為「確認插入成功才標記該列」**（見 1.4）

**驗證**：從裝置 WebSocket 送出遙測 → 一個 alarm 週期後查 D1 → 資料確實落地。

### 1.2 裝置警報從未寫入 D1

**根因**：寫入 `alert_type`（欄位實際叫 `type`）。即使改名，
`evaluateAlerts()` 產生的是 `ph_low` / `ph_high` / `temp_low` / `temp_high`，
而 `alerts.type` 有 CHECK 限制，**只允許**
`ph_abnormal | ec_high | temp_abnormal | do_low | offline | water_low | leak`
—— 4 種型別全部違反約束。

**修法**：寫入 D1 時映射到允許的詞彙（`ph_low`/`ph_high → ph_abnormal`、
`temp_low`/`temp_high → temp_abnormal`）；精確資訊保留在 `message`
與 WebSocket 廣播中。同時補上裝置外鍵所需的 upsert。

### 1.3 指令稽核從未寫入 D1

**根因**：寫入 `command`、`params_json` 兩個**不存在的欄位**；
D1 的 `relay_log` 實際是 `device_id, relay1, relay2, ph_cal, status, created_at`。

**修法**：以 `ALTER TABLE` 新增 `command`、`params_json` 兩欄（向後相容，預設空字串）。

> **副作用（正面）**：修正後，先前卡在 DO 緩衝區的真實資料被補送進 D1 ——
> 包括 4 筆 `esp32-sensor` 的 `set_led` 指令紀錄。這證明修正有效，
> 也證明這些資料在修正前確實一直送不出去。

### 1.4 寫入失敗被標記已處理 → 永久遺失

原本三個緩衝表都是「迴圈逐列 try/catch，之後**無條件**執行一次
`UPDATE ... SET flushed = 1 WHERE flushed = 0`」。任何一列寫入失敗，
下一輪就不會再重試 —— 資料無聲消失。

**修法**：改為每一列寫入成功後單獨標記（`WHERE id = ?`）；失敗的列保持未處理，
下一個週期自動重試。**實證**：修正前失敗的那筆遙測，在修正後被重試並成功送達
（遙測總數 426 → 428，其中一筆就是補回來的）。

### 1.5 相關：`devices.last_seen` 從未更新

`UPDATE devices SET last_seen = ? ... WHERE device_id = ?` —— 該表的主鍵叫 `id`，
所以條件永遠不匹配（靜默更新 0 列）。另外寫入的是毫秒，而表存的是秒。
兩者皆已修正。

---

## 2. 安全性修補

| # | 問題 | 修法 |
|---|---|---|
| 1 | **登入繞過**：`password.ts` 的 `if (storedHash.startsWith('$2')) return true;` → 任何密碼都能以 admin 登入 | 移除短路，改為 fail-closed；統一自描述格式 `pbkdf2:<iters>:<salt>:<hash>` |
| 2 | **WebSocket 無認證**（兩條通道皆可任意連線，可看遙測、可遙控繼電器） | 在 Worker 層攔截：`/dashboard/*` 驗 JWT、`/device/*` 驗裝置 token、其他回 404（不進入 DO） |
| 3 | **`POST /api/telemetry` 完全開放** → 可灌假資料 | 需裝置 token（`?token=` 或 `X-Device-Token`）或有效 JWT |
| 4 | 5 個帳號使用預設密碼、以 bcrypt 儲存 | 全數遷移為 PBKDF2（100,000 次、SHA-256）並更換密碼 |
| 5 | `JWT_SECRET` / `WB_API_KEY` 以公開預設值提交在 `wrangler.toml` | 移除；JWT 密鑰只從 D1 `settings` 讀取；`WB_API_KEY` 改為 Pages 專案的 `secret_text` |
| 6 | 舊打包產物 `edge/src/index.mjs` 含**有漏洞的登入與無認證 WS** | 刪除；部署改用 `wrangler deploy`（直接打包 `src/index.ts`） |
| 7 | 裝置 token 一度寫進要提交的韌體原始碼 | 移到 gitignored 的 `device_secrets.h` / `device_secrets.py` |
| 8 | Git 歷史中的外洩 WiFi 憑證 | `git filter-repo` 改寫歷史並重建 repo |

**邊界案例**：`api/_middleware.ts` 原本對整個 `/api/auth/` 前綴放行，
導致 `/api/auth/me` 的 `context.data.user` 未定義而回 500
（且是 500 而非 401，會洩漏「此路徑存在」）。現在只放行 `/api/auth/login`。

### ⚠️ 尚未處理的安全風險

| 風險 | 說明 |
|---|---|
| `iot-hub.funconnect.workers.dev` | **另一個 Cloudflare 帳號**的 Worker，仍公開且仍有相同的登入繞過。本帳號無權處理 —— 建議停用 |
| `GET /api/relay`（Pages） | 無需認證即可讀取繼電器狀態（刻意保留給裝置讀取） |
| 對話中曾出現的憑證 | GitHub PAT、數顆 Cloudflare token、`WB_API_KEY` —— **建議輪換** |

---

## 3. 功能缺陷修補

以下 15 項來自一次系統性的「待確認清單」逐一驗證，結果為 **11 項真問題、4 項誤判**。

### 已修

| # | 問題 | 影響 | 修法 |
|---|---|---|---|
| A | Worker 與 Pages 簽發的 JWT 內容不一致 | Pages 端 `office_id` 為 undefined → **所有 office_admin 都被 403** | 統一 payload 為 `{sub, username, role, office_id, display_name}` |
| B | `OfficeContext` 讀 `localStorage`，`useAuth` 寫 `sessionStorage` | `userRole` 永遠 null、**辦公室鎖定完全失效**；另有硬編碼的辦公室 ID 9 | 改讀 sessionStorage、移除硬編碼預設值 |
| 1 | Worker 登入未檢查 `active` | 停用的帳號仍可登入（SPA 走的就是 Worker） | 加上 `AND active = 1` |
| 2 | 警報閾值無效 | 改閾值不影響警報（詳見 §4） | DO 改從 D1 讀取 |
| 3 | 看門狗只認「連線後從未收到遙測」 | 遙測中途停止永遠不會被發現 | 加上 90 秒停滯偵測；另加 30 秒連線寬限期（避免誤殺剛連上的裝置） |
| 4 | 離線廣播硬編碼 `device_id` | 其他裝置的離線狀態會誤報成 `esp32-sensor` | 改用連線的實際裝置 ID |
| 5 | 寫入失敗仍標記已處理 | 資料永久遺失 | 改為逐列確認後標記（§1.4） |
| 9 | AI 謊稱校正已寫入裝置 | 使用者以為校正生效，實際 **EEPROM 一個 byte 都沒寫** | 改為誠實說明（§4.3） |
| 10 | SPA 警報確認打了不存在的端點 | **確認按鈕完全無效**（Worker 回 404） | 改用 `POST /api/alerts/ack` |
| 11 | 11 處管理 API 呼叫缺 `/api` 前綴 | Pages 回 SPA 外殼（200 + HTML）→ `res.json()` 拋錯 → **使用者／作物管理頁全空** | 在 `lib/api.ts` 集中正規化路徑 |
| 14 | 韌體每次開機覆蓋 EEPROM 校正值 | 透過 WSS 做的 EC 校正**每次重開機就白做** | 移除該段 |
| 15 | `toggle-led.mjs` 指向已淘汰的 `esp32-01` | 工具量測不到裝置 | 改為 `esp32-sensor`，可用 `GREENY_DEVICE_ID` 覆寫 |

### 另外發現並已修（不在原本 15 項內）

| 項目 | 說明 |
|---|---|
| 警報重複生成 | 去重條件用 `flushed = 0`，flush 之後同一狀況又會警報 → **每分鐘重複**。改為 30 分鐘冷卻窗 |
| 指令重複派送 | 裝置 ACK 後未從 `relay_queue` 移除 → 下一筆遙測再送一次 | 
| `relay_queue` 無上限 | 唯一沒有任何清理機制的表 → 加上保留最新 50 筆 |
| 警報確認未套用篩選 | Worker 的 `GET /api/alerts` **完全忽略 `acknowledged` 參數** → 「待確認／已確認」篩選無效（Pages 版有實作、Worker 版漏了） |
| 迭代中刪除同表 | `drainRelayQueue` 在遊標迭代時 `DELETE` 同表資料 → 改為先收集再刪除 |

### 判定為誤判（不用改）

| # | 原本懷疑 | 實際 |
|---|---|---|
| 6 | DO-local 表可能無限成長 | 有清理上限（100/50/50），且 `flushed = 0` 不會累積 |
| 7 / 8 | `MODEL_REASON`、`TOOLS` 未使用 | 事實成立，但屬無害死碼 |
| 12 | `users/[id].ts` 不用 `c.params.id` | 兩種寫法等價 |
| — | `relay_queue` 在裝置重連時被清空 | **刻意的**（避免重放過期的校正指令），不要「順手修掉」 |

---

## 4. 新功能與行為變更

### 4.1 警報閾值改由資料庫驅動

**變更前**：DO 硬編碼 `ph 5.5–8.5 / ec 2000 / temp 18–30`；
設定頁寫 `phMax 7.5 / tempMax 28` 到 `localStorage`；D1 又有第三組（`phMax 7.0`）。
**三套數值，且後端完全不讀。**

**變更後**：D1 `settings` 是唯一權威來源。

- DO 在 `alarm()` 讀取並快取（存於 DO-local `device_state`），
  `evaluateAlerts()` 同步讀快取（熱路徑不能 `await`）
- 裝置連線後**約 1 秒**即刷新（DO 會提早觸發一次 alarm）；其餘情況最多 60 秒
- 新增端點 `GET` / `PUT /api/settings/thresholds`（見 [API.md Part G](./API.md)）
- 設定頁改為從 API 載入、寫回 API（localStorage 降級為渲染快取）
- 警報訊息改為繁體中文並**附上生效的閾值**，例如
  `溫度過高: 27°C（上限 26）`

**實測**：把 `temp_max` 設為 26，裝置回報 27 → D1 出現
`{"type":"temp_abnormal","message":"溫度過高: 27°C（上限 26）"}`
—— 證明用的是 D1 的值，不是舊的硬編碼 30。

### 4.2 新增：連線測試工具

`tools/greeny_check.py` —— **22 項**端到端檢查，涵蓋 Worker 健康、Pages SPA、
兩個主機的登入（含錯誤密碼必須被拒）、REST（含無 token 必須 401）、
儀表板 WS 與裝置 WS 的認證正反面。支援 `--json` 與非零退出碼，可掛監控。

> 設計要點：裝置 WS 測試預設使用 `<device-id>-probe` 而非真實 ID ——
> Durable Object 只接受一個裝置連線，用真 ID 會**把線上裝置踢掉**。

### 4.3 AI 校正回覆改為誠實

原本回覆「**已送到你的 ESP32，之後所有 pH 讀值都會用這組值**」，但：
韌體沒有 `type:"ph"` 分支、對未知型別無條件回 `ok`、單位也不一致、EEPROM 未寫入。

現在明確說明「**這些數值沒有寫入裝置**」，並引導使用正確的兩點緩衝液校正流程。

### 4.4 新增韌體實作

| 檔案 | 說明 |
|---|---|
| `firmware/greeny2_sensor/greeny2_sensor.ino` | Arduino **精簡版**（374 行）：與完整版協定相同，但移除 OLED / Captive Portal / EEPROM，方便閱讀與修改 |
| `firmware/esp32-micropython/main.py` | MicroPython 版（540 行）：自帶 WebSocket 握手與 frame 編解碼，不需 Arduino 工具鏈 |

三個實作（完整版 Arduino / 精簡版 Arduino / MicroPython）**協定完全相同**。
兩份 Arduino 版本皆已用 `arduino-cli 1.5.1` + `esp32 core 3.3.12` **編譯通過**。

---

## 5. 資料庫結構變更

以 `ALTER TABLE` 新增 4 個欄位（皆向後相容，既有資料不受影響）：

```sql
ALTER TABLE telemetry  ADD COLUMN esp32_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE telemetry  ADD COLUMN do_ms    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_log  ADD COLUMN command     TEXT NOT NULL DEFAULT '';
ALTER TABLE relay_log  ADD COLUMN params_json TEXT NOT NULL DEFAULT '';
```

`edge/db/schema.sql` 已**由線上 D1 實際結構重新產生**（205 行，14 張表 + 18 個索引）。

> ⚠️ **舊版 `schema.sql` 是錯的**：它宣告了 `users.salt`（線上不存在）
> 以及 telemetry 的 `temp` / `led`（線上叫 `water_temp`、無 `led`）。
> 照舊版建表會讓 Worker 登入查詢與 DO 的所有寫入全部失敗。
>
> 檔頭現在明確記載：**D1 會強制外鍵完整性**，
> `telemetry.device_id` 必須先存在於 `devices.id`。

---

## 6. 驗證紀錄

所有驗證都是對**線上正式環境**執行，不是本地推論。

| 驗證項目 | 方法 | 結果 |
|---|---|---|
| 連線與認證（22 項） | `tools/greeny_check.py` | ✅ 22/22 通過 |
| 登入繞過已關閉 | 錯誤密碼登入 Worker 與 Pages | ✅ 皆回 401（修正前是 200 + superadmin token） |
| WebSocket 認證 | 無 token／假 token／有效憑證 | ✅ 401 / 401 / 101 |
| **後台 → 裝置 relay 指令** | 模擬裝置連線 → `POST /api/relay` → 觀察裝置收到什麼 | ✅ 裝置收到 `{"command":"set_led","params":{"state":true}}` |
| 指令不重複派送 | ACK 後觀察 13 秒 | ✅ 無重複 |
| **遙測上傳** | 送出一筆 → 等 alarm → 查 D1 | ✅ 落地（`water_temp`/`relay1` 映射正確） |
| **警報上傳** | 送 pH 5.0 / EC 2500 / temp 35 | ✅ D1 出現 3 筆警報 |
| **指令稽核上傳** | 送 `set_led` → ACK | ✅ D1 出現 `sent` 與 `acked` 兩筆 |
| 裝置自動註冊 | 未註冊裝置送遙測 | ✅ `devices` 自動新增，`last_seen` 為秒 |
| 失敗重試 | 修正前失敗的資料 | ✅ 修正後被補送（426 → 428） |
| 警報確認 | `POST /api/alerts/ack` | ✅ D1 的 `acknowledged` 由 0 變 1 |
| 警報篩選 | `?acknowledged=0` / `=1` | ✅ 分別排除／包含該筆 |
| 閾值生效 | `temp_max=26` 後送 27 | ✅ 警報訊息含「上限 26」 |
| JWT 一致性 | 用 Worker 發的 token 打 Pages API | ✅ `/api/users` 回 200 |
| Arduino 兩版編譯 | `arduino-cli compile` | ✅ 皆 exit 0（精簡版 85%、完整版 90% flash） |
| AI 回覆已改 | 抓線上部署內容比對 | ✅ 舊假宣稱 0 次、新說明 1 次 |

**測試資料均已清除**；閾值已還原為原值。
過程中殘留於 D1 的 `esp32-sensor` 資料是**真實資料**（先前卡住、修正後補送），未刪除。

---

## 7. 待辦與需人工處理

### 必須由人處理

| 項目 | 說明 |
|---|---|
| **重新燒錄實體 ESP32** | 所有驗證都是用**模擬裝置**完成的。真實裝置要能用，必須燒錄指向 `iot-hub.ai-caseylai.workers.dev` 並帶入 device token 的韌體 |
| **更換 WiFi 密碼** | 舊密碼曾外洩於 Git 歷史（歷史已改寫，但密碼本身要換） |
| **輪換憑證** | GitHub PAT、Cloudflare token、`WB_API_KEY` 曾以明文出現於對話 |
| **停用 `iot-hub.funconnect.workers.dev`** | 另一帳號的 Worker，仍有相同的登入繞過 |

### 尚未修

| 優先 | 項目 |
|---|---|
| 中低 | Captive Portal 死碼（兩個函式從未被呼叫）—— **進行中** |
| 低 | 裝置 ID 硬編碼在韌體（多裝置需各自編譯） |
| 低 | Pages 專案的永久 API token 權限不足，每次部署都要臨時建立 |
| 低 | 沒有 CI，`git push` 不會自動部署（Pages 無 Git 整合） |

### 已知但不打算修

| 項目 | 理由 |
|---|---|
| `relay_queue` 在裝置重連時清空 | 刻意設計 —— 避免重放過期的校正指令 |
| `GET /api/relay`（Pages）免認證 | 保留給裝置讀取 |
| `calibrate` 為 QoS 0（離線即丟棄） | 校正綁定探頭當下位置，重放會寫入錯誤值 |

---

## 8. 附錄：Commit 對照表

### 安全性與資料管線（本次重點）

| Commit | 日期 | 內容 |
|---|---|---|
| `01943c2` | 10-11 | JWT 密鑰只從 D1 讀取，移除公開預設值 |
| `00c6e45` | 10-13 | 關閉登入繞過、加入 WS 與遙測認證、統一端點 |
| `6360795` | 10-13 | MicroPython 客戶端；憑證清理 |
| `731cde3` | 10-13 | 新增 `docs/GUIDE.md` |
| `44500a0` | 10-13 | 新增 Arduino 精簡版韌體 |
| `2aeafd2` | 10-13 | 記錄編譯驗證結果 |
| `26cbba4` | 10-13 | 新增 `tools/greeny_check.py`（22 項檢查） |
| `f75a97c` | 10-13 | 新增 `docs/CODE-EXPLAINED.md` |
| `7b19bf4` | 10-13 | 警報確認端點、`acknowledged` 篩選、schema.sql 重生成、精簡版文件 |
| `3b00d8f` | 10-13 | **裝置遙測從未寫入 D1** ＋ 7 項 triage 修正 |
| `8ba84fc` | 10-14 | **警報與指令稽核也從未寫入 D1**；完整來回測試 |
| `196767c` | 10-14 | AI 不再謊稱校正已套用 |
| `f6a6034` | 10-14 | **閾值改由 D1 驅動**、`relay_queue` 上限、文件同步 |

### 功能移植與國際化（較早）

| Commit | 日期 | 內容 |
|---|---|---|
| `545a417` / `bc58a88` / `4b3ffcc` / `4407651` | 07-05 ~ 07-06 | 多語系（EN / 繁體 / 簡體，含區旗下拉選單）與頁面翻譯 |
| `b2f5f71` / `8b77576` / `30cd2f2` | 07-06 | 從 aquagreen 移植貨架管理、管理頁面與 Functions API（**ESP32 連線路徑保持不變**） |
| `8900487` | 07-06 | Pages Functions middleware 改從 D1 讀取 JWT 密鑰 |
| `c8ffca2` | 07-05 | 憑證清理：原始碼改為佔位值、`wifi.env` 列入 gitignore |

> 完整的 48 筆歷史見 `git log`。

---

**維護方式**：每次修改架構、端點、認證或部署流程時，於本文件新增一節，
並同步更新對應的 [GUIDE.md](./GUIDE.md) / [API.md](./API.md)。
