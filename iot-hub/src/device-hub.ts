/**
 * DeviceHub — Durable Object
 * Holds WebSocket connections from ESP32 and browser dashboards.
 * Forwards commands, broadcasts state. Uses WebSocket Hibernation.
 */

import { DurableObject } from "cloudflare:workers";

interface Attachment {
  role: "esp32" | "browser";
  connectedAt: number;
}

export class DeviceHub extends DurableObject {
  private esp32ws: WebSocket | null = null;
  private browsers = new Map<WebSocket, Attachment>();
  private ledState = false;
  private tds = 0;
  private ec = 0;
  private ph = 7.0;
  private temp = 25.0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // ZERO I/O — restore from attachments only, runs on every wake
    ctx.getWebSockets().forEach((ws) => {
      const meta = ws.deserializeAttachment() as Attachment | null;
      if (meta?.role === "esp32") {
        this.esp32ws = ws;
      } else if (meta?.role === "browser") {
        this.browsers.set(ws, meta);
      }
    });
    console.log(
      `[DO] constructor — esp32:${this.esp32ws ? "yes" : "no"}, browsers:${this.browsers.size}`
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server); // HIBERNATION — not server.accept()

    const role: Attachment["role"] = url.pathname.includes("dashboard")
      ? "browser"
      : "esp32";
    const meta: Attachment = { role, connectedAt: Date.now() };
    server.serializeAttachment(meta);

    if (role === "esp32") {
      this.esp32ws = server;
      console.log("[DO] ESP32 connected");
      // Push initial state to new ESP32 connection
      server.send(
        JSON.stringify({
          type: "sync",
          led: this.ledState,
          doTs: Date.now(),
        })
      );
    } else {
      this.browsers.set(server, meta);
      console.log(`[DO] Browser connected (${this.browsers.size} total)`);
      // Push current state to new browser immediately
      server.send(
        JSON.stringify({
          type: "state",
          led: this.ledState,
          connected: this.esp32ws !== null,
          doTs: Date.now(),
        })
      );
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string) {
    const meta = ws.deserializeAttachment() as Attachment | null;

    try {
      const msg = JSON.parse(raw);

      if (meta?.role === "esp32") {
        this.handleESP32Message(ws, msg);
      } else if (meta?.role === "browser") {
        this.handleBrowserMessage(msg);
      }
    } catch (err) {
      console.log("[DO] Invalid JSON from", meta?.role, err);
    }
  }

  private handleESP32Message(ws: WebSocket, msg: Record<string, unknown>) {
    // ESP32 ack'd a command
    if (msg.type === "ack") {
      const led = msg.led as boolean;
      this.ledState = led;
      const ackTs = Date.now();
      console.log(`[DO] ESP32 ack: led=${led}, doTs=${ackTs}`);

      // Store in SQLite (durable, survives eviction)
      this.ctx.storage.put("ledState", led ? 1 : 0);

      // Broadcast to all browser dashboards
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: true,
        doTs: ackTs,
      });
    }
    // Telemetry from sensor hub
    else if (msg.type === "telemetry") {
      this.tds = msg.tds as number;
      this.ec = msg.ec as number;
      this.ph = msg.ph as number;
      this.temp = msg.temp as number;
      this.ledState = msg.led as boolean;
      const ackTs = Date.now();

      // Store latest in SQLite
      this.ctx.storage.put("tds", msg.tds as number);
      this.ctx.storage.put("ec", msg.ec as number);
      this.ctx.storage.put("ph", msg.ph as number);
      this.ctx.storage.put("temp", msg.temp as number);

      // Broadcast sensor state to all browsers
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: true,
        tds: this.tds,
        ec: this.ec,
        ph: this.ph,
        temp: this.temp,
        doTs: ackTs,
      });
    }
    // Also handle ping (existing behaviour — DO echoes back)
    else if (msg.type === "ping") {
      ws.send(
        JSON.stringify({
          type: "pong",
          seq: msg.seq,
          echo: `[DO] received ping seq=${msg.seq}`,
        })
      );
    }
  }

  private handleBrowserMessage(msg: Record<string, unknown>) {
    // Forward calibration commands to ESP32
    if (msg.command === "calibrate" && this.esp32ws) {
      console.log(`[DO] browser command: calibrate ${msg.params?.type}`);
      this.esp32ws.send(JSON.stringify(msg));
    }
    else if (msg.command === "set_led" && this.esp32ws) {
      const state = msg.state as boolean;
      const clientTs = msg.ts as number;
      const doTs = Date.now();

      console.log(
        `[DO] browser command: set_led=${state}, clientTs=${clientTs}, doForwardTs=${doTs}`
      );

      this.esp32ws.send(
        JSON.stringify({
          command: "set_led",
          params: { state },
        })
      );
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    if (meta?.role === "esp32") {
      this.esp32ws = null;
      console.log("[DO] ESP32 disconnected");
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: false,
        doTs: Date.now(),
      });
    } else {
      this.browsers.delete(ws);
      console.log(`[DO] Browser disconnected (${this.browsers.size} remain)`);
    }
    // Auto-reply handled by runtime (compat_date >= 2026-04-07)
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    const meta = ws.deserializeAttachment() as Attachment | null;
    console.log(`[DO] WebSocket error on ${meta?.role}:`, error);
    // Same cleanup as close
    if (meta?.role === "esp32") {
      this.esp32ws = null;
      this.broadcast({
        type: "state",
        led: this.ledState,
        connected: false,
        doTs: Date.now(),
      });
    } else {
      this.browsers.delete(ws);
    }
  }

  private broadcast(data: Record<string, unknown>) {
    const json = JSON.stringify(data);
    this.browsers.forEach((_, ws) => {
      try {
        ws.send(json);
      } catch {
        this.browsers.delete(ws);
      }
    });
  }
}
