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
  // The CSS box, and only the CSS box. This used to fall back to the bitmap
  // size, which defeated the very check below it: a hidden canvas measures zero
  // but has a bitmap, so `clientWidth || width` handed back the bitmap and the
  // guard never fired. Every poll that arrived while the dashboard was on
  // another tab then re-entered the resize with width = the current bitmap,
  // multiplied it by the device pixel ratio again, and assigning canvas.width
  // wipes the canvas. Measured at 125% scaling: 345 -> 431 -> 539 -> 674, and
  // 279239x93075 after about seven minutes away - a bitmap no browser will
  // allocate, from a card that was 276 CSS pixels wide.
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  // A hidden view measures zero. Returning leaves the last good frame in
  // place instead of clearing it to nothing.
  if (!width || !height) return;
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
  // The CSS box, and only the CSS box. This used to fall back to the bitmap
  // size, which defeated the very check below it: a hidden canvas measures zero
  // but has a bitmap, so `clientWidth || width` handed back the bitmap and the
  // guard never fired. Every poll that arrived while the dashboard was on
  // another tab then re-entered the resize with width = the current bitmap,
  // multiplied it by the device pixel ratio again, and assigning canvas.width
  // wipes the canvas. Measured at 125% scaling: 345 -> 431 -> 539 -> 674, and
  // 279239x93075 after about seven minutes away - a bitmap no browser will
  // allocate, from a card that was 276 CSS pixels wide.
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  // A hidden view measures zero. Returning leaves the last good frame in
  // place instead of clearing it to nothing.
  if (!width || !height) return;
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

// The managed local-host monitor. Hidden unless a host is under takeover:
// it uses the gateway's bounded, content-free lane events rather than trying
// to reverse-engineer scheduler state from a completed-request log.
const hostDash = {
  prefill: [],
  decode: [],
  seen: new Set(),
  prefillPeak: { peak: 0 },
  decodePeak: { peak: 0 },
  prefillPoints: [],
  decodePoints: [],
};
const HOSTDASH_SWIM_STATE = {
  running: "running",
  switching: "switching",
  restoring: "restoring",
  restored: "restoring",
  cold_prefill: "cold",
  hot: "hot",
  failed: "failed",
};

function hostDashPush(history, point) {
  history.push(point);
  history.sort((a, b) => a.t - b.t);
  if (history.length > WAVE_MAX_POINTS) history.splice(0, history.length - WAVE_MAX_POINTS);
}

function hostDashAvg(history) {
  if (!history.length) return 0;
  return history.reduce((sum, point) => sum + point.v, 0) / history.length;
}

