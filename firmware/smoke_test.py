"""Smoke test: ESP32 firmware via WSS dashboard.
Usage: python3 smoke_test.py
Requires: pip install websocket-client
"""
import websocket
import json
import sys
import time

WS_URL = "wss://iot-hub.funconnect.workers.dev/dashboard/esp32-sensor"
DEVICE = "esp32-sensor"

passed = 0
failed = 0

def test(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}{' — ' + detail if detail else ''}")
    else:
        failed += 1
        print(f"  FAIL  {name}{' — ' + detail if detail else ''}")

print(f"Connecting to {WS_URL}...")
try:
    ws = websocket.create_connection(WS_URL, timeout=10)
except Exception as e:
    print(f"FATAL: Cannot connect: {e}")
    sys.exit(1)

ws.settimeout(3)
acks = []
states = []

# Eat initial state
try:
    msg = ws.recv()
    data = json.loads(msg)
    if data.get("type") == "state":
        states.append(data)
except:
    pass

# ── S4: LED ON ──
print("S4: LED toggle...")
cmd = {"command": "set_led", "device_id": DEVICE, "state": True, "ts": int(time.time() * 1000)}
ws.send(json.dumps(cmd))
time.sleep(2)
led_on = False
for _ in range(5):
    try:
        data = json.loads(ws.recv())
        if data.get("type") == "ack": acks.append(data)
        if data.get("type") == "state": states.append(data)
        if data.get("led") == True: led_on = True
    except:
        break
test("set_led ON  → led=True in state", led_on, f"got {len(states)} states, {len(acks)} acks")

# LED OFF
cmd["state"] = False
cmd["ts"] = int(time.time() * 1000)
ws.send(json.dumps(cmd))
time.sleep(2)
led_off = False
for _ in range(5):
    try:
        data = json.loads(ws.recv())
        if data.get("type") == "ack": acks.append(data)
        if data.get("type") == "state": states.append(data)
        if data.get("led") == False: led_off = True
    except:
        break
test("set_led OFF → led=False in state", led_off)

# ── S5: CAL:RESET ──
print("S5: CAL:RESET...")
cmd = {"command": "calibrate", "device_id": DEVICE, "params": {"type": "reset"}, "ts": int(time.time() * 1000)}
ws.send(json.dumps(cmd))
time.sleep(2)
cal_ack = False
for _ in range(5):
    try:
        data = json.loads(ws.recv())
        if data.get("type") == "ack": acks.append(data)
        if data.get("type") == "state": states.append(data)
        if data.get("command") == "calibrate" and data.get("status") == "ok":
            cal_ack = True
    except:
        break
test("CAL:RESET acknowledged", cal_ack, f"got {len(acks)} total acks")

# ── S6: Telemetry fields ──
print("S6: Telemetry fields...")
latest = states[-1] if states else {}
has_id = latest.get("device_id") == DEVICE
has_ec = latest.get("ec", 0) != 0
has_tds = isinstance(latest.get("tds"), (int, float))
has_ph = isinstance(latest.get("ph"), (int, float))
has_temp = latest.get("temp", 0) > 0
has_ms = latest.get("esp32_ms", 0) > 0
test("device_id", has_id)
test("ec != 0", has_ec, f"ec={latest.get('ec')}")
test("tds present", has_tds, f"tds={latest.get('tds')}")
test("ph present", has_ph, f"ph={latest.get('ph')}")
test("temp > 0", has_temp, f"temp={latest.get('temp')}")
test("esp32_ms > 0", has_ms, f"esp32_ms={latest.get('esp32_ms')}")

# ── S7: DS18B20 ──
temp = latest.get("temp", 0)
test("DS18B20 temp plausible (10-40°C)", 10 <= temp <= 40, f"temp={temp}")

# ── S8: EC check ──
ec = latest.get("ec", 0)
if ec > 4000:
    test("EC in range (100-3000)", False, f"ec={ec} — probe is DRY or disconnected")
elif ec < 10:
    test("EC in range (10-3000)", False, f"ec={ec} — ecOffset may be consuming signal")
else:
    test("EC in range (10-3000)", True, f"ec={ec}")

ws.close()

print(f"\n{'='*40}")
print(f"RESULTS: {passed} passed, {failed} failed")
if failed:
    print(f"WARN: {failed} smoke test(s) failed — check output above")
    sys.exit(1)
else:
    print("All smoke tests passed.")
