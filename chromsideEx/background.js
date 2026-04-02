// background.js - Service Worker
// Handles communication between content script and MCP bridge server

chrome.runtime.onStartup.addListener(() => {
  console.log("waBridge starting up");
  setupKeepAlive();
});

chrome.runtime.onInstalled.addListener(() => {
  setupKeepAlive();
});

function setupKeepAlive() {
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    console.log("[waBridge] Service worker keep-alive ping");
  }
});

const MCP_SERVER = "http://localhost:3000";
const SUGGESTION_TIMEOUT_MS = 30000;
const SUGGESTION_RETRY_COUNT = 1;
const DEFAULT_PROVIDER = "local";
const DEFAULT_MODEL = "local-model";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_SYSTEM_PROMPT = "You are a helpful WhatsApp assistant. Reply concisely and naturally.";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[waBridge] Background message received:", msg?.type, {
    tabId: sender?.tab?.id,
    contactName: msg?.payload?.contactName,
  });

  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_SUGGESTION") {
    fetchSuggestion(msg.payload)
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GET_SETTINGS") {
    chrome.storage.sync.get(["keywords", "keywordFilterEnabled", "provider", "model", "systemPrompt", "autoSend", "autoSendDelay"], (data) => {
      const provider = data.provider || DEFAULT_PROVIDER;
      sendResponse({
        keywords: data.keywords || ["help", "support", "info", "halo", "hai"],
        keywordFilterEnabled: data.keywordFilterEnabled !== false,
        provider,
        model: data.model || (provider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL),
        systemPrompt: data.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        autoSend: data.autoSend || false,
        autoSendDelay: data.autoSendDelay || 5,
      });
    });
    return true;
  }

  if (msg.type === "SAVE_SETTINGS") {
    chrome.storage.sync.set(msg.payload, () => sendResponse({ ok: true }));
    return true;
  }
});

async function fetchSuggestion(payload) {
  const requestBody = JSON.stringify(payload);
  let lastError = null;

  for (let attempt = 0; attempt <= SUGGESTION_RETRY_COUNT; attempt++) {
    const attemptNumber = attempt + 1;

    try {
      console.log("[waBridge] Fetching suggestion", {
        attempt: attemptNumber,
        contactName: payload.contactName,
        provider: payload.provider,
        historyLength: Array.isArray(payload.chatHistory) ? payload.chatHistory.length : 0,
      });

      const response = await fetchWithTimeout(
        `${MCP_SERVER}/suggest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        SUGGESTION_TIMEOUT_MS
      );

      if (!response.ok) {
        const rawBody = await response.text();
        let message = `MCP server error: ${response.status}`;

        try {
          const parsed = JSON.parse(rawBody);
          if (parsed?.error) {
            message = parsed.error;
          }
        } catch {
          if (rawBody.trim()) {
            message = `${message} - ${rawBody.trim().slice(0, 300)}`;
          }
        }

        throw new Error(message);
      }

      const data = await response.json();
      console.log("[waBridge] Suggestion fetch succeeded", {
        attempt: attemptNumber,
        contactName: payload.contactName,
      });
      return data.reply;
    } catch (error) {
      lastError = error;

      if (attempt === SUGGESTION_RETRY_COUNT || !isRetryableError(error)) {
        break;
      }
    }
  }

  throw new Error(getFriendlySuggestionError(lastError));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRetryableError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.name === "AbortError" || message.includes("failed to fetch");
}

function getFriendlySuggestionError(error) {
  if (!error) return "Server not reachable";

  if (error.name === "AbortError") {
    return `Suggestion request timed out after ${Math.round(SUGGESTION_TIMEOUT_MS / 1000)}s. The bridge is probably running, but the selected model may be too slow.`;
  }

  const message = String(error.message || "");
  if (/failed to fetch/i.test(message)) {
    return `Could not reach waBridge at ${MCP_SERVER}. Make sure the local bridge server is running and the extension has been reloaded.`;
  }

  return message;
}
