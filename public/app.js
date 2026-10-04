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

// Every dashboard wave is the same bounded projection of completed response
// records. The projector owns only the metric-specific value; dedupe, ordering,
// retention and session identity stay here so one card cannot quietly retain a
// different request set from the others.
function appendResponseMetric(history, recent, project) {
  const seen = new Set(history.map((point) => point.id));
  for (const item of recent) {
    if (item.kind !== "responses" || item.status !== "ok" || seen.has(item.id)) continue;
    const point = project(item);
    if (!point) continue;
    history.push({
      id: item.id,
      t: item.startedAt || 0,
      session: sessionKeyOf(item),
      ...point,
    });
    seen.add(item.id);
  }
  history.sort((a, b) => a.t - b.t);
  if (history.length > WAVE_MAX_POINTS) history.splice(0, history.length - WAVE_MAX_POINTS);
  return history;
}

function shortModel(model) {
  return String(model || "—").split("@")[0];
}

function renderContextWave(recent) {
  const canvas = $("context-wave");
  if (!canvas) return;
  appendResponseMetric(waveHistory, recent, (item) => ({
    v: Number(item.inputTokens) || 0,
    firstResponseLatencyMs: Number(item.firstResponseLatencyMs) || 0,
  }));
  const visible = visiblePoints(waveHistory);
  visibleContextHistory = visible;
  const last = visible.length ? visible[visible.length - 1].v : 0;
  const lastLatency = visible.length ? visible[visible.length - 1].firstResponseLatencyMs : 0;
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
  appendResponseMetric(cacheHistory, recent, (item) => {
    const input = Number(item.inputTokens) || 0;
    if (input <= 0) return null;
    return {
      v: Math.min(1, Math.max(0, (Number(item.cachedTokens) || 0) / input)),
    };
  });
  const visible = visiblePoints(cacheHistory);
  visibleCacheHistory = visible;
  const last = visible.length ? visible[visible.length - 1].v : null;
  const avg = visible.length ? visible.reduce((sum, point) => sum + point.v, 0) / visible.length : null;
  set("cache-last", percent(last));
  set("cache-avg", percent(avg));
  set("cache-count", number(visible.length));
  drawWave(canvas, visible, 1, cacheHoverState.hover, WAVE_BLUE, cacheWavePoints);
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
  appendResponseMetric(dataHistory, recent, (item) => {
    const value = Number(item.bytesOut) || 0;
    return value > 0 ? { v: value } : null;
  });
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
  appendResponseMetric(tpsHistory, recent, (item) => {
    const output = Number(item.outputTokens) || 0;
    const latencyMs = Number(item.latencyMs) || 0;
    if (output <= 0 || latencyMs <= 0) return null;
    return {
      v: output / (latencyMs / 1000),
    };
  });
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
    const entry = map.get(key) || { id: key, model: "", lastAt: 0, lastStartedAt: 0 };
    const startedAt = Number(item.startedAt || 0);
    const at = Number(item.finishedAt || startedAt);
    // Metrics are newest-first today, but ordering is not this projection's
    // contract. Pick model and timestamp together so a later storage/order
    // change cannot make the session chip report its oldest model.
    if (!entry.model || at > entry.lastAt || (at === entry.lastAt && startedAt > entry.lastStartedAt)) {
      if (item.model) entry.model = item.model;
      entry.lastAt = at;
      entry.lastStartedAt = startedAt;
    }
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

// Money is never abbreviated. "$1.3K" throws away the only number the card
// exists to report, and an option that call sites can forget is how the summary
// card ended up shortened while its own breakdown rows were not. Sub-cent
// amounts keep four decimals so a real cost never renders as $0.00.
function usd(value) {
  const amount = Math.max(0, Number(value) || 0);
  const digits = amount > 0 && amount < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

function render(data) {
  lastData = data;
  const ready = data.ready;
  const status = $("live-status");
  status.className = `status-pill ${ready ? "ready" : "error"}`;
  status.querySelector("strong").textContent = ready ? t("status.ready") : t("status.tokenMissing");
  const currentRoute = currentRouteView(data);
  renderModelOptions(data, currentRoute);
  renderSubagent(data.subagent);
  set("uptime", "v" + (data.update?.currentVersion || "") + " " + t("status.uptime") + " " + uptime(data.uptimeMs));
  set("main-model", currentRoute.modelId);
  if (currentRoute.providerLabel) set("route-provider", currentRoute.providerLabel);
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
  const mainUpstream = data.config.mainUpstreamUrl || data.config.opencodeBaseUrl;
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
let lastCatalogRevision = null;
let lastPricingRevision = null;

function refreshCatalogConsumers({ roster = true } = {}) {
  // Stats keeps a bounded snapshot for ten minutes, but model labels and public
  // price changes invalidate it immediately. Only a catalog change also needs
  // the Models roster: pricing does not change that projection.
  statsLoadedAt = 0;
  const active = document.querySelector(".view.is-active")?.dataset.view || "";
  if (active === "models" && roster) renderModelRoster().catch(() => {});
  if (active === "stats") loadStats({ force: true }).catch(() => {});
}

function modelSignature(models) {
  const selected = models?.selected || {};
  const options = models?.options || [];
  const providers = models?.providers || [];
  const visionProviders = models?.visionProviders || providers;
  // This signature is a render cache key, so it must include every option fact
  // the render consumes. Keying only identity left a changed label, context or
  // supportsVision flag stuck in the old DOM until some unrelated field moved.
  const key = (model) => [
    model.id,
    model.provider,
    model.label,
    model.supportsVision,
    model.tierLabel,
    model.visionTier,
    model.balanceScore,
    model.contextWindow,
    model.contextSource,
    model.free,
    model.status,
  ].join("|");
  const providerKey = (provider) => [
    provider.id,
    provider.label,
    provider.tokenConfigured,
  ].join("|");
  return [
    selected.mainModel,
    selected.visionModel,
    models?.selectedProvider,
    models?.selectedVisionProvider,
    providers.map(providerKey).join("|"),
    visionProviders.map(providerKey).join("|"),
    options.map(key).join("|"),
  ].join("\u0001");
}

let lastModelData = null;
// The vision provider the user picked in the dropdown, when it differs from the
// one the server reports. Cleared once the saved selection catches up.
let visionProviderOverride = "";

function currentRouteView(data) {
  const models = data?.models || {};
  const selected = models.selected || {};
  const providers = models.providers || [];
  const modelId = data?.config?.routeModel || selected.mainModel || "";
  const option = models.options?.find((model) => model.id === modelId);
  const providerId = data?.config?.routeProvider
    || option?.provider
    || models.selectedProvider
    || "other";
  const providerLabel = data?.config?.routeProviderLabel
    || providers.find((provider) => provider.id === providerId)?.label
    || providerId;
  return {
    modelId,
    modelLabel: option?.label || modelId,
    providerId,
    providerLabel,
  };
}

function renderCurrentModel(data, route = currentRouteView(data)) {
  // The route header and this read-only model block describe the same fact and
  // therefore consume the same projection. `models.selected` remains a separate
  // configured/catalog default, not a competing definition of current traffic.
  const providerDisplay = $("main-provider-display");
  const modelDisplay = $("main-model-display-name");
  if (providerDisplay) providerDisplay.textContent = route.providerLabel;
  if (modelDisplay) modelDisplay.textContent = route.modelLabel;
  const mainModelStatic = document.querySelector(".model-static");
  if (mainModelStatic) mainModelStatic.classList.toggle("busy", modelBusy);
  if (modelDisplay) modelDisplay.classList.toggle("busy", modelBusy);
  if (providerDisplay) providerDisplay.classList.toggle("busy", modelBusy);
}

function renderModelOptions(data, currentRoute = currentRouteView(data)) {
  const models = data.models;
  if (!models?.options) return;
  lastModelData = data;
  const catalogRevision = Number(models.catalogRevision) || 0;
  const catalogChanged = lastCatalogRevision !== null && catalogRevision !== lastCatalogRevision;
  const pricingRevision = data.pricing?.revision;
  const pricingChanged = pricingRevision !== undefined && lastPricingRevision !== null && pricingRevision !== lastPricingRevision;
  if (catalogChanged || pricingChanged) {
    refreshCatalogConsumers({ roster: catalogChanged });
  }
  lastCatalogRevision = catalogRevision;
  if (pricingRevision !== undefined) lastPricingRevision = pricingRevision;
  // This must run on every status event. The selectable model set changes
  // rarely, but the latest real route can change from one request to the next.
  renderCurrentModel(data, currentRoute);
  const signature = modelSignature(models);
  if (signature === lastModelSignature) {
    // Models did not change since the last SSE event; keep the current DOM.
    // The waveform and token cards still update from their own renderers.
    return;
  }
  lastModelSignature = signature;
  const selected = models.selected || {};
  const providers = models.providers || [];
  const visionProviders = models.visionProviders || providers;
  const selectedVisionProvider = models.selectedVisionProvider || "";
  const visionProviderSelect = $("vision-provider-select");
  if (visionProviderSelect) {
    // Honour a provider the user just picked (visionProviderOverride) over the
    // one the payload reports, so re-rendering after a change does not snap the
    // dropdown back to the previously selected provider.
    const wanted = visionProviderOverride && visionProviders.some((provider) => provider.id === visionProviderOverride)
      ? visionProviderOverride
      : selectedVisionProvider;
    // An empty saved selection is None, not permission to display the first
    // paid provider. Keep the same empty option used by the model selector.
    const items = wanted ? visionProviders : [{ id: "", label: t("models.none") }, ...visionProviders];
    fillSelect(visionProviderSelect, items, {
      value: wanted,
      disabled: !visionProviders.length || modelBusy,
    });
  }
  const visionFilter = (model) => model.supportsVision && model.provider === (visionProviderSelect?.value ?? selectedVisionProvider);
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
  attachAreaWaveHover({ canvasId: "cache-wave", tooltipId: "cache-wave-tooltip", pointsRef: cacheWavePoints, hoverState: cacheHoverState, draw: (canvas, hover) => drawWave(canvas, visibleCacheHistory, 1, hover, WAVE_BLUE, cacheWavePoints), formatValue: percent });
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
$("vision-provider-select").addEventListener("change", async () => {
  // Re-render the whole vision list for the newly picked provider instead of
  // filtering the options already in the DOM: those were built for the previous
  // provider, so switching (e.g. custom -> opencode-go) found no match and left
  // the old provider's model selected. renderModelOptions reads the select's
  // current value in its filter, so a forced re-render lists the right models.
  if (!lastModelData) return;
  visionProviderOverride = $("vision-provider-select").value;
  lastModelSignature = "";
  renderModelOptions(lastModelData);
  // Choosing a provider is already a complete user choice: renderModelOptions
  // selects that provider's first available vision model. Programmatic select
  // updates do not emit a second change event, so persist the resulting model
  // here instead of showing an unsaved choice that disappears on refresh.
  await setModels();
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
  // to keep landing where provider access lives - the Cloud page, not the
  // small preferences dialog.
  const openRequested = new URLSearchParams(location.search).get("settings") === "1";
  if (openRequested || (config && !config.tokenConfigured)) {
    location.hash = "#cloud";
  }
}

// Cloud access and local engines live on full pages, so their fields have to be
// filled whether or not the preferences dialog is ever opened. Autostart is
// the only connection setting left in that dialog.
let lastSettings = null;

function renderProviderTokenFields(data) {
  // The field owns its public form key; the provider registry owns identity and
  // configured state. Never echo a stored token back into the field: the
  // placeholder reports whether one is set, and submitting an empty field leaves
  // it alone.
  for (const input of document.querySelectorAll("[data-provider-token]")) {
    const provider = (data.providers || []).find((entry) => entry.id === input.dataset.providerToken);
    input.dataset.settingsField = provider?.settingsField || "";
    input.value = "";
    input.placeholder = provider?.tokenConfigured
      ? t("settings.configured")
      : (data.tokenConfigured ? t("settings.optional") : t("settings.required"));
    const disconnect = document.querySelector(`[data-provider-disconnect="${input.dataset.providerToken}"]`);
    if (disconnect) disconnect.hidden = !provider?.tokenConfigured;
  }
}

async function loadSettings() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Settings ${response.status}`);
  renderProviderTokenFields(data);
  const status = $("settings-status");
  if (status) status.textContent = "";
  renderAutostart(data);
  renderCustomSection();
  renderXaiSection(data.xai);
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
  commandcode: {
    color: "#f4f4f4",
    image: "/assets/commandcode-favicon.svg",
  },
  local: {
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
  if (mark.image) {
    const image = document.createElement("img");
    image.src = mark.image;
    image.alt = "";
    image.decoding = "async";
    wrap.append(image);
    wrap.style.setProperty("--provider-color", mark.color);
    return wrap;
  }
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
function rosterSwitch(entry, onChanged, vision = false) {
  const cell = document.createElement("td");
  cell.className = "roster-switch-cell";
  const wrap = document.createElement("label");
  wrap.className = "roster-switch";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = vision ? Boolean(entry.supportsVision) : entry.published !== false;
  const locked = vision ? Boolean(entry.visionLocked) : Boolean(entry.locked);
  input.disabled = locked;
  const track = document.createElement("span");
  track.className = "roster-switch-track";
  track.append(document.createElement("i"));
  wrap.append(input, track);
  if (locked) {
    wrap.classList.add("locked");
    wrap.title = t("roster.switchLocked");
  } else {
    wrap.title = input.checked ? t("roster.switchOn") : t("roster.switchOff");
  }
  input.setAttribute("aria-label", `${t("roster.switchLabel")} - ${entry.label}`);
  const visionLabel = document.createElement("span");
  const syncVision = () => {
    if (!vision) return;
    visionLabel.textContent = t(input.checked ? "roster.yes" : "roster.no");
    input.setAttribute("aria-label", `Vision - ${entry.label}`);
    wrap.title = locked
      ? "Choose a different vision model first to disable this capability."
      : "Toggle direct image input. Saved across restarts and upgrades; restart Codex after changing.";
  };
  syncVision();

  input.addEventListener("change", async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      const response = await fetch(vision ? "/api/models/vision" : "/api/models/enabled", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, [vision ? "supportsVision" : "enabled"]: next }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || `Models ${response.status}`);
      if (vision) entry.supportsVision = next;
      else entry.published = next;
      wrap.title = next ? t("roster.switchOn") : t("roster.switchOff");
      // The row recedes here rather than on the next render: this handler
      // deliberately does not re-render (that would throw away the scroll
      // position of a thirty-row table), so the class has to follow the switch.
      if (!vision) cell.closest("tr")?.classList.toggle("roster-parked", !next);
      // The restart banner is driven by the same restartRequired flag this
      // route sets, so the row stays put and the page says it once at the top.
      // Re-rendering here would also throw away the scroll position on a
      // thirty-row table for a change the user can already see.
      onChanged?.();
    } catch (error) {
      input.checked = !next;
      window.alert(error.message);
    } finally {
      input.disabled = locked;
      syncVision();
    }
  });
  cell.append(wrap);
  if (vision) cell.append(" ", visionLabel);
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
  row.append(entry.visionEditable
    ? rosterSwitch(entry, onChanged, true)
    : rosterCell(t(entry.supportsVision ? "roster.yes" : "roster.no")));
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

// --- Stats: one server-bounded 30-day aggregate snapshot. ---
// No browser history is accumulated here. Entering the tab replaces at most
// thirty daily bars (or twenty-four hourly bars) and seven model rows from
// /api/stats.
let lastStats = null;
let statsLoadedAt = 0;
let statsRangeDays = 30;

// One colour per model, shared by every plot on the page. The server ranks the
// named models once per snapshot (`modelLegend`) so a model keeps the same
// colour when the range changes; a model that only surfaces inside a shorter
// window takes the next unused slot instead of borrowing somebody else's.
const STATS_MODEL_COLORS = [
  "#50b7ff", "#a78bfa", "#48d6a0", "#f7b955",
  "#ff8fa3", "#5eead4", "#f0abfc", "#fdba74",
];
const STATS_OTHER_ID = "__other__";
const STATS_OTHER_COLOR = "#5b6f7f";
const SVG_NS = "http://www.w3.org/2000/svg";

let statsColors = new Map([[STATS_OTHER_ID, STATS_OTHER_COLOR]]);
let statsNames = new Map();
let statsModelOrder = [STATS_OTHER_ID];

function statsColor(id) {
  return statsColors.get(id) || STATS_OTHER_COLOR;
}

function statsModelName(id) {
  if (id === STATS_OTHER_ID) return t("stats.other");
  const known = statsNames.get(id);
  if (known) return known;
  return entryName("", id);
}

// Both maps are rebuilt from the snapshot before anything paints, so a stale
// colour can never outlive the model list that produced it.
function buildStatsPalette(data, periodModels) {
  const colors = new Map();
  const names = new Map();
  const take = (entry) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (!id || id === STATS_OTHER_ID || colors.has(id)) return;
    colors.set(id, STATS_MODEL_COLORS[colors.size % STATS_MODEL_COLORS.length]);
    const label = String(data?.modelLabels?.[id] || "").trim();
    names.set(id, label || entryName(entry, id));
  };
  for (const id of data.modelLegend || []) take(id);
  for (const entry of periodModels || []) take(entry);
  colors.set(STATS_OTHER_ID, STATS_OTHER_COLOR);
  names.set(STATS_OTHER_ID, t("stats.other"));
  statsColors = colors;
  statsNames = names;
  statsModelOrder = [
    ...(periodModels || []).map((entry) => entry?.id).filter((id) => id && id !== STATS_OTHER_ID),
    STATS_OTHER_ID,
  ];
}

// Display name for a model row, or for a bare legend id that carries no row.
function entryName(entry, id) {
  const named = typeof entry === "string" ? "" : String(entry?.model || "");
  if (named) return named;
  // Stats ids are already the server's canonical cross-provider model id.
  // Do not parse route ownership again in the browser.
  return String(id || "");
}

// --- Stats hover layer ---
//
// Bars and slices are replaced on every render, so the tooltip payload lives in
// a WeakMap keyed by the element rather than in an attribute that would have to
// carry escaped markup. One layer serves all four plots, which is also what
// keeps a hovered model highlighted across charts that live in different cards.
const statsTipPayloads = new WeakMap();
let statsTipEl = null;
let statsTipTarget = null;
let statsFocusedModel = null;

function statsTipLayer() {
  if (statsTipEl) return statsTipEl;
  const layer = document.createElement("div");
  layer.className = "stats-tip";
  layer.hidden = true;
  document.body.append(layer);
  statsTipEl = layer;
  return layer;
}

function statsTipPlace() {
  if (!statsTipEl || !statsTipTarget || statsTipEl.hidden) return;
  const rect = statsTipTarget.getBoundingClientRect();
  const box = statsTipEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2));
  const top = rect.top - box.height - 8 < 8 ? rect.bottom + 8 : rect.top - box.height - 8;
  statsTipEl.style.left = `${Math.round(left)}px`;
  statsTipEl.style.top = `${Math.round(top)}px`;
}

function statsTipShow(target) {
  const payload = statsTipPayloads.get(target);
  const layer = statsTipLayer();
  if (!payload?.rows?.length) {
    statsTipHide();
    return;
  }
  const head = document.createElement("b");
  head.className = "stats-tip-period";
  head.textContent = payload.period;
  layer.style.setProperty("--stats-tip-accent", statsColor(payload.modelId));
  const who = document.createElement("span");
  who.className = "stats-tip-model";
  const dot = document.createElement("i");
  dot.style.background = statsColor(payload.modelId);
  const name = document.createElement("em");
  name.textContent = statsModelName(payload.modelId);
  who.append(dot, name);
  const lines = payload.rows.map((row) => {
    const line = document.createElement("span");
    line.className = "stats-tip-row";
    const label = document.createElement("em");
    label.textContent = row.label;
    const value = document.createElement("strong");
    value.textContent = row.value;
    line.append(label, value);
    return line;
  });
  layer.replaceChildren(head, who, ...lines);
  layer.hidden = false;
  statsTipTarget = target;
  statsTipPlace();
}

function statsTipHide() {
  statsTipTarget = null;
  if (statsTipEl) statsTipEl.hidden = true;
}

// Dim every other model, in every plot, while one is being pointed at.
function statsFocusModel(id) {
  if (statsFocusedModel === id) return;
  statsFocusedModel = id;
  for (const node of document.querySelectorAll("[data-stats-model]")) {
    node.classList.toggle("is-mute", Boolean(id) && node.dataset.statsModel !== id);
  }
}

document.addEventListener("pointerover", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-stats-tip]") : null;
  if (!target) return;
  statsTipShow(target);
  statsFocusModel(target.dataset.statsModel || null);
});
document.addEventListener("pointerout", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-stats-tip]") : null;
  if (!target) return;
  if (event.relatedTarget instanceof Element && target.contains(event.relatedTarget)) return;
  statsTipHide();
  statsFocusModel(null);
});
window.addEventListener("scroll", statsTipPlace, true);
window.addEventListener("resize", statsTipHide);
// Leaving the tab hides the charts but not the layer they anchored to.
window.addEventListener("hashchange", () => {
  statsTipHide();
  statsFocusModel(null);
});

function statsDayLabel(day) {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat(getLang(), { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function statsHourLabel(hour) {
  return new Intl.DateTimeFormat(getLang(), {
    month: "short", day: "numeric", hour: "2-digit", hourCycle: "h23", timeZone: "UTC",
  }).format(new Date(hour));
}

function statsEmpty(host) {
  const empty = document.createElement("p");
  empty.className = "stats-empty";
  empty.textContent = t("stats.noData");
  host.replaceChildren(empty);
}

// Stacked-by-model bars. Every plot on the page answers a different question
// about the same traffic - tokens, requests, money - so all three are split by
// the same model colours and read top-to-bottom in the same order.
function statsSegmentIds(byModel) {
  const ordered = [];
  const seen = new Set();
  for (const id of [...statsModelOrder, ...Object.keys(byModel)]) {
    if (seen.has(id) || !byModel[id]) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function statsBucketSegments(bucket, kind) {
  const byModel = bucket.byModel || {};
  const segments = [];
  for (const id of statsSegmentIds(byModel)) {
    const row = byModel[id];
    const tokens = row.newInput + row.cached + row.output;
    const value = kind === "tokens" ? tokens : kind === "requests" ? row.requests : row.cost;
    if (!(value > 0)) continue;
    const money = usd(row.cost);
    const rows = kind === "requests"
      ? [
        { label: t("stats.requestVolume"), value: number(row.requests) },
        { label: t("stats.tokenFlow"), value: number(tokens) },
        { label: t("stats.apiSpend"), value: money },
      ]
      : kind === "spend"
        ? [
          { label: t("stats.apiSpend"), value: money },
          { label: t("stats.tokenFlow"), value: number(tokens) },
          { label: t("stats.requestVolume"), value: number(row.requests) },
        ]
        : [
          { label: t("stats.newInput"), value: number(row.newInput) },
          { label: t("stats.cachedInput"), value: number(row.cached) },
          { label: t("stats.output"), value: number(row.output) },
          { label: t("stats.requestVolume"), value: number(row.requests) },
          { label: t("stats.apiSpend"), value: money },
        ];
    segments.push({ id, value, rows });
  }
  // A quiet bucket still needs a nub on the baseline, or the axis reads as a gap
  // in the series rather than a period with no traffic. It is deliberately not
  // painted in the Other colour: that would claim traffic the tail never had.
  if (!segments.length) segments.push({ id: "", value: 1, rows: [] });
  return segments;
}

function renderDailyStats(hostId, days, {
  valueFor, kind, labelFor = (day) => statsDayLabel(day.day), renderZero = false,
} = {}) {
  const host = $(hostId);
  if (!host) return;
  const values = days.map((day) => Math.max(0, Number(valueFor(day)) || 0));
  const max = Math.max(0, ...values);
  if (!max && !renderZero) return statsEmpty(host);

  const plot = document.createElement("div");
  plot.className = "stats-daily-bars";
  plot.dataset.days = String(days.length);
  plot.style.gridTemplateColumns = days.length === 1
    ? "minmax(18px, 38px)"
    : `repeat(${days.length}, minmax(3px, 1fr))`;
  days.forEach((day, index) => {
    const holder = document.createElement("span");
    holder.className = "stats-day";
    const period = labelFor(day);
    holder.setAttribute("aria-label", `${period}: ${number(values[index])}`);
    const height = max > 0 ? Math.max(2, (values[index] / max) * 100) : 2;
    const stack = document.createElement("span");
    stack.className = "stats-stack";
    stack.style.height = `${height}%`;
    for (const segment of statsBucketSegments(day, kind)) {
      const part = document.createElement("i");
      part.className = "stats-segment";
      part.style.flexGrow = String(segment.value);
      part.style.background = segment.id ? statsColor(segment.id) : "rgba(137,160,175,.22)";
      if (segment.id) part.dataset.statsModel = segment.id;
      if (segment.rows.length) {
        part.dataset.statsTip = "1";
        statsTipPayloads.set(part, { period, modelId: segment.id, rows: segment.rows });
      }
      stack.append(part);
    }
    holder.append(stack);
    plot.append(holder);
  });
  const axis = document.createElement("div");
  axis.className = "stats-axis";
  const first = document.createElement("span");
  first.textContent = labelFor(days[0]);
  const last = document.createElement("span");
  last.textContent = labelFor(days.at(-1));
  axis.append(first, last);
  host.replaceChildren(plot, axis);
}

// Annular sector, not a dashed circle: a real path is what makes each slice its
// own hover target, and a hairline stop short of full turn keeps a single-model
// period from collapsing into an arc that starts and ends on the same pixel.
function statsDonutArc(cx, cy, outer, inner, start, end) {
  const point = (radius, angle) => [
    (cx + radius * Math.cos(angle)).toFixed(2),
    (cy + radius * Math.sin(angle)).toFixed(2),
  ];
  const sweep = Math.min(end - start, Math.PI * 2 - 0.002);
  const stop = start + sweep;
  const large = sweep > Math.PI ? 1 : 0;
  return [
    "M", ...point(outer, start),
    "A", outer, outer, 0, large, 1, ...point(outer, stop),
    "L", ...point(inner, stop),
    "A", inner, inner, 0, large, 0, ...point(inner, start),
    "Z",
  ].join(" ");
}

function renderModelShare(models = [], modelCount = 0, periodLabel = "") {
  const host = $("stats-model-chart");
  if (!host) return;
  const used = models.filter((entry) => Number(entry.totalTokens) > 0);
  set("stats-model-count", t("stats.modelCount", { count: number(modelCount) }));
  if (!used.length) return statsEmpty(host);
  const total = used.reduce((sum, entry) => sum + (Number(entry.totalTokens) || 0), 0) || 1;

  const wrap = document.createElement("div");
  wrap.className = "stats-donut-wrap";
  const donut = document.createElement("div");
  donut.className = "stats-donut";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 150 150");
  svg.setAttribute("role", "img");
  const centerPct = document.createElement("b");
  const centerName = document.createElement("span");
  const showCenter = (entry, share) => {
    centerPct.textContent = percent(share);
    centerName.textContent = statsModelName(entry.id);
    centerName.title = entry.id;
  };
  const restoreCenter = () => showCenter(used[0], (Number(used[0].totalTokens) || 0) / total);

  let angle = -Math.PI / 2;
  const tips = new Map();
  for (const entry of used) {
    const share = (Number(entry.totalTokens) || 0) / total;
    const tip = {
      period: periodLabel,
      modelId: entry.id,
      rows: [
        { label: t("stats.tokenFlow"), value: `${number(entry.totalTokens)} (${percent(share)})` },
        { label: t("stats.newInput"), value: number(entry.newInputTokens) },
        { label: t("stats.cachedInput"), value: number(entry.cachedTokens) },
        { label: t("stats.output"), value: number(entry.outputTokens) },
        { label: t("stats.requestVolume"), value: number(entry.completedRequests) },
        { label: t("stats.apiSpend"), value: usd(entry.estimatedApiCostUsd) },
      ],
    };
    tips.set(entry.id, tip);
    const slice = document.createElementNS(SVG_NS, "path");
    slice.setAttribute("d", statsDonutArc(75, 75, 72, 49, angle, angle + share * Math.PI * 2));
    slice.setAttribute("fill", statsColor(entry.id));
    slice.classList.add("stats-slice");
    slice.dataset.statsModel = entry.id;
    slice.dataset.statsTip = "1";
    statsTipPayloads.set(slice, tip);
    slice.addEventListener("pointerenter", () => showCenter(entry, share));
    slice.addEventListener("pointerleave", restoreCenter);
    svg.append(slice);
    angle += share * Math.PI * 2;
  }
  restoreCenter();
  const center = document.createElement("div");
  center.className = "stats-donut-center";
  center.append(centerPct, centerName);
  donut.append(svg, center);

  // The rows are the legend for every coloured plot on the page, which is why
  // hovering one dims the other models in the bars as well as in the ring.
  const legend = document.createElement("div");
  legend.className = "stats-donut-legend";
  for (const entry of used) {
    const row = document.createElement("div");
    row.className = "stats-share-row stats-legend-row";
    row.dataset.statsModel = entry.id;
    row.dataset.statsTip = "1";
    statsTipPayloads.set(row, tips.get(entry.id));
    const dot = document.createElement("i");
    dot.className = "stats-dot";
    dot.style.background = statsColor(entry.id);
    const name = document.createElement("span");
    name.className = "stats-share-name";
    name.textContent = statsModelName(entry.id);
    name.title = entry.id;
    const value = document.createElement("strong");
    value.className = "stats-share-value";
    const tokens = document.createElement("span");
    tokens.textContent = number(entry.totalTokens);
    const cost = document.createElement("small");
    cost.textContent = usd(entry.estimatedApiCostUsd);
    value.append(tokens, cost);
    row.append(dot, name, value);
    legend.append(row);
  }
  wrap.append(donut, legend);
  host.replaceChildren(wrap);
}

function paintStatsRange() {
  for (const node of document.querySelectorAll("[data-stats-window]")) node.textContent = `${statsRangeDays}D`;
  for (const button of document.querySelectorAll("[data-stats-range]")) {
    const active = Number(button.dataset.statsRange) === statsRangeDays;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderStats(data) {
  if (!data) return;
  lastStats = data;
  const periodKey = statsRangeDays === 1 ? "hours24" : statsRangeDays === 7 ? "days7" : "days30";
  const period = data.periods?.[periodKey] || {};
  set("stats-input", number(period.inputTokens));
  set("stats-output", number(period.outputTokens));
  set("stats-cache", percent(period.cacheRate || 0));
  set("stats-cache-detail", t("stats.cachedDetail", { tokens: number(period.cachedTokens), rate: percent(period.cacheRate || 0) }));
  set("stats-cost", usd(period.estimatedApiCostUsd));
  set("stats-cost-detail", t("stats.costDetail", { coverage: percent(period.costCoverage || 0) }));
  paintStatsRange();
  const updated = Date.parse(data.updatedAt || "");
  set("stats-updated", Number.isFinite(updated)
    ? t("stats.updated", { time: new Intl.DateTimeFormat(getLang(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(updated)) })
    : t("stats.notUpdated"));

  const hourly = statsRangeDays === 1;
  // The server builds one complete projection per range: aggregate, model
  // ranking and buckets all share the same legend. Resolve that projection
  // once; every plot below consumes these exact arrays.
  const days = [...(data.series?.[periodKey] || [])];
  const labelFor = hourly ? (entry) => statsHourLabel(entry.hour) : (entry) => statsDayLabel(entry.day);
  const modelPeriod = data.modelPeriods?.[periodKey] || { models: [], modelCount: 0 };
  const periodModels = modelPeriod.models || [];
  buildStatsPalette(data, periodModels);
  // The snapshot replaces every node the hover layer can point at.
  statsTipHide();
  statsFocusModel(null);
  renderDailyStats("stats-token-chart", days, {
    valueFor: (day) => day.totalTokens,
    kind: "tokens",
    labelFor,
  });
  renderDailyStats("stats-request-chart", days, {
    valueFor: (day) => day.completedRequests,
    kind: "requests",
    labelFor,
  });
  renderDailyStats("stats-spend-chart", days, {
    valueFor: (day) => day.estimatedApiCostUsd,
    kind: "spend",
    labelFor,
    renderZero: true,
  });
  renderModelShare(periodModels, modelPeriod.modelCount || 0, `${statsRangeDays}D`);
  const error = $("stats-error");
  if (error) error.hidden = true;
}

async function loadStats({ force = false } = {}) {
  if (!force && lastStats && Date.now() - statsLoadedAt < 10 * 60_000) {
    renderStats(lastStats);
    return;
  }
  const error = $("stats-error");
  try {
    const response = await fetch("/api/stats", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Stats ${response.status}`);
    statsLoadedAt = Date.now();
    renderStats(data);
  } catch (reason) {
    if (error) {
      error.textContent = reason.message;
      error.hidden = false;
    }
  }
}

document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-stats-range]") : null;
  if (!button) return;
  const next = Number(button.dataset.statsRange);
  if (![1, 7, 30].includes(next) || next === statsRangeDays) return;
  statsRangeDays = next;
  paintStatsRange();
  if (lastStats) renderStats(lastStats);
});
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

