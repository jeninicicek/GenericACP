import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const CLIENT_INFO = { name: "generic-acp-agent", version: "0.1.0" };

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private client: Client;
  private transport: Transport | null = null;

  constructor(readonly serverName: string) {
    this.client = new Client(CLIENT_INFO);
  }

  async connect(transport: Transport): Promise<void> {
    this.transport = transport;
    await this.client.connect(transport);
  }

  async listTools(): Promise<McpToolDef[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: "object",
        properties: (t.inputSchema as { properties?: Record<string, object> }).properties ?? {},
        required: (t.inputSchema as { required?: string[] }).required ?? [],
      },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (!content || content.length === 0) {
      const toolResult = (result as { toolResult?: unknown }).toolResult;
      return toolResult != null ? JSON.stringify(toolResult) : "No output";
    }
    return content
      .filter((c): c is { type: string; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
}
