# 02 — MCP Bridging

## Status

Implemented

## Summary

Built a real MCP stdio client and bridge so `getTools()` lists tools discovered from the `mcpServers` passed into `newSession`.

- `src/mcp/client.ts` — `McpClient` wraps `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`; exposes `connect()`, `listTools()`, `callTool()` (flattens MCP content blocks to text), `close()`.
- `src/mcp/bridge.ts` — `McpBridge` connects all servers eagerly at session creation, namespaces tools as `serverName_toolName` (collision-safe routing), surfaces `getTools()`, `hasTool()`, `callTool()`, `close()`. A failing server is logged and skipped; the rest keep working.
- `src/openai/tools.ts` — `getTools(bridge?)` merges the three built-in tools with MCP-discovered tools.
- `src/acp/session.ts` — `Session` now holds an optional `mcpBridge`.
- `src/acp/agent.ts` — `newSession` connects stdio, HTTP, SSE, and ACP servers (`src/mcp/bridge.ts`, `src/mcp/acp-transport.ts`); `executeTool` routes MCP tools before the built-in switch. `cancel` aborts the in-flight turn and leaves the bridge connected. `session/close` and session expiry close it. A changed server list on `session/load` reconnects.

Verified with `npm run typecheck` / `npm run build`, a direct `McpBridge` test against a mock MCP stdio server (discovery, namespaced routing, unknown-tool error, failure isolation), and a full ACP drive over stdio (`initialize` → `session/new` with the mock MCP server → `session/cancel` → clean exit) using the SDK's `ClientApp`.

## Objective

Implement an actual MCP client so `mcpServersToOpenAiTools()` lists real tools from the `mcpServers` passed into `newSession`, instead of returning `[]`.

## Background

The ACP `NewSessionRequest` includes an `mcpServers` array describing MCP servers that the client (JetBrains AI Assistant) wants the agent to expose. Currently, `src/openai/tools.ts` ignores these and returns an empty array. The readme's architecture diagram shows an `mcp/bridge.ts` module for this purpose.

## Requirements

### 1. MCP Client Implementation

**New file:** `src/mcp/client.ts`

- Create an MCP client that can connect to MCP servers via **stdio** transport (the standard for local MCP servers)
- Use the `@modelcontextprotocol/sdk` package (or equivalent) to communicate with MCP servers
- Support:
  - `initialize` handshake
  - `tools/list` — enumerate available tools
  - `tools/call` — invoke a tool

- **Dependencies to add:**
  ```json
  "@modelcontextprotocol/sdk": "^1.0.0"
  ```

- **McpServer config shape** (from ACP SDK):
  ```typescript
  interface McpServer {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }
  ```

- **Connection flow:**
  1. Spawn the MCP server process using `child_process.spawn(server.command, server.args, { env: { ...process.env, ...server.env } })`
  2. Connect via stdio transport
  3. Send `initialize` request
  4. Send `tools/list` request to discover tools

### 2. Tool Schema Conversion

**File:** `src/openai/tools.ts`

Replace the stub `mcpServersToOpenAiTools()` with a real implementation:

- **Input:** Array of `McpServer` configs
- **Output:** Array of `ChatCompletionTool` schemas
- **Process:**
  1. For each MCP server, spawn the process and connect
  2. Call `tools/list` to get the server's tool definitions
  3. Map each MCP tool to an OpenAI function schema:
     ```typescript
     function mcpToolToOpenAiTool(mcpTool: McpTool): ChatCompletionTool {
       return {
         type: "function",
         function: {
           name: `${mcpTool.name}`,  // prefix with server name if needed
           description: mcpTool.description,
           parameters: mcpTool.inputSchema  // MCP uses JSON Schema directly
         }
       };
     }
     ```
  4. Return the combined list of all tools from all servers

- **Caching:** Tool lists should be fetched once per session (at session creation or first prompt), not on every prompt

### 3. Tool Execution Bridge

**New file:** `src/mcp/bridge.ts`

When the model calls a function that came from an MCP server:

1. Identify which MCP server owns the tool (by name prefix or lookup table)
2. Call `tools/call` on the appropriate MCP client with the tool name and arguments
3. Return the result to be fed back into the conversation

```typescript
interface McpBridge {
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
```

### 4. Session Lifecycle

**File:** `src/acp/session.ts`

- Store MCP clients in the `Session` object
- On session creation, spawn all MCP servers and discover tools
- On session close (or agent shutdown), close all MCP connections and kill spawned processes

### 5. Error Handling

- If an MCP server fails to start, log a warning and continue with the remaining servers
- If `tools/list` fails, skip that server's tools
- If `tools/call` fails, return the error as the tool result (the model can then handle it)

## Files to Modify / Create

| File | Changes |
|------|---------|
| `src/mcp/client.ts` | **NEW** — MCP stdio client |
| `src/mcp/bridge.ts` | **NEW** — Bridge between OpenAI tool calls and MCP tool execution |
| `src/openai/tools.ts` | Replace stub with real MCP tool discovery |
| `src/acp/session.ts` | Store MCP clients; lifecycle management |
| `src/acp/agent.ts` | Use MCP bridge for tool execution |
| `package.json` | Add `@modelcontextprotocol/sdk` dependency |

## Key Design Decisions

1. **stdio transport only** — MCP servers are typically local processes. HTTP/SSE transport can be added later if needed.

2. **Tool name namespacing** — To avoid collisions when multiple MCP servers expose tools with the same name, prefix with server name: `serverName_toolName`. The bridge must reverse this mapping when dispatching calls.

3. **Lazy vs eager connection** — Connect eagerly at session creation so tools are available on the first prompt. This adds slight latency to session creation but avoids delays mid-conversation.

## Testing Strategy

1. **Unit test:** Mock MCP server responses; verify tool schema conversion produces valid OpenAI function definitions
2. **Integration test:** Create a simple MCP server script that exposes a trivial tool (e.g., `echo`); verify the full flow: spawn → discover → model calls → execute → result
3. **Manual test:** Run with a real MCP server (e.g., the official filesystem MCP server)

## Acceptance Criteria

- [ ] MCP servers listed in `mcpServers` are spawned and connected via stdio
- [ ] `mcpServersToOpenAiTools()` returns valid OpenAI function schemas derived from MCP `tools/list`
- [ ] Tool calls from the model are dispatched to the correct MCP server via `tools/call`
- [ ] MCP server failures are handled gracefully (logged, skipped)
- [ ] MCP processes are cleaned up when the session ends
- [ ] Tool names are namespaced to avoid collisions
- [ ] `npm run typecheck` passes
