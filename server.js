import fs from "fs";
import express from "express";
import cors from "cors";
import { McpManager } from "./mcp-manager.js";
import {
  getContact,
  getAllContacts,
  upsertContact,
  deleteContact,
  trackMessage,
  formatMemory,
} from "./memory-store.js";
import { deleteImageContext, getImageContext, upsertImageContext } from "./image-context-store.js";

loadEnvFile();

const PORT = process.env.PORT || 3000;
const LM_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const LM_API_KEY = process.env.LM_API_KEY || "";
const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || "";
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || "waBridge";
const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "local").toLowerCase() === "openrouter" ? "openrouter" : "local";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "local-model";
const DEFAULT_OPENROUTER_MODEL = process.env.DEFAULT_OPENROUTER_MODEL || "openrouter/free";
const DEFAULT_OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "google/gemma-3-4b-it:free";
const OPENROUTER_MODELS = parseConfiguredModels(
  process.env.OPENROUTER_MODELS,
  [
    DEFAULT_OPENROUTER_MODEL,
    "openrouter/free",
  ]
);
const MAX_TOOL_ROUNDS = 5;
const ENABLE_MCP_TOOLS = String(process.env.ENABLE_MCP_TOOLS || "false").toLowerCase() === "true";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful WhatsApp assistant. " +
  "Reply concisely and naturally - this is a WhatsApp message, not an essay. " +
  "Reply in the same language the user is writing in.";

const mcpManager = new McpManager();
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "12mb" }));

console.log("\n==============================================");
console.log("  WhatsApp LLM Bridge - Starting Up");
console.log("==============================================\n");

await mcpManager.start();

app.get("/health", async (_req, res) => {
  const localModels = await getLocalModels();
  const lmStatus = localModels.length ? "online" : "offline";

  res.json({
    status: "ok",
    provider: DEFAULT_PROVIDER,
    lmStudio: lmStatus,
    openrouter: OPENROUTER_API_KEY ? "configured" : "missing_api_key",
    model: DEFAULT_PROVIDER === "openrouter" ? DEFAULT_OPENROUTER_MODEL : (localModels[0] || DEFAULT_MODEL),
    models: localModels,
    openrouterModels: OPENROUTER_MODELS,
    mcp: mcpManager.status(),
  });
});

app.get("/status", (_req, res) => {
  res.json({
    bridge: "running",
    port: PORT,
    lmStudio: LM_URL,
    defaultProvider: DEFAULT_PROVIDER,
    openrouterConfigured: Boolean(OPENROUTER_API_KEY),
    mcpServers: mcpManager.status(),
    availableTools: mcpManager.getToolsForLLM().map((tool) => tool.function.name),
    contacts: Object.keys(getAllContacts()).length,
  });
});

app.get("/providers", async (_req, res) => {
  const localModels = await getLocalModels();
  res.json({
    defaultProvider: DEFAULT_PROVIDER,
    providers: [
      {
        id: "local",
        label: "Local Model",
        hint: localModels.length
          ? `Using models currently exposed by LM Studio at ${LM_URL}.`
          : "No local models detected. Start LM Studio and load a model.",
        models: mapModelOptions(localModels, DEFAULT_MODEL),
      },
      {
        id: "openrouter",
        label: "OpenRouter API",
        hint: OPENROUTER_API_KEY
          ? `Using the curated OpenRouter model list from waBridge. Image requests automatically use ${DEFAULT_OPENROUTER_VISION_MODEL}.`
          : "Set OPENROUTER_API_KEY in your environment before using OpenRouter.",
        models: mapModelOptions(OPENROUTER_MODELS, DEFAULT_OPENROUTER_MODEL),
      },
    ],
  });
});

