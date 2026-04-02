// content.js — Injected into web.whatsapp.com
// Monitors chat messages, matches keywords, shows suggestion panel
// v2: Per-contact memory with Read 📖 and Write ✏️ buttons

console.log("[WA-LLM] Content script successfully loaded. Waiting for WhatsApp UI...");

const MCP_SERVER = "http://localhost:3000";
const AUTO_IMAGE_SCAN_LIMIT = 4;

let settings = { keywords: [], keywordFilterEnabled: true, provider: "local", model: "local-model", systemPrompt: "", autoSend: false, autoSendDelay: 5 };
let lastProcessedSignature = null;
let suggestionPanel = null;
let isProcessing = false;
let currentContactName = "Contact";
let currentSuggestion = "";
let panelMode = "idle"; // idle | thinking | suggestion | memory-read | memory-write | error
let previousPanelState = { mode: "idle", content: "" };
let isMathPreviewOpen = false;
let isPanelMinimized = false;
let panelDragState = null;
let autoSendTimer = null;
let currentChatHistory = [];
let lastContactName = "";
let awaitingIncomingContact = "";

// ─── Extension health check ───────────────────────────────────────────────────

function isExtensionValid() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "PING" }, () => {
        resolve(!chrome.runtime.lastError);
      });
      setTimeout(() => resolve(false), 1000);
    } catch (e) {
      resolve(false);
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  console.log("[WA-LLM] Starting initialization sequence...");

  const alive = await isExtensionValid();
  if (!alive) {
    console.warn("[WA-LLM] Extension disconnected, reloading page...");
    window.location.reload();
    return;
  }

  try {
    settings = await getSettings();
    settings.keywords = normalizeKeywords(settings.keywords);
    settings.keywordFilterEnabled = normalizeKeywordFilterEnabled(settings.keywordFilterEnabled);
    settings.provider = normalizeProvider(settings.provider);
    settings.autoSend = Boolean(settings.autoSend);
    settings.autoSendDelay = normalizeAutoSendDelay(settings.autoSendDelay);
    console.log("[WA-LLM] Settings loaded.", settings);
  } catch (err) {
    console.error("[WA-LLM] Failed to load settings, using defaults.", err);
    settings = {
      keywords: ["help", "support", "info", "halo", "hai"],
      keywordFilterEnabled: true,
      provider: "local",
      model: "local-model",
      systemPrompt: "",
      autoSend: false,
      autoSendDelay: 5,
    };
    settings.keywords = normalizeKeywords(settings.keywords);
  }

  injectPanel();
  observeChat();
  await syncActiveContactContext(true);
  console.log("[WA-LLM] Extension active. Listening for keywords:", settings.keywords);
}

function getSettings() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for background script")), 3000);
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.keywords) settings.keywords = normalizeKeywords(changes.keywords.newValue);
  if (changes.keywordFilterEnabled) settings.keywordFilterEnabled = normalizeKeywordFilterEnabled(changes.keywordFilterEnabled.newValue);
  if (changes.provider) settings.provider = normalizeProvider(changes.provider.newValue);
  if (changes.model) settings.model = changes.model.newValue || "local-model";
  if (changes.systemPrompt) settings.systemPrompt = changes.systemPrompt.newValue || "";
  if (changes.autoSend) settings.autoSend = Boolean(changes.autoSend.newValue);
  if (changes.autoSendDelay) settings.autoSendDelay = normalizeAutoSendDelay(changes.autoSendDelay.newValue);
  if (panelMode === "idle") showPanel("idle");
  console.log("[WA-LLM] Settings updated live:", settings);
});

// ─── DOM Observer ─────────────────────────────────────────────────────────────

