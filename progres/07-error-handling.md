# 07 — Error Handling Polish

## Status

Implemented

## Summary

Provider errors are now classified, logged, and surfaced to the client instead of crashing the agent.

- `src/errors.ts` — `AgentError` union (`auth` / `rate_limit` / `network` / `model` / `unknown`), `classifyProviderError()` (checks `OpenAI.AuthenticationError`, `OpenAI.RateLimitError` with `retry-after` header parsing, `OpenAI.APIConnectionError`, `OpenAI.APIError` — note: openai v7 has **no** `APIStatusError`; `APIError` is the status base), and `logError()` with optional session context.
- `src/acp/agent.ts` — `prompt()` catch block classifies, logs via `logError()`, sends an `agent_message_chunk` session update containing `\n\n[Error: …]`, and returns `{ stopReason: "end_turn" }`.

Two spec deviations found during implementation:
1. **No `OpenAI.APIStatusError`** — openai v7 exports `APIError` (with `status`/`headers`/`error`) instead; `AuthenticationError`/`RateLimitError` extend it, so ordering matters.
2. **No `errorMessage` field / `"error"` stop reason** — ACP v1 `PromptResponse` only has `stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"` and no `errorMessage`. Errors are therefore communicated exclusively via session updates (the spec's own section 6 fallback).

Verified with `npm run typecheck` / `npm run build`, a unit-style run over all five error categories (constructed with the real openai v7 error classes, including `retry-after` header parsing), and a full ACP stdio drive against a mock provider returning 401: the agent logged the classified error, streamed an `[Error: …]` chunk to the client, resolved `session/prompt` with `end_turn`, and the connection closed cleanly.

## Objective

Map provider errors (rate limits, auth failures, network issues) to ACP-friendly stop reasons or user-facing messages; currently just propagate as thrown errors.

## Background

Currently in `src/acp/agent.ts`, the `prompt()` method catches errors but only handles the abort case:

```typescript
} catch (error) {
  if (abortController.signal.aborted) {
    return { stopReason: "cancelled" };
  }
  throw error;  // <-- unhandled errors propagate as-is
}
```

Provider errors thrown from the OpenAI SDK (e.g., `AuthenticationError`, `RateLimitError`, `APIConnectionError`) crash the agent or produce cryptic error messages in the ACP client.

## Requirements

### 1. Error Classification

**New file:** `src/errors.ts`

Define error categories that map to ACP stop reasons:

```typescript
type AgentError =
  | { kind: "auth"; message: string; providerMessage?: string }
  | { kind: "rate_limit"; message: string; retryAfter?: number }
  | { kind: "network"; message: string }
  | { kind: "model"; message: string; statusCode?: number }
  | { kind: "unknown"; message: string; originalError?: unknown };

function classifyProviderError(error: unknown): AgentError {
  if (error instanceof OpenAI.AuthenticationError) {
    return { kind: "auth", message: "Authentication failed. Check your API key.", providerMessage: error.message };
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfter = error.headers?.["retry-after"];
    return {
      kind: "rate_limit",
      message: "Rate limit exceeded. Please wait before retrying.",
      retryAfter: retryAfter ? parseInt(retryAfter) : undefined,
    };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return { kind: "network", message: "Failed to connect to the provider. Check your baseUrl." };
  }
  if (error instanceof OpenAI.APIStatusError) {
    return { kind: "model", message: `Provider returned status ${error.status}`, statusCode: error.status };
  }
  return { kind: "unknown", message: String(error), originalError: error };
}
```

### 2. Error Mapping to ACP Stop Reasons

**File:** `src/acp/agent.ts`

Map classified errors to ACP stop reasons:

| Error Kind | ACP Stop Reason | Additional Action |
|------------|-----------------|-------------------|
| `auth` | `"error"` | Send `errorMessage` with auth guidance |
| `rate_limit` | `"error"` | Send `errorMessage` with retry info |
| `network` | `"error"` | Send `errorMessage` with connection guidance |
| `model` | `"error"` | Send `errorMessage` with provider details |
| `unknown` | `"error"` | Send `errorMessage` with generic message |
| `cancelled` | `"cancelled"` | (already handled) |

**Implementation:**
```typescript
async prompt(params: PromptRequest): Promise<PromptResponse> {
  // ... existing setup ...

  try {
    // ... streaming loop ...
  } catch (error) {
    if (abortController.signal.aborted) {
      return { stopReason: "cancelled" };
    }

    const agentError = classifyProviderError(error);

    // Send error as a session update so the client can display it
    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `\n\n[Error: ${agentError.message}]` },
      },
    });

    return {
      stopReason: "error",
      errorMessage: agentError.message,
    };
  } finally {
    session.abortController = null;
  }
}
```

### 3. Error Message Types

**File:** `src/errors.ts`

Add user-friendly error messages for common scenarios:

```typescript
const ERROR_MESSAGES: Record<AgentError["kind"], string> = {
  auth: "Authentication failed. Please verify your API key in the configuration.",
  rate_limit: "The provider is rate-limiting requests. Please wait a moment and try again.",
  network: "Could not connect to the provider. Please check your network connection and baseUrl configuration.",
  model: "The provider returned an error. This may be a temporary issue or a configuration problem.",
  unknown: "An unexpected error occurred. Please check the agent logs for details.",
};
```

### 4. Graceful Degradation

- **Auth errors:** Should not crash the agent; the session should remain usable (the user can fix the key and retry)
- **Rate limit errors:** Include `retryAfter` information if available
- **Network errors:** Suggest checking the `baseUrl` configuration
- **Model errors:** Include the HTTP status code for debugging

### 5. Logging

**File:** `src/errors.ts`

Add structured logging for errors:

```typescript
export function logError(error: AgentError, context?: { sessionId?: string }): void {
  const prefix = context?.sessionId ? `[session:${context.sessionId}]` : "[agent]";
  console.error(`${prefix} [${error.kind}] ${error.message}`);
  if (error.kind === "unknown" && error.originalError) {
    console.error(`${prefix} Original error:`, error.originalError);
  }
}
```

### 6. ACP `PromptResponse` Type Check

Verify the ACP SDK's `PromptResponse` type supports an `errorMessage` field. If not, errors may need to be communicated via session updates only.

Check `@agentclientprotocol/sdk` types:
```typescript
// If PromptResponse has errorMessage:
interface PromptResponse {
  stopReason: "end_turn" | "cancelled" | "error";
  errorMessage?: string;  // optional
}

// If not, use session updates to communicate errors
```

## Files to Modify / Create

| File | Changes |
|------|---------|
| `src/errors.ts` | **NEW** — Error classification, messages, logging |
| `src/acp/agent.ts` | Handle errors in `prompt()`; map to ACP stop reasons |
| `src/openai/provider.ts` | Consider wrapping SDK errors at the provider boundary |
| `src/openai/streaming.ts` | Consider wrapping stream errors |

## Error Flow

```text
Provider Error
    ↓
OpenAI SDK throws (AuthenticationError, RateLimitError, etc.)
    ↓
classifyProviderError() → AgentError
    ↓
logError() — structured log
    ↓
sessionUpdate (agent_message_chunk with error text)
    ↓
PromptResponse { stopReason: "error", errorMessage }
    ↓
ACP Client displays error to user
```

## Testing Strategy

1. **Unit test:** Create mock errors for each category; verify classification and ACP response
2. **Integration test:** Mock the OpenAI client to throw each error type; verify the agent handles them gracefully
3. **Manual test:** Use an invalid API key; verify the error message appears in the IDE

## Acceptance Criteria

- [ ] All OpenAI SDK error types are caught and classified
- [ ] Authentication errors return a clear message about checking the API key
- [ ] Rate limit errors include retry-after information when available
- [ ] Network errors suggest checking the baseUrl
- [ ] Errors don't crash the agent; sessions remain usable
- [ ] Errors are logged with structured context
- [ ] `npm run typecheck` passes
