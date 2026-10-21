# Greeny2 Signal 個人筆記查詢

手機 Signal 的「個人筆記 / Note to Self」可輸入 ec?、temp?、ph?。新鮮資料回覆數字，EC 單位 µS/cm、溫度 °C、pH 為兩位小數。離線或超過 30 秒的資料會明確標示「最後讀數」及香港採樣時間；沒有資料就回覆不可用。數字由受驗證的感測欄位直接格式化，避免語言模型改寫或補造數值。網頁其他問題保留 Workers AI，只讀且強制附採樣／離線提示。

Signal 是端到端加密通訊。此整合在指定手機帳戶新增名為 Greeny2 Note to Self 的連結裝置；手機保持原有帳戶。橋接程式只處理自己傳給自己的三個查詢，忽略其他聯絡人、群組、歷史訊息及任何控制指令。不要將完整 Signal 聊天記錄或私密設定提交 Git。

## 安裝及啟動

先備份套用來源，通過工具測試及 production build，再以既有 tools/deploy-openezit.mjs deploy 部署自己的 Worker。接著執行 tools/signal/setup.mjs all，加上已授權手機的 E.164 號碼。安裝器下載鎖定版本 signal-cli 與 Temurin JRE，檢查來源公布的 SHA-256，放在本專案 .signal-runtime；不需 Docker，也不改系統 Java。

Cloud 服務端僅保存橋接金鑰的 SHA-256。此金鑰只能呼叫 /api/signal/query 讀取配置的一部感測器，不能用於管理或 Relay API。設定此功能需要 superadmin。原有管理員密碼、裝置 token、資料庫、韌體及繼電器狀態保留。

安裝器顯示 QR code 時，在手機 Signal 頭像 > 已連結裝置 > 連結新裝置掃描，完成後只在「個人筆記」查詢。桌面電腦必須開機並連網；橋接在本 Windows 使用者登入時以隱藏視窗自動啟動，裝置在客戶處亦須連網上傳。電腦關機／睡眠期間無法即時自動回覆。後續可將這個橋接部署到常開伺服器。

Node.js 24+，Windows x64。狀態：node tools/signal/setup.mjs status。重新配對：node tools/signal/setup.mjs link。啟動：node tools/signal/setup.mjs start。停止並移除本整合的登入啟動捷徑：node tools/signal/setup.mjs stop。停止後仍保留手機配對及私密設定；手機可隨時在「已連結裝置」撤銷。

## 私密檔案與驗證

.greeny2-signal-private.json及 .signal-runtime 已忽略 Git。前者包含唯讀 Cloud 金鑰，後者包含 Signal 裝置私鑰、去重日誌及狀態，應只留在授權的主機。

SQLite 日誌保存訊息指紋與回覆狀態以防重覆處理；發送結果不確定時不自動重發，可重新輸入查詢。重啟不回覆超過兩分鐘的積壓查詢，避免把歷史訊息當成新查詢。橋接不記錄其他聊天內容。端到端驗證須確認手機收到三種回覆，並核對採樣時間及實機；只通過單元測試不代表已配對或已送達手機。

signal-cli 為第三方開源軟件，須隨 Signal 協議更新維護：https://github.com/AsamK/signal-cli 。

## 瀏覽器配對頁

link 命令會顯示本機 PAIR PAGE 網址。先開啟該網址，再在手機 Signal 開啟「已連結裝置 → 連結新裝置」，準備好後按「產生新的配對碼」。QR 為本機產生的黑白 SVG，包含四格留白，不受終端機字型或換行影響。掃描無反應時可按「重新產生配對碼」，舊工作階段會關閉。頁面會顯示配對成功或等待逾時狀態。只有經核對的帳戶才會保存身分及啟動橋接。

配對頁僅綁定 127.0.0.1，具隨機路徑、來源檢查與 CSP；無外部 QR 網站。sgnl:// 配對連結只留在該工作階段記憶體，不寫入 pair-session.json。該狀態檔只保留本機頁面網址及進度。舊終端機方式可用 link-terminal，但建議使用瀏覽器方式。
