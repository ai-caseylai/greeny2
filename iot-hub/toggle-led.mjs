#!/usr/bin/env node
/**
 * toggle-led.mjs — Random LED toggler
 * Connects to the IoT Hub DO via WSS, sends random set_led commands,
 * logs timestamps and RTT to toggle-log.jsonl.
 *
 * Run: node toggle-led.mjs
 * Stop: Ctrl+C — logs saved to toggle-log.jsonl
 * Stats: node toggle-led.mjs --stats  (reads log and prints distribution)
 */

const WS_URL = "wss://iot-hub.funconnect.workers.dev/dashboard/esp32-01";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(__dirname, "toggle-log.jsonl");

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "fs";

const args = process.argv.slice(2);

// ── Stats mode ──────────────────────────────────
if (args.includes("--stats")) {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found at", LOG_FILE);
    process.exit(0);
  }
  const lines = readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  const rtts = [];
  const durations = [];
  for (const line of lines) {
    const r = JSON.parse(line);
    if (r.rttMs != null && r.rttMs > 0 && r.rttMs < 10000) rtts.push(r.rttMs);
    if (r.durationMs != null && r.durationMs > 0) durations.push(r.durationMs);
  }

  if (rtts.length === 0) {
    console.log("No valid RTT entries found.");
    process.exit(0);
  }

  rtts.sort((a, b) => a - b);
  const min = rtts[0];
  const max = rtts[rtts.length - 1];
  const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  const p50 = rtts[Math.floor(rtts.length * 0.50)];
  const p90 = rtts[Math.floor(rtts.length * 0.90)];
  const p99 = rtts[Math.floor(rtts.length * 0.99)];

  // ── ASCII histogram ───────────────────────────
  const bucketSize = Math.max(1, Math.ceil((max - min) / 25));
  const buckets = {};
  for (const r of rtts) {
    const b = Math.floor(r / bucketSize) * bucketSize;
    buckets[b] = (buckets[b] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(buckets));

  console.log(`\n=== LED Toggle Latency Distribution ===`);
  console.log(`Samples: ${rtts.length}  |  Min: ${min}ms  |  Max: ${max}ms`);
  console.log(`Avg: ${avg.toFixed(1)}ms  |  P50: ${p50}ms  |  P90: ${p90}ms  |  P99: ${p99}ms`);
  console.log(`\nRTT (ms) distribution:\n`);

  for (const [bucket, count] of Object.entries(buckets).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const barLen = Math.ceil((count / maxCount) * 40);
    const bar = "█".repeat(barLen);
    console.log(`  ${String(bucket).padStart(5)} | ${bar} ${count}`);
  }
  // ── Duration distribution ─────────────────────
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    console.log(`\n=== LED State Duration Distribution ===`);
    console.log(`Samples: ${durations.length}`);

    const fmt = (ms) => {
      if (ms < 1000) return `${ms}ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
      if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
      return `${(ms / 3600000).toFixed(1)}h`;
    };

    for (const d of durations) {
      const onOff = d === durations[durations.indexOf(d)] ? "" : ""; // simplified
    }

    // Group by order-of-magnitude
    const dBuckets = {};
    for (const d of durations) {
      let key;
      if (d < 10000) key = "<10s";
      else if (d < 60000) key = "10s-1m";
      else if (d < 300000) key = "1-5m";
      else if (d < 1800000) key = "5-30m";
      else if (d < 3600000) key = "30m-1h";
      else if (d < 21600000) key = "1-6h";
      else key = ">6h";
      dBuckets[key] = (dBuckets[key] || 0) + 1;
    }
    const dMax = Math.max(...Object.values(dBuckets));
    const order = ["<10s", "10s-1m", "1-5m", "5-30m", "30m-1h", "1-6h", ">6h"];
    for (const key of order) {
      if (!dBuckets[key]) continue;
      const barLen = Math.ceil((dBuckets[key] / dMax) * 40);
      console.log(`  ${key.padEnd(8)} | ${"█".repeat(barLen)} ${dBuckets[key]}`);
    }
  }

  console.log();

  process.exit(0);
}

// ── Toggle mode ─────────────────────────────────
let ws;
let toggleCount = 0;
let connected = false;
let lastLed = null;       // previous LED state
let lastChangeTs = null;  // when the LED last CHANGED state (Date.now())
let heartbeatInterval = null;

function log(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  appendFileSync(LOG_FILE, line + "\n");
  console.log(line);
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connected = true;
    log({ event: "connected" });
    scheduleNext();
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "state" && msg.doTs) {
        const rttMs = Date.now() - msg.doTs;
        const now = Date.now();

        // Track ON/OFF duration between state CHANGES
        let durationMs = null;
        if (lastLed !== null && msg.led !== lastLed && lastChangeTs) {
          durationMs = now - lastChangeTs;
        }
        if (lastLed === null || msg.led !== lastLed) {
          lastLed = msg.led;
          lastChangeTs = now;
        }

        log({ event: "ack", led: msg.led, doTs: msg.doTs, rttMs, durationMs });
      }
    } catch {}
  };

  ws.onclose = () => {
    connected = false;
    log({ event: "disconnected" });
    console.log("Reconnecting in 5s…");
    setTimeout(connect, 5000);
  };

  ws.onerror = () => {
    log({ event: "error" });
  };

  // Heartbeat: print current duration every 30s
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (lastLed !== null && lastChangeTs) {
      const dur = Date.now() - lastChangeTs;
      console.log(`  💓 LED=${lastLed ? "ON " : "OFF"} for ${fmtDelay(dur)}`);
    }
  }, 30000);
}

function randomDelay() {
  const r = Math.random();
  if (r < 0.60)   return (2 + Math.random() * 28) * 1000;         // 60%: 2–30s
  if (r < 0.80)   return (60 + Math.random() * 240) * 1000;       // 20%: 1–5 min
  if (r < 0.95)   return (600 + Math.random() * 1200) * 1000;     // 15%: 10–30 min
  return (3600 + Math.random() * 18000) * 1000;                    //  5%: 1–6 hours
}

function fmtDelay(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(0)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function scheduleNext() {
  if (!connected) return;
  const delay = randomDelay();
  console.log(`  ⏳ next toggle in ${fmtDelay(delay)}`);
  setTimeout(() => {
    if (!connected) return;
    const state = Math.random() > 0.5;
    toggleCount++;
    ws.send(JSON.stringify({ command: "set_led", state, ts: Date.now() }));
    console.log(`  → ${state ? "ON " : "OFF"}  #${toggleCount}`);
    scheduleNext();
  }, delay);
}

// ── Main ────────────────────────────────────────
console.log(`Toggle bot starting — WS: ${WS_URL}`);
console.log(`Log: ${LOG_FILE}`);
console.log(`Ctrl+C to stop, then run with --stats for distribution\n`);

connect();

// Graceful shutdown
process.on("SIGINT", () => {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  console.log(`\nStopped after ${toggleCount} toggles.`);
  if (lastLed !== null) {
    console.log(`Final state: LED=${lastLed ? "ON" : "OFF"} for ${fmtDelay(Date.now() - lastChangeTs)}`);
  }
  console.log(`Log saved to ${LOG_FILE}`);
  console.log(`Run: node toggle-led.mjs --stats`);
  if (ws) ws.close();
  process.exit(0);
});