function observeChat() {
  let debounceTimer = null;
  console.log("[WA-LLM] Starting DOM observer for WhatsApp chat updates.");
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void checkLatestMessage();
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function checkLatestMessage() {
  await syncActiveContactContext();
  if (isProcessing) return;
  const latestMessage = getLatestMessageNode();
  if (!latestMessage) {
    console.log("[WA-LLM] No latest message node found. DOM selectors may need review.");
    return;
  }
  processMessageNode(latestMessage);
}

function getLatestMessageNode() {
  const seen = new Set();
  const messageNodes = Array.from(
    document.querySelectorAll('[data-id], div[class*="message-in"], div[class*="message-out"]')
  ).filter((node) => {
    const key = node.getAttribute("data-id") || node.outerHTML.slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (let i = messageNodes.length - 1; i >= 0; i--) {
    if (extractMessageText(messageNodes[i])) return messageNodes[i];
  }
  return null;
}

function processMessageNode(node) {
  const msgId =
    node.getAttribute("data-id") ||
    node.closest("[data-id]")?.getAttribute("data-id") ||
    node.querySelector("[data-id]")?.getAttribute("data-id");

  const messageText = extractMessageText(node);
  if (!messageText) return;

  const signature = `${msgId || "no-id"}::${messageText}`;
  if (signature === lastProcessedSignature) return;

  const direction = getMessageDirection(node, msgId);
  console.log(`[WA-LLM] Captured ${direction} message: "${messageText.substring(0, 50)}"`);

  // Update current contact on every message check
  currentContactName = getContactName();
  void refreshStoredChatHistory(currentContactName);

  if (awaitingIncomingContact === currentContactName) {
    lastProcessedSignature = signature;
    if (direction !== "incoming") {
      return;
    }
    awaitingIncomingContact = "";
  }

  if (direction !== "incoming") {
    lastProcessedSignature = signature;
    return;
  }

  const matched = !settings.keywordFilterEnabled || settings.keywords.some((kw) =>
    messageText.toLowerCase().includes(kw)
  );

  if (!matched) {
    lastProcessedSignature = signature;
    return;
  }

  console.log(settings.keywordFilterEnabled
    ? `[WA-LLM] Keyword matched! Triggering LLM...`
    : `[WA-LLM] Keyword filter disabled. Triggering LLM for incoming message...`);
  lastProcessedSignature = signature;
  handleKeywordMatch(messageText);
}

async function handleKeywordMatch(messageText) {
  isProcessing = true;
  showPanel("thinking");

  const contactName = getContactName();
  const chatHistory = await refreshStoredChatHistory(contactName);
  const imagePayload = shouldAttachImageContext(messageText)
    ? await buildAutoImagePayload(contactName)
    : {};

  requestSuggestion({
    message: messageText,
    contactName,
    chatHistory,
    provider: settings.provider,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    ...imagePayload,
  });
}

function requestSuggestion(payload) {
  console.log("[WA-LLM] Requesting suggestion", {
    contactName: payload.contactName,
    provider: payload.provider,
    historyLength: Array.isArray(payload.chatHistory) ? payload.chatHistory.length : 0,
    hasImage: Boolean(payload.imageDataUrl || payload.latestImageKey),
  });

  chrome.runtime.sendMessage(
    {
      type: "GET_SUGGESTION",
      payload,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error("[WA-LLM] Background message failed:", chrome.runtime.lastError.message);
        showPanel("error", chrome.runtime.lastError.message);
        isProcessing = false;
        return;
      }
      if (response?.ok) {
        if (payload.latestImageKey && (payload.imageDataUrl || payload.forceImageRefresh)) {
          void setStoredImageKey(payload.contactName, payload.latestImageKey);
          void clearIgnoredImageKey(payload.contactName);
        }
        console.log("[WA-LLM] Suggestion received successfully for", payload.contactName);
        showPanel("suggestion", response.reply);
      } else {
        console.error("[WA-LLM] Suggestion request returned an error:", response?.error);
        showPanel("error", response?.error || "Unknown error");
      }
      isProcessing = false;
    }
  );
}

async function analyzeLatestImage() {
  if (isProcessing) return;

  currentContactName = getContactName();
  isProcessing = true;
  showPanel("thinking", "Analyzing image...");

  try {
    const latestImage = await getLatestImageInfo();
    const latestMessage = sanitizeImageAnalysisMessage(extractMessageText(getLatestMessageNode()));
    const chatHistory = await refreshStoredChatHistory(currentContactName);

    requestSuggestion({
      message: latestMessage || "Please analyze the latest attached image and suggest a helpful WhatsApp reply.",
      contactName: currentContactName,
      chatHistory,
      provider: settings.provider,
      model: settings.model,
      systemPrompt: settings.systemPrompt,
      imageDataUrl: latestImage.imageDataUrl,
      latestImageKey: latestImage.imageKey,
      forceImageRefresh: true,
    });
  } catch (err) {
    showPanel("error", err.message);
    isProcessing = false;
  }

}

async function clearLatestImageCache() {
  currentContactName = getContactName();

  try {
    const latestImage = await getLatestImageInfo({
      requireVisible: false,
      includeDataUrl: false,
      scanLimit: AUTO_IMAGE_SCAN_LIMIT,
    });
    await clearStoredImageKey(currentContactName);
    if (latestImage?.imageKey) {
      await setIgnoredImageKey(currentContactName, latestImage.imageKey);
    } else {
      await clearIgnoredImageKey(currentContactName);
    }
    await fetch(`${MCP_SERVER}/image-context/${encodeURIComponent(currentContactName)}`, {
      method: "DELETE",
    });
    showPanel("idle", "");
  } catch (err) {
    showPanel("error", `Could not clear image cache: ${err.message}`);
  }
}

// ─── Chat Context Helpers ──────────────────────────────────────────────────────

function collectChatHistory() {
  const history = [];
  const messages = document.querySelectorAll('[data-id], div[class*="message-in"], div[class*="message-out"]');
  const recent = Array.from(messages).slice(-10);
  for (const el of recent) {
    const msgId =
      el.getAttribute("data-id") ||
      el.closest("[data-id]")?.getAttribute("data-id") ||
      el.querySelector("[data-id]")?.getAttribute("data-id");
    const isOutgoing = getMessageDirection(el, msgId) === "outgoing";
    const text = extractMessageText(el);
    if (!text) continue;
    history.push({ role: isOutgoing ? "assistant" : "user", content: text });
  }
  return history;
}

async function syncActiveContactContext(force = false) {
  const contactName = getContactName();
  if (!contactName) return;
  if (!force && contactName === lastContactName) return;
  const contactChanged = contactName !== lastContactName;

  currentContactName = contactName;
  lastContactName = contactName;
  if (contactChanged) {
    lastProcessedSignature = null;
    console.log("[WA-LLM] Contact switch detected. Resetting processed message guard for", contactName);
  }

  currentChatHistory = await loadStoredChatHistory(contactName);
  console.log("[WA-LLM] Active contact changed:", contactName, {
    storedMessages: currentChatHistory.length,
    force,
    contactChanged,
  });

  await refreshStoredChatHistory(contactName);
}

async function refreshStoredChatHistory(contactName) {
  const storedHistory = contactName === lastContactName
    ? currentChatHistory
    : await loadStoredChatHistory(contactName);
  const visibleHistory = collectChatHistory();
  const mergedHistory = mergeChatHistories(storedHistory, visibleHistory);

  currentChatHistory = mergedHistory;
  lastContactName = contactName;

  if (!areHistoriesEqual(storedHistory, mergedHistory)) {
    await saveStoredChatHistory(contactName, mergedHistory);
    console.log("[WA-LLM] Synced contact context from DOM:", contactName, {
      storedMessages: mergedHistory.length,
    });
  }

  return mergedHistory;
}

function loadStoredChatHistory(contactName) {
  const key = getContactMemoryStorageKey(contactName);
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (data) => {
      const history = normalizeStoredChatHistory(data[key] || []);
      console.log("[WA-LLM] Loaded local context:", contactName, {
        storedMessages: history.length,
      });
      resolve(history);
    });
  });
}

