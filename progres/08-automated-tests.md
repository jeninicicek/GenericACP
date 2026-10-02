# 08 — Automated Tests

## Status

Implemented — `npm test` builds and runs the unit suite plus `test/integration/agent.test.ts` and the mock stdio scripts via `test/integration/stdio-scripts.test.ts`. `npm run test:coverage` enforces 70% statement and line coverage on `src/` except `src/main.ts`.

## Objective

Create a test suite; verification so far has been manual (`npm run typecheck`, `npm run build`, and a hand-rolled stdio driver script).

## Background

The project currently has zero automated tests. All verification is done via:

1. `npm run typecheck` — TypeScript type checking
2. `npm run build` — Compilation
3. A hand-rolled stdio driver script (not checked into the repository)

## Requirements

### 1. Test Framework Setup

**Dependencies to add:**

```json
{
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
```

**Why Vitest:**
- Native ESM support (matches `type: module` in package.json)
- Fast, modern, TypeScript-first
- Built-in coverage support
- Compatible with the project's NodeNext module resolution

**Config file:** `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

**Scripts to add in `package.json`:**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

### 2. Test Structure

```text
test/
├── unit/
│   ├── config.test.ts          — loadConfig tests
│   ├── content.test.ts         — contentBlocksToText tests
│   ├── session.test.ts         — SessionStore tests
│   ├── tools.test.ts           — mcpServersToOpenAiTools tests
│   ├── errors.test.ts          — Error classification tests
│   └── streaming.test.ts       — Stream parsing tests
├── integration/
│   ├── agent.test.ts           — Full agent lifecycle via stdio
│   ├── prompt-roundtrip.test.ts — Prompt → stream → response
│   └── tool-calling.test.ts    — Tool call flow
└── fixtures/
    ├── simple-prompt.json      — Minimal ACP exchange
    ├── tool-call-prompt.json   — Exchange with tool calls
    └── mock-server.ts          — Mock OpenAI-compatible server
```

### 3. Unit Tests

#### 3.1 `config.test.ts`

```typescript
describe("loadConfig", () => {
  it("loads config from file", () => { /* ... */ });
  it("env vars override file config", () => { /* ... */ });
  it("throws on missing fields", () => { /* ... */ });
  it("uses GENERIC_ACP_CONFIG env for custom path", () => { /* ... */ });
});
```

#### 3.2 `content.test.ts`

```typescript
describe("contentBlocksToText", () => {
  it("converts text blocks", () => { /* ... */ });
  it("converts resource_link blocks", () => { /* ... */ });
  it("converts resource blocks with text", () => { /* ... */ });
  it("skips empty blocks", () => { /* ... */ });
  it("joins multiple blocks with newlines", () => { /* ... */ });
});

describe("contentBlocksToMessageContent", () => {
  it("returns string for text-only content", () => { /* ... */ });
  it("returns array for mixed content (text + image)", () => { /* ... */ });
  it("converts image data blocks to data URLs", () => { /* ... */ });
  it("converts image URI blocks to URLs", () => { /* ... */ });
});
```

#### 3.3 `session.test.ts`

```typescript
describe("SessionStore", () => {
  it("creates a session with unique id", () => { /* ... */ });
  it("retrieves session by id", () => { /* ... */ });
  it("throws on unknown session id", () => { /* ... */ });
  it("stores cwd and mcpServers", () => { /* ... */ });
});
```

#### 3.4 `errors.test.ts`

```typescript
describe("classifyProviderError", () => {
  it("classifies AuthenticationError as auth", () => { /* ... */ });
  it("classifies RateLimitError as rate_limit", () => { /* ... */ });
  it("classifies APIConnectionError as network", () => { /* ... */ });
  it("classifies APIStatusError as model", () => { /* ... */ });
  it("classifies unknown errors as unknown", () => { /* ... */ });
});
```

### 4. Integration Tests

#### 4.1 Mock OpenAI Server

Create a lightweight mock server that simulates OpenAI's streaming API:

```typescript
// test/fixtures/mock-server.ts
import { createServer } from "node:http";