// Warnings travel with the live row that produced them. They used to live in a
// drawer the unified view no longer has, and a warning nobody can see is the
// same as no warning: an on-and-ineffective setting would be silently accepted.
function appendWarnings(item, warnings) {
  const list = Array.isArray(warnings) ? warnings : [];
  if (!list.length) return;
  const box = document.createElement("ul");
  box.className = "engine-warnings";
  for (const warning of list) {
    const line = document.createElement("li");
    line.textContent = warningText(warning.code);
    box.append(line);
  }
  item.append(box);
}

// Two origins are the same endpoint even when one carries the /v1 tree and the
// other does not, so a live row suppresses a saved registration for the address
// it already shows. Identity here is the protocol, host and port - never the
// path, which discovery does not promise and the user never typed.
function localOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return String(value || "").trim().replace(/\/+$/, "").toLowerCase();
  }
}

// --- Local Hosts: one scan list, one attach dialog ---
//
// Everything listening on this machine is one list. Selecting a row reveals its
// one inline action: Connect for a discovered origin, Disconnect for one
// ModelDock already holds. There is no second place an engine is configured.
//
// A keyless origin still needs a name for Codex to route by, so Connect probes
// first and opens a naming dialog only when the probe answered. A probe that
// failed leaves one generic line on the row and opens nothing - a form that
// cannot save is worse than no form at all. The scan itself never writes.
//
// The last outcome for an address is kept by origin, because a scan that lands
// after the user clicked must not erase what the click said. It is re-applied to
// the row the list shows now, and to whatever a later scan rebuilds.
const localRowMessages = new Map();

