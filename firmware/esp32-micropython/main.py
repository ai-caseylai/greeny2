"""
Greeny2 — ESP32 MicroPython 裝置客戶端
======================================

與 Arduino 版韌體 (`firmware/esp32/esp32.ino`) 行為一致：

  * 連線   wss://<WS_HOST>/device/<DEVICE_ID>?token=<DEVICE_TOKEN>
  * 每 10 秒送一次 `telemetry`
  * 接收 `sync` / `set_led` / `calibrate` / `wifi_scan` / `wifi_set`，並回 `ack`
  * 30 秒沒收到任何 inbound 資料 → 強制重連（修復半開連線）
  * 每 10 秒發一次應用層 `ping`（DO 會回 `pong`）

憑證放在 `device_secrets.py`（已列入 .gitignore），**不要提交進 repo**。

依賴：MicroPython 官方 ESP32 固件（內建 `json` / `socket` / `ssl` / `onewire` / `ds18x20`）。
本檔自行實作 WebSocket handshake 與 frame 編解碼，不需要額外套件。

⚠️ 本檔未在實體硬體上驗證過（開發環境沒有 ESP32）。首次使用請先看 README.md 的
   檢查清單，特別是 TLS 與 ADC 兩處。
"""

import time
import json
import struct
import socket
import ssl
import network
from machine import Pin, ADC
from os import urandom

# ─────────────────────────────────────────────────────────────────────────────
# 設定
# ─────────────────────────────────────────────────────────────────────────────

try:
    from device_secrets import (          # noqa: F401
        WIFI_SSID, WIFI_PASS, DEVICE_ID, DEVICE_TOKEN, WS_HOST,
    )
except ImportError:
    # 沒有 device_secrets.py 時的佔位值：Worker 會以 401 拒絕，這是預期的。
    raise SystemExit(
        "缺少 device_secrets.py。請複製 device_secrets.example.py 並填入：\n"
        "  WIFI_SSID / WIFI_PASS / DEVICE_ID / DEVICE_TOKEN / WS_HOST"
    )

WS_PORT = 443
TELEMETRY_INTERVAL_MS = const(10_000)     # 送遙測的間隔
WATCHDOG_MS = const(30_000)               # 超過此時間沒有 inbound 就重連
SOCK_TIMEOUT_S = 1                        # 每輪 socket 讀取等待時間（秒）
CONNECT_TIMEOUT_S = 15

# TLS 憑證驗證：
#   False = 加密但不驗證伺服器身分（MicroPython ESP32 沒有內建 CA bundle，
#           官方 Arduino 版用的是 ESP32 內建 CA bundle，MicroPython 沒有對應物）
#   True  = 需自行把 CA 憑證放到 flash 並確認固件支援 cadata/cert
TLS_VERIFY = False

# 校正值（Arduino 版存在 EEPROM；MicroPython 版直接放常數，需要時再改）
K_VALUE = 1.0            # EC 斜率
EC_OFFSET = 0.0          # EC 零點偏移
PH7_VOLTAGE = 1.65       # pH 7.0 對應電壓
VREF = 3.3

# 腳位（與 Arduino 版一致）
LED_PIN = const(2)
TDS_PIN = const(35)      # ADC1
PH_PIN = const(39)       # ADC1
ONEWIRE_PIN = const(13)

# 執行期狀態（給 wifi_set 回滾用）
_wifi_state = {"ssid": WIFI_SSID, "pass": WIFI_PASS, "old": None, "pending": False}


# ─────────────────────────────────────────────────────────────────────────────
# 極簡 WebSocket 客戶端（RFC 6455，client 端必 mask）
# ─────────────────────────────────────────────────────────────────────────────

def _b64(data):
    """base64 編碼（MicroPython 的 binascii.b2a_base64 會多一個換行）。"""
    import binascii
    return binascii.b2a_base64(data).strip().decode()


