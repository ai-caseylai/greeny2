# greeny2_sensor — ESP32 Arduino 精簡版

`greeny2_sensor.ino` 是 [完整版韌體](../esp32/esp32.ino) 的**精簡重寫**：協定完全相同，
但只保留必要邏輯，方便閱讀與修改。

| | 完整版 `firmware/esp32/esp32.ino` | **精簡版 `greeny2_sensor.ino`** |
|---|---|---|
| 行數 | ~1000 | ~380 |
| OLED 顯示 | ✅ SSD1306 | ❌ |
| WiFi Captive Portal（AP 模式設定） | ✅ | ❌（改用 WSS `wifi_scan` / `wifi_set`） |
| 校正值持久化 | ✅ EEPROM | ❌ 常數（`calibrate` 只回報量測值） |
| WiFi 憑證來源 | EEPROM ＋ `wifi.env` | `device_secrets.h` |
| WiFi 切換回滾 | ✅ | ✅ |
| 看門狗（30s 重連） | ✅ | ✅ |
| 遙測 / ping / ack / 指令 | ✅ | ✅（相同協定） |
| 驗證狀態 | ✅ 曾在實機運行 | ✅ **編譯通過**（arduino-cli 1.5.1 ＋ esp32 core 3.3.12）<br>⚠️ 尚未上機 |

## 為什麼有兩版

完整版是**生產版本**（歷史上在實機跑過、功能最齊）。
精簡版是為了讓人讀懂 —— 完整版混了 OLED、Captive Portal、EEPROM、序列校正，
要看懂「怎麼跟 Greeny2 通訊」得先剝掉一半程式碼。

> 建議：**要上線用完整版**；要理解或改寫協定邏輯看精簡版（或
> [MicroPython 版](../esp32-micropython/main.py)）。

## 編譯驗證結果

```
arduino-cli 1.5.1 ／ esp32:esp32 core 3.3.12
Sketch uses 1115705 bytes (85%) of program storage space. Maximum is 1310720 bytes.
Global variables use 48456 bytes (14%) of dynamic memory, leaving 279224 bytes for local variables.
```

只有 OneWire 函式庫自身的 `extra tokens at end of #undef directive` warning，與本程式無關。
**尚未在實體硬體上執行過**，請先燒錄並觀察序列埠輸出。

## 資料夾結構（Arduino IDE 要求資料夾名稱 = .ino 名稱）

```
greeny2_sensor/
├── greeny2_sensor.ino     ← 要編譯的檔
└── device_secrets.h       ← 憑證（已 gitignore，請自行建立）
```

`device_secrets.h` 內容：

```cpp
#define WIFI_SSID "你的 2.4GHz WiFi"
#define WIFI_PASS "你的密碼"
#define WS_TOKEN  "<D1 settings.device_token>"
```

沒有這個檔案也能編譯，但會用佔位值 → 連線會被 Worker 以 **401** 拒絕。

## 編譯與燒錄

```bash
arduino-cli lib install WebSockets@2.7.2
arduino-cli lib install ArduinoJson@7.4.3
arduino-cli lib install OneWire@2.3.8
arduino-cli lib install DallasTemperature@4.0.6

arduino-cli compile --fqbn esp32:esp32:esp32 firmware/greeny2_sensor
arduino-cli upload  --fqbn esp32:esp32:esp32 -p COM3 firmware/greeny2_sensor
arduino-cli monitor -p COM3 -c baudrate=115200
```

## 預期開機輸出

```
=== Greeny2 ESP32 sensor (lean) ===
device_id = esp32-sensor
WiFi OK  IP=192.168.x.x  RSSI=-52 dBm
NTP syncing... OK
WSS: wss://iot-hub.ai-caseylai.workers.dev:443/device/esp32-sensor?token=***
WSS connected
sync  led=0
TX  EC=1024 TDS=512 pH=6.80 T=24.5 LED=0
```

## 疑難排解

| 症狀 | 原因 |
|---|---|
| `WSS: ...` 後一直重連、Serial 沒有 `WSS connected` | `WS_TOKEN` 不對 → Worker 回 401（用 `wrangler tail iot-hub` 看得到 `rejected device`） |
| NTP FAILED | 網路不通或 DNS 被擋；TLS 握手會因此失敗 |
| `EC` 讀值接近滿刻度 | 探頭乾掉或未接 SEN0244 |
| `pH` 固定約 3.3 V | pH 放大板缺失或探頭未接 |
| `set_led` 沒反應 | 參數要包在 `params`（見 `.ino` 內註解） |
| 校正指令沒反應 | `calibrate` 是 QoS 0，裝置離線時會被丟棄 |

## 與完整版的取捨

如果你需要 **OLED 顯示**、**沒有網路時用手機連 AP 設定 WiFi**、或**校正值斷電後保留**，
請用 `firmware/esp32/esp32.ino`；那些功能這個精簡版沒有實作。