function localRowMessage(baseUrl) {
  return localRowMessages.get(localOrigin(baseUrl)) || "";
}

function setLocalRowState(baseUrl, text) {
  const origin = localOrigin(baseUrl);
  if (text) localRowMessages.set(origin, text);
  else localRowMessages.delete(origin);
  const list = $("local-engine-list");
  const row = list ? [...list.children].find((item) => item.dataset.origin === origin) : null;
  const stateLine = row?.querySelector(".local-engine-state");
  // Clearing restores the state the row was built with, so a cancelled dialog
  // never leaves "Connecting..." behind.
  if (stateLine) stateLine.textContent = text || row.localTarget?.state || "";
}

function localRow({ label, baseUrl, models, state, mode, engine, modelId }) {
  const item = document.createElement("li");
  item.className = "local-engine";
  item.tabIndex = 0;
  item.dataset.origin = localOrigin(baseUrl);
  const origin = item.dataset.origin;
  const head = document.createElement("div");
  head.className = "local-engine-head";
  const name = document.createElement("strong");
  name.textContent = label;
  const where = document.createElement("span");
  where.className = "local-engine-base";
  where.textContent = baseUrl || "";
  head.append(name, where);
  item.append(head);
  const modelsLine = document.createElement("p");
  modelsLine.className = "local-engine-models";
  modelsLine.textContent = models?.length ? models.join(", ") : t("local.noModels");
  item.append(modelsLine);
  const stateLine = document.createElement("p");
  stateLine.className = "local-engine-state";
  stateLine.textContent = localRowMessages.get(origin) || state || "";
  item.append(stateLine);
  // The row's identity for the action it reveals. It is kept beside the element
  // rather than read back out of the DOM: the address on screen is a label, and
  // the value a request needs must not be reconstructed from one.
  item.localTarget = { mode, label, baseUrl: baseUrl || "", engine, modelId, state: state || "" };
  item.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    selectLocalRow(item);
  });
  item.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("button")) return;
    event.preventDefault();
    selectLocalRow(item);
  });
  return item;
}

