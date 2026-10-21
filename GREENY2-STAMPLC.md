# Greeny2 · openezit · StamPLC 四路繼電器

本安裝使用自己的 https://greeny2.openezit.com、Worker greeny2 及 D1 greeny2-db。原有客戶 Worker、資料庫、域名根目錄網站與郵件 DNS 保留。

## 安裝及部署

先由更新安裝器備份及套用程式，再執行 tools/deploy-openezit.mjs build。build 只在本機產生網站與 Worker dry-run 檔，不部署、不燒錄。以相同 Node 命令執行 login，並在瀏覽器完成 Cloudflare 官方 OAuth；最後執行 deploy。deploy 會重新 build，核對已指定的 Cloudflare 帳戶，只建立 greeny2-db、自己的 Worker 及 greeny2 子域名；不會啟用付費方案。

首次 deploy 產生 .greeny2-private.json，內有新 admin 密碼、裝置 token 及 JWT 密鑰。此檔已忽略 Git，不要分享或提交；重跑不重置密碼或密鑰。舊客戶帳號密碼不會複製。需要給 partner 使用時，登入後按辦公室建立 office_admin 或 staff；staff 只可查看。

本機 Node：C:/Program Files/nodejs/node.exe。部署命令：node tools/deploy-openezit.mjs build|login|deploy。工具會保留 .greeny2-build/build-manifest.json，可核對部署所用來源。若指定的既有資料庫未標記且有資料，工具會停止。

## 顯示及控制

日期為實際感測時間（香港，DD-MM-YY HH:MM:SS）；EC 單位 µS/cm、兩位小數，溫度 °C、一位小數，pH 兩位小數。沒有 TDS 探頭時顯示未提供，不從 EC 臆算。30 秒以上舊讀數會標示過期；接收時間與測量時間分開。

四個 Relay 各有獨立開關。按下後等待裝置 ACK 或新的 GPIO 狀態，介面不預先顯示成功。離線不排隊；重新連線或重啟會作廢舊指令。GPIO 回讀代表驅動腳狀態，不等於已量度繼電器機械接點或外接負載。LLM 只可讀數據，不能控制 Relay。

## 韌體

版本 PHECRELAY-20261015-v6。USB 單獨供電時更新，保留完整 8MB 備份；只寫 application。安裝 runner 使用 --cloud-config 指向此專案 .greeny2-private.json，更新 Cloud 設定而保留裝置已保存的 Wi-Fi。原有本機 AP 設定、LCD、RS485 腳位及倍率保留。

啟動時四路關閉。短暫斷線或進入 Wi-Fi 設定時保持當前 Relay 狀態。初次測試須確認無負載；逐路開關後全部關閉。USB-only 不預期有變送器讀數，稍後拔 USB、接回 DC12V 核對 pH/EC/溫度及 Cloud 新時間戳。

connect OK 需要有效新感測值、校時、Cloud 收件確認及應用層 pong；表示 Cloud 已暫存樣本，D1 歷史寫入與 LLM 仍要獨立驗證。Cloud 以 Durable Object 保留待寫記錄，每分鐘寫入 D1，失敗保留重試。

## 用量

使用 Cloudflare 免費項目的可用配置（Workers、D1、SQLite Durable Objects、Workers AI）；實際免費額度及限制以帳戶當時規則為準。預設每 10 秒上傳一次；不包含其他服務的付費通知整合。

## 驗證範圍

交付前：TypeScript noEmit、Worker 記憶體打包、ESP32-S3 固定工具鏈語法/API 檢查、協議/權限/時間與資料庫測試。完整 production build、Cloudflare 部署、實機燒錄、螢幕及四路接點驗證須以安裝後輸出為準；此文件不表示已完成實機驗收。
