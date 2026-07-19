let state = null;

const ids = [
  "codexHome",
  "currentProvider",
  "currentModel",
  "currentReasoning",
  "presetSelect",
  "providerId",
  "providerName",
  "model",
  "reasoningEffort",
  "verbosity",
  "wireApi",
  "baseUrl",
  "envKey",
  "profileName",
  "aliasNotice",
  "providerModelStatus",
  "providerModelFilter",
  "providerModelSelect",
  "providerModelOutput",
  "testCwd",
  "testPrompt",
  "testOutput",
  "backupList",
  "configPreview",
  "toast",
  "restartNote"
];

const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let providerModels = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || response.statusText);
  return data;
}

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 5200);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function activeFormData() {
  return {
    providerId: el.providerId.value,
    providerName: el.providerName.value,
    model: el.model.value,
    reasoningEffort: el.reasoningEffort.value,
    verbosity: el.verbosity.value,
    wireApi: el.wireApi.value,
    baseUrl: el.baseUrl.value,
    envKey: el.envKey.value,
    profileName: el.profileName.value
  };
}

function isProviderAlias(data) {
  return data.providerId.trim().toLowerCase() === "openai" && Boolean(data.baseUrl.trim() || data.envKey.trim());
}

function updateAliasNotice() {
  const data = activeFormData();
  if (!isProviderAlias(data)) {
    el.aliasNotice.hidden = true;
    el.aliasNotice.textContent = "";
    return;
  }
  const label = data.providerName.trim() || "Custom provider";
  el.aliasNotice.hidden = false;
  el.aliasNotice.textContent = [
    `Provider ID is being reused as an alias: openai -> ${label}.`,
    `Apply will write [model_providers.openai] with ${data.baseUrl || "this endpoint"}; conversations may remain under openai after restart.`
  ].join(" ");
}

function setForm(preset) {
  el.providerId.value = preset.providerId || "";
  el.providerName.value = preset.providerName || preset.providerId || "";
  el.model.value = preset.model || "";
  el.reasoningEffort.value = preset.reasoningEffort || "";
  el.verbosity.value = preset.verbosity || "";
  el.wireApi.value = preset.wireApi || "";
  el.baseUrl.value = preset.baseUrl || "";
  el.envKey.value = preset.envKey || "";
  if (!el.profileName.value) el.profileName.value = preset.providerId || preset.id || "";
  clearProviderModels();
  updateAliasNotice();
}

function clearProviderModels() {
  providerModels = [];
  el.providerModelSelect.innerHTML = "";
  el.providerModelOutput.textContent = "No provider models fetched yet.";
  el.providerModelStatus.textContent = "Fetch models from this preset's Base URL.";
}

function formatModelMeta(model) {
  const bits = [];
  if (model.contextLength) bits.push(`${Number(model.contextLength).toLocaleString()} ctx`);
  if (model.promptPrice) bits.push(`in ${model.promptPrice}`);
  if (model.completionPrice) bits.push(`out ${model.completionPrice}`);
  return bits.join(" | ");
}

function renderProviderModels() {
  const needle = el.providerModelFilter.value.trim().toLowerCase();
  const selected = el.providerModelSelect.value;
  el.providerModelSelect.innerHTML = "";
  for (const model of providerModels) {
    if (needle && !model.id.toLowerCase().includes(needle) && !model.name.toLowerCase().includes(needle)) continue;
    const option = document.createElement("option");
    option.value = model.id;
    const meta = formatModelMeta(model);
    option.textContent = meta ? `${model.id} (${meta})` : model.id;
    el.providerModelSelect.append(option);
  }
  if (selected) el.providerModelSelect.value = selected;
}

async function fetchProviderModels() {
  el.providerModelStatus.textContent = "Fetching provider models...";
  el.providerModelOutput.textContent = "Fetching...";
  const result = await api("/api/provider-models", {
    method: "POST",
    body: JSON.stringify(activeFormData())
  });
  providerModels = result.models || [];
  renderProviderModels();
  el.providerModelStatus.textContent = `${result.count} models from ${result.providerId}`;
  el.providerModelOutput.textContent = JSON.stringify({
    ok: result.ok,
    providerId: result.providerId,
    baseUrl: result.baseUrl,
    count: result.count,
    sample: providerModels.slice(0, 12).map((model) => ({
      id: model.id,
      contextLength: model.contextLength,
      promptPrice: model.promptPrice,
      completionPrice: model.completionPrice
    }))
  }, null, 2);
}

