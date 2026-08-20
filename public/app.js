import { t, getLang, setLang, initI18n, applyStaticI18n } from "./i18n.js";

const $ = (id) => document.getElementById(id);

function number(value) {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
}

// Cache-rate percentage with one decimal place (99.3%). The value is a fraction
// 0..1 from the trace records; null/undefined renders as an em dash.
function percent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

// Per-call output-token throughput (tokens/sec) for the wave stats and hover
// tooltip; uses the same compact notation as number() with a tps suffix.
function tps(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "\u2014";
  return `${number(value)} tps`;
}

function rgba(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function bytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function duration(value) {
  if (!value) return "0 ms";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

function uptime(value) {
  const seconds = Math.floor((value || 0) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours
    ? `${hours}${t("unit.h")} ${minutes}${t("unit.m")}`
    : `${minutes}${t("unit.m")} ${seconds % 60}${t("unit.s")}`;
}

function set(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function showTrace(item) {
  const detail = $("trace-detail");
  detail.hidden = false;
  set("trace-detail-title", t("traceDetail.titleFormat", { kind: item.kind || "request", id: item.id || "unknown" }));
  $("trace-detail-json").textContent = JSON.stringify(item, null, 2);
  detail.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderRecent(items) {
  const body = $("recent-body");
  body.replaceChildren();
  if (!items.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty";
    cell.textContent = t("recent.empty");
    row.append(cell);
    body.append(row);
    return;
  }

  for (const item of items.slice(0, 10)) {
    const row = document.createElement("tr");
    row.className = "trace-row";
    row.tabIndex = 0;
    row.title = t("recent.openTitle");
    row.addEventListener("click", () => showTrace(item));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") showTrace(item);
    });
    const target = item.model || item.requestedModel || item.operation || "—";
    const detail =
      item.error ||
      item.query ||
      (item.compression
        ? t("detail.compressed", {
            pct: percent(item.compression.toChars / item.compression.fromChars),
            from: number(item.compression.fromChars),
            to: number(item.compression.toChars),
          })
        : item.harnessToolRounds
          ? t("detail.toolRound", { n: item.harnessToolRounds })
          : item.filteredTools
            ? t("detail.filteredTools", { n: item.filteredTools })
            : item.imageRefs?.length
              ? t("detail.imageRef", { n: item.imageRefs.length })
              : "—");
    // Context size per request: the input tokens actually sent upstream. The
    // upstream only reports usage when the request completes, so an in-flight
    // row shows a pending ellipsis and non-token kinds render an em dash. A CPU
    // compact event bills no upstream tokens, so its context cell shows the
    // compacted history as a token range (chars / 3, the same estimate as the
    // trace detail) - from -> to - making the compression visible at a glance.
    const contextTokens = item.compression
      ? `${number(Math.round(item.compression.fromChars / 3))} \u2192 ${number(Math.round(item.compression.toChars / 3))}`
      : item.status === "active"
        ? "…"
        : Number.isFinite(Number(item.inputTokens)) && Number(item.inputTokens) > 0
          ? number(item.inputTokens)
          : "—";
    const values = [item.kind, target, item.status, duration(item.latencyMs), contextTokens, detail];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 2) {
        const status = document.createElement("span");
        status.className = `trace-status ${item.status}`;
        status.append(document.createElement("i"), document.createTextNode(item.status));
        cell.append(status);
      } else {
        cell.textContent = String(value ?? "—");
        cell.title = cell.textContent;
      }
      row.append(cell);
    });
    body.append(row);
  }
}

// Context-token waveform: plots per-call input tokens from the responses metric
// records (chronological, sessions interleaved) onto a small canvas. The history
// buffer lives in the browser so the wave persists and grows across SSE updates.
// The context, cache, and transfer cards share one renderer (drawWave) and one
// hover handler (attachAreaWaveHover), each with the card's own accent color.
const WAVE_MAX_POINTS = 180;
const WAVE_AMBER = "#f7b955";
const WAVE_BLUE = "#50b7ff";
const WAVE_GREEN = "#48d6a0";
const WAVE_VIOLET = "#a78bfa";
const waveHistory = [];
const wavePeakState = { peak: 0 };
const waveHoverState = { hover: -1 };
let wavePoints = [];
// The filtered slices actually on screen. Hover redraws must use them too, or
// a session-filtered wave flashes back to the all-sessions plot on hover.
let visibleContextHistory = [];
let visibleCacheHistory = [];
let visibleDataHistory = [];
let visibleTpsHistory = [];

// Per-session view: one dropdown above the cards. Picking a session filters
// every card's wave (and the trace table) without touching the gateway-wide
// totals in the card headers. Session keys come from the trace records, which
// carry the Codex conversation id (sessionId, threadId fallback).
let sessionFilter = "";
let lastSessionSignature = "";

function sessionKeyOf(item) {
  return String(item.sessionId || item.threadId || "").trim();
}

function visiblePoints(history) {
  return sessionFilter ? history.filter((point) => point.session === sessionFilter) : history;
}

function shortModel(model) {
  return String(model || "—").split("@")[0];
}

function renderContextWave(recent) {
  const canvas = $("context-wave");
  if (!canvas) return;
  const responseLatencies = recent
    .filter(
      (item) =>
        item.kind === "responses" &&
        Number.isFinite(Number(item.firstResponseLatencyMs)) &&
        (!sessionFilter || sessionKeyOf(item) === sessionFilter),
    )
    .sort((a, b) => (a.finishedAt || a.startedAt || 0) - (b.finishedAt || b.startedAt || 0));
  const seen = new Set(waveHistory.map((point) => point.id));
  for (const item of recent) {
    // Only sample completed responses. In-flight (active) records carry no usage
    // yet and would otherwise pin the newest sample at 0; skipping them here means
    // a record is first added when it finishes with a real input-token count.
    if (item.kind !== "responses" || item.status !== "ok" || seen.has(item.id)) continue;
    waveHistory.push({
      id: item.id,
      t: item.startedAt || 0,
      v: Number(item.inputTokens) || 0,
      firstResponseLatencyMs: Number(item.firstResponseLatencyMs) || 0,
      session: sessionKeyOf(item),
    });
  }
  waveHistory.sort((a, b) => a.t - b.t);
  if (waveHistory.length > WAVE_MAX_POINTS) waveHistory.splice(0, waveHistory.length - WAVE_MAX_POINTS);
  const visible = visiblePoints(waveHistory);
  visibleContextHistory = visible;
  const last = visible.length ? visible[visible.length - 1].v : 0;
  const lastLatency = responseLatencies.length
    ? Number(responseLatencies[responseLatencies.length - 1].firstResponseLatencyMs)
    : visible.length
      ? visible[visible.length - 1].firstResponseLatencyMs
      : 0;
  wavePeakState.peak = visible.reduce((max, point) => Math.max(max, point.v), 0);
  set("wave-last", number(last));
  set("wave-peak", number(wavePeakState.peak));
  set("context-latency", duration(lastLatency));
  set("wave-count", number(visible.length));
  drawWave(canvas, visible, wavePeakState.peak, waveHoverState.hover, WAVE_AMBER, wavePoints);
}