app.post("/suggest", async (req, res) => {
  const {
    message,
    contactName = "Contact",
    chatHistory = [],
    provider = DEFAULT_PROVIDER,
    model,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    useTools,
    imageDataUrl,
    latestImageKey,
    forceImageRefresh,
  } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const selectedProvider = provider === "openrouter" ? "openrouter" : "local";
  const selectedModel = model || (selectedProvider === "openrouter" ? DEFAULT_OPENROUTER_MODEL : DEFAULT_MODEL);
  const selectedVisionModel = selectedProvider === "openrouter"
    ? DEFAULT_OPENROUTER_VISION_MODEL
    : selectedModel;

  console.log(`\n[Bridge] Provider: ${selectedProvider} | Contact: ${contactName} | Message: "${message.slice(0, 60)}"`);

  try {
    const imageContextSummary = await resolveImageContext({
      contactName,
      latestImageKey,
      imageDataUrl,
      provider: selectedProvider,
      model: imageDataUrl ? selectedVisionModel : selectedModel,
      forceImageRefresh,
    });

    const reply = await generateReply({
      message,
      contactName,
      chatHistory,
      provider: selectedProvider,
      model: imageDataUrl ? selectedVisionModel : selectedModel,
      systemPrompt,
      useTools,
      imageDataUrl,
      imageContextSummary,
    });

    trackMessage(contactName);

    console.log(`[Bridge] Reply: "${reply.slice(0, 80)}"`);
    res.json({ reply });
  } catch (err) {
    console.error("[Bridge] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/memory", (_req, res) => {
  const all = getAllContacts();
  const summary = Object.values(all).map((contact) => ({
    name: contact.name,
    messageCount: contact.messageCount || 0,
    lastSeen: contact.lastSeen,
    topicsCount: contact.topics?.length || 0,
  }));
  res.json({ contacts: summary });
});

app.get("/memory/:name", (req, res) => {
  const contact = getContact(req.params.name);
  if (!contact) {
    return res.status(404).json({ error: `No memory for "${req.params.name}"` });
  }
  res.json({ contact: formatMemory(contact) });
});

app.put("/memory/:name", (req, res) => {
  const { style, topics, notes } = req.body;
  const updated = upsertContact(req.params.name, {
    ...(style !== undefined && { style }),
    ...(topics !== undefined && { topics: Array.isArray(topics) ? topics : [topics] }),
    ...(notes !== undefined && { notes }),
  });
  console.log(`[Memory] Manual write for "${req.params.name}"`);
  res.json({ contact: formatMemory(updated) });
});

app.delete("/memory/:name", (req, res) => {
  const deleted = deleteContact(req.params.name);
  if (!deleted) {
    return res.status(404).json({ error: "Contact not found" });
  }
  res.json({ ok: true, deleted: req.params.name });
});

app.delete("/image-context/:name", (req, res) => {
  deleteImageContext(req.params.name);
  res.json({ ok: true, cleared: req.params.name });
});

app.listen(PORT, () => {
  console.log("\n==============================================");
  console.log(`  Bridge      : http://localhost:${PORT}`);
  console.log(`  LM Studio   : ${LM_URL}`);
  console.log(`  OpenRouter  : ${OPENROUTER_API_KEY ? "configured" : "not configured"}`);
  console.log(`  Tools       : ${mcpManager.allTools.length}`);
  console.log("==============================================\n");
});

app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Image payload too large. Try a smaller image or crop the visible photo before analyzing.",
    });
  }
  return next(err);
});

process.on("SIGINT", () => {
  mcpManager.stopAll();
  process.exit(0);
});