function compactTokens(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`;
  return number(Math.round(count));
}

function hostDashState(kind) {
  return HOSTDASH_SWIM_STATE[String(kind || "")] || "";
}

function hostDashEvents(telemetry) {
  return Array.isArray(telemetry?.events)
    ? telemetry.events.filter((event) => Number.isFinite(Number(event?.at))).sort((left, right) => Number(left.at) - Number(right.at))
    : [];
}

function createSwimSegment({ event, next, windowStart, now }) {
  const state = hostDashState(event.kind);
  if (!state) return null;
  let start = Math.max(windowStart, Number(event.at));
  let end = Math.min(now, Number(next?.at) || now);
  if (event.kind === "restored" && Number(event.durationMs) > 0) {
    start = Math.max(windowStart, Number(event.at) - Number(event.durationMs));
    end = Math.min(now, Number(event.at));
  }
  if (end <= start) end = Math.min(now, start + Math.max(350, Number(event.durationMs) || 0));
  if (end <= windowStart || start >= now) return null;
  const segment = document.createElement("span");
  segment.className = `swim-segment swim-${state}`;
  const left = Math.max(0, Math.min(100, ((start - windowStart) / (now - windowStart)) * 100));
  const width = Math.min(100 - left, Math.max(0.7, ((end - start) / (now - windowStart)) * 100));
  segment.style.left = `${left}%`;
  segment.style.width = `${width}%`;
  segment.title = `${event.kind} · ${new Date(Number(event.at)).toLocaleTimeString()}`;
  return segment;
}

function renderHostSwimlanes(localHost, telemetry) {
  const container = $("hostdash-swimlanes");
  if (!container) return;
  const now = Date.now();
  const windowMs = Math.max(1_000, Number(telemetry?.windowMs) || 300_000);
  const windowStart = now - windowMs;
  const events = hostDashEvents(telemetry);
  const lanes = [...(localHost.lanes || [])].sort((left, right) => Number(left.slot) - Number(right.slot));
  const rows = lanes.map((lane) => {
    const row = document.createElement("div");
    row.className = "swimlane";
    const label = document.createElement("span");
    label.className = "swimlane-label";
    label.textContent = `SLOT ${Number(lane.slot) + 1}`;
    const track = document.createElement("div");
    track.className = "swimlane-track";
    const laneEvents = events.filter((event) => Number(event.slot) === Number(lane.slot) && hostDashState(event.kind));
    if (!laneEvents.length && lane.state !== "empty") {
      laneEvents.push({
        at: Math.max(windowStart, Date.parse(lane.lastAccessedAt || "") || now),
        kind: lane.state === "hot" ? "hot" : "running",
      });
    }
    laneEvents.forEach((event, index) => {
      const segment = createSwimSegment({ event, next: laneEvents[index + 1], windowStart, now });
      if (segment) track.append(segment);
    });
    const current = document.createElement("span");
    current.className = `swim-current${lane.state === "active" ? " is-active" : lane.state === "hot" ? " is-hot" : ""}`;
    current.title = lane.state || "empty";
    track.append(current);
    row.append(label, track);
    return row;
  });
  container.replaceChildren(...rows);
}

function renderLocalHostDashboard(data) {
  const section = $("local-host-dashboard");
  if (!section) return;
  const localHost = data.localHost;
  const managed = Boolean(localHost?.managed);
  // The monitor lives on its own rail tab so it can never collide with the
  // manage drawer; the tab itself is the gate - present only while a host is
  // under management. A stale #hostmonitor URL without a managed host shows
  // the explanation instead of a blank page.
  const rail = $("rail-hostmonitor");
  if (rail) rail.hidden = !managed;
  const empty = $("hostdash-empty");
  if (empty) empty.hidden = managed;
  section.hidden = !managed;
  if (!managed) return;

  // The backend exposes a bounded recent window. Retain dedupe ids only while
  // they remain in that window: otherwise a long-running browser tab retains
  // one Set entry for every completed local request forever.
  const recent = data.recent || [];
  const currentRecentIds = new Set(recent.map((item) => item?.id).filter(Boolean));
  for (const id of hostDash.seen) {
    if (!currentRecentIds.has(id)) hostDash.seen.delete(id);
  }

  for (const item of recent) {
    if (item.kind !== "responses" || item.status !== "ok" || !item.localCache?.tier || hostDash.seen.has(item.id)) continue;
    hostDash.seen.add(item.id);
    const restoreMs = Number(item.localCache.restoreMs) || 0;
    // Prefill speed is charged net of the SSD restore: the restore bought the
    // speed, so it must not be billed against it. Cached input is likewise
    // excluded: reporting cached history as new prefill made the old card lie.
    const firstMs = Number(item.firstResponseLatencyMs) || 0;
    const prefillMs = Math.max(0, firstMs - restoreMs);
    const inTokens = Number(item.inputTokens) || 0;
    const cachedTokens = Math.min(inTokens, Number(item.cachedTokens) || 0);
    const prefillTokens = Math.max(0, inTokens - cachedTokens);
    if (prefillTokens > 0 && prefillMs > 0) {
      hostDashPush(hostDash.prefill, { id: item.id, t: item.startedAt || 0, v: prefillTokens / (prefillMs / 1000) });
    }
    const outTokens = Number(item.outputTokens) || 0;
    const decodeMs = Math.max(0, (Number(item.latencyMs) || 0) - firstMs);
    if (outTokens > 0 && decodeMs > 0) {
      hostDashPush(hostDash.decode, { id: item.id, t: item.startedAt || 0, v: outTokens / (decodeMs / 1000) });
    }
  }

  const prefillVisible = visiblePoints(hostDash.prefill);
  hostDash.prefillPeak.peak = prefillVisible.reduce((max, point) => Math.max(max, point.v), 0);
  const prefillCanvas = $("hostdash-prefill-wave");
  if (prefillCanvas) drawWave(prefillCanvas, prefillVisible, hostDash.prefillPeak.peak, -1, WAVE_BLUE, hostDash.prefillPoints);
  set("hostdash-prefill-last", prefillVisible.length ? number(Math.round(prefillVisible[prefillVisible.length - 1].v)) : "—");
  set("hostdash-prefill-avg", prefillVisible.length ? number(Math.round(hostDashAvg(prefillVisible))) : "—");
  set("hostdash-prefill-count", number(prefillVisible.length));

  const decodeVisible = visiblePoints(hostDash.decode);
  hostDash.decodePeak.peak = decodeVisible.reduce((max, point) => Math.max(max, point.v), 0);
  const decodeCanvas = $("hostdash-decode-wave");
  if (decodeCanvas) drawWave(decodeCanvas, decodeVisible, hostDash.decodePeak.peak, -1, WAVE_VIOLET, hostDash.decodePoints);
  set("hostdash-decode-last", decodeVisible.length ? number(Math.round(decodeVisible[decodeVisible.length - 1].v)) : "—");
  set("hostdash-decode-avg", decodeVisible.length ? number(Math.round(hostDashAvg(decodeVisible))) : "—");

  const telemetry = localHost.telemetry || {};
  const totals = telemetry.totals || {};
  const counters = localHost.counters || {};
  const events = hostDashEvents(telemetry);
  const lastRestore = [...events].reverse().find((event) => event.kind === "restored" && Number(event.durationMs) > 0);
  set("hostdash-read-total", compactTokens(totals.inputTokens));
  set("hostdash-reused-total", compactTokens(totals.cachedTokens));
  set("hostdash-output-total", compactTokens(totals.outputTokens));
  const calibrated = Number(telemetry.coldPrefillSamples) > 0;
  set("hostdash-time-saved", calibrated ? duration(totals.timeSavedMs || 0) : "—");
  set("hostdash-time-saved-label", calibrated ? t("hostdash.timeSaved") : t("hostdash.calibrating"));
  set("hostdash-active-count", number(localHost.activeCount || 0));
  set("hostdash-pending-count", number(localHost.pendingCount || 0));
  renderHostSwimlanes(localHost, telemetry);
  set("hostdash-hot-lanes", `${localHost.hotCount || 0}/${(localHost.lanes || []).length || 0}`);
  set("hostdash-gpu-hot-lanes", `${localHost.hotCount || 0}/${(localHost.lanes || []).length || 0}`);
  set("hostdash-restores", number(counters.restores || 0));
  set("hostdash-prefill-restore-last", lastRestore ? duration(lastRestore.durationMs) : "—");
  set("hostdash-restore-last", lastRestore ? duration(lastRestore.durationMs) : "—");
  const slots = $("hostdash-gpu-slots");
  if (slots) {
    slots.replaceChildren(...(localHost.lanes || []).map((lane) => {
      const slot = document.createElement("i");
      slot.className = `kv-slot${lane.state === "active" ? " is-active" : lane.state === "hot" ? " is-hot" : ""}`;
      slot.title = lane.state || "empty";
      return slot;
    }));
  }

  const ssd = localHost.ssd;
  const fill = $("hostdash-ssd-fill");
  if (ssd && ssd.budgetBytes > 0) {
    const ratio = Math.min(1, (Number(ssd.totalBytes) || 0) / Number(ssd.budgetBytes));
    if (fill) {
      fill.style.width = `${Math.round(ratio * 100)}%`;
      fill.classList.toggle("is-tight", ratio > 0.85);
    }
    set("hostdash-ssd-used", `${gib(ssd.totalBytes)} / ${gib(ssd.budgetBytes)}`);
  } else {
    if (fill) fill.style.width = "0";
    set("hostdash-ssd-used", "—");
  }
  set("hostdash-ssd-states", number(ssd?.states || 0));
  set("hostdash-checkpoints", number(counters.saves || 0));
  set("hostdash-cold-prefills", number(counters.coldPrefills || 0));
}

function gib(bytes) {
  const value = Number(bytes) / 1024 ** 3;
  if (!Number.isFinite(value) || value <= 0) return "0 GiB";
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} GiB`;
}

