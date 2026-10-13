#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Greeny2 連線測試工具
====================

一次驗證整條鏈路的每一段：Pages SPA → Pages 管理 API → Worker REST → 兩個 WebSocket
通道 → （選用）裝置認證。預設**唯讀**：不會開關繼電器、不會寫入遙測。

用法
----
    # 最簡單：用環境變數提供憑證
    set GREENY_USER=admin
    set GREENY_PASSWORD=<你的密碼>
    python greeny_check.py

    # 或全部用參數
    python greeny_check.py --user admin --password 'xxx'

    # 加上裝置通道與寫入測試（會以裝置身分註冊、會寫入一筆遙測）
    python greeny_check.py --device-token <device_token> --write-test

    # 給監控系統用：輸出 JSON、失敗時 exit code != 0
    python greeny_check.py --json

環境變數
--------
    GREENY_WORKER_HOST   預設 iot-hub.ai-caseylai.workers.dev
    GREENY_PAGES_HOST    預設 greeny.techforliving.net
    GREENY_DEVICE_ID     預設 esp32-sensor
    GREENY_USER / GREENY_PASSWORD / GREENY_DEVICE_TOKEN

需求
----
    pip install requests websockets
"""

import argparse
import asyncio
import json as jsonlib
import os
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import requests

try:
    import websockets
except ImportError:
    websockets = None


# ── 結果收集 ─────────────────────────────────────────────────────────────────

RESULTS = []          # (section, name, ok, detail, ms)
CRITICAL_FAILS = []   # 影響可用性的失敗


def record(section, name, ok, detail="", ms=None, critical=False):
    RESULTS.append((section, name, ok, detail, ms))
    if critical and not ok:
        CRITICAL_FAILS.append(f"{section} / {name}: {detail}")


def section(title):
    print(f"\n\033[1m── {title} ─────────────────────────────────────────\033[0m"
          if sys.stdout.isatty() else f"\n── {title} ──")


def line(name, ok, detail="", ms=None):
    mark = "PASS" if ok else "FAIL"
    t = f"  {ms:6.0f} ms" if ms is not None else "         "
    print(f"  [{mark}] {name:<40}{t}  {detail}")


def timed(fn):
    t0 = time.monotonic()
    try:
        out = fn()
        return out, (time.monotonic() - t0) * 1000, None
    except Exception as e:                      # noqa: BLE001
        return None, (time.monotonic() - t0) * 1000, e


# ── 測試項目 ─────────────────────────────────────────────────────────────────

def check_http(section_name, name, method, url, *, headers=None, json=None,
               expect=200, critical=False, timeout=20):
    def run():
        r = requests.request(method, url, headers=headers, json=json,
                             timeout=timeout, allow_redirects=True)
        return r

    r, ms, err = timed(run)
    if err is not None:
        record(section_name, name, False, f"{type(err).__name__}: {err}", ms, critical)
        line(name, False, f"{type(err).__name__}: {str(err)[:60]}", ms)
        return None
    ok = r.status_code == expect
    body = " ".join(r.text.split())[:88]
    record(section_name, name, ok, f"HTTP {r.status_code} {body}", ms, critical)
    line(name, ok, f"HTTP {r.status_code}  {body[:70]}", ms)
    return r


async def _ws_probe(url, timeout):
    """回傳 (狀態, 第一則訊息)。狀態為 'ok' / 'rejected' / 'error'。"""
    try:
        async with websockets.connect(url, open_timeout=timeout) as ws:
            first = None
            try:
                first = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                first = None
            return "ok", first, None
    except Exception as e:                                     # noqa: BLE001
        status = None
        resp = getattr(e, "response", None)
        if resp is not None:
            status = getattr(resp, "status_code", None)
        if status is None:                                     # 從字串撈狀態碼
            s = str(e)
            for code in (401, 403, 404, 500):
                if str(code) in s:
                    status = code
                    break
        return "rejected" if status else "error", status, str(e)


def check_ws(section_name, name, url, expect, *, critical=False, timeout=20,
             show_first=True):
    if websockets is None:
        record(section_name, name, False, "websockets 未安裝", None, critical)
        line(name, False, "websockets 未安裝")
        return None

    t0 = time.monotonic()
    status, payload, err = asyncio.run(_ws_probe(url, timeout))
    ms = (time.monotonic() - t0) * 1000

    if expect == "allow":
        ok = status == "ok"
        detail = "101 Switching Protocols"
        if ok and payload:
            detail += "  <- " + " ".join(str(payload).split())[:60]
    else:                                   # expect == "reject"
        code = payload if isinstance(payload, int) else None
        ok = status == "rejected" and (code == expect or expect == "reject")
        detail = f"HTTP {payload}" if isinstance(payload, int) else (err or "")[:50]

    record(section_name, name, ok, detail, ms, critical)
    line(name, ok, detail, ms)
    return payload


# ── 主流程 ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Greeny2 連線測試")
    ap.add_argument("--worker-host", default=os.environ.get(
        "GREENY_WORKER_HOST", "iot-hub.ai-caseylai.workers.dev"))
    ap.add_argument("--pages-host", default=os.environ.get(
        "GREENY_PAGES_HOST", "greeny.techforliving.net"))
    ap.add_argument("--device-id", default=os.environ.get("GREENY_DEVICE_ID", "esp32-sensor"))
    ap.add_argument("--user", default=os.environ.get("GREENY_USER", ""))
    ap.add_argument("--password", default=os.environ.get("GREENY_PASSWORD", ""))
    ap.add_argument("--device-token", default=os.environ.get("GREENY_DEVICE_TOKEN", ""))
    ap.add_argument("--device-ws-id", default=None,
                    help="裝置 WS 測試用的 device_id。預設為 <device-id>-probe —— "
                         "刻意不碰真實裝置：DO 只允許一個 esp32 連線，用真 id 會把上線中的裝置踢掉")
    ap.add_argument("--write-test", action="store_true",
                    help="額外測試 POST /api/telemetry（會寫入一筆遙測資料）")
    ap.add_argument("--json", action="store_true", help="以 JSON 輸出結果")
    ap.add_argument("--timeout", type=float, default=20)
    args = ap.parse_args()

    worker = f"https://{args.worker_host}"
    pages = f"https://{args.pages_host}"
    device_ws_id = args.device_ws_id or f"{args.device_id}-probe"
    blog = (lambda *a: None) if args.json else print

    if not args.json:
        print("Greeny2 連線測試")
        print(f"  Worker : {worker}")
        print(f"  Pages  : {pages}")
        print(f"  裝置   : {args.device_id}（REST）／{device_ws_id}（WS 探測，避免踢掉真實裝置）")

    # ── 1. 基礎連線 ──
    if not args.json:
        section("1. 基礎連線")
    check_http("1. 基礎連線", f"Worker /health ({args.worker_host})",
               "GET", f"{worker}/health", critical=True, timeout=args.timeout)
    check_http("1. 基礎連線", f"Pages / ({args.pages_host})",
               "GET", pages + "/", critical=True, timeout=args.timeout)

    # ── 2. 登入 ──
    tokens = {}
    if args.user and args.password:
        if not args.json:
            section("2. 使用者登入")
        for label, base in (("Worker", worker), ("Pages", pages)):
            r = check_http(f"2. 使用者登入（{label}）", f"{label} POST /api/auth/login",
                           "POST", f"{base}/api/auth/login",
                           json={"username": args.user, "password": args.password},
                           critical=True, timeout=args.timeout)
            if r is not None and r.status_code == 200:
                try:
                    tokens[label] = r.json().get("token", "")
                except Exception:
                    pass
        # 負向：錯誤密碼必須被拒絕
        check_http("2. 使用者登入", "Worker 錯誤密碼應被拒絕（401）",
                   "POST", f"{worker}/api/auth/login",
                   json={"username": args.user, "password": "__wrong__"},
                   expect=401, timeout=args.timeout)
    else:
        if not args.json:
            section("2. 使用者登入")
            print("  [SKIP] 未提供 --user / --password（或環境變數 GREENY_USER / GREENY_PASSWORD）")

    # ── 3. Worker REST（需 JWT）──
    if "Worker" in tokens:
        if not args.json:
            section("3. Worker REST API（JWT）")
        h = {"Authorization": f"Bearer {tokens['Worker']}"}
        for path in ("/api/auth/me", "/api/devices",
                     f"/api/telemetry?device_id={args.device_id}&limit=1",
                     "/api/alerts?limit=1"):
            check_http("3. Worker REST", f"GET {path}", "GET", worker + path,
                       headers=h, timeout=args.timeout)
        # 負向：無 token 必須 401
        check_http("3. Worker REST", "GET /api/devices 無 token 應被拒絕（401）",
                   "GET", f"{worker}/api/devices", expect=401, timeout=args.timeout)

    # ── 4. Pages 管理 API（需 JWT）──
    if "Pages" in tokens:
        if not args.json:
            section("4. Pages 管理 API（JWT）")
        h = {"Authorization": f"Bearer {tokens['Pages']}"}
        for path in ("/api/auth/me", "/api/offices", "/api/racks", "/api/users",
                     "/api/dashboard/stats"):
            check_http("4. Pages 管理 API", f"GET {path}", "GET", pages + path,
                       headers=h, timeout=args.timeout)
        check_http("4. Pages 管理 API", "GET /api/offices 無 token 應被拒絕（401）",
                   "GET", f"{pages}/api/offices", expect=401, timeout=args.timeout)

    # ── 5. 儀表板 WebSocket 認證 ──
    if not args.json:
        section("5. 儀表板 WebSocket 認證")
    ws_base = worker.replace("https://", "wss://")
    check_ws("5. 儀表板 WS", "不帶 token 應被拒絕（401）",
             f"{ws_base}/dashboard/{args.device_id}", expect=401, timeout=args.timeout)
    check_ws("5. 儀表板 WS", "帶假 token 應被拒絕（401）",
             f"{ws_base}/dashboard/{args.device_id}?token=bogus", expect=401,
             timeout=args.timeout)
    if "Worker" in tokens:
        check_ws("5. 儀表板 WS", "帶有效 JWT 應連上（101）",
                 f"{ws_base}/dashboard/{args.device_id}?token={tokens['Worker']}",
                 expect="allow", critical=True, timeout=args.timeout)

    # ── 6. 裝置通道（選用，需要 device token）──
    if args.device_token:
        if not args.json:
            section("6. 裝置 WebSocket（device token）")
        check_ws("6. 裝置 WS", "不帶 token 應被拒絕（401）",
                 f"{ws_base}/device/{device_ws_id}", expect=401, timeout=args.timeout)
        check_ws("6. 裝置 WS", "錯誤 device token 應被拒絕（401）",
                 f"{ws_base}/device/{device_ws_id}?token=wrong", expect=401,
                 timeout=args.timeout)
        check_ws("6. 裝置 WS", f"正確 device token 應連上並收到 sync（101）",
                 f"{ws_base}/device/{device_ws_id}?token={args.device_token}",
                 expect="allow", critical=True, timeout=args.timeout)

        if args.write_test:
            if not args.json:
                section("7. 遙測寫入（會新增一筆資料）")
            probe_id = f"greeny-check-{int(time.time()) % 100000}"
            r = check_http("7. 遙測寫入", f"POST /api/telemetry (device_id={probe_id})",
                           "POST", f"{pages}/api/telemetry",
                           headers={"X-Device-Token": args.device_token},
                           json={"device_id": probe_id, "ph": 6.8, "ec": 1200,
                                 "water_temp": 24.5},
                           timeout=args.timeout)
            check_http("7. 遙測寫入", "無憑證 POST 應被拒絕（401）",
                       "POST", f"{pages}/api/telemetry",
                       json={"device_id": probe_id}, expect=401, timeout=args.timeout)
            if r is not None and r.status_code == 200:
                print(f"\n  ℹ️  已寫入 device_id={probe_id}，如要清理：")
                print(f"      DELETE FROM telemetry WHERE device_id='{probe_id}';")
                print(f"      DELETE FROM devices   WHERE id='{probe_id}';")
    elif not args.json:
        section("6. 裝置 WebSocket")
        print("  [SKIP] 未提供 --device-token（或 GREENY_DEVICE_TOKEN）")

    # ── 總結 ──
    passed = sum(1 for r in RESULTS if r[2])
    total = len(RESULTS)

    if args.json:
        print(jsonlib.dumps({
            "ok": not CRITICAL_FAILS,
            "passed": passed,
            "total": total,
            "critical_failures": CRITICAL_FAILS,
            "results": [
                {"section": s, "name": n, "ok": ok, "detail": d, "ms": m}
                for s, n, ok, d, m in RESULTS
            ],
        }, ensure_ascii=False, indent=2))
    else:
        section("總結")
        print(f"  {passed}/{total} 項通過")
        if CRITICAL_FAILS:
            print("\n  \033[31m關鍵失敗：\033[0m" if sys.stdout.isatty() else "\n  關鍵失敗：")
            for f in CRITICAL_FAILS:
                print(f"    - {f}")
        else:
            print("  所有關鍵項目通過 ✅")

    return 1 if CRITICAL_FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
