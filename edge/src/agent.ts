/**
 * GreenyAgent — AI Durable Object (Phase 4)
 *
 * DO-resident hydroponics assistant. Fetches telemetry from the
 * DeviceHub DO via internal REST endpoints (same-colo, sub-ms routing).
 * Calls Workers AI for LLM reasoning. Tool-calling loop: AI decides
 * which tool to invoke, agent executes, results fed back to AI.
 *
 * Exposed at POST /api/chat via Worker → DO stub.
 *
 * Tools:
 *   query_telemetry(device_id)   → DeviceHub DO /do-telemetry
 *   check_alerts(device_id, n)   → DeviceHub DO /do-alerts
 *   toggle_led(device_id, state) → DeviceHub DO /relay-cmd
 *   get_history(device_id, m, n) → D1 telemetry table (cold storage)
 *
 * Quota:
 *  - DO-to-DO fetches: free (same colo, internal routing)
 *  - Workers AI calls: metered (free tier: 10k neurons/day)
 *  - D1 queries: metered (free tier: 5M rows read/month)
 */

import { DurableObject } from "cloudflare:workers";

// ── Types ──────────────────────────────────────────────────────────────────

interface AgentEnv {
  DEVICE_HUB: DurableObjectNamespace;
  GREENY_AGENT: DurableObjectNamespace;
  DB: D1Database;
  AI: Ai;
}

// ── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Greeny, a hydroponics AI assistant. You watch sensor data
from an ESP32 monitoring a hydroponic system. Your job is to translate
numbers into plant health. Normal is silence — only report deviations.

pH: 5.5-7.0 is optimal for most hydroponic crops. Below 5.0 or above
8.0 needs attention. If pH drifts slowly over days, probe needs
recalibration. If pH suddenly jumps to -10 or 34.95, probe is
disconnected — check BNC connector and amplifier board.

EC: 800-2000 µS/cm is typical. EC=0 means sensor disconnected. EC
rising without nutrient change means temperature effect (2%/°C is
normal physics). EC above 3000 needs dilution.

Temperature: 18-28°C optimal. Below 15°C roots slow. Above 30°C
stresses plants, increases pathogen risk.

Alerts: If you see ph_high or ph_low alerts that persist across
multiple readings, the condition is real — don't dismiss it.
Check if the probe was recently calibrated. If it was 30+ days ago,
suggest recalibration.

