# WhatsApp LLM Bridge

`waBridge` connects WhatsApp Web to a local model running in LM Studio. It pairs a Chrome extension with a small Express server so you can generate suggested replies, optionally call MCP tools, and keep lightweight contact memory on your machine.

## Overview

- Local-first reply suggestions for WhatsApp Web
- LM Studio integration through the OpenAI-compatible chat API
- Optional MCP tool access for file, web, GitHub, and memory workflows
- Simple contact memory stored in `contacts.json`
- Image context caching stored in `image-contexts.json`

## How it works

```text
WhatsApp Web
  -> Chrome extension
  -> POST /suggest
  -> waBridge server
  -> LM Studio
  -> optional MCP tool calls
  -> suggested reply
  -> extension panel
```

## Repository layout

```text
.
|- server.js
|- mcp-manager.js
|- memory-store.js
|- image-context-store.js
|- contacts.json
|- image-contexts.json
\- chromsideEx/
   |- manifest.json
   |- background.js
   |- content.js
   |- popup.html
   \- panel.css
```

## Requirements

- Node.js
- LM Studio with at least one loaded model
- Chrome or any Chromium-based browser
- Optional MCP servers installed in your LM Studio MCP directory

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create your environment file

```bash
copy .env.example .env
```

Then update `.env` with the correct local paths and values:

| Variable | Purpose |
|---|---|
| `LM_STUDIO_URL` | LM Studio server URL, usually `http://localhost:1234` |
| `DEFAULT_MODEL` | Default model id to use for suggestions |
| `PORT` | Local bridge port, default `3000` |
| `NODE_BIN` | Full path to `node.exe` |
| `MCP_BASE` | Base folder containing your MCP servers |
| `ALLOWED_DIR` | Allowed root directory for `file-reader` |
| `GITHUB_TOKEN` | Optional token for `github-reader` |
| `LM_API_KEY` | Optional API key if your LM Studio server requires one |
| `ENABLE_MCP_TOOLS` | Set to `true` to allow automatic tool use |

### 3. Start LM Studio

Load a model in LM Studio and start the local server.

### 4. Start the bridge server

```bash
npm start
```

For watch mode during development:

```bash
npm run dev
```

### 5. Load the Chrome extension

1. Open `chrome://extensions`
2. Turn on Developer Mode
3. Click Load unpacked
4. Choose the `chromsideEx` folder

The extension targets `http://localhost:3000` by default. If you change `PORT`, update `MCP_SERVER` in `chromsideEx/background.js` as well.

### 6. Verify the installation

Open these endpoints in your browser:

- `http://localhost:3000/health`
- `http://localhost:3000/status`

## MCP integration

On startup, the bridge attempts to launch these MCP servers:

- `file-reader`
- `web-summarizer`
- `github-reader`
- `memory-mcp`

If one server fails, the bridge continues running with the rest of the available tools.

## Reply generation behavior

The `POST /suggest` endpoint accepts message text plus optional chat and image context.

- Text-only requests can use MCP tools when `ENABLE_MCP_TOOLS=true` and the selected model appears capable enough
- Image requests use a multimodal prompt path instead of the MCP tool loop
- If the first result looks malformed or schema-like, the bridge retries with a simpler prompt
- Tool use is capped at `5` rounds in the current implementation

## API reference

### `GET /health`

Returns:

- bridge status
- LM Studio availability
- detected model list
- MCP readiness summary

### `GET /status`

Returns:

- bridge status
- configured port
- LM Studio URL
- available tool names
- number of saved contacts

### `POST /suggest`

Example request body:

```json
{
  "message": "Can you check the screenshot?",
  "contactName": "Budi",
  "chatHistory": [],
  "model": "local-model",
  "systemPrompt": "You are a helpful WhatsApp assistant.",
  "useTools": true,
  "imageDataUrl": "data:image/png;base64,...",
  "latestImageKey": "chat-123:last-image",
  "forceImageRefresh": false
}
```

Field notes:

- `message` is required
- `chatHistory` should use chat-completions style message objects
- `useTools` can force-enable or disable MCP tool usage
- `imageDataUrl` enables image-aware reply generation
- `latestImageKey` and `forceImageRefresh` control image-summary caching

### Memory endpoints

- `GET /memory`
- `GET /memory/:name`
- `PUT /memory/:name`
- `DELETE /memory/:name`
- `DELETE /image-context/:name`

Contact memory is intentionally lightweight. The bridge automatically tracks message count and last-seen time, but structured memory updates are manual.

## Troubleshooting

| Problem | Fix |
|---|---|
| LM Studio is offline | Start the LM Studio local server and verify `LM_STUDIO_URL` |
| MCP tools do not appear | Check `MCP_BASE`, `NODE_BIN`, and confirm each MCP server contains `server.js` |
| `file-reader` cannot access files | Make sure `ALLOWED_DIR` points to a valid readable directory |
| GitHub tool fails | Set a valid `GITHUB_TOKEN` in `.env` |
| The extension cannot reach the bridge | Confirm the bridge is running and `MCP_SERVER` in `chromsideEx/background.js` matches your current port |
| Tool calling is unreliable | Enable `ENABLE_MCP_TOOLS=true` and use a model that supports tool use well |
| Image requests fail | Reduce the image size or crop the screenshot before sending |