$("hostdash-ssd-clear")?.addEventListener("click", async () => {
  if (!window.confirm(t("hostdash.clearConfirm"))) return;
  const button = $("hostdash-ssd-clear");
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/local/kv/clear", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Clear ${response.status}`);
  } catch (error) {
    window.alert(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

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
  renderLocalHostDashboard(data);
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
  renderXaiSection(data.xai);
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

// "published" heads an unlabelled column: the switches read as a column of
// their own, and a heading over them would have to be a verb ("Publish"?) that
// reads as an action on all of them rather than the state of each.
const ROSTER_COLUMNS = ["published", "model", "provider", "context", "vision", "requests", "tps", "cache"];

// The column the table is ordered by, and which way. Requests descending is
// where it starts, because "what am I actually running" is the first question
// this page answers; a click on another heading answers a different one.
//
// Two states per column, not three: the third ("back to how it was") is
// already reachable by clicking Requests, so a cycle that passes through it
// would only add a click nobody asked for.
const rosterSort = { column: "requests", direction: "desc" };

// Numbers sort as numbers, text as text, and a missing value always sinks -
// an unused model has no tps to compare, and floating it to the top of an
// ascending sort would say it was the fastest.
const ROSTER_SORT_KEYS = {
  published: (entry) => (entry.published === false ? 0 : 1),
  model: (entry) => entry.label || entry.id,
  provider: (entry) => entry.providerLabel || entry.provider || "",
  context: (entry) => entry.contextWindow || 0,
  vision: (entry) => (entry.supportsVision ? 1 : 0),
  requests: (entry) => entry.usage?.popularity ?? entry.usage?.requests ?? 0,
  tps: (entry) => entry.usage?.tps || 0,
  cache: (entry) => entry.usage?.cacheRate || 0,
};

// Provider marks stay inline so the table has no network dependency and each
// mark remains crisp at the small size a dense roster needs. The paths are
// brand marks, not decorative substitutes; the provider name remains visible
// beside every mark for clarity and accessibility.
const PROVIDER_MARKS = {
  openai: {
    color: "#9bb7c8",
    viewBox: "0 0 256 260",
    path: "M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z",
  },
  "opencode-go": {
    color: "#9aabff",
    viewBox: "0 0 24 24",
    path: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
  },
  "deepseek-official": {
    color: "#6f91ff",
    viewBox: "0 0 24 24",
    path: "M23.748 4.651c-.254-.124-.364.113-.512.233c-.051.04-.094.09-.137.137c-.372.397-.806.657-1.373.626c-.829-.046-1.537.214-2.163.848c-.133-.782-.575-1.248-1.247-1.548c-.352-.155-.708-.311-.955-.65c-.172-.24-.219-.509-.305-.774c-.055-.16-.11-.323-.293-.35c-.2-.031-.278.136-.356.276c-.313.572-.434 1.202-.422 1.84c.027 1.436.633 2.58 1.838 3.393c.137.094.172.187.129.323c-.082.28-.18.553-.266.833c-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836c.27-.098.094-.433-.778-.428c-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136a9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653c1.857 1.533 3.997 2.284 6.438 2.14c1.482-.085 3.132-.284 4.994-1.86c.47.234.962.328 1.78.398c.629.058 1.235-.031 1.705-.129c.735-.155.684-.836.418-.961c-2.155-1.004-1.682-.595-2.112-.926c1.095-1.295 2.768-3.598 3.284-6.733c.05-.346.115-.834.108-1.114c-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517c.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16c-.39.024-.32.472-.234.763c.09.288.207.487.371.74c.114.167.192.416-.113.603c-.673.416-1.842-.14-1.897-.168c-1.361-.801-2.5-1.86-3.301-3.306c-.775-1.393-1.225-2.888-1.299-4.482c-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774c.868.86 1.525 1.887 2.202 2.89c.72 1.066 1.494 2.082 2.48 2.915c.348.291.626.513.892.677c-.802.09-2.14.109-3.055-.615z",
  },
  xai: {
    color: "#c0a8ff",
    viewBox: "0 0 24 24",
    path: "M14.234 10.162L22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993l-9.168-13.838zm-2.837 3.299l-.929-1.329L3.076 1.56h3.182l5.965 8.532l.929 1.329l7.754 11.09h-3.182z",
  },
  llamacpp: {
    color: "#b9c8d4",
    viewBox: "0 0 24 24",
    path: "M3 4h18v16H3zM7 8h2v2H7zm4 0h6v2h-6zM7 12h2v2H7zm4 0h4v2h-4zM7 16h10v2H7z",
  },
  custom: {
    color: "#aab9c4",
    viewBox: "0 0 24 24",
    path: "M8 3v5a4 4 0 0 0 8 0V3h-2v5a2 2 0 0 1-4 0V3zM3 11h18v2H3zm5 5h8v2H8z",
  },
};

function providerMark(provider) {
  const key = String(provider || "").toLowerCase();
  const mark = PROVIDER_MARKS[key] || PROVIDER_MARKS.custom;
  const wrap = document.createElement("span");
  wrap.className = `roster-provider-mark roster-provider-mark-${key.replace(/[^a-z0-9]+/g, "-")}`;
  wrap.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", mark.viewBox);
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", mark.path);
  svg.append(path);
  wrap.append(svg);
  wrap.style.setProperty("--provider-color", mark.color);
  return wrap;
}

function providerCell(entry) {
  const cell = document.createElement("td");
  cell.className = "roster-provider-cell";
  const content = document.createElement("span");
  content.className = "roster-provider";
  const name = document.createElement("span");
  name.className = "roster-provider-name";
  name.textContent = entry.providerLabel || entry.provider || "-";
  content.append(providerMark(entry.provider), name);
  cell.append(content);
  return cell;
}

function rosterMetricCell(kind, value, formatted, ratio) {
  const cell = document.createElement("td");
  cell.className = "roster-num roster-metric-cell";
  if (value === null) {
    cell.textContent = "-";
    return cell;
  }
  const metric = document.createElement("span");
  metric.className = `roster-metric roster-metric-${kind}`;
  const track = document.createElement("span");
  track.className = "roster-metric-track";
  track.setAttribute("aria-hidden", "true");
  const fill = document.createElement("i");
  fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  track.append(fill);
  const numberNode = document.createElement("span");
  numberNode.className = "roster-metric-value";
  numberNode.textContent = formatted;
  metric.append(numberNode, track);
  cell.append(metric);
  return cell;
}

function sortRoster(rows) {
  const key = ROSTER_SORT_KEYS[rosterSort.column] || ROSTER_SORT_KEYS.requests;
  const sign = rosterSort.direction === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    const compared = typeof left === "string" || typeof right === "string"
      ? String(left).localeCompare(String(right))
      : (left || 0) - (right || 0);
    // Output tokens break a tie on traffic: two models called the same number
    // of times are not equally used if one of them wrote ten times as much.
    // The label breaks everything else, so the order never wobbles between
    // renders of identical data.
    return compared * sign
      || ((b.usage?.out || 0) - (a.usage?.out || 0)) * (rosterSort.column === "requests" ? 1 : 0)
      || String(a.label).localeCompare(String(b.label));
  });
}

// One row's switch. A model that is switched off keeps its row - the roster is
// the only way back on - so the state is drawn, never filtered.
//
// The gateway's own selections are drawn as on and locked rather than hidden:
// the catalog publishes them whatever the file says, so an interactive switch
// there would be a control that cannot change anything.
function rosterSwitch(entry, onChanged) {
  const cell = document.createElement("td");
  cell.className = "roster-switch-cell";
  const wrap = document.createElement("label");
  wrap.className = "roster-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = entry.published !== false;
  input.disabled = Boolean(entry.locked);
  const track = document.createElement("span");
  track.className = "roster-switch-track";
  track.append(document.createElement("i"));
  wrap.append(input, track);
  if (entry.locked) {
    wrap.classList.add("locked");
    wrap.title = t("roster.switchLocked");
  } else {
    wrap.title = input.checked ? t("roster.switchOn") : t("roster.switchOff");
  }
  input.setAttribute("aria-label", `${t("roster.switchLabel")} - ${entry.label}`);

  input.addEventListener("change", async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      const response = await fetch("/api/models/enabled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, enabled: next }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || `Models ${response.status}`);
      entry.published = next;
      wrap.title = next ? t("roster.switchOn") : t("roster.switchOff");
      // The row recedes here rather than on the next render: this handler
      // deliberately does not re-render (that would throw away the scroll
      // position of a thirty-row table), so the class has to follow the switch.
      cell.closest("tr")?.classList.toggle("roster-parked", !next);
      // The restart banner is driven by the same restartRequired flag this
      // route sets, so the row stays put and the page says it once at the top.
      // Re-rendering here would also throw away the scroll position on a
      // thirty-row table for a change the user can already see.
      onChanged?.();
    } catch (error) {
      input.checked = !next;
      window.alert(error.message);
    } finally {
      input.disabled = Boolean(entry.locked);
    }
  });
  cell.append(wrap);
  return cell;
}

