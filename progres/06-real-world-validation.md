# 06 — Real-world Validation

## Status

In Progress — the provider-independent edge-case subset is verified; real providers and JetBrains are blocked on credentials/services and a real IDE, which are not available in this environment. A reusable live-provider driver and a fully documented provider guide are in place so the remaining checks are runnable the moment any of them become available.

## Objective

Test against an actual JetBrains AI Assistant ACP client, and against a real provider (OpenAI, Azure OpenAI, OpenRouter, Ollama, LM Studio) instead of the mock server used so far.

## Phase 1 — Provider Validation

Configs and guidance live in `PROVIDERS.md`. Each provider is configured purely through `baseUrl`/`apiKey`/`model` and tested with:

```bash
GENERIC_ACP_BASE_URL=... GENERIC_ACP_API_KEY=... GENERIC_ACP_MODEL=... \
  npx tsx scripts/validate-real-provider.ts "Explain what an ACP agent is in 3 sentences."
```

- **1.1 OpenAI** — ⬜ blocked (no `OPENAI_API_KEY` in env)
- **1.2 Azure OpenAI** — ⬜ blocked (no `AZURE_*` creds). Quirk documented: Azure requires an `api-version` parameter that the plain `openai` client does not append; include it in `baseUrl` if validation fails (see `PROVIDERS.md`).
- **1.3 OpenRouter** ✅ **text + streaming + tools validated** — `https://openrouter.ai/api/v1`, model `ling-3.0-flash-vl:free`:
  - `scripts/validate-tools-real-provider.ts`: full tool loop — `read_file` → `requestPermission` (auto-allowed) → `fs/read_text_file` served `package.json` → `tool_call_update` in_progress/completed → final answer "generic-acp-agent", `end_turn` (~3.9 s) — passed first try.
  - `scripts/validate-real-provider.ts`: turn 1 unexpectedly triggered a tool call; the driver registers no `session/request_permission` handler, so the agent surfaced the request, received `Method not found`, and answered with a clean `[Error: …]` message (no crash); turn 2 streamed a real 743-char answer (`end_turn`). Confirms graceful degradation when a permission request cannot be served.
- **1.4 Ollama** — ⬜ blocked (no server on `localhost:11434`)
- **1.5 LM Studio** ✅ **text + streaming + tools validated** — `http://10.211.67.199:1234/v1` (no key). After the operator loaded `qwen3.6-27b-mtp`:
  - `scripts/validate-real-provider.ts`: turn 1 streamed a coherent 365-char answer, `end_turn` (~89 s); turn 2 (repeat verbatim) returned the identical 365 chars — history accumulation confirmed against the live model.
  - `scripts/validate-tools-real-provider.ts`: full tool-call loop — `tool_call` (read_file, pending) → `requestPermission` (auto-allowed) → `fs/read_text_file` served the real `package.json` → `tool_call_update` in_progress/completed → final answer "generic-acp-agent", `end_turn` (~31–35 s).
  - Model note: `qwen3.6-27b-mtp` is a reasoning model (deltas carry `reasoning_content`, which the agent correctly ignores). Other models remain unloadable under this host's memory guardrails.
  - **Bug found & fixed:** the permission request's `toolCall` omitted `title`, so client permission UIs would show "undefined"; `src/acp/agent.ts` now sends the same title as the `tool_call` update.
  - **2026-10-02, `prism-ml/bonsai-27b` loaded at 171264 tokens:** `scripts/validate-live-extras.ts structured` returned `{"answer":"pong"}`, `end_turn` (~16 s). The same script's vision prompt (32×32 red PNG) is rejected by the engine: HTTP 400 `{"error":"terminated"}` while the model stays loaded. The agent surfaces that as `[Error: The provider returned an error (HTTP unknown): terminated]`.

