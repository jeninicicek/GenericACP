import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { GenericAcpAgent } from "../../src/acp/agent.js";
import type { Session } from "../../src/acp/session.js";
import { mcpFingerprint } from "../../src/mcp/bridge.js";
import type { AgentConfig } from "../../src/config/config.js";
import type { OpenAiProvider } from "../../src/openai/provider.js";
import type { StreamDelta } from "../../src/openai/streaming.js";

const config: AgentConfig = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "test",
  model: "mock",
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const close = cleanups.pop();
    if (close) {
      await close();
    }
  }
});

function fakeConn(overrides: Record<string, unknown> = {}): AgentSideConnection {
  return {
    sessionUpdate: vi.fn(async () => {}),
    requestPermission: vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "allow_once" },
    })),
    readTextFile: vi.fn(async () => ({ content: "file" })),
    writeTextFile: vi.fn(async () => ({})),
    createTerminal: vi.fn(),
    ...overrides,
  } as unknown as AgentSideConnection;
}

function scripted(deltas: StreamDelta[]): Pick<OpenAiProvider, "streamChat"> {
  return {
    async *streamChat() {
      for (const delta of deltas) {
        yield delta;
      }
    },
  };
}

async function closeMcp(agent: GenericAcpAgent, sessionId: string): Promise<void> {
  const store = (
    agent as unknown as {
      sessions: { get(id: string): { mcpBridge: { close(): Promise<void> } | null } };
    }
  ).sessions;
  await store.get(sessionId).mcpBridge?.close();
}

describe("prompt stop reasons", () => {
  it("maps length to max_tokens and content_filter to refusal", async () => {
    const cases: Array<[string, string]> = [
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
      ["stop", "end_turn"],
    ];

    for (const [finishReason, stopReason] of cases) {
      const agent = new GenericAcpAgent(
        fakeConn(),
        config,
        scripted([
          { type: "text", text: "hello" },
          { type: "done", finishReason },
        ]),
      );
      const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(result.stopReason).toBe(stopReason);
    }
  });
});

