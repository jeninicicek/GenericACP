# Generic ACP Agent

A thin [Agent Client Protocol](https://agentclientprotocol.com) agent that connects JetBrains AI Assistant to any OpenAI-compatible API: OpenAI, Azure OpenAI, OpenRouter, Ollama, LM Studio, vLLM, or another server that speaks the same HTTP API.

One process, one configuration. Provider differences are `baseUrl`, `apiKey`, `model`, and optional headers. The implementation is the ACP session, tool calls, and the OpenAI HTTP API.

```text
JetBrains AI Assistant
        │  ACP over stdio
        ▼
Generic ACP Agent
        │  Chat Completions or Responses API
        ▼
OpenAI-compatible host
```

## What it does

- Streams assistant text and reasoning into the IDE.
- Calls `read_file`, `write_file`, and `run_terminal` through the client's permission and filesystem APIs, and calls tools from MCP servers the client passes in (stdio, HTTP, SSE, and ACP).
- Keeps session history. With `sessionDir`, sessions survive a process restart (`session/list`, `session/resume`, `session/load`, `session/fork`, `session/delete`).
- Lists models from `GET /v1/models` and lets the IDE switch model, tool choice, reasoning effort, image detail, and parallel tool calls.
- Accepts several hosts in one process. The model id is then `endpointId:modelId`.
- Sends Chat Completions by default. `apiMode: "responses"` uses `/v1/responses` and falls back to Chat Completions when that route is missing.
- Sends optional `responseSchema` as structured output and drops it if the host rejects it.
- Maps image blocks to `image_url`. Audio blocks are sent only when `audioSupport` is on.
- Shrinks a prompt that does not fit the context window read from the model record (`loaded_context_length`, otherwise the advertised max). `GENERIC_ACP_CONTEXT_TOKENS` overrides that number.
- Waits 30 minutes for a silent local model (`requestTimeoutMs` or `GENERIC_ACP_REQUEST_TIMEOUT_MS`). Node's fetch otherwise closes the socket after five minutes.
- Reports provider failures as an `[Error: …]` message and `end_turn`. ACP has no error stop reason.

## Requirements

Node.js 20 or newer.

```bash
npm install
npm run build
npm start
```

`npm run dev` runs `src/main.ts` without a build. `npm test` typechecks and runs the unit and stdio tests.

## Configuration

Copy `config.example.json` to `config.json`, or set `GENERIC_ACP_CONFIG` to a JSON file. Environment variables override the file.

One host:

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-v1-replace-me",
  "model": "inclusionai/ling-3.0-flash-sante:free"
}
```

The same three values are `GENERIC_ACP_BASE_URL`, `GENERIC_ACP_API_KEY`, and `GENERIC_ACP_MODEL`.

Several hosts. The first entry is the default model. Ids are letters, digits, `_`, and `-`. A model id may itself contain a colon; the picker still splits on the first colon.

```json
{
  "endpoints": [
    {
      "id": "lmstudio",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "apiKey": "lmstudio",
      "model": "prism-ml/bonsai-27b"
    },
    {
      "id": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-v1-replace-me",
      "model": "inclusionai/ling-3.0-flash-sante:free"
    }
  ]
}
```

`GENERIC_ACP_ENDPOINTS` is that array as one JSON string. Headers that belong to one host go on that endpoint. Top-level `headers` apply only to endpoints that do not set their own.

Other fields in the same file:

| Field | Role |
|---|---|
| `apiMode` | `chat-completions` (default) or `responses` |
| `responseSchema` | JSON schema for structured output |
| `headers` | Extra HTTP headers |
| `imageSupport` | Advertise and send images (default on) |
| `audioSupport` | Send `input_audio` for wav and mp3 (default off) |
| `requestTimeoutMs` | Header and body silence limit, default 30 minutes |
| `contextTokens` | Context window override |
| `request` | `instructions`, `temperature`, `topP`, `maxTokens`, `stop`, `seed`, penalties, `toolChoice`, `parallelToolCalls`, `reasoningEffort`, `imageDetail` |
| `modes` | Named presets. A mode `model` uses the `endpointId:modelId` form when more than one endpoint is configured |
| `commands` | Slash commands. `/name` is rewritten to the command description |
| `includeOpenDocuments` | Attach editor text from document notifications (default off) |
| `sessionDir` | Directory of session JSON files |

Azure OpenAI needs `api-version` on the URL, for example `https://your-resource.openai.azure.com/openai/deployments/your-deployment?api-version=2024-10-21`. The client does not add that query itself.

Per-provider notes and what has been run live are in `PROVIDERS.md`.

## JetBrains

AI Assistant starts the built agent on stdio. The launcher config is `~/.jetbrains/acp.json`. This repository's `config.json` is not read unless you set `GENERIC_ACP_CONFIG`.

```json
{
  "agent_servers": {
    "Generic ACP": {
      "command": "node",
      "args": ["C:\\DEV\\GenericACP\\dist\\main.js"],
      "env": {
        "GENERIC_ACP_ENDPOINTS": "[{\"id\":\"lmstudio\",\"baseUrl\":\"http://127.0.0.1:1234/v1\",\"apiKey\":\"lmstudio\",\"model\":\"local-model\"},{\"id\":\"openrouter\",\"baseUrl\":\"https://openrouter.ai/api/v1\",\"apiKey\":\"sk-or-v1-replace-me\",\"model\":\"inclusionai/ling-3.0-flash-sante:free\"}]"
      }
    }
  }
}
```

Restart the agent after changing that file or rebuilding `dist/main.js`.

## Layout

```text
src/
├── main.ts                 stdio entry
├── acp/
│   ├── agent.ts            ACP Agent implementation
│   ├── session.ts          in-memory sessions and optional JSON files
│   ├── content.ts          ACP content blocks ↔ OpenAI message content
│   ├── controls.ts         modes, config options, slash commands
│   └── documents.ts        open editor buffers
├── openai/
│   ├── provider.ts         one OpenAI client
│   ├── streaming.ts        Chat Completions stream
│   ├── responses.ts        Responses API stream
│   ├── tools.ts            built-in tools
│   ├── sampling.ts         standard request fields
│   ├── model-info.ts       model list and context window
│   ├── context.ts          shrink a prompt that does not fit
│   └── http.ts             long fetch timeouts
├── mcp/                    MCP clients (stdio, HTTP, SSE, ACP)
└── config/                 config.json and env loading
```

## Out of scope

Next-edit suggestions, elicitation, a planning engine, and automatic failover from one host to another. Choosing another endpoint is a model-list selection, not a retry.
