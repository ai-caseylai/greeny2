"""
graph-results.py — Read toggle-log.jsonl and produce distribution charts.
Saves to Desktop as iot-hub-results.png
"""

import json
import os
from pathlib import Path

LOG_FILE = Path(__file__).parent / "toggle-log.jsonl"
DESKTOP = Path.home() / "Desktop" / "iot-hub-results.png"

# ── Load data ───────────────────────────────────
rtts = []
durations = []

with open(LOG_FILE) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        if r.get("rttMs") and 0 < r["rttMs"] < 10000:
            rtts.append(r["rttMs"])
        if r.get("durationMs") and r["durationMs"] > 0:
            durations.append(r["durationMs"] / 1000)  # convert to seconds

rtts.sort()
durations.sort()

# ── Matplotlib ───────────────────────────────────
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

fig, axes = plt.subplots(2, 2, figsize=(12, 9))
fig.suptitle(f"IoT Hub — Overnight Results ({len(rtts)} toggles)", fontsize=14, fontweight="bold")

# ── 1. RTT histogram ────────────────────────────
ax = axes[0, 0]
ax.hist(rtts, bins=30, color="#22d3ee", edgecolor="#0f172a", alpha=0.9)
p50 = np.percentile(rtts, 50)
p90 = np.percentile(rtts, 90)
p99 = np.percentile(rtts, 99)
ax.axvline(p50, color="#facc15", linestyle="--", linewidth=2, label=f"P50: {p50:.0f}ms")
ax.axvline(p90, color="#f97316", linestyle="--", linewidth=2, label=f"P90: {p90:.0f}ms")
ax.axvline(p99, color="#ef4444", linestyle="--", linewidth=2, label=f"P99: {p99:.0f}ms")
ax.set_title(f"RTT Distribution (avg: {np.mean(rtts):.0f}ms, min: {min(rtts):.0f}ms, max: {max(rtts):.0f}ms)")
ax.set_xlabel("RTT (ms)")
ax.set_ylabel("Count")
ax.legend(fontsize=9)
ax.set_facecolor("#1e293b")
ax.tick_params(colors="#94a3b8")

# ── 2. RTT over time ────────────────────────────
ax = axes[0, 1]
times = list(range(len(rtts)))
ax.scatter(times, rtts, s=2, color="#22d3ee", alpha=0.5)
ax.axhline(p50, color="#facc15", linestyle="--", linewidth=1, alpha=0.7)
ax.set_title("RTT Over Time (sequential toggles)")
ax.set_xlabel("Toggle #")
ax.set_ylabel("RTT (ms)")
ax.set_facecolor("#1e293b")
ax.tick_params(colors="#94a3b8")

# ── 3. Duration histogram ───────────────────────
ax = axes[1, 0]
if durations:
    # Log-scale bins for durations spanning seconds to hours
    bins = np.logspace(np.log10(0.1), np.log10(max(durations) + 1), 30)
    ax.hist(durations, bins=bins, color="#a78bfa", edgecolor="#0f172a", alpha=0.9)
    ax.set_xscale("log")
    ax.set_title(f"LED State Duration (changes: {len(durations)})")
    ax.set_xlabel("Duration (seconds, log scale)")
    ax.set_ylabel("Count")
else:
    ax.text(0.5, 0.5, "No duration data", ha="center", va="center")
ax.set_facecolor("#1e293b")
ax.tick_params(colors="#94a3b8")

# ── 4. Duration buckets (pie-style bar) ─────────
ax = axes[1, 1]
buckets = {"<10s": 0, "10s–1m": 0, "1–5m": 0, "5–30m": 0, "30m–1h": 0, ">1h": 0}
for d in durations:
    if d < 10:
        buckets["<10s"] += 1
    elif d < 60:
        buckets["10s–1m"] += 1
    elif d < 300:
        buckets["1–5m"] += 1
    elif d < 1800:
        buckets["5–30m"] += 1
    elif d < 3600:
        buckets["30m–1h"] += 1
    else:
        buckets[">1h"] += 1

labels = list(buckets.keys())
values = list(buckets.values())
colors = ["#22d3ee", "#a78bfa", "#34d399", "#facc15", "#f97316", "#ef4444"]
# Remove empty buckets
labels = [l for l, v in zip(labels, values) if v > 0]
colors = [c for c, v in zip(colors, values) if v > 0]
values = [v for v in values if v > 0]

bars = ax.bar(range(len(labels)), values, color=colors, edgecolor="#0f172a")
ax.set_xticks(range(len(labels)))
ax.set_xticklabels(labels, fontsize=9)
ax.set_title("State Duration Buckets")
ax.set_ylabel("Count")
for bar, val in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + max(values) * 0.02,
            str(val), ha="center", fontsize=9, color="#e2e8f0")
ax.set_facecolor("#1e293b")
ax.tick_params(colors="#94a3b8")

# ── Style & save ─────────────────────────────────
for ax in axes.flat:
    ax.set_facecolor("#1e293b")
    ax.tick_params(colors="#94a3b8")
    for spine in ax.spines.values():
        spine.set_color("#334155")

fig.patch.set_facecolor("#0f172a")
fig.tight_layout()
fig.savefig(str(DESKTOP), dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
print(f"Saved to {DESKTOP}")
