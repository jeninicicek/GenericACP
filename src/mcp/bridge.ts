import type { McpServer } from "@agentclientprotocol/sdk";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { McpClient, type McpToolDef } from "./client.js";

export interface McpStdioConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type McpLaunchConfig =
  | (McpStdioConfig & { kind?: "stdio" })
  | { name: string; kind: "http"; url: string; headers?: Record<string, string> }
  | { name: string; kind: "sse"; url: string; headers?: Record<string, string> }
  | { name: string; kind: "acp"; serverId: string };

interface ToolRoute {
  serverName: string;
  toolName: string;
}

export function mcpFingerprint(servers: McpServer[]): string {
  return servers.map(describeServer).sort().join("|");
}

export function launchesFromMcpServers(servers: McpServer[]): McpLaunchConfig[] {
  return servers.map((server) => {
    if ("type" in server && server.type === "http") {
      return { name: server.name, kind: "http", url: server.url, headers: headersToRecord(server.headers) };
    }
    if ("type" in server && server.type === "sse") {
      return { name: server.name, kind: "sse", url: server.url, headers: headersToRecord(server.headers) };
    }
    if ("type" in server && server.type === "acp") {
      return { name: server.name, kind: "acp", serverId: server.serverId };
    }
    return {
      name: server.name,
      kind: "stdio",
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    };
  });
}

export class McpBridge {
  private clients = new Map<string, McpClient>();
  private routes = new Map<string, ToolRoute>();
  private discoveredTools = new Map<string, McpToolDef>();

  get connectedServers(): number {
    return this.clients.size;
  }

  async connectAll(servers: McpLaunchConfig[], openAcp?: (serverId: string) => Transport): Promise<void> {
    for (const server of servers) {
      const client = new McpClient(server.name);
      try {
        await client.connect(await openTransport(server, openAcp));
        const tools = await client.listTools();
        this.clients.set(server.name, client);
        for (const tool of tools) {
          const namespacedName = `${server.name}_${tool.name}`;
          this.routes.set(namespacedName, { serverName: server.name, toolName: tool.name });
          this.discoveredTools.set(namespacedName, tool);
        }
      } catch (err) {
        console.error(`MCP server "${server.name}" failed to connect:`, err);
        await client.close().catch(() => {});
      }
    }
  }

  hasTool(name: string): boolean {
    return this.discoveredTools.has(name);
  }

  getTools(): ChatCompletionFunctionTool[] {
    return Array.from(this.discoveredTools.entries()).map(([namespacedName, tool]) => ({
      type: "function",
      function: {
        name: namespacedName,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const route = this.routes.get(name);
    if (!route) {
      throw new Error(`No MCP server found for tool: ${name}`);
    }
    const client = this.clients.get(route.serverName);
    if (!client) {
      throw new Error(`MCP client not connected: ${route.serverName}`);
    }
    return client.callTool(route.toolName, args);
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((client) => client.close()));
    this.clients.clear();
    this.routes.clear();
    this.discoveredTools.clear();
  }
}

async function openTransport(server: McpLaunchConfig, openAcp?: (serverId: string) => Transport): Promise<Transport> {
  if ("command" in server) {
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env,
      stderr: "ignore",
    });
  }
  if (server.kind === "http") {
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }
  if (server.kind === "sse") {
    return new SSEClientTransport(new URL(server.url), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }
  if (!openAcp) {
    throw new Error(`MCP server "${server.name}" uses the ACP transport, which is not available on this connection`);
  }
  return openAcp(server.serverId);
}

function headersToRecord(headers: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(headers.map((header) => [header.name, header.value]));
}

function describeServer(server: McpServer): string {
  if ("type" in server && server.type === "http") {
    return `http:${server.name}:${server.url}:${headerKey(server.headers)}`;
  }
  if ("type" in server && server.type === "sse") {
    return `sse:${server.name}:${server.url}:${headerKey(server.headers)}`;
  }
  if ("type" in server && server.type === "acp") {
    return `acp:${server.name}:${server.serverId}`;
  }
  const env = server.env.map((entry) => `${entry.name}=${entry.value}`).sort().join(",");
  return `stdio:${server.name}:${server.command}:${server.args.join(" ")}:${env}`;
}

function headerKey(headers: Array<{ name: string; value: string }>): string {
  return headers.map((header) => `${header.name}=${header.value}`).sort().join(",");
}