class WSClient:
    OP_TEXT = 0x1
    OP_CLOSE = 0x8
    OP_PING = 0x9
    OP_PONG = 0xA

    def __init__(self, sock):
        self.s = sock
        self.buf = b""

    # ---- 低階 I/O ----
    def _read_exact(self, n):
        out = b""
        while len(out) < n:
            try:
                chunk = self.s.read(n - len(out))
            except OSError:
                raise                          # timeout 往上拋，主迴圈會處理
            if chunk is None:
                continue
            if not chunk:
                raise OSError("connection closed")
            out += chunk
        return out

    def _read_until(self, delim, limit=4096):
        out = b""
        while delim not in out:
            chunk = self.s.read(1)
            if not chunk:
                raise OSError("connection closed during handshake")
            out += chunk
            if len(out) > limit:
                raise OSError("handshake response too large")
        return out

    # ---- handshake ----
    def handshake(self, host, path, port):
        key = _b64(urandom(16))
        req = (
            "GET {path} HTTP/1.1\r\n"
            "Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).format(path=path, host=host, port=port, key=key)
        self.s.write(req.encode())

        header = self._read_until(b"\r\n\r\n")
        status = header.split(b"\r\n", 1)[0]
        if b" 101" not in status:
            raise OSError("handshake failed: " + status.decode(errors="replace"))
        return True

    # ---- frame ----
    def send(self, text):
        self._send_frame(self.OP_TEXT, text.encode())
        return True

    def _send_frame(self, opcode, payload=b""):
        n = len(payload)
        head = bytearray([0x80 | opcode])          # FIN + opcode
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        mask = urandom(4)
        head += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i % 4]
        self.s.write(bytes(head) + bytes(masked))

    def recv_text(self, timeout_s=SOCK_TIMEOUT_S):
        """回傳一條文字訊息；逾時回 None；連線關閉回 False。"""
        self.s.settimeout(timeout_s)
        try:
            while True:
                chunk = self.s.read(2)
                if not chunk:
                    return False
                while len(chunk) < 2:
                    more = self.s.read(2 - len(chunk))
                    if not more:
                        return False
                    chunk += more

                b1, b2 = chunk[0], chunk[1]
                opcode = b1 & 0x0F
                masked = b2 & 0x80
                ln = b2 & 0x7F
                if ln == 126:
                    ln = struct.unpack(">H", self._read_exact(2))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", self._read_exact(8))[0]
                mask = self._read_exact(4) if masked else None
                data = self._read_exact(ln) if ln else b""
                if mask:
                    data = bytearray(data)
                    for i in range(len(data)):
                        data[i] ^= mask[i % 4]
                    data = bytes(data)

                if opcode == self.OP_PING:
                    self._send_frame(self.OP_PONG, data)
                    continue
                if opcode == self.OP_PONG:
                    continue
                if opcode == self.OP_CLOSE:
                    return False
                if opcode == self.OP_TEXT:
                    return data.decode(errors="replace")
                # binary / continuation 忽略
        except OSError:
            return None                            # timeout —— 正常，交給主迴圈


# ─────────────────────────────────────────────────────────────────────────────
# 感測器
# ─────────────────────────────────────────────────────────────────────────────

led = Pin(LED_PIN, Pin.OUT)
tds_adc = ADC(Pin(TDS_PIN))
ph_adc = ADC(Pin(PH_PIN))
for _adc in (tds_adc, ph_adc):
    try:
        _adc.atten(ADC.ATTN_11DB)              # 0 ~ 3.3 V
        _adc.width(ADC.WIDTH_12BIT)            # 0 ~ 4095
    except Exception:
        pass

_ow = None
_ds = None
try:
    import onewire
    import ds18x20
    _ow = onewire.OneWire(Pin(ONEWIRE_PIN))
    _ds = ds18x20.DS18X20(_ow)
    _roms = _ds.scan()
    print("DS18B20 found:", len(_roms))
except Exception as e:                          # 沒有溫度探頭也要能跑
    print("DS18B20 unavailable:", e)


def _voltage(adc):
    try:
        return adc.read_uv() / 1_000_000.0     # 新版 MicroPython 有 read_uv
    except AttributeError:
        return adc.read() / 4095.0 * VREF


def read_temp():
    if _ds is None or not _roms:
        return 25.0
    try:
        _ds.convert_temp()
        time.sleep_ms(750)
        return _ds.read_temp(_roms[0])
    except Exception:
        return 25.0


def read_ec(temp):
    """DFRobot SEN0244 三次多項式；先扣 offset 再做溫度補償（順序不可換）。"""
    v = _voltage(tds_adc)
    ec_raw = (133.42 * v * v * v - 255.86 * v * v + 857.39 * v) * K_VALUE
    return (ec_raw - EC_OFFSET) / (1.0 + 0.02 * (temp - 25.0))


def read_tds(temp):
    return read_ec(temp) * 0.5


def read_ph():
    v = _voltage(ph_adc)
    return 7.0 + (v - PH7_VOLTAGE) / 0.059


# ─────────────────────────────────────────────────────────────────────────────
# WiFi / NTP
# ─────────────────────────────────────────────────────────────────────────────

wlan = network.WLAN(network.STA_IF)


