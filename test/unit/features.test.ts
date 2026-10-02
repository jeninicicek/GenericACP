import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { GenericAcpAgent } from "../../src/acp/agent.js";
import type { SamplingOptions } from "../../src/openai/sampling.js";
import { applyCommandPrefix } from "../../src/acp/controls.js";
import { DocumentStore } from "../../src/acp/documents.js";
import { contentBlocksToMessageContent } from "../../src/acp/content.js";
import { SessionStore } from "../../src/acp/session.js";
import { dropRejectedSampling, samplingState } from "../../src/openai/sampling.js";

describe("applyCommandPrefix", () => {
  it("rewrites a slash command into its description plus the rest of the text", () => {
    const blocks = applyCommandPrefix(
      [{ type: "text", text: "/explain the loop" }],
      [{ name: "explain", description: "Explain this code", hint: "what" }],
    );
    expect(blocks).toEqual([{ type: "text", text: "Explain this code\nthe loop" }]);
  });
});

describe("DocumentStore", () => {
  it("applies a ranged edit and marks the focused document", () => {
    const docs = new DocumentStore();
    docs.open("file:///a.ts", "typescript", 1, "hello\nworld");
    docs.change("file:///a.ts", 2, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, text: "hi" }]);
    docs.focus("file:///a.ts", 2);
    const block = docs.contextBlocks()[0];
    expect(block).toMatchObject({ type: "text" });
    if (block?.type === "text") {
      expect(block.text).toContain("hi\nworld");
      expect(block.text).toContain("(focused)");
    }
  });
});

describe("audio content", () => {
  it("maps wav audio to an OpenAI input_audio part", () => {
    const content = contentBlocksToMessageContent(
      [{ type: "audio", mimeType: "audio/wav", data: "UklGRg==" }],
      { audio: true },
    );
    expect(content).toEqual([{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } }]);
  });
});

describe("dropRejectedSampling", () => {
  it("switches max_completion_tokens to max_tokens when that field is rejected", () => {
    const state = samplingState({ maxTokens: 32 });
    expect(dropRejectedSampling(state, new Error("unknown parameter max_completion_tokens"))).toBeTruthy();
    expect(state.useMaxCompletionTokens).toBe(false);
    expect(state.maxTokens).toBe(32);
  });
});

describe("SessionStore files", () => {
  it("reloads a session from disk after it leaves memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-sessions-"));
    const store = new SessionStore(dir);
    const created = store.create("C:/work");
    created.messages.push({ role: "user", content: "hello" });
    created.title = "hello";
    store.save(created);
    store.delete(created.id);

    const loaded = store.get(created.id);
    expect(loaded.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(loaded.cwd).toBe("C:/work");

    const listed = store.list("C:/work");
    expect(listed.sessions.map((session) => session.sessionId)).toContain(created.id);

    store.removeStored(created.id);
    expect(() => store.get(created.id)).toThrow();
  });
});

describe("GenericAcpAgent settings", () => {
  it("applies a mode, switches the model, and reports usage against the context window", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const calls: Array<{ model?: string; sampling?: SamplingOptions }> = [];
    const conn = {
      sessionUpdate: vi.fn(async (params: { update: Record<string, unknown> }) => {
        updates.push(params.update);
      }),
      requestPermission: vi.fn(),
    } as unknown as AgentSideConnection;
    const agent = new GenericAcpAgent(
      conn,
      {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "test",
        model: "base-model",
        contextTokens: 32768,
        request: { temperature: 0.2 },
        modes: [{ id: "brief", name: "Brief", model: "small", temperature: 0 }],
        commands: [{ name: "explain", description: "Explain this code" }],
      },
      {
        async *streamChat(_messages, _tools, _signal, call) {
          calls.push(call ?? {});
          yield { type: "text", text: "ok" };
          yield { type: "done", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } };
        },
      },
    );

    const created = await agent.newSession({ cwd: "C:/work", mcpServers: [] });
    expect(created.modes?.availableModes.map((mode) => mode.id)).toEqual(["default", "brief"]);
    expect(updates.some((update) => update.sessionUpdate === "available_commands_update")).toBe(true);

    await agent.setSessionMode({ sessionId: created.sessionId, modeId: "brief" });
    await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/explain the loop" }] });

    expect(calls[0]?.model).toBe("small");
    expect(calls[0]?.sampling?.temperature).toBe(0);
    expect(updates.some((update) => update.sessionUpdate === "usage_update" && update.used === 12 && update.size === 32768)).toBe(true);

    const switched = await agent.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: "model",
      value: "base-model",
    });
    expect(switched.configOptions.find((option) => option.id === "model")).toMatchObject({ currentValue: "base-model" });
  });

  it("routes a namespaced model to that endpoint and leaves the other alone", async () => {
    const calls: Array<{ endpoint: string; model?: string }> = [];
    const client = (endpoint: string) => ({
      async *streamChat(_messages: unknown, _tools: unknown, _signal: AbortSignal, call?: { model?: string }) {
        calls.push({ endpoint, model: call?.model });
        yield { type: "done" as const, finishReason: "stop" };
      },
      async listModels() {
        if (endpoint === "lmstudio") throw new Error("down");
        return ["ling:free", "other"];
      },
    });
    const conn = { sessionUpdate: vi.fn(async () => {}) } as unknown as AgentSideConnection;
    const agent = new GenericAcpAgent(
      conn,
      {
        baseUrl: "http://lm/v1",
        apiKey: "a",
        model: "bonsai",
        endpoints: [
          { id: "lmstudio", baseUrl: "http://lm/v1", apiKey: "a", model: "bonsai" },
          { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "ling:free" },
        ],
      },
      undefined,
      {
        lmstudio: client("lmstudio"),
        openrouter: client("openrouter"),
      },
    );

    const created = await agent.newSession({ cwd: "C:/work", mcpServers: [] });
    const model = created.configOptions?.find((option) => option.id === "model");
    expect(model && "options" in model ? model.options.map((option) => option.value) : []).toEqual([
      "lmstudio:bonsai",
      "openrouter:ling:free",
      "openrouter:other",
    ]);

    await agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", value: "openrouter:ling:free" });
    await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(calls).toEqual([{ endpoint: "openrouter", model: "ling:free" }]);
  });
});
