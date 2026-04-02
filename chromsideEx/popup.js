// popup.js
const MCP_SERVER = "http://localhost:3000";
const DEFAULT_PROVIDER = "local";
const DEFAULT_MODEL = "local-model";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful WhatsApp assistant. Reply concisely and naturally.";

let providerCatalog = {
  defaultProvider: DEFAULT_PROVIDER,
  providers: [],
};
let pendingSettings = null;

function normalizeKeywordFilterEnabled(value) {
  return value !== false;
}

function syncAutoSendDelayState() {
  const autoSend = document.getElementById("autoSend");
  const delayInput = document.getElementById("autoSendDelay");
  delayInput.disabled = !autoSend.checked;
  delayInput.style.opacity = autoSend.checked ? "1" : "0.55";
}

function syncKeywordFilterState() {
  const enabled = document.getElementById("keywordFilterEnabled").checked;
  const keywordsInput = document.getElementById("keywords");
  const keywordsHint = document.getElementById("keywordsHint");

  keywordsInput.disabled = !enabled;
  keywordsInput.style.opacity = enabled ? "1" : "0.55";
  keywordsHint.textContent = enabled
    ? "Comma-separated. Reply suggestions trigger when any keyword is detected."
    : "Keyword filter is off, so every new incoming message can trigger a reply suggestion.";
}

function setStatus(message, type = "") {
  const status = document.getElementById("status");
  status.textContent = message;
  status.className = type ? `status ${type}` : "status";
}

function normalizeProvider(provider) {
  return provider === "openrouter" ? "openrouter" : DEFAULT_PROVIDER;
}

function getProviderConfig(providerId) {
  return providerCatalog.providers.find((provider) => provider.id === providerId) || null;
}

function getProviderModels(providerId) {
  return getProviderConfig(providerId)?.models || [];
}

function chooseModelForProvider(providerId, preferredModel = "") {
  const models = getProviderModels(providerId);
  if (!models.length) return "";
  if (preferredModel && models.some((model) => model.id === preferredModel)) {
    return preferredModel;
  }
  const recommended = models.find((model) => model.recommended);
  return (recommended || models[0]).id;
}

function renderModelOptions(providerId, preferredModel = "") {
  const modelSelect = document.getElementById("model");
  const modelHint = document.getElementById("modelHint");
  const provider = getProviderConfig(providerId);
  const models = provider?.models || [];

  modelSelect.innerHTML = "";

  if (!models.length) {
    modelSelect.disabled = true;
    const option = document.createElement("option");
    option.value = "";
    option.textContent = providerId === "openrouter"
      ? "No OpenRouter models configured"
      : "No local models found";
    modelSelect.appendChild(option);
    modelHint.textContent = provider?.hint || "No models available for the selected provider.";
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label || model.id;
    modelSelect.appendChild(option);
  }

  modelSelect.disabled = false;
  modelSelect.value = chooseModelForProvider(providerId, preferredModel);
  modelHint.textContent = provider?.hint || "Pick the model to use for reply generation.";
}

function syncProviderUi(preferredModel = "") {
  const provider = normalizeProvider(document.getElementById("provider").value);
  renderModelOptions(provider, preferredModel);
}

async function checkServer() {
  const dot = document.getElementById("server-dot");
  const label = document.getElementById("server-label");
  try {
    const res = await fetch(`${MCP_SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      dot.className = "dot online";
      const data = await res.json();
      label.textContent = `Online - ${data.provider || "local"} / ${data.model || "model ready"}`;
    } else {
      throw new Error("not ok");
    }
  } catch {
    dot.className = "dot offline";
    label.textContent = "Offline - start waBridge first";
  }
}

async function loadProviderCatalog() {
  const res = await fetch(`${MCP_SERVER}/providers`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    throw new Error(`Could not load providers: ${res.status}`);
  }
  providerCatalog = await res.json();
}

function applySavedSettings(data) {
  const provider = normalizeProvider(data.provider || providerCatalog.defaultProvider || DEFAULT_PROVIDER);
  pendingSettings = null;

  document.getElementById("keywords").value = (data.keywords || ["help", "support", "info", "halo", "hai"]).join(", ");
  document.getElementById("keywordFilterEnabled").checked = normalizeKeywordFilterEnabled(data.keywordFilterEnabled);
  document.getElementById("provider").value = provider;
  document.getElementById("systemPrompt").value = data.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  document.getElementById("autoSend").checked = Boolean(data.autoSend);
  document.getElementById("autoSendDelay").value = data.autoSendDelay || 5;

  syncProviderUi(data.model || DEFAULT_MODEL);
  syncAutoSendDelayState();
  syncKeywordFilterState();
}

function loadSavedSettings() {
  chrome.storage.sync.get(["keywords", "keywordFilterEnabled", "provider", "model", "systemPrompt", "autoSend", "autoSendDelay"], (data) => {
    if (!providerCatalog.providers.length) {
      pendingSettings = data;
      return;
    }
    applySavedSettings(data);
  });
}

document.getElementById("save").addEventListener("click", () => {
  const keywordsRaw = document.getElementById("keywords").value;
  const keywords = keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean);
  const keywordFilterEnabled = document.getElementById("keywordFilterEnabled").checked;
  const provider = normalizeProvider(document.getElementById("provider").value);
  const model = document.getElementById("model").value.trim();
  const systemPrompt = document.getElementById("systemPrompt").value.trim();
  const autoSend = document.getElementById("autoSend").checked;
  const autoSendDelay = parseInt(document.getElementById("autoSendDelay").value, 10) || 5;

  chrome.storage.sync.set({ keywords, keywordFilterEnabled, provider, model, systemPrompt, autoSend, autoSendDelay }, () => {
    setStatus("Settings saved!", "ok");
    setTimeout(() => { setStatus(""); }, 2000);
  });
});

document.getElementById("autoSend").addEventListener("change", syncAutoSendDelayState);
document.getElementById("keywordFilterEnabled").addEventListener("change", syncKeywordFilterState);
document.getElementById("provider").addEventListener("change", () => {
  const selectedProvider = normalizeProvider(document.getElementById("provider").value);
  syncProviderUi(chooseModelForProvider(selectedProvider));
});

async function initPopup() {
  loadSavedSettings();
  await checkServer();

  try {
    await loadProviderCatalog();
    const defaultProvider = normalizeProvider(providerCatalog.defaultProvider || DEFAULT_PROVIDER);
    const providerSelect = document.getElementById("provider");
    providerSelect.value = getProviderConfig(providerSelect.value) ? providerSelect.value : defaultProvider;

    if (pendingSettings) {
      applySavedSettings(pendingSettings);
    } else {
      syncProviderUi(chooseModelForProvider(providerSelect.value, DEFAULT_MODEL));
    }
  } catch (error) {
    const providerSelect = document.getElementById("provider");
    providerCatalog = {
      defaultProvider: DEFAULT_PROVIDER,
      providers: [
        {
          id: "local",
          label: "Local Model",
          hint: "waBridge is offline, so the local model list could not be loaded.",
          models: [{ id: DEFAULT_MODEL, label: DEFAULT_MODEL, recommended: true }],
        },
        {
          id: "openrouter",
          label: "OpenRouter API",
          hint: "waBridge is offline, so the OpenRouter model list could not be loaded.",
          models: [],
        },
      ],
    };
    providerSelect.value = DEFAULT_PROVIDER;
    if (pendingSettings) {
      applySavedSettings(pendingSettings);
    } else {
      syncProviderUi(DEFAULT_MODEL);
    }
    setStatus(error.message, "err");
  }
}

initPopup();