function selectLocalRow(item) {
  const list = $("local-engine-list");
  const reselected = item.classList.contains("is-selected");
  for (const other of list ? [...list.children] : []) {
    other.classList.remove("is-selected");
    other.querySelector(".local-engine-actions")?.remove();
  }
  if (reselected) return;
  item.classList.add("is-selected");
  item.append(localRowAction(item));
}

function localRowAction(item) {
  const target = item.localTarget || {};
  const actions = document.createElement("div");
  actions.className = "custom-row local-engine-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "custom-action";
  if (target.mode === "connect") {
    button.classList.add("primary");
    button.textContent = t("local.connectBtn");
    button.addEventListener("click", () => { connectLocalEndpoint(target, item, button).catch(() => {}); });
  } else {
    button.textContent = t("local.disconnect");
    button.addEventListener("click", () => { disconnectLocalEndpoint(target, item, button).catch(() => {}); });
  }
  actions.append(button);
  return actions;
}

async function connectLocalEndpoint(target, item, button) {
  button.disabled = true;
  setLocalRowState(target.baseUrl, t("local.connecting"));
  let opened = false;
  try {
    const reply = await fetch("/api/local/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: target.baseUrl }),
    });
    const payload = await reply.json().catch(() => ({}));
    if (!reply.ok) throw new Error("probe");
    openLocalConnectDialog(target, payload);
    opened = true;
  } catch {
    // One generic line, and never a reason: a probe can fail for a hundred
    // provider-specific causes and naming them was never the useful part.
    setLocalRowState(target.baseUrl, t("local.connectFailed"));
  } finally {
    button.disabled = false;
    if (opened) setLocalRowState(target.baseUrl, "");
  }
}