function saveStoredChatHistory(contactName, chatHistory) {
  const key = getContactMemoryStorageKey(contactName);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: chatHistory }, () => {
      console.log("[WA-LLM] Saved local context:", contactName, {
        storedMessages: chatHistory.length,
      });
      resolve();
    });
  });
}

function clearStoredChatHistory(contactName) {
  const key = getContactMemoryStorageKey(contactName);
  return new Promise((resolve) => {
    chrome.storage.local.remove(key, () => {
      console.log("[WA-LLM] Cleared local context:", contactName);
      resolve();
    });
  });
}

function mergeChatHistories(storedHistory, visibleHistory) {
  const combined = [...normalizeStoredChatHistory(storedHistory), ...normalizeStoredChatHistory(visibleHistory)];
  const dedupedReversed = [];
  const seen = new Set();

  for (let i = combined.length - 1; i >= 0; i--) {
    const entry = combined[i];
    const signature = `${entry.role}::${entry.content}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    dedupedReversed.push(entry);
  }

  return dedupedReversed.reverse().slice(-20);
}

function normalizeStoredChatHistory(history) {
  return (Array.isArray(history) ? history : [])
    .map((entry) => ({
      role: entry?.role === "assistant" ? "assistant" : "user",
      content: String(entry?.content || "").trim(),
    }))
    .filter((entry) => entry.content);
}

function areHistoriesEqual(left, right) {
  const leftNormalized = normalizeStoredChatHistory(left);
  const rightNormalized = normalizeStoredChatHistory(right);

  if (leftNormalized.length !== rightNormalized.length) {
    return false;
  }

  return leftNormalized.every((entry, index) => (
    entry.role === rightNormalized[index].role &&
    entry.content === rightNormalized[index].content
  ));
}

function getContactMemoryStorageKey(contactName) {
  return `memory_${contactName}`;
}

function getContactName() {
  const header = document.querySelector(
    '[data-testid="conversation-header"] [data-testid="conversation-info-header-chat-title"]'
  );
  return header?.innerText?.trim() || "Contact";
}

// ─── Panel UI ─────────────────────────────────────────────────────────────────

function injectPanel() {
  if (suggestionPanel) return;

  suggestionPanel = document.createElement("div");
  suggestionPanel.id = "wa-llm-panel";
  suggestionPanel.innerHTML = `
    <div class="wa-llm-header">
      <span class="wa-llm-logo">⚡ LLM Assist</span>
      <div class="wa-llm-header-btns">
        <button class="wa-llm-mem-btn" id="wa-llm-read" title="Read contact memory">📖</button>
        <button class="wa-llm-mem-btn" id="wa-llm-write" title="Edit contact memory">✏️</button>
        <button class="wa-llm-close" id="wa-llm-close">✕</button>
      </div>
    </div>
    <div class="wa-llm-body" id="wa-llm-body">
      <div class="wa-llm-idle">${getIdlePanelMessage()}</div>
    </div>
    <div class="wa-llm-footer" id="wa-llm-footer" style="display:none">
      <button class="wa-btn wa-btn-secondary" id="wa-llm-regen">↺ Regen</button>
      <button class="wa-btn wa-btn-primary" id="wa-llm-send">Send ↗</button>
    </div>
    <div class="wa-llm-footer" id="wa-llm-nav-footer" style="display:none">
      <button class="wa-btn wa-btn-secondary" id="wa-llm-clear-memory">Clear Memory</button>
      <button class="wa-btn wa-btn-secondary" id="wa-llm-back">Back</button>
    </div>
    <div class="wa-llm-footer" id="wa-llm-mem-footer" style="display:none">
      <button class="wa-btn wa-btn-secondary" id="wa-llm-mem-clear">Clear Memory</button>
      <button class="wa-btn wa-btn-secondary" id="wa-llm-mem-cancel">✕ Cancel</button>
      <button class="wa-btn wa-btn-primary" id="wa-llm-mem-save">💾 Save</button>
    </div>
  `;

  document.body.appendChild(suggestionPanel);

  const headerButtons = suggestionPanel.querySelector(".wa-llm-header-btns");
  const visionButton = document.createElement("button");
  visionButton.className = "wa-llm-mem-btn";
  visionButton.id = "wa-llm-vision";
  visionButton.title = "Analyze latest image";
  visionButton.textContent = "Img";
  headerButtons.insertBefore(visionButton, headerButtons.firstChild);

  const closeButton = document.getElementById("wa-llm-close");
  const clearImageCacheButton = document.createElement("button");
  clearImageCacheButton.className = "wa-llm-mem-btn";
  clearImageCacheButton.id = "wa-llm-clear-image-cache";
  clearImageCacheButton.title = "Clear latest image cache";
  clearImageCacheButton.textContent = "Clr";
  headerButtons.insertBefore(clearImageCacheButton, closeButton);

  const minimizeButton = document.createElement("button");
  minimizeButton.className = "wa-llm-minimize";
  minimizeButton.id = "wa-llm-minimize";
  minimizeButton.title = "Minimize panel";
  minimizeButton.textContent = "_";
  headerButtons.insertBefore(minimizeButton, closeButton);

  const mainFooter = document.getElementById("wa-llm-footer");
  const mathButton = document.createElement("button");
  mathButton.className = "wa-btn wa-btn-secondary";
  mathButton.id = "wa-llm-toggle-math";
  mathButton.textContent = "Math";
  mainFooter.insertBefore(mathButton, mainFooter.firstChild);

  const analyzeButton = document.createElement("button");
  analyzeButton.className = "wa-btn wa-btn-secondary";
  analyzeButton.id = "wa-llm-analyze-image";
  analyzeButton.textContent = "Analyze Image";
  mainFooter.insertBefore(analyzeButton, document.getElementById("wa-llm-send"));

  document.getElementById("wa-llm-back").textContent = "Back";
  document.getElementById("wa-llm-mem-cancel").textContent = "Back";
  document.getElementById("wa-llm-mem-save").textContent = "Save";

  document.getElementById("wa-llm-close").addEventListener("click", () => {
    suggestionPanel.classList.add("wa-llm-hidden");
  });

  document.getElementById("wa-llm-minimize").addEventListener("click", togglePanelMinimize);
  document.getElementById("wa-llm-vision").addEventListener("click", analyzeLatestImage);
  document.getElementById("wa-llm-clear-image-cache").addEventListener("click", clearLatestImageCache);
  document.getElementById("wa-llm-toggle-math").addEventListener("click", toggleMathPreview);
  document.getElementById("wa-llm-send").addEventListener("click", sendSuggestion);
  document.getElementById("wa-llm-analyze-image").addEventListener("click", analyzeLatestImage);
  document.getElementById("wa-llm-regen").addEventListener("click", regenerate);
  document.getElementById("wa-llm-read").addEventListener("click", readMemory);
  document.getElementById("wa-llm-write").addEventListener("click", writeMemory);
  document.getElementById("wa-llm-clear-memory").addEventListener("click", clearContactMemory);
  document.getElementById("wa-llm-back").addEventListener("click", goBackToPreviousPanel);
  document.getElementById("wa-llm-mem-clear").addEventListener("click", clearContactMemory);
  document.getElementById("wa-llm-mem-cancel").addEventListener("click", goBackToPreviousPanel);
  document.getElementById("wa-llm-mem-save").addEventListener("click", saveMemory);
  setupPanelDragging();
}

// ─── Panel States ─────────────────────────────────────────────────────────────

function showPanel(state, content = "") {
  if (!suggestionPanel) injectPanel();
  clearAutoSendTimer();
  if (isMemoryState(state)) rememberPreviousPanel();
  panelMode = state;
  suggestionPanel.classList.remove("wa-llm-hidden");

  const body = document.getElementById("wa-llm-body");
  const footer = document.getElementById("wa-llm-footer");
  const navFooter = document.getElementById("wa-llm-nav-footer");
  const memFooter = document.getElementById("wa-llm-mem-footer");

  footer.style.display = "none";
  navFooter.style.display = "none";
  memFooter.style.display = "none";

  if (state === "idle") {
    body.innerHTML = `<div class="wa-llm-idle">${getIdlePanelMessage()}</div>`;
  } else if (state === "thinking") {
    body.innerHTML = `<div class="wa-llm-thinking"><span class="wa-dot"></span><span class="wa-dot"></span><span class="wa-dot"></span><span style="margin-left:8px">${escapeHtml(content || "Generating reply...")}</span></div>`;
  } else if (state === "suggestion") {
    currentSuggestion = content;
    isMathPreviewOpen = false;
    body.innerHTML = `
      <div class="wa-llm-suggestion-wrap">
        <div class="wa-llm-suggestion" contenteditable="true" id="wa-llm-text">${escapeHtml(content)}</div>
        <div class="wa-llm-math-section wa-llm-math-hidden" id="wa-llm-math-section">
          <div class="wa-llm-preview-label">Math Preview</div>
          <div class="wa-llm-math-preview" id="wa-llm-math-preview">${renderMathPreview(content)}</div>
        </div>
      </div>`;
    document.getElementById("wa-llm-text").addEventListener("input", updateSuggestionPreview);
    syncMathPreviewVisibility();
    footer.style.display = "flex";
    scheduleAutoSend();
  } else if (state === "memory-loading") {
    body.innerHTML = `<div class="wa-llm-thinking"><span class="wa-dot"></span><span class="wa-dot"></span><span class="wa-dot"></span><span style="margin-left:8px">Loading memory...</span></div>`;
  } else if (state === "memory-read") {
    body.innerHTML = renderMemoryRead(content);
    navFooter.style.display = "flex";
  } else if (state === "memory-write") {
    body.innerHTML = renderMemoryWrite(content);
    memFooter.style.display = "flex";
  } else if (state === "error") {
    body.innerHTML = `<div class="wa-llm-error">⚠ ${escapeHtml(content)}</div>`;
  }
  const inlineClearButton = document.getElementById("wa-llm-clear-memory-inline");
  if (inlineClearButton) {
    inlineClearButton.addEventListener("click", clearContactMemory);
  }
}

function rememberPreviousPanel() {
  if (isMemoryState(panelMode) || panelMode === "thinking") return;
  previousPanelState = {
    mode: panelMode,
    content: panelMode === "suggestion" ? getCurrentSuggestionText() : "",
  };
}

function goBackToPreviousPanel() {
  if (previousPanelState.mode === "suggestion" && previousPanelState.content) {
    showPanel("suggestion", previousPanelState.content);
    return;
  }
  showPanel("idle");
}

function isMemoryState(state) {
  return state === "memory-loading" || state === "memory-read" || state === "memory-write";
}

function togglePanelMinimize() {
  setPanelMinimized(!isPanelMinimized);
}

function setPanelMinimized(minimized) {
  isPanelMinimized = minimized;
  if (!suggestionPanel) return;

  suggestionPanel.classList.toggle("wa-llm-minimized", minimized);

  const minimizeButton = document.getElementById("wa-llm-minimize");
  if (minimizeButton) {
    minimizeButton.textContent = minimized ? "+" : "_";
    minimizeButton.title = minimized ? "Expand panel" : "Minimize panel";
  }
}

function setupPanelDragging() {
  const header = suggestionPanel?.querySelector(".wa-llm-header");
  if (!header) return;

  header.addEventListener("mousedown", startPanelDrag);
  document.addEventListener("mousemove", dragPanel);
  document.addEventListener("mouseup", stopPanelDrag);
}

function startPanelDrag(event) {
  if (!suggestionPanel || event.button !== 0) return;
  if (event.target.closest("button, input, textarea, select")) return;

  const rect = suggestionPanel.getBoundingClientRect();
  panelDragState = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };

  suggestionPanel.classList.add("wa-llm-dragging");
  suggestionPanel.style.left = `${rect.left}px`;
  suggestionPanel.style.top = `${rect.top}px`;
  suggestionPanel.style.right = "auto";
  suggestionPanel.style.bottom = "auto";

  event.preventDefault();
}

function dragPanel(event) {
  if (!panelDragState || !suggestionPanel) return;

  const maxLeft = Math.max(0, window.innerWidth - suggestionPanel.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - suggestionPanel.offsetHeight);
  const nextLeft = Math.min(Math.max(0, event.clientX - panelDragState.offsetX), maxLeft);
  const nextTop = Math.min(Math.max(0, event.clientY - panelDragState.offsetY), maxTop);

  suggestionPanel.style.left = `${nextLeft}px`;
  suggestionPanel.style.top = `${nextTop}px`;
}

function stopPanelDrag() {
  if (!panelDragState || !suggestionPanel) return;

  panelDragState = null;
  suggestionPanel.classList.remove("wa-llm-dragging");
}

function renderMemoryRead(memory) {
  const contact = currentContactName;
  const contextCount = currentChatHistory.length;
  if (!memory) {
    return `
      <div class="wa-mem-read">
        <div class="wa-mem-name">📇 ${escapeHtml(contact)}</div>
        <div class="wa-mem-empty">No memory yet.<br>Use Edit contact memory to save notes for this chat.</div>
        <div class="wa-mem-row"><span class="wa-mem-label">Prompt Context</span><span>${contextCount} saved messages for this contact</span></div>
        <button class="wa-btn wa-btn-secondary wa-mem-inline-btn" id="wa-llm-clear-memory-inline">Clear memory</button>
      </div>`;
  }
  const topics = (memory.topics || []).map((t) => `<span class="wa-mem-tag">${escapeHtml(t)}</span>`).join("");
  return `
    <div class="wa-mem-read">
      <div class="wa-mem-name">📇 ${escapeHtml(memory.name)}</div>
      <div class="wa-mem-row"><span class="wa-mem-label">Style</span><span>${escapeHtml(memory.style || "—")}</span></div>
      <div class="wa-mem-row"><span class="wa-mem-label">Topics</span><div class="wa-mem-tags">${topics || "<span style='color:#475569'>none yet</span>"}</div></div>
      <div class="wa-mem-row"><span class="wa-mem-label">Notes</span><span>${escapeHtml(memory.notes || "—")}</span></div>
      <div class="wa-mem-meta">💬 ${memory.messageCount} messages · Last seen ${memory.lastSeen || "—"}</div>
    </div>`;
}

function renderMemoryWrite(memory) {
  return `
    <div class="wa-mem-write">
      <div class="wa-mem-row"><span class="wa-mem-label">Prompt Context</span><span>${currentChatHistory.length} saved messages for this contact</span></div>
      <div class="wa-mem-name">✏️ ${escapeHtml(currentContactName)}</div>
      <label class="wa-mem-label">Style</label>
      <input id="wa-mem-style" class="wa-mem-input" type="text" placeholder="e.g. casual, bahasa Indonesia, friendly" value="${escapeHtml(memory?.style || "")}" />
      <label class="wa-mem-label">Topics (comma separated)</label>
      <input id="wa-mem-topics" class="wa-mem-input" type="text" placeholder="e.g. project deadline, invoice" value="${escapeHtml((memory?.topics || []).join(", "))}" />
      <label class="wa-mem-label">Notes</label>
      <textarea id="wa-mem-notes" class="wa-mem-textarea" placeholder="Any notes about this contact...">${escapeHtml(memory?.notes || "")}</textarea>
    </div>`;
}

// ─── Memory Actions ───────────────────────────────────────────────────────────

async function readMemory() {
  currentContactName = getContactName();
  await syncActiveContactContext(true);
  console.log("[WA-LLM] Loading contact notes for", currentContactName);
  showPanel("memory-loading");
  try {
    const res = await fetch(`${MCP_SERVER}/memory/${encodeURIComponent(currentContactName)}`);
    if (res.status === 404) {
      showPanel("memory-read", null);
      return;
    }
    const data = await res.json();
    showPanel("memory-read", data.contact);
  } catch (err) {
    showPanel("error", `Could not load memory: ${err.message}`);
  }
}

async function writeMemory() {
  currentContactName = getContactName();
  await syncActiveContactContext(true);
  console.log("[WA-LLM] Opening memory editor for", currentContactName);
  showPanel("memory-loading");
  try {
    // Pre-fill with existing memory if available
    const res = await fetch(`${MCP_SERVER}/memory/${encodeURIComponent(currentContactName)}`);
    const existing = res.ok ? (await res.json()).contact : null;
    showPanel("memory-write", existing);
  } catch {
    showPanel("memory-write", null);
  }
}

async function saveMemory() {
  const style  = document.getElementById("wa-mem-style")?.value.trim() || "";
  const topicsRaw = document.getElementById("wa-mem-topics")?.value.trim() || "";
  const notes  = document.getElementById("wa-mem-notes")?.value.trim() || "";
  const topics = topicsRaw.split(",").map((t) => t.trim()).filter(Boolean);

  try {
    const res = await fetch(`${MCP_SERVER}/memory/${encodeURIComponent(currentContactName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style, topics, notes }),
    });
    const data = await res.json();
    showPanel("memory-read", data.contact);
  } catch (err) {
    showPanel("error", `Could not save memory: ${err.message}`);
  }
}

