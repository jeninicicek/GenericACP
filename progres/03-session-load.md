# 03 — Session Load

## Status

Implemented

## Objective

Support resuming a previous session (previously `AgentCapabilities.loadSession` was advertised as `false`).

## Background

The ACP protocol supports a `session/load` method that allows a client to resume a previously created session. This is useful for:

- Resuming interrupted conversations
- Continuing work across IDE restarts
- Sharing session state between multiple prompts

## What was implemented

- `initialize` in `src/acp/agent.ts` now advertises `loadSession: true`.
- `loadSession(params: LoadSessionRequest)` in `GenericAcpAgent`:
  - looks the session up by `sessionId` (unknown ids → `RequestError.resourceNotFound`, i.e. JSON-RPC "resource not found")
  - rejects a mismatched `cwd` with `RequestError.invalidParams`
  - reconnects the session's MCP bridge when it is `null`, using the `mcpServers` from the load request
  - streams the stored conversation history back to the client as `session/update` notifications — one `user_message_chunk` per stored user message and one `agent_message_chunk` per stored assistant message (with `messageId: "load-<n>"` for grouping), plus a `tool_call` update (status `completed`, `name`, `kind`, `rawInput`, `rawOutput`) for each stored assistant `tool_calls` entry
  - returns an empty `LoadSessionResponse` (`{}`)
- `src/acp/content.ts` gains `messageContentToContentBlocks()` — the inverse of `contentBlocksToMessageContent()` — for converting stored OpenAI message content back into ACP `ContentBlock[]` (text parts → text blocks, image `data:` URLs → image blocks).
- `src/acp/session.ts`: `SessionStore` now tracks `lastActivityAt` and prunes sessions idle longer than 1 hour (TTL) on each `create`.

## Requirements

### 1. Advertise Capability — done

`src/acp/agent.ts` `initialize()` returns `agentCapabilities: { loadSession: true, ... }`.

### 2. Implement `loadSession` Method — done

`GenericAcpAgent.loadSession()` is added. The SDK wires it automatically (`legacyAgentApp` / `session/load` request handler) whenever the `Agent` interface method is present.

**Note on the response shape:** the SDK's `LoadSessionResponse` (v1.4.0) has no `sessionId` or `messages` fields — only `modes?` / `configOptions?` / `_meta?`. Per the SDK's documented contract, a `loadSession` agent must "restore the session context" and "stream the entire conversation history back to the client via notifications". The earlier draft spec (response containing `messages`) does not match the SDK types and has been corrected to the notification-based approach.

### 3. Session Persistence — memory, plus JSON when `sessionDir` is set

- Sessions survive while the agent process is running (the same `Session` object is reused across loads — the loaded session is the live session).
- With `sessionDir` (config or `GENERIC_ACP_SESSION_DIR`), each session is a JSON file (`sessionId`, `cwd`, `title`, `messages`, `modeId`, `model`, `settings`, timestamps). `session/load` and `session/resume` read that file after a restart. Memory prune (1 hour) and `session/close` keep the file. `session/delete` removes it. Files older than 7 days are removed on the next create.

### 4. Session Serialization — history streamed as notifications

`session/load` replays the stored history via `session/update` notifications rather than in the response body (see note in requirement 2). `messageContentToContentBlocks()` reconstructs ACP content blocks (text and image) from the stored OpenAI-format messages.

### 5. Expiration / Cleanup — done

In-memory sessions have a 1-hour TTL based on `lastActivityAt`, refreshed on every `get`. Expired sessions are pruned lazily on the next `create` (the JSON file stays). Files older than 7 days are removed by the same create path.

## Files Modified

| File | Changes |
|------|---------|
| `src/acp/agent.ts` | Advertise `loadSession: true`; implement `loadSession()` (lookup, cwd check, MCP reconnect, history replay as notifications); extract `connectMcpServers()` helper shared with `newSession` |
| `src/acp/content.ts` | Add `messageContentToContentBlocks()` (OpenAI message content → ACP `ContentBlock[]`) |
| `src/acp/session.ts` | Add `lastActivityAt` + `touch()`, 1h TTL pruning in `SessionStore` |

## Testing Strategy

1. **Integration test over stdio** — `scripts/test-session-load.ts` (kept as a permanent regression script): mock OpenAI server, real agent process:
   - `initialize` advertises `loadSession: true`
   - `session/new` → `session/prompt` ("first") → `session/load` replays the stored user + assistant chunks as notifications (verified both via `ActiveSession` routing and raw frames on the wire)
   - a second `session/prompt` ("second") sees 2 user messages, proving history survived the load
   - loading with a mismatched `cwd` → invalid-params error
   - loading an unknown `sessionId` → resource-not-found error
2. **Manual test** — run against JetBrains AI Assistant and verify session resume works (still to do; see Real-world Validation task).

## Acceptance Criteria

- [x] `initialize` response advertises `loadSession: true`
- [x] `loadSession` method is implemented; history is streamed back to the client as `session/update` notifications (per the SDK's response shape, which has no `messages` field)
- [x] Sessions created in the current process can be loaded by session ID
- [x] Loading a non-existent session returns an appropriate error ("resource not found")
- [x] `npm run typecheck` passes

## Follow-up

- File persistence and `session/list`, `session/resume`, `session/delete`, and `session/fork` are implemented (`src/acp/session.ts`, `src/acp/agent.ts`). MCP servers are not stored; the client sends them again on load and resume.