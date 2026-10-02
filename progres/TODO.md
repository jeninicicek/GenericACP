# Generic ACP Agent — TODO

## Overview

This document lists all remaining tasks for the Generic ACP Agent project. Each item links to a detailed specification file in the `progres/` folder.

## Priority Legend

- **P0** — Critical: Required for basic functionality
- **P1** — High: Important for production use
- **P2** — Medium: Nice to have, improves user experience
- **P3** — Low: Future enhancements

---

## Tasks

### 1. Tool Calling
**Priority:** P0  
**Status:** Implemented  
**Spec:** [01-tool-calling.md](./01-tool-calling.md)

Bridge OpenAI function-calling responses into ACP `tool_call` / `tool_call_update` session updates, request permission via `RequestPermissionRequest`, and execute via the client's filesystem and terminal capabilities.

---

### 2. MCP Bridging
**Priority:** P0  
**Status:** Implemented  
**Spec:** [02-mcp-bridging.md](./02-mcp-bridging.md)

`src/mcp/client.ts` and `src/mcp/bridge.ts` connect stdio, HTTP, SSE, and ACP MCP servers from `newSession`, namespace tools as `serverName_toolName`, and route calls. `session/cancel` leaves the bridge up.

---

### 3. Session Load
**Priority:** P2  
**Status:** Implemented  
**Spec:** [03-session-load.md](./03-session-load.md)

`initialize` advertises `loadSession: true`. History is replayed as `session/update` notifications because `LoadSessionResponse` has no `messages` field. With `sessionDir` (task 12) the same JSON is reloaded after a restart; without it, sessions last for the life of the process (1-hour memory TTL).

---

### 4. Structured Output / Responses API
**Priority:** P1  
**Status:** Implemented  
**Spec:** [04-structured-output-responses-api.md](./04-structured-output-responses-api.md)

Chat Completions is the default. `apiMode: "responses"` streams `/v1/responses` and falls back to chat completions on 404 or an unsupported endpoint. `responseSchema` is sent as `response_format` or Responses `text.format`, and dropped on a 400/422.

---

### 5. Image / Audio Content Blocks
**Priority:** P2  
**Status:** Implemented  
**Spec:** [05-image-audio-content.md](./05-image-audio-content.md)

`contentBlocksToMessageContent()` maps image blocks to `image_url` (advertised by default) and, when `audioSupport` is on, audio blocks to `input_audio`. See task 16 for the audio switch.

---

### 6. Real-world Validation
**Priority:** P0  
**Status:** In Progress (LM Studio, OpenRouter, and OpenCode Zen: text + streaming + tools. OpenRouter free models: vision on `dots-studio/dots-3-note-preview:free`, structured output on `liquid/lfm-2.5-2.6b:free`, and a live 429 on `google/gemma-4-31b-it:free`. LM Studio vision is rejected by that engine. OpenAI, Azure, Ollama, and JetBrains still blocked)  
**Spec:** [06-real-world-validation.md](./06-real-world-validation.md)

Edge cases (network drop, long conversations, large responses, concurrency) pass in `scripts/test-edge-cases.ts`. Live text, streaming, and tools passed on LM Studio, OpenRouter, and OpenCode Zen. Still open: OpenAI, Azure, Ollama, a live rate limit, JetBrains UI, and vision on a model whose engine accepts images. Details are in the status line and in `PROVIDERS.md`.

---

### 7. Error Handling Polish
**Priority:** P1  
**Status:** Implemented  
**Spec:** [07-error-handling.md](./07-error-handling.md)

`src/errors.ts` classifies auth, rate limit, network (including a mid-stream drop and an inactivity timeout), model, and unknown errors. `prompt()` sends an `[Error: …]` chunk and returns `end_turn` instead of throwing. ACP v1 has no error stop reason.

---

### 8. Automated Tests
**Priority:** P0  
**Status:** Implemented  
**Spec:** [08-automated-tests.md](./08-automated-tests.md)

`npm test` builds then runs Vitest. Unit tests cover config, content, session, errors, chat-completions retry, Responses history, request settings, and `OpenAiProvider`. `test/integration/agent.test.ts` covers stop reasons, cancel (permission + terminal), and MCP survival. `test/integration/stdio-scripts.test.ts` runs the mock stdio scripts. `npm run test:coverage` requires 70% statement and line coverage of `src/` except `src/main.ts`.

---

### 9. Protocol Conformance — Omitted Fields
**Priority:** P1  
**Status:** Implemented  
**Spec:** [09-protocol-conformance.md](./09-protocol-conformance.md)