async function clearContactMemory() {
  currentContactName = getContactName();
  if (!window.confirm(`Clear saved prompt context for ${currentContactName}?`)) {
    return;
  }

  try {
    await clearStoredChatHistory(currentContactName);
    currentChatHistory = [];
    lastProcessedSignature = null;
    console.log("[WA-LLM] Prompt context cleared for", currentContactName);
    if (panelMode === "memory-write") {
      await writeMemory();
    } else {
      await readMemory();
    }
  } catch (err) {
    showPanel("error", `Could not clear memory: ${err.message}`);
  }
}

// ─── Suggestion Actions ───────────────────────────────────────────────────────

async function sendSuggestion() {
  clearAutoSendTimer();

  const text = getCurrentSuggestionText();
  if (!text) return;

  const injected = injectTextIntoInput(text);
  if (!injected) {
    showPanel("error", "Could not find the WhatsApp reply box.");
    return;
  }

  const sent = await triggerWhatsAppSend();
  if (!sent) {
    showPanel("error", "Reply was inserted, but WhatsApp did not send it.");
    return;
  }

  document.getElementById("wa-llm-footer").style.display = "none";
  document.getElementById("wa-llm-body").innerHTML = `<div class="wa-llm-idle">✓ Sent! Waiting for next keyword...</div>`;
  awaitingIncomingContact = currentContactName;
}