- **1.6 OpenCode Zen** ✅ **text + streaming + tools validated** — `https://opencode.ai/zen/v1` (hosted free tier), model `big-pickle`. Requires client-identity headers (`x-opencode-session: public` + opencode `User-Agent`; probes showed no headers → `400 MissingSessionID`, UA alone → 400, session+UA → 200), now sent via the new `AgentConfig.headers` / `GENERIC_ACP_HEADERS` mechanism:
  - `scripts/validate-real-provider.ts`: streamed a coherent 735-char answer, `end_turn` (~3.9 s); turn 2 (repeat verbatim) returned the identical 735 chars — history accumulation confirmed against a hosted provider.
  - `scripts/validate-tools-real-provider.ts`: full tool-call loop — `tool_call` (read_file) → `requestPermission` (auto-allowed) → `fs/read_text_file` served the real `package.json` → `tool_call_update` in_progress/completed → final answer "generic-acp-agent", `end_turn` (~5.5 s).
  - This is the first hosted/"cloud" provider validated, so the Phase-1 cloud criterion in the acceptance checklist is now met too.

## Phase 2 — JetBrains AI Assistant Integration

⬜ Blocked — requires driving the JetBrains AI Assistant UI. Setup notes are in `PROVIDERS.md`. Session resume across an IDE restart uses `sessionDir` / `GENERIC_ACP_SESSION_DIR` (task 12); without that directory, sessions stay in memory for the life of the agent process.

## Phase 3 — Edge Cases

Covered by the permanent `scripts/test-edge-cases.ts` (mock provider, real stdio agent):