def wifi_connect(ssid=None, password=None):
    ssid = ssid or _wifi_state["ssid"]
    password = password if password is not None else _wifi_state["pass"]
    if not wlan.active():
        wlan.active(True)
    if wlan.isconnected():
        return True
    wlan.connect(ssid, password)
    t0 = time.time()
    while not wlan.isconnected():
        if time.time() - t0 > 30:
            return False
        time.sleep(0.5)
    print("WiFi:", wlan.ifconfig())
    return True


def ntp_sync():
    """TLS 需要正確時鐘，否則憑證會被判定失效（ESP32 開機時間是 1970）。"""
    try:
        import ntptime
        for _ in range(3):
            try:
                ntptime.settime()
                print("NTP ok:", time.localtime()[:6])
                return True
            except Exception as e:
                print("NTP retry:", e)
                time.sleep(1)
    except ImportError:
        print("ntptime 不可用")
    return False


# ─────────────────────────────────────────────────────────────────────────────
# 指令處理
# ─────────────────────────────────────────────────────────────────────────────

def send_ack(ws, command, status="ok", **extra):
    msg = {"type": "ack", "device_id": DEVICE_ID, "command": command, "status": status}
    msg.update(extra)
    ws.send(json.dumps(msg))


def do_wifi_scan(ws):
    try:
        nets = []
        for n in wlan.scan():
            ssid = n[0].decode(errors="replace") if isinstance(n[0], bytes) else str(n[0])
            if not ssid:
                continue
            nets.append({"ssid": ssid, "rssi": n[3], "enc": 1 if n[4] else 0})
        nets.sort(key=lambda x: -x["rssi"])
        ws.send(json.dumps({"type": "wifi_list", "device_id": DEVICE_ID, "networks": nets}))
        print("wifi_scan ->", len(nets), "networks")
    except Exception as e:
        print("wifi_scan failed:", e)
        send_ack(ws, "wifi_scan", "error")


def do_wifi_set(ws, params):
    ssid = params.get("ssid")
    password = params.get("pass", "")
    if not ssid:
        send_ack(ws, "wifi_set", "error", msg="ssid required")
        return
    _wifi_state["old"] = (_wifi_state["ssid"], _wifi_state["pass"])
    _wifi_state["ssid"], _wifi_state["pass"] = ssid, password
    _wifi_state["pending"] = True
    print("wifi_set ->", ssid)
    wlan.disconnect()
    time.sleep(0.5)
    wlan.connect(ssid, password)


def check_wifi_set(ws, start_ms):
    """wifi_set 的結果監看：成功回報 IP，逾時則回滾到前一組網路。"""
    if not _wifi_state["pending"]:
        return
    if wlan.isconnected():
        _wifi_state["pending"] = False
        ip = wlan.ifconfig()[0]
        print("wifi_set ok:", ip)
        send_ack(ws, "wifi_set", "ok", ip=ip)
    elif time.ticks_diff(time.ticks_ms(), start_ms) > 20_000:
        _wifi_state["pending"] = False
        old = _wifi_state["old"]
        print("wifi_set failed — rollback to", old)
        if old:
            _wifi_state["ssid"], _wifi_state["pass"] = old
            wlan.disconnect()
            time.sleep(0.3)
            wlan.connect(old[0], old[1])
        send_ack(ws, "wifi_set", "error", msg="connection failed, reverted")


CAL_TYPES = ("reset", "ec_zero", "ec_1413", "ec_value", "ph_4", "ph_7", "ph_9")


def do_calibrate(ws, params):
    """
    校正（QoS 0：Worker 端不會排隊，裝置離線就丟棄）。
    MicroPython 版沒有 EEPROM 校正儲存，這裡只做「量測並回報」，
    讓使用者自行把建議值寫回 main.py 的 K_VALUE / EC_OFFSET / PH7_VOLTAGE。
    """
    global K_VALUE, EC_OFFSET, PH7_VOLTAGE
    ctype = (params or {}).get("type", "")
    if ctype not in CAL_TYPES:
        send_ack(ws, "calibrate", "error", msg="unknown calibrate type: %s" % ctype)
        return

    v_tds = _voltage(tds_adc)
    v_ph = _voltage(ph_adc)

    if ctype == "reset":
        K_VALUE, EC_OFFSET, PH7_VOLTAGE = 1.0, 0.0, 1.65
        send_ack(ws, "calibrate", "ok", note="reset to defaults")
        print("CAL:RESET")
        return

    if ctype == "ph_7":
        PH7_VOLTAGE = v_ph
        print("ph7Voltage =", round(v_ph, 4))

    send_ack(ws, "calibrate", "ok",
             params={"type": ctype, "v_tds": round(v_tds, 4), "v_ph": round(v_ph, 4)},
             note="值僅回報，請寫回 main.py 常數")


