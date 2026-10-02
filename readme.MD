# Generic ACP ↔ OpenAI-Compatible Bridge for JetBrains AI Assistant

## Overview

This document describes a concept for a lightweight ACP (Agent Client Protocol) agent that acts as a bridge between JetBrains AI Assistant and any OpenAI-compatible API.

The goal is to provide a vendor-neutral ACP agent that can be used with:

- OpenAI
- Azure OpenAI
- OpenRouter
- Ollama
- LM Studio
- vLLM
- Custom OpenAI-compatible services

without being tied to a specific provider such as Gemini, Claude, or Codex.

Prefered is TypeScript implementation...

## Problem Statement

Current ACP agents are primarily focused on specific ecosystems or full agent frameworks:

| Agent | Primary Focus |
|---------|---------|
| Gemini CLI | Gemini ecosystem |
| Codex CLI | OpenAI ecosystem |
| OpenCode | Full coding agent |
| Cline | Full coding agent |

While these solutions may support multiple model providers, they contain significantly more functionality than is required for a simple ACP-to-LLM bridge.

What is currently missing is a simple adapter:

```text
JetBrains
    │
    │ ACP
    ▼
Generic ACP Agent
    │
    │ OpenAI-Compatible API
    ▼
Any LLM Provider
```

This agent would act similarly to JDBC for databases: a thin abstraction layer between the IDE and the underlying provider.

## Architecture

```text
┌──────────────────────┐
│ IntelliJ IDEA / JB AI│
└──────────┬───────────┘
           │ ACP
           ▼
┌──────────────────────┐
│ Generic ACP Agent    │
├──────────────────────┤
│ ACP Protocol Layer   │
│ Session Management   │
│ Tool Execution       │
│ Model Adapter        │
└──────────┬───────────┘
           │ OpenAI API
           ▼
┌──────────────────────┐
│ OpenAI Compatible API│
└──────────┬───────────┘
           │
           ├─ OpenAI
           ├─ Azure OpenAI
           ├─ OpenRouter
           ├─ Ollama
           ├─ LM Studio
           └─ vLLM
```

## Design Goals

### Vendor Neutral

The agent should have no provider-specific implementation.

Example configuration:

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "secret",
  "model": "anthropic/claude-sonnet-4"
}
```

Changing providers should require only configuration changes.

### Minimal Footprint

The agent should implement only:

- ACP protocol
- OpenAI API communication
- Session management
- Tool calling

Avoid:

- planning engines
- autonomous workflows
- provider-specific integrations
- complex orchestration layers

### OpenAI Compatibility First

Support:

- Chat Completions
- Responses API
- Streaming
- Function Calling
- Structured Output

## ACP Responsibilities

### Initialization

```text
JetBrains
    │
initialize
    │
    ▼
ACP Agent
```

The agent advertises:

- supported capabilities
- tool support
- session capabilities
- optional modes

### Session Lifecycle

```text
create session
load session
resume session
close session
```

### Prompt Processing

```text
ACP Prompt
    ↓
OpenAI Request
    ↓
Provider Response
    ↓
ACP Response
```

No additional prompt manipulation should be required.

## Tool Calling

The bridge maps ACP tool requests to OpenAI tool/function calls.

```text
JetBrains
    ↓
ACP Tool Request
    ↓
OpenAI Tool Schema
    ↓
Model
    ↓
Tool Execution
    ↓
ACP Result
```

Potential tools:

- MCP tools
- IntelliJ MCP tools
- Filesystem tools
- Terminal tools
- Enterprise integrations

## Configuration Examples

### OpenRouter

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "...",
  "model": "anthropic/claude-sonnet-4"
}
```

### Azure OpenAI

```json
{
  "baseUrl": "https://company.openai.azure.com",
  "apiKey": "...",
  "model": "gpt-5"
}
```

### Ollama

```json
{
  "baseUrl": "http://localhost:11434/v1",
  "apiKey": "unused",
  "model": "qwen3-coder"
}
```

### LM Studio

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "apiKey": "unused",
  "model": "local-model"
}
```

## Proposed Internal Modules

```text
src/
├── acp/
│   ├── server.ts
│   ├── session.ts
│   └── protocol.ts
│
├── openai/
│   ├── provider.ts
│   ├── streaming.ts
│   └── tools.ts
│
├── config/
│   └── config.ts
│
├── mcp/
│   └── bridge.ts
│
└── main.ts
```

## Development Inspiration

Potential source projects worth studying:

### OpenCode

Useful for:

- provider abstraction
- agent structure
- session management

Repository:

```text
https://github.com/sst/opencode
```

### Gemini CLI

Useful for:

- ACP implementation
- protocol examples

Repository:

```text
https://github.com/google-gemini/gemini-cli
```

### Codex CLI

Useful for:

- OpenAI-based architecture
- coding workflows

Repository:

```text
https://github.com/openai/codex
```

### mcpc / acp-ai-provider

Useful for:

- ACP abstractions
- ACP ↔ AI SDK bridging

Repository:

```text
https://github.com/mcpc-tech/mcpc
```

## Optional Future Capabilities

### MCP Support

Expose MCP servers provided by JetBrains.

### Cost Tracking

Track:

- requests
- token usage
- estimated costs

### Model Profiles

```json
{
  "coding": "gpt-5",
  "review": "claude-sonnet-4",
  "fast": "gpt-5-mini"
}
```

### Provider Fallbacks

```json
{
  "primary": "openrouter",
  "secondary": "azure-openai"
}
```

## Candidate Project Names

```text
acp-openai-agent
```

```text
generic-acp-agent
```

```text
openai-acp-bridge
```

```text
universal-acp-agent
```

```text
acp-model-adapter
```

## Expected Benefits

- No vendor lock-in
- One ACP agent for all OpenAI-compatible providers
- Cloud and local model support
- Simpler enterprise deployments
- Consistent configuration
- Reusable ACP layer

## Vision

The project should become for ACP what JDBC became for databases:

> A thin, provider-agnostic integration layer allowing any ACP-capable client to communicate with any OpenAI-compatible model provider through a common interface.