function regenerate() {
  const latestMessage = getLatestMessageNode();
  const msg = latestMessage ? extractMessageText(latestMessage) : "";
  if (msg) handleKeywordMatch(msg);
}

// ─── WhatsApp Input Injection ─────────────────────────────────────────────────

function injectTextIntoInput(text) {
  const input =
    document.querySelector('[data-testid="conversation-compose-box-input"]') ||
    document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]');

  if (!input) {
    console.error("[WA-LLM] Could not find message input box");
    return false;
  }

  input.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function scheduleAutoSend() {
  if (!settings.autoSend) return;

  const delayMs = normalizeAutoSendDelay(settings.autoSendDelay) * 1000;
  autoSendTimer = window.setTimeout(() => {
    if (panelMode === "suggestion") {
      void sendSuggestion();
    }
  }, delayMs);
}

function clearAutoSendTimer() {
  if (!autoSendTimer) return;
  window.clearTimeout(autoSendTimer);
  autoSendTimer = null;
}

async function triggerWhatsAppSend() {
  await wait(150);

  const sendButton =
    document.querySelector('[data-testid="compose-btn-send"]') ||
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('span[data-icon="send"]')?.closest("button");

  if (sendButton instanceof HTMLElement && !sendButton.disabled) {
    sendButton.click();
    return true;
  }

  const input =
    document.querySelector('[data-testid="conversation-compose-box-input"]') ||
    document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]');

  if (!(input instanceof HTMLElement)) {
    return false;
  }

  input.focus();
  const keyboardOptions = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
  input.dispatchEvent(new KeyboardEvent("keydown", keyboardOptions));
  input.dispatchEvent(new KeyboardEvent("keypress", keyboardOptions));
  input.dispatchEvent(new KeyboardEvent("keyup", keyboardOptions));

  await wait(250);
  return !isComposeBoxFilled(input);
}