def handle_message(ws, raw):
    try:
        msg = json.loads(raw)
    except Exception:
        print("bad json:", raw[:80])
        return

    if msg.get("type") == "sync":
        led.value(1 if msg.get("led") else 0)
        print("sync led =", msg.get("led"))
        return

    cmd = msg.get("command")
    if cmd == "set_led":
        state = bool((msg.get("params") or {}).get("state", msg.get("state")))
        led.value(1 if state else 0)
        send_ack(ws, "set_led", "ok", led=state)
        print("set_led ->", state)
    elif cmd == "calibrate":
        do_calibrate(ws, msg.get("params") or {})
    elif cmd == "wifi_scan":
        do_wifi_scan(ws)
    elif cmd == "wifi_set":
        do_wifi_set(ws, msg.get("params") or {})
    elif cmd:
        print("unknown command:", cmd)
        send_ack(ws, cmd, "error", msg="unsupported")


# ─────────────────────────────────────────────────────────────────────────────
# 連線
# ─────────────────────────────────────────────────────────────────────────────

def open_ws():
    path = "/device/%s?token=%s" % (DEVICE_ID, DEVICE_TOKEN)
    addr = socket.getaddrinfo(WS_HOST, WS_PORT)[0][-1]
    raw = socket.socket()
    raw.settimeout(CONNECT_TIMEOUT_S)
    raw.connect(addr)

    if TLS_VERIFY:
        sock = ssl.wrap_socket(raw, server_hostname=WS_HOST)
    else:
        try:
            sock = ssl.wrap_socket(raw, server_hostname=WS_HOST, cert_reqs=ssl.CERT_NONE)
        except TypeError:
            sock = ssl.wrap_socket(raw, server_hostname=WS_HOST)

    ws = WSClient(sock)
    ws.handshake(WS_HOST, path, WS_PORT)
    print("WSS connected:", path.rsplit("?", 1)[0])
    return ws


def send_telemetry(ws):
    temp = read_temp()
    ec = read_ec(temp)
    payload = {
        "type": "telemetry",
        "device_id": DEVICE_ID,
        "tds": round(read_tds(temp)),
        "ec": round(ec),
        "ph": round(read_ph(), 2),
        "temp": round(temp, 1),
        "led": bool(led.value()),
        "esp32_ms": time.ticks_ms(),
    }
    ws.send(json.dumps(payload))
    print("->", payload)


# ─────────────────────────────────────────────────────────────────────────────
# 主程式
# ─────────────────────────────────────────────────────────────────────────────

def main():
    print("=== Greeny2 MicroPython device client ===")
    print("device_id =", DEVICE_ID)

    while not wifi_connect():
        print("WiFi failed — retry in 5s")
        time.sleep(5)

    ntp_sync()

    ws = None
    last_tx = last_rx = time.ticks_ms()
    wifi_set_start = 0

    while True:
        try:
            if ws is None:
                ws = open_ws()
                last_rx = time.ticks_ms()

            now = time.ticks_ms()

            # 每 10 秒：送遙測 + 應用層 ping（同時當心跳）
            if time.ticks_diff(now, last_tx) >= TELEMETRY_INTERVAL_MS:
                send_telemetry(ws)
                ws.send(json.dumps({"type": "ping", "device_id": DEVICE_ID, "seq": now // 1000}))
                last_tx = now

            # 看門狗：30 秒沒有 inbound → 半開連線，重連
            if time.ticks_diff(now, last_rx) > WATCHDOG_MS:
                print("[WD] no inbound for 30s — reconnecting")
                raise OSError("watchdog")

            raw = ws.recv_text(SOCK_TIMEOUT_S)
            if raw is False:
                raise OSError("closed by server")
            if raw:
                last_rx = time.ticks_ms()
                handle_message(ws, raw)

            if _wifi_state["pending"]:
                check_wifi_set(ws, wifi_set_start or time.ticks_ms())
                if wifi_set_start == 0:
                    wifi_set_start = time.ticks_ms()
            else:
                wifi_set_start = 0

        except Exception as e:
            print("connection problem:", e, "— reconnect in 5s")
            try:
                if ws:
                    ws.s.close()
            except Exception:
                pass
            ws = None
            time.sleep(5)
            if not wlan.isconnected():
                wifi_connect()


if __name__ == "__main__":
    main()