async function generateWithTools({ message, contactName, chatHistory, provider, model, systemPrompt }) {
  const tools = mcpManager.getToolsForLLM();
  const messages = [
    { role: "system", content: `${systemPrompt}\n\nYou are replying on behalf of the user in a WhatsApp conversation with ${contactName}.` },
    ...chatHistory.slice(-8),
    { role: "user", content: `New message from ${contactName}: "${message}"\n\nGenerate a suitable WhatsApp reply.` },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await providerFetch(provider, "POST", "/chat/completions", {
      model,
      messages,
      max_tokens: 1000,
      temperature: 0.7,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    });

    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error(provider === "openrouter" ? "No response from OpenRouter" : "No response from LM Studio");
    }

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
      const text = assistantMsg.content?.trim();
      if (text) return text;
    }

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls?.length) {
      return extractReplyText(response) || "Sorry, I couldn't generate a reply.";
    }

    for (const call of toolCalls) {
      let toolArgs = {};
      try {
        toolArgs = JSON.parse(call.function.arguments || "{}");
      } catch {
        toolArgs = {};
      }

      let toolResult;
      try {
        toolResult = await mcpManager.executeTool(call.function.name, toolArgs);
      } catch (err) {
        toolResult = `Tool error: ${err.message}`;
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: String(toolResult) });
    }
  }

  const fallback = await providerFetch(provider, "POST", "/chat/completions", {
    model,
    max_tokens: 500,
    temperature: 0.7,
    messages: [...messages, { role: "user", content: "Give your final WhatsApp reply now." }],
  });

  return extractReplyText(fallback) || "Sorry, I couldn't generate a reply.";
}

async function generateReply({ message, contactName, chatHistory, provider, model, systemPrompt, useTools, imageDataUrl, imageContextSummary }) {
  const useMcpTools = !imageDataUrl && shouldUseTools({ provider, model, useTools });

  const primaryReply = useMcpTools
    ? await generateWithTools({ message, contactName, chatHistory, provider, model, systemPrompt })
    : await generatePlainReply({ message, contactName, chatHistory, provider, model, systemPrompt, imageDataUrl, imageContextSummary });

  if (!looksLikeGibberish(primaryReply)) {
    return primaryReply;
  }

  console.warn(`[Bridge] Detected low-quality model output from "${model}". Retrying with minimal prompt.`);
  return generatePlainReply({
    message,
    contactName,
    chatHistory: [],
    provider,
    model,
    systemPrompt,
    imageDataUrl,
    imageContextSummary,
  });
}

async function generatePlainReply({ message, contactName, chatHistory, provider, model, systemPrompt, imageDataUrl, imageContextSummary }) {
  const latestUserPrompt = imageDataUrl
    ? [
        {
          type: "text",
          text:
            `Latest context from ${contactName}: "${message}"\n\n` +
            "Analyze the attached WhatsApp image and write one clear reply the user could send back. " +
            "If the image does not need a reply, briefly describe it and suggest a useful response anyway. " +
            "Do not explain your reasoning.",
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl,
          },
        },
      ]
    : buildTextOnlyPrompt({ message, contactName, imageContextSummary });

  const messages = [
    {
      role: "system",
      content:
        `${systemPrompt}\n\n` +
        `You are replying on behalf of the user in a WhatsApp conversation with ${contactName}. ` +
        "Write only the final reply text. Keep it natural, short, and coherent.",
    },
    ...chatHistory.slice(imageDataUrl ? -2 : -4),
    {
      role: "user",
      content: latestUserPrompt,
    },
  ];

  const response = await createChatCompletionWithFallback({
    provider,
    model,
    systemPrompt,
    contactName,
    chatHistory: chatHistory.slice(imageDataUrl ? -2 : -4),
    userContent: latestUserPrompt,
    maxTokens: 160,
    temperature: 0.5,
  });

  const text = extractReplyText(response);
  if (!text) {
    throw new Error(buildEmptyResponseError(provider, response));
  }
  return text;
}

async function resolveImageContext({ contactName, latestImageKey, imageDataUrl, provider, model, forceImageRefresh }) {
  if (!latestImageKey) return "";

  const cached = getImageContext(contactName);
  const cacheMatches = cached?.imageKey === latestImageKey;

  if (cacheMatches && !forceImageRefresh) {
    return cached.summary || "";
  }

  if (!imageDataUrl) {
    return "";
  }

  const summary = await generateImageSummary({ contactName, imageDataUrl, provider, model });
  upsertImageContext(contactName, {
    imageKey: latestImageKey,
    summary,
  });
  return summary;
}