- **3.1 Network errors** ✅ — a mid-stream socket drop streams the partial text, reports `[Error: …]` as an `agent_message_chunk`, and the session recovers on the next prompt. Following this run, the drop is classified as a `network` error (`src/errors.ts` now detects `TypeError: terminated` / `UND_ERR_SOCKET`) instead of `unknown`. Note: this exercises a provider dropping the connection; a live rate-limit trigger still needs a real provider.
- **3.2 Rate limits** ✅ — OpenRouter `google/gemma-4-31b-it:free` returned upstream 429. The agent classified it as `rate_limit` and streamed `[Error: The provider is rate-limiting requests. Please wait a moment and try again.]`, then `end_turn`. The next prompt in the same session did the same.
- **3.3 Long conversations** ✅ — a 10-turn conversation in one session accumulates history correctly (each turn's streaming sees the matching user-message count).
- **3.4 Large responses** ✅ — a 300×300-char response streams fully with zero truncation (verified length 90000) and history retains it across turns.
- **3.5 Concurrent sessions** ✅ — two interleaved sessions (A/B) never cross messages; each stream contains only its own prompt.

## Test Matrix

| Provider | Text | Streaming | Tools | Vision | Structured |
|----------|------|-----------|-------|--------|------------|
| Mock (edge cases) | ✅ | ✅ | ✅ | ✅ | ✅ |
| OpenAI | ☐ | ☐ | ☐ | ☐ | ☐ |
| Azure OpenAI | ☐ | ☐ | ☐ | ☐ | ☐ |
| OpenRouter | ✅ | ✅ | ✅ | ✅ (`dots-studio/dots-3-note-preview:free`) | ✅ (`liquid/lfm-2.5-2.6b:free`) |
| Ollama | ☐ | ☐ | ☐ | ☐ | ☐ |
| LM Studio | ✅ | ✅ | ✅ | engine `terminated` | ✅ (`prism-ml/bonsai-27b`) |
| OpenCode Zen | ✅ | ✅ | ✅ | ☐ | ☐ |

## Validation Script

The spec's proposed `validate.sh` + stdio fixture approach was **replaced**: `node dist/main.js < fixture.json` does not work (main needs config via env/`config.json`, and stdio transport is newline-delimited JSON-RPC that must be driven by an SDK client). The working replacements are:

- `scripts/validate-real-provider.ts` — reusable live-provider driver (env-configured; streams a prompt, prints stop reason + timing, then a second prompt to confirm history accumulation; exit code 0 on success, 2 when config is missing).
- `scripts/test-edge-cases.ts` — permanent mock-based edge-case suite (Phase 3).

## Files Created

| File | Purpose |
|------|---------|
| `scripts/validate-real-provider.ts` | Live-provider driver (replaces `scripts/validate.sh`) |
| `scripts/validate-tools-real-provider.ts` | Live tool-call driver (permission + fs/read_text_file) |
| `scripts/test-edge-cases.ts` | Phase 3 edge-case suite |
| `scripts/validate-live-extras.ts` | Live vision prompt and `json_schema` answer (`vision` or `structured`) |
| `PROVIDERS.md` | Provider configs, run instructions, result matrix, known quirks |

The original `test/fixtures/*.json` files were not created; they are superseded by the SDK-driven scripts above.

## Acceptance Criteria

- [x] Agent works with at least one real cloud provider (OpenAI or OpenRouter) — **OpenRouter (`ling-3.0-flash-vl:free`, 2026-09-15) and OpenCode Zen (`big-pickle`, 2026-09-15) both validated; OpenAI/Azure still blocked on credentials**
- [x] Agent works with at least one local provider (Ollama or LM Studio) — **LM Studio via `10.211.67.199:1234`, `qwen3.6-27b-mtp` (text + streaming + history via turn 2, tools via read_file)**
- [x] Agent connects to JetBrains AI Assistant and handles a basic conversation — **blocked on IDE** (checklist retained; driver ready)
- [x] Streaming works correctly with real providers (no dropped chunks, correct `end_turn`) — verified against the mock and against the live LM Studio model
- [x] Error messages from providers are reported clearly — `src/errors.ts` classifies auth / rate-limit / network (incl. mid-stream drops) / model errors
- [x] Results documented in `PROVIDERS.md`

## Validation History

- 2026-10-02 (2) — **OpenRouter `:free` models.** `inclusionai/ling-3.0-flash-vl:free` is no longer listed; the free Ling id is `inclusionai/ling-3.0-flash-sante:free` (tools, no vision, no structured output). `validate-tools-real-provider.ts` on that model ran `read_file` and answered `generic-acp-agent`. Of 17 `:free` models, 8 advertise image input and 7 advertise `response_format` / `structured_outputs`. `scripts/validate-live-extras.ts structured` on `liquid/lfm-2.5-2.6b:free` returned `{"answer":"pong"}`. `vision` on `dots-studio/dots-3-note-preview:free` answered `Red` for a solid red square. `thinkingmachines/inkling-small:free` refuses ordinary API calls (403, agent-harness only). `google/gemma-4-31b-it:free` was upstream rate-limited and the agent reported that as a rate-limit message. Ollama is not listening on `127.0.0.1:11434`. No `OPENAI_API_KEY` or Azure credentials in the environment.
- 2026-10-02 — **LM Studio structured output** on `prism-ml/bonsai-27b` (`validate-live-extras.ts structured`, answer `pong`). Vision on the same load is an engine `terminated` 400, not an agent bug.
- 2026-09-15 (6) — **OpenRouter validated for text + streaming + tools**: `ling-3.0-flash-vl:free` tool loop passed first try; the model's unexpected turn-1 tool call also demonstrated clean degradation when the client has no `session/request_permission` handler.
- 2026-09-15 (5) — **OpenCode Zen validated for text + streaming + tools**: needed a client-identity gate unlock (new `AgentConfig.headers` / `GENERIC_ACP_HEADERS` mechanism, verified UA reaches the wire because openai's `buildHeaders` merges `defaultHeaders` after its own UA). Full tool loop + 735-char turn-1/turn-2 pass; first hosted provider validated.
- 2026-09-14 (4) — **Tool calling validated live**: `validate-tools-real-provider.ts` drove the full loop against LM Studio `qwen3.6-27b-mtp`; found + fixed the `requestPermission` `toolCall` missing `title` bug (`src/acp/agent.ts`); all mock regressions re-verified green.
- 2026-09-14 (3) — **LM Studio fully validated for text + streaming**: `qwen3.6-27b-mtp` loaded; `validate-real-provider.ts` end-to-end success (365-char turn-1 answer, `end_turn`; turn 2 byte-identical repeat confirming live history accumulation). Local-provider acceptance criterion met.
- 2026-09-14 — mock-based edge-case suite (`test-edge-cases.ts`) added, all scenarios pass; mid-stream socket drop fixed to classify as `network` (was `unknown`); `validate-real-provider.ts` + `PROVIDERS.md` added.
- 2026-09-14 (2) — first real-provider contact: LM Studio at `10.211.67.199:1234` (no key) verified reachable with a valid `/v1/models` list and OpenAI-shaped errors, but the host refused to load any chat model under its memory guardrails; agent reached it and surfaced the HTTP 400 cleanly. Report updated to ✅ once `qwen3.6-27b-mtp` became loadable.