function rosterCell(text, className) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function rosterRow(entry, rank, onChanged, scales) {
  const row = document.createElement("tr");
  if (entry.published === false) row.classList.add("roster-parked");
  row.append(rosterSwitch(entry, onChanged));
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
  row.append(providerCell(entry));
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
  const requests = usage ? Number(usage.popularity ?? usage.requests) || 0 : null;
  const tpsValue = usage && usage.tps ? Number(usage.tps) : null;
  const cacheValue = usage && usage.in ? Math.max(0, Math.min(1, Number(usage.cacheRate) || 0)) : null;
  row.append(rosterMetricCell("requests", requests, requests === null ? "-" : number(requests), requests === null ? 0 : requests / scales.requests));
  row.append(rosterMetricCell("tps", tpsValue, tpsValue === null ? "-" : tpsValue.toFixed(1), tpsValue === null ? 0 : tpsValue / scales.tps));
  row.append(rosterMetricCell("cache", cacheValue, cacheValue === null ? "-" : `${Math.round(cacheValue * 100)}%`, cacheValue === null ? 0 : cacheValue));
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
    sortRoster(rows);
    host.innerHTML = "";
    const table = document.createElement("table");
    table.className = "roster-table";
    const head = document.createElement("tr");
    for (const column of ROSTER_COLUMNS) {
      const cell = document.createElement("th");
      // The context column names its unit; every other column is its own label.
      // The switch column is deliberately unlabelled (see ROSTER_COLUMNS).
      cell.textContent = column === "published"
        ? ""
        : t(column === "context" ? "roster.contextWindow" : `roster.${column}`);
      if (column === "published") cell.className = "roster-head-switch";
      // Context is a right-aligned field, while the three visual metrics need
      // their headings above the left-hand bars rather than above the values.
      if (column === "context") cell.className = "roster-head-num";
      if (["requests", "tps", "cache"].includes(column)) cell.className = "roster-head-metric";
      // The switch column has no heading to click, and nothing to order by that
      // the state itself does not already say.
      if (column !== "published") {
        cell.classList.add("roster-head-sort");
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        if (rosterSort.column === column) {
          cell.classList.add("is-sorted");
          cell.dataset.direction = rosterSort.direction;
          cell.setAttribute("aria-sort", rosterSort.direction === "asc" ? "ascending" : "descending");
        }
        const resort = () => {
          // A new column starts descending for numbers and ascending for text:
          // "most requests" and "A first" are what each one is usually asked.
          if (rosterSort.column === column) {
            rosterSort.direction = rosterSort.direction === "asc" ? "desc" : "asc";
          } else {
            rosterSort.column = column;
            rosterSort.direction = ["model", "provider"].includes(column) ? "asc" : "desc";
          }
          renderModelRoster();
        };
        cell.addEventListener("click", resort);
        cell.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); resort(); }
        });
      }
      head.append(cell);
    }
    const body = document.createElement("tbody");
    body.append(head);
    const scales = {
      requests: Math.max(1, ...rows.map((entry) => Number(entry.usage?.popularity ?? entry.usage?.requests) || 0)),
      tps: Math.max(1, ...rows.map((entry) => Number(entry.usage?.tps) || 0)),
    };
    let used = 0;
    rows.forEach((entry, index) => {
      if (entry.usage) used += 1;
      body.append(rosterRow(entry, String(index + 1), () => pollConfig().catch(() => {}), scales));
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
// Warnings are keyed by code so the text lives in the translation table and
// the server sends no prose.
function warningText(code) {
  return t(`warn.${code}`);
}

function renderEngineWarnings(warnings) {
  const box = $("local-warnings");
  if (!box) return;
  const list = Array.isArray(warnings) ? warnings : [];
  box.replaceChildren();
  box.hidden = list.length === 0;
  for (const warning of list) {
    const item = document.createElement("li");
    item.textContent = warningText(warning.code);
    box.append(item);
  }
}

// 81920 reads as 80K to anyone who set it; the exact figure is noise here.
// Thousands, the same base the Models page reads windows in. Binary K is the
// computing convention and would suit a llama.cpp -c 81920 (80K exactly), but
// most published windows are decimal - 272000, 200000, 1000000 - and showing
// DeepSeek 1M as 976.6K to keep Kimi 256K round is the worse trade. One base
// across the product beats either base used in half of it.
function formatContextSize(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function formatContextTokens(tokens) {
  const value = Number(tokens);
  return Number.isSafeInteger(value) && value > 0 ? value.toLocaleString() : "?";
}

function managedPlanSummary(profile) {
  if (!profile?.laneCount || !profile?.laneContextTokens) return "";
  return t("host.plan", {
    context: formatContextTokens(profile.totalContextTokens),
    lanes: profile.laneCount,
  });
}

function hostControlSummary(management) {
  if (!management) return t("host.userOwned");
  if (management.state !== "ready") return t("host.state", {
    state: management.state,
    failure: management.failure ? ` - ${management.failure}` : "",
  });
  return managedPlanSummary(management.profile) || "automatic profile pending";
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
    localKvDirectoryDefault = String(data.kvDirectoryDefault || "");
    localKvBudgetDefaultGiB = Number(data.kvBudgetDefaultGiB) || 0;
    localNativeHostPicker = Boolean(data.nativeLocalHostPicker);
    // Feed the dialog: a discovered engine opens pre-filled and its button goes
    // blue. An engine that has stopped answering is dropped from the map so the
    // colour follows reality rather than the last good scan.
    localDiscovery.clear();
    for (const engine of engines) {
      // One entry per engine, and which one matters: discovery lists the ports
      // it read from the process table before the fixed candidates, precisely so
      // the attributed one wins. Overwriting on a repeated engine id inverted
      // that - a llama-server on 11435 was replaced by a fixed-list hit on 8080,
      // taking the pid, binary and launch arguments with it, and the dialog then
      // offered the default port while the real server ran elsewhere.
      if (!engine.offline && Number.isInteger(engine.port) && preferEngine(engine, localDiscovery.get(engine.engine))) {
        localDiscovery.set(engine.engine, engine);
      }
    }
    for (const engineId of localEngineIds) paintEngineButton(engineId);
    for (const engineId of localEngineIds) paintRestartButton(engineId);
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
      // The scan names a server and the model it is serving, and stops there.
      // It used to carry the model file, the context, the slot count, the binary
      // path, the memory ledger and the warnings as well - six lines per engine,
      // stacked before anyone had asked a question. All of it is in
      // Configurations, which is where you go when you have one.
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
        state.textContent = t("local.gatewayOffline", { count: engine.connectedModels });
      } else if (engine.connected) {
        item.classList.add("is-connected");
        state.textContent = t("local.gatewayConnected", { count: engine.connectedModels });
      } else {
        state.textContent = t("local.gatewayNotConnected");
      }
      item.append(state);
      if (engine.engine === "llamacpp") {
        const control = document.createElement("p");
        control.className = "local-engine-state";
        control.textContent = hostControlSummary(engine.management);
        item.append(control);
      }
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
// One field per configured endpoint, shaped like the preset above it: the
// provider on top, its key below, editable in place. The list used to be
// summary rows you could only delete, so a key typed once was invisible and
// unchangeable afterwards - the page could show you what you had configured
// but not let you correct it.
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
      host.append(endpointField(endpoint));
    }
    if (note) note.textContent = endpoints.length ? "" : t("endpoints.empty");
  } catch (error) {
    if (note) note.textContent = error.message;
  }
}

