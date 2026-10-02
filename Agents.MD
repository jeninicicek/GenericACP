# Agent Instructions

This file gives AI coding agents (Claude Code, Codex CLI, etc.) the context needed to work in this repository. For the full design rationale, read [`readme.MD`](./readme.MD) first — this file only covers conventions and process.

## What this project is

A vendor-neutral ACP (Agent Client Protocol) agent that bridges JetBrains AI Assistant to any OpenAI-compatible API (OpenAI, Azure OpenAI, OpenRouter, Ollama, LM Studio, vLLM, ...). See `readme.MD` for the full architecture and design goals.

## Source layout

```text
src/
├── acp/
│   ├── agent.ts     — GenericAcpAgent: implements the ACP Agent interface
│   ├── session.ts   — SessionStore: in-memory per-session state
│   └── content.ts   — ACP ContentBlock[] -> plain text
├── openai/
│   ├── provider.ts  — OpenAiProvider: wraps the openai SDK
│   ├── streaming.ts — streams chat completion deltas
│   └── tools.ts     — MCP servers -> OpenAI tool schema (stub)
├── config/
│   └── config.ts    — loadConfig(): baseUrl/apiKey/model from file or env
└── main.ts          — entry point, wires stdio into an ACP connection
```

## Commands

```bash
npm run build       # tsc build to dist/
npm run typecheck   # tsc --noEmit
npm run dev         # run src/main.ts directly via tsx
npm start           # run the built dist/main.js
```

Config for local runs comes from `config.json` (copy from `config.example.json`) or the `GENERIC_ACP_BASE_URL` / `GENERIC_ACP_API_KEY` / `GENERIC_ACP_MODEL` env vars. Several hosts in one process use the `endpoints` array in that file, or `GENERIC_ACP_ENDPOINTS`. JetBrains `acp.json` launches the same process and puts that JSON in the agent `env`.

## Conventions

- TypeScript, strict mode, ESM (`type: module`) — use `.js` extensions in relative imports (NodeNext resolution).
- Keep the footprint minimal per `readme.MD`: no planning engines, no autonomous workflows, no provider-specific code paths. Provider differences are config only (`baseUrl` / `apiKey` / `model`).
- No comments unless they explain a non-obvious *why*.
- Use the `@agentclientprotocol/sdk` package (NOT the deprecated `@zed-industries/agent-client-protocol`).
- Verify changes by building (`npm run typecheck`) and, for anything touching the ACP flow (`agent.ts`, `session.ts`, `main.ts`), driving the built agent over stdio with a scripted JSON-RPC exchange (`initialize` → `session/new` → `session/prompt`) rather than assuming the type-check alone proves it works.

## Progress tracking

`progres/PROGRESS.md` is the living Done / To-do list for this project. Whenever you complete a task or identify new follow-up work, update that file:

- Move finished items from **To do** into **Done**, with a one-line note of what was actually built (file names, not prose).
- Add newly discovered work to **To do** rather than letting it live only in chat history.
- If a decision reverses something recorded as Done (e.g. swapping a dependency), edit the existing entry rather than leaving stale info.

If `progres/` accumulates more than one file, `PROGRESS.md` remains the canonical current-state summary — add new files only for content that doesn't fit that shape (e.g. a dated investigation note), and link to them from `PROGRESS.md`.
