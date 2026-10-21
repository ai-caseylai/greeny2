# Greeny2 Telegram 水質查詢

指定 Bot：@greeny2_bot（https://t.me/greeny2_bot）。手機使用原有客戶號碼。

手機輸入 ec?、temp?、ph?，或按 Bot 下方三個按鈕；另支援 /ec、/temp、/ph、/help。EC 回覆 µS/cm 數值（包括有效零值），溫度保留一位小數，pH 保留兩位。資料由現有 DeviceHub 取得，沿用實際採樣時間及離線／過期警示；沒有讀數時不補造值。三個查詢直接讀取已驗證的感測欄位，毋須額外呼叫 LLM。

手機 → Telegram 官方 HTTPS webhook → Cloudflare Greeny2 Worker → SQLite-backed TelegramHub Durable Object → 現有 DeviceHub → Webhook 回傳 sendMessage → Telegram 發出回覆。PC、Java、signal-cli、常開瀏覽器均不是正式運行依賴；StamPLC 韌體及客戶端 Wi-Fi 設定毋須更改。

## 一次性設定

1. 在手機 Telegram 的官方 @BotFather 建立 @greeny2_bot，保留 Bot Token。
2. 執行已核對 SHA-256 的來源安裝器。它先備份這次來源修改並執行本機測試，再啟動 tools/telegram/setup.mjs setup。
3. 在本機 PowerShell 的 Bot Token 隱藏提示貼入 Token。工具透過 getMe 驗證確實屬於 @greeny2_bot；不把 Token 放在命令參數、公開程式或聊天訊息。
4. 工具保留原有 Cloud 管理員密碼、裝置 token、D1 數據及 Signal 設定，重新編譯及部署同一個自有 Greeny2 Worker；新增兩個 Worker Secrets：TELEGRAM_BOT_TOKEN、TELEGRAM_WEBHOOK_SECRET。不呼叫付費升級 API，也不建立 Containers。
5. 新增 TelegramHub SQLite Durable Object（遷移 v3-telegram），使用可供 Workers Free 使用的方案；原有 DeviceHub／GreenyAgent 遷移與資料保留。安裝器只對自有帳戶、greeny2-db、greeny2.openezit.com 部署。用量仍受 Cloudflare 及 Telegram 免費限制。
6. 打開 PowerShell 顯示的本機 PAIR PAGE。用手機相機掃 QR，開啟 Telegram 並按 Start／開始；若沒有收到提示，直接在 Bot 傳送 /start；再按 Bot 的「確認手機號碼」，分享自己的聯絡資料。必須與原有客戶號碼相同，且 contact.user_id 必須是發送者本人；電話只以 SHA-256 保存到 Cloudflare。
7. 在手機分別輸入 ec?、temp?、ph?。本機監看頁顯示三項通過後，仍須人眼確認手機收到的答案及採樣時間。最後關閉電腦，再重試三項，驗證沒有本機依賴。

Token 本機保存在已排除 Git 的 .greeny2-telegram-private.json；Cloudflare 以 Worker Secrets 保存。不要把此檔及 .greeny2-private.json 上傳 GitHub。本機 .telegram-runtime/pair-session.json 只含暫時 localhost 頁面網址／進度，不含 Bot Token 或 Telegram 配對連結。本機監看頁保持一小時，QR 只作開啟 Bot 的導引；直接 /start 同樣可要求手機核對。每次手機聯絡資料確認有效十五分鐘，只有 Telegram 驗證的本人 user_id 與原授權號碼相符才可綁定；同一設定重跑保留已核對的手機。

## 維護

Node.js 24+。不需新 npm 套件，沿用 Signal 安裝時已附的本機 QR 函式庫。

- node tools/telegram/setup.mjs setup：部署並設定，首次時在本機隱藏輸入 Token。
- node tools/telegram/setup.mjs pair：重新產生臨時配對頁／恢復驗收監看；保留現有已核對手機。
- node tools/telegram/setup.mjs status：以管理員驗證後檢查配對與最近查詢。
- node tools/telegram/setup.mjs finish：三項測試均通過、且用戶已確認手機答案後執行；停止此專案的本機 Signal 背景橋接及登入啟動捷徑，保留 Signal 私鑰、來源與所有韌體備份。Telegram webhook 繼續由 Cloudflare 運行。

瀏覽器／PowerShell 只在首次 Token 設定與驗收時開啟。設定工具不修改電腦 DNS；如本機解析未更新，使用公開 DNS 的 IP 連接同一網域，HTTPS 憑證及 SNI 驗證維持啟用。

## 存取及重送

Webhook 要求 Telegram 官方 secret_token 標頭，只接受新近的私人訊息；忽略群組、Bot、轉寄他人 contact、編輯訊息和兩分鐘前的積壓訊息。其他帳戶不能藉 username 讀取資料。管理設定僅限 superadmin；Telegram 沒有 Relay 或校正入口。

DO 保存手機綁定及更新 ID 日誌並序列處理重複 webhook，重啟後仍能去重。Webhook 回覆一經提交便記錄更新 ID，重送事件不會重複提交。若手機沒有收到回覆，請重新發出查詢。日誌不保存完整 Telegram 訊息、聯絡資料或 Bot Token；定期刪除超過兩天的更新 ID。

驗收狀態中的 submitted_queries 表示 Worker 已在 Webhook 回應提交包含實際感測資料的 sendMessage 方法。此模式依 Telegram 官方協議無法取得方法執行結果，因此不宣稱已送達，仍須人眼確認手機答案。離線最後讀數仍帶警告，不會當作即時資料。

參考：
- Telegram Bot API：https://core.telegram.org/bots/api#setwebhook
- Telegram BotFather：https://core.telegram.org/bots/features#botfather
- Cloudflare Durable Objects 免費方案：https://developers.cloudflare.com/durable-objects/platform/pricing/

## 配對診斷

/api/telegram/config 的 superadmin 狀態增加 pairing_stage 與 last_pairing_event，只記錄 start／contact 種類、時間及 Telegram 回覆狀態／錯誤代號，不記錄訊息內容、電話或 Token。手機開啟 Bot 未帶入 start 參數時，直接輸入 /start 可顯示「確認手機號碼」按鈕。資料存取仍要求私聊、本人 contact.user_id 及原客戶號碼核對，其他手機不能查詢。

## Webhook 回覆模式

Telegram 發出 webhook 更新時，Greeny2 直接回傳 application/json，內容為 method=sendMessage、已核對的 chat_id、文字及 reply_markup。Telegram 自己執行該方法，不依賴 Worker 向 api.telegram.org 額外連線。Webhook secret_token、私人聊天及原客戶手機號碼驗證全部保留；狀態使用 submitted（已提交），不會把缺少的 Telegram API 執行結果當作送達證明。

官方說明：https://core.telegram.org/bots/faq#how-can-i-make-requests-in-response-to-updates
