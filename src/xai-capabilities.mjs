import { readXaiAuth } from "./xai-auth.mjs";

const XAI_VIDEO_MODELS = new Set(["grok-imagine-video", "grok-imagine-video-1.5"]);

export function xaiSessionToken(config = {}) {
  return config.tokens?.xai || readXaiAuth(config.xaiAuthFile)?.accessToken || "";
}

export function xaiModels(config = {}) {
  return readXaiAuth(config.xaiAuthFile)?.models || [];
}

export function xaiVideoModel(config = {}, requested = "") {
  const model = String(requested || "").trim();
  if (model && !XAI_VIDEO_MODELS.has(model)) return "";
  const models = xaiModels(config);
  if (!models.length) return model || "grok-imagine-video-1.5";
  if (model) return models.includes(model) ? model : "";
  if (models.includes("grok-imagine-video-1.5")) return "grok-imagine-video-1.5";
  return models.includes("grok-imagine-video") ? "grok-imagine-video" : "";
}

export function xaiGenerationCapabilities(config = {}) {
  const connected = Boolean(xaiSessionToken(config));
  const models = xaiModels(config);
  return {
    connected,
    image: connected && (!models.length || models.includes("grok-4.6")),
    video: connected && Boolean(xaiVideoModel(config)),
  };
}