$("endpoint-save")?.addEventListener("click", async () => {
  const button = $("endpoint-save");
  const status = $("endpoint-save-status");
  button.disabled = true;
  if (status) status.textContent = t("settings.saving");
  try {
    const deepseek = $("settings-deepseek-token")?.value.trim();
    if (deepseek) {
      const reply = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deepseekApiKey: deepseek }),
      });
      const body = await reply.json();
      if (!reply.ok) throw new Error(body.error?.message || `Save ${reply.status}`);
      $("settings-deepseek-token").value = "";
    }
    // A user-set endpoint keeps its own key, so each changed one is its own
    // write rather than a single payload the server would have to unpick.
    for (const field of document.querySelectorAll("#endpoint-list .field")) {
      const key = field.querySelector(".endpoint-key");
      const value = key?.value.trim();
      if (!value) continue;
      const reply = await fetch("/api/custom/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          modelId: field.dataset.modelId,
          providerId: field.dataset.providerId,
          apiKey: value,
        }),
      });
      const body = await reply.json();
      if (!reply.ok) throw new Error(body.error?.message || `Save ${reply.status}`);
      key.value = "";
    }
    if (status) status.textContent = t("settings.saved");
    await renderEndpointList();
    pollConfig().catch(() => {});
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function endpointField(endpoint) {
  const field = document.createElement("label");
  field.className = "field";
  field.dataset.modelId = endpoint.modelId;
  field.dataset.providerId = endpoint.providerId || "custom";

  const head = document.createElement("div");
  head.className = "field-head";
  const name = document.createElement("span");
  // The address is the provider and the model together: the same model id
  // can be served by two providers, and the name has to say which one this is.
  name.textContent = `${endpoint.providerId || "custom"} / ${endpoint.modelId}`;
  const where = document.createElement("a");
  where.className = "endpoint-base";
  where.href = endpoint.baseUrl;
  where.target = "_blank";
  where.rel = "noopener noreferrer";
  where.textContent = endpoint.baseUrl;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "endpoint-remove";
  remove.textContent = "×";
  // An icon needs its name somewhere a pointer and a screen reader can both
  // reach; the glyph is not one.
  remove.title = t("endpoints.remove");
  remove.setAttribute("aria-label", t("endpoints.remove"));
  // The address and the control travel together at the right end, so the
  // heading stays a two-part row rather than spreading into three - and the
  // key field below is left free to span the same width as the preset one
  // above it, which is the whole reason the button is not beside it.
  const tail = document.createElement("span");
  tail.className = "endpoint-head-tail";
  tail.append(where, remove);
  head.append(name, tail);

  const row = document.createElement("div");
  row.className = "settings-row";
  const key = document.createElement("input");
  key.type = "password";
  key.className = "endpoint-key";
  key.autocomplete = "off";
  key.spellcheck = false;
  // Never echo a stored key back into the field: the placeholder reports that
  // one is set, and leaving it blank keeps it - the same contract the preset
  // key fields have always had.
  key.placeholder = t(endpoint.apiKeyConfigured ? "settings.configured" : "settings.required");
  remove.addEventListener("click", async (event) => {
    event.preventDefault();
    remove.disabled = true;
    try {
      const reply = await fetch("/api/custom/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: endpoint.modelId, providerId: endpoint.providerId }),
      });
      const body = await reply.json();
      if (!reply.ok) throw new Error(body.error?.message || `Remove ${reply.status}`);
      await renderEndpointList();
      renderModelRoster().catch(() => {});
      poll().catch(() => {});
      pollConfig().catch(() => {});
    } catch (error) {
      window.alert(error.message);
      remove.disabled = false;
    }
  });
  row.append(key);

  field.append(head, row);
  return field;
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
          providerId: $("custom-provider")?.value || "",
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
  // Same rule the other two get: something to replay, and nothing answering.
  localCanRestart.set("ollama", Boolean(ollamaState.canRestart));
  paintRestartButton("ollama");
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
const localCanRestart = new Map();

// Offered only when there is a launch to replay and nothing is answering:
// starting a second copy on a port the first one holds just fails.
function paintRestartButton(engine) {
  const button = $(`${engine}-restart`);
  if (!button) return;
  const offer = Boolean(localCanRestart.get(engine)) && !localDiscovery.has(engine);
  button.hidden = !offer;
  // The remembered launch is the process's own argv and nothing else. An engine
  // configured through LLAMA_ARG_* or OLLAMA_HOST comes back with the same
  // command line and different settings, so say so rather than imply a faithful
  // replay. This goes away once a chosen spec exists, because those args are ours.
  const hint = $(`${engine}-restart-hint`);
  if (hint) hint.hidden = !offer;
}

// A connected engine beats an idle one; an engine we could attribute to a
// process beats one we only found by knocking on a default port. Otherwise the
// first stays, which is discovery order.
function preferEngine(next, current) {
  if (!current) return true;
  if (Boolean(next.connected) !== Boolean(current.connected)) return Boolean(next.connected);
  if (Boolean(next.pid) !== Boolean(current.pid)) return Boolean(next.pid);
  return false;
}
const localConnectedState = new Map();
const localDefaultPorts = { ollama: 11434, llamacpp: 8080, vllm: 8000 };
let localConfigEngine = "";
// Server-computed manage-form default (the install's own state dir): the
// server knows the platform and the directory it owns; the frontend does not
// guess at drive letters.
let localKvDirectoryDefault = "";
// Also server-computed: derived from the free space of the volume holding the
// default directory, minus a system reserve - never a constant that assumes
// the disk has room.
let localKvBudgetDefaultGiB = 0;
// The browser still permits typing an absolute path anywhere. Browse appears
// only when this local gateway can open a Windows-native dialog for it.
let localNativeHostPicker = false;

function localEngineLabel(engine) {
  return { ollama: "Ollama", llamacpp: "llama.cpp", vllm: "vLLM" }[engine] || engine;
}

function paintEngineButton(engine) {
  // Two controls that mirror the two authorities: Connect is the light,
  // reversible decision (route requests through the gateway), Manage opens the
  // drawer where the heavy boundaries live (host takeover, SSD KV). One
  // "Configurations" button used to carry both, and users could not tell the
  // weight of what they were about to click.
  const connected = Boolean(localConnectedState.get(engine));
  // Reachable means a probe answered - discovery answers /props and /v1/models
  // before reporting an engine, and a hand-typed port only counts once connect
  // accepted it. The colour therefore always means "this really responds".
  const reachable = Boolean(localDiscovery.has(engine) || connected);
  const connect = $(`${engine}-connect`);
  if (connect) {
    connect.classList.toggle("primary", reachable && !connected);
    connect.textContent = t(connected ? "local.disconnect" : "local.connectBtn");
  }
  const manage = $(`${engine}-configure`);
  if (manage) {
    manage.classList.toggle("primary", connected);
    manage.classList.toggle("is-open", localConfigEngine === engine);
    manage.textContent = t("local.manageBtn");
  }
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
  // Shown only when there is a launch to replay, and only while the engine is
  // not answering: starting a second copy on a port the first one holds fails,
  // and offering it would read as a control that does not work.
  localCanRestart.set(engine, Boolean(state?.canRestart));
  paintRestartButton(engine);
}