// Shared area-wave renderer used by the context, cache, and transfer cards. The
// card accent color and the per-wave points array (for hover hit-testing) are
// parameters; everything else - gridlines, area fill, glow line, hover guide,
// peak marker - is one implementation.
function drawWave(canvas, history, peak, hoverIndex = -1, color = WAVE_AMBER, pointsRef = wavePoints) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = 4;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const max = peak || 1;
  const n = history.length;
  pointsRef.length = 0;

  // Gridlines (3 horizontal ticks).
  ctx.strokeStyle = rgba(color, 0.08);
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = pad + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  if (n === 0) return;

  // Area fill under the curve.
  const gradient = ctx.createLinearGradient(0, pad, 0, pad + plotH);
  gradient.addColorStop(0, rgba(color, 0.35));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.beginPath();
  ctx.moveTo(pad, pad + plotH);
  history.forEach((point, index) => {
    const x = pad + (n === 1 ? plotW / 2 : (plotW * index) / (n - 1));
    const y = pad + plotH - Math.min(1, point.v / max) * plotH;
    pointsRef.push({ x, y, v: point.v, t: point.t });
    ctx.lineTo(x, y);
  });
  ctx.lineTo(width - pad, pad + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line with a soft glow.
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = pad + (n === 1 ? plotW / 2 : (plotW * index) / (n - 1));
    const y = pad + plotH - Math.min(1, point.v / max) * plotH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 2;
  ctx.shadowColor = rgba(color, 0.5);
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Hover guide: vertical rule + highlighted sample.
  if (hoverIndex >= 0 && pointsRef[hoverIndex]) {
    const p = pointsRef[hoverIndex];
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p.x, pad);
    ctx.lineTo(p.x, pad + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(8,16,24,.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Peak marker dot.
  if (n > 0 && peak > 0) {
    let peakIndex = 0;
    history.forEach((point, index) => { if (point.v >= history[peakIndex].v) peakIndex = index; });
    const px = pad + (n === 1 ? plotW / 2 : (plotW * peakIndex) / (n - 1));
    const py = pad + plotH - (history[peakIndex].v / max) * plotH;
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

// Shared waveform hover: nearest-sample guide line, tooltip with the formatted
// value and wall-clock time, redraw on movement, reset on leave. One handler
// serves the context, cache, and transfer cards.
function attachAreaWaveHover({ canvasId, tooltipId, pointsRef, hoverState, draw, formatValue }) {
  const canvas = $(canvasId);
  const tooltip = $(tooltipId);
  if (!canvas || !tooltip) return;

  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let nearest = -1;
    let best = Infinity;
    pointsRef.forEach((point, index) => {
      const distance = Math.abs(point.x - x);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    if (nearest !== hoverState.hover) {
      hoverState.hover = nearest;
      draw(canvas, nearest);
    }
    if (nearest >= 0) {
      const point = pointsRef[nearest];
      const percentX = Math.max(0, Math.min(rect.width, point.x)) / rect.width;
      tooltip.style.left = `${(point.x / rect.width) * 100}%`;
      tooltip.style.transform = `translateX(${percentX < 0.08 ? "0%" : percentX > 0.92 ? "-100%" : "-50%"})`;
      tooltip.innerHTML = `<b>${formatValue(point.v)}</b><small>${formatWaveTime(point.t)}</small>`;
      tooltip.hidden = false;
    } else {
      tooltip.hidden = true;
    }
  });

  canvas.addEventListener("mouseleave", () => {
    hoverState.hover = -1;
    tooltip.hidden = true;
    draw(canvas, -1);
  });
}

function formatWaveTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Cache-rate waveform on the Requests card: per-call prompt-cache hit rate
// (cachedTokens / inputTokens) from the same trace records as the context wave,
// plotted on a fixed 0..100% scale. The drawing code mirrors the context wave
// (area fill, glow line, hover guide, tooltip, peak marker) with the card's own
// accent color (--blue). Beyond cost visibility this is a passthrough canary:
// prefix-cache collapse means something started rewriting conversation history.
const cacheHistory = [];
const cacheHoverState = { hover: -1 };
let cacheWavePoints = [];

function renderCacheWave(recent) {
  const canvas = $("cache-wave");
  if (!canvas) return;
  const seen = new Set(cacheHistory.map((point) => point.id));
  for (const item of recent) {
    // Only sample completed responses that carry input-token usage; in-flight
    // records have none yet and would pin the newest sample at 0.
    if (item.kind !== "responses" || item.status !== "ok" || seen.has(item.id)) continue;
    const input = Number(item.inputTokens) || 0;
    if (input <= 0) continue;
    cacheHistory.push({
      id: item.id,
      t: item.startedAt || 0,
      v: Math.min(1, Math.max(0, (Number(item.cachedTokens) || 0) / input)),
      session: sessionKeyOf(item),
    });
  }
  cacheHistory.sort((a, b) => a.t - b.t);
  if (cacheHistory.length > WAVE_MAX_POINTS) cacheHistory.splice(0, cacheHistory.length - WAVE_MAX_POINTS);
  const visible = visiblePoints(cacheHistory);
  visibleCacheHistory = visible;
  const last = visible.length ? visible[visible.length - 1].v : null;
  const avg = visible.length ? visible.reduce((sum, point) => sum + point.v, 0) / visible.length : null;
  set("cache-last", percent(last));
  set("cache-avg", percent(avg));
  set("cache-count", number(visible.length));
  drawCacheWave(canvas, visible, cacheHoverState.hover);
}

function drawCacheWave(canvas, history, hoverIndex = -1) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = 4;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const n = history.length;
  // Clear in place, never reassign: attachAreaWaveHover holds this array by
  // reference for its hit-test, and a reassignment would strand it on the old
  // empty array - the cache wave's hover silently never fires.
  cacheWavePoints.length = 0;
  const xFor = (index) => pad + (n === 1 ? plotW / 2 : (plotW * index) / (n - 1));
  const yFor = (value) => pad + plotH - Math.min(1, Math.max(0, value)) * plotH;

  // Gridlines (3 horizontal ticks on the fixed 0-100% scale).
  ctx.strokeStyle = rgba(WAVE_BLUE, 0.08);
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = pad + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  if (n === 0) return;

  // Area fill under the curve.
  const gradient = ctx.createLinearGradient(0, pad, 0, pad + plotH);
  gradient.addColorStop(0, rgba(WAVE_BLUE, 0.35));
  gradient.addColorStop(1, rgba(WAVE_BLUE, 0));
  ctx.beginPath();
  ctx.moveTo(pad, pad + plotH);
  history.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.v);
    cacheWavePoints.push({ x, y, v: point.v, t: point.t });
    ctx.lineTo(x, y);
  });
  ctx.lineTo(xFor(n - 1), pad + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line with a soft glow.
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.v);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = rgba(WAVE_BLUE, 0.9);
  ctx.lineWidth = 2;
  ctx.shadowColor = rgba(WAVE_BLUE, 0.5);
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Hover guide: vertical rule + highlighted sample.
  if (hoverIndex >= 0 && cacheWavePoints[hoverIndex]) {
    const p = cacheWavePoints[hoverIndex];
    ctx.strokeStyle = rgba(WAVE_BLUE, 0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(p.x, pad);
    ctx.lineTo(p.x, pad + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = WAVE_BLUE;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(8,16,24,.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Peak marker dot (highest hit rate).
  if (n > 0) {
    let peakIndex = 0;
    history.forEach((point, index) => { if (point.v >= history[peakIndex].v) peakIndex = index; });
    const px = xFor(peakIndex);
    const py = yFor(history[peakIndex].v);
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = WAVE_BLUE;
    ctx.fill();
  }
}

// Transfer waveform on the green card: per-call response bytes (bytesOut) over
// time from the same trace records as the token waves. The grand total rides in
// the card header (top-right); the wave shows how the bytes were spread across
// calls. History lives in the browser so the plot persists across SSE updates.
const dataHistory = [];
const dataPeakState = { peak: 0 };
const dataHoverState = { hover: -1 };
const dataWavePoints = [];

function renderDataWave(recent) {
  const canvas = $("data-wave");
  if (!canvas) return;
  const seen = new Set(dataHistory.map((point) => point.id));
  for (const item of recent) {
    // Sample completed responses that actually streamed bytes; failed relays
    // and in-flight records carry no bytesOut and would pin a flat zero.
    if (item.kind !== "responses" || item.status !== "ok" || seen.has(item.id)) continue;
    const value = Number(item.bytesOut) || 0;
    if (value <= 0) continue;
    dataHistory.push({ id: item.id, t: item.startedAt || 0, v: value, session: sessionKeyOf(item) });
  }
  dataHistory.sort((a, b) => a.t - b.t);
  if (dataHistory.length > WAVE_MAX_POINTS) dataHistory.splice(0, dataHistory.length - WAVE_MAX_POINTS);
  const visible = visiblePoints(dataHistory);
  visibleDataHistory = visible;
  dataPeakState.peak = visible.reduce((max, point) => Math.max(max, point.v), 0);
  drawWave(canvas, visible, dataPeakState.peak, dataHoverState.hover, WAVE_GREEN, dataWavePoints);
}

let lastData = null;

// Output-token throughput waveform on the Tokens card: per-call tokens per
// second (outputTokens / wall-clock seconds) from the same trace records as the
// token waves, plotted with a dynamic peak. History lives in the browser so the
// plot persists across SSE updates.
const tpsHistory = [];
const tpsPeakState = { peak: 0 };
const tpsHoverState = { hover: -1 };
const tpsWavePoints = [];

function renderTpsWave(recent) {
  const canvas = $("tps-wave");
  if (!canvas) return;
  const seen = new Set(tpsHistory.map((point) => point.id));
  for (const item of recent) {
    // Only completed responses with real output tokens and a wall-clock
    // duration carry a usable rate; in-flight and failed records have neither.
    if (item.kind !== "responses" || item.status !== "ok" || seen.has(item.id)) continue;
    const output = Number(item.outputTokens) || 0;
    const latencyMs = Number(item.latencyMs) || 0;
    if (output <= 0 || latencyMs <= 0) continue;
    tpsHistory.push({
      id: item.id,
      t: item.startedAt || 0,
      v: output / (latencyMs / 1000),
      session: sessionKeyOf(item),
    });
  }
  tpsHistory.sort((a, b) => a.t - b.t);
  if (tpsHistory.length > WAVE_MAX_POINTS) tpsHistory.splice(0, tpsHistory.length - WAVE_MAX_POINTS);
  const visible = visiblePoints(tpsHistory);
  visibleTpsHistory = visible;
  const last = visible.length ? visible[visible.length - 1].v : null;
  const avg = visible.length ? visible.reduce((sum, point) => sum + point.v, 0) / visible.length : null;
  set("tps-last", tps(last));
  set("tps-avg", tps(avg));

  // Dynamic peak keeps the whole curve visible as the rate varies; the violet
  // reuses the Tokens card accent so no new color is introduced.
  tpsPeakState.peak = visible.reduce((max, point) => Math.max(max, point.v), 0);
  drawWave(canvas, visible, tpsPeakState.peak, tpsHoverState.hover, WAVE_VIOLET, tpsWavePoints);
}

// Session overview bar: one chip per session, each with a mini context
// sparkline and the session's last context size. The dropdown above the chips
// and the chips themselves both set the same filter; the chip DOM rebuilds
// only when the session set changes, and the sparklines refresh on every push.
function buildSessionList(recent) {
  const map = new Map();
  for (const item of recent) {
    if (item.kind !== "responses") continue;
    const key = sessionKeyOf(item);
    if (!key) continue;
    const entry = map.get(key) || { id: key, model: "", lastAt: 0 };
    if (item.model) entry.model = item.model;
    entry.lastAt = Math.max(entry.lastAt, Number(item.finishedAt || item.startedAt || 0));
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.lastAt - a.lastAt);
}

function renderSessions(recent, names = {}) {
  const filter = $("session-filter");
  if (!filter) return;
  const sessions = buildSessionList(recent);
  // Real conversations carry a readable name from their Codex rollout file;
  // one-shot background sessions (native luna probes) do not. Only named
  // sessions enter the dropdown; if the server supplied no names at all
  // (older build), fall back to showing everything.
  const useNames = Object.keys(names).length > 0;
  const visible = useNames ? sessions.filter((session) => names[session.id]) : sessions;
  const select = $("session-select");
  if (!visible.length) {
    filter.hidden = true;
    return;
  }
  filter.hidden = false;
  const signature = visible.map((session) => `${session.id}|${names[session.id] || ""}|${session.model}`).join("\u0001");
  if (signature !== lastSessionSignature) {
    lastSessionSignature = signature;
    if (!visible.some((session) => session.id === sessionFilter)) sessionFilter = "";
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = t("session.all");
    select.append(all);
    visible.forEach((session) => {
      const option = document.createElement("option");
      option.value = session.id;
      // "project - model@provider": the project comes from the Codex rollout
      // file, the model is the trace record's own qualified id.
      option.textContent = names[session.id]
        ? `${names[session.id]} - ${session.model}`
        : `${shortModel(session.model)} · ${session.id.slice(0, 8)}`;
      select.append(option);
    });
  }
  select.value = sessionFilter;
}

function render(data) {
  lastData = data;
  const ready = data.ready;
  const status = $("live-status");
  status.className = `status-pill ${ready ? "ready" : "error"}`;
  status.querySelector("strong").textContent = ready ? t("status.ready") : t("status.tokenMissing");
  renderModelOptions(data);
  renderSubagent(data.subagent);
  set("uptime", "v" + (data.update?.currentVersion || "") + " " + t("status.uptime") + " " + uptime(data.uptimeMs));
  set("main-model", data.config.routeModel || data.config.mainModel);
  if (data.config.routeProviderLabel || data.config.mainProviderLabel) set("route-provider", data.config.routeProviderLabel || data.config.mainProviderLabel);
  if (data.config.mainWire) set("route-wire", data.config.mainWire === "chat" ? "chat/completions" : "responses");

  const responses = data.responses;
  set("requests-active", number(responses.active));
  set("requests-total", number(responses.total));

  const inputTokens = responses.inputTokens || 0;
  const outputTokens = responses.outputTokens || 0;


  set("tokens-input", number(inputTokens));
  set("tokens-output", number(outputTokens));
  // token meter removed: In/Out now live in the card header.

  renderContextWave(data.recent || []);
  renderCacheWave(data.recent || []);
  renderDataWave(data.recent || []);
  renderTpsWave(data.recent || []);
  renderSessions(data.recent || [], data.sessionNames || {});
  set("bytes-total", bytes(responses.bytesIn + responses.bytesOut));
  set("bytes-in", bytes(responses.bytesIn));
  set("bytes-out", bytes(responses.bytesOut));
  set("stream-count", number(responses.streaming));

  set("cfg-bind", data.config.bind);
  const mainUpstream = data.config.mainUpstreamUrl || data.config.goBaseUrl;
  set("cfg-go", mainUpstream);
  const upstreamDd = $("cfg-go");
  if (upstreamDd) upstreamDd.title = mainUpstream;
  set("cfg-main", data.config.mainModel);
  set("cfg-vision", data.config.visionModel || t("models.none"));
  const visionDd = $("cfg-vision");
  if (visionDd) visionDd.title = data.config.visionUpstreamUrl ? t("runtime.via", { url: data.config.visionUpstreamUrl }) : "";
  set("cfg-exa", data.config.exaMcpUrl);
  const runtime = data.runtime || {};
  set("cfg-node", runtime.nodeVersion || "n/a");
  const nodeDd = $("cfg-node");
  if (nodeDd) nodeDd.title = `zstd: ${runtime.zstdBackend || "unknown"}`;
  const migration = $("runtime-migration");
  if (migration) migration.hidden = !runtime.migrationRequired;
  renderAutostart(data);
  renderSpeech(data);
  renderUpdate(data);
  maybePromptSettings(data.config);
  const sessionItems = sessionFilter
    ? (data.recent || []).filter((item) => sessionKeyOf(item) === sessionFilter)
    : (data.recent || []);
  renderRecent(sessionItems);
}

let lastSpeechCheckAt = 0;
const SPEECH_CHECK_TTL_MS = 5_000;

async function renderSpeech(data) {
  const now = Date.now();
  if (now - lastSpeechCheckAt < SPEECH_CHECK_TTL_MS) return;
  lastSpeechCheckAt = now;
  const ttsStatus = $("speech-tts-status");
  const sttStatus = $("speech-stt-status");
  const installBtn = $("speech-tts-install");
  if (!ttsStatus || !sttStatus) return;
  const green = "var(--green)";
  const red = "#ff7b7b";
  try {
    const res = await fetch("/api/speech", { headers: { accept: "application/json" } });
    const body = await res.json();
    const tts = body.tts || {};
    const stt = body.stt || {};
    ttsStatus.textContent = tts.installed ? t("speech.ttsOn") : t("speech.ttsOff");
    ttsStatus.style.color = tts.installed ? green : red;
    sttStatus.textContent = stt.available
      ? `${t("speech.sttOn")} · ${stt.cultures.join(" / ")}`
      : t("speech.sttOff");
    sttStatus.style.color = stt.available ? green : red;
    installBtn.hidden = tts.installed;
    installBtn.disabled = false;
  } catch {
    ttsStatus.textContent = t("speech.ttsOff");
    ttsStatus.style.color = red;
    sttStatus.textContent = t("speech.sttOff");
    sttStatus.style.color = red;
  }
}

// Every picker on this page follows the same contract: rebuild the options from
// the data, show a placeholder when there is nothing to offer, and fall back to
// the first entry when the requested value is no longer in the list. Writing it
// out per picker is how the vision list ended up filtering the stale DOM instead
// of re-rendering, so it silently kept the previous provider's model. Returns the
// value the select ended up on.
function fillSelect(select, items, { value = "", label, data, placeholder = true, disabled = false } = {}) {
  if (!select) return "";
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = label ? label(item) : (item.label || item.id);
    if (data) {
      for (const [key, entry] of Object.entries(data(item))) option.dataset[key] = entry || "";
    }
    select.append(option);
  }
  if (!items.length && placeholder) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("models.none");
    select.append(option);
  }
  select.value = items.some((item) => item.id === value) ? value : (items[0]?.id || "");
  select.disabled = disabled;
  return select.value;
}

let lastModelSignature = "";

function modelSignature(models) {
  const selected = models?.selected || {};
  const options = models?.options || [];
  const key = (model) => `${model.id}|${model.provider}|${model.tierLabel || ""}|${model.visionTier || ""}`;
  return [
    selected.mainModel,
    selected.visionModel,
    models?.selectedProvider,
    models?.selectedVisionProvider,
    options.map(key).join("|"),
  ].join("\u0001");
}

let lastModelData = null;
// The vision provider the user picked in the dropdown, when it differs from the
// one the server reports. Cleared once the saved selection catches up.
let visionProviderOverride = "";

function renderModelOptions(data) {
  const models = data.models;
  if (!models?.options) return;
  lastModelData = data;
  const signature = modelSignature(models);
  if (signature === lastModelSignature) {
    // Models did not change since the last SSE event; keep the current DOM.
    // The waveform and token cards still update from their own renderers.
    return;
  }
  lastModelSignature = signature;
  const selected = models.selected || {};
  const providers = models.providers || [];
  const selectedProvider = models.selectedProvider || "other";
  const visionProviders = models.visionProviders || providers;
  const selectedVisionProvider = models.selectedVisionProvider || "";
  // The main model is a display, not a picker: it follows what Codex is
  // actually using (the GUI selection is echoed back through client_selected),
  // so the dashboard never writes it. Only the vision and subagent rows are
  // editable, and both read the same published options set below.
  const providerLabel = providers.find((provider) => provider.id === selectedProvider)?.label || selectedProvider;
  const mainModelLabel = models.options.find((model) => model.id === selected.mainModel)?.label || selected.mainModel;
  const providerDisplay = $("main-provider-display");
  const modelDisplay = $("main-model-display-name");
  if (providerDisplay) providerDisplay.textContent = providerLabel;
  if (modelDisplay) modelDisplay.textContent = mainModelLabel;
  const mainModelStatic = document.querySelector(".model-static");
  if (mainModelStatic) mainModelStatic.classList.toggle("busy", modelBusy);
  if (modelDisplay) modelDisplay.classList.toggle("busy", modelBusy);
  if (providerDisplay) providerDisplay.classList.toggle("busy", modelBusy);
  const visionProviderSelect = $("vision-provider-select");
  if (visionProviderSelect) {
    // Honour a provider the user just picked (visionProviderOverride) over the
    // one the payload reports, so re-rendering after a change does not snap the
    // dropdown back to the previously selected provider.
    const wanted = visionProviderOverride && visionProviders.some((provider) => provider.id === visionProviderOverride)
      ? visionProviderOverride
      : selectedVisionProvider;
    fillSelect(visionProviderSelect, visionProviders, {
      value: wanted,
      disabled: !visionProviders.length || modelBusy,
    });
  }
  const visionFilter = (model) => model.supportsVision && model.provider === (visionProviderSelect?.value || selectedVisionProvider);
  const visionModels = models.options
    .filter(visionFilter)
    .sort((a, b) => (b.balanceScore ?? -1) - (a.balanceScore ?? -1) || a.id.localeCompare(b.id));
  fillSelect($("vision-model-select"), visionModels, {
    value: selected.visionModel,
    label: (model) => (model.tierLabel ? `${model.label} (${model.tierLabel})` : model.label),
    data: (model) => ({ provider: model.provider, tier: model.visionTier }),
    disabled: !visionModels.length || modelBusy,
  });
}

// Sub Agent mirrors the vision provider/model pair but with no capability
// filter: every enabled routed provider plus the native ChatGPT provider is
// open, and the choice persists to the ModelDock-managed agent file.
let lastSubagentPayload = null;

function renderSubagent(payload, options = {}) {
  if (!payload) return;
  lastSubagentPayload = payload;
  const providerSelect = $("subagent-provider-select");
  const modelSelect = $("subagent-model-select");
  if (!providerSelect || !modelSelect) return;
  const providers = payload.providers || [];
  const entries = payload.options || [];
  const disabled = !entries.length || modelBusy;
  const provider = fillSelect(providerSelect, providers, {
    value: payload.selectedProvider || providers[0]?.id || "",
    placeholder: false,
    disabled,
  });
  renderSubagentModels(payload, provider, disabled);
}

// Provider and model selects stay bound: switching the provider re-renders the
// model list from the full payload instead of filtering the stale option set.
function renderSubagentModels(payload, provider, disabled) {
  const modelSelect = $("subagent-model-select");
  if (!modelSelect) return;
  const filtered = (payload.options || []).filter((model) => model.provider === provider);
  fillSelect(modelSelect, filtered, {
    value: payload.selected || "",
    data: (model) => ({ provider: model.provider }),
    disabled,
  });
}

let autostartBusy = false;
let modelBusy = false;
let autostartEnabled = false;

async function setModels() {
  modelBusy = true;
  $("vision-model-select").disabled = true;
  $("vision-provider-select").disabled = true;
  try {
    const response = await fetch("/api/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visionModel: $("vision-model-select").value }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Model update ${response.status}`);
    // The saved selection now carries the provider; stop overriding the dropdown.
    visionProviderOverride = "";
  } catch (error) {
    window.alert(error.message);
  } finally {
    modelBusy = false;
    poll().catch(() => {});
  }
}

async function saveSubagent() {
  modelBusy = true;
  $("subagent-model-select").disabled = true;
  $("subagent-provider-select").disabled = true;
  try {
    const response = await fetch("/api/subagent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: $("subagent-model-select").value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Subagent update ${response.status}`);
    renderSubagent(body);
    pollConfig().catch(() => {});
  } catch (error) {
    window.alert(error.message);
  } finally {
    modelBusy = false;
    poll().catch(() => {});
  }
}

function renderAutostart(data) {
  autostartEnabled = Boolean(data.autostart?.enabled);
  const supported = Boolean(data.autostart?.supported);
  const toggle = $("settings-autostart-toggle");
  if (!toggle) return;
  toggle.checked = autostartEnabled;
  toggle.disabled = autostartBusy || !supported;
  $("settings-autostart-off-label").classList.toggle("active", !autostartEnabled);
  $("settings-autostart-on-label").classList.toggle("active", autostartEnabled);
  toggle.title = supported
    ? (autostartEnabled ? t("autostart.titleOn") : t("autostart.titleOff"))
    : t("autostart.unsupported");
}

async function setAutostartEnabled(enabled) {
  autostartBusy = true;
  $("settings-autostart-toggle").disabled = true;
  try {
    const response = await fetch("/api/autostart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Autostart update ${response.status}`);
    renderAutostart({ autostart: { supported: true, enabled: body.enabled } });
  } catch (error) {
    renderAutostart({ autostart: { supported: true, enabled: autostartEnabled } });
    window.alert(error.message);
  } finally {
    autostartBusy = false;
    $("settings-autostart-toggle").disabled = false;
  }
}

let updateBusy = false;

function renderUpdate(data) {
  const button = $("update-button");
  if (!button || updateBusy) return;
  const update = data.update;
  if (update?.available) {
    button.hidden = false;
    button.textContent = t("update.available", { n: update.latestVersion });
    button.title = t("update.title", { current: update.currentVersion });
  } else {
    button.hidden = true;
  }
}

async function applyUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  const button = $("update-button");
  button.disabled = true;
  button.textContent = t("update.updating");
  try {
    const response = await fetch("/api/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Update ${response.status}`);
    button.textContent = t("update.restarting");
    if (body.mode === "installer") awaitRuntimeMigrationThenUpdate(body.latestVersion);
    else awaitRestartThenReload(body.latestVersion);
  } catch (error) {
    updateBusy = false;
    button.disabled = false;
    button.textContent = t("button.update");
    window.alert(error.message);
  }
}

// The old process exits ~1s after responding and the relauncher waits 2s before
// starting the new one, so begin probing after 4s and reload on the first answer.
function awaitRestartThenReload(expectedVersion = "") {
  const started = Date.now();
  setTimeout(function probe() {
    fetch("/api/status", { cache: "no-store" })
      .then(async (response) => {
        const status = response.ok ? await response.json() : null;
        if (response.ok && (!expectedVersion || status?.update?.currentVersion === expectedVersion)) window.location.reload();
        else throw new Error("not ready");
      })
      .catch(() => {
        if (Date.now() - started > 120_000) window.location.reload();
        else setTimeout(probe, 2_000);
      });
  }, 4_000);
}

let switchBusy = false;
let switchState = null;
let currentMode = "off";

function renderModeSegments(mode) {
  currentMode = mode;
  document.querySelectorAll(".mode-segment").forEach((segment) => {
    segment.disabled = switchBusy;
    segment.classList.toggle("active", segment.dataset.mode === mode);
  });
}

function renderConfigSwitch(data) {
  switchState = data;
  const mode = data.enabled ? "on" : "off";
  renderModeSegments(mode);
  set("switch-description", data.enabled ? t("switch.descEnabled") : t("switch.descDisabled"));
  set("switch-default", `${t("switch.mode")} - ${t("switch." + mode)}`);
  const message = $("switch-message");
  message.className = "";
  if (data.stateError) {
    message.textContent = t("switch.stateError", { msg: data.stateError });
    message.className = "error";
  } else if (data.externallyRestored) {
    message.textContent = t("switch.restored");
  } else {
    message.textContent = data.enabled ? t("switch.backupReady") : t("switch.defaultOff");
  }
  $("restart-banner").hidden = !data.restartRequired;
}

async function pollConfig() {
  const response = await fetch("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error(`Config status ${response.status}`);
  renderConfigSwitch(await response.json());
}

async function setMode(mode) {
  switchBusy = true;
  renderModeSegments(currentMode);
  set("switch-message", t("switch.updating"));
  try {
    const response = await fetch("/api/config/mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Mode update ${response.status}`);
    renderConfigSwitch(body);
  } catch (error) {
    const message = $("switch-message");
    message.textContent = error.message;
    message.className = "error";
    renderModeSegments(switchState ? (switchState.enabled ? "on" : "off") : "off");
  } finally {
    switchBusy = false;
    renderModeSegments(currentMode);
  }
}

async function poll() {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error(`Status ${response.status}`);
  render(await response.json());
}

const events = new EventSource("/api/events");
events.onopen = () => set("event-connection", t("event.connected"));
let pendingSseData = null;
let pendingSseTimer = null;
events.onmessage = (event) => {
  pendingSseData = JSON.parse(event.data);
  if (pendingSseTimer) return;
  pendingSseTimer = setTimeout(() => {
    pendingSseTimer = null;
    if (pendingSseData) render(pendingSseData);
    pendingSseData = null;
  }, 150);
};
events.onerror = () => {
  set("event-connection", t("event.reconnecting"));
  poll().catch(() => {});
  };

  attachAreaWaveHover({ canvasId: "context-wave", tooltipId: "wave-tooltip", pointsRef: wavePoints, hoverState: waveHoverState, draw: (canvas, hover) => drawWave(canvas, visibleContextHistory, wavePeakState.peak, hover, WAVE_AMBER, wavePoints), formatValue: number });
  attachAreaWaveHover({ canvasId: "cache-wave", tooltipId: "cache-wave-tooltip", pointsRef: cacheWavePoints, hoverState: cacheHoverState, draw: (canvas, hover) => drawCacheWave(canvas, visibleCacheHistory, hover), formatValue: percent });
  attachAreaWaveHover({ canvasId: "data-wave", tooltipId: "data-wave-tooltip", pointsRef: dataWavePoints, hoverState: dataHoverState, draw: (canvas, hover) => drawWave(canvas, visibleDataHistory, dataPeakState.peak, hover, WAVE_GREEN, dataWavePoints), formatValue: bytes });
  attachAreaWaveHover({ canvasId: "tps-wave", tooltipId: "tps-wave-tooltip", pointsRef: tpsWavePoints, hoverState: tpsHoverState, draw: (canvas, hover) => drawWave(canvas, visibleTpsHistory, tpsPeakState.peak, hover, WAVE_VIOLET, tpsWavePoints), formatValue: tps });

poll().catch(() => set("event-connection", t("event.unavailable")));
pollConfig().catch((error) => {
  const message = $("switch-message");
  message.textContent = error.message;
  message.className = "error";
});
setInterval(() => poll().catch(() => {}), 15_000);
setInterval(() => pollConfig().catch(() => {}), 15_000);

document.querySelectorAll(".mode-segment").forEach((segment) => {
  segment.addEventListener("click", async () => {
    if (switchBusy) return;
    const mode = segment.dataset.mode;
    if (mode === currentMode) return;
    const enabling = mode !== "off";
    if (enabling !== (currentMode !== "off")) {
      const prompt = enabling ? t("confirm.enable") : t("confirm.disable");
      if (!window.confirm(prompt)) return;
    }
    await setMode(mode);
  });
});

$("settings-autostart-toggle").addEventListener("change", (event) => {
  setAutostartEnabled(event.target.checked);
});

$("vision-model-select").addEventListener("change", setModels);
$("vision-provider-select").addEventListener("change", () => {
  // Re-render the whole vision list for the newly picked provider instead of
  // filtering the options already in the DOM: those were built for the previous
  // provider, so switching (e.g. custom -> opencode-go) found no match and left
  // the old provider's model selected. renderModelOptions reads the select's
  // current value in its filter, so a forced re-render lists the right models.
  if (!lastModelData) return;
  visionProviderOverride = $("vision-provider-select").value;
  lastModelSignature = "";
  renderModelOptions(lastModelData);
});

$("subagent-model-select").addEventListener("change", saveSubagent);
$("subagent-provider-select").addEventListener("change", () => {
  if (!lastSubagentPayload) return;
  renderSubagentModels(lastSubagentPayload, $("subagent-provider-select").value, $("subagent-model-select").disabled);
});

$("restart-ack").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/config/restart-ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Config update ${response.status}`);
    renderConfigSwitch(body);
  } catch (error) {
    window.alert(error.message);
  }
});
$("trace-detail-close").addEventListener("click", () => { $("trace-detail").hidden = true; });

const ttsInstallBtn = $("speech-tts-install");
if (ttsInstallBtn) {
  ttsInstallBtn.addEventListener("click", async () => {
    ttsInstallBtn.disabled = true;
    ttsInstallBtn.textContent = t("speech.installing");
    try {
      const res = await fetch("/api/speech/install", { method: "POST", headers: { accept: "application/json" } });
      const body = await res.json();
      if (res.ok && body.installed) {
        $("speech-tts-status").textContent = t("speech.ttsOn");
        $("speech-tts-status").style.color = "var(--green)";
        ttsInstallBtn.hidden = true;
      } else {
        $("speech-tts-status").textContent = `${t("speech.ttsOff")} (${body.error?.message || t("speech.ttsOff")})`;
      }
    } catch {
      $("speech-tts-status").textContent = t("speech.ttsOff");
    }
    ttsInstallBtn.textContent = t("speech.install");
    ttsInstallBtn.disabled = false;
  });
}

let settingsPrompted = false;

function maybePromptSettings(config) {
  if (settingsPrompted) return;
  settingsPrompted = true;
  // ?settings=1 is hardcoded into every installer already shipped, so it has
  // to keep landing where the token goes - which is the Subscriptions page
  // now, not the dialog.
  const openRequested = new URLSearchParams(location.search).get("settings") === "1";
  if (openRequested || (config && !config.tokenConfigured)) {
    location.hash = "#subscriptions";
  }
}

// Tokens, the custom endpoint, and the local engines live on their own pages
// now, so their fields have to be filled whether or not the settings dialog is
// ever opened. Autostart is the only part of it left.
let lastSettings = null;

async function loadSettings() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Settings ${response.status}`);
  const go = (data.providers || []).find((p) => p.id === "opencode-go");
  const ds = (data.providers || []).find((p) => p.id === "deepseek-official");
  const goInput = $("settings-go-token");
  const dsInput = $("settings-deepseek-token");
  if (goInput && dsInput) {
    // Never echo a stored token back into the field: the placeholder reports
    // whether one is set, and submitting an empty field leaves it alone.
    goInput.value = "";
    dsInput.value = "";
    goInput.placeholder = go?.tokenConfigured ? t("settings.configured") : (data.tokenConfigured ? t("settings.optional") : t("settings.required"));
    dsInput.placeholder = ds?.tokenConfigured ? t("settings.configured") : (data.tokenConfigured ? t("settings.optional") : t("settings.required"));
  }
  const status = $("settings-status");
  if (status) status.textContent = "";
  renderAutostart(data);
  renderCustomSection(data.custom);
  renderOllamaSection(data.ollama);
  for (const [engine, render] of Object.entries(renderLocalSections)) render(data.local?.[engine]);
  lastSettings = data;
  return data;
}

async function openSettings() {
  const dialog = $("settings-dialog");
  if (!dialog) return;
  try {
    await loadSettings();
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  } catch (error) {
    window.alert(error.message);
  }
}

// --- Model roster (Models page) ---
//
// One ranked list, not a table per provider: the first question is "what am I
// actually running", and grouping answers "what could I run from here"
// instead. Provider is a column because a model id is provider plus name and
// the same name serves from two of them.
// Thousands, rounded, so a column of windows reads at a glance: 272, 1000,
// 262. Exact thousands were worse than the six digits they replaced - 262144
// became 262.144 and 1048576 became 1048.576.
//
// Rounding a field that is also its own input would normally rewrite the
// number on the next save, so the Save button watches the text rather than
// the value: a row nobody typed in cannot save, whatever it displays. The
// exact window is in the cell's tooltip.
const contextToK = (value) => (value ? String(Math.round(value / 1000)) : "");
const contextFromK = (raw) => Math.round(Number(raw) * 1000);

const ROSTER_COLUMNS = ["model", "provider", "context", "vision", "requests", "tps", "cache"];

function rosterCell(text, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function rosterRow(entry, rank) {
  const row = document.createElement("tr");
  const name = document.createElement("td");
  const position = document.createElement("span");
  position.className = "roster-rank";
  position.textContent = rank;
  const label = document.createElement("strong");
  label.textContent = entry.label;
  name.append(position, label);
  if (entry.free) {
    const tag = document.createElement("span");
    tag.className = "roster-tag";
    tag.textContent = t("roster.free");
    name.append(" ", tag);
  }
  row.append(name);
  row.append(rosterCell(entry.providerLabel, "roster-provider"));
  // A published window is the model maker's claim about the base model, not a
  // measurement of what this endpoint serves. The two can differ, and whoever
  // hits the wall knows better than the table does - so the cell says where
  // its number came from and lets that number be corrected.
  //
  // Committing on blur was wrong twice over: nothing said the number was
  // editable until you clicked it, and once you had typed, looking away saved
  // it. A change now waits behind a Save button on its own row, and saving
  // says plainly that Codex has to restart before it means anything.
  const context = document.createElement("td");
  context.className = "roster-num roster-context-cell";
  const contextField = document.createElement("input");
  contextField.type = "text";
  contextField.className = "roster-context";
  contextField.inputMode = "numeric";
  contextField.value = contextToK(entry.contextWindow);
  const contextShown = contextField.value;
  contextField.setAttribute("aria-label", t("roster.contextWindow"));
  if (entry.contextSource) {
    contextField.title = `${number(entry.contextWindow)} - ${t(`roster.context.${entry.contextSource}`)}`;
    if (entry.contextSource !== "measured") contextField.classList.add("roster-claimed");
    if (entry.contextSource === "user") contextField.classList.add("roster-edited");
  }
  const save = document.createElement("button");
  save.type = "button";
  save.className = "roster-save";
  save.textContent = t("roster.save");
  save.hidden = true;
  const parse = () => {
    const raw = contextField.value.trim();
    // An emptied field means "forget my correction", not "set it to zero".
    if (raw === "") return null;
    const value = contextFromK(raw.replace(/[,_\s]/g, ""));
    return Number.isFinite(value) ? value : undefined;
  };
  const syncSave = () => {
    const next = parse();
    save.hidden = next === undefined || contextField.value.trim() === contextShown;
  };
  contextField.addEventListener("input", syncSave);
  save.addEventListener("click", async () => {
    const next = parse();
    if (next === undefined) return;
    save.disabled = true;
    contextField.disabled = true;
    try {
      const response = await fetch("/api/models/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, contextWindow: next }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || `Context ${response.status}`);
      // No dialog: the row re-renders as edited and the restart banner at the
      // top of the page is already driven by the same restartRequired flag this
      // route sets. A modal on top of a banner says the same thing twice, and
      // the modal is the one that interrupts.
      await renderModelRoster();
      pollConfig().catch(() => {});
    } catch (error) {
      window.alert(error.message);
      contextField.value = contextToK(entry.contextWindow);
      syncSave();
    } finally {
      save.disabled = false;
      contextField.disabled = false;
    }
  });
  contextField.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !save.hidden) save.click();
    if (event.key === "Escape") {
      contextField.value = contextToK(entry.contextWindow);
      syncSave();
      contextField.blur();
    }
  });
  context.append(contextField, save);
  row.append(context);
  // Yes or no, not a tier: the column answers whether images can be sent at
  // all, and a tier beside a request count reads as a quality score.
  row.append(rosterCell(t(entry.supportsVision ? "roster.yes" : "roster.no")));
  const usage = entry.usage;
  row.append(rosterCell(usage ? number(usage.requests) : "-", "roster-num"));
  row.append(rosterCell(usage && usage.tps ? usage.tps.toFixed(1) : "-", "roster-num"));
  row.append(rosterCell(usage && usage.in ? `${Math.round(usage.cacheRate * 100)}%` : "-", "roster-num"));
  if (!usage) row.classList.add("roster-unused");
  return row;
}

async function renderModelRoster() {
  const host = $("roster-groups");
  const note = $("roster-note");
  if (!host) return;
  try {
    const response = await fetch("/api/models/roster", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Roster ${response.status}`);
    const rows = [...(data.models || [])];
    // Requests first, then output tokens: two models called the same number of
    // times are not equally used if one of them wrote ten times as much.
    rows.sort((a, b) =>
      (b.usage?.requests || 0) - (a.usage?.requests || 0)
      || (b.usage?.out || 0) - (a.usage?.out || 0)
      || a.label.localeCompare(b.label));
    host.innerHTML = "";
    const table = document.createElement("table");
    table.className = "roster-table";
    const head = document.createElement("tr");
    for (const column of ROSTER_COLUMNS) {
      const cell = document.createElement("th");
      // The context column names its unit; every other column is its own label.
      cell.textContent = t(column === "context" ? "roster.contextWindow" : `roster.${column}`);
      // Numeric columns are right-aligned in the body, so their headers are
      // too. This was a nth-child rule counting the first four columns, which
      // put the Context heading on the left of a right-aligned column.
      if (["context", "requests", "tps", "cache"].includes(column)) cell.className = "roster-head-num";
      head.append(cell);
    }
    const body = document.createElement("tbody");
    body.append(head);
    let used = 0;
    rows.forEach((entry, index) => {
      if (entry.usage) used += 1;
      body.append(rosterRow(entry, String(index + 1)));
    });
    table.append(body);
    host.append(table);
    if (note) {
      note.textContent = rows.length
        ? `${t("roster.summary", { used, total: rows.length })} ${t("roster.contextHint")}`
        : t("roster.empty");
    }
  } catch (error) {
    if (note) note.textContent = error.message;
  }
}
// --- Local engine discovery (Local Hosts) ---
//
// Read-only: it reports what is already listening so the user does not have to
// know a port number. Connecting still goes through the flow that owns the
// engine, which is why nothing here writes.
// 81920 reads as 80K to anyone who set it; the exact figure is noise here.
function formatContextSize(tokens) {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

async function renderLocalEngines() {
  const list = $("local-engine-list");
  const note = $("local-discovery-note");
  if (!list) return;
  list.innerHTML = "";
  if (note) note.textContent = t("local.scanning");
  try {
    const response = await fetch("/api/local/discover", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Discover ${response.status}`);
    const engines = data.engines || [];
    // Feed the dialog: a discovered engine opens pre-filled and its button goes
    // blue. An engine that has stopped answering is dropped from the map so the
    // colour follows reality rather than the last good scan.
    localDiscovery.clear();
    for (const engine of engines) {
      if (!engine.offline && Number.isInteger(engine.port)) localDiscovery.set(engine.engine, engine);
    }
    for (const engineId of localEngineIds) paintEngineButton(engineId);
    for (const engine of engines) {
      const item = document.createElement("li");
      item.className = "local-engine";
      const head = document.createElement("div");
      head.className = "local-engine-head";
      const name = document.createElement("strong");
      name.textContent = engine.label;
      const where = document.createElement("span");
      where.className = "local-engine-base";
      where.textContent = engine.baseUrl;
      head.append(name, where);
      const models = document.createElement("p");
      models.className = "local-engine-models";
      models.textContent = engine.models?.length
        ? engine.models.join(", ")
        : t("local.noModels");
      item.append(head, models);
      // What the operating system already knows about the process behind this
      // port: the model file actually loaded, the context it was started with,
      // and which build is running. Read rather than asked for, so it cannot
      // disagree with the engine. Absent for a port we could not attribute
      // (inside WSL or a container), and that row simply stays shorter.
      const spec = engine.launch;
      if (spec || engine.binary) {
        const runtime = document.createElement("p");
        runtime.className = "local-engine-runtime";
        const parts = [];
        if (spec?.model) parts.push(spec.model.split(/[\\/]/).pop());
        if (spec?.ctxSize) parts.push(t("local.ctxTokens", { tokens: formatContextSize(spec.ctxSize) }));
        if (spec?.parallel) parts.push(t("local.slots", { count: spec.parallel }));
        if (engine.binary) parts.push(engine.binary);
        runtime.textContent = parts.join(" · ");
        item.append(runtime);
      }
      // A scan result, not a control. Every engine connects from its own
      // section below, so this list stays one shape for all three.
      const state = document.createElement("p");
      state.className = "local-engine-state";
      if (!engine.connectable && engine.engine !== "ollama") {
        // Discovered, but there is no profile to attach it to. The API page
        // takes an arbitrary endpoint with a key, which is what this needs.
        state.textContent = t("local.useApiPage");
      } else if (engine.connected && engine.offline) {
        item.classList.add("is-connected", "is-offline");
        state.textContent = t("local.offline", { count: engine.connectedModels });
      } else if (engine.connected) {
        item.classList.add("is-connected");
        state.textContent = t("local.connected", { count: engine.connectedModels });
      } else {
        state.textContent = t("local.notConnected");
      }
      item.append(state);
      list.append(item);
    }
    if (note) note.textContent = engines.length ? "" : t("local.none");
    return engines;
  } catch (error) {
    if (note) note.textContent = error.message;
    return [];
  }
}

// Rescan discovers and nothing else. Connecting is the dialog's job, which is
// what gives an undiscovered engine a way in at all: there is no state where
// the user is left with a button that can only report failure.
$("local-rescan")?.addEventListener("click", () => { renderLocalEngines().catch(() => {}); });
// --- Configured endpoints (API page) ---
//
// One record per model rather than one slot: a self-hosted vLLM alongside a
// third-party API is an ordinary setup, and the slot this replaced silently
// overwrote the first endpoint when a second was added.
async function renderEndpointList() {
  const host = $("endpoint-list");
  const note = $("endpoint-list-note");
  if (!host) return;
  try {
    const response = await fetch("/api/custom/endpoints", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Endpoints ${response.status}`);
    const endpoints = data.endpoints || [];
    host.innerHTML = "";
    for (const endpoint of endpoints) {
      const item = document.createElement("li");
      item.className = "endpoint-row";
      const head = document.createElement("div");
      head.className = "endpoint-head";
      const name = document.createElement("strong");
      name.textContent = endpoint.modelId;
      const where = document.createElement("span");
      where.className = "endpoint-base";
      where.textContent = endpoint.baseUrl;
      head.append(name, where);
      const facts = document.createElement("p");
      facts.className = "endpoint-facts";
      const bits = [];
      if (endpoint.contextWindow) bits.push(`${number(endpoint.contextWindow)} ${t("roster.context")}`);
      if (endpoint.supportsVision) bits.push(t("roster.vision"));
      bits.push(t(endpoint.apiKeyConfigured ? "endpoints.keySet" : "endpoints.keyMissing"));
      facts.textContent = bits.join(" \u00b7 ");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "custom-action endpoint-remove";
      remove.textContent = t("endpoints.remove");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const reply = await fetch("/api/custom/remove", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ modelId: endpoint.modelId }),
          });
          const body = await reply.json();
          if (!reply.ok) throw new Error(body.error?.message || `Remove ${reply.status}`);
          await renderEndpointList();
          renderModelRoster().catch(() => {});
          poll().catch(() => {});
        } catch (error) {
          window.alert(error.message);
          remove.disabled = false;
        }
      });
      item.append(head, facts, remove);
      host.append(item);
    }
    if (note) note.textContent = endpoints.length ? "" : t("endpoints.empty");
  } catch (error) {
    if (note) note.textContent = error.message;
  }
}

// --- Custom model add section ---
const customEndpointInput = $("custom-endpoint");
const customApiKeyInput = $("custom-api-key");
const customModelSelect = $("custom-model-select");
const customAsVision = $("custom-as-vision");
const customListModelsBtn = $("custom-list-models");
const customAddBtn = $("custom-add-btn");
const customStatus = $("custom-status");
const customError = $("custom-error");
const customEndpointHint = $("custom-endpoint-hint");

function customShow(text, error) {
  if (customStatus) customStatus.hidden = !text || Boolean(error);
  if (customError) customError.hidden = !(text && error);
  if (customStatus) customStatus.textContent = error ? "" : text || "";
  if (customError) customError.textContent = error ? text : "";
}

function customErrorText(code, fallback) {
  const key = {
    connect: "custom.errConnect",
    key: "custom.errKey",
    model: "custom.errModel",
    upstream: "custom.errUpstream",
  }[code];
  return key ? t(key) : fallback;
}

// Lightweight mirror of the server's normalizeBaseUrl: show the completed
// Responses URL the probe will actually hit, e.g. https://host/v1 -> .../responses.
function customResponsesUrlPreview(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return "";
  const base = /\/v1$/i.test(value) ? value : `${value}/v1`;
  return `${base}/responses`;
}

function customShowHint(url) {
  if (!customEndpointHint) return;
  if (!url) {
    customEndpointHint.hidden = true;
    customEndpointHint.textContent = "";
    return;
  }
  customEndpointHint.hidden = false;
  customEndpointHint.textContent = t("custom.probeUrl", { url });
}

function renderCustomSection(custom) {
  const state = custom || {};
  if (!customEndpointInput || !customApiKeyInput) return;
  customEndpointInput.value = state.baseUrl || "";
  customShowHint(customResponsesUrlPreview(state.baseUrl));
  if (customModelSelect) {
    fillSelect(customModelSelect, state.model ? [{ id: state.model, label: state.model }] : [], {
      value: state.model || "",
      placeholder: false,
      disabled: !state.model,
    });
  }
  if (customAsVision) customAsVision.checked = Boolean(state.asVision);
  if (customApiKeyInput) {
    customApiKeyInput.value = "";
    customApiKeyInput.placeholder = state.apiKeyConfigured ? t("settings.configured") : "sk-...";
  }
  customShow("", false);
}

if (customEndpointInput) {
  customEndpointInput.addEventListener("input", () => {
    customShowHint(customResponsesUrlPreview(customEndpointInput.value));
  });
}

function awaitRuntimeMigrationThenUpdate(expectedVersion) {
  const started = Date.now();
  setTimeout(function probe() {
    fetch("/api/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("not ready");
        const status = await response.json();
        const nodeMajor = Number(String(status?.runtime?.nodeVersion || "").replace(/^v/, "").split(".", 1)[0]);
        if (nodeMajor < 24) throw new Error("runtime migration still in progress");
        const updateResponse = await fetch("/api/update", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = await updateResponse.json();
        if (!updateResponse.ok) {
          updateBusy = false;
          const button = $("update-button");
          if (button) {
            button.disabled = false;
            button.textContent = t("button.update");
          }
          window.alert(body.error?.message || `Update ${updateResponse.status}`);
          return;
        }
        awaitRestartThenReload(body.latestVersion || expectedVersion);
      })
      .catch((error) => {
        if (Date.now() - started > 120_000) {
          updateBusy = false;
          const button = $("update-button");
          if (button) {
            button.disabled = false;
            button.textContent = t("button.update");
          }
          window.alert("Node.js runtime migration did not complete. Check modeldock-update.log and try again.");
        } else if (error.message === "runtime migration still in progress" || error.message === "not ready" || error instanceof TypeError) setTimeout(probe, 2_000);
        else {
          updateBusy = false;
          const button = $("update-button");
          if (button) {
            button.disabled = false;
            button.textContent = t("button.update");
          }
          window.alert(error.message);
        }
      });
  }, 2_000);
}

// Endpoint presets for the two-in-one endpoint field: typing is always free, and
// the dropdown next to the input fills a common provider base URL. autoList is
// true only for endpoints whose /models is public (no key needed), so picking
// OpenRouter lands straight on model selection; the others list after a key.
const ENDPOINT_PRESETS = [
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1", autoList: true },
  { label: "OpenAI", url: "https://api.openai.com/v1", autoList: false },
  { label: "Ollama (local)", url: "http://127.0.0.1:11434/v1", autoList: false },
];
const customEndpointPresetsBtn = $("custom-endpoint-presets");
const customEndpointMenu = $("custom-endpoint-menu");
// Localized tooltip/aria labels for the preset dropdown; re-applied on language
// change through refreshDynamicText.
function applyPresetToggleLabel() {
  if (!customEndpointPresetsBtn || !customEndpointMenu) return;
  const label = t("custom.presetLabel");
  customEndpointPresetsBtn.title = label;
  customEndpointPresetsBtn.setAttribute("aria-label", label);
  customEndpointMenu.setAttribute("aria-label", label);
}
if (customEndpointPresetsBtn && customEndpointMenu) {
  applyPresetToggleLabel();
  const renderPresetMenu = () => {
    customEndpointMenu.replaceChildren();
    for (const preset of ENDPOINT_PRESETS) {
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = preset.label;
      button.append(Object.assign(document.createElement("small"), { textContent: preset.url }));
      button.addEventListener("click", () => {
        customEndpointInput.value = preset.url;
        customShowHint(customResponsesUrlPreview(customEndpointInput.value));
        customEndpointMenu.hidden = true;
        customEndpointPresetsBtn.setAttribute("aria-expanded", "false");
        if (preset.autoList) customListModelsBtn?.click();
      });
      item.append(button);
      customEndpointMenu.append(item);
    }
  };
  const closePresetMenu = () => {
    customEndpointMenu.hidden = true;
    customEndpointPresetsBtn.setAttribute("aria-expanded", "false");
  };
  customEndpointPresetsBtn.addEventListener("click", () => {
    const opening = customEndpointMenu.hidden;
    renderPresetMenu();
    customEndpointMenu.hidden = !opening;
    customEndpointPresetsBtn.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".endpoint-combo")) closePresetMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePresetMenu();
  });
}

if (customListModelsBtn) {
  customListModelsBtn.addEventListener("click", async () => {
    const baseUrl = customEndpointInput.value.trim();
    const apiKey = customApiKeyInput.value.trim();
    if (!baseUrl) {
      customShow(t("custom.errEndpointRequired"), true);
      return;
    }
    customListModelsBtn.disabled = true;
    try {
      const response = await fetch("/api/custom/list-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(body.error?.message || "List models failed"), { code: body.error?.type });
      }
      fillSelect(customModelSelect, body.models || [], {
        placeholder: false,
        disabled: !(body.models || []).length,
      });
      // Surface the exact URL the Add probe will hit (server-normalized).
      customShowHint(body.responsesUrl || customResponsesUrlPreview(baseUrl));
      customShow(
        body.models?.length ? t("custom.modelsLoaded", { n: body.models.length }) : t("custom.noModels"),
        false,
      );
    } catch (error) {
      customShow(customErrorText(error.code) || error.message, true);
    } finally {
      customListModelsBtn.disabled = false;
    }
  });
}

if (customAddBtn) {
  customAddBtn.addEventListener("click", async () => {
    const baseUrl = customEndpointInput.value.trim();
    const apiKey = customApiKeyInput.value.trim();
    const modelId = customModelSelect.value;
    if (!baseUrl) {
      customShow(t("custom.errEndpointRequired"), true);
      return;
    }
    if (!modelId) {
      customShow(t("custom.errModelRequired"), true);
      return;
    }
    if (!apiKey) {
      customShow(t("custom.errKeyRequired"), true);
      return;
    }
    customAddBtn.disabled = true;
    customAddBtn.textContent = t("custom.adding");
    customShow("", false);
    try {
      const response = await fetch("/api/custom/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          apiKey,
          modelId,
          asVision: Boolean(customAsVision?.checked),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(body.error?.message || "Add failed"), { code: body.error?.type });
      }
      customShowHint(body.responsesUrl || customResponsesUrlPreview(baseUrl));
      customShow(t("custom.added"), false);
      // Refresh the dashboard so the model list and route card pick up the new
      // provider immediately.
      poll().catch(() => {});
      pollConfig().catch(() => {});
      renderEndpointList().catch(() => {});
      renderModelRoster().catch(() => {});
    } catch (error) {
      customShow(customErrorText(error.code) || error.message, true);
    } finally {
      customAddBtn.disabled = false;
      customAddBtn.textContent = t("custom.add");
    }
  });
}

// --- Ollama (local) connect section ---
const ollamaStatus = $("ollama-status");
const ollamaError = $("ollama-error");

let ollamaState = { connected: false, baseUrl: "", models: [], mainModel: "", visionModel: "" };

function ollamaShow(text, error) {
  if (ollamaStatus) ollamaStatus.hidden = !text || Boolean(error);
  if (ollamaError) ollamaError.hidden = !(text && error);
  if (ollamaStatus) ollamaStatus.textContent = error ? "" : text || "";
  if (ollamaError) ollamaError.textContent = error ? text : "";
}

function ollamaErrorText(code, fallback) {
  const key = {
    connect: "ollama.errConnect",
    protocol: "ollama.errProtocol",
    models: "ollama.errModels",
    model: "ollama.errModel",
    upstream: "ollama.errUpstream",
  }[code];
  return key ? t(key) : fallback;
}

function renderOllamaSection(state) {
  ollamaState = state || { connected: false, baseUrl: "", models: [], mainModel: "", visionModel: "" };
  const connected = Boolean(ollamaState.connected && ollamaState.models?.length);
  ollamaShow(connected ? t("ollama.connected", { n: ollamaState.models?.length || 0 }) : "", false);
}

// --- Local engines: one port dialog for all three ---
//
// Scanning discovers, the dialog decides. The two were briefly one action,
// which left no way in at all when discovery came up empty; now a button
// always opens the same dialog and an engine that was not found is typed in.
//
// Blue means reachable, not merely configured. Both routes to blue are a probe
// that succeeded: discovery answers /props and /v1/models before it reports an
// engine, and a hand-typed port turns blue only after connect accepts it. A
// blue button that meant "a number is present" would be a colour saying nothing.
//
// There is no API key field. A local engine is reachable on loopback only, and
// that is the entire reason it needs no credential - one decision, not two,
// enforced by assertLocalBase on the server.
const localEngineIds = ["ollama", "llamacpp", "vllm"];
const localDiscovery = new Map();
const localConnectedState = new Map();
const localDefaultPorts = { ollama: 11434, llamacpp: 8080, vllm: 8000 };
let localConfigEngine = "";

function localEngineLabel(engine) {
  return { ollama: "Ollama", llamacpp: "llama.cpp", vllm: "vLLM" }[engine] || engine;
}

function paintEngineButton(engine) {
  const button = $(`${engine}-configure`);
  if (!button) return;
  const reachable = localDiscovery.has(engine) || localConnectedState.get(engine);
  button.classList.toggle("primary", Boolean(reachable));
  button.textContent = t(localConnectedState.get(engine) ? "local.configured" : "local.configure");
}

function localShow(engine, text, isError) {
  const status = $(`${engine}-status`);
  const errorLine = $(`${engine}-error`);
  if (status) {
    status.hidden = !text || Boolean(isError);
    status.textContent = isError ? "" : text || "";
  }
  if (errorLine) {
    errorLine.hidden = !(text && isError);
    errorLine.textContent = isError ? text : "";
  }
}

// Called with the settings payload for one engine, so the button and its status
// line agree with what the server actually published.
function renderLocalEngineState(engine, state) {
  const connected = Boolean(state?.connected && state.models?.length);
  localConnectedState.set(engine, connected);
  localShow(engine, connected ? t("local.connected", { count: state.models.length }) : "", false);
  paintEngineButton(engine);
}

const renderLocalSections = {
  llamacpp: (state) => renderLocalEngineState("llamacpp", state),
  vllm: (state) => renderLocalEngineState("vllm", state),
};

function openLocalConfig(engine) {
  localConfigEngine = engine;
  const dialog = $("local-config-dialog");
  if (!dialog) return;
  const found = localDiscovery.get(engine);
  const title = $("local-config-title");
  if (title) title.textContent = localEngineLabel(engine);

  // Pre-filled when discovery found it, empty with a hint when it did not.
  const port = $("local-config-port");
  if (port) {
    port.value = found ? String(found.port) : "";
    port.placeholder = String(localDefaultPorts[engine] || 8080);
  }

  // Read-only proof that the pre-filled port is the right one: the model file
  // actually loaded and the context it was started with, taken from the process
  // behind that port rather than from anything the user typed.
  const runtime = $("local-config-runtime");
  if (runtime) {
    const parts = [];
    if (found?.launch?.model) parts.push(found.launch.model.split(/[\\/]/).pop());
    if (found?.launch?.ctxSize) parts.push(t("local.ctxTokens", { tokens: formatContextSize(found.launch.ctxSize) }));
    if (found?.binary) parts.push(found.binary);
    runtime.textContent = parts.join(" · ");
    runtime.hidden = parts.length === 0;
  }

  // Ollama publishes vision from its own model metadata, so the toggle would be
  // a control that changes nothing there.
  const visionRow = $("local-config-vision-row");
  if (visionRow) visionRow.hidden = engine === "ollama";
  const vision = $("local-config-vision");
  if (vision) vision.checked = false;

  const disconnect = $("local-config-disconnect");
  if (disconnect) disconnect.hidden = !localConnectedState.get(engine);
  const errorLine = $("local-config-error");
  if (errorLine) errorLine.hidden = true;
  const save = $("local-config-save");
  if (save) save.textContent = t("local.connect");

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeLocalConfig() {
  const dialog = $("local-config-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function submitLocalConfig(action) {
  const engine = localConfigEngine;
  if (!engine) return;
  const save = $("local-config-save");
  const disconnect = $("local-config-disconnect");
  const errorLine = $("local-config-error");
  const showError = (text) => {
    if (!errorLine) return;
    errorLine.hidden = !text;
    errorLine.textContent = text || "";
  };
  showError("");

  const ollama = engine === "ollama";
  let body = ollama ? {} : { engine };
  if (action === "connect") {
    const field = $("local-config-port");
    const port = Number(String(field?.value || "").trim() || field?.placeholder || 0);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      showError(t("local.errPort"));
      return;
    }
    // Host is fixed: assertLocalBase refuses anything but loopback anyway, so a
    // host field could only ever be a way to be told no.
    const baseUrl = `http://127.0.0.1:${port}`;
    body = ollama
      ? { baseUrl }
      : { engine, baseUrl, asVision: Boolean($("local-config-vision")?.checked) };
  }

  if (save) save.disabled = true;
  if (disconnect) disconnect.disabled = true;
  const previous = save?.textContent;
  if (save && action === "connect") save.textContent = t("local.connecting");
  try {
    const path = ollama ? `/api/ollama/${action}` : `/api/local/${action}`;
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `${action} ${response.status}`);
    if (ollama) renderOllamaSection(payload.settings?.ollama);
    else renderLocalEngineState(engine, payload.settings?.local?.[engine]);
    closeLocalConfig();
    poll().catch(() => {});
    pollConfig().catch(() => {});
    renderModelRoster().catch(() => {});
    renderLocalEngines().catch(() => {});
  } catch (error) {
    showError(error.message);
  } finally {
    if (save) {
      save.disabled = false;
      if (previous) save.textContent = previous;
    }
    if (disconnect) disconnect.disabled = false;
  }
}

for (const engineId of localEngineIds) {
  $(`${engineId}-configure`)?.addEventListener("click", () => openLocalConfig(engineId));
  paintEngineButton(engineId);
}
$("local-config-close")?.addEventListener("click", closeLocalConfig);
$("local-config-save")?.addEventListener("click", () => { submitLocalConfig("connect").catch(() => {}); });
$("local-config-disconnect")?.addEventListener("click", () => { submitLocalConfig("disconnect").catch(() => {}); });



function closeSettings() {
  const dialog = $("settings-dialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function saveSettings() {
  const saveBtn = $("settings-save");
  saveBtn.disabled = true;
  const status = $("settings-status");
  status.textContent = t("settings.saving");
  try {
    const body = {};
    const go = $("settings-go-token").value.trim();
    const ds = $("settings-deepseek-token").value.trim();
    if (go) body.opencodeGoToken = go;
    if (ds) body.deepseekApiKey = ds;
    if (!Object.keys(body).length) {
      closeSettings();
      return;
    }
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Save ${response.status}`);
    status.textContent = t("settings.saved");
    closeSettings();
    poll().catch(() => {});
    pollConfig().catch(() => {});
  } catch (error) {
    status.textContent = error.message;
  } finally {
    saveBtn.disabled = false;
  }
}

$("settings-open")?.addEventListener("click", openSettings);
$("settings-close")?.addEventListener("click", closeSettings);
$("settings-save")?.addEventListener("click", saveSettings);
$("update-button")?.addEventListener("click", applyUpdate);

// Session filter: the dropdown and the chips below it set the same filter;
// both re-render in place so the cards, table, and chips stay consistent.
function resetWaveHovers() {
  waveHoverState.hover = -1;
  cacheHoverState.hover = -1;
  dataHoverState.hover = -1;
  tpsHoverState.hover = -1;
}

$("session-select")?.addEventListener("change", (event) => {
  sessionFilter = event.target.value;
  resetWaveHovers();
  if (typeof lastData !== "undefined" && lastData) render(lastData);
});

// Language selector: re-apply static text and refresh dynamic text in place.
// Every step is isolated. A language change is not all-or-nothing: one
// renderer throwing used to take the rest of the page with it, silently,
// because they ran in sequence with nothing between them. Rows built in
// script carry no data-i18n, so applyStaticI18n cannot reach their labels -
// the pages that build rows have to redraw them by hand.
function refreshDynamicText() {
  const steps = [
    () => applyStaticI18n(),
    () => { if (typeof applyPresetToggleLabel === "function") applyPresetToggleLabel(); },
    () => { if (typeof lastData !== "undefined" && lastData) render(lastData); },
    () => pollConfig().catch(() => {}),
    () => renderEndpointList().catch(() => {}),
    () => renderModelRoster().catch(() => {}),
    () => renderLocalEngines().catch(() => {}),
    () => {
      if (!lastSettings) return;
      renderCustomSection(lastSettings.custom);
      renderOllamaSection(lastSettings.ollama);
      for (const [engine, render] of Object.entries(renderLocalSections)) {
        render(lastSettings.local?.[engine]);
      }
    },
  ];
  for (const step of steps) {
    try { step(); } catch { /* one broken panel must not freeze the language */ }
  }
}

const langSelect = $("settings-lang");
if (langSelect) {
  langSelect.addEventListener("change", (event) => {
    setLang(event.target.value);
    refreshDynamicText();
  });
}


// Hash routing across the left rail. Views stay mounted and are toggled with a
// class, so the SSE stream, poll timers, and every listener registered below
// survive navigation - a per-page reload would tear all of that down and
// rebuild it on every click.
const VIEWS = ["dashboard", "subscriptions", "api", "local", "models"];

function routeToView(name) {
  const view = VIEWS.includes(name) ? name : VIEWS[0];
  for (const node of document.querySelectorAll("[data-view]")) {
    node.classList.toggle("is-active", node.dataset.view === view);
  }
  for (const link of document.querySelectorAll("[data-rail]")) {
    const active = link.dataset.rail === view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  return view;
}

function currentView() {
  return routeToView((location.hash || "").replace(/^#/, ""));
}

window.addEventListener("hashchange", currentView);
currentView();

// The settings pages render from /api/settings, so fetch it once at startup
// rather than waiting for a dialog nobody has to open any more.
loadSettings().catch(() => {});
renderLocalEngines().catch(() => {});
renderModelRoster().catch(() => {});
renderEndpointList().catch(() => {});

initI18n();
// After initI18n, not before: it resolves the stored/browser language, so reading it
// earlier would leave the picker on "English" while the page renders in another one.
if (langSelect) langSelect.value = getLang();
