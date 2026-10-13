# Greeny2 — ESP32 MicroPython 裝置客戶端

`main.py` 是 [Arduino 版韌體](../esp32/esp32.ino) 的 MicroPython 對應實作，行為一致：

| 行為 | 說明 |
|---|---|
| 連線 | `wss://<WS_HOST>/device/<DEVICE_ID>?token=<DEVICE_TOKEN>` |
| 遙測 | 每 **10 秒**送一次 `telemetry`（tds / ec / ph / temp / led / esp32_ms） |
| 心跳 | 每 10 秒送一次 `{"type":"ping"}`，DO 會回 `pong` |
| 指令 | `set_led` / `calibrate` / `wifi_scan` / `wifi_set`，收到後回 `ack` |
| 看門狗 | **30 秒**沒有任何 inbound → 強制重連（修復 Worker 部署後的半開連線） |
| 斷線 | 5 秒後重連；WiFi 掉了會自動重連 |

**不需要任何額外套件** —— WebSocket handshake 與 frame 編解碼都寫在 `main.py` 裡，
不依賴 `micropython-lib` 的 `websocket-client`（版本差異常導致 API 不相容）。

> ⚠️ **本檔未在實體硬體上驗證過**（開發環境沒有 ESP32）。邏輯是照 Arduino 版與 `PROTOCOL.md`
> 重寫的，請先照下面的檢查清單跑一遍。

---

## 1. 燒錄 MicroPython 固件

```bash
pip install esptool mpremote

# 下載官方固件（選 ESP32 / GENERIC，不要選 ESP32-S3/C3，除非你的板子是那種）
# https://micropython.org/download/ESP32_GENERIC/

esptool.py --chip esp32 --port COM3 erase_flash
esptool.py --chip esp32 --port COM3 --baud 460800 write_flash -z 0x1000 ESP32_GENERIC-*.bin
```

## 2. 上傳程式與憑證

```bash
cd firmware/esp32-micropython

# 憑證（不會進 repo）
cp device_secrets.example.py device_secrets.py
#   → 編輯 device_secrets.py：填 WiFi 帳密；DEVICE_TOKEN 用 D1 settings.device_token
#     的查詢：SELECT value FROM settings WHERE key = 'device_token';

mpremote connect COM3 fs cp device_secrets.py :device_secrets.py
mpremote connect COM3 fs cp main.py           :main.py
mpremote connect COM3 reset
```

`main.py` 會在開機時自動執行。要看輸出：

```bash
mpremote connect COM3 repl
```

（也可以用 Thonny：把兩個檔案存到裝置上、按 Reset。）

## 3. 預期開機輸出

```
=== Greeny2 MicroPython device client ===
device_id = esp32-sensor
DS18B20 found: 1
WiFi: ('192.168.x.x', ...)
NTP ok: (2026, 10, 14, ...)
WSS connected: /device/esp32-sensor
-> {'type': 'telemetry', 'device_id': 'esp32-sensor', 'tds': 512, 'ec': 1024, ...}
```

## 4. 硬體與腳位（與 Arduino 版相同）

| 用途 | 腳位 | 備註 |
|---|---|---|
| LED | GPIO 2 | 兼作連線測試 |
| TDS（DFRobot SEN0244） | GPIO 35 | **ADC1**（WiFi 開啟時 ADC2 不可用） |
| pH 探頭 + 放大板 | GPIO 39 | ADC1 |
| DS18B20 水溫 | GPIO 13 | OneWire |

## 5. 與 Arduino 版的已知差異

| 項目 | Arduino 版 | MicroPython 版 |
|---|---|---|
| TLS 驗證 | 用 ESP32 內建 CA bundle 做完整驗證 | **預設 `TLS_VERIFY = False`**（MicroPython 沒有內建 CA bundle；連線仍加密，但不驗證伺服器身分）。要開啟驗證需自行提供 CA 憑證並確認固件支援 |
| 校正值儲存 | 存 EEPROM | **不持久化**：`calibrate` 只量測並回報，請把值寫回 `main.py` 的 `K_VALUE` / `EC_OFFSET` / `PH7_VOLTAGE` |
| WiFi 憑證 | 存 EEPROM（可透過 `wifi_set` 換） | `wifi_set` 可切換並在失敗時回滾，但**重開機後回到 `device_secrets.py` 的設定** |
| 序列埠校正 | 不支援（CH340 一開就 reset） | 同樣不建議 |

## 6. 首次上線檢查清單

1. **`DEVICE_TOKEN` 與 D1 一致** —— 不一致會被 Worker 以 **401** 拒絕（訊息 `Unauthorized device`）
2. **NTP 有同步成功** —— 沒有正確時鐘時 TLS 握手會失敗（MicroPython 可能只回模糊的 `OSError`）
3. **WiFi 是 2.4 GHz** —— ESP32 看不到 5 GHz
4. **ADC 讀值合理** —— 探頭乾掉或未接時 EC 會接近滿刻度
5. 從 Cloudflare 端確認裝置上線：
   ```bash
   curl -s https://iot-hub.ai-caseylai.workers.dev/api/devices \
        -H "Authorization: Bearer <JWT>"
   ```

## 7. 疑難排解

| 症狀 | 原因 / 對策 |
|---|---|
| 連上就立刻斷、一直重連 | `?token=` 不對（Worker 401）；或 `DEVICE_ID` 與路徑不符 |
| `handshake failed: HTTP/1.1 401` | device token 與 D1 `settings.device_token` 不一致 |
| `handshake failed: HTTP/1.1 404` | 路徑不是 `/device/...` 或 `/dashboard/...` |
| TLS 相關 `OSError` | 先確認 NTP 成功；或把 `TLS_VERIFY` 設為 `False` |
| `DS18B20 unavailable` | 探頭未接；`read_temp()` 會回 25.0 讓程式繼續跑 |
| 有送遙測但沒收到指令 | 檢查 `WSClient.recv_text()` 是否收到 `sync`；DO 只在裝置連線時轉發指令 |

---

## 檔案

| 檔案 | 用途 |
|---|---|
| `main.py` | 裝置客戶端（要上傳到 ESP32） |
| `device_secrets.example.py` | 憑證範本（進 repo） |
| `device_secrets.py` | 真實憑證（**gitignored，不進 repo**） |
| `README.md` | 本文件 |