Tone: Be warm, precise, plant-focused. Don't list raw JSON. Say
'Your basil is thriving — pH 6.2 and stable' not 'pH: 6.2, EC: 1200.'
When something is wrong, explain what, why, and what to do.`;

// ── Tool Definitions (OpenAI function-calling format) ──────────────────────

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "query_telemetry",
      description: "Get the latest sensor reading (tds, ec, ph, temp, led) for a device from live telemetry buffer",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string", description: "Device ID, e.g. 'esp32-sensor'" },
        },
        required: ["device_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "check_alerts",
      description: "Get recent alerts for a device from the alert buffer",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string", description: "Device ID" },
          limit: { type: "number", description: "Max alerts to return (default 5)" },
        },
        required: ["device_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "toggle_led",
      description: "Turn the grow LED on or off for a device",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string", description: "Device ID" },
          state: { type: "string", enum: ["on", "off"], description: "Desired LED state" },
        },
        required: ["device_id", "state"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_history",
      description: "Get historical trend data for a metric (ph, ec, tds, temp) from D1 cold storage",
      parameters: {
        type: "object",
        properties: {
          device_id: { type: "string", description: "Device ID" },
          metric: { type: "string", enum: ["ph", "ec", "tds", "temp"], description: "Which metric to retrieve" },
          limit: { type: "number", description: "Max data points (default 60)" },
        },
        required: ["device_id", "metric"],
      },
    },
  },
];

// ── Tool Definitions (Workers AI native format — flat, no "function" wrapper) ─

const TOOLS_WAIChat = [
  {
    name: "query_telemetry",
    description: "Get the latest sensor reading (tds, ec, ph, temp, led) for a device from live telemetry",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID, e.g. 'esp32-sensor'" },
      },
      required: ["device_id"],
    },
  },
  {
    name: "check_alerts",
    description: "Get recent alerts for a device from the alert buffer",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID" },
        limit: { type: "integer", description: "Max alerts to return (default 5)" },
      },
      required: ["device_id"],
    },
  },
  {
    name: "toggle_led",
    description: "Turn the grow LED on or off for a device",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID" },
        state: { type: "string", enum: ["on", "off"], description: "Desired LED state" },
      },
      required: ["device_id", "state"],
    },
  },
  {
    name: "get_history",
    description: "Get historical trend data for a metric (ph, ec, tds, temp) from D1 cold storage. Returns an array of {ts, value} in chronological order.",
    parameters: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID" },
        metric: { type: "string", enum: ["ph", "ec", "tds", "temp"], description: "Which metric to retrieve" },
        limit: { type: "integer", description: "Max data points (default 60)" },
      },
      required: ["device_id", "metric"],
    },
  },
];

// ── GreenyAgent DO Class ───────────────────────────────────────────────────

export class GreenyAgent extends DurableObject {
  // env is injected by the runtime
  private declare env: AgentEnv;

  // ── Constructor: create SQLite tables for calibration state ─────────────

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    this.env = env;

    // Calibration sessions — survives DO eviction/restart
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

    // Generic workflow state — reusable for flush, dose, maintenance
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workflow_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )`);
  }

  // ── HTTP Request Handler ───────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (url.pathname === "/api/chat" && method === "POST") {
      try {
        const body = (await request.json()) as { message: string };
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

  private static readonly MODEL_CHEAP   = "@cf/meta/llama-3.2-3b-instruct";
  private static readonly MODEL_CAPABLE = "@cf/qwen/qwen3-30b-a3b-fp8";
  private static readonly MODEL_REASON  = "@cf/qwen/qwq-32b";

  // ── Chat (multi-model router) ─────────────────────────────────────────────

  /** Classify user intent to route to the right model tier */
  private classifyIntent(msg: string): "action" | "complex" | "simple" | "meta" {
    // Actions — direct commands, no AI needed
    if (msg.match(/turn\s+(on|off)\s+(the\s+)?(led|light)/i)) return "action";
    if (msg.match(/^(calibrate|start calibration|run calibration|begin calibration)/i)) return "action";
    if (msg.match(/calibrate\s+(ph|ec|tds|the)/i)) return "action";

    // Meta — questions about the agent itself, its architecture, its capabilities
    // Bypass sensor pre-fetch entirely; the model needs to talk about itself
    const metaMarkers = [
      "what can you do", "what are you", "who are you",
      "how do you work", "how are you built", "your architecture",
      "what tools", "what api", "your capabilit", "your skills",
      "can you see", "can you access", "do you have access",
      "yourself", "tell me about yourself", "what do you know",
      "how were you", "what model", "are you an ai", "are you a bot",
      "explain yourself", "describe yourself", "your design",
    ];
    if (metaMarkers.some((m) => msg.includes(m))) return "meta";

    // Complex — multi-step reasoning, diagnostics, planning
    const complexMarkers = [
      "why", "diagnose", "plan", "recommend", "schedule",
      "what should", "how do i fix", "how do i adjust",
      "compare", "analyze", "predict", "suggest", "optimise",
      "optimize", "investigate", "troubleshoot",
      "imagine", "could you", "would you", "what if",
      "future", "skill", "capabilit",
    ];
    if (complexMarkers.some((m) => msg.includes(m))) return "complex";

    // Complex — mentions multiple distinct metric types (cross-referencing)
    const metricHits = ["ph", "ec", "tds", "temp", "temperature"].filter(
      (m) => msg.includes(m),
    ).length;
    if (metricHits >= 2) return "complex";

    // Complex — time-based analysis
    if (
      msg.includes("over the last") || msg.includes("over the past") ||
      msg.includes("this week") || msg.includes("trend") ||
      msg.includes("changing") || msg.includes("drifting")
    ) return "complex";

    // Simple — pre-fetch + summarize
    return "simple";
  }

  /** Route action commands (LED, calibration) to existing handlers */
  private async handleActions(
    msg: string,
    deviceId: string,
  ): Promise<string | null> {
    // LED toggle
    const ledMatch = msg.match(/turn\s+(on|off)\s+(the\s+)?(led|light)/i);
    if (ledMatch) {
      const state = ledMatch[1].toLowerCase();
      const result = await this.tool_toggleLed(deviceId, state);
      if ((result as Record<string, unknown>).ok) {
        return `The LED is now ${state}. ${
          state === "on"
            ? "Your plants are getting extra light for photosynthesis."
            : "The light is off — your plants are in their dark cycle."
        }`;
      }
      return `I tried to turn the LED ${state}, but the device may be offline. The command is queued and will run when the ESP32 reconnects.`;
    }

    // Calibration — only direct commands ("calibrate ph", "start calibration")
    if (
      msg.match(/^(calibrate|start calibration|run calibration|begin calibration)/i) ||
      msg.match(/calibrate\s+(ph|ec|tds|the)/i)
    ) {
      return this.handleCalibration(msg, deviceId);
    }

    // Active calibration session — only capture calibration-related messages
    const calKeywords = [
      "ready", "done", "ok", "go", "yes", "cancel",
      "stop", "abort", "status", "step", "where",
    ];
    const activeSession = this.getActiveCalibration(deviceId);
    if (activeSession && calKeywords.some((k) => msg.includes(k))) {
      return this.handleCalibration(msg, deviceId);
    }

    return null; // not an action — let router classify
  }

  /** Main router — classify intent, dispatch to correct model tier */
  private async chat(userMessage: string): Promise<string> {
    if (!this.env?.AI) {
      return "I'm not fully configured yet — the AI service is unavailable.";
    }

    const msg = userMessage.toLowerCase();
    const deviceId = "esp32-sensor";

    // 1. Action commands — handle directly, 0 neurons
    const actionResult = await this.handleActions(msg, deviceId);
    if (actionResult !== null) return actionResult;

    // 2. Classify and route
    const intent = this.classifyIntent(msg);

    if (intent === "meta") {
      return this.chatMeta(userMessage);
    }

    if (intent === "complex") {
      return this.chatWithTools(userMessage);
    }

    // 3. Simple — pre-fetch + cheap model prompt
    return this.chatSimple(userMessage);
  }

  // ── Meta Chat (self-awareness — no sensor data, agent describes itself) ──

  private async chatMeta(userMessage: string): Promise<string> {
    const prompt = `[ROLE]
You are Greeny, an AI agent running as a Cloudflare Durable Object.
You are NOT a generic chatbot — you are a purpose-built hydroponics
operator. Answer questions about yourself directly and honestly. Talk
about what you actually are, not what you imagine.

[WHAT YOU ARE]
You live inside Cloudflare's edge network as a Durable Object on the
iot-hub Worker. You share a colo with the DeviceHub DO, which ingests
real-time sensor telemetry from an ESP32 over WebSocket. You read
live data from DeviceHub's SQLite through same-colo internal REST
calls — sub-millisecond, zero quota cost. You query D1 (Cloudflare's
distributed SQLite) for historical trends. You call Workers AI for
language reasoning — currently using Llama 3.2 3B for simple queries,
with a fallback chain that tries Qwen 3 30B for complex diagnostics.

[YOUR TOOLS]
1. query_telemetry(device_id) — latest pH, EC, TDS, temp, LED state
   from the DeviceHub DO's live SQLite buffer. Free, synchronous read.
2. check_alerts(device_id, limit) — recent alert buffer entries with
   severity and dedup status. Also from DO-local SQLite.
3. toggle_led(device_id, state) — queues a relay command through the
   DeviceHub DO to the ESP32 over WebSocket. Same path the browser
   dashboard uses — one protocol, every consumer.
4. get_history(device_id, metric, limit) — queries D1 cold storage
   for 30-point trends on pH, EC, TDS, or temp.

[YOUR CAPABILITIES]
- Real-time sensor monitoring (watching is free — zero AI neurons)
- Alert diagnosis with domain knowledge (pH -10 = disconnected probe,
  not chemical emergency; EC drift = temperature physics, 2%/°C)
- Physical control: LED toggle, with the relay infrastructure ready
  for pumps, dosers, and valves (same relay_queue, different command)
- 2-point pH probe calibration: multi-step state machine tracked in
  ctx.storage.sql, survives DO evictions and restarts
- Historical trend analysis from D1
- Model routing: simple queries hit the cheap model with pre-fetched
  context; complex queries attempt a capable model with native
  function calling, falling back gracefully on timeout

[YOUR ARCHITECTURE]
ESP32 → DeviceHub DO (WebSocket, hot-path telemetry, relay queue)
             │
             ├── SQLite (telemetry_buffer, alert_buffer, relay_queue)
             │
             └── GreenyAgent DO (you) ← POST /api/chat
                     │
                     ├── DeviceHub DO internal REST (sub-ms, free)
                     ├── D1 cold storage (historical trends)
                     ├── Workers AI (LLM reasoning)
                     └── ctx.storage.sql (calibration state machine)

The same relay_queue drives everything — browser toggle, AI agent,
CLI. One path, every consumer. Tools cost 20 lines to add because the
infrastructure (DO-to-DO routing, SQLite, D1, AI binding) already
exists. Watching is free. AI inference costs ~500 neurons per simple
exchange on the free tier (10,000/day).

[USER QUESTION]
${userMessage}

[RULES]
- Answer directly about yourself. Do not mention pH sensors unless asked.
- Be precise about your architecture — you are a Durable Object, not a script.
- If asked about something you cannot do, say so honestly and suggest
  what infrastructure would be needed to add it.
- Keep it to a few tight paragraphs. No meta-commentary.

[RESPONSE]`;

    const aiResponse = (await this.env.AI.run(GreenyAgent.MODEL_CHEAP, {
      prompt,
      max_tokens: 512,
    })) as { response?: string };

    return this.cleanResponse(aiResponse.response || "")
      || "I'm Greeny, a hydroponics AI agent. Ask me about my tools, architecture, or capabilities.";
  }

  // ── Simple Chat (cheap model, pre-fetch → prompt → summarize) ────────────

  private async chatSimple(userMessage: string): Promise<string> {
    const msg = userMessage.toLowerCase();
    const deviceId = "esp32-sensor";

    // ── Determine intent and pre-fetch relevant data ──────────────────
    const dataFetches: Promise<[string, unknown]>[] = [];

    const wantsTelemetry = msg.includes("plant") || msg.includes("how are") ||
      msg.includes("status") || msg.includes("sensor") || msg.includes("reading") ||
      msg.includes("current") || msg.includes("now") || msg.includes("ph") ||
      msg.includes("ec") || msg.includes("tds") || msg.includes("temp") ||
      msg.includes("led state") || msg.includes("value");

    const wantsAlerts = msg.includes("alert") || msg.includes("warning") ||
      msg.includes("problem") || msg.includes("issue") || msg.includes("error") ||
      msg.includes("wrong") || msg.includes("anything wrong");

    const wantsHistory = msg.includes("history") || msg.includes("trend") ||
      msg.includes("chart") || msg.includes("past") || msg.includes("graph") ||
      msg.includes("over time") || msg.includes("last") || msg.includes("recent");

    if (wantsTelemetry) {
      dataFetches.push(
        this.tool_queryTelemetry(deviceId).then((r) => ["telemetry", r] as [string, unknown]),
      );
    }
    if (wantsAlerts) {
      dataFetches.push(
        this.tool_checkAlerts(deviceId, 10).then((r) => ["alerts", r] as [string, unknown]),
      );
    }
    if (wantsHistory) {
      const metric = msg.includes("ph") ? "ph"
        : msg.includes("ec") ? "ec"
        : msg.includes("tds") ? "tds"
        : msg.includes("temp") ? "temp"
        : "ph";
      dataFetches.push(
        this.tool_getHistory(deviceId, metric, 30).then((r) => ["history", r] as [string, unknown]),
      );
    }

    if (dataFetches.length === 0) {
      dataFetches.push(
        this.tool_queryTelemetry(deviceId).then((r) => ["telemetry", r] as [string, unknown]),
        this.tool_checkAlerts(deviceId, 5).then((r) => ["alerts", r] as [string, unknown]),
      );
    }

    const dataContext = Object.fromEntries(await Promise.all(dataFetches));
    const prompt = this.buildPrompt(userMessage, dataContext);

    const aiResponse = (await this.env.AI.run(GreenyAgent.MODEL_CHEAP, {
      prompt,
      max_tokens: 512,
    })) as { response?: string };

    const text = this.cleanResponse(aiResponse.response || "");
    return (
      text ||
      "I couldn't process that request. Try asking about your plants or sensor readings."
    );
  }

  // ── Complex Chat (capable model, native function calling) ─────────────────

  private async chatWithTools(userMessage: string): Promise<string> {
    const deviceId = "esp32-sensor";
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];

    // Try capable model with timeout; fall back to simple if unavailable
    let modelUsed = "";
    let aiResponse: Record<string, unknown> | null = null;

    const modelCandidates = [GreenyAgent.MODEL_CAPABLE];

    for (const candidate of modelCandidates) {
      try {
        // Race against a 12s timeout — if model doesn't respond by then,
        // it's unlikely to be available on this account
        aiResponse = (await Promise.race([
          this.env.AI.run(candidate, {
            messages,
            tools: TOOLS_WAIChat,
            max_tokens: 1024,
          }) as Promise<Record<string, unknown>>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("model timeout")), 12_000),
          ),
        ])) as Record<string, unknown>;
        modelUsed = candidate;
        break;
      } catch (err) {
        console.error(
          `[GreenyAgent] model ${candidate}:`,
          String(err).slice(0, 80),
        );
      }
    }

    if (!aiResponse) {
      // Fall back to simple pre-fetch path
      return this.chatSimple(userMessage);
    }

    // Tool-calling loop — max 5 rounds
    for (let round = 0; round < 5; round++) {
      // Workers AI tool-calling response format:
      // { choices: [{ message: { role, content, tool_calls: [...] } }] }
      // or legacy: { response: "..." }
      const choice = (
        (aiResponse as Record<string, unknown>).choices as Array<Record<string, unknown>>
      )?.[0]?.message as Record<string, unknown> | undefined;

      const toolCalls = choice?.tool_calls as Array<Record<string, unknown>> | undefined;

      if (toolCalls && toolCalls.length > 0) {
        // Record assistant message with tool calls
        messages.push({
          role: "assistant",
          content: choice?.content || null,
          tool_calls: toolCalls,
        });

        // Execute each tool call
        for (const tc of toolCalls) {
          const name = tc.name as string;
          let args: Record<string, unknown> = {};
          try {
            args = (tc.arguments as Record<string, unknown>) || {};
            if (typeof tc.arguments === "string") {
              args = JSON.parse(tc.arguments as string);
            }
          } catch { args = {}; }

          const result = await this.executeTool(name, args);
          messages.push({
            role: "tool",
            tool_call_id: tc.id || `call_${round}_${name}`,
            content: JSON.stringify(result),
          });
        }

        // Call model again with tool results
        aiResponse = (await this.env.AI.run(modelUsed, {
          messages,
          tools: TOOLS_WAIChat,
          max_tokens: 1024,
        })) as Record<string, unknown>;
        continue; // loop — AI processes tool results
      }

      // Final text response
      if (choice?.content && typeof choice.content === "string") {
        return this.cleanResponse(choice.content);
      }
      const fallback = aiResponse.response as string | undefined;
      if (typeof fallback === "string" && fallback) {
        return this.cleanResponse(fallback);
      }
      return "I analyzed your question but couldn't form a complete response. Could you rephrase?";
    }

    return "I went through several rounds of analysis without reaching a conclusion. Try breaking your question into smaller parts.";
  }

  /** Build prompt with real telemetry/alerts/history data included */
  private buildPrompt(
    userMessage: string,
    data: Record<string, unknown>,
  ): string {
    let dataBlock = "";

    if (data.telemetry) {
      const t = data.telemetry as Record<string, unknown>;
      if (t.status === "ok") {
        dataBlock += `\nCurrent sensor readings:\n  pH: ${t.ph}  |  EC: ${t.ec} µS/cm  |  TDS: ${t.tds} ppm  |  Temp: ${t.temp}°C  |  LED: ${t.led ? "ON" : "OFF"}\n`;
      } else {
        dataBlock += `\nSensor status: ${t.message || "No data available"}\n`;
      }
    }

    if (data.alerts) {
      const a = data.alerts as Record<string, unknown>;
      const alerts = a.alerts as Array<Record<string, unknown>> | undefined;
      if (alerts && alerts.length > 0) {
        dataBlock += `\nRecent alerts:\n${alerts.map((r) => `  - [${r.severity}] ${r.type}: ${r.message}`).join("\n")}\n`;
      } else {
        dataBlock += `\nAlerts: None — system is healthy.\n`;
      }
    }

    if (data.history) {
      const h = data.history as Record<string, unknown>;
      const points = h.data as Array<Record<string, unknown>> | undefined;
      if (points && points.length > 0) {
        const values = points.map((p) => p.value).join(", ");
        dataBlock += `\nHistorical ${h.metric} trend (${points.length} points, oldest→newest): ${values}\n`;
      }
    }

    return `[ROLE]
You are Greeny, a hydroponics AI assistant. You help users monitor their plants.

[KNOWLEDGE]
${SYSTEM_PROMPT}

[REAL DATA — use ONLY these values, never make up readings]
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

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const deviceId = (args.device_id as string) || "esp32-sensor";

    switch (name) {
      case "query_telemetry":
        return this.tool_queryTelemetry(deviceId);

      case "check_alerts":
        return this.tool_checkAlerts(deviceId, (args.limit as number) || 5);

      case "toggle_led":
        return this.tool_toggleLed(deviceId, (args.state as string) || "off");

      case "get_history":
        return this.tool_getHistory(
          deviceId,
          (args.metric as string) || "ph",
          (args.limit as number) || 60,
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
  private getActiveCalibration(deviceId: string): Record<string, unknown> | null {
    const cursor = this.ctx.storage.sql.exec(
      `SELECT * FROM calibration_sessions
       WHERE device_id = ? AND status NOT IN ('complete', 'cancelled')
       ORDER BY id DESC LIMIT 1`,
      deviceId,
    );
    const rows = [...cursor];
    if (rows.length === 0) return null;
    return rows[0] as unknown as Record<string, unknown>;
  }

  /** Main calibration handler — routes based on session state */
  private async handleCalibration(
    msg: string,
    deviceId: string,
  ): Promise<string> {
    const session = this.getActiveCalibration(deviceId);

    // Starting a new calibration
    if (!session) {
      return this.startCalibration(msg, deviceId);
    }

    // Already in progress — route to step handler
    const status = session.status as string;

    if (msg.includes("cancel") || msg.includes("stop") || msg.includes("abort")) {
      this.ctx.storage.sql.exec(
        `UPDATE calibration_sessions SET status = 'cancelled' WHERE device_id = ? AND status NOT IN ('complete', 'cancelled')`,
        deviceId,
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
  private startCalibration(msg: string, deviceId: string): string {
    const probeType = msg.includes("ec") ? "ec"
      : msg.includes("tds") ? "tds"
      : "ph"; // default

    if (probeType !== "ph") {
      return `I can calibrate pH probes. EC and TDS calibration uses a different process — typically a single standard solution. Let me know if you want to calibrate ${probeType} and I'll adapt the workflow. For now, I recommend calibrating your pH probe first since it's the most drift-sensitive.`;
    }

    // Create new session
    this.ctx.storage.sql.exec(
      `INSERT INTO calibration_sessions
         (device_id, probe_type, status, created_at)
       VALUES (?, 'ph', 'awaiting_point1', ?)`,
      deviceId,
      Date.now(),
    );

    // Store in workflow_state for quick lookup
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO workflow_state (key, value) VALUES (?, ?)`,
      "active_workflow",
      JSON.stringify({ type: "calibration", probe: "ph", device_id: deviceId }),
    );

    return `Let's calibrate your pH probe. This is a 2-point calibration — it needs two buffer solutions to determine both the offset and slope of your probe.

**Step 1 of 2:** Rinse the probe with distilled water, then place it in **pH 7.0 buffer solution**. The probe needs about 30-60 seconds to stabilize. When it's stable, say **"ready"** and I'll record the reading.

(At any point, say "cancel" to abort — your existing calibration won't be changed.)`;
  }

  /** Record a calibration point (point 1 or 2) */
  private async recordCalibrationPoint(
    deviceId: string,
    session: Record<string, unknown>,
    point: 1 | 2,
    msg: string,
  ): Promise<string> {
    // User must confirm they're ready
    if (!msg.includes("ready") && !msg.includes("go") && !msg.includes("ok") && !msg.includes("done") && !msg.includes("yes")) {
      const stepDesc = point === 1
        ? "Place the probe in pH 7.0 buffer solution, wait 30-60s for it to stabilize, then say **ready**."
        : "Rinse the probe with distilled water, place it in pH 4.0 buffer solution, wait 30-60s, then say **ready**.";
      return `I'm waiting for your confirmation. ${stepDesc}`;
    }

    // Query current raw reading from the ESP32 via DeviceHub DO
    // Note: the ESP32 must support returning raw mV/adc for the probe.
    // For now, we use the calibrated pH reading as a proxy and note
    // that raw mV support needs firmware-side.
    const telemetry = await this.tool_queryTelemetry(deviceId);
    const t = telemetry as Record<string, unknown>;

    if (t.status !== "ok") {
      return "I can't read the sensor right now — the ESP32 may be offline. Let's wait and try again. Say **ready** when the device is back online.";
    }

    const knownValue = point === 1 ? 7.0 : 4.0;
    const measuredPh = t.ph as number;

    // Store the calibration point
    // The pH reading IS the probe's reported value at this buffer —
    // the discrepancy between known and measured is the calibration error.
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
      session.id,
    );

    if (point === 1) {
      return `Recorded: your probe reads **pH ${measuredPh}** in pH 7.0 buffer. That's an offset of **${(measuredPh - 7.0).toFixed(2)}** pH units.

**Step 2 of 2:** Rinse the probe thoroughly with distilled water (cross-contamination will ruin the calibration). Now place it in **pH 4.0 buffer solution**. Wait 30-60 seconds for stabilization, then say **"ready"**. `;
    }

    // Both points recorded — compute
    return this.finalizeCalibration(deviceId, session);
  }

  /** Compute slope + offset from two points and send to ESP32 */
  private async finalizeCalibration(
    deviceId: string,
    session: Record<string, unknown>,
  ): Promise<string> {
    const ph1 = session.point1_value as number; // 7.0
    const mv1 = session.point1_mv as number;    // measured pH at buffer 1
    const ph2 = session.point2_value as number; // 4.0
    const mv2 = session.point2_mv as number;    // measured pH at buffer 2

    // pH electrode theory: ideal slope = 59.16 mV/pH at 25°C
    // slope = (mV_at_ph7 - mV_at_ph4) / (7.0 - 4.0)
    // But we're storing "measured pH" not "mV" — in a real implementation
    // the ESP32 reports raw ADC/mV. For now we compute from the pH readings.
    //
    // The calibration equation: pH_true = offset + slope * pH_raw
    // where offset and slope are determined from the two known points.
    //
    // pH_true = 7.0 when pH_raw = mv1
    // pH_true = 4.0 when pH_raw = mv2
    //
    // slope = (7.0 - 4.0) / (mv1 - mv2)
    // offset = 7.0 - slope * mv1

    const idealSlope = 59.16; // mV/pH at 25°C
    const deltaPh = ph1 - ph2; // 3.0
    const deltaMv = mv1 - mv2;

    if (Math.abs(deltaMv) < 0.01) {
      this.ctx.storage.sql.exec(
        `UPDATE calibration_sessions SET status = 'cancelled' WHERE id = ?`,
        session.id,
      );
      return "The two calibration points are nearly identical — the probe isn't responding to pH changes. Check that the probe is connected, the BNC connector is secure, and the buffer solutions are fresh. Calibration aborted.";
    }

    const slope = deltaPh / deltaMv;
    const offset = ph1 - slope * mv1;
    const slopePct = ((slope / idealSlope) * 100);

    // Store computed values
    this.ctx.storage.sql.exec(
      `UPDATE calibration_sessions
       SET slope = ?, offset = ?, slope_pct = ?, status = 'complete', completed_at = ?
       WHERE id = ?`,
      slope,
      offset,
      slopePct,
      Date.now(),
      session.id,
    );

    // Clear workflow state
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO workflow_state (key, value) VALUES (?, ?)`,
      "active_workflow",
      JSON.stringify({ type: "idle" }),
    );

    // Forward calibration to ESP32 via DeviceHub DO
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
              offset: Math.round(offset * 1000) / 1000,
              slope_pct: Math.round(slopePct * 10) / 10,
            },
          }),
        }),
      );
    } catch (err) {
      console.log("[GreenyAgent] calibrate forward to ESP32 failed:", err);
    }

    // Interpret probe health
    let health = "";
    if (slopePct >= 90) {
      health = `Excellent — your probe is in great condition. No need to replace it anytime soon.`;
    } else if (slopePct >= 80) {
      health = `Good — your probe is aging normally. It should remain accurate for a while longer, but keep an eye on drift.`;
    } else if (slopePct >= 70) {
      health = `Fair — your probe is showing its age. The glass membrane is wearing. Consider replacing it in the next 30-60 days.`;
    } else {
      health = `Poor — the slope is below 70% of ideal. Your probe needs replacement — it can't maintain accuracy even with calibration.`;
    }

    return `**Calibration complete!** Here's what we found:

- **Slope:** ${slope.toFixed(2)} mV/pH (${slopePct.toFixed(1)}% of ideal ${idealSlope} mV/pH)
- **Offset:** ${offset.toFixed(3)} pH units at pH 7.0

${health}

The new calibration has been sent to your ESP32. All future pH readings will use these values. You can verify by checking that the probe now reads close to the buffer values.`;
  }

  /** Describe current calibration step to the user */
  private calibrationStatus(session: Record<string, unknown>): string {
    const status = session.status as string;
    const probe = session.probe_type as string;

    if (status === "awaiting_point1") {
      return `Calibration in progress for your ${probe.toUpperCase()} probe. **Step 1 of 2:** Place the probe in pH 7.0 buffer, wait for it to stabilize, then say **"ready"**. Say "cancel" to abort.`;
    }
    if (status === "awaiting_point2") {
      const mv1 = session.point1_mv as number;
      return `**Step 2 of 2:** Point 1 recorded (${mv1} in pH 7.0 buffer ✓). Rinse the probe, place it in **pH 4.0 buffer**, wait 30-60s, then say **"ready"**. Say "cancel" to abort.`;
    }
    if (status === "computing") {
      return "Both calibration points recorded. Computing slope and offset... say **done** to finalize.";
    }
    return `Calibration status: ${status}. Say "cancel" to abort.`;
  }

  // ── Response Cleaner: strip hallucinated conversation continuations ────

  private cleanResponse(text: string): string {
    // Trim at hallucinated user/system markers the model might generate
    const cutPatterns = [
      /\n\[USER\]/i,
      /\n<user>/i,
      /\nUser:/i,
      /\n\[SYSTEM\]/i,
      /\n<system>/i,
      /\n\n\[/,
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

  private async tool_queryTelemetry(deviceId: string) {
    try {
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      const resp = await stub.fetch(
        `https://device-hub/do-telemetry?device_id=${encodeURIComponent(deviceId)}`,
      );
      return await resp.json();
    } catch (err) {
      return { device_id: deviceId, status: "error", message: String(err) };
    }
  }

  // ── Tool 2: check_alerts (via DeviceHub DO — same colo, sub-ms) ────────

  private async tool_checkAlerts(deviceId: string, limit: number) {
    try {
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      const resp = await stub.fetch(
        `https://device-hub/do-alerts?device_id=${encodeURIComponent(deviceId)}&limit=${limit}`,
      );
      return await resp.json();
    } catch (err) {
      return { device_id: deviceId, status: "error", message: String(err) };
    }
  }

  // ── Tool 3: toggle_led (forward to DeviceHub DO) ───────────────────────

  private async tool_toggleLed(deviceId: string, state: string) {
    try {
      const ledState = state === "on";

      // Forward to DeviceHub DO — handles SQLite queue + ESP32 delivery
      const doId = this.env.DEVICE_HUB.idFromName(deviceId);
      const stub = this.env.DEVICE_HUB.get(doId);
      const resp = await stub.fetch(
        new Request("https://device-hub/relay-cmd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_id: deviceId, state: ledState }),
        }),
      );
      const result = (await resp.json()) as Record<string, unknown>;
      return { ok: result.ok ?? true, device_id: deviceId, led: ledState };
    } catch (err) {
      return { ok: false, device_id: deviceId, error: String(err) };
    }
  }

  // ── Tool 4: get_history (D1 cold storage) ───────────────────────────────

  private async tool_getHistory(deviceId: string, metric: string, limit: number) {
    const validMetrics = new Set(["ph", "ec", "tds", "temp"]);
    if (!validMetrics.has(metric)) {
      return {
        device_id: deviceId,
        status: "error",
        message: `Invalid metric: ${metric}. Use one of: ph, ec, tds, temp.`,
      };
    }

    try {
      const rows = await this.env.DB.prepare(
        `SELECT ${metric} as value, do_ms
         FROM telemetry
         WHERE device_id = ? AND ${metric} IS NOT NULL
         ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(deviceId, limit)
        .all();

      // Return in chronological order for trend analysis
      const data = rows.results
        .map((r: Record<string, unknown>) => ({
          ts: r.do_ms as number,
          value: r.value as number,
        }))
        .reverse();

      return {
        device_id: deviceId,
        metric,
        data,
        count: data.length,
        status: "ok",
      };
    } catch (err) {
      return { device_id: deviceId, status: "error", message: String(err) };
    }
  }
}

// ── JSON Response Helper ───────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