function isComposeBoxFilled(input) {
  const text = input.innerText || input.textContent || "";
  return text.trim().length > 0;
}

function normalizeAutoSendDelay(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 5;
  return Math.min(Math.max(parsed, 1), 60);
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ─── Utils ────────────────────────────────────────────────────────────────────

async function buildAutoImagePayload(contactName) {
  const latestImage = await getLatestImageInfo({
    requireVisible: false,
    includeDataUrl: false,
    scanLimit: AUTO_IMAGE_SCAN_LIMIT,
  });
  if (!latestImage) {
    return {};
  }

  const ignoredImageKey = await getIgnoredImageKey(contactName);
  if (ignoredImageKey && ignoredImageKey === latestImage.imageKey) {
    return {};
  }

  const storedImageKey = await getStoredImageKey(contactName);
  if (storedImageKey === latestImage.imageKey) {
    return { latestImageKey: latestImage.imageKey };
  }

  const latestImageWithData = await getLatestImageInfo({
    requireVisible: true,
    includeDataUrl: true,
    scanLimit: AUTO_IMAGE_SCAN_LIMIT,
  });
  return latestImageWithData;
}

async function getLatestImageInfo(options = {}) {
  const { requireVisible = true, includeDataUrl = true, scanLimit = Infinity } = options;
  const imageNode = getLatestImageNode(scanLimit);
  if (!imageNode) {
    if (requireVisible) {
      throw new Error("No visible image found in this chat.");
    }
    return null;
  }

  const container = imageNode.closest("[data-id]") || imageNode.closest('div[class*="message-in"], div[class*="message-out"]');
  const imageKey = buildImageKey(container, imageNode);
  const imageInfo = { latestImageKey: imageKey, imageKey };
  if (includeDataUrl) {
    imageInfo.imageDataUrl = await imageElementToJpegDataUrl(imageNode);
  }
  return imageInfo;
}

function getLatestImageNode(scanLimit = Infinity) {
  const containers = Array.from(
    document.querySelectorAll('[data-id], div[class*="message-in"], div[class*="message-out"]')
  );
  const limitedContainers = Number.isFinite(scanLimit)
    ? containers.slice(-Math.max(1, scanLimit))
    : containers;

  for (let i = limitedContainers.length - 1; i >= 0; i--) {
    const images = Array.from(limitedContainers[i].querySelectorAll("img"));
    for (let j = images.length - 1; j >= 0; j--) {
      if (isUsableChatImage(images[j])) {
        return images[j];
      }
    }
  }

  return null;
}

function buildImageKey(container, img) {
  const messageId = container?.getAttribute("data-id") || container?.dataset?.id || "no-message-id";
  const src = img.currentSrc || img.src || "no-src";
  const srcToken = src.slice(-80);
  return `${currentContactName}::${messageId}::${img.naturalWidth}x${img.naturalHeight}::${srcToken}`;
}

function isUsableChatImage(img) {
  const src = img.currentSrc || img.src || "";
  if (!src) return false;
  if (img.naturalWidth < 80 || img.naturalHeight < 80) return false;
  if (src.includes("data:image/gif")) return false;
  return src.startsWith("blob:") || src.startsWith("data:image") || /^https?:/i.test(src);
}

async function imageElementToJpegDataUrl(img) {
  await ensureImageLoaded(img);

  const maxDimension = 768;
  const scale = Math.min(1, maxDimension / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.55);
  if (dataUrl.length > 8_000_000) {
    throw new Error("The selected image is still too large after compression.");
  }
  return dataUrl;
}

function ensureImageLoaded(img) {
  if (img.complete && img.naturalWidth > 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load the selected image."));
    };
    const cleanup = () => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
    };

    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
  });
}

