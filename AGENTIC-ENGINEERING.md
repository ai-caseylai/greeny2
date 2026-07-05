# Agentic Engineering — Lessons from Greeny Alpha

This project wasn't built by a single developer. It was built by a team of AI agents — Alpha, Edge, Firmware, AI, and Beauty — each with bounded scope, each reading only their module spec, each communicating through a single shared API surface. The methodology is what made it work. The API surface is what made it possible.

---

## The Methodology: Agent-Decomposed Architecture

Traditional software engineering decomposes by technical layer: frontend team, backend team, firmware team. Each team needs context about the entire stack to make changes. A frontend developer fixing a CSS bug needs to know the API response shape, the database schema, and the deployment process.

AI agents have a context window, not a brain. Loading the entire codebase exhausts it before the first change. Our decomposition split by **module boundary**, not technical layer:

| Agent | Scope | Context Budget |
|---|---|---|
| Agent Alpha | Architecture, spec files, smoke test orchestration | ~400 lines |
| Agent Edge | Worker, DO, D1, auth, REST API, dashboard HTML | ~750 lines |
| Agent Firmware | ESP32 sketches, flashing, calibration | ~530 lines |
| Agent AI | Cloudflare agent, Workers AI, skills | ~400 lines |
| Agent Beauty | React SPA, CSS, WebSocket integration | ~500 lines |

Each agent loaded exactly two files into context: the shared `PROTOCOL.md` (the wire contract) and its own `MODULE.md` (implementation spec). The firmware agent never read `device-hub.ts`. The edge agent never read `esp32.ino`. They communicated only through the protocol — message shapes, field names, connection URLs.

**Key insight:** The protocol IS the interface. When Agent Beauty needed to fix the chart drain bug, they didn't read the DO source. They read `PROTOCOL.md` to see that `{type:"state"}` had flat fields while `{type:"telemetry_update"}` had nested ones. The answer was in the contract, not the code.

---

## The Enabler: Single API Surface

Every consumer — browser, CLI, AI agent, Abu Desktop — uses the same REST endpoints, the same WebSocket broadcasts, the same JWT auth. One token, one surface, zero adapters.

```
                    POST /api/relay {"relay1":1}
Browser Dashboard ──────────────┐
Cloudflare Agent ───────────────┤
Abu Desktop ────────────────────┘
                                    │
                              IoT Worker
                              (iot-hub.funconnect.workers.dev)
                                    │
                              DeviceHub DO
                              (per-device, SQLite, hibernation)
                                    │
                              WSS → ESP32
                                    │
                              GPIO 2 → LED ON
```

All three consumers triggered the same LED by sending the same JSON to the same endpoint. None needed to know about the others. The DO broadcast `{type:"state",led:true}` to all three WebSocket connections simultaneously. They all saw the result at the same time.

**This is the architectural insight that enables agentic coordination:** when every agent sees the same surface, they don't need to coordinate with each other — they coordinate through the system. Agent Alpha didn't tell Agent Beauty to update the LED UI. The DO broadcast did. Agent Beauty didn't tell Agent AI the LED was now on. The DO broadcast did. The system is the communication channel.

---

## Cloudflare API as Agent Control Plane

Beyond the REST API, the Cloudflare API itself is an agent-accessible surface:

- `GET /accounts/.../workers/scripts` — deployed Workers, bindings, compatibility flags
- `GET /accounts/.../d1/database` — D1 schema, row counts, storage size
- `POST /accounts/.../graphql` — quota usage, request counts, duration
- `PUT /accounts/.../workers/scripts/{name}` — deploy new code
- `wrangler tail` — real-time logs

One token (`FunConnect`) grants access to all of it. An AI agent can inspect the pipeline at every layer with the same credential. What a human operator checks across 5 dashboards — the agent checks in a single prompt: "Are we healthy?"

---

## What Made This Work (And What Broke)

**The protocol was the single source of truth.** `PROTOCOL.md` defined every message shape, every field name, every connection URL. When Agent Edge added Casey-protocol compat (`{type:"relay"}` → `{command:"set_led"}`), Agent Beauty's React app worked without changes. When Agent AI needed to query telemetry, they didn't read the DO source — they read `PROTOCOL.md` and called `GET /api/telemetry`.

**The API surface was agent-accessible from day one.** Every endpoint returns structured JSON. Every WebSocket broadcast follows the same `{type, ...}` pattern. JWT auth is standard Bearer tokens. CORS headers on every response. No SOAP, no GraphQL, no custom binary protocol. Agents can curl it from a terminal or fetch it from a browser.

**The module specs prevented context bleed.** `FIRMWARE.md` told the firmware agent about GPIO pins, sensor physics, and EEPROM layout. It never mentioned DOs, D1, or JWT. `EDGE.md` told the edge agent about Worker routes, SQLite tables, and alarm handlers. It never mentioned ADC pins or Nernst equations. The spec files were the firewall between agents' context windows.

**Where it broke: deploys breaking the WebSocket.** Every `esbuild` + `curl PUT` deploy restarted the DO, dropping all WebSocket connections. The ESP32 reconnected within 5 seconds, but the outgoing path went half-open — telemetry flowed (ESP32→DO), commands didn't (DO→ESP32). This was invisible to the agents because the telemetry made it look healthy. The fix required a human to notice the pattern and add a firmware-side watchdog. This is the kind of cross-module failure that no single agent could diagnose from their module spec alone.

**Where it broke: EEPROM validation.** The `loadCalibration()` function had a validation range of ±1000 for `ecOffset`, but the inverted TDS board needed ~2275. Every boot reset it to 0. Worse, `EEPROM.get()` overwrites the variable BEFORE validation — hardcoded defaults were silently clobbered. This was finally caught when calibration values persisted across replugs but vanished after flashes. Required reading both the firmware source AND the EEPROM spec to understand.

---

## The Next Frontier: ESP-Claw

The same API surface that enables cloud agents can run on the edge. An ESP32 with a thin agent — ESP-Claw — watches sensor data locally, makes sub-millisecond decisions (kill pump if EC spikes), and calls out to the Cloudflare agent only when it needs deeper reasoning or user communication.

```
ESP-Claw (local, sub-ms)          Cloudflare Agent (edge, ms)
  ├── Threshold reflexes            ├── History queries
  ├── Anomaly detection             ├── LLM reasoning
  └── Emergency shutdown            ├── Calibration guidance
                                    └── User communication
```

Both agents use the same WSS+JSON protocol. Both are first-class consumers on the same API surface. The local agent is fast and dumb. The cloud agent is slower and smart. Together they form a hierarchical intelligence — reflexes at the edge, reasoning in the cloud.

---

## Why This Matters

Most AI-assisted development treats the agent as a tool — generating code snippets, answering questions, writing documentation. Greeny Alpha treated agents as a team — each with bounded scope, each reading a shared contract, each communicating through a single API surface. The methodology scaled because the agents didn't need to understand each other's code. They only needed to understand the protocol.

This is not "AI wrote the code." This is "agents coordinated through an interface." The difference is that the interface — `PROTOCOL.md`, the REST API, the WebSocket broadcast — outlives any single agent's context window. A new agent joins the team by reading the contract. The agents who built the original system can be replaced, and the system continues to function, because the surface they built against is documented, stable, and accessible to any consumer with a token.