async function disconnectLocalEndpoint(target, item, button) {
  button.disabled = true;
  const stateLine = item.querySelector(".local-engine-state");
  try {
    const reply = await fetch("/api/custom/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: target.modelId, local: true }),
    });
    const payload = await reply.json().catch(() => ({}));
    if (!reply.ok) throw new Error(payload.error?.message || `Disconnect ${reply.status}`);
    poll().catch(() => {});
    pollConfig().catch(() => {});
    renderCustomSection();
    renderModelRoster().catch(() => {});
    await renderLocalEngines();
  } catch (error) {
    if (stateLine) stateLine.textContent = error.message;
    button.disabled = false;
  }
}

let localConnectOrigin = "";
let localConnectModels = [];

// A routing name has to survive into a model id, so the suggestion is the engine
// label reduced to slug characters - never a translated string. It is a starting
// point the user edits, not a value anything reads back.
function localNameSuggestion(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
}

function openLocalConnectDialog(target, probe) {
  const dialog = $("local-connect-dialog");
  if (!dialog) return;
  localConnectOrigin = target.baseUrl;
  localConnectModels = (probe?.models || [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.id))
    .filter((id) => Boolean(id));
  const source = $("local-connect-source");
  if (source) source.textContent = target.baseUrl || "";
  const field = $("local-connect-upstream-field");
  const select = $("local-connect-upstream");
  if (select) {
    select.replaceChildren();
    for (const id of localConnectModels) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      select.append(option);
    }
  }
  // The picker appears only when there is a choice to make. One model is the
  // model, and a select with a single option is a field that only looks like one.
  if (field) field.hidden = localConnectModels.length <= 1;
  const provider = $("local-connect-provider");
  const model = $("local-connect-model");
  if (provider) provider.value = localNameSuggestion(target.label);
  if (model) model.value = localNameSuggestion(localConnectModels[0]);
  if (select) select.onchange = () => { if (model) model.value = localNameSuggestion(select.value); };
  const errorLine = $("local-connect-error");
  if (errorLine) {
    errorLine.hidden = true;
    errorLine.textContent = "";
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  provider?.focus();
  provider?.select();
}

