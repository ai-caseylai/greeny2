# device_secrets.py —— 複製本檔為 device_secrets.py 並填入真實值
#
# device_secrets.py 已列入 .gitignore，**不要提交進 repo**。
#
# DEVICE_TOKEN 必須與 D1 `settings.device_token` 相同：
#     SELECT value FROM settings WHERE key = 'device_token';
# 這與 Arduino 版 firmware/esp32/device_secrets.h 用的是同一個 token。

WIFI_SSID    = "YOUR_SSID"        # 2.4 GHz only（ESP32 看不到 5 GHz）
WIFI_PASS    = "YOUR_PASSWORD"

DEVICE_ID    = "esp32-sensor"     # 對應 Worker 路徑 /device/<DEVICE_ID>
DEVICE_TOKEN = "REPLACE_WITH_DEVICE_TOKEN"

WS_HOST      = "iot-hub.ai-caseylai.workers.dev"
