/**
 * DeviceHub — Durable Object (Phase 2+: SQLite + D1 alarm sync)
 *
 * Holds WebSocket connections from ESP32 and browser dashboards.
 * Forwards commands, broadcasts state. Uses WebSocket Hibernation.
 *
 * Non-negotiables:
 *  - ctx.acceptWebSocket(server) — NEVER server.accept()
 *  - ZERO awaits in webSocketMessage() — all storage via synchronous
 *    ctx.storage.sql.exec()
 *  - Constructor restores from deserializeAttachment() — no storage reads
 *  - All D1 access is in alarm() only, never in webSocketMessage()
 */

import { DurableObject } from "cloudflare:workers";

// ── Types ──────────────────────────────────────────────────────────────────

interface Attachment {
  role: "esp32" | "dashboard";
  deviceId?: string;
  connectedAt: number;
}

interface AlertDef {
  type: string;
  message: string;
  severity: "warning" | "critical";
}

interface Env {
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  DB: D1Database;
}

// ── DO Class ───────────────────────────────────────────────────────────────

export class DeviceHub extends DurableObject {
  private esp32ws: WebSocket | null = null;
  private dashboards = new Map<WebSocket, Attachment>();

  private ledState = false;
  private lastTelemetryMs = 0; // for bidirectional health check
  private esp32ConnectedAt = 0; // when the current device socket was accepted
  private tds = 0;
  private ec = 0;
  private ph = 7.0;
  private temp = 25.0;

  // Alert thresholds. D1 `settings` is the source of truth; this field is a
  // cache because the hot path (webSocketMessage) must never await. The
  // constructor restores it from DO-local storage and alarm() refreshes it from
  // D1 on every cycle, so an edit in the dashboard takes effect within ~60s.
  private thresholds = { phMin: 5.5, phMax: 8.5, ecMax: 2000, tempMin: 18, tempMax: 30 };