const renderLocalSections = {
  llamacpp: (state) => renderLocalEngineState("llamacpp", state),
  vllm: (state) => renderLocalEngineState("vllm", state),
};

function showLocalHostManageStatus(message, isError = false) {
  const status = $("local-host-manage-status");
  if (!status) return;
  status.hidden = !message;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
}

function renderLocalHostControl(engine, found) {
  const control = $("local-host-control");
  if (!control) return;
  const supported = engine === "llamacpp";
  control.hidden = !supported;
  if (!supported) return;

  const connected = Boolean(found && !found.offline && localConnectedState.get("llamacpp"));
  const management = found?.management || null;
  const gateway = $("local-host-gateway-state");
  if (gateway) {
    gateway.textContent = connected
      ? t("host.gatewayConnected")
      : t("host.gatewayNotConnected");
  }
  const state = $("local-host-management-state");
  if (state) {
    state.textContent = management
      ? hostControlSummary(management)
      : (found?.recommendedProfile
        ? t("host.automaticTarget", {
            state: t("host.userOwned"),
            lanes: found.recommendedProfile.laneCount,
            context: formatContextSize(found.recommendedProfile.laneContextTokens),
          })
        : t("host.userOwned"));
  }
  const form = $("local-host-management-form");
  // A managed host still needs to show the exact model, projector, and SSD KV
  // paths that ModelDock will reuse after a restart. Hiding this form made a
  // successful takeover look like a blank drawer and forced users to wonder
  // whether their choices had been retained. The values are read-only while
  // managed; Leave management returns the form to its editable setup state.
  if (form) form.hidden = !connected;
  // The drawer's bottom primary is contextual: before the gateway route exists
  // it connects ("Connect and Save" - the manual-port path); once connected
  // and unmanaged it performs the takeover ("Save and Manage"); once managed
  // there is nothing left for it to save - Leave management is the action.
  const save = $("local-config-save");
  if (save && localConfigEngine === engine) {
    const manageMode = connected && !management;
    save.dataset.mode = manageMode ? "manage" : "connect";
    save.textContent = t(manageMode ? "local.saveManage" : "local.connect");
    save.hidden = Boolean(management);
  }
  const release = $("local-host-unmanage");
  if (release) {
    release.hidden = !management;
    release.dataset.hostId = management?.id || "";
  }
  const directory = $("local-host-kv-directory");
  if (directory && management?.cacheDirectory) directory.value = management.cacheDirectory;
  if (directory && !management && !directory.value && localKvDirectoryDefault) {
    directory.value = localKvDirectoryDefault;
  }
  const budget = $("local-host-kv-budget");
  if (budget && management?.cacheBudgetBytes) budget.value = String(Math.round(Number(management.cacheBudgetBytes) / 1024 ** 3));
  const observation = found?.observation || null;
  const model = $("local-host-model-file");
  if (model && management?.modelPath) model.value = management.modelPath;
  if (model && !management && !model.value) model.value = observation?.modelPath || found?.launch?.model || "";
  const visionToggle = $("local-host-vision-enabled");
  const projector = $("local-host-vision-projector");
  if (projector && management?.visionProjectorPath) projector.value = management.visionProjectorPath;
  if (projector && !management && !projector.value) projector.value = observation?.visionProjectorPath || found?.launch?.visionProjectorPath || "";
  if (visionToggle && management) visionToggle.checked = Boolean(management.visionProjectorPath);
  if (visionToggle && !management && !visionToggle.dataset.observationApplied) {
    visionToggle.checked = Boolean(observation?.supportsVision || projector?.value);
    visionToggle.dataset.observationApplied = "true";
  }
  const projectorRow = $("local-host-vision-projector-row");
  if (projectorRow) projectorRow.hidden = !Boolean(visionToggle?.checked);
  const managedReadonly = Boolean(management);
  for (const field of [model, projector, directory]) {
    if (field) field.readOnly = managedReadonly;
  }
  if (budget) budget.disabled = managedReadonly;
  if (visionToggle) visionToggle.disabled = managedReadonly;
  for (const id of ["local-host-model-browse", "local-host-vision-browse", "local-host-kv-browse"]) {
    const browse = $(id);
    if (browse) {
      browse.hidden = !localNativeHostPicker;
      browse.disabled = managedReadonly;
    }
  }
  // Translate GiB into sessions: the default budget is deliberately small, and
  // whether it is enough depends entirely on this model's full-context state
  // size - a number the server already computed from the GGUF shape.
  const hint = $("local-host-kv-hint");
  if (hint) {
    const stateBytes = Number(found?.kvFullStateBytes) || 0;
    const budgetGiB = Number(budget?.value) || 0;
    if (stateBytes > 0 && budgetGiB > 0) {
      const stateGiB = stateBytes / 1024 ** 3;
      hint.hidden = false;
      hint.textContent = t("host.budgetHint", {
        state: `${stateGiB >= 10 ? Math.round(stateGiB) : stateGiB.toFixed(1)} GiB`,
        count: String(Math.max(0, Math.floor((budgetGiB * 1024 ** 3) / stateBytes))),
      });
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
}

async function openLocalConfig(engine) {
  localConfigEngine = engine;
  const drawer = $("local-drawer");
  if (!drawer) return;
  // Configuration buttons render before the asynchronous first discovery
  // completes. A managed host must not open as a blank editable form merely
  // because that scan is still in flight: finish the one read, then show its
  // durable paths read-only.
  if (engine === "llamacpp" && !localDiscovery.has(engine)) await renderLocalEngines();
  const found = localDiscovery.get(engine);
  if (engine === "llamacpp") {
    const model = $("local-host-model-file");
    const projector = $("local-host-vision-projector");
    const toggle = $("local-host-vision-enabled");
    if (model) model.value = "";
    if (projector) projector.value = "";
    if (toggle) {
      toggle.checked = false;
      delete toggle.dataset.observationApplied;
    }
  }
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
  renderEngineWarnings(found?.warnings);
  // Fresh suggestions on every open: the server's default directory and a
  // budget derived from what the volume can actually spare. A managed host
  // shows its stored values instead (renderLocalHostControl overwrites).
  const budgetField = $("local-host-kv-budget");
  if (budgetField && !found?.management && localKvBudgetDefaultGiB > 0) {
    budgetField.value = String(localKvBudgetDefaultGiB);
  }
  showLocalHostManageStatus("");

  const disconnect = $("local-config-disconnect");
  if (disconnect) disconnect.hidden = !localConnectedState.get(engine);
  const errorLine = $("local-config-error");
  if (errorLine) errorLine.hidden = true;
  const save = $("local-config-save");
  if (save) {
    save.dataset.mode = "connect";
    save.hidden = false;
    save.textContent = t("local.connect");
  }
  // After the defaults above: for a connected, unmanaged llama.cpp this
  // switches the bottom primary into its "Save and Manage" mode.
  renderLocalHostControl(engine, found);

  // Not modal: the row this drawer describes stays readable beside it, which
  // is the whole reason it is not the dialog it replaced.
  drawer.hidden = false;
  for (const engineId of localEngineIds) paintEngineButton(engineId);
  $("local-config-port")?.focus();
}

function closeLocalConfig() {
  const drawer = $("local-drawer");
  if (drawer) drawer.hidden = true;
  localConfigEngine = "";
  const hostControl = $("local-host-control");
  if (hostControl) hostControl.hidden = true;
  for (const engineId of localEngineIds) paintEngineButton(engineId);
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
    const observed = localDiscovery.get(engine);
    // Reusing the discovered endpoint lets Connect carry llama.cpp's live
    // /props modalities into the saved observation. A manually changed port
    // remains explicit and keeps the lightweight no-scan connect behaviour.
    const discoveredPort = Number(observed?.port) || 0;
    body = ollama
      ? { baseUrl }
      : (discoveredPort === port ? { engine } : { engine, baseUrl });
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
  // The row is a mouse convenience; the button inside it is the real control,
  // so the keyboard and assistive tech get one named, focusable target instead
  // of a div pretending to be a button around another button.
  $(`${engineId}-configure`)?.addEventListener("click", () => openLocalConfig(engineId));
  // One-click routing toggle. Connect posts with no baseUrl so the server
  // discovers the address the same way the drawer prefill does; when nothing
  // was discovered the drawer opens instead, which already carries the manual
  // port hint. Disconnect of a managed llama.cpp host is refused by the server
  // (409) and the message lands on the engine's error line.
  $(`${engineId}-connect`)?.addEventListener("click", async () => {
    const button = $(`${engineId}-connect`);
    const ollama = engineId === "ollama";
    const connected = Boolean(localConnectedState.get(engineId));
    if (!connected && !ollama && !localDiscovery.get(engineId)) {
      openLocalConfig(engineId);
      return;
    }
    if (button) button.disabled = true;
    if (!connected) localShow(engineId, t("local.connecting"), false);
    try {
      const action = connected ? "disconnect" : "connect";
      const response = await fetch(ollama ? `/api/ollama/${action}` : `/api/local/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ollama ? {} : { engine: engineId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || `${action} ${response.status}`);
      if (ollama) renderOllamaSection(payload.settings?.ollama);
      else renderLocalEngineState(engineId, payload.settings?.local?.[engineId]);
      localShow(engineId, "", false);
      await renderLocalEngines();
    } catch (error) {
      localShow(engineId, error.message, true);
    } finally {
      if (button) button.disabled = false;
      paintEngineButton(engineId);
    }
  });
  $(`${engineId}-row`)?.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    openLocalConfig(engineId);
  });
  // The request carries an engine id and nothing else: what runs is what the
  // gateway wrote down while that engine was serving.
  $(`${engineId}-restart`)?.addEventListener("click", async () => {
    const button = $(`${engineId}-restart`);
    button.disabled = true;
    localShow(engineId, t("local.restarting"), false);
    try {
      const reply = await fetch("/api/local/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine: engineId }),
      });
      const body = await reply.json();
      if (!reply.ok) throw new Error(body.error?.message || `Restart ${reply.status}`);
      // A model can take a while to load - a large one much longer than any
      // fixed wait would be honest about - so this polls until the engine
      // answers or the ceiling is reached, and says which happened.
      let up = false;
      for (let waited = 0; waited < 60_000 && !up; waited += 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await renderLocalEngines();
        up = localDiscovery.has(engineId);
      }
      localShow(engineId, up ? "" : t("local.restartSlow"), !up);
      poll().catch(() => {});
      pollConfig().catch(() => {});
    } catch (error) {
      localShow(engineId, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  paintEngineButton(engineId);
}
$("local-config-close")?.addEventListener("click", closeLocalConfig);
$("local-config-save")?.addEventListener("click", () => {
  if ($("local-config-save")?.dataset.mode === "manage") submitLocalManage().catch(() => {});
  else submitLocalConfig("connect").catch(() => {});
});
// Folding a section away. The button carries the state on aria-expanded, so
// the stylesheet turns the glyph and assistive technology reads the same fact
// from the same place rather than from a class that has to be kept in step.
for (const engineId of localEngineIds) {
  const toggle = $(`${engineId}-toggle`);
  const body = $(`${engineId}-body`);
  if (!toggle || !body) continue;
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "false";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    toggle.title = t(open ? "local.expand" : "local.collapse");
    body.hidden = open;
  });
}


$("local-config-disconnect")?.addEventListener("click", () => { submitLocalConfig("disconnect").catch(() => {}); });

// The sessions estimate must follow the number being typed, not the number
// that was there when the drawer opened.
$("local-host-kv-budget")?.addEventListener("input", () => {
  if (localConfigEngine !== "llamacpp") return;
  renderLocalHostControl("llamacpp", localDiscovery.get("llamacpp"));
});

function showLocalHostVisionProjector() {
  const enabled = Boolean($("local-host-vision-enabled")?.checked);
  const row = $("local-host-vision-projector-row");
  if (row) row.hidden = !enabled;
}

async function browseLocalHostPath(kind, inputId) {
  const button = $(kind === "model" ? "local-host-model-browse" : kind === "vision_projector" ? "local-host-vision-browse" : "local-host-kv-browse");
  if (button) button.disabled = true;
  showLocalHostManageStatus("");
  try {
    const response = await fetch("/api/local/pick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Pick ${response.status}`);
    const field = $(inputId);
    if (field && body.path) field.value = body.path;
  } catch (error) {
    showLocalHostManageStatus(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

$("local-host-vision-enabled")?.addEventListener("change", showLocalHostVisionProjector);
$("local-host-model-browse")?.addEventListener("click", () => { browseLocalHostPath("model", "local-host-model-file").catch(() => {}); });
$("local-host-vision-browse")?.addEventListener("click", () => { browseLocalHostPath("vision_projector", "local-host-vision-projector").catch(() => {}); });
$("local-host-kv-browse")?.addEventListener("click", () => { browseLocalHostPath("kv_directory", "local-host-kv-directory").catch(() => {}); });

// The takeover action lives on the drawer's bottom primary button ("Save and
// Manage") once the host is connected - the first-level Manage button already
// said what the drawer is for, so a second "Manage this host" inside it was
// the same decision asked twice.
async function submitLocalManage() {
  if (localConfigEngine !== "llamacpp") return;
  const modelPath = String($("local-host-model-file")?.value || "").trim();
  const visionEnabled = Boolean($("local-host-vision-enabled")?.checked);
  const visionProjectorPath = String($("local-host-vision-projector")?.value || "").trim();
  const directory = String($("local-host-kv-directory")?.value || "").trim();
  const budgetGiB = Number($("local-host-kv-budget")?.value || 0);
  if (!modelPath) {
    showLocalHostManageStatus(t("host.chooseModel"), true);
    return;
  }
  if (visionEnabled && !visionProjectorPath) {
    showLocalHostManageStatus(t("host.chooseVisionProjector"), true);
    return;
  }
  if (!directory) {
    showLocalHostManageStatus(t("host.chooseFolder"), true);
    return;
  }
  if (!Number.isSafeInteger(budgetGiB) || budgetGiB < 1 || budgetGiB > 1024) {
    showLocalHostManageStatus(t("host.chooseBudget"), true);
    return;
  }
  const button = $("local-config-save");
  if (button) button.disabled = true;
  showLocalHostManageStatus(t("host.verifying"));
  try {
    const response = await fetch("/api/local/manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        engine: "llamacpp",
        modelPath,
        visionProjectorPath: visionEnabled ? visionProjectorPath : "",
        cacheDirectory: directory,
        cacheBudgetGiB: budgetGiB,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Manage ${response.status}`);
    await renderLocalEngines();
    openLocalConfig("llamacpp");
    showLocalHostManageStatus(managedPlanSummary(body.management?.profile));
  } catch (error) {
    showLocalHostManageStatus(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

$("local-host-unmanage")?.addEventListener("click", async () => {
  const button = $("local-host-unmanage");
  const hostId = String(button?.dataset.hostId || "").trim();
  if (!hostId) return;
  if (button) button.disabled = true;
  showLocalHostManageStatus(t("host.releasing"));
  try {
    const response = await fetch("/api/local/unmanage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || `Unmanage ${response.status}`);
    await renderLocalEngines();
    openLocalConfig("llamacpp");
  } catch (error) {
    showLocalHostManageStatus(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});


// --- xAI (Grok) subscription sign-in ---
//
// A device grant is a person walking to a browser, so the page owns the
// waiting: one poll per tick, and closing the tab ends it. The gateway does
// not keep a loop running for a sign-in nobody is watching.
let xaiPolling = null;

function xaiShow(text, isError) {
  const status = $("xai-status");
  const error = $("xai-error");
  if (status) {
    status.hidden = !text || Boolean(isError);
    status.textContent = isError ? "" : text || "";
  }
  if (error) {
    error.hidden = !(text && isError);
    error.textContent = isError ? text : "";
  }
}

function renderXaiSection(state) {
  const connected = Boolean(state?.connected && state.models?.length);
  const signIn = $("xai-signin");
  const disconnect = $("xai-disconnect");
  if (disconnect) disconnect.hidden = !connected;
  if (signIn) signIn.textContent = t(connected ? "xai.refresh" : "xai.signIn");
  xaiShow(connected ? t("xai.connected", { count: state.models.length }) : "", false);
}

function showXaiDevice(device) {
  const box = $("xai-device");
  const link = $("xai-device-url");
  const code = $("xai-device-code");
  if (link) { link.href = device.verificationUrl; link.textContent = device.verificationUrl; }
  // The link already carries the code; the code is shown too because a user
  // reading it off one screen and typing it on another needs it visible.
  if (code) code.textContent = device.userCode || "";
  if (box) box.hidden = false;
}

function hideXaiDevice() {
  const box = $("xai-device");
  if (box) box.hidden = true;
  if (xaiPolling) { clearInterval(xaiPolling); xaiPolling = null; }
}

if ($("xai-signin")) {
  $("xai-signin").addEventListener("click", async () => {
    const button = $("xai-signin");
    button.disabled = true;
    hideXaiDevice();
    xaiShow(t("xai.starting"), false);
    try {
      const started = await fetch("/api/xai/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const device = await started.json();
      if (!started.ok) throw new Error(device.error?.message || `Sign-in ${started.status}`);
      showXaiDevice(device);
      xaiShow(t("xai.waiting"), false);
      // Opening it for them saves a copy-paste; if the browser blocks it the
      // link is on screen anyway.
      window.open(device.verificationUrl, "_blank", "noopener");
      xaiPolling = setInterval(async () => {
        try {
          const reply = await fetch("/api/xai/poll", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          const body = await reply.json();
          if (reply.ok && body.status === "pending") return;
          hideXaiDevice();
          button.disabled = false;
          if (!reply.ok) throw new Error(body.error?.message || `Sign-in ${reply.status}`);
          renderXaiSection(body.settings?.xai);
          poll().catch(() => {});
          pollConfig().catch(() => {});
          renderModelRoster().catch(() => {});
        } catch (error) {
          hideXaiDevice();
          button.disabled = false;
          xaiShow(error.message, true);
        }
      }, Math.max(Number(device.intervalMs) || 5000, 2000));
    } catch (error) {
      hideXaiDevice();
      button.disabled = false;
      xaiShow(error.message, true);
    }
  });
}

$("xai-disconnect")?.addEventListener("click", async () => {
  const button = $("xai-disconnect");
  button.disabled = true;
  try {
    const reply = await fetch("/api/xai/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await reply.json();
    if (!reply.ok) throw new Error(body.error?.message || `Disconnect ${reply.status}`);
    renderXaiSection(body.settings?.xai);
    poll().catch(() => {});
    renderModelRoster().catch(() => {});
  } catch (error) {
    xaiShow(error.message, true);
  } finally {
    button.disabled = false;
  }
});



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
    // DeepSeek moved to the API page and saves there; this button keeps the
    // providers that are still on this page.
    if (go) body.opencodeGoToken = go;
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
      renderXaiSection(lastSettings.xai);
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


// Redraw every wave from the history it already holds. Used when the dashboard
// becomes visible again, where there is nothing new to fetch - only a frame to
// put back.
function redrawWaves() {
  const paint = (id, history, peakState, hoverState, color, pointsRef) => {
    const canvas = $(id);
    if (canvas) drawWave(canvas, history, peakState.peak, hoverState.hover, color, pointsRef);
  };
  paint("context-wave", visibleContextHistory, wavePeakState, waveHoverState, WAVE_AMBER, wavePoints);
  paint("data-wave", visibleDataHistory, dataPeakState, dataHoverState, WAVE_GREEN, dataWavePoints);
  paint("tps-wave", visibleTpsHistory, tpsPeakState, tpsHoverState, WAVE_VIOLET, tpsWavePoints);
  const cache = $("cache-wave");
  if (cache) drawCacheWave(cache, visibleCacheHistory, cacheHoverState.hover);
}
// Hash routing across the left rail. Views stay mounted and are toggled with a
// class, so the SSE stream, poll timers, and every listener registered below
// survive navigation - a per-page reload would tear all of that down and
// rebuild it on every click.
const VIEWS = ["dashboard", "subscriptions", "api", "local", "models", "hostmonitor"];

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
  const view = routeToView((location.hash || "").replace(/^#/, ""));
  // The canvases could not draw while this view was hidden, so returning to
  // it has to repaint rather than wait for the next datum to arrive.
  if (view === "dashboard") redrawWaves();
  if (view === "hostmonitor" && lastData) renderLocalHostDashboard(lastData);
  return view;
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