function closeLocalConnectDialog() {
  const dialog = $("local-connect-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  localConnectOrigin = "";
  localConnectModels = [];
}

async function saveLocalConnect() {
  const provider = $("local-connect-provider");
  const model = $("local-connect-model");
  const select = $("local-connect-upstream");
  const errorLine = $("local-connect-error");
  const save = $("local-connect-save");
  const showError = (text) => {
    if (errorLine) {
      errorLine.hidden = !text;
      errorLine.textContent = text || "";
    }
  };
  showError("");
  const providerName = String(provider?.value || "").trim();
  const modelName = String(model?.value || "").trim();
  if (!providerName || !modelName) {
    showError(t("local.errNames"));
    return;
  }
  // The wire id and the published names are two facts. The picker owns the
  // upstream id; the two inputs above own what Codex routes by.
  const upstreamId = (select?.value || "") || localConnectModels[0] || "";
  if (save) save.disabled = true;
  try {
    const reply = await fetch("/api/local/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: localConnectOrigin, upstreamId, providerName, modelName }),
    });
    const payload = await reply.json().catch(() => ({}));
    if (!reply.ok) throw new Error(payload.error?.message || t("local.attachFailed"));
    closeLocalConnectDialog();
    poll().catch(() => {});
    pollConfig().catch(() => {});
    renderCustomSection();
    renderModelRoster().catch(() => {});
    renderLocalEngines().catch(() => {});
  } catch (error) {
    showError(error.message);
  } finally {
    if (save) save.disabled = false;
  }
}

