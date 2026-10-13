#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Greeny2 連線模擬 / 健康檢查工具
================================
唯讀工具：只做 GET 讀取與 WebSocket 訂閱，**不會**切換繼電器或修改任何資料。

用法:
    python greeny_probe.py

需要: requests, websockets  (pip install requests websockets)
"""

import asyncio
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests

try:
    import websockets
except ImportError:
    websockets = None

WORKER = "https://iot-hub.ai-caseylai.workers.dev"
PAGES = "https://greeny.techforliving.net"
DEVICE = "esp32-sensor"

# 故意錯誤的密碼，用來測試 Pages 端是否錯誤地接受 bcrypt 帳號
FAKE_PASSWORD = "WRONG-PASSWORD-DO-NOT-USE-1234"


def hr(title):
    print("\n" + "=" * 62)
    print(title)
    print("=" * 62)


# ── 1. 健康檢查 ────────────────────────────────────────────────────────────
def health():
    hr("1. 健康檢查（免認證）")
    for base in (WORKER, PAGES):
        try:
            r = requests.get(f"{base}/health", timeout=15)
            print(f"  {base}/health")
            print(f"    -> HTTP {r.status_code}  {r.text[:90]}")
        except Exception as e:
            print(f"  {base}/health -> 失敗: {type(e).__name__}: {e}")


# ── 2. 登入測試 ────────────────────────────────────────────────────────────
def login(base, username, password, label):
    hr(f"2. 登入測試 — {label}")
    print(f"  POST {base}/api/auth/login")
    print(f"  username = {username!r}")
    print(f"  password = {password!r}")
    try:
        r = requests.post(
            f"{base}/api/auth/login",
            json={"username": username, "password": password},
            timeout=25,
        )
        print(f"  -> HTTP {r.status_code}")
        print(f"  -> {r.text[:220]}")
        if r.status_code == 200:
            return r.json().get("token")
    except Exception as e:
        print(f"  -> 例外 {type(e).__name__}: {e}")
    return None


# ── 3. 讀取 API ────────────────────────────────────────────────────────────
def read_apis(base, token, label):
    hr(f"3. 以取得的 token 讀取 API — {label}")
    h = {"Authorization": f"Bearer {token}"}
    paths = [
        "/api/auth/me",
        "/api/devices",
        f"/api/telemetry?device_id={DEVICE}&limit=3",
        "/api/alerts?limit=3",
        "/api/offices",
    ]
    for p in paths:
        try:
            r = requests.get(f"{base}{p}", headers=h, timeout=25)
            body = " ".join(r.text.split())[:170]
            print(f"  GET {p:48s} -> {r.status_code}  {body}")
        except Exception as e:
            print(f"  GET {p:48s} -> 例外 {e}")


# ── 4. WebSocket 訂閱 ──────────────────────────────────────────────────────
async def ws_test(url, label, token=None):
    hr(f"4. WebSocket 訂閱 — {label}")
    if websockets is None:
        print("  跳過：未安裝 websockets")
        return
    full = f"{url}?token={token}" if token else url
    shown = f"{url}?token={'<JWT>' if token else ''}" if token else url
    print(f"  連線: {shown}")
    try:
        async with websockets.connect(full, open_timeout=20) as ws:
            print("  [OK] 已連上（HTTP 101 Switching Protocols）")
            for i in range(3):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=15)
                    print(f"  <- 收到 #{i+1}: {' '.join(str(msg).split())[:230]}")
                except asyncio.TimeoutError:
                    print("  (15 秒內未再收到訊息)")
                    break
    except Exception as e:
        print(f"  [FAIL] {type(e).__name__}: {e}")


# ── main ───────────────────────────────────────────────────────────────────
def main():
    print("Greeny2 連線模擬工具（唯讀，不會操作繼電器）")

    health()

    token = None
    pages_token = login(PAGES, "admin", FAKE_PASSWORD,
                        "Pages (greeny.techforliving.net)：故意使用『錯誤密碼』")
    if pages_token:
        print("\n  *** 注意：用錯誤密碼竟然拿到 token -> Pages 登入驗證有問題 ***")
        read_apis(PAGES, pages_token, "Pages API")
        token = pages_token

    worker_token = login(WORKER, "admin", "admin123",
                         "Worker (iot-hub.funconnect...)：使用 seed 預設密碼 admin123")
    if worker_token:
        read_apis(WORKER, worker_token, "Worker API")
        token = token or worker_token

    ws_url = WORKER.replace("https://", "wss://") + f"/dashboard/{DEVICE}"
    asyncio.run(ws_test(ws_url, "儀表板通道（刻意『不帶』token）"))

    if token:
        ws_url2 = WORKER.replace("https://", "wss://") + f"/dashboard/{DEVICE}"
        asyncio.run(ws_test(ws_url2, "儀表板通道（帶 JWT）", token))


if __name__ == "__main__":
    main()
