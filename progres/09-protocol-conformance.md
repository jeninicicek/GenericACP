# 09 — Protocol Conformance: Omitted Features / Fields

**Priority:** P1 (protocol completeness — fields the schema supports that real clients render)
**Status:** Implemented (2026-09-15)
**Date:** 2026-09-14

## Motivation

The live LM Studio tool validation surfaced a real conformance bug: the `requestPermission` `toolCall` omitted `title`, so client permission UIs rendered "undefined" (fixed in `src/acp/agent.ts`). That was one instance of a broader class of issue — **protocol objects we construct with fewer fields than the schema supports**, where the omitted fields change what the client displays, groups, or annotates. This spec audits every `session/update`, `requestPermission`, and `initialize`/`prompt` object we send against `@agentclientprotocol/sdk` schema types and plans implementations for every gap found.

## Audit method

- Read the payload builders in `src/acp/agent.ts` (initialize, loadSession, prompt tool loop, cancel) and the mapper `src/acp/content.ts`.
- Compared each constructed object against the SDK schema (`dist/schema/types.gen.d.ts`): `InitializeResponse` / `AgentCapabilities` / `PromptCapabilities`, `ContentChunk`, `ToolCall`, `ToolCallUpdate`, `RequestPermissionRequest`, `PromptResponse`, `Usage`, `ToolCallLocation`, `PermissionOption`, `Implementation`, `SessionUpdate`.
- Checked both chat-completions (`streaming.ts`) and Responses (`responses.ts`) deltas for whether `usage` and `reasoning_content` are capturable.

## Implemented (2026-09-15)

All gaps G1–G7 and B1 landed; the one optional item (O1) was deliberately left out.

- `src/openai/streaming.ts` — new `TurnUsage` type; `StreamDelta` gains `{ type: "reasoning"; text }`; the `done` delta now carries optional `usage`. `streamChatCompletion` requests `stream_options: { include_usage: true }`, with a retry-fallback ladder for providers that reject `stream_options` and/or `response_format`. Chat usage maps `completion_tokens_details.reasoning_tokens` → `thoughtTokens` and `prompt_tokens_details.cached_tokens` → `cachedReadTokens`. `reasoning_content` is captured via a cast (the OpenAI `Delta` type lacks it).
- `src/openai/responses.ts` — `response.completed` usage now mapped to `PromptResponse.usage`; `reasoning_text.delta` / `reasoning_summary_text.delta` emitted as `reasoning` deltas (G6 for Responses mode).
- `src/acp/session.ts` — `Session.nextAssistantMessageId()` returns `` `assistant-<counter>` `` (per-session counter).
- `src/acp/agent.ts` — G1 `agentInfo`; G2/G6 `messageId` on `agent_message_chunk` / `agent_thought_chunk`; G3/G7 `rawInput`/`rawOutput`/`name` on pending, permission, and completed tool calls; G4 `locations: [{ path: resolve(cwd, args.path) }]` for `read_file`/`write_file`; G5 `PromptResponse.usage` (thought/cached only when non-zero); B1 tool execution failures now `status: "failed"` (user-rejected calls also `failed`, rawOutput `"Tool call rejected by user."`); `executeTool` now throws `Unknown tool: <name>`.

## Confirmed gaps (implement)