Audit of protocol objects we construct with fewer fields than the SDK schema supports (same class of bug as the `requestPermission.toolCall` missing `title`, found during live LM Studio validation). Implemented: `agentInfo` in `initialize` (name + version from package.json); `messageId` on streamed `agent_message_chunk`s (per-turn); `agent_thought_chunk` for reasoning deltas; `rawInput`/`rawOutput`/`name` on pending, permission-request, and completed tool calls; `locations` for `read_file`/`write_file`; `PromptResponse.usage` (chat + Responses modes); and `status:"failed"` for failing tool executions instead of `completed`. Verified by `scripts/test-conformance.ts` (24 assertions) plus all mock regressions and a live OpenRouter run.

---

### 10. OpenAI request settings
**Priority:** P1  
**Status:** Implemented  

Pass standard Chat Completions / Responses request fields from config (`config.json` or `GENERIC_ACP_*`), and advertise the user-facing ones through `session/set_config_option`:

- `instructions` (system message)
- `temperature`, `top_p`
- `max_tokens` / `max_completion_tokens`
- `stop`, `seed`
- `presence_penalty`, `frequency_penalty`
- `tool_choice`, `parallel_tool_calls`
- `reasoning_effort` for reasoning models
- image `detail` (`auto` / `low` / `high`) when `imageSupport` is on

No provider-specific branches. A server that rejects a field is skipped the same way `response_format` and `stream_options` already are.

---

### 11. Model catalog and model switch
**Priority:** P1  
**Status:** Implemented  

`GET /v1/models` (falling back to `/api/v0/models`) fills the `model` config option. One `baseUrl` stays a single endpoint with bare model ids. `endpoints` or `GENERIC_ACP_ENDPOINTS` adds more: each gets its own client, and the model option is `endpointId:modelId` (the model id may itself contain a colon). A down endpoint keeps its configured model and does not drop the others. `providers/list` lists those endpoints; `providers/disable` is rejected. The API key stays in agent config.

---

### 12. Session list, resume, delete, and fork
**Priority:** P2  
**Status:** Implemented  

`sessionDir` (config or `GENERIC_ACP_SESSION_DIR`) stores each session as JSON. `session/list`, `session/resume`, `session/delete`, and `session/fork` are advertised and implemented. Files stay after the 1-hour memory prune and after `session/close`, and are removed by `session/delete` or after 7 days. Fork copies stored history into a new id. Without `sessionDir`, list/resume/fork still work for sessions held in memory.

---

### 13. Modes
**Priority:** P2  
**Status:** Implemented  

Config presets (`modes`: name plus model, temperature, instructions, tool_choice). Advertised on session create/load/resume and applied by `session/set_mode`. A mode only changes the settings sent on the next OpenAI request. `default` is always listed.

---

### 14. Slash commands
**Priority:** P3  
**Status:** Implemented  

Optional config list of commands. On `session/new`, `load`, and `resume`, send `available_commands_update`. A `/name` prompt is rewritten to the command description plus the rest of the text.

---

### 15. Open documents as prompt context
**Priority:** P2  
**Status:** Implemented  

Setting `includeOpenDocuments` (default off). `document/didOpen`, `didChange`, `didClose`, `didSave`, and `didFocus` keep the editor text and attach it to the next `session/prompt` as ordinary chat text. Off by default, those notifications do nothing.

---

### 16. Audio input
**Priority:** P2  
**Status:** Implemented  
**Spec:** [05-image-audio-content.md](./05-image-audio-content.md)

`audioSupport` (default false, env `GENERIC_ACP_AUDIO`) maps ACP audio blocks to OpenAI `input_audio` (`wav` / `mp3`). A provider that rejects audio retries once with the audio replaced by a text note.

---

### 17. Live usage updates
**Priority:** P3  
**Status:** Implemented  

`PromptResponse.usage` is filled from `stream_options.include_usage`. The same chunk also emits `session/update` `usage_update` (`used` = input tokens, `size` = the context window already read for the model) when that window is known.

---

## Recommended Execution Order

```text
Phase 1 — Core Functionality
  ├── 1. Tool Calling (P0)
  ├── 2. MCP Bridging (P0)
  └── 7. Error Handling Polish (P1)

Phase 2 — Protocol Completeness
  ├── 4. Structured Output / Responses API (P1)
  ├── 5. Image / Audio Content Blocks (P2)
  └── 3. Session Load (P2)

Phase 3 — Validation & Quality
  ├── 6. Real-world Validation (P0)
  └── 8. Automated Tests (P0)

Phase 4 — Settings and standard OpenAI fields
  ├── 10. OpenAI request settings (P1)
  ├── 11. Model catalog and model switch (P1)
  ├── 12. Session list, resume, delete, and fork (P2)
  ├── 13. Modes (P2)
  ├── 15. Open documents as prompt context (P2)
  ├── 16. Audio input (P2)
  ├── 14. Slash commands (P3)
  └── 17. Live usage updates (P3)
```

