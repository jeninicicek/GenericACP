import { describe, expect, it, vi } from "vitest";
import { launchesFromMcpServers, mcpFingerprint } from "../../src/mcp/bridge.js";
import { AcpMcpTransport } from "../../src/mcp/acp-transport.js";

describe("MCP server launch config", () => {
  it("keeps http, sse, and acp servers instead of dropping them", () => {
    const launches = launchesFromMcpServers([
      { type: "http", name: "web", url: "http://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] },
      { type: "sse", name: "events", url: "http://example.test/sse", headers: [] },
      { type: "acp", name: "ide", serverId: "srv-1" },
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "A", value: "1" }] },
    ]);
    expect(launches).toEqual([
      { name: "web", kind: "http", url: "http://example.test/mcp", headers: { Authorization: "Bearer t" } },
      { name: "events", kind: "sse", url: "http://example.test/sse", headers: {} },
      { name: "ide", kind: "acp", serverId: "srv-1" },
      { name: "local", kind: "stdio", command: "node", args: ["server.js"], env: { A: "1" } },
    ]);
  });

  it("changes the fingerprint when the server list changes", () => {
    const http = [{ type: "http" as const, name: "web", url: "http://example.test/mcp", headers: [] }];
    const sse = [{ type: "sse" as const, name: "web", url: "http://example.test/mcp", headers: [] }];
    expect(mcpFingerprint(http)).not.toBe(mcpFingerprint(sse));
  });
});

describe("AcpMcpTransport", () => {
  it("connects over mcp/connect and forwards a tool request", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "mcp/connect") {
        return { connectionId: "conn-1" };
      }
      return { tools: [] };
    });
    const registered = new Map<string, AcpMcpTransport>();
    const transport = new AcpMcpTransport(
      request,
      vi.fn(async () => {}),
      "srv-1",
      (connectionId, value) => {
        registered.set(connectionId, value);
      },
      (connectionId) => {
        registered.delete(connectionId);
      },
    );
    const received: unknown[] = [];
    transport.onmessage = (message) => {
      received.push(message);
    };

    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });

    expect(registered.has("conn-1")).toBe(true);
    expect(request).toHaveBeenCalledWith("mcp/message", {
      connectionId: "conn-1",
      method: "tools/list",
      params: {},
    });
    expect(received[0]).toMatchObject({ id: 7, result: { tools: [] } });

    await transport.close();
    expect(request).toHaveBeenCalledWith("mcp/disconnect", { connectionId: "conn-1" });
    expect(registered.size).toBe(0);
  });
});