$("local-connect-close")?.addEventListener("click", closeLocalConnectDialog);
$("local-connect-cancel")?.addEventListener("click", closeLocalConnectDialog);
$("local-connect-save")?.addEventListener("click", () => { saveLocalConnect().catch(() => {}); });

async function renderLocalEngines() {
  const list = $("local-engine-list");
  const note = $("local-discovery-note");
  if (!list) return [];
  if (note) note.textContent = t("local.scanning");
  try {
    const response = await fetch("/api/local/discover", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Discover ${response.status}`);
    const engines = data.engines || [];
    const registrations = data.registrations || [];
    // Each saved model keeps its own Disconnect control. Several models may
    // share one origin, so a map to one registration would hide all but the
    // last and leave the hidden routes impossible to disconnect here.
    const savedByOrigin = new Map();
    for (const registration of registrations) {
      const origin = localOrigin(registration.baseUrl);
      if (!savedByOrigin.has(origin)) savedByOrigin.set(origin, []);
      savedByOrigin.get(origin).push(registration);
    }
    const rendered = new Set();
    // Built off-document and swapped in at the end: a refresh must never leave a
    // window where the list is empty, because the row is the control.
    const rows = document.createDocumentFragment();
    for (const engine of engines) {
      const saved = engine.offline ? null : savedByOrigin.get(localOrigin(engine.baseUrl));
      if (saved?.length) {
        for (const registration of saved) {
          rendered.add(registration.modelId);
          rows.append(localRegistrationRow(registration));
        }
      } else {
        rows.append(localEngineRow(engine));
      }
    }
    // A saved origin that is not answering any more stays in the same list, so
    // there is exactly one place a local endpoint lives.
    for (const registration of registrations) {
      if (rendered.has(registration.modelId)) continue;
      rows.append(localRegistrationRow(registration));
    }
    list.replaceChildren(rows);
    if (note) note.textContent = list.children.length ? "" : t("local.none");
    return engines;
  } catch (error) {
    if (note) note.textContent = error.message;
    return [];
  }
}

function localEngineRow(engine) {
  const item = localRow({
    label: engine.label || engine.engine,
    baseUrl: engine.baseUrl,
    models: engine.models,
    state: t("local.routeAvailable"),
    mode: "connect",
    engine: engine.engine,
  });
  appendWarnings(item, engine.warnings);
  return item;
}

// A saved local endpoint ModelDock already holds. It is the same list, offline,
// with the one control that removes it.
function localRegistrationRow(registration) {
  const item = localRow({
    label: registration.label || registration.modelId || registration.baseUrl,
    baseUrl: registration.baseUrl,
    models: registration.upstreamId ? [registration.upstreamId] : [],
    state: registration.offline ? t("local.routeOffline") : t("local.routeConnected"),
    mode: "registration",
    modelId: registration.modelId,
  });
  item.classList.add("is-connected");
  if (registration.offline) item.classList.add("is-offline");
  return item;
}

// Rescan discovers and nothing else. Connecting is the dialog's job, which is
// what gives an undiscovered origin a way in at all: there is no state where the
// user is left with a button that can only report failure. It also forgets the
// previous attempts, which is what a rescan is for.
$("local-rescan")?.addEventListener("click", () => {
  localRowMessages.clear();
  renderLocalEngines().catch(() => {});
});
// --- Configured endpoints (API page) ---
//
// One record per model rather than one slot: a self-hosted API alongside a
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
  const errors = [];
  customShow("", false);
  try {
    try {
      await saveCustomEndpointDraft();
    } catch (error) {
      errors.push(error);
    }
    // A user-set endpoint keeps its own key, so each changed one is its own
    // write rather than a single payload the server would have to unpick.
    for (const field of document.querySelectorAll("#endpoint-list .field")) {
      const key = field.querySelector(".endpoint-key");
      const value = key?.value.trim();
      if (!value) continue;
      try {
        const reply = await fetch("/api/custom/key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelId: field.dataset.modelId,
            apiKey: value,
          }),
        });
        const body = await reply.json();
        if (!reply.ok) throw new Error(body.error?.message || `Save ${reply.status}`);
        key.value = "";
      } catch (error) {
        errors.push(error);
      }
    }
    await renderEndpointList();
    poll().catch(() => {});
    pollConfig().catch(() => {});
    renderModelRoster().catch(() => {});
    if (status) status.textContent = errors[0]?.message || t("settings.saved");
  } finally {
    button.disabled = false;
  }
});

function endpointField(endpoint) {
  const field = document.createElement("label");
  field.className = "field";
  field.dataset.modelId = endpoint.modelId;

  const head = document.createElement("div");
  head.className = "field-head";
  const name = document.createElement("span");
  name.textContent = `custom / ${endpoint.modelId}`;
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
        body: JSON.stringify({ modelId: endpoint.modelId }),
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
const customStatus = $("custom-status");
const customError = $("custom-error");
const customEndpointHint = $("custom-endpoint-hint");
let customDraftInitialized = false;

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

// Lightweight mirror of the server's normalizeBaseUrl: saving first probes
// Responses, then Chat Completions when the endpoint is Chat-only.
function customProbeTargetsPreview(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return "";
  const base = /\/v1$/i.test(value) ? value : `${value}/v1`;
  return `${base}/responses or ${base}/chat/completions`;
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

function clearCustomDraft() {
  if (!customEndpointInput || !customApiKeyInput) return;
  customEndpointInput.value = "";
  customApiKeyInput.value = "";
  invalidateCustomModelList();
  if (customAsVision) customAsVision.checked = false;
  customShowHint("");
  customShow("", false);
}

function invalidateCustomModelList() {
  if (!customModelSelect) return;
  fillSelect(customModelSelect, [], { placeholder: false, disabled: true });
}

function renderCustomSection() {
  if (!customEndpointInput || !customApiKeyInput) return;
  // Configured endpoints have their own canonical rows above this composer.
  // Rehydrating one of them into the add form created a second editable copy
  // and made Save re-add an endpoint the user had already persisted.
  if (!customDraftInitialized) {
    clearCustomDraft();
    customDraftInitialized = true;
  }
  customApiKeyInput.placeholder = "sk-...";
}

if (customEndpointInput) {
  customEndpointInput.addEventListener("input", () => {
    invalidateCustomModelList();
    customShowHint(customProbeTargetsPreview(customEndpointInput.value));
  });
}

async function saveCustomEndpointDraft() {
  const baseUrl = customEndpointInput?.value.trim() || "";
  const apiKey = customApiKeyInput?.value.trim() || "";
  const modelId = customModelSelect?.value || "";
  const engaged = Boolean(baseUrl || apiKey || modelId || customAsVision?.checked);
  if (!engaged) return false;
  if (!baseUrl) {
    throw new Error(t("custom.errEndpointRequired"));
  }
  if (!modelId) {
    throw new Error(t("custom.errModelRequired"));
  }
  if (!apiKey) {
    throw new Error(t("custom.errKeyRequired"));
  }

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
    const error = Object.assign(new Error(body.error?.message || "Save failed"), { code: body.error?.type });
    error.message = customErrorText(error.code) || error.message;
    throw error;
  }
  clearCustomDraft();
  return true;
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
        invalidateCustomModelList();
        customShowHint(customProbeTargetsPreview(customEndpointInput.value));
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
    invalidateCustomModelList();
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
      // Surface the exact protocol order Save will probe (server-normalized).
      customShowHint(
        body.responsesUrl && body.chatUrl
          ? `${body.responsesUrl} or ${body.chatUrl}`
          : customProbeTargetsPreview(baseUrl),
      );
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
    for (const input of document.querySelectorAll("[data-provider-token][data-settings-field]")) {
      const value = input.value.trim();
      if (value) body[input.dataset.settingsField] = value;
    }
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
    // Cloud is a persistent page, not the old modal this save handler predates.
    // Apply the authoritative response immediately so a newly stored provider
    // does not keep displaying the stale "optional" placeholder until reload.
    renderProviderTokenFields(data);
    lastSettings = data;
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
for (const button of document.querySelectorAll("[data-provider-disconnect]")) {
  button.addEventListener("click", async () => {
    const provider = button.dataset.providerDisconnect;
    button.disabled = true;
    const status = $("settings-status");
    if (status) status.textContent = t("settings.saving");
    try {
      const response = await fetch("/api/providers/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || `Disconnect ${response.status}`);
      renderProviderTokenFields(data.settings);
      lastSettings = data.settings;
      if (status) status.textContent = t("settings.saved");
      poll().catch(() => {});
      pollConfig().catch(() => {});
      renderModelRoster().catch(() => {});
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
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
    () => { if (lastStats) renderStats(lastStats); },
    () => renderLocalEngines().catch(() => {}),
    () => {
      if (!lastSettings) return;
      renderCustomSection();
      renderXaiSection(lastSettings.xai);
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
  if (cache) drawWave(cache, visibleCacheHistory, 1, cacheHoverState.hover, WAVE_BLUE, cacheWavePoints);
}
// Hash routing across the left rail. Views stay mounted and are toggled with a
// class, so the SSE stream, poll timers, and every listener registered below
// survive navigation - a per-page reload would tear all of that down and
// rebuild it on every click.
const VIEWS = ["dashboard", "cloud", "local", "stats", "models"];
const LEGACY_VIEWS = { subscriptions: "cloud", api: "cloud" };

function routeToView(name) {
  const requested = LEGACY_VIEWS[name] || name;
  const view = VIEWS.includes(requested) ? requested : VIEWS[0];
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
  if (view === "stats") loadStats().catch(() => {});
  if (view === "models") renderModelRoster().catch(() => {});
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