describe("cancel", () => {
  it("aborts a permission wait and leaves the session able to continue", async () => {
    const seen: ChatCompletionMessageParam[][] = [];
    let turn = 0;
    const conn = fakeConn({
      requestPermission: vi.fn(() => new Promise(() => {})),
    });
    const provider: Pick<OpenAiProvider, "streamChat"> = {
      async *streamChat(messages: ChatCompletionMessageParam[]) {
        seen.push(messages);
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call",
            index: 0,
            id: "call_1",
            name: "read_file",
            arguments: "{\"path\":\"a.ts\"}",
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", text: "resumed" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const agent = new GenericAcpAgent(conn, config, provider);
    const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const pending = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });

    await vi.waitFor(() => expect(conn.requestPermission).toHaveBeenCalled());
    await agent.cancel({ sessionId: session.sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });

    const next = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "again" }],
    });
    expect(next.stopReason).toBe("end_turn");
    const followUp = seen[1] ?? [];
    expect(followUp.some((message) => message.role === "tool" && message.content === "Cancelled.")).toBe(true);
  });

  it("kills a terminal that is still running", async () => {
    const kill = vi.fn(async () => ({}));
    const release = vi.fn(async () => ({}));
    const conn = fakeConn({
      createTerminal: vi.fn(async () => ({
        waitForExit: () => new Promise(() => {}),
        kill,
        release,
        currentOutput: vi.fn(),
      })),
    });
    const agent = new GenericAcpAgent(
      conn,
      config,
      scripted([
        {
          type: "tool_call",
          index: 0,
          id: "call_t",
          name: "run_terminal",
          arguments: "{\"command\":\"sleep 100\"}",
        },
        { type: "done", finishReason: "tool_calls" },
      ]),
    );
    const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const pending = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "run" }],
    });

    await vi.waitFor(() => expect(conn.createTerminal).toHaveBeenCalled());
    await agent.cancel({ sessionId: session.sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(kill).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps MCP tools available on the next prompt", async () => {
    const seen: string[][] = [];
    const provider: Pick<OpenAiProvider, "streamChat"> = {
      async *streamChat(_messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]) {
        seen.push(tools.map((tool) => (tool.type === "function" ? tool.function.name : tool.type)));
        yield { type: "text", text: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const agent = new GenericAcpAgent(fakeConn(), config, provider);
    const session = await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [
        {
          name: "mock",
          command: process.execPath,
          args: ["--experimental-strip-types", resolve("scripts/mock-mcp-server.ts")],
          env: [],
        },
      ],
    });
    cleanups.push(() => closeMcp(agent, session.sessionId));

    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "one" }] });
    await agent.cancel({ sessionId: session.sessionId });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "two" }] });

    expect(seen[0]).toContain("mock_echo");
    expect(seen[1]).toContain("mock_echo");
  });

  it("rejects a second prompt while the first is still running", async () => {
    const conn = fakeConn({
      requestPermission: vi.fn(() => new Promise(() => {})),
    });
    const agent = new GenericAcpAgent(
      conn,
      config,
      scripted([
        {
          type: "tool_call",
          index: 0,
          id: "call_1",
          name: "read_file",
          arguments: "{\"path\":\"a.ts\"}",
        },
        { type: "done", finishReason: "tool_calls" },
      ]),
    );
    const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const pending = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await vi.waitFor(() => expect(conn.requestPermission).toHaveBeenCalled());
    await expect(
      agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "again" }] }),
    ).rejects.toThrow(/already running/);
    await agent.cancel({ sessionId: session.sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("keeps partial assistant text in history when the stream fails", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const conn = fakeConn({
      sessionUpdate: vi.fn(async (notification: { update: Record<string, unknown> }) => {
        updates.push(notification.update);
      }),
    });
    let turn = 0;
    const seen: ChatCompletionMessageParam[][] = [];
    const agent = new GenericAcpAgent(conn, config, {
      async *streamChat(messages: ChatCompletionMessageParam[]) {
        seen.push(messages);
        turn += 1;
        if (turn === 1) {
          yield { type: "text", text: "partial-" };
          throw new Error("socket dropped");
        }
        yield { type: "text", text: "recovered" };
        yield { type: "done", finishReason: "stop" };
      },
    });
    const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const failed = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
    expect(failed.stopReason).toBe("end_turn");
    const errorUpdate = updates.find(
      (update) => update.sessionUpdate === "agent_message_chunk" && String((update.content as { text?: string }).text).includes("[Error:"),
    );
    expect(errorUpdate?.messageId).toBe("assistant-0");
    const next = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "continue" }],
    });
    expect(next.stopReason).toBe("end_turn");
    const assistant = seen[1]?.find((message) => message.role === "assistant");
    expect(assistant?.content).toContain("partial-");
    expect(assistant?.content).toContain("[Error:");
  });

  it("fails a tool call whose arguments are not a JSON object", async () => {
    let turn = 0;
    const conn = fakeConn();
    const agent = new GenericAcpAgent(conn, config, {
      async *streamChat() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: "tool_call" as const,
            index: 0,
            id: "call_bad",
            name: "read_file",
            arguments: "not-json",
          };
          yield { type: "done" as const, finishReason: "tool_calls" };
          return;
        }
        yield { type: "text" as const, text: "gave up" };
        yield { type: "done" as const, finishReason: "stop" };
      },
    });
    const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const result = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "read" }],
    });
    expect(result.stopReason).toBe("end_turn");
    expect(conn.requestPermission).not.toHaveBeenCalled();
    expect(conn.readTextFile).not.toHaveBeenCalled();
    const live = liveSession(agent, session.sessionId);
    expect(live.toolOutcomes.get("call_bad")?.status).toBe("failed");
  });

  it("replays stored tool status and locations", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const conn = fakeConn({
      sessionUpdate: vi.fn(async (notification: { update: Record<string, unknown> }) => {
        updates.push(notification.update);
      }),
    });
    const agent = new GenericAcpAgent(conn, config, scripted([]));
    const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const live = liveSession(agent, created.sessionId);
    live.messages.push(
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "Error: nope" },
    );
    live.recordToolOutcome("call_1", { status: "failed", locations: [{ path: resolve(process.cwd(), "a.ts") }] });

    await agent.loadSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers: [] });
    const toolCall = updates.find((update) => update.sessionUpdate === "tool_call");
    expect(toolCall).toMatchObject({
      status: "failed",
      locations: [{ path: resolve(process.cwd(), "a.ts") }],
      rawOutput: "Error: nope",
    });
  });

  it("reconnects MCP servers when session/load brings a different list", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const agent = new GenericAcpAgent(fakeConn(), config, scripted([]));
      const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const live = liveSession(agent, created.sessionId);
      const close = vi.fn(async () => {});
      live.mcpBridge = { close, connectedServers: 1 } as unknown as Session["mcpBridge"];
      live.mcpFingerprint = "previous";
      await agent.loadSession({
        sessionId: created.sessionId,
        cwd: process.cwd(),
        mcpServers: [{ type: "http", name: "remote", url: "http://127.0.0.1:1/mcp", headers: [] }],
      });
      expect(close).toHaveBeenCalledOnce();
      expect(error.mock.calls.flat().join(" ")).toContain("remote");
    } finally {
      error.mockRestore();
    }
  });

  it("keeps an already connected MCP bridge when the server list is unchanged", async () => {
    const servers = [{ name: "local", command: "node", args: ["server.js"], env: [] as Array<{ name: string; value: string }> }];
    const agent = new GenericAcpAgent(fakeConn(), config, scripted([]));
    const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const live = liveSession(agent, created.sessionId);
    const close = vi.fn(async () => {});
    live.mcpBridge = { close, connectedServers: 1 } as unknown as Session["mcpBridge"];
    live.mcpFingerprint = mcpFingerprint(servers);
    await agent.loadSession({ sessionId: created.sessionId, cwd: process.cwd(), mcpServers: servers });
    expect(close).not.toHaveBeenCalled();
  });

  it("closeSession aborts the turn and drops the MCP bridge", async () => {
    const conn = fakeConn({
      requestPermission: vi.fn(() => new Promise(() => {})),
    });
    const agent = new GenericAcpAgent(
      conn,
      config,
      scripted([
        {
          type: "tool_call",
          index: 0,
          id: "call_1",
          name: "read_file",
          arguments: "{\"path\":\"a.ts\"}",
        },
        { type: "done", finishReason: "tool_calls" },
      ]),
    );
    const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const live = liveSession(agent, created.sessionId);
    const close = vi.fn(async () => {});
    live.mcpBridge = { close, connectedServers: 1, getTools: () => [] } as unknown as Session["mcpBridge"];
    const pending = agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await vi.waitFor(() => expect(conn.requestPermission).toHaveBeenCalled());
    await agent.closeSession({ sessionId: created.sessionId });
    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(close).toHaveBeenCalledOnce();
    expect(() => liveSession(agent, created.sessionId)).toThrow();
  });
});

function liveSession(agent: GenericAcpAgent, sessionId: string): Session {
  return (agent as unknown as { sessions: { get(id: string): Session } }).sessions.get(sessionId);
}