async function generateImageSummary({ contactName, imageDataUrl, provider, model }) {
  const response = await createChatCompletionWithFallback({
    provider,
    model,
    systemPrompt:
      "Summarize the attached WhatsApp image for future reply context. " +
      "Return a short factual summary under 80 words. Focus on what matters for follow-up chat replies.",
    contactName,
    chatHistory: [],
    userContent: [
      {
        type: "text",
        text: `Create a compact image context summary for the chat with ${contactName}.`,
      },
      {
        type: "image_url",
        image_url: {
          url: imageDataUrl,
        },
      },
    ],
    maxTokens: 120,
    temperature: 0.2,
  });

  const summary = extractReplyText(response);
  if (!summary) {
    return "";
  }
  return summary;
}

function buildTextOnlyPrompt({ message, contactName, imageContextSummary }) {
  let prompt = `Latest message from ${contactName}: "${message}"\n\n`;
  if (imageContextSummary) {
    prompt += `Relevant image context from this chat: ${imageContextSummary}\n\n`;
  }
  prompt += "Write one clear WhatsApp reply. Do not explain your reasoning.";
  return prompt;
}

function shouldUseTools({ provider, model, useTools }) {
  if (typeof useTools === "boolean") return useTools;
  if (provider !== "local") return false;
  if (!ENABLE_MCP_TOOLS) return false;

  const lowerModel = String(model || "").toLowerCase();
  const knownSmallModels = ["phi-3", "mini", "3b", "1b", "2b", "4k"];
  return !knownSmallModels.some((token) => lowerModel.includes(token));
}

