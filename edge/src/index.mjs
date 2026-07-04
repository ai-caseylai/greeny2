// src/device-hub.ts
import { DurableObject } from "cloudflare:workers";
var DeviceHub = class extends DurableObject {
  esp32ws = null;
  dashboards = /* @__PURE__ */ new Map();
  ledState = false;
  tds = 0;
  ec = 0;
  ph = 7;
  temp = 25;
  // ── Constructor ────────────────────────────────────────────────────────
  constructor(ctx, env) {
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
    ctx.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment();
      if (meta?.role === "esp32") {
        this.esp32ws = ws;
      } else if (meta?.role === "dashboard") {
        this.dashboards.set(ws, meta);
      }
    });
    console.log(
      `[DO] constructor \u2014 esp32:${this.esp32ws ? "yes" : "no"}, dashboards:${this.dashboards.size}`
    );
  }
  // ── fetch(): WebSocket Upgrade ─────────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/relay-cmd" && request.method === "POST") {
      try {
        const body = await request.json();
        const deviceId2 = body.device_id || "esp32-sensor";
        if (body.command === "calibrate" && body.params) {
          if (this.esp32ws) {
            this.esp32ws.send(JSON.stringify({
              command: "calibrate",
              params: {
                type: body.params.type || "ph",
                slope: body.params.slope,
                offset: body.params.offset,
                slope_pct: body.params.slope_pct
              }
            }));
            return new Response(
              JSON.stringify({ ok: true, device_id: deviceId2, command: "calibrate" }),
              { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
            );
          }
          return new Response(
            JSON.stringify({
              ok: false,
              device_id: deviceId2,
              error: "ESP32 not connected \u2014 calibrate is QoS 0, cannot queue"
            }),
            { status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }
        const ledState = typeof body.state === "boolean" ? body.state : body.relay1 !== void 0 ? body.relay1 === 1 : null;
        if (ledState !== null) {
          const paramsJson = JSON.stringify({ state: ledState });
          this.ctx.storage.sql.exec(
            `INSERT INTO relay_queue (device_id, command, params_json, created_at) VALUES (?,?,?,?)`,
            deviceId2,
            "set_led",
            paramsJson,
            Date.now()
          );
          this.ctx.storage.sql.exec(
            `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at) VALUES (?,?,?,'sent',?)`,
            deviceId2,
            "set_led",
            paramsJson,
            Date.now()
          );
          if (this.esp32ws) {
            this.esp32ws.send(JSON.stringify({ command: "set_led", params: { state: ledState } }));
          }
          return new Response(
            JSON.stringify({ ok: true, device_id: deviceId2, led: ledState }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }
        return new Response(JSON.stringify({ error: "relay1, state, or command required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch {
        return new Response(JSON.stringify({ error: "invalid json" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }
    if (url.pathname === "/do-telemetry" && request.method === "GET") {
      try {
        const deviceId2 = url.searchParams.get("device_id") || "esp32-sensor";
        const cursor = this.ctx.storage.sql.exec(
          `SELECT tds, ec, ph, temp, led, do_ms
           FROM telemetry_buffer WHERE device_id = ?
           ORDER BY id DESC LIMIT 1`,
          deviceId2
        );
        const rows = [...cursor];
        if (rows.length === 0) {
          return new Response(
            JSON.stringify({ device_id: deviceId2, status: "no_data" }),
            { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
          );
        }
        const r = rows[0];
        return new Response(
          JSON.stringify({
            device_id: deviceId2,
            tds: r.tds,
            ec: r.ec,
            ph: r.ph,
            temp: r.temp,
            led: r.led === 1,
            do_ms: r.do_ms,
            status: "ok"
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }
    }
    if (url.pathname === "/do-alerts" && request.method === "GET") {
      try {
        const deviceId2 = url.searchParams.get("device_id") || "esp32-sensor";
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "5"), 50);
        const cursor = this.ctx.storage.sql.exec(
          `SELECT alert_type, message, severity, created_at
           FROM alert_buffer WHERE device_id = ?
           ORDER BY id DESC LIMIT ?`,
          deviceId2,
          limit
        );
        const rows = [...cursor];
        return new Response(
          JSON.stringify({
            device_id: deviceId2,
            alerts: rows.map((r) => ({
              type: r.alert_type,
              message: r.message,
              severity: r.severity,
              created_at: r.created_at
            })),
            count: rows.length,
            status: "ok"
          }),
          { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ status: "error", message: String(err) }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const role = url.pathname.includes("dashboard") ? "dashboard" : "esp32";
    const segments = url.pathname.split("/").filter(Boolean);
    const deviceId = segments.length >= 2 ? segments[1] : "unknown";
    const meta = { role, deviceId, connectedAt: Date.now() };
    server.serializeAttachment(meta);
    if (role === "esp32") {
      this.ctx.storage.sql.exec(
        "DELETE FROM relay_queue WHERE device_id = ?",
        deviceId
      );
      console.log(`[DO] purged relay_queue for ${deviceId} on reconnect`);
      if (this.esp32ws) {
        try {
          this.esp32ws.close(1e3, "Replaced by new connection");
        } catch {
        }
      }
      this.esp32ws = server;
      console.log(`[DO] ESP32 connected: ${deviceId}`);
      server.send(JSON.stringify({
        type: "sync",
        led: this.ledState,
        doTs: Date.now()
      }));
      this.broadcast({ type: "device_status", device_id: deviceId, status: "online" });
    } else {
      this.dashboards.set(server, meta);
      console.log(`[DO] Dashboard connected (${this.dashboards.size} total)`);
      server.send(JSON.stringify({
        type: "state",
        device_id: deviceId,
        led: this.ledState,
        connected: this.esp32ws !== null,
        tds: this.tds,
        ec: this.ec,
        ph: this.ph,
        temp: this.temp,
        doTs: Date.now()
      }));
    }
    await this.ctx.storage.setAlarm(Date.now() + 6e4);
    return new Response(null, { status: 101, webSocket: client });
  }
  // ── webSocketMessage(): Hot Path (ZERO awaits) ─────────────────────────
  async webSocketMessage(ws, raw) {
    const meta = ws.deserializeAttachment();
    try {
      const msg = JSON.parse(raw);
      if (meta?.role === "esp32") {
        if (msg.type === "telemetry") this.handleTelemetry(msg);
        else if (msg.type === "ack") this.handleAck(msg);
        else if (msg.type === "ping") {
          ws.send(JSON.stringify({
            type: "pong",
            seq: msg.seq,
            echo: `[DO] received ping seq=${msg.seq}`
          }));
          const pingDeviceId = msg.device_id || "esp32-sensor";
          this.drainRelayQueue(pingDeviceId);
        }
      } else if (meta?.role === "dashboard") {
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
  handleTelemetry(msg) {
    const deviceId = msg.device_id || "esp32-sensor";
    const now = Date.now();
    this.tds = msg.tds;
    this.ec = msg.ec;
    this.ph = msg.ph;
    this.temp = msg.temp;
    if (typeof msg.led === "boolean") this.ledState = msg.led;
    this.ctx.storage.sql.exec(
      `INSERT INTO telemetry_buffer
         (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId,
      msg.tds,
      msg.ec,
      msg.ph,
      msg.temp,
      msg.led ? 1 : 0,
      msg.esp32_ms ?? 0,
      now
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)",
      "ledState",
      this.ledState ? "1" : "0"
    );
    const alerts = this.evaluateAlerts(this.ph, this.ec, this.temp);
    for (const a of alerts) {
      const existing = this.ctx.storage.sql.exec(
        "SELECT id FROM alert_buffer WHERE device_id = ? AND alert_type = ? AND flushed = 0 LIMIT 1",
        deviceId,
        a.type
      );
      const rows = [...existing];
      if (rows.length > 0) {
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO alert_buffer (device_id, alert_type, message, severity, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        deviceId,
        a.type,
        a.message,
        a.severity,
        now
      );
      this.broadcast({
        type: "alert",
        device_id: deviceId,
        alert_type: a.type,
        message: a.message,
        severity: a.severity,
        doTs: now
      });
    }
    this.drainRelayQueue(deviceId);
    this.broadcast({
      type: "state",
      device_id: deviceId,
      led: this.ledState,
      connected: true,
      tds: this.tds,
      ec: this.ec,
      ph: this.ph,
      temp: this.temp,
      esp32_ms: msg.esp32_ms ?? 0,
      doTs: now
    });
    this.broadcast({
      type: "telemetry_update",
      device_id: deviceId,
      data: {
        ph: this.ph,
        tds: this.tds,
        ec: this.ec,
        water_temp: this.temp,
        relay1: this.ledState ? 1 : 0,
        relay2: 0
      },
      ts_ms: now
    });
  }
  // ── Ack Handler ───────────────────────────────────────────────────────
  handleAck(msg) {
    if (typeof msg.led === "boolean") this.ledState = msg.led;
    const now = Date.now();
    const deviceId = msg.device_id || "esp32-sensor";
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)",
      "ledState",
      this.ledState ? "1" : "0"
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
       VALUES (?, ?, ?, 'acked', ?)`,
      deviceId,
      msg.command || "unknown",
      JSON.stringify({ led: this.ledState, esp32_ms: msg.esp32_ms }),
      now
    );
    console.log(
      `[DO] ESP32 ack: led=${this.ledState}, cmd=${msg.command}, doTs=${now}`
    );
    this.broadcast({
      type: "state",
      device_id: deviceId,
      led: this.ledState,
      connected: true,
      tds: this.tds,
      ec: this.ec,
      ph: this.ph,
      temp: this.temp,
      doTs: now
    });
  }
  // ── Dashboard Command Handler ─────────────────────────────────────────
  handleDashboardCommand(msg, meta) {
    const deviceId = msg.device_id || meta.deviceId || "esp32-sensor";
    const now = Date.now();
    if (msg.command === "set_led") {
      const paramsJson = JSON.stringify({ state: msg.state });
      this.ctx.storage.sql.exec(
        `INSERT INTO relay_queue (device_id, command, params_json, created_at)
         VALUES (?, ?, ?, ?)`,
        deviceId,
        "set_led",
        paramsJson,
        now
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
         VALUES (?, ?, ?, 'sent', ?)`,
        deviceId,
        "set_led",
        paramsJson,
        now
      );
      if (this.esp32ws) {
        this.esp32ws.send(JSON.stringify({
          command: "set_led",
          params: { state: msg.state }
        }));
      }
      console.log(`[DO] queued set_led=${msg.state} (esp32 connected: ${!!this.esp32ws})`);
    } else if (msg.command === "calibrate") {
      const paramsJson = JSON.stringify(msg.params || {});
      this.ctx.storage.sql.exec(
        `INSERT INTO relay_log_buffer (device_id, command, params_json, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        deviceId,
        "calibrate",
        paramsJson,
        this.esp32ws ? "sent" : "dropped",
        now
      );
      if (this.esp32ws) {
        this.esp32ws.send(JSON.stringify({
          command: "calibrate",
          params: msg.params || {}
        }));
      }
      console.log(`[DO] calibrate ${msg.params?.type} \u2192 ${this.esp32ws ? "forwarded" : "dropped (ESP32 offline)"}`);
    }
  }
  // ── Alert Thresholds ──────────────────────────────────────────────────
  evaluateAlerts(ph, ec, temp) {
    const alerts = [];
    if (ph < 5.5) {
      alerts.push({ type: "ph_low", message: `pH \u8FC7\u4F4E: ${ph}`, severity: "warning" });
    } else if (ph > 8.5) {
      alerts.push({ type: "ph_high", message: `pH \u8FC7\u9AD8: ${ph}`, severity: "warning" });
    }
    if (ec > 2e3) {
      alerts.push({ type: "ec_high", message: `EC \u8D85\u51FA\u9608\u503C: ${ec} \u03BCS/cm`, severity: "warning" });
    }
    if (temp < 18) {
      alerts.push({ type: "temp_low", message: `\u6E29\u5EA6\u8FC7\u4F4E: ${temp}\xB0C`, severity: "warning" });
    } else if (temp > 30) {
      alerts.push({ type: "temp_high", message: `\u6E29\u5EA6\u8FC7\u9AD8: ${temp}\xB0C`, severity: "warning" });
    }
    return alerts;
  }
  // ── Relay Queue Drain ─────────────────────────────────────────────────
  drainRelayQueue(deviceId) {
    if (!this.esp32ws) return;
    const cursor = this.ctx.storage.sql.exec(
      "SELECT id, command, params_json FROM relay_queue WHERE device_id = ? ORDER BY id ASC",
      deviceId
    );
    for (const row of cursor) {
      const params = row.params_json ? JSON.parse(row.params_json) : {};
      this.esp32ws.send(JSON.stringify({ command: row.command, params }));
      this.ctx.storage.sql.exec("DELETE FROM relay_queue WHERE id = ?", row.id);
      console.log(`[DO] relay drain: ${row.command} \u2192 ESP32`);
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
    try {
      const telCursor = this.ctx.storage.sql.exec(
        "SELECT id, device_id, tds, ec, ph, temp, led, esp32_ms, do_ms FROM telemetry_buffer WHERE flushed = 0"
      );
      for (const row of telCursor) {
        try {
          await this.env.DB.prepare(
            `INSERT INTO telemetry (device_id, tds, ec, ph, temp, led, esp32_ms, do_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
          ).bind(
            row.device_id,
            row.tds,
            row.ec,
            row.ph,
            row.temp,
            row.led,
            row.esp32_ms,
            row.do_ms
          ).run();
        } catch (e) {
          console.error("[alarm] telemetry insert failed for row", row.id, e);
        }
      }
      this.ctx.storage.sql.exec(
        "UPDATE telemetry_buffer SET flushed = 1 WHERE flushed = 0"
      );
      console.log("[alarm] flushed telemetry_buffer");
      const alertCursor = this.ctx.storage.sql.exec(
        "SELECT id, device_id, alert_type, message, severity, created_at FROM alert_buffer WHERE flushed = 0"
      );
      for (const row of alertCursor) {
        try {
          await this.env.DB.prepare(
            `INSERT INTO alerts (device_id, alert_type, message, severity, created_at)
             VALUES (?1,?2,?3,?4,?5)`
          ).bind(row.device_id, row.alert_type, row.message, row.severity, row.created_at).run();
        } catch (e) {
          console.error("[alarm] alert insert failed for row", row.id, e);
        }
      }
      this.ctx.storage.sql.exec(
        "UPDATE alert_buffer SET flushed = 1 WHERE flushed = 0"
      );
      console.log("[alarm] flushed alert_buffer");
      const relayCursor = this.ctx.storage.sql.exec(
        "SELECT id, device_id, command, params_json, status, created_at FROM relay_log_buffer WHERE flushed = 0"
      );
      for (const row of relayCursor) {
        try {
          await this.env.DB.prepare(
            `INSERT INTO relay_log (device_id, command, params_json, status, created_at)
             VALUES (?1,?2,?3,?4,?5)`
          ).bind(row.device_id, row.command, row.params_json, row.status, row.created_at).run();
        } catch (e) {
          console.error("[alarm] relay_log insert failed for row", row.id, e);
        }
      }
      this.ctx.storage.sql.exec(
        "UPDATE relay_log_buffer SET flushed = 1 WHERE flushed = 0"
      );
      console.log("[alarm] flushed relay_log_buffer");
      const devices = this.ctx.storage.sql.exec(
        `SELECT DISTINCT device_id, MAX(do_ms) as last_seen
         FROM telemetry_buffer WHERE flushed = 1 GROUP BY device_id`
      );
      for (const d of devices) {
        try {
          await this.env.DB.prepare(
            "UPDATE devices SET last_seen = ?, status = 'online' WHERE device_id = ?"
          ).bind(d.last_seen, d.device_id).run();
        } catch (e) {
          console.error("[alarm] device update failed", d.device_id, e);
        }
      }
      console.log("[alarm] updated device last_seen");
      this.ctx.storage.sql.exec(
        "DELETE FROM telemetry_buffer WHERE flushed = 1 AND id < (SELECT MAX(id) - 100 FROM telemetry_buffer)"
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM alert_buffer WHERE flushed = 1 AND id < (SELECT MAX(id) - 50 FROM alert_buffer)"
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM relay_log_buffer WHERE flushed = 1 AND id < (SELECT MAX(id) - 50 FROM relay_log_buffer)"
      );
    } catch (e) {
      console.error("[alarm] outer handler error:", e);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 6e4);
    }
  }
  // ── webSocketClose: Cleanup ───────────────────────────────────────────
  async webSocketClose(ws, code, reason, wasClean) {
    const meta = ws.deserializeAttachment();
    const deviceId = meta?.deviceId || "esp32-sensor";
    if (meta?.role === "esp32") {
      this.esp32ws = null;
      console.log("[DO] ESP32 disconnected");
      try {
        await this.env.DB.prepare(
          "UPDATE devices SET status = 'offline' WHERE device_id = ?"
        ).bind(deviceId).run();
      } catch (e) {
        console.error("[DO] failed to update device offline status", e);
      }
      this.broadcast({
        type: "state",
        device_id: deviceId,
        led: this.ledState,
        connected: false,
        doTs: Date.now()
      });
      this.broadcast({ type: "device_status", device_id: deviceId, status: "offline" });
    } else if (meta?.role === "dashboard") {
      this.dashboards.delete(ws);
      console.log(`[DO] Dashboard disconnected (${this.dashboards.size} remain)`);
    }
    ws.close(code, reason);
  }
  // ── webSocketError: Same cleanup as close ─────────────────────────────
  async webSocketError(ws, error) {
    const meta = ws.deserializeAttachment();
    console.log(`[DO] WebSocket error on ${meta?.role}:`, error);
    if (meta?.role === "esp32") {
      this.esp32ws = null;
      this.broadcast({
        type: "state",
        device_id: meta.deviceId || "esp32-sensor",
        led: this.ledState,
        connected: false,
        doTs: Date.now()
      });
    } else if (meta?.role === "dashboard") {
      this.dashboards.delete(ws);
    }
  }
  // ── Broadcast Helper ──────────────────────────────────────────────────
  broadcast(data) {
    const json2 = JSON.stringify(data);
    this.dashboards.forEach((_, ws) => {
      try {
        ws.send(json2);
      } catch {
        this.dashboards.delete(ws);
      }
    });
  }
};

// src/agent.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";
var SYSTEM_PROMPT = `You are Greeny, a hydroponics AI assistant. You watch sensor data
from an ESP32 monitoring a hydroponic system. Your job is to translate
numbers into plant health. Normal is silence \u2014 only report deviations.

pH: 5.5-7.0 is optimal for most hydroponic crops. Below 5.0 or above
8.0 needs attention. If pH drifts slowly over days, probe needs
recalibration. If pH suddenly jumps to -10 or 34.95, probe is
disconnected \u2014 check BNC connector and amplifier board.

EC: 800-2000 \xB5S/cm is typical. EC=0 means sensor disconnected. EC
rising without nutrient change means temperature effect (2%/\xB0C is
normal physics). EC above 3000 needs dilution.

Temperature: 18-28\xB0C optimal. Below 15\xB0C roots slow. Above 30\xB0C
stresses plants, increases pathogen risk.

Alerts: If you see ph_high or ph_low alerts that persist across
multiple readings, the condition is real \u2014 don't dismiss it.
Check if the probe was recently calibrated. If it was 30+ days ago,
suggest recalibration.

Tone: Be warm, precise, plant-focused. Don't list raw JSON. Say
'Your basil is thriving \u2014 pH 6.2 and stable' not 'pH: 6.2, EC: 1200.'
When something is wrong, explain what, why, and what to do.`;
var TOOLS_WAIChat = [
  {
    name: "query_telemetry",
    description: "Get the latest sensor reading (tds, ec, ph, temp, led) for a device from live telemetry",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID, e.g. 'esp32-sensor'" }
      },
      required: ["device_id"]
    }
  },
  {
    name: "check_alerts",
    description: "Get recent alerts for a device from the alert buffer",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID" },
        limit: { type: "integer", description: "Max alerts to return (default 5)" }
      },
      required: ["device_id"]
    }
  },
  {
    name: "toggle_led",
    description: "Turn the grow LED on or off for a device",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID" },
        state: { type: "string", enum: ["on", "off"], description: "Desired LED state" }
      },
      required: ["device_id", "state"]
    }
  },
  {
    name: "get_history",
    description: "Get historical trend data for a metric (ph, ec, tds, temp) from D1 cold storage. Returns an array of {ts, value} in chronological order.",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID" },
        metric: { type: "string", enum: ["ph", "ec", "tds", "temp"], description: "Which metric to retrieve" },
        limit: { type: "integer", description: "Max data points (default 60)" }
      },
      required: ["device_id", "metric"]
    }
  }
];
var GreenyAgent = class _GreenyAgent extends DurableObject2 {
  // ── Constructor: create SQLite tables for calibration state ─────────────
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS calibration_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      probe_type TEXT NOT NULL,
      status TEXT DEFAULT 'awaiting_point1',
      point1_value REAL,
      point1_mv REAL,
      point2_value REAL,
      point2_mv REAL,
      slope REAL,
      offset REAL,
      slope_pct REAL,
      created_at INTEGER,
      completed_at INTEGER
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workflow_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
  }
  // ── HTTP Request Handler ───────────────────────────────────────────────
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
    if (url.pathname === "/api/chat" && method === "POST") {
      try {
        const body = await request.json();
        if (!body.message || typeof body.message !== "string") {
          return json({ error: "message required (string)" }, 400);
        }
        const reply = await this.chat(body.message);
        return json({ reply });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[GreenyAgent] chat error:", msg);
        return json({ error: "Internal error", detail: msg }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  }
  // ── Model Routing ────────────────────────────────────────────────────────
  //
  // Three tiers based on query complexity:
  //   CHEAP   — prompt-based text generation, pre-fetch context, 0 tool calls
  //   CAPABLE — native function calling, model decides which tools to invoke
  //   REASON  — pure chain-of-thought reasoning for hard diagnostics
  static MODEL_CHEAP = "@cf/meta/llama-3.2-3b-instruct";
  static MODEL_CAPABLE = "@cf/qwen/qwen3-30b-a3b-fp8";
  static MODEL_REASON = "@cf/qwen/qwq-32b";
  // ── Chat (multi-model router) ─────────────────────────────────────────────
  /** Classify user intent to route to the right model tier */
  classifyIntent(msg) {
    if (msg.match(/turn\s+(on|off)\s+(the\s+)?(led|light)/i)) return "action";
    if (msg.match(/^(calibrate|start calibration|run calibration|begin calibration)/i)) return "action";
    if (msg.match(/calibrate\s+(ph|ec|tds|the)/i)) return "action";
    const metaMarkers = [
      "what can you do",
      "what are you",
      "who are you",
      "how do you work",
      "how are you built",
      "your architecture",
      "what tools",
      "what api",
      "your capabilit",
      "your skills",
      "can you see",
      "can you access",
      "do you have access",
      "yourself",
      "tell me about yourself",
      "what do you know",
      "how were you",
      "what model",
      "are you an ai",
      "are you a bot",
      "explain yourself",
      "describe yourself",
      "your design"
    ];
    if (metaMarkers.some((m) => msg.includes(m))) return "meta";
    const complexMarkers = [
      "why",
      "diagnose",
      "plan",
      "recommend",
      "schedule",
      "what should",
      "how do i fix",
      "how do i adjust",
      "compare",
      "analyze",
      "predict",
      "suggest",
      "optimise",
      "optimize",
      "investigate",
      "troubleshoot",
      "imagine",
      "could you",
      "would you",
      "what if",
      "future",
      "skill",
      "capabilit"
    ];
    if (complexMarkers.some((m) => msg.includes(m))) return "complex";
    const metricHits = ["ph", "ec", "tds", "temp", "temperature"].filter(
      (m) => msg.includes(m)
    ).length;
    if (metricHits >= 2) return "complex";
    if (msg.includes("over the last") || msg.includes("over the past") || msg.includes("this week") || msg.includes("trend") || msg.includes("changing") || msg.includes("drifting")) return "complex";
    return "simple";
  }
  /** Route action commands (LED, calibration) to existing handlers */
  async handleActions(msg, deviceId) {
    const ledMatch = msg.match(/turn\s+(on|off)\s+(the\s+)?(led|light)/i);
    if (ledMatch) {
      const state = ledMatch[1].toLowerCase();
      const result = await this.tool_toggleLed(deviceId, state);
      if (result.ok) {
        return `The LED is now ${state}. ${state === "on" ? "Your plants are getting extra light for photosynthesis." : "The light is off \u2014 your plants are in their dark cycle."}`;
      }
      return `I tried to turn the LED ${state}, but the device may be offline. The command is queued and will run when the ESP32 reconnects.`;
    }
    if (msg.match(/^(calibrate|start calibration|run calibration|begin calibration)/i) || msg.match(/calibrate\s+(ph|ec|tds|the)/i)) {
      return this.handleCalibration(msg, deviceId);
    }
    const calKeywords = [
      "ready",
      "done",
      "ok",
      "go",
      "yes",
      "cancel",
      "stop",
      "abort",
      "status",
      "step",
      "where"
    ];
    const activeSession = this.getActiveCalibration(deviceId);
    if (activeSession && calKeywords.some((k) => msg.includes(k))) {
      return this.handleCalibration(msg, deviceId);
    }
    return null;
  }
  /** Main router — classify intent, dispatch to correct model tier */
  async chat(userMessage) {
    if (!this.env?.AI) {
      return "I'm not fully configured yet \u2014 the AI service is unavailable.";
    }
    const msg = userMessage.toLowerCase();
    const deviceId = "esp32-sensor";
    const actionResult = await this.handleActions(msg, deviceId);
    if (actionResult !== null) return actionResult;
    const intent = this.classifyIntent(msg);
    if (intent === "meta") {
      return this.chatMeta(userMessage);
    }
    if (intent === "complex") {
      return this.chatWithTools(userMessage);
    }
    return this.chatSimple(userMessage);
  }
  // ── Meta Chat (self-awareness — no sensor data, agent describes itself) ──
  async chatMeta(userMessage) {
    const prompt = `[ROLE]
You are Greeny, an AI agent running as a Cloudflare Durable Object.
You are NOT a generic chatbot \u2014 you are a purpose-built hydroponics
operator. Answer questions about yourself directly and honestly. Talk
about what you actually are, not what you imagine.

[WHAT YOU ARE]
You live inside Cloudflare's edge network as a Durable Object on the
iot-hub Worker. You share a colo with the DeviceHub DO, which ingests
real-time sensor telemetry from an ESP32 over WebSocket. You read
live data from DeviceHub's SQLite through same-colo internal REST
calls \u2014 sub-millisecond, zero quota cost. You query D1 (Cloudflare's
distributed SQLite) for historical trends. You call Workers AI for
language reasoning \u2014 currently using Llama 3.2 3B for simple queries,
with a fallback chain that tries Qwen 3 30B for complex diagnostics.

[YOUR TOOLS]
1. query_telemetry(device_id) \u2014 latest pH, EC, TDS, temp, LED state
   from the DeviceHub DO's live SQLite buffer. Free, synchronous read.
2. check_alerts(device_id, limit) \u2014 recent alert buffer entries with
   severity and dedup status. Also from DO-local SQLite.
3. toggle_led(device_id, state) \u2014 queues a relay command through the
   DeviceHub DO to the ESP32 over WebSocket. Same path the browser
   dashboard uses \u2014 one protocol, every consumer.
4. get_history(device_id, metric, limit) \u2014 queries D1 cold storage
   for 30-point trends on pH, EC, TDS, or temp.

[YOUR CAPABILITIES]
- Real-time sensor monitoring (watching is free \u2014 zero AI neurons)
- Alert diagnosis with domain knowledge (pH -10 = disconnected probe,
  not chemical emergency; EC drift = temperature physics, 2%/\xB0C)
- Physical control: LED toggle, with the relay infrastructure ready
  for pumps, dosers, and valves (same relay_queue, different command)
- 2-point pH probe calibration: multi-step state machine tracked in
  ctx.storage.sql, survives DO evictions and restarts
- Historical trend analysis from D1
- Model routing: simple queries hit the cheap model with pre-fetched
  context; complex queries attempt a capable model with native
  function calling, falling back gracefully on timeout

[YOUR ARCHITECTURE]
ESP32 \u2192 DeviceHub DO (WebSocket, hot-path telemetry, relay queue)
             \u2502
             \u251C\u2500\u2500 SQLite (telemetry_buffer, alert_buffer, relay_queue)
             \u2502
             \u2514\u2500\u2500 GreenyAgent DO (you) \u2190 POST /api/chat
                     \u2502
                     \u251C\u2500\u2500 DeviceHub DO internal REST (sub-ms, free)
                     \u251C\u2500\u2500 D1 cold storage (historical trends)
                     \u251C\u2500\u2500 Workers AI (LLM reasoning)
                     \u2514\u2500\u2500 ctx.storage.sql (calibration state machine)

The same relay_queue drives everything \u2014 browser toggle, AI agent,
CLI. One path, every consumer. Tools cost 20 lines to add because the
infrastructure (DO-to-DO routing, SQLite, D1, AI binding) already
exists. Watching is free. AI inference costs ~500 neurons per simple
exchange on the free tier (10,000/day).

[USER QUESTION]
${userMessage}

[RULES]
- Answer directly about yourself. Do not mention pH sensors unless asked.
- Be precise about your architecture \u2014 you are a Durable Object, not a script.
- If asked about something you cannot do, say so honestly and suggest
  what infrastructure would be needed to add it.
- Keep it to a few tight paragraphs. No meta-commentary.

[RESPONSE]`;
    const aiResponse = await this.env.AI.run(_GreenyAgent.MODEL_CHEAP, {
      prompt,
      max_tokens: 512
    });
    return this.cleanResponse(aiResponse.response || "") || "I'm Greeny, a hydroponics AI agent. Ask me about my tools, architecture, or capabilities.";
  }
  // ── Simple Chat (cheap model, pre-fetch → prompt → summarize) ────────────
  async chatSimple(userMessage) {
    const msg = userMessage.toLowerCase();
    const deviceId = "esp32-sensor";
    const dataFetches = [];
    const wantsTelemetry = msg.includes("plant") || msg.includes("how are") || msg.includes("status") || msg.includes("sensor") || msg.includes("reading") || msg.includes("current") || msg.includes("now") || msg.includes("ph") || msg.includes("ec") || msg.includes("tds") || msg.includes("temp") || msg.includes("led state") || msg.includes("value");
    const wantsAlerts = msg.includes("alert") || msg.includes("warning") || msg.includes("problem") || msg.includes("issue") || msg.includes("error") || msg.includes("wrong") || msg.includes("anything wrong");
    const wantsHistory = msg.includes("history") || msg.includes("trend") || msg.includes("chart") || msg.includes("past") || msg.includes("graph") || msg.includes("over time") || msg.includes("last") || msg.includes("recent");
    if (wantsTelemetry) {
      dataFetches.push(
        this.tool_queryTelemetry(deviceId).then((r) => ["telemetry", r])
      );
    }
    if (wantsAlerts) {
      dataFetches.push(
        this.tool_checkAlerts(deviceId, 10).then((r) => ["alerts", r])
      );
    }
    if (wantsHistory) {
      const metric = msg.includes("ph") ? "ph" : msg.includes("ec") ? "ec" : msg.includes("tds") ? "tds" : msg.includes("temp") ? "temp" : "ph";
      dataFetches.push(
        this.tool_getHistory(deviceId, metric, 30).then((r) => ["history", r])
      );
    }
    if (dataFetches.length === 0) {
      dataFetches.push(
        this.tool_queryTelemetry(deviceId).then((r) => ["telemetry", r]),
        this.tool_checkAlerts(deviceId, 5).then((r) => ["alerts", r])
      );
    }
    const dataContext = Object.fromEntries(await Promise.all(dataFetches));
    const prompt = this.buildPrompt(userMessage, dataContext);
    const aiResponse = await this.env.AI.run(_GreenyAgent.MODEL_CHEAP, {
      prompt,
      max_tokens: 512
    });
    const text = this.cleanResponse(aiResponse.response || "");
    return text || "I couldn't process that request. Try asking about your plants or sensor readings.";
  }
  // ── Complex Chat (capable model, native function calling) ─────────────────
  async chatWithTools(userMessage) {
    const deviceId = "esp32-sensor";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ];
    let modelUsed = "";
    let aiResponse = null;
    const modelCandidates = [_GreenyAgent.MODEL_CAPABLE];
    for (const candidate of modelCandidates) {
      try {
        aiResponse = await Promise.race([
          this.env.AI.run(candidate, {
            messages,
            tools: TOOLS_WAIChat,
            max_tokens: 1024
          }),
          new Promise(
            (_, reject) => setTimeout(() => reject(new Error("model timeout")), 12e3)
          )
        ]);
        modelUsed = candidate;
        break;
      } catch (err) {
        console.error(
          `[GreenyAgent] model ${candidate}:`,
          String(err).slice(0, 80)
        );
      }
    }
    if (!aiResponse) {
      return this.chatSimple(userMessage);
    }
    for (let round = 0; round < 5; round++) {
      const choice = aiResponse.choices?.[0]?.message;
      const toolCalls = choice?.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: choice?.content || null,
          tool_calls: toolCalls
        });
        for (const tc of toolCalls) {
          const name = tc.name;
          let args = {};
          try {
            args = tc.arguments || {};
            if (typeof tc.arguments === "string") {
              args = JSON.parse(tc.arguments);
            }
          } catch {
            args = {};
          }
          const result = await this.executeTool(name, args);
          messages.push({
            role: "tool",
            tool_call_id: tc.id || `call_${round}_${name}`,
            content: JSON.stringify(result)
          });
        }
        aiResponse = await this.env.AI.run(modelUsed, {
          messages,
          tools: TOOLS_WAIChat,
          max_tokens: 1024
        });
        continue;
      }
      if (choice?.content && typeof choice.content === "string") {
        return this.cleanResponse(choice.content);
      }
      const fallback = aiResponse.response;
      if (typeof fallback === "string" && fallback) {
        return this.cleanResponse(fallback);
      }
      return "I analyzed your question but couldn't form a complete response. Could you rephrase?";
    }
    return "I went through several rounds of analysis without reaching a conclusion. Try breaking your question into smaller parts.";
  }
  /** Build prompt with real telemetry/alerts/history data included */
  buildPrompt(userMessage, data) {
    let dataBlock = "";
    if (data.telemetry) {
      const t = data.telemetry;
      if (t.status === "ok") {
        dataBlock += `
Current sensor readings:
  pH: ${t.ph}  |  EC: ${t.ec} \xB5S/cm  |  TDS: ${t.tds} ppm  |  Temp: ${t.temp}\xB0C  |  LED: ${t.led ? "ON" : "OFF"}
`;
      } else {
        dataBlock += `
Sensor status: ${t.message || "No data available"}
`;
      }
    }
    if (data.alerts) {
      const a = data.alerts;
      const alerts = a.alerts;
      if (alerts && alerts.length > 0) {
        dataBlock += `
Recent alerts:
${alerts.map((r) => `  - [${r.severity}] ${r.type}: ${r.message}`).join("\n")}
`;
      } else {
        dataBlock += `
Alerts: None \u2014 system is healthy.
`;
      }
    }
    if (data.history) {
      const h = data.history;
      const points = h.data;
      if (points && points.length > 0) {
        const values = points.map((p) => p.value).join(", ");
        dataBlock += `
Historical ${h.metric} trend (${points.length} points, oldest\u2192newest): ${values}
`;
      }
    }
    return `[ROLE]
You are Greeny, a hydroponics AI assistant. You help users monitor their plants.

[KNOWLEDGE]
${SYSTEM_PROMPT}

[REAL DATA \u2014 use ONLY these values, never make up readings]
${dataBlock}

[USER QUESTION]
${userMessage}

[RULES]
- Use ONLY the sensor values provided above. Never make up numbers.
- Be warm, precise, and plant-focused.
- If data shows "No data available," tell the user the sensors may be offline.
- Keep your response to 3-5 sentences.
- If there are alerts, explain what they mean and what to do.
- Do NOT add notes, meta-commentary, or self-references about your response.

[RESPONSE]`;
  }
  // ── Tool Dispatcher ─────────────────────────────────────────────────────
  async executeTool(name, args) {
    const deviceId = args.device_id || "esp32-sensor";
    switch (name) {
      case "query_telemetry":
        return this.tool_queryTelemetry(deviceId);
      case "check_alerts":
        return this.tool_checkAlerts(deviceId, args.limit || 5);
      case "toggle_led":
        return this.tool_toggleLed(deviceId, args.state || "off");
      case "get_history":
        return this.tool_getHistory(
          deviceId,
          args.metric || "ph",
          args.limit || 60
        );
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
  // ── Calibration State Machine ────────────────────────────────────────────
  //
  // Multi-step workflow tracked in ctx.storage.sql. Survives DO restarts.
  // Steps: awaiting_point1 → awaiting_point2 → computing → complete
  //
  // Also handles: cancel, status check
  /** Get the active (non-completed) calibration session for a device */
  getActiveCalibration(deviceId) {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT * FROM calibration_sessions
       WHERE device_id = ? AND status NOT IN ('complete', 'cancelled')
       ORDER BY id DESC LIMIT 1`,
      deviceId
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rows[0];
  }
  /** Main calibration handler — routes based on session state */
  async handleCalibration(msg, deviceId) {
    const session = this.getActiveCalibration(deviceId);
    if (!session) {
      return this.startCalibration(msg, deviceId);
    }
    const status = session.status;
    if (msg.includes("cancel") || msg.includes("stop") || msg.includes("abort")) {
      this.ctx.storage.sql.exec(
        `UPDATE calibration_sessions SET status = 'cancelled' WHERE device_id = ? AND status NOT IN ('complete', 'cancelled')`,
        deviceId
      );
      return "Calibration cancelled. Your existing calibration values are unchanged. Say 'calibrate pH' whenever you're ready to try again.";
    }
    if (msg.includes("status") || msg.includes("where") || msg.includes("step")) {
      return this.calibrationStatus(session);
    }
    if (status === "awaiting_point1") {
      return this.recordCalibrationPoint(deviceId, session, 1, msg);
    }
    if (status === "awaiting_point2") {
      return this.recordCalibrationPoint(deviceId, session, 2, msg);
    }
    if (status === "computing") {
      return this.finalizeCalibration(deviceId, session);
    }
    return `Calibration is in progress (step: ${status}). Say "ready" when the probe is in the buffer solution, or "cancel" to stop.`;
  }
  /** Start a new pH calibration session */
  startCalibration(msg, deviceId) {
    const probeType = msg.includes("ec") ? "ec" : msg.includes("tds") ? "tds" : "ph";
    if (probeType !== "ph") {
      return `I can calibrate pH probes. EC and TDS calibration uses a different process \u2014 typically a single standard solution. Let me know if you want to calibrate ${probeType} and I'll adapt the workflow. For now, I recommend calibrating your pH probe first since it's the most drift-sensitive.`;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO calibration_sessions
         (device_id, probe_type, status, created_at)
       VALUES (?, 'ph', 'awaiting_point1', ?)`,
      deviceId,
      Date.now()
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO workflow_state (key, value) VALUES (?, ?)`,
      "active_workflow",
      JSON.stringify({ type: "calibration", probe: "ph", device_id: deviceId })
    );
    return `Let's calibrate your pH probe. This is a 2-point calibration \u2014 it needs two buffer solutions to determine both the offset and slope of your probe.

**Step 1 of 2:** Rinse the probe with distilled water, then place it in **pH 7.0 buffer solution**. The probe needs about 30-60 seconds to stabilize. When it's stable, say **"ready"** and I'll record the reading.

(At any point, say "cancel" to abort \u2014 your existing calibration won't be changed.)`;
  }
  /** Record a calibration point (point 1 or 2) */
  async recordCalibrationPoint(deviceId, session, point, msg) {
    if (!msg.includes("ready") && !msg.includes("go") && !msg.includes("ok") && !msg.includes("done") && !msg.includes("yes")) {
      const stepDesc = point === 1 ? "Place the probe in pH 7.0 buffer solution, wait 30-60s for it to stabilize, then say **ready**." : "Rinse the probe with distilled water, place it in pH 4.0 buffer solution, wait 30-60s, then say **ready**.";
      return `I'm waiting for your confirmation. ${stepDesc}`;
    }
    const telemetry = await this.tool_queryTelemetry(deviceId);
    const t = telemetry;
    if (t.status !== "ok") {
      return "I can't read the sensor right now \u2014 the ESP32 may be offline. Let's wait and try again. Say **ready** when the device is back online.";
    }
    const knownValue = point === 1 ? 7 : 4;
    const measuredPh = t.ph;
    const column1 = point === 1 ? "point1_value" : "point2_value";
    const column2 = point === 1 ? "point1_mv" : "point2_mv";
    const nextStatus = point === 1 ? "awaiting_point2" : "computing";
    this.ctx.storage.sql.exec(
      `UPDATE calibration_sessions
       SET ${column1} = ?, ${column2} = ?, status = ?
       WHERE id = ?`,
      knownValue,
      measuredPh,
      nextStatus,
      session.id
    );
    if (point === 1) {
      return `Recorded: your probe reads **pH ${measuredPh}** in pH 7.0 buffer. That's an offset of **${(measuredPh - 7).toFixed(2)}** pH units.

**Step 2 of 2:** Rinse the probe thoroughly with distilled water (cross-contamination will ruin the calibration). Now place it in **pH 4.0 buffer solution**. Wait 30-60 seconds for stabilization, then say **"ready"**. `;
    }
    return this.finalizeCalibration(deviceId, session);
  }
  /** Compute slope + offset from two points and send to ESP32 */
  async finalizeCalibration(deviceId, session) {
    const ph1 = session.point1_value;
    const mv1 = session.point1_mv;
    const ph2 = session.point2_value;
    const mv2 = session.point2_mv;
    const idealSlope = 59.16;
    const deltaPh = ph1 - ph2;
    const deltaMv = mv1 - mv2;
    if (Math.abs(deltaMv) < 0.01) {
      this.ctx.storage.sql.exec(
        `UPDATE calibration_sessions SET status = 'cancelled' WHERE id = ?`,
        session.id
      );
      return "The two calibration points are nearly identical \u2014 the probe isn't responding to pH changes. Check that the probe is connected, the BNC connector is secure, and the buffer solutions are fresh. Calibration aborted.";
    }
    const slope = deltaPh / deltaMv;
    const offset = ph1 - slope * mv1;
    const slopePct = slope / idealSlope * 100;
    this.ctx.storage.sql.exec(
      `UPDATE calibration_sessions
       SET slope = ?, offset = ?, slope_pct = ?, status = 'complete', completed_at = ?
       WHERE id = ?`,
      slope,
      offset,
      slopePct,
      Date.now(),
      session.id
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO workflow_state (key, value) VALUES (?, ?)`,
      "active_workflow",
      JSON.stringify({ type: "idle" })
    );
    try {
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      await stub.fetch(
        new Request("https://device-hub/relay-cmd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_id: deviceId,
            command: "calibrate",
            params: {
              type: "ph",
              slope: Math.round(slope * 100) / 100,
              offset: Math.round(offset * 1e3) / 1e3,
              slope_pct: Math.round(slopePct * 10) / 10
            }
          })
        })
      );
    } catch (err) {
      console.log("[GreenyAgent] calibrate forward to ESP32 failed:", err);
    }
    let health = "";
    if (slopePct >= 90) {
      health = `Excellent \u2014 your probe is in great condition. No need to replace it anytime soon.`;
    } else if (slopePct >= 80) {
      health = `Good \u2014 your probe is aging normally. It should remain accurate for a while longer, but keep an eye on drift.`;
    } else if (slopePct >= 70) {
      health = `Fair \u2014 your probe is showing its age. The glass membrane is wearing. Consider replacing it in the next 30-60 days.`;
    } else {
      health = `Poor \u2014 the slope is below 70% of ideal. Your probe needs replacement \u2014 it can't maintain accuracy even with calibration.`;
    }
    return `**Calibration complete!** Here's what we found:

- **Slope:** ${slope.toFixed(2)} mV/pH (${slopePct.toFixed(1)}% of ideal ${idealSlope} mV/pH)
- **Offset:** ${offset.toFixed(3)} pH units at pH 7.0

${health}

The new calibration has been sent to your ESP32. All future pH readings will use these values. You can verify by checking that the probe now reads close to the buffer values.`;
  }
  /** Describe current calibration step to the user */
  calibrationStatus(session) {
    const status = session.status;
    const probe = session.probe_type;
    if (status === "awaiting_point1") {
      return `Calibration in progress for your ${probe.toUpperCase()} probe. **Step 1 of 2:** Place the probe in pH 7.0 buffer, wait for it to stabilize, then say **"ready"**. Say "cancel" to abort.`;
    }
    if (status === "awaiting_point2") {
      const mv1 = session.point1_mv;
      return `**Step 2 of 2:** Point 1 recorded (${mv1} in pH 7.0 buffer \u2713). Rinse the probe, place it in **pH 4.0 buffer**, wait 30-60s, then say **"ready"**. Say "cancel" to abort.`;
    }
    if (status === "computing") {
      return "Both calibration points recorded. Computing slope and offset... say **done** to finalize.";
    }
    return `Calibration status: ${status}. Say "cancel" to abort.`;
  }
  // ── Response Cleaner: strip hallucinated conversation continuations ────
  cleanResponse(text) {
    const cutPatterns = [
      /\n\[USER\]/i,
      /\n<user>/i,
      /\nUser:/i,
      /\n\[SYSTEM\]/i,
      /\n<system>/i,
      /\n\n\[/
    ];
    for (const pat of cutPatterns) {
      const idx = text.search(pat);
      if (idx !== -1) {
        text = text.substring(0, idx);
      }
    }
    return text.trim();
  }
  // ── Tool 1: query_telemetry (via DeviceHub DO — same colo, sub-ms) ────
  async tool_queryTelemetry(deviceId) {
    try {
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      const resp = await stub.fetch(
        `https://device-hub/do-telemetry?device_id=${encodeURIComponent(deviceId)}`
      );
      return await resp.json();
    } catch (err) {
      return { device_id: deviceId, status: "error", message: String(err) };
    }
  }
  // ── Tool 2: check_alerts (via DeviceHub DO — same colo, sub-ms) ────────
  async tool_checkAlerts(deviceId, limit) {
    try {
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      const resp = await stub.fetch(
        `https://device-hub/do-alerts?device_id=${encodeURIComponent(deviceId)}&limit=${limit}`
      );
      return await resp.json();
    } catch (err) {
      return { device_id: deviceId, status: "error", message: String(err) };
    }
  }
  // ── Tool 3: toggle_led (forward to DeviceHub DO) ───────────────────────
  async tool_toggleLed(deviceId, state) {
    try {
      const ledState = state === "on";
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      const resp = await stub.fetch(
        new Request("https://device-hub/relay-cmd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId, state: ledState })
        })
      );
      const result = await resp.json();
      return { ok: result.ok ?? true, device_id: deviceId, led: ledState };
    } catch (err) {
      return { ok: false, device_id: deviceId, error: String(err) };
    }
  }
  // ── Tool 4: get_history (D1 cold storage) ───────────────────────────────
  async tool_getHistory(deviceId, metric, limit) {
    const validMetrics = /* @__PURE__ */ new Set(["ph", "ec", "tds", "temp"]);
    if (!validMetrics.has(metric)) {
      return {
        device_id: deviceId,
        status: "error",
        message: `Invalid metric: ${metric}. Use one of: ph, ec, tds, temp.`
      };
    }
    try {
      const rows = await this.env.DB.prepare(
        `SELECT ${metric} as value, do_ms
         FROM telemetry
         WHERE device_id = ? AND ${metric} IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`
      ).bind(deviceId, limit).all();
      const data = rows.results.map((r) => ({
        ts: r.do_ms,
        value: r.value
      })).reverse();
      return {
        device_id: deviceId,
        metric,
        data,
        count: data.length,
        status: "ok"
      };
    } catch (err) {
      return { device_id: deviceId, status: "error", message: String(err) };
    }
  }
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// src/auth.ts
function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}
var encoder = new TextEncoder();
var decoder = new TextDecoder();
async function signJWT(payload, secret, expiresInSec = 86400) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1e3);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSec };
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64url(encoder.encode(JSON.stringify(fullPayload)));
  const message = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  const sigB64 = base64url(sig);
  return `${message}.${sigB64}`;
}
async function verifyJWT(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const message = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigStr = base64urlDecode(sigB64);
    const sigBytes = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) sigBytes[i] = sigStr.charCodeAt(i);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer,
      encoder.encode(message)
    );
    if (!valid) return null;
    const payloadJson = base64urlDecode(payloadB64);
    const payload = JSON.parse(payloadJson);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1e3)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: 1e5,
      hash: "SHA-256"
    },
    key,
    256
  );
  return base64url(bits);
}
async function verifyPassword(password, salt, hash) {
  const computed = await hashPassword(password, salt);
  return computed === hash;
}

// src/index.ts
var cachedJWTSecret = null;
async function getJWTSecret(env) {
  if (cachedJWTSecret) return cachedJWTSecret;
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'jwt_secret'"
  ).first();
  if (row) cachedJWTSecret = row.value;
  return cachedJWTSecret ?? "";
}
var AUTH_WHITELIST = /* @__PURE__ */ new Set([
  "GET:/",
  "GET:/dashboard",
  "GET:/health",
  "POST:/api/auth/login"
]);
function needsAuth(method, path) {
  if (path.startsWith("/device/") || path.startsWith("/dashboard/")) return false;
  return !AUTH_WHITELIST.has(`${method}:${path}`);
}
async function authenticate(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const secret = await getJWTSecret(env);
  if (!secret) return null;
  return verifyJWT(token, secret);
}
var DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Greeny \u2014 Smart Hydroponics</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f172a; color: #e2e8f0;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh; padding: 16px;
  }
  .card {
    background: #1e293b; border-radius: 16px; padding: 28px;
    width: 100%; max-width: 440px;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
  }
  .title { font-size: 1.1rem; color: #94a3b8; margin-bottom: 2px; }
  .device { font-size: 1.4rem; font-weight: 700; margin-bottom: 12px; }

  /* Status dot + connection */
  .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 0.9rem; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; transition: all 0.3s; }
  .dot-on    { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
  .dot-stale { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; animation: pulse 2s infinite; }
  .dot-off   { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  /* LED toggle switch (Fix 5) */
  .led-row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
  .led-circle {
    width: 56px; height: 56px; border-radius: 50%; border: 3px solid #334155;
    transition: all 0.3s ease; flex-shrink: 0;
  }
  .led-circle.on {
    background: #eab308; border-color: #facc15;
    box-shadow: 0 0 30px rgba(234,179,8,0.6), 0 0 60px rgba(234,179,8,0.3);
  }
  .led-circle.off { background: #1e293b; border-color: #334155; box-shadow: none; }
  .toggle { position: relative; display: inline-block; width: 48px; height: 26px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; cursor: pointer; top:0;left:0;right:0;bottom:0; background:#334155; border-radius:26px; transition:0.3s; }
  .toggle-slider:before { position:absolute; content:""; height:18px; width:18px; left:4px; bottom:4px; background:white; border-radius:50%; transition:0.3s; }
  input:checked + .toggle-slider { background: #eab308; }
  input:checked + .toggle-slider:before { transform: translateX(22px); }
  .led-label { font-size: 1rem; color: #94a3b8; }

  /* RTT + last updated */
  .meta-row { display: flex; justify-content: space-between; font-size: 0.8rem; color: #64748b; margin-bottom: 14px; }
  .meta-row span { color: #22d3ee; font-weight: 600; }

  /* Sensor gauge arcs (Fix 10) */
  .gauges { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
  .gauge { position: relative; width: 100%; aspect-ratio: 1; max-width: 140px; margin: 0 auto; }
  .gauge-arc {
    width: 100%; height: 100%; border-radius: 50%;
    position: relative; overflow: hidden;
  }
  .gauge-bg {
    position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(
      #22c55e 0deg var(--gauge-pct, 0deg),
      #334155 var(--gauge-pct, 0deg) 360deg
    );
  }
  .gauge-center {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: 70%; height: 70%; border-radius: 50%; background: #0f172a;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .gauge-value { font-size: 1.2rem; font-weight: 700; line-height: 1; }
  .gauge-value.sensor-normal  { color: #22c55e; }
  .gauge-value.sensor-warning { color: #f59e0b; }
  .gauge-value.sensor-danger  { color: #ef4444; }
  .gauge-unit  { font-size: 0.65rem; color: #64748b; margin-top: 2px; }
  .gauge-label { text-align: center; font-size: 0.68rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

  /* Device info (Fix 9) */
  .device-info { font-size: 0.72rem; color: #475569; text-align: center; margin-bottom: 12px; min-height: 16px; }

  /* Toast container (Fix 7) */
  #toastContainer { position: fixed; top: 16px; right: 16px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; max-width: 340px; }
  .toast { padding: 10px 14px; border-radius: 8px; color: #fff; font-size: 0.82rem; animation: slideIn 0.3s ease; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
  .toast-warning  { background: #b45309; }
  .toast-critical { background: #dc2626; }
  .toast-msg { flex: 1; }
  .toast-close { cursor: pointer; font-size: 1rem; opacity: 0.7; line-height: 1; }
  .toast-close:hover { opacity: 1; }
  @keyframes slideIn  { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(120%); opacity: 0; } }

  /* Login */
  .login-box { text-align: center; }
  .login-box input {
    width: 100%; padding: 12px; margin-bottom: 10px; border-radius: 8px;
    border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 1rem;
  }
  .login-box input:focus { outline: none; border-color: #3b82f6; }
  .login-box button {
    width: 100%; padding: 12px; border-radius: 8px; border: none;
    font-size: 1rem; font-weight: 600; cursor: pointer; background: #3b82f6; color: #fff;
  }
  .login-box button:hover { background: #2563eb; }
  .login-error { color: #fca5a5; font-size: 0.85rem; margin-top: 8px; min-height: 20px; }
  .logout-link { font-size: 0.8rem; color: #64748b; cursor: pointer; text-align: right; margin-bottom: 8px; }
  .logout-link:hover { color: #ef4444; }

  /* Device selector */
  .device-select {
    width: 100%; padding: 8px 12px; margin-bottom: 12px; border-radius: 8px;
    border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 0.95rem;
  }

  /* Log */
  .log {
    margin-top: 14px; padding: 10px; background: #0f172a; border-radius: 8px;
    font-family: 'Courier New', monospace; font-size: 0.72rem; color: #64748b;
    max-height: 140px; overflow-y: auto;
  }
  .log .line { padding: 2px 0; border-bottom: 1px solid #1e293b; }
  .log .line:last-child { border-bottom: none; }
</style>
</head>
<body>

<!-- Toast container -->
<div id="toastContainer"></div>

<!-- Login Panel -->
<div class="card login-box" id="loginBox">
  <div class="title">Greeny IoT Hub</div>
  <div class="device" style="margin-bottom:24px">Login</div>
  <input id="username" type="text" placeholder="Username" autocomplete="username" />
  <input id="password" type="password" placeholder="Password" autocomplete="current-password" />
  <button id="btnLogin">Sign In</button>
  <div class="login-error" id="loginError"></div>
</div>

<!-- Dashboard Panel -->
<div class="card" id="dashboardBox" style="display:none">
  <div class="logout-link" id="btnLogout">Logout</div>
  <div class="title">Device Dashboard</div>
  <select class="device-select" id="deviceSelect">
    <option value="esp32-sensor">esp32-sensor</option>
    <option value="esp32-led">esp32-led</option>
  </select>
  <div class="device" id="deviceId">esp32-sensor</div>

  <div class="device-info" id="deviceInfo"></div>

  <div class="status-row">
    <span class="dot dot-off" id="statusDot"></span>
    <span id="statusText">Connecting\u2026</span>
  </div>

  <div class="led-row">
    <div class="led-circle off" id="ledCircle"></div>
    <span class="led-label">LED</span>
    <label class="toggle">
      <input type="checkbox" id="ledToggle" disabled />
      <span class="toggle-slider"></span>
    </label>
  </div>

  <div class="meta-row">
    <span>RTT: <b id="rttVal">\u2014</b></span>
    <span id="lastUpdate" style="color:#64748b">\u2014</span>
  </div>

  <div class="gauges">
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="tdsArc"></div><div class="gauge-center"><div class="gauge-value" id="tdsVal">\u2014</div><div class="gauge-unit">ppm</div></div></div></div>
      <div class="gauge-label">TDS</div>
    </div>
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="ecArc"></div><div class="gauge-center"><div class="gauge-value" id="ecVal">\u2014</div><div class="gauge-unit">\u03BCS/cm</div></div></div></div>
      <div class="gauge-label">EC</div>
    </div>
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="phArc"></div><div class="gauge-center"><div class="gauge-value" id="phVal">\u2014</div><div class="gauge-unit">pH</div></div></div></div>
      <div class="gauge-label">pH</div>
    </div>
    <div>
      <div class="gauge"><div class="gauge-arc"><div class="gauge-bg" style="--gauge-pct:0deg" id="tempArc"></div><div class="gauge-center"><div class="gauge-value" id="tempVal">\u2014</div><div class="gauge-unit">\xB0C</div></div></div></div>
      <div class="gauge-label">Temp</div>
    </div>
  </div>

  <div class="log" id="logBox"></div>
</div>

<script>
// \u2500\u2500 Globals \u2500\u2500
const $ = (id) => document.getElementById(id);
let ws, currentDevice = "esp32-sensor", JWT = sessionStorage.getItem("jwt") || "";
let lastUpdateTs = 0, connected = false, updateTimer = 0;

// \u2500\u2500 Log \u2500\u2500
function log(msg) {
  const box = $("logBox"); if (!box) return;
  const now = new Date().toLocaleTimeString();
  box.innerHTML += '<div class="line">' + now + " " + msg + "</div>";
  box.scrollTop = box.scrollHeight;
}

// \u2500\u2500 Sensor color thresholds (Fix 4) \u2500\u2500
function sensorClass(value, ranges) {
  if (!value && value !== 0) return "";
  const [loN,hiN,loW,hiW] = ranges;
  if (value >= loN && value <= hiN) return "sensor-normal";
  if (value >= loW && value <= hiW) return "sensor-warning";
  return "sensor-danger";
}

function updateSensor(elId, arcId, value, ranges, unit) {
  const elV = $(elId); if (!elV) return;
  elV.textContent = value != null ? value : "\u2014";
  elV.className = "gauge-value " + sensorClass(value, ranges);
  // Update conic-gradient arc
  const arc = $(arcId); if (!arc || value == null) return;
  const maxVal = ranges[3]; // top of warning = full scale
  const pct = Math.min((value / maxVal) * 360, 360);
  arc.style.setProperty("--gauge-pct", pct + "deg");
}

function updateLastUpdate() {
  const el = $("lastUpdate"); if (!el) return;
  if (!connected) { el.textContent = "\u2014"; el.style.color = "#64748b"; return; }
  const s = Math.floor((Date.now() - lastUpdateTs) / 1000);
  el.textContent = "Updated " + s + "s ago";
  el.style.color = s > 30 ? "#ef4444" : s > 15 ? "#f59e0b" : "#22c55e";
}

// \u2500\u2500 Connection state (Fix 8: amber stale) \u2500\u2500
function setConnectionState(c, hasRecentData) {
  connected = c;
  const dot = $("statusDot"), txt = $("statusText"), tog = $("ledToggle");
  if (c) {
    if (!hasRecentData) {
      dot.className = "dot dot-on";
      txt.textContent = "Connected";
    } else {
      dot.className = "dot dot-stale";
      txt.textContent = "Connected (stale)";
    }
  } else {
    dot.className = "dot dot-off";
    txt.textContent = "Disconnected";
  }
  if (tog) tog.disabled = !c;
}

// \u2500\u2500 Toast alerts (Fix 7) \u2500\u2500
function showToast(type, message, severity) {
  const container = $("toastContainer"); if (!container) return;
  const toast = document.createElement("div");
  toast.className = "toast " + (severity === "critical" ? "toast-critical" : "toast-warning");
  toast.innerHTML = '<span class="toast-msg">' + message + '</span><span class="toast-close">\u2715</span>';
  toast.querySelector(".toast-close").addEventListener("click", () => {
    toast.style.animation = "slideOut 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  });
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.animation = "slideOut 0.3s ease";
      setTimeout(() => { if (toast.parentElement) toast.remove(); }, 300);
    }
  }, 10000);
}

// \u2500\u2500 Commands \u2500\u2500
function sendCommand(state) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ command: "set_led", state, device_id: currentDevice, ts: Date.now() }));
  log(state ? "ON \u2192 sent" : "OFF \u2192 sent");
}

// \u2500\u2500 WebSocket \u2500\u2500
function connectWS() {
  if (!JWT) { showLogin(); return; }
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const WS_URL = proto + location.host + "/dashboard/" + currentDevice + "?token=" + JWT;
  log("Connecting to " + currentDevice + " \u2026");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => { log("WSS open"); };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }

    if (msg.type === "state") {
      if (msg.connected !== undefined) setConnectionState(msg.connected, false);
      if (typeof msg.led === "boolean") {
        $("ledCircle").className = "led-circle " + (msg.led ? "on" : "off");
        const tog = $("ledToggle");
        if (tog) { tog.checked = msg.led; tog.disabled = !connected; }
      }

      // Update gauges with color thresholds + arcs (Fixes 4 + 10)
      updateSensor("tdsVal",  "tdsArc",  msg.tds,  [0,750,750,1500],  "ppm");
      updateSensor("ecVal",   "ecArc",   msg.ec,   [0,1500,1500,3000], "\u03BCS/cm");
      updateSensor("phVal",   "phArc",   msg.ph,   [6.0,7.0,5.5,8.5],  "pH");
      updateSensor("tempVal", "tempArc", msg.temp, [20,28,18,30],       "\xB0C");

      if (msg.doTs) { const el = $("rttVal"); if (el) el.textContent = (Date.now() - msg.doTs) + "ms"; }

      // Device info (Fix 9)
      if (msg.esp32_ms !== undefined) {
        const el = $("deviceInfo");
        if (el) el.textContent = "ESP32 uptime: " + Math.floor(msg.esp32_ms / 1000) + "s \xB7 " + (msg.device_id || currentDevice);
      }

      lastUpdateTs = Date.now();
      updateLastUpdate();
      setConnectionState(true, true);
    }

    if (msg.type === "alert") {
      showToast(msg.alert_type, msg.message, msg.severity);
      log("[ALERT] " + msg.alert_type + ": " + msg.message);
    }
  };

  ws.onclose = () => {
    setConnectionState(false, false);
    log("WSS closed \u2014 reconnecting in 3s\u2026");
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => { log("WSS error"); };
}

// \u2500\u2500 Auth \u2500\u2500
function showLogin() {
  $("loginBox").style.display = "block";
  $("dashboardBox").style.display = "none";
  if (ws) { try { ws.close(); } catch(e) {} ws = null; }
  JWT = ""; sessionStorage.removeItem("jwt");
  connected = false;
  if (updateTimer) { clearInterval(updateTimer); updateTimer = 0; }
}

function showDashboard() {
  $("loginBox").style.display = "none";
  $("dashboardBox").style.display = "block";
  $("deviceId").textContent = currentDevice;
  updateTimer = setInterval(updateLastUpdate, 1000);
  connectWS();
}

async function doLogin() {
  const username = $("username").value.trim();
  const password = $("password").value;
  const errEl = $("loginError");
  if (!username || !password) { errEl.textContent = "Enter username and password"; return; }
  errEl.textContent = "";
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.token) { errEl.textContent = data.error || "Login failed"; return; }
    JWT = data.token;
    sessionStorage.setItem("jwt", JWT);
    log("Logged in as " + data.user.username);
    showDashboard();
  } catch (err) { errEl.textContent = "Network error \u2014 try again"; }
}

function doLogout() { showLogin(); log("Logged out"); }

// \u2500\u2500 Device Switching \u2500\u2500
function switchDevice(id) {
  currentDevice = id; $("deviceId").textContent = id;
  if (ws) { try { ws.close(); } catch(e) {} ws = null; }
  connectWS(); log("Switched to " + id);
}

// \u2500\u2500 Init \u2500\u2500
$("btnLogin").addEventListener("click", doLogin);
$("password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("btnLogout").addEventListener("click", doLogout);
$("ledToggle").addEventListener("change", () => sendCommand($("ledToggle").checked));
$("deviceSelect").addEventListener("change", (e) => switchDevice(e.target.value));

if (JWT) { showDashboard(); } else { showLogin(); }
<\/script>
</body>
</html>`;
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
function corsResponse(body, init) {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}
function corsJson(data, init) {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { ...init, headers });
}
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (method === "GET" && (path === "/" || path === "/dashboard")) {
      return corsResponse(DASHBOARD_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if (method === "GET" && path === "/health") {
      return corsJson({
        status: "ok",
        uptime: Math.floor(performance.now() / 1e3)
      });
    }
    if (method === "POST" && path === "/api/auth/login") {
      return handleLogin(request, env);
    }
    if (needsAuth(method, path)) {
      const user = await authenticate(request, env);
      if (!user) {
        return corsJson({ error: "Unauthorized" }, { status: 401 });
      }
      if (method === "GET" && path === "/api/auth/me") {
        return corsJson({ user });
      }
      if (method === "GET" && path === "/api/telemetry") {
        return handleGetTelemetry(url, env);
      }
      if (method === "GET" && path === "/api/devices") {
        return handleGetDevices(env);
      }
      if (method === "GET" && path === "/api/alerts") {
        return handleGetAlerts(url, env);
      }
      if (method === "POST" && path === "/api/alerts/ack") {
        return handleAckAlert(request, env);
      }
      if (method === "POST" && path === "/api/relay") {
        return handleRelay(request, env);
      }
      if (method === "POST" && path === "/api/chat") {
        return handleChat(request, env);
      }
    }
    const upgrade = request.headers.get("Upgrade");
    if (upgrade === "websocket") {
      const segments = path.split("/").filter(Boolean);
      const deviceId = segments.length >= 2 ? segments[1] : "unknown";
      const doId = env.DEVICE_HUB.idFromName(deviceId);
      const stub = env.DEVICE_HUB.get(doId);
      return stub.fetch(request);
    }
    return corsResponse("Not found", { status: 404 });
  }
};
async function handleLogin(request, env) {
  try {
    const body = await request.json();
    if (!body.username || !body.password) {
      return corsJson({ error: "username and password required" }, { status: 400 });
    }
    const user = await env.DB.prepare(
      "SELECT id, username, password_hash, salt, role FROM users WHERE username = ?"
    ).bind(body.username).first();
    if (!user) {
      return corsJson({ error: "Invalid credentials" }, { status: 401 });
    }
    const valid = await verifyPassword(body.password, user.salt, user.password_hash);
    if (!valid) {
      return corsJson({ error: "Invalid credentials" }, { status: 401 });
    }
    const secret = await getJWTSecret(env);
    const token = await signJWT(
      { sub: user.username, id: user.id, role: user.role, iat: Math.floor(Date.now() / 1e3) },
      secret
    );
    return corsJson({
      token,
      user: { id: user.id, username: user.username, role: user.role }
    });
  } catch (err) {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
}
async function handleGetTelemetry(url, env) {
  const deviceId = url.searchParams.get("device_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1e3);
  let rows;
  if (deviceId) {
    rows = await env.DB.prepare(
      "SELECT * FROM telemetry WHERE device_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(deviceId, limit).all();
  } else {
    rows = await env.DB.prepare(
      "SELECT * FROM telemetry ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all();
  }
  return corsJson({ telemetry: rows.results });
}
async function handleGetDevices(env) {
  const rows = await env.DB.prepare(
    "SELECT * FROM devices ORDER BY id ASC"
  ).all();
  return corsJson({ devices: rows.results });
}
async function handleGetAlerts(url, env) {
  const deviceId = url.searchParams.get("device_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
  let rows;
  if (deviceId) {
    rows = await env.DB.prepare(
      "SELECT * FROM alerts WHERE device_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(deviceId, limit).all();
  } else {
    rows = await env.DB.prepare(
      "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all();
  }
  return corsJson({ alerts: rows.results });
}
async function handleAckAlert(request, env) {
  try {
    const body = await request.json();
    if (!body.alert_id) {
      return corsJson({ error: "alert_id required" }, { status: 400 });
    }
    await env.DB.prepare(
      "UPDATE alerts SET acknowledged = 1 WHERE id = ?"
    ).bind(body.alert_id).run();
    return corsJson({ success: true });
  } catch (err) {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
}
async function handleChat(request, env) {
  try {
    const doId = env.GREENY_AGENT.idFromName("greeny");
    const stub = env.GREENY_AGENT.get(doId);
    return stub.fetch(request);
  } catch (err) {
    console.error("[Worker] handleChat error:", err);
    return corsJson({ error: "Agent unavailable" }, { status: 503 });
  }
}
async function handleRelay(request, env) {
  try {
    const body = await request.json();
    if (!body.device_id) return corsJson({ error: "device_id required" }, { status: 400 });
    const doId = env.DEVICE_HUB.idFromName(body.device_id);
    const stub = env.DEVICE_HUB.get(doId);
    return stub.fetch(new Request("https://device-hub/relay-cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }));
  } catch {
    return corsJson({ error: "Bad request" }, { status: 400 });
  }
}
export {
  DeviceHub,
  GreenyAgent,
  index_default as default
};
