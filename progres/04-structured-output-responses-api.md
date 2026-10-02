# 04 — Structured Output / Responses API

## Status

Implemented and verified end-to-end over stdio with mock providers (Responses mode with an MCP tool call; chat-completions mode whose provider rejects `response_format`).

## Objective

Implement both Chat Completions (with structured output) and the Responses API as specified in the readme; currently only basic Chat Completions streaming is implemented.

## Background

The readme states:

> Support:
> - Chat Completions
> - Responses API
> - Streaming
> - Function Calling
> - Structured Output

Currently, only basic Chat Completions with streaming is implemented. Two gaps remain:

1. **Structured Output** — OpenAI's `response_format: { type: "json_schema", schema: ... }` parameter for constrained decoding
2. **Responses API** — OpenAI's newer `/v1/responses` endpoint, which is an alternative to Chat Completions with built-in tool support

## Requirements

### Part A: Structured Output

#### 1. Support `response_format` in Chat Completions

**File:** `src/openai/streaming.ts`

The OpenAI SDK already supports structured output via the `response_format` parameter. The agent should allow the client to request structured output.

- **ACP integration:** Check if ACP's `PromptRequest` includes a schema or format hint. If not, this may be exposed as a configuration option or triggered by tool definitions that use `strict: true`.

- **Implementation:**
  ```typescript
  // In streamChatCompletion, add an optional response_format parameter
  interface ChatOptions {
    messages: ChatCompletionMessageParam[];
    tools: ChatCompletionTool[];
    signal: AbortSignal;
    responseFormat?: { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: object } };
  }
  ```

#### 2. Provider Support Check

- Not all OpenAI-compatible providers support structured output
- The agent should gracefully degrade: if the provider returns an error for `response_format`, retry without it
- Log a warning when structured output is not supported

### Part B: Responses API

#### 3. Implement Responses API Endpoint

**New file:** `src/openai/responses.ts`

OpenAI's Responses API (`/v1/responses`) is a newer alternative to Chat Completions with:
- Built-in tool orchestration
- Structured output as a first-class concept
- Multi-turn conversation management

- **Decision point:** The Responses API is OpenAI-specific. Since this project aims to be vendor-neutral and work with any OpenAI-compatible API, the Responses API should be:
  - Implemented as an **optional** provider mode
  - Disabled by default
  - Enabled via config: `{ "apiMode": "responses" }` (default: `"chat-completions"`)

- **Implementation:**
  ```typescript
  // src/openai/responses.ts
  export async function* streamResponses(
    client: OpenAI,
    model: string,
    input: string | ResponseInputItem[],
    tools: ResponseTool[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamDelta> {
    const stream = await client.responses.create({
      model,
      input,
      stream: true,
      tools,
    }, { signal });

    for await (const event of stream) {
      // Map response stream events to StreamDelta
      if (event.type === 'response.output_text.delta') {
        yield { type: "text", text: event.delta };
      }
      // ... handle other event types
    }
  }
  ```

#### 4. Provider Selection

**File:** `src/openai/provider.ts`

Add support for switching between Chat Completions and Responses API:

```typescript
interface AgentConfig {
  // ... existing fields
  apiMode?: "chat-completions" | "responses";  // default: "chat-completions"
}
```

The `OpenAiProvider.streamChat()` method delegates to the appropriate implementation based on `apiMode`.

#### 5. Tool Mapping for Responses API

The Responses API uses a different tool schema format (`ResponseTool`) compared to Chat Completions (`ChatCompletionTool`). A mapping function is needed:

```typescript
function chatToolToResponseTool(tool: ChatCompletionTool): ResponseTool {
  // Map OpenAI function-calling schema to Responses API tool format
}
```

## Files to Modify / Create

| File | Changes |
|------|---------|
| `src/openai/streaming.ts` | Add `response_format` support to `streamChatCompletion` |
| `src/openai/responses.ts` | **NEW** — Responses API streaming implementation |
| `src/openai/provider.ts` | Add `apiMode` config; delegate to appropriate implementation |
| `src/config/config.ts` | Add optional `apiMode` field |
| `src/openai/tools.ts` | Add tool schema mapping for Responses API |

## Key Design Decisions

1. **Chat Completions is the default** — It has wider provider support. Responses API is opt-in.

2. **Graceful degradation** — If structured output fails, fall back to unconstrained generation with a warning.

3. **Tool schema mapping** — The Responses API has different tool types (`web_search_preview`, `code_interpreter`, etc.) that don't exist in Chat Completions. Only map `function` tools; ignore Responses API-specific tools.

## Testing Strategy

1. **Unit test:** Mock OpenAI streaming with `response_format` and verify structured output is parsed correctly
2. **Integration test:** Script a stdio exchange requesting structured output; verify the model returns valid JSON matching the schema
3. **Manual test:** Test with OpenAI (supports both APIs) and Ollama (supports Chat Completions only, to verify graceful degradation)

## Acceptance Criteria

- [x] Structured output via `response_format` works with Chat Completions
- [x] Responses API can be enabled via config and functions correctly
- [x] Providers that don't support structured output degrade gracefully
- [x] Providers that don't support Responses API fall back to Chat Completions
- [x] Tool schemas are correctly mapped between the two APIs
- [x] `npm run typecheck` passes

## Implementation Notes

- ACP `PromptRequest` has no schema/format hint, so structured output is config-driven: `responseSchema` in `config.json` (or the `GENERIC_ACP_RESPONSE_SCHEMA` env var) builds a `response_format: { type: "json_schema", json_schema: { name: "generic_acp_output", strict: true, schema } }`. Chat Completions retries without `response_format` (with a stderr warning) when the provider rejects it.
- `apiMode` is validated at config load (throws on unknown values); `GENERIC_ACP_API_MODE` overrides the file value.
- The Responses fallback is scoped to provider *support* errors only: 404, or 400 whose body mentions `not support` / `unsupported`. Other errors propagate to the existing error-handling path.
- Responses streaming maps `response.output_text.delta` → text, builds `ResponseFunctionToolCall`s across `output_item.added` / `function_call_arguments.delta` / `output_item.done` (using `call_id` with `id` fallback so MCP-style name-only tools work), maps `response.completed` to `tool_calls` (when function-call output items exist), and maps `status: "incomplete"` reasons (`max_output_tokens` → `length`, `content_filter`, otherwise `incomplete`) to finish reasons.
- Chat history converts to `ResponseInputItem[]`: `EasyInputMessage` for user/system/assistant text, `function_call` for prior assistant tool calls, `function_call_output` for tool results.