function looksLikeGibberish(text) {
  if (!text) return true;

  const trimmed = text.trim();
  if (trimmed.length < 2) return true;

  const weirdPunctuation = (trimmed.match(/[{}\[\]\\/_]{6,}|["',]\s*["',]/g) || []).length;
  const repeatedFragments = (trimmed.match(/\b(description|required|type|properties|schema|input)\b/gi) || []).length;
  const alphaChars = (trimmed.match(/[A-Za-z]/g) || []).length;
  const spaceChars = (trimmed.match(/\s/g) || []).length;
  const punctuationChars = (trimmed.match(/[^\w\s]/g) || []).length;

  if (repeatedFragments >= 3) return true;
  if (weirdPunctuation >= 2) return true;
  if (alphaChars > 0 && punctuationChars > alphaChars) return true;
  if (trimmed.length > 80 && spaceChars < 6) return true;

  return false;
}

async function lmFetch(method, path, body = null) {
  const url = buildApiUrl(LM_URL, path);
  const headers = { "Content-Type": "application/json" };
  if (LM_API_KEY) headers.Authorization = `Bearer ${LM_API_KEY}`;

  const res = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LM Studio ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function openRouterFetch(method, path, body = null) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter is selected but OPENROUTER_API_KEY is not configured.");
  }

  const url = buildApiUrl(OPENROUTER_URL, path);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  };

  if (OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = OPENROUTER_SITE_URL;
  }
  if (OPENROUTER_SITE_NAME) {
    headers["X-Title"] = OPENROUTER_SITE_NAME;
  }

  const res = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function providerFetch(provider, method, path, body = null) {
  return provider === "openrouter"
    ? openRouterFetch(method, path, body)
    : lmFetch(method, path, body);
}

async function createChatCompletionWithFallback({
  provider,
  model,
  systemPrompt,
  contactName,
  chatHistory,
  userContent,
  maxTokens,
  temperature,
}) {
  const primaryMessages = [
    {
      role: "system",
      content:
        `${systemPrompt}\n\n` +
        `You are replying on behalf of the user in a WhatsApp conversation with ${contactName}.`,
    },
    ...chatHistory,
    {
      role: "user",
      content: userContent,
    },
  ];

  try {
    return await providerFetch(provider, "POST", "/chat/completions", {
      model,
      messages: primaryMessages,
      max_tokens: maxTokens,
      temperature,
    });
  } catch (error) {
    if (!shouldRetryWithoutSystemPrompt(provider, error)) {
      throw error;
    }

    const fallbackMessages = [
      ...chatHistory,
      {
        role: "user",
        content: mergeSystemPromptIntoUserContent(systemPrompt, contactName, userContent),
      },
    ];

    return providerFetch(provider, "POST", "/chat/completions", {
      model,
      messages: fallbackMessages,
      max_tokens: maxTokens,
      temperature,
    });
  }
}

function shouldRetryWithoutSystemPrompt(provider, error) {
  if (provider !== "openrouter") return false;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("developer instruction is not enabled");
}

function mergeSystemPromptIntoUserContent(systemPrompt, contactName, userContent) {
  const prefix =
    `${systemPrompt}\n\n` +
    `You are replying on behalf of the user in a WhatsApp conversation with ${contactName}.`;

  if (Array.isArray(userContent)) {
    const [firstPart, ...rest] = userContent;
    if (firstPart?.type === "text") {
      return [
        {
          ...firstPart,
          text: `${prefix}\n\n${firstPart.text}`,
        },
        ...rest,
      ];
    }

    return [{ type: "text", text: prefix }, ...userContent];
  }

  return `${prefix}\n\n${String(userContent || "")}`;
}

async function getLocalModels() {
  try {
    const response = await lmFetch("GET", "/models");
    return response.data?.map((model) => model.id).filter(Boolean) || [];
  } catch {
    return [];
  }
}

function buildApiUrl(baseUrl, path) {
  const normalizedBase = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (/\/(?:api\/)?v1$/i.test(normalizedBase)) {
    return `${normalizedBase}${normalizedPath.startsWith("/v1/") ? normalizedPath.slice(3) : normalizedPath}`;
  }

  return `${normalizedBase}${normalizedPath.startsWith("/v1/") ? normalizedPath : `/v1${normalizedPath}`}`;
}

function mapModelOptions(models, preferredModel) {
  return dedupeStrings(models).map((modelId) => ({
    id: modelId,
    label: modelId,
    recommended: modelId === preferredModel,
  }));
}

function parseConfiguredModels(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return dedupeStrings(parsed.length ? parsed : fallback);
}

function dedupeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function extractReplyText(response) {
  const choice = response?.choices?.[0];
  if (!choice) return "";

  const message = choice.message || {};
  const directContent = normalizeMessageContent(message.content);
  if (directContent) return directContent;

  const refusal = normalizeMessageContent(message.refusal);
  if (refusal) return refusal;

  const reasoning = normalizeMessageContent(message.reasoning);
  if (reasoning) return reasoning;

  const toolCallText = Array.isArray(message.tool_calls)
    ? message.tool_calls
      .map((call) => normalizeMessageContent(call?.function?.arguments))
      .filter(Boolean)
      .join("\n")
    : "";

  return toolCallText.trim();
}

function normalizeMessageContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") {
        return part.text || "";
      }
      if (typeof part?.content === "string") {
        return part.content;
      }
      return "";
    })
    .join("\n")
    .trim();
}

function buildEmptyResponseError(provider, response) {
  const providerName = provider === "openrouter" ? "OpenRouter" : "LM Studio";
  const choice = response?.choices?.[0];
  const finishReason = choice?.finish_reason ? ` finish_reason=${choice.finish_reason}.` : "";
  const message = choice?.message || {};
  const previewObject = {
    id: response?.id,
    model: response?.model,
    finish_reason: choice?.finish_reason || "",
    content_type: Array.isArray(message.content) ? "array" : typeof message.content,
    refusal: normalizeMessageContent(message.refusal).slice(0, 120),
    reasoning: normalizeMessageContent(message.reasoning).slice(0, 120),
  };

  return `Empty response from ${providerName}.${finishReason} Preview: ${JSON.stringify(previewObject)}`;
}

function loadEnvFile() {
  const envPath = ".env";
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}




