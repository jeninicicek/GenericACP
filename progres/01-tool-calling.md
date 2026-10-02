# 01 — Tool Calling

## Status

Not Started

## Objective

Bridge OpenAI function-calling responses into ACP `tool_call` / `tool_call_update` session updates, request permission via `RequestPermissionRequest`, and execute via the client's filesystem and terminal capabilities.

## Background

Currently, `src/openai/provider.ts` and `src/openai/streaming.ts` pass tools to the OpenAI API but ignore tool-call deltas in the streaming response. The `prompt()` method in `src/acp/agent.ts` only collects text content and never sends tool-call updates to the ACP client.

## Requirements

### 1. Detect Tool Calls in Streaming Response

**File:** `src/openai/streaming.ts`

The async generator `streamChatCompletion` currently yields only text deltas. It must also yield tool-call deltas when the model invokes a function.

- **OpenAI streaming format for tool calls:**
  - `chunk.choices[0].delta.tool_calls` is an array of partial tool-call objects
  - Each has `index`, `id`, `function.name`, and `function.arguments` (incremental)
  - `finish_reason` becomes `"tool_calls"` when the model wants to call tools

- **Changes:**
  - Replace the `AsyncGenerator<string>` return type with a new discriminated union type:
    ```typescript
    type StreamDelta =
      | { type: "text"; text: string }
      | { type: "tool_call"; index: number; id?: string; name?: string; arguments?: string }
      | { type: "done"; finishReason: string };
    ```
  - In the `for await` loop, check both `delta.content` (text) and `delta.tool_calls` (function calls)
  - Emit `done` with the `finish_reason` when the stream ends

### 2. Accumulate Tool Calls in Provider

**File:** `src/openai/provider.ts`

- **Changes:**
  - Update `streamChat` to return `AsyncGenerator<StreamDelta>` instead of `AsyncGenerator<string>`
  - Consider adding a higher-level method like `chatWithTools()` that handles the tool-call loop internally (optional, may be deferred)

### 3. Handle Tool Calls in Agent Prompt

**File:** `src/acp/agent.ts`

The `prompt()` method must handle tool-call deltas from the model:

- **Accumulation:**
  - Maintain a `Map<number, { id: string; name: string; arguments: string }>` to accumulate incremental tool-call deltas by index
  - When `finishReason === "tool_calls"`, the accumulated tool calls are complete

- **ACP Tool Call Updates:**
  - For each accumulated tool call, send a `sessionUpdate` with:
    - `sessionUpdate: "tool_call"` — announces the tool call with `toolCallId`, `toolName`, and `arguments` (parsed from the accumulated JSON string)
    - This must be sent via `this.conn.sessionUpdate()`

- **Permission Request:**
  - After sending tool_call updates, send a `permissionRequest` via `this.conn.requestPermission()` if needed
  - The permission request should describe what the tool will do (e.g., "Read file: /path/to/file")

- **Tool Execution:**
  - Depending on the tool type, execute via the ACP client's capabilities:
    - `fs.readTextFile` — read a file
    - `fs.writeTextFile` — write a file
    - `terminal` — run a command
  - Wait for the client's response via `this.conn.requestPermission()` result

- **Feedback Loop:**
  - After tool execution, append the result to the conversation as a `tool` role message
  - Re-invoke the provider with the updated messages
  - Repeat until `finishReason === "end_turn"` (max iterations safeguard, e.g., 10)

### 4. Session Message History

**File:** `src/acp/session.ts`

- Add a `toolCalls` map to `Session` to track pending tool calls
- The `messages` array already uses `ChatCompletionMessageParam` which supports `tool` role messages

### 5. Tool Schema Conversion

**File:** `src/openai/tools.ts`

- The current `mcpServersToOpenAiTools()` stub returns `[]`
- For tool calling to work, this function must return valid `ChatCompletionTool[]` schemas
- This is tightly coupled with MCP Bridging (Task 02); initially implement a minimal set of built-in tools:
  ```typescript
  const BUILTIN_TOOLS: ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file at the given path",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute file path" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file at the given path",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute file path" },
            content: { type: "string", description: "Content to write" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_terminal",
        description: "Run a terminal command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command to execute" },
            cwd: { type: "string", description: "Working directory" }
          },
          required: ["command"]
        }
      }
    }
  ];
  ```

## Files to Modify

| File | Changes |
|------|---------|
| `src/openai/streaming.ts` | New `StreamDelta` type; yield tool_call deltas |
| `src/openai/provider.ts` | Update return type of `streamChat` |
| `src/acp/agent.ts` | Tool-call accumulation, ACP updates, permission requests, execution loop |
| `src/acp/session.ts` | Add toolCalls map for pending calls |
| `src/openai/tools.ts` | Add built-in tool schemas |

## Testing Strategy

1. **Unit test:** Mock the OpenAI streaming response to include tool_call deltas; verify the agent accumulates them correctly and produces valid ACP tool_call updates
2. **Integration test:** Run a scripted stdio exchange where the model triggers a tool call; verify the full round-trip (stream → accumulate → ACP update → permission → execution → feedback → second stream → end_turn)
3. **Manual test:** Build and run against a model that supports function calling (e.g., GPT-4, Claude via OpenRouter)

## Acceptance Criteria

- [ ] Model tool-call deltas are correctly accumulated into complete tool calls
- [ ] ACP `tool_call` session updates are sent with correct `toolCallId`, `toolName`, and parsed `arguments`
- [ ] Permission requests are sent before tool execution
- [ ] Tool execution calls the appropriate client capability
- [ ] Tool results are fed back to the model and the conversation continues
- [ ] The loop terminates when the model returns `end_turn`
- [ ] A maximum iteration safeguard prevents infinite loops
- [ ] `npm run typecheck` passes