function getStoredImageKey(contactName) {
  return new Promise((resolve) => {
    chrome.storage.local.get([getImageCacheStorageKey(contactName)], (data) => {
      resolve(data[getImageCacheStorageKey(contactName)]?.latestImageKey || "");
    });
  });
}

function setStoredImageKey(contactName, latestImageKey) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [getImageCacheStorageKey(contactName)]: {
          latestImageKey,
          updatedAt: new Date().toISOString(),
        },
      },
      resolve
    );
  });
}

function clearStoredImageKey(contactName) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(getImageCacheStorageKey(contactName), resolve);
  });
}

function getIgnoredImageKey(contactName) {
  return new Promise((resolve) => {
    chrome.storage.local.get([getIgnoredImageStorageKey(contactName)], (data) => {
      resolve(data[getIgnoredImageStorageKey(contactName)]?.latestImageKey || "");
    });
  });
}

function setIgnoredImageKey(contactName, latestImageKey) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        [getIgnoredImageStorageKey(contactName)]: {
          latestImageKey,
          updatedAt: new Date().toISOString(),
        },
      },
      resolve
    );
  });
}

function clearIgnoredImageKey(contactName) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(getIgnoredImageStorageKey(contactName), resolve);
  });
}

function getImageCacheStorageKey(contactName) {
  return `waBridge:imageCache:${contactName}`;
}

function getIgnoredImageStorageKey(contactName) {
  return `waBridge:ignoredImage:${contactName}`;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/\n/g, "<br>");
}

function normalizeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .map((kw) => String(kw).trim().toLowerCase()).filter(Boolean);
}

function normalizeKeywordFilterEnabled(value) {
  return value !== false;
}

function normalizeProvider(provider) {
  return provider === "openrouter" ? "openrouter" : "local";
}

function getIdlePanelMessage() {
  return settings.keywordFilterEnabled
    ? "Waiting for keyword match..."
    : "Keyword filter is off. Waiting for the next incoming message...";
}

function shouldAttachImageContext(messageText) {
  const normalized = String(messageText || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return /\b(image|img|photo|picture|pic|screenshot|screen shot|vision|lihat|foto|gambar)\b/i.test(normalized);
}

function sanitizeImageAnalysisMessage(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  if (/^\d{1,2}:\d{2}\s?(am|pm)$/i.test(normalized)) {
    return "";
  }

  return normalized;
}

function getMessageDirection(node, msgId = "") {
  if (node.closest('[class*="message-out"]')) {
    return "outgoing";
  }

  if (node.closest('[class*="message-in"]')) {
    return "incoming";
  }

  const normalizedId = String(msgId || "").trim().toLowerCase();
  if (normalizedId.startsWith("true_") || normalizedId.includes("_true_")) {
    return "outgoing";
  }
  if (normalizedId.startsWith("false_") || normalizedId.includes("_false_")) {
    return "incoming";
  }

  const nestedOutgoing = node.querySelector('[data-id^="true_"]');
  if (nestedOutgoing) {
    return "outgoing";
  }

  const nestedIncoming = node.querySelector('[data-id^="false_"]');
  if (nestedIncoming) {
    return "incoming";
  }

  return "incoming";
}

function getCurrentSuggestionText() {
  const textEl = document.getElementById("wa-llm-text");
  const text = textEl ? textEl.innerText.trim() : currentSuggestion;
  if (text) currentSuggestion = text;
  return currentSuggestion;
}

function toggleMathPreview() {
  isMathPreviewOpen = !isMathPreviewOpen;
  syncMathPreviewVisibility();
}

function syncMathPreviewVisibility() {
  const section = document.getElementById("wa-llm-math-section");
  const button = document.getElementById("wa-llm-toggle-math");
  if (button) {
    button.textContent = isMathPreviewOpen ? "Hide Math" : "Math";
  }
  if (!section) return;
  section.classList.toggle("wa-llm-math-hidden", !isMathPreviewOpen);
}

function updateSuggestionPreview() {
  const text = getCurrentSuggestionText();
  const preview = document.getElementById("wa-llm-math-preview");
  if (preview) {
    preview.innerHTML = renderMathPreview(text);
  }
}

function renderMathPreview(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const escaped = escapeHtml(normalized);
  return formatMathMarkup(escaped).replace(/\n/g, "<br>");
}

function formatMathMarkup(text) {
  let formatted = text;

  formatted = formatted.replace(
    /\\begin\{(?:bmatrix|pmatrix|matrix)\}([\s\S]*?)\\end\{(?:bmatrix|pmatrix|matrix)\}/g,
    (_match, body) => renderMatrix(body)
  );

  formatted = formatted.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, (_match, numerator, denominator) =>
    `<span class="wa-frac"><span class="wa-frac-top">${formatInlineMath(numerator)}</span><span class="wa-frac-bottom">${formatInlineMath(denominator)}</span></span>`
  );

  formatted = formatted.replace(/\\sqrt\{([^{}]+)\}/g, (_match, content) =>
    `<span class="wa-sqrt"><span class="wa-sqrt-sign">√</span><span class="wa-sqrt-body">${formatInlineMath(content)}</span></span>`
  );

  formatted = formatted.replace(/\\sqrt\(([^()]+)\)/g, (_match, content) =>
    `<span class="wa-sqrt"><span class="wa-sqrt-sign">√</span><span class="wa-sqrt-body">${formatInlineMath(content)}</span></span>`
  );

  return formatInlineMath(formatted);
}