  // ── Constructor ────────────────────────────────────────────────────────

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS telemetry_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      tds REAL, ec REAL, ph REAL, temp REAL,
      led INTEGER DEFAULT 0,
      esp32_ms INTEGER, do_ms INTEGER,
      flushed INTEGER DEFAULT 0
    )`);

    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      command TEXT NOT NULL,
      params_json TEXT,
      created_at INTEGER
    )`);

    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS alert_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT DEFAULT 'warning',
      created_at INTEGER,
      flushed INTEGER DEFAULT 0
    )`);

    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS relay_log_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      command TEXT NOT NULL,
      params_json TEXT,
      status TEXT DEFAULT 'sent',
      created_at INTEGER,
      flushed INTEGER DEFAULT 0
    )`);

    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS device_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);

    // Restore the cached alert thresholds. The constructor cannot await, so this
    // reads the DO-local copy that alarm() keeps in sync with D1.
    try {
      const saved = [...ctx.storage.sql.exec(
        "SELECT value FROM device_state WHERE key = 'thresholds'"
      )][0];
      if (saved?.value) {
        this.thresholds = { ...this.thresholds, ...JSON.parse(saved.value as string) };
      }
    } catch { /* first run — keep the defaults */ }

    // Restore WebSocket connections from hibernation
    ctx.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment() as Attachment | null;
      if (meta?.role === "esp32") {
        this.esp32ws = ws;
      } else if (meta?.role === "dashboard") {
        this.dashboards.set(ws, meta);
      }
    });

    console.log(
      `[DO] constructor — esp32:${this.esp32ws ? "yes" : "no"}, dashboards:${this.dashboards.size}`
    );
  }

  // ── fetch(): WebSocket Upgrade ─────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // REST relay endpoint — allows HTTP POST commands (Casey protocol compat)
    if (url.pathname === "/relay-cmd" && request.method === "POST") {
      try {
        const body = await request.json() as {
          device_id?: string; relay1?: number; relay2?: number;
          state?: boolean; command?: string; params?: Record<string, unknown>;
        };
        const deviceId = body.device_id || "esp32-sensor";

        // GreenyAgent calibrate command — forward directly to ESP32 (QoS 0,
        // context-dependent, never queued)
        if (body.command === "calibrate" && body.params) {
          if (this.esp32ws) {
            this.esp32ws.send(JSON.stringify({
              command: "calibrate",
              params: {
                type: body.params.type || "ph",
                slope: body.params.slope,
                offset: body.params.offset,
                slope_pct: body.params.slope_pct,
              },
            }));
            return new Response(JSON.stringify({ ok: true, device_id: deviceId, command: "calibrate" }),
              { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
          }
          return new Response(JSON.stringify({ ok: false, device_id: deviceId,
            error: "ESP32 not connected — calibrate is QoS 0, cannot queue" }),
            { status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        }

        // Map relay1 or state to LED
        const ledState = typeof body.state === "boolean" ? body.state
          : (body.relay1 !== undefined ? body.relay1 === 1 : null);
        if (ledState !== null) {
          const paramsJson = JSON.stringify({ state: ledState });
          this.ctx.storage.sql.exec(
            `INSERT INTO relay_queue (device_id, command, params_json, created_at) VALUES (?,?,?,?)`,
            deviceId, "set_led", paramsJson, Date.now()
          );
          this.ctx.storage.sql.exec(
            `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at) VALUES (?,?,?,'sent',?)`,
            deviceId, "set_led", paramsJson, Date.now()
          );
          if (this.esp32ws) {
            this.esp32ws.send(JSON.stringify({ command: "set_led", params: { state: ledState } }));
          }
          return new Response(JSON.stringify({ ok: true, device_id: deviceId, led: ledState }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        }
        return new Response(JSON.stringify({ error: "relay1, state, or command required" }), { status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch {
        return new Response(JSON.stringify({ error: "invalid json" }), { status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
    }

    // --- Internal DO query endpoints (called by GreenyAgent DO) ---
    if (url.pathname === "/do-telemetry" && request.method === "GET") {
      try {
        const deviceId = url.searchParams.get("device_id") || "esp32-sensor";
        const cursor = this.ctx.storage.sql.exec(
          `SELECT tds, ec, ph, temp, led, do_ms
           FROM telemetry_buffer WHERE device_id = ?
           ORDER BY id DESC LIMIT 1`,
          deviceId,
        );
        const rows = [...cursor];
        if (rows.length === 0) {
          return new Response(
            JSON.stringify({ device_id: deviceId, status: "no_data" }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
          );
        }
        const r = rows[0];
        return new Response(
          JSON.stringify({
            device_id: deviceId,
            tds: r.tds, ec: r.ec, ph: r.ph, temp: r.temp,
            led: r.led === 1, do_ms: r.do_ms, status: "ok",
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
        );
      }
    }

    if (url.pathname === "/do-alerts" && request.method === "GET") {
      try {
        const deviceId = url.searchParams.get("device_id") || "esp32-sensor";
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "5"), 50);
        const cursor = this.ctx.storage.sql.exec(
          `SELECT alert_type, message, severity, created_at
           FROM alert_buffer WHERE device_id = ?
           ORDER BY id DESC LIMIT ?`,
          deviceId, limit,
        );
        const rows = [...cursor];
        return new Response(
          JSON.stringify({
            device_id: deviceId,
            alerts: rows.map((r) => ({
              type: r.alert_type,
              message: r.message,
              severity: r.severity,
              created_at: r.created_at,
            })),
            count: rows.length,
            status: "ok",
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
        );
      }
    }

    // --- WebSocket Upgrade ---
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const role: Attachment["role"] = url.pathname.includes("dashboard")
      ? "dashboard" : "esp32";

    const segments = url.pathname.split("/").filter(Boolean);
    const deviceId = segments.length >= 2 ? segments[1] : "unknown";

    const meta: Attachment = { role, deviceId, connectedAt: Date.now() };
    server.serializeAttachment(meta);

    if (role === "esp32") {
      // Purge stale relay queue on reconnect — calibration commands are
      // context-dependent (probe position matters) and replaying them
      // after a reboot/flash corrupts calibration state.
      this.ctx.storage.sql.exec(
        "DELETE FROM relay_queue WHERE device_id = ?", deviceId
      );
      console.log(`[DO] purged relay_queue for ${deviceId} on reconnect`);

      // Fix 3: close existing connection before replacing (prevents zombie sockets)
      if (this.esp32ws) {
        try { this.esp32ws.close(1000, "Replaced by new connection"); } catch {}
      }
      this.esp32ws = server;
      this.lastTelemetryMs = 0; // reset health check
      this.esp32ConnectedAt = Date.now();
      console.log(`[DO] ESP32 connected: ${deviceId}`);
      server.send(JSON.stringify({
        type: "sync", led: this.ledState, doTs: Date.now(),
      }));
      this.broadcast({ type: "device_status", device_id: deviceId, status: "online" });
    } else {
      this.dashboards.set(server, meta);
      console.log(`[DO] Dashboard connected (${this.dashboards.size} total)`);
      server.send(JSON.stringify({
        type: "state", device_id: deviceId,
        led: this.ledState, connected: this.esp32ws !== null,
        tds: this.tds, ec: this.ec, ph: this.ph, temp: this.temp,
        doTs: Date.now(),
      }));
    }

    // A brand-new DO has only the default thresholds until its first alarm, so
    // a device that connects right after a threshold change would alert against
    // stale numbers for a whole cycle. Run the alarm shortly after a device
    // connects (it re-schedules itself at the normal 60s cadence afterwards).
    // Dashboards keep the ordinary cadence.
    const justConnected =
      this.esp32ws !== null && this.esp32ConnectedAt > 0 &&
      Date.now() - this.esp32ConnectedAt < 5_000;
    await this.ctx.storage.setAlarm(Date.now() + (justConnected ? 1_000 : 60_000));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── webSocketMessage(): Hot Path (ZERO awaits) ─────────────────────────

  async webSocketMessage(ws: WebSocket, raw: string) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    try {
      const msg = JSON.parse(raw);
      if (meta?.role === "esp32") {
        if (msg.type === "telemetry") this.handleTelemetry(msg);
        else if (msg.type === "ack") this.handleAck(msg);
        else if (msg.type === "ping") {
          ws.send(JSON.stringify({
            type: "pong", seq: msg.seq,
            echo: `[DO] received ping seq=${msg.seq}`,
          }));
          // Fix 4: drain relay queue on ping for lower latency
          const pingDeviceId = (msg.device_id as string) || "esp32-sensor";
          this.drainRelayQueue(pingDeviceId);
        } else if (msg.type === "wifi_list") {
          this.broadcast(msg);
        } else if (msg.type === "wifi_ack") {
          this.broadcast(msg);
        }
      } else if (meta?.role === "dashboard") {
        // Casey protocol compat: {type:"relay", device_id, relay1, relay2}
        if (msg.type === "relay") {
          const ledState = typeof msg.relay1 === "number" ? msg.relay1 === 1 : !!msg.state;
          this.handleDashboardCommand({ command: "set_led", device_id: msg.device_id, state: ledState }, meta);
        } else {
          this.handleDashboardCommand(msg, meta);
        }
      }
    } catch (err) {
      console.log("[DO] Invalid JSON from", meta?.role, err);
    }
  }

  // ── Telemetry Handler ─────────────────────────────────────────────────

  private handleTelemetry(msg: Record<string, any>) {
    const deviceId = msg.device_id || "esp32-sensor";
    const now = Date.now();

    this.lastTelemetryMs = Date.now();
    this.tds = msg.tds as number;
    this.ec = msg.ec as number;
    this.ph = msg.ph as number;
    this.temp = msg.temp as number;
    if (typeof msg.led === "boolean") this.ledState = msg.led;

    this.ctx.storage.sql.exec(
      `INSERT INTO telemetry_buffer
         (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId, msg.tds, msg.ec, msg.ph, msg.temp,
      msg.led ? 1 : 0, msg.esp32_ms ?? 0, now
    );

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)",
      "ledState", this.ledState ? "1" : "0"
    );

    // Deduplicate alerts so one condition does not alert on every telemetry
    // frame. The old check filtered on `flushed = 0`, which only suppressed
    // duplicates until the next alarm flush — after that the same condition
    // alerted again, every 60s, forever. Use a cooldown window instead.
    const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
    const alerts = this.evaluateAlerts(this.ph, this.ec, this.temp);
    for (const a of alerts) {
      const recent = [...this.ctx.storage.sql.exec(
        "SELECT created_at FROM alert_buffer WHERE device_id = ? AND alert_type = ? ORDER BY id DESC LIMIT 1",
        deviceId, a.type
      )];
      const lastTs = recent.length ? Number(recent[0].created_at) : 0;
      if (lastTs && now - lastTs < ALERT_COOLDOWN_MS) {
        // Same condition within the cooldown — skip
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO alert_buffer (device_id, alert_type, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        deviceId, a.type, a.message, a.severity, now
      );
      this.broadcast({
        type: "alert", device_id: deviceId,
        alert_type: a.type, message: a.message, severity: a.severity, doTs: now,
      });
    }

    this.drainRelayQueue(deviceId);

    // Our native broadcast
    this.broadcast({
      type: "state", device_id: deviceId, led: this.ledState,
      connected: true,
      tds: this.tds, ec: this.ec, ph: this.ph, temp: this.temp,
      esp32_ms: msg.esp32_ms ?? 0,
      doTs: now,
    });

    // Casey protocol compat: telemetry_update for React app
    this.broadcast({
      type: "telemetry_update",
      device_id: deviceId,
      data: {
        ph: this.ph, tds: this.tds, ec: this.ec, water_temp: this.temp,
        relay1: this.ledState ? 1 : 0, relay2: 0,
      },
      ts_ms: now,
    });
  }

  // ── Ack Handler ───────────────────────────────────────────────────────

  private handleAck(msg: Record<string, any>) {
    if (typeof msg.led === "boolean") this.ledState = msg.led;
    const now = Date.now();
    const deviceId = (msg.device_id as string) || "esp32-sensor";

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)",
      "ledState", this.ledState ? "1" : "0"
    );

    // The device acknowledged the command — drop it from the durable queue.
    // Without this, drainRelayQueue() re-sent the same command on the next
    // telemetry/ping (delivered twice).
    const ackedCmd = (msg.command as string) || "unknown";
    this.ctx.storage.sql.exec(
      "DELETE FROM relay_queue WHERE device_id = ? AND command = ?",
      deviceId, ackedCmd
    );

    // Fix 2: audit trail — log the acknowledged command
    this.ctx.storage.sql.exec(
      `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
       VALUES (?, ?, ?, 'acked', ?)`,
      deviceId,
      ackedCmd,
      JSON.stringify({ led: this.ledState, esp32_ms: msg.esp32_ms }),
      now
    );

    console.log(
      `[DO] ESP32 ack: led=${this.ledState}, cmd=${msg.command}, doTs=${now}`
    );

    this.broadcast({
      type: "state", device_id: deviceId, led: this.ledState,
      connected: true, tds: this.tds, ec: this.ec, ph: this.ph, temp: this.temp,
      doTs: now,
    });
  }

  // ── Dashboard Command Handler ─────────────────────────────────────────

  private handleDashboardCommand(msg: Record<string, any>, meta: Attachment) {
    // Always queue command for durability — drainRelayQueue delivers on
    // next telemetry/ping even if ESP32 is temporarily disconnected.
    const deviceId = msg.device_id || meta.deviceId || "esp32-sensor";
    const now = Date.now();

    if (msg.command === "set_led") {
      const paramsJson = JSON.stringify({ state: msg.state });
      this.ctx.storage.sql.exec(
        `INSERT INTO relay_queue (device_id, command, params_json, created_at)
         VALUES (?, ?, ?, ?)`,
        deviceId, "set_led", paramsJson, now
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
         VALUES (?, ?, ?, 'sent', ?)`,
        deviceId, "set_led", paramsJson, now
      );
      if (this.esp32ws) {
        this.esp32ws.send(JSON.stringify({
          command: "set_led", params: { state: msg.state },
        }));
      }
      console.log(`[DO] queued set_led=${msg.state} (esp32 connected: ${!!this.esp32ws})`);
    } else if (msg.command === "calibrate") {
      // QoS 0 — calibrate is context-dependent (probe position matters).
      // Never queue in relay_queue. Forward directly if ESP32 connected,
      // drop if not. Audit trail still written to relay_log_buffer.
      const paramsJson = JSON.stringify(msg.params || {});
      this.ctx.storage.sql.exec(
        `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        deviceId, "calibrate", paramsJson,
        this.esp32ws ? "sent" : "dropped", now
      );
      if (this.esp32ws) {
        this.esp32ws.send(JSON.stringify({
          command: "calibrate", params: msg.params || {},
        }));
      }
      console.log(`[DO] calibrate ${msg.params?.type} → ${this.esp32ws ? "forwarded" : "dropped (ESP32 offline)"}`);
    } else if (msg.command) {
      // Generic passthrough: forward any unknown command to ESP32 directly.
      // Used by wifi_scan, wifi_set, and future commands.
      if (this.esp32ws) {
        this.esp32ws.send(JSON.stringify(msg));
        console.log(`[DO] forwarded ${msg.command} → ESP32`);
      } else {
        console.log(`[DO] dropped ${msg.command} — ESP32 offline`);
      }
    }
  }

  // ── Alert Thresholds ──────────────────────────────────────────────────

  private evaluateAlerts(ph: number, ec: number, temp: number): AlertDef[] {
    // Thresholds now come from D1 `settings` (cached on this.thresholds), not
    // from literals here — the settings page used to write only localStorage,
    // so changing a threshold had no effect on alerting at all.
    const t = this.thresholds;
    const alerts: AlertDef[] = [];
    if (ph < t.phMin) {
      alerts.push({ type: "ph_low", message: `pH 過低: ${ph}（下限 ${t.phMin}）`, severity: "warning" });
    } else if (ph > t.phMax) {
      alerts.push({ type: "ph_high", message: `pH 過高: ${ph}（上限 ${t.phMax}）`, severity: "warning" });
    }
    if (ec > t.ecMax) {
      alerts.push({ type: "ec_high", message: `EC 超出閾值: ${ec} μS/cm（上限 ${t.ecMax}）`, severity: "warning" });
    }
    if (temp < t.tempMin) {
      alerts.push({ type: "temp_low", message: `溫度過低: ${temp}°C（下限 ${t.tempMin}）`, severity: "warning" });
    } else if (temp > t.tempMax) {
      alerts.push({ type: "temp_high", message: `溫度過高: ${temp}°C（上限 ${t.tempMax}）`, severity: "warning" });
    }
    return alerts;
  }

  // ── Relay Queue Drain ─────────────────────────────────────────────────

  private drainRelayQueue(deviceId: string) {
    if (!this.esp32ws) return;
    // Collect first — the loop deletes from the table it is reading.
    const queued = [...this.ctx.storage.sql.exec(
      "SELECT id, command, params_json FROM relay_queue WHERE device_id = ? ORDER BY id ASC",
      deviceId
    )];
    for (const row of queued) {
      const params = row.params_json
        ? (JSON.parse(row.params_json as string) as Record<string, unknown>)
        : {};
      this.esp32ws.send(JSON.stringify({ command: row.command, params }));
      this.ctx.storage.sql.exec("DELETE FROM relay_queue WHERE id = ?", row.id);
      console.log(`[DO] relay drain: ${row.command} → ESP32`);
    }
  }

  // ── alarm(): D1 Flush (Cold Path) — FIX 1: resilient + FIX 3: last_seen ─
  //
  // Cloudflare doc: if alarm() throws 6 times (exponential backoff),
  // it permanently stops. Without setAlarm(), it never fires again.
  //
  // Non-negotiable: try/catch per row, outer try/catch, finally { setAlarm }

  async alarm() {
    console.log("[DO] alarm() firing");

    // --- Bidirectional health check ---
    // The device sends telemetry every 10s, so "connected but silent" means the
    // DO→ESP32 path is broken (common after deploys). Two cases to catch:
    //   1. nothing received since connect        (lastTelemetryMs === 0)
    //   2. received something, then it stopped   (stalled)
    // Case 2 was previously missed entirely: once the first telemetry arrived,
    // a dead half-open socket was never detected.
    const STALL_MS = 90_000;
    // Give a freshly accepted socket time to send its first frame — otherwise an
    // alarm firing seconds after connect would kill a perfectly healthy device.
    const CONNECT_GRACE_MS = 30_000;
    const connectedFor = this.esp32ConnectedAt ? Date.now() - this.esp32ConnectedAt : Number.POSITIVE_INFINITY;
    const silentSinceConnect = this.lastTelemetryMs === 0 && connectedFor > CONNECT_GRACE_MS;
    const stalled = this.lastTelemetryMs > 0 && Date.now() - this.lastTelemetryMs > STALL_MS;
    if (this.esp32ws && (silentSinceConnect || stalled)) {
      const stale = this.esp32ws.deserializeAttachment() as Attachment | null;
      const staleId = stale?.deviceId ?? "unknown";
      console.log(
        `[DO] health check FAILED (${silentSinceConnect ? `no telemetry in ${Math.round(connectedFor / 1000)}s since connect` : `stalled ${Math.round((Date.now() - this.lastTelemetryMs) / 1000)}s`}) — forcing reconnect for ${staleId}`
      );
      try { this.esp32ws.close(1000, "Health check failed — reconnect"); } catch {}
      this.esp32ws = null;
      this.lastTelemetryMs = 0;
      // NOTE: device_id used to be hardcoded to "esp32-sensor" here, which
      // misreported every other device. Use the connection's real id.
      this.broadcast({ type: "device_status", device_id: staleId, status: "offline" });
    }

    try {
      // --- Refresh alert thresholds from D1 settings ---
      // alarm() is the only DO entry point that may await, so this is where the
      // D1 values are pulled in. evaluateAlerts() then reads the cache
      // synchronously from the hot path.
      try {
        const rows = (await this.env.DB.prepare(
          "SELECT key, value FROM settings WHERE key IN ('ph_min','ph_max','ec_max','temp_min','temp_max')"
        ).all<{ key: string; value: string }>()).results ?? [];
        if (rows.length) {
          const num = (key: string, fallback: number) => {
            const hit = rows.find((r) => r.key === key);
            const n = hit ? parseFloat(String(hit.value)) : NaN;
            return Number.isFinite(n) ? n : fallback;
          };
          this.thresholds = {
            phMin: num("ph_min", this.thresholds.phMin),
            phMax: num("ph_max", this.thresholds.phMax),
            ecMax: num("ec_max", this.thresholds.ecMax),
            tempMin: num("temp_min", this.thresholds.tempMin),
            tempMax: num("temp_max", this.thresholds.tempMax),
          };
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO device_state (key, value) VALUES ('thresholds', ?)",
            JSON.stringify(this.thresholds)
          );
          console.log("[alarm] thresholds →", JSON.stringify(this.thresholds));
        }
      } catch (e) {
        console.error("[alarm] threshold refresh failed", e);
        // Keep the cached values — alerting must not stop because D1 is busy.
      }

      // --- Flush telemetry_buffer → D1 telemetry ---
      // Collect first: the loop mutates the table it is reading.
      const telRows = [...this.ctx.storage.sql.exec(
        "SELECT id, device_id, tds, ec, ph, temp, led, esp32_ms, do_ms FROM telemetry_buffer WHERE flushed = 0"
      )];
      for (const row of telRows) {
        try {
          const doMs = row.do_ms ?? Date.now();
          // ── Why this looks odd (it is all load-bearing) ──────────────
          // 1. FK: telemetry.device_id REFERENCES devices(id) and D1 ENFORCES
          //    foreign keys, so a device that was never registered made every
          //    insert fail. Register it first (same upsert the Pages telemetry
          //    POST uses).
          // 2. The D1 schema has `water_temp`, NOT `temp`, and has NO `led`
          //    column — the previous INSERT named three columns that do not
          //    exist (temp, led, esp32_ms), so EVERY flush failed silently and
          //    no device telemetry ever reached D1.
          // 3. `led` is stored as relay1 (the aquagreen-era writer did the same).
          // 4. `ts_ms` is NOT NULL and holds epoch ms for the history charts —
          //    do_ms (server epoch ms) fills both.
          await this.env.DB.prepare(
            `INSERT INTO devices (id, name, floor, location, status, last_seen)
             VALUES (?1, ?1, 1, '', 'online', ?2)
             ON CONFLICT(id) DO UPDATE SET status = 'online', last_seen = ?2`
          ).bind(row.device_id, Math.floor(doMs / 1000)).run();

          await this.env.DB.prepare(
            `INSERT INTO telemetry
               (device_id, tds, ec, ph, water_temp, relay1, esp32_ms, do_ms, ts_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)`
          ).bind(row.device_id, row.tds, row.ec, row.ph, row.temp, row.led ? 1 : 0,
                 row.esp32_ms, doMs).run();
          // Mark THIS row flushed only after a confirmed insert.
          // The old code ran one unconditional `UPDATE ... WHERE flushed = 0`
          // after the loop, so a failed insert was marked flushed anyway and the
          // sample was lost forever (at-most-once). Now a failure stays unflushed
          // and is retried on the next alarm cycle.
          this.ctx.storage.sql.exec(
            "UPDATE telemetry_buffer SET flushed = 1 WHERE id = ?", row.id
          );
        } catch (e) {
          console.error("[alarm] telemetry insert failed for row", row.id, e);
          // Don't rethrow — the row stays unflushed and will be retried.
        }
      }
      console.log(`[alarm] flushed ${telRows.length} telemetry rows`);

      // --- Flush alert_buffer → D1 alerts ---
      const alertRows = [...this.ctx.storage.sql.exec(
        "SELECT id, device_id, alert_type, message, severity, created_at FROM alert_buffer WHERE flushed = 0"
      )];
      // D1 `alerts.type` has a CHECK constraint limited to
      // ph_abnormal | ec_high | temp_abnormal | do_low | offline | water_low | leak
      // while evaluateAlerts() produces finer names (ph_low, ph_high, temp_low,
      // temp_high). Inserting those violated the constraint and every alert
      // flush failed. Map to the allowed vocabulary here; the precise detail is
      // still in `message` and in the WebSocket broadcast.
      const D1_ALERT_TYPE: Record<string, string> = {
        ph_low: "ph_abnormal",
        ph_high: "ph_abnormal",
        temp_low: "temp_abnormal",
        temp_high: "temp_abnormal",
        ec_high: "ec_high",
        offline: "offline",
      };
      for (const row of alertRows) {
        try {
          // FK: alerts.device_id REFERENCES devices(id) — same upsert as above.
          await this.env.DB.prepare(
            `INSERT INTO devices (id, name, floor, location, status, last_seen)
             VALUES (?1, ?1, 1, '', 'online', ?2)
             ON CONFLICT(id) DO UPDATE SET status = 'online', last_seen = ?2`
          ).bind(row.device_id, Math.floor((row.created_at ?? Date.now()) / 1000)).run();

          await this.env.DB.prepare(
            `INSERT INTO alerts (device_id, type, message, severity, created_at)
             VALUES (?1,?2,?3,?4,?5)`
          ).bind(row.device_id, D1_ALERT_TYPE[row.alert_type] ?? "ph_abnormal",
                 row.message, row.severity, Math.floor((row.created_at ?? Date.now()) / 1000)).run();
          this.ctx.storage.sql.exec(
            "UPDATE alert_buffer SET flushed = 1 WHERE id = ?", row.id
          );
        } catch (e) {
          console.error("[alarm] alert insert failed for row", row.id, e);
        }
      }
      console.log(`[alarm] flushed ${alertRows.length} alert rows`);

      // --- Flush relay_log_buffer → D1 relay_log (Fix 2) ---
      const relayRows = [...this.ctx.storage.sql.exec(
        "SELECT id, device_id, command, params_json, status, created_at FROM relay_log_buffer WHERE flushed = 0"
      )];
      for (const row of relayRows) {
        try {
          await this.env.DB.prepare(
            `INSERT INTO relay_log (device_id, command, params_json, status, created_at)
             VALUES (?1,?2,?3,?4,?5)`
          ).bind(row.device_id, row.command, row.params_json, row.status, row.created_at).run();
          this.ctx.storage.sql.exec(
            "UPDATE relay_log_buffer SET flushed = 1 WHERE id = ?", row.id
          );
        } catch (e) {
          console.error("[alarm] relay_log insert failed for row", row.id, e);
        }
      }
      console.log(`[alarm] flushed ${relayRows.length} relay_log rows`);

      // --- Update devices.last_seen (Fix 3) ---
      const devices = this.ctx.storage.sql.exec(
        `SELECT DISTINCT device_id, MAX(do_ms) as last_seen
         FROM telemetry_buffer WHERE flushed = 1 GROUP BY device_id`
      );
      for (const d of devices) {
        try {
          // `WHERE device_id = ?` never matched anything — the devices table
          // keys on `id`. And last_seen is epoch SECONDS (the telemetry_buffer
          // holds epoch ms), so convert.
          await this.env.DB.prepare(
            "UPDATE devices SET last_seen = ?, status = 'online' WHERE id = ?"
          ).bind(Math.floor((d.last_seen ?? 0) / 1000), d.device_id).run();
        } catch (e) {
          console.error("[alarm] device update failed", d.device_id, e);
        }
      }
      console.log("[alarm] updated device last_seen");

      // --- Purge old flushed rows to prevent unbounded growth ---
      // D1 rows-read quota: every alarm cycle scans flushed rows.
      // Without cleanup, a week of telemetry = 60K rows × 1,440 cycles
      // = 86M rows read/day just for the devices.last_seen query.
      this.ctx.storage.sql.exec(
        "DELETE FROM telemetry_buffer WHERE flushed = 1 AND id < (SELECT MAX(id) - 100 FROM telemetry_buffer)"
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM alert_buffer WHERE flushed = 1 AND id < (SELECT MAX(id) - 50 FROM alert_buffer)"
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM relay_log_buffer WHERE flushed = 1 AND id < (SELECT MAX(id) - 50 FROM relay_log_buffer)"
      );

      // relay_queue was the only table with no bound at all: queued commands
      // disappeared only when the device reconnected or drained them, so a device
      // that never comes back would grow the DO's SQLite forever. Keep the newest
      // 50 commands (device commands are small and idempotent).
      this.ctx.storage.sql.exec(
        "DELETE FROM relay_queue WHERE id NOT IN (SELECT id FROM relay_queue ORDER BY id DESC LIMIT 50)"
      );
    } catch (e) {
      console.error("[alarm] outer handler error:", e);
      // Outer catch — prevents alarm from exhausting retries on systemic failure
    } finally {
      // NON-NEGOTIABLE: always reschedule, even if D1 is completely down.
      // Without this, 6 consecutive failures permanently kill the alarm.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  // ── webSocketClose: Cleanup ───────────────────────────────────────────

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    const deviceId = meta?.deviceId || "esp32-sensor";

    if (meta?.role === "esp32") {
      this.esp32ws = null;
      console.log("[DO] ESP32 disconnected");

      // Update D1 device status to offline (best-effort)
      try {
        await this.env.DB.prepare(
          "UPDATE devices SET status = 'offline' WHERE device_id = ?"
        ).bind(deviceId).run();
      } catch (e) {
        console.error("[DO] failed to update device offline status", e);
      }

      this.broadcast({
        type: "state", device_id: deviceId,
        led: this.ledState, connected: false, doTs: Date.now(),
      });
      this.broadcast({ type: "device_status", device_id: deviceId, status: "offline" });
    } else if (meta?.role === "dashboard") {
      this.dashboards.delete(ws);
      console.log(`[DO] Dashboard disconnected (${this.dashboards.size} remain)`);
    }
    ws.close(code, reason);
  }

  // ── webSocketError: Same cleanup as close ─────────────────────────────

  async webSocketError(ws: WebSocket, error: unknown) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    console.log(`[DO] WebSocket error on ${meta?.role}:`, error);

    if (meta?.role === "esp32") {
      this.esp32ws = null;
      this.broadcast({
        type: "state",
        device_id: meta.deviceId || "esp32-sensor",
        led: this.ledState, connected: false, doTs: Date.now(),
      });
    } else if (meta?.role === "dashboard") {
      this.dashboards.delete(ws);
    }
  }

  // ── Broadcast Helper ──────────────────────────────────────────────────

  private broadcast(data: Record<string, unknown>) {
    const json = JSON.stringify(data);
    this.dashboards.forEach((_, ws) => {
      try { ws.send(json); } catch { this.dashboards.delete(ws); }
    });
  }
}