export function createMockOpenAI(options: {
  response?: string;
  toolCalls?: ToolCall[];
  error?: { status: number; message: string };
}) {
  return createServer((req, res) => {
    // Parse the request body
    // Return SSE chunks matching the options
    // Support both text-only and tool-call responses
  });
}
```

#### 4.2 Agent Lifecycle Test

```typescript
describe("Agent lifecycle", () => {
  it("handles initialize → session/new → session/prompt", async () => {
    // Start mock server
    // Spawn the agent process
    // Send initialize request
    // Send session/new request
    // Send session/prompt request
    // Collect streamed chunks
    // Verify response has end_turn
  });
});
```

#### 4.3 Prompt Roundtrip Test

```typescript
describe("Prompt roundtrip", () => {
  it("streams text chunks and returns end_turn", async () => {
    // Mock server returns "Hello, world!"
    // Verify agent sends agent_message_chunk updates
    // Verify final response has stopReason: "end_turn"
  });

  it("handles abort/cancel", async () => {
    // Start a slow mock response
    // Send cancel notification
    // Verify stopReason: "cancelled"
  });
});
```

### 5. Test Helpers

```typescript
// test/helpers.ts
import { spawn } from "node:child_process";

export async function spawnAgent(config: AgentConfig) {
  const child = spawn("node", ["dist/main.js"], {
    env: {
      GENERIC_ACP_BASE_URL: config.baseUrl,
      GENERIC_ACP_API_KEY: config.apiKey,
      GENERIC_ACP_MODEL: config.model,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    send: (message: unknown) => {
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    readMessage: (): Promise<unknown> => {
      return new Promise((resolve) => {
        let buffer = "";
        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          if (lines.length > 0) {
            resolve(JSON.parse(lines[0]));
          }
        });
      });
    },
  };
}
```

### 6. CI Configuration

**Optional:** Add a GitHub Actions workflow:

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm test
```

## Files to Create / Modify

| File | Purpose | Status |
|------|---------|--------|
| `vitest.config.ts` | **NEW** — Vitest configuration | **done** |
| `package.json` | Add vitest dependency + `test`/`test:watch`/`test:coverage` scripts | **done** |
| `test/unit/config.test.ts` | **NEW** — Config loading tests (8 assertions) | **done** |
| `test/unit/content.test.ts` | **NEW** — Content block conversion tests (12 assertions) | **done** |
| `test/unit/session.test.ts` | **NEW** — Session store tests (8 assertions) | **done** |
| `test/unit/errors.test.ts` | **NEW** — Error classification tests (10 assertions) | **done** |
| `test/integration/agent.test.ts` | **NEW** — Agent lifecycle tests | remaining |
| `test/integration/prompt-roundtrip.test.ts` | **NEW** — Prompt flow tests | remaining |
| `test/fixtures/mock-server.ts` | **NEW** — Mock OpenAI server | remaining |

## Testing Strategy by Component

| Component | Unit Tests | Integration Tests | Manual Tests |
|-----------|-----------|-------------------|--------------|
| Config loading | ✓ | | ✓ |
| Content conversion | ✓ | | |
| Session store | ✓ | | |
| Error handling | ✓ | | |
| Streaming | ✓ | ✓ | ✓ |
| Agent lifecycle | | ✓ | ✓ |
| Tool calling | ✓ | ✓ | ✓ |
| MCP bridging | ✓ | ✓ | ✓ |
| Provider communication | | ✓ | ✓ |

## Acceptance Criteria

- [ ] Vitest is configured and `npm test` runs successfully
- [ ] Unit tests exist for: config, content, session, errors
- [ ] Integration tests exist for: agent lifecycle, prompt roundtrip
- [ ] Mock OpenAI server is implemented and usable in tests
- [ ] All tests pass with `npm run typecheck && npm run build && npm test`
- [x] Test coverage is at least 70% for core modules (`npm run test:coverage`, `src/` except the process entry `src/main.ts`)
- [ ] CI pipeline runs tests (optional but recommended)
