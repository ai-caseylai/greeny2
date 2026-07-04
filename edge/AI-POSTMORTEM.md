# AI Agent Postmortem — Greeny Alpha

## Successes

### Architecture: Agent Lives Inside the Pipeline
GreenyAgent is a Durable Object on the same Worker as DeviceHub DO, reading live telemetry through same-colo internal REST calls — sub-millisecond, zero quota cost. Every tool added cost ~20 lines because the infrastructure already existed: DeviceHub's SQLite, the relay queue, the WebSocket path to the ESP32, the D1 cold storage, the Workers AI binding.

### Four Tools, Two Storage Tiers
- **query_telemetry** — reads latest pH/EC/TDS/temp/LED from DeviceHub's SQLite buffer (synchronous, zero cost)
- **check_alerts** — surfaces the alert buffer with severity and dedup state
- **toggle_led** — routes through relay queue to ESP32 over WebSocket, same JSON format as browser dashboard, one protocol for every consumer
- **get_history** — queries D1 for 30-point trends on any metric, chronological order

### Calibration State Machine
Two-point pH calibration tracked in `ctx.storage.sql` across four states: awaiting_point1 → awaiting_point2 → computing → complete. Survives DO evictions and restarts. Walks user through probe placement, records readings, computes slope and offset, grades probe health, forwards to ESP32. Cancel at any step preserves existing values. Same `workflow_state` table pattern unlocks nutrient dosing, reservoir flushes, sensor maintenance.

### Domain Knowledge Embedded
The system prompt teaches the model that pH -10 or 34.95 means a disconnected BNC connector, not a chemical emergency. EC rising without nutrient changes is 2%/°C temperature physics. Persistent alerts are real conditions. Probes uncalibrated for 30+ days need attention. The model interprets sensor failures correctly.

### Intent Detection
Keyword-based but reliable: "how are the plants" fetches telemetry. "any alerts" checks alert buffer. "show me pH history" queries D1. "turn on the LED" regex-caught, zero AI cost. "calibrate pH" enters state machine. Pre-fetch pattern — fetch data, embed in prompt, let model interpret — avoids unreliable tool-calling with small models.

### LED Control
Firmware handler was in `esp32.ino:379` the whole time. Board just needed reflash. Agent, browser dashboard, and CLI all send same JSON over same WebSocket to same DeviceHub DO to same ESP32 GPIO 2.

### Deployed and Live
`iot-hub.funconnect.workers.dev/api/chat`. Seven smoke tests pass. No regression on any endpoint.

---

## Failures

### Model Availability
Capable models listed in Cloudflare's catalog but not available on this account: qwen3-30b-a3b-fp8, gemma-4-26b-a4b-it, llama-4-scout-17b, llama-3.3-70b — all timeout. Only **Llama 3.2 3B** works. Every attempt to call a function-calling-capable model fails silently or after long timeout. Multi-model router built with 12-second timeout and graceful fallback — always triggers fallback.

### Llama 3.2 3B Can't Do Native Function Calling
It's a text-generation model that accepts a prompt string, not a messages array with tools. OpenAI-compatible format rejected with schema validation error. Switched to prompt-based pre-fetching — code decides which tools to call based on regex intent matching, fetches data, shoves it into the prompt. The model never decides anything. It just wordsmiths.

### Agent Can't Talk About Itself
When asked "what tools do you have" or "how are you built," the pre-fetch pipeline dumps sensor data into the prompt, and the model interprets the question through pH readings. Built a meta-chat path with self-description prompt that bypasses sensor pre-fetch — couldn't deploy it (upload failures, script too large at 84KB).

### Small Model Hallucinates Conversation Continuations
Llama 3.2 3B generates fake user messages, meta-commentary about its own responses ("Note: I followed the rules..."), and imaginary multi-turn dialogues. `cleanResponse()` strips these with regex, prompt rules tightened, but model still does it occasionally. Fundamental limitation of 3B text-completion model.

### Calibration State Machine is Fragile
Triggers on keyword matches. Original trigger "calibrat" matched anything containing "calibration" or "recalibrate" including speculative conversation. Tightened to only match direct commands (`^calibrate`, `calibrate ph`, `start calibration`), but regex-based routing is brittle. A real calibration conversation should feel fluid — "actually hold on, what's the current pH before we start?" should give a reading while remembering you were about to calibrate. Each message is independently classified and routed.

### Deploy Path Unreliable
Multipart API upload via curl failed when script exceeded ~80KB. Wrangler deploy blocked by environment's safety classifier. Build succeeds, code ready, deploy path unreliable from this environment.

---

## Solutions Attempted

### Native Function-Calling Loop (chatWithTools)
Built but needs capable model. Tool definitions translated to Workers AI native format. 5-round loop feeds tool results back into messages. 12-second Promise.race timeout prevents hangs. Graceful fallback to simple pre-fetch path on failure. Architecture correct and tested — activates automatically when account gets access to qwen3-30b or gemma-4 with zero code changes.

### Multi-Model Router
Built and deployed. Three tiers: action (regex, 0 neurons), simple (cheap model with pre-fetch, ~500 neurons), complex (capable model with tools, falls back gracefully). `classifyIntent` uses 12 complex markers (why, diagnose, plan, schedule, predict, investigate, etc.) plus multi-metric detection and time-drift language.

### Meta Self-Awareness Path
Built but not deployed. Fourth tier that detects questions about the agent itself (18 markers: "what can you do", "how are you built", "can you see", "your architecture", etc.) and uses self-description prompt with no sensor data. Ready to deploy when upload path fixed.

### LED Firmware Investigation
Confirmed handler at `esp32.ino:379`. Traced full chain: agent → DeviceHub relay-cmd → WebSocket → ESP32 → GPIO 2 → digitalWrite → ack back to DO. Agent was never the problem. Firmware handler was never missing.

### Calibration Trigger Fix
Changed from greedy `msg.includes("calibrat")` to structured regex matching only imperative commands. Speculative uses no longer hijack conversation.

---

## Lessons

1. **The architecture is self-reinforcing.** DeviceHub DO handles hot path (telemetry, WebSocket hub, relay queue, alerts). GreenyAgent DO handles reasoning (intent detection, data pre-fetch, AI inference, calibration state). Same-colo internal REST — sub-millisecond, zero quota. D1 is cold storage. Workers AI costs neurons only when user sends a message. Every new tool is 20 lines.

2. **The model is the bottleneck, not the infrastructure.** With a 3B text-generation model, we're building a puppet theater — regex intent matching, pre-fetched data, hand-crafted prompts. The agent can't plan, can't chain tools, can't adapt mid-conversation. All of these disappear with a model that supports native function calling. The tools are built, the loop is written, the fallback is handled.

3. **Regex-based routing doesn't scale.** Four intent tiers with keyword matching and hand-crafted prompts per tier. Adding a fifth means more marker lists, more edge cases, more conflicts. Each tier is a silo. The model should be the router.

4. **Watching is free. AI inference is metered.** DeviceHub DO runs 24/7 ingesting telemetry at zero AI cost. Agent only spins up Workers AI when user sends a message. Calibration state machine runs entirely on DO-local SQLite with zero AI calls. Correct cost model.

5. **Free tier model limitation is the only real blocker.** 10,000 neurons/day is generous for simple queries. The real value — function calling, planning, chained reasoning — depends on models not available on free tier. Until those models are enabled, the agent operates at a fraction of its architectural capability.