### G1. `initialize` omits `agentInfo` — `agent.ts:50`
- Schema: `InitializeResponse.agentInfo?: Implementation` (`{ name, version, vendor? }` — the SDK type's doc shows `title`, not `vendor`); the schema notes it "in future versions of the protocol, this will be **required**."
- Impact: real clients (JetBrains AI Assistant) display agent name/version; absent today.
- Plan: return `agentInfo: { name: "generic-acp-agent", version: <from package.json> }`.
- Implemented: `agent.ts` — `AGENT_NAME = "Generic ACP Agent"`; `AGENT_VERSION` read from `../../package.json` (via `new URL`) with a `"0.0.0"` fallback; `initialize` sends `agentInfo: { name, version }`.

### G2. Streamed `agent_message_chunk` omits `messageId` — `agent.ts:161`, `agent.ts:285`
- Schema: `ContentChunk.messageId` — "A change in messageId indicates a new message has started. All chunks belonging to the same message share the same messageId."
- Impact: every text delta in a turn — across the multi-iteration tool loop and the `[Error: …]` chunk — is grouped into a **single** assistant message bubble on the client. `loadSession` replay already sends distinct `messageId`s (`load-<n>`), so live and replay diverge.
- Plan: per-session incrementing assistant `messageId`; bump once per model turn (each loop iteration / error chunk gets its own id).

### G3. `tool_call_update` (completed) omits `rawInput` / `rawOutput` — `agent.ts:262`
- Schema: `ToolCallUpdate.rawInput` / `rawOutput`. `loadSession` replay sends them (`agent.ts:116-117`); the live completion does not.
- Impact: clients can't show tool-call details; live vs replay inconsistent.
- Plan: send `rawInput: args`, `rawOutput: result` on the completed `tool_call_update`.

### G4. `locations` never sent for file tools — `agent.ts:211`, `agent.ts:262`
- Schema: `ToolCall.locations?` / `ToolCallUpdate.locations?`; `ToolCallLocation { path, line? }` powers the "follow-along" feature (highlighting the file being read/edited).
- Impact: for `read_file` / `write_file` we already know `args.path`; the client can't highlight affected files.
- Plan: for file tools, send `locations: [{ path: <resolved-absolute-path> }]` on the pending `tool_call` and completed `tool_call_update`.

### G5. `PromptResponse.usage` omitted — `agent.ts:181`, `191`, `276`, `293`
- Schema: `PromptResponse.usage?: Usage` (`totalTokens`, `inputTokens`, `outputTokens`, optional `thoughtTokens`/`cachedReadTokens`/`cachedWriteTokens`). Marked UNSTABLE but rendered by JetBrains.
- Impact: clients show no token usage for a turn.
- Plan: capture usage from the stream `done` delta (chat completions `chunk.usage` arrives on the final chunk; Responses `response.completed` likewise) and return it in `PromptResponse`; extend `StreamDelta.done` to carry usage.

### G6. `agent_thought_chunk` never sent for reasoning models — `streaming.ts`, `agent.ts`
- Schema: `SessionUpdate` includes `agent_thought_chunk` (a `ContentChunk`).
- Impact: reasoning deltas (`delta.reasoning_content`, seen live with LM Studio `qwen3.6-27b-mtp`) are silently dropped; clients display no thinking trace.
- Plan: stream `reasoning_content` as `agent_thought_chunk` using the G2 `messageId` scheme.

### G7. Pending `tool_call` / `requestPermission.toolCall` omit `rawInput` and `name` — `agent.ts:211`, `agent.ts:225`
- Schema: `ToolCall.rawInput`; the permission request's `ToolCallUpdate.name` is the (experimental) programmatic tool name. We fixed `title` only.
- Impact: the permission dialog can't show the programmatic tool name or raw args.
- Plan: include `rawInput: args` on the pending `tool_call`; include `name` and `rawInput` in the permission `toolCall`.

## Behavioral correctness (implement)

### B1. Tool failure reported as `completed`, not `failed` — `agent.ts:255-270`
- Schema: `ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"`. When `executeTool` throws (or returns `Unknown tool: …`), we still send `status: "completed"` with `Error: …` text. The user-rejected path already sends `failed` (`agent.ts:238-241`).
- Impact: clients render a successful-looking tool result that contains an error string.
- Plan: on execution failure send `tool_call_update` with `status: "failed"` (plus `rawOutput` error detail); still feed the error message to the model as the `tool` message so the model can react.

## Minor / optional (note, do not block)

- **O1. Live user prompt not echoed as `user_message_chunk`** — reference ACP agents echo the incoming prompt at the start of `prompt()` so the client has it under an agent-assigned `messageId`. We store it only server-side. Add only if a live client run shows a missing user message after `session/load` or replay.

## Reviewed — no action needed

- `embeddedContext: true` / `image: true` advertising is backed by `content.ts` handling `resource` / `resource_link` / `image` blocks (not over-advertised).
- No `authMethods`, `modes`, `configOptions`, `mcpCapabilities.http/sse/acp` advertised — we intentionally don't support those opt-in extension points (stdio MCP servers are baseline and need no capability flag).
- `_meta` never sent on our objects — optional by design.

## Implementation plan

1. **`initialize` agentInfo** (G1) — add `name`; `version` read from `package.json` at runtime.
2. **Assistant `messageId` scheme** (G2, G6) — per-session counter; bump per model turn; used by `agent_message_chunk` and `agent_thought_chunk`; keep `load-<n>` for replay.
3. **Reasoning deltas** (G6) — `streaming.ts`: yield `reasoning_content` as a new delta type; `agent.ts`: forward as `agent_thought_chunk`.
4. **Tool-call completeness** (G3, G4, G7, B1) — `rawInput`/`name` on pending + permission; `locations` on pending + completed for file tools; `rawInput`/`rawOutput` on completed; `status:"failed"` on execution errors (B1).
5. **Usage** (G5) — capture `usage` from the stream `done` delta (chat completions + Responses) and return it in `PromptResponse`.
6. **O1** — decide after a real-client run.

## Verification

- `npm run typecheck` && `npm run build` — green (typecheck caught 4 issues, fixed: `?? 0` for possibly-undefined usage fields in `agent.ts`; the `reasoning_content` cast in `streaming.ts`).
- `scripts/test-conformance.ts` (new, `npx tsx scripts/test-conformance.ts`) — 24 assertions, **all passed**, against a mock chat-completions SSE provider (streams a reasoning chunk, a `read_file` tool call, a bogus tool, and usage chunks) asserting on what the agent **sends** (intercepting `sessionUpdate` / `requestPermission` payloads):
  - `initialize` result contains `agentInfo.name` / `agentInfo.version`.
  - each assistant turn's `agent_message_chunk`s share one `messageId`, consecutive turns differ.
  - reasoning mock: `reasoning_content` becomes `agent_thought_chunk` sharing the same `messageId` as the following text.
  - `tool_call` pending + `requestPermission.toolCall` carry `name` + `rawInput`; completed `tool_call_update` carries `rawInput` + `rawOutput`; `read_file` sends `locations` (absolute path); a throwing tool produces `status: "failed"` with the raw error; user-rejected tool call is `failed`.
  - `PromptResponse.usage` populated (45/30/15 totals from the mock).
  - wire-level checks that `session/update` payloads for `in_progress`/`failed`/`agent_thought_chunk` are well-formed.
- Re-ran existing regressions — `test-session-load` (9), `test-image-content` (12), `test-edge-cases` (15), `test-mcp-bridge`, `test-failure`: all green.
- Live check vs the current `provider.ENV` (OpenRouter `ling-3.0-flash-vl:free`): `npx tsx scripts/validate-real-provider.ts "Say hello in one short sentence."` → two turns, both `end_turn`, model answered despite a slightly awkward turn-2 repetition prompt. Live tool loop also re-passed with the new emit code: `npx tsx scripts/validate-tools-real-provider.ts` → `read_file` pending → `requestPermission` → `fs/read_text_file` → completed → final answer, `RESULT: SUCCESS` (14752ms).