function renderBackups(backups) {
  if (!backups.length) {
    el.backupList.innerHTML = "<p>No backups yet.</p>";
    return;
  }
  el.backupList.innerHTML = "";
  for (const backup of backups) {
    const item = document.createElement("div");
    item.className = "backup-item";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = backup.name;
    const meta = document.createElement("span");
    meta.textContent = `${new Date(backup.mtimeMs).toLocaleString()} · ${formatBytes(backup.size)}`;
    info.append(title, meta);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Restore";
    button.addEventListener("click", async () => {
      if (!confirm(`Restore ${backup.name}? Current config will be backed up first.`)) return;
      const result = await api("/api/restore", {
        method: "POST",
        body: JSON.stringify({ backupName: backup.name })
      });
      showToast(result.message);
      await loadStatus();
    });
    item.append(info, button);
    el.backupList.append(item);
  }
}

function renderStatus(data) {
  state = data;
  el.codexHome.textContent = data.realCodexHome || data.codexHome;
  el.currentProvider.textContent = data.current.modelProvider || "(default)";
  el.currentModel.textContent = data.current.model || "(default)";
  el.currentReasoning.textContent = data.current.reasoningEffort || "(default)";
  el.restartNote.textContent = data.restartRequiredNote;
  el.configPreview.textContent = data.configText || "";
  el.testCwd.value ||= data.realCodexHome || data.codexHome;
  updateAliasNotice();

  el.presetSelect.innerHTML = "";
  for (const preset of data.presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    el.presetSelect.append(option);
  }
  if (!el.providerId.value && data.presets[0]) setForm(data.presets[0]);
  renderBackups(data.backups || []);
}

async function loadStatus() {
  renderStatus(await api("/api/status"));
}

async function applyConfig() {
  const result = await api("/api/apply", {
    method: "POST",
    body: JSON.stringify(activeFormData())
  });
  showToast(result.message);
  await loadStatus();
}

async function saveProfile() {
  const result = await api("/api/profile", {
    method: "POST",
    body: JSON.stringify(activeFormData())
  });
  showToast(`${result.message} ${result.command}`);
  await loadStatus();
}

async function runTest(kind) {
  el.testOutput.textContent = `Running ${kind}...`;
  const result = await api("/api/test", {
    method: "POST",
    body: JSON.stringify({
      kind,
      cwd: el.testCwd.value,
      prompt: el.testPrompt.value
    })
  });
  el.testOutput.textContent = JSON.stringify(result, null, 2);
}

document.getElementById("refreshBtn").addEventListener("click", () => loadStatus().catch((error) => showToast(error.message, true)));
document.getElementById("applyBtn").addEventListener("click", () => applyConfig().catch((error) => showToast(error.message, true)));
document.getElementById("saveProfileBtn").addEventListener("click", () => saveProfile().catch((error) => showToast(error.message, true)));
document.getElementById("fetchProviderModelsBtn").addEventListener("click", () => fetchProviderModels().catch((error) => {
  el.providerModelStatus.textContent = "Provider model fetch failed.";
  el.providerModelOutput.textContent = String(error.stack || error.message || error);
  showToast(error.message, true);
}));
el.providerModelFilter.addEventListener("input", renderProviderModels);
el.providerModelSelect.addEventListener("change", () => {
  if (el.providerModelSelect.value) el.model.value = el.providerModelSelect.value;
});
["providerId", "providerName", "baseUrl", "envKey"].forEach((id) => {
  el[id].addEventListener("input", updateAliasNotice);
});
el.presetSelect.addEventListener("change", () => {
  const preset = state?.presets.find((item) => item.id === el.presetSelect.value);
  if (preset) setForm(preset);
});
document.querySelectorAll("[data-test]").forEach((button) => {
  button.addEventListener("click", () => runTest(button.dataset.test).catch((error) => {
    el.testOutput.textContent = String(error.stack || error.message || error);
    showToast(error.message, true);
  }));
});

loadStatus().catch((error) => showToast(error.message, true));