function renderMatrix(body) {
  const rows = body
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) =>
      row
        .split("&")
        .map((cell) => `<span class="wa-matrix-cell">${formatInlineMath(cell.trim())}</span>`)
        .join("")
    )
    .map((cells) => `<span class="wa-matrix-row">${cells}</span>`)
    .join("");

  return `<span class="wa-matrix">${rows}</span>`;
}

function formatInlineMath(text) {
  let formatted = text;

  formatted = formatted.replace(
    /\\(sum|prod|int|lim)_\{([^{}]+)\}\^\{([^{}]+)\}/g,
    (_match, op, lower, upper) => renderOperator(op, lower, upper)
  );
  formatted = formatted.replace(
    /\\(sum|prod|int)_\{([^{}]+)\}/g,
    (_match, op, lower) => renderOperator(op, lower, "")
  );
  formatted = formatted.replace(
    /\\(sum|prod|int|lim)\^([A-Za-z0-9+\-=><]+)/g,
    (_match, op, upper) => renderOperator(op, "", upper)
  );
  formatted = formatted.replace(
    /\\(sum|prod|int|lim)_([A-Za-z0-9+\-=><]+)/g,
    (_match, op, lower) => renderOperator(op, lower, "")
  );

  formatted = formatted.replace(/\\infty/g, "∞");
  formatted = formatted.replace(/\\to/g, "→");
  formatted = formatted.replace(/\\approx/g, "≈");
  formatted = formatted.replace(/\\neq/g, "≠");
  formatted = formatted.replace(/\\leq/g, "≤");
  formatted = formatted.replace(/\\geq/g, "≥");
  formatted = formatted.replace(/\\cdot/g, "·");
  formatted = formatted.replace(/\\times/g, "×");
  formatted = formatted.replace(/\\alpha/g, "α");
  formatted = formatted.replace(/\\beta/g, "β");
  formatted = formatted.replace(/\\gamma/g, "γ");
  formatted = formatted.replace(/\\delta/g, "δ");
  formatted = formatted.replace(/\\theta/g, "θ");
  formatted = formatted.replace(/\\lambda/g, "λ");
  formatted = formatted.replace(/\\mu/g, "μ");
  formatted = formatted.replace(/\\pi/g, "π");
  formatted = formatted.replace(/\\sigma/g, "σ");
  formatted = formatted.replace(/\\omega/g, "ω");
  formatted = formatted.replace(/\\int/g, "∫");
  formatted = formatted.replace(/\\sum/g, "∑");
  formatted = formatted.replace(/\\prod/g, "∏");
  formatted = formatted.replace(/\\lim/g, "lim");

  formatted = formatted.replace(/([A-Za-z0-9)\]])\^\{([^{}]+)\}/g, '$1<sup>$2</sup>');
  formatted = formatted.replace(/([A-Za-z0-9)\]])_\\{([^{}]+)\\}/g, '$1<sub>$2</sub>');
  formatted = formatted.replace(/([A-Za-z0-9)\]])_\{([^{}]+)\}/g, '$1<sub>$2</sub>');
  formatted = formatted.replace(/([A-Za-z0-9)\]])\^([A-Za-z0-9+\-]+)/g, '$1<sup>$2</sup>');
  formatted = formatted.replace(/([A-Za-z0-9)\]])_([A-Za-z0-9+\-]+)/g, '$1<sub>$2</sub>');

  return formatted;
}

function renderOperator(op, lower, upper) {
  const symbolMap = {
    sum: "∑",
    prod: "∏",
    int: "∫",
    lim: "lim",
  };

  const symbol = symbolMap[op] || op;
  const lowerHtml = lower ? `<span class="wa-op-lower">${formatInlineMath(lower)}</span>` : "";
  const upperHtml = upper ? `<span class="wa-op-upper">${formatInlineMath(upper)}</span>` : "";

  return `<span class="wa-op"><span class="wa-op-upper-wrap">${upperHtml}</span><span class="wa-op-symbol">${symbol}</span><span class="wa-op-lower-wrap">${lowerHtml}</span></span>`;
}

function extractMessageText(node) {
  if (!node) return "";
  const selectors = [
    "span.selectable-text",
    "div.copyable-text span[dir='ltr']",
    "div.copyable-text span[dir='auto']",
    '[data-testid="msg-text"]',
    '[data-testid="conversation-text-message"]',
  ];
  for (const selector of selectors) {
    const candidates = Array.from(node.querySelectorAll(selector));
    const text = candidates.map((el) => el.innerText?.trim() || "").filter(Boolean).join(" ").trim();
    if (text) return text;
  }
  const copyable = node.querySelector("div.copyable-text");
  if (copyable?.innerText?.trim()) return copyable.innerText.trim();
  if (node.innerText?.trim() && node.innerText.trim().length < 2000) return node.innerText.trim();
  return "";
}

// ─── Start ────────────────────────────────────────────────────────────────────

let attempts = 0;
const bootInterval = setInterval(() => {
  attempts++;
  const isLoaded =
    document.getElementById("pane-side") ||
    document.querySelector("#app .two") ||
    document.querySelector('[data-testid="chat-list"]') ||
    document.querySelector('[data-testid="search-input-container"]') ||
    document.querySelector('div[contenteditable="true"][data-tab="3"]');

  if (isLoaded) {
    console.log("[WA-LLM] WhatsApp UI detected!");
    clearInterval(bootInterval);
    init();
  } else if (attempts > 30) {
    clearInterval(bootInterval);
    console.error("[WA-LLM] Gave up waiting for WhatsApp UI.");
  } else if (attempts % 5 === 0) {
    console.log(`[WA-LLM] Waiting for WhatsApp to load... (attempt ${attempts})`);
  }
}, 2000);



