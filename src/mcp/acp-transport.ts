import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

interface PendingIncoming {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
}

export class AcpMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private connectionId: string | null = null;
  private readonly incoming = new Map<string, PendingIncoming>();
  private nextIncomingId = 1;

  constructor(
    private readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly notify: (method: string, params: Record<string, unknown>) => Promise<void>,
    private readonly serverId: string,
    private readonly register: (connectionId: string, transport: AcpMcpTransport) => void,
    private readonly unregister: (connectionId: string) => void,
  ) {}

  async start(): Promise<void> {
    const response = (await this.request("mcp/connect", { serverId: this.serverId })) as {
      connectionId?: string;
    };
    if (!response?.connectionId) {
      throw new Error(`mcp/connect for ${this.serverId} did not return a connectionId`);
    }
    this.connectionId = response.connectionId;
    this.register(this.connectionId, this);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.connectionId) {
      throw new Error("ACP MCP transport is not connected");
    }

    if ("method" in message && typeof message.method === "string") {
      const params = "params" in message && message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : null;
      if ("id" in message && message.id !== undefined) {
        try {
          const result = await this.request("mcp/message", {
            connectionId: this.connectionId,
            method: message.method,
            params,
          });
          this.onmessage?.({ jsonrpc: "2.0", id: message.id, result } as JSONRPCMessage);
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          this.onerror?.(wrapped);
          this.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: wrapped.message },
          } as JSONRPCMessage);
        }
        return;
      }
      await this.notify("mcp/message", {
        connectionId: this.connectionId,
        method: message.method,
        params,
      });
      return;
    }

    if (!("id" in message) || message.id === undefined) {
      return;
    }
    const pending = this.incoming.get(String(message.id));
    if (!pending) {
      return;
    }
    this.incoming.delete(String(message.id));
    if ("error" in message && message.error) {
      const errorMessage = typeof message.error === "object" && message.error && "message" in message.error
        ? String(message.error.message)
        : "MCP error";
      pending.reject(new Error(errorMessage));
      return;
    }
    const result = "result" in message && message.result && typeof message.result === "object"
      ? (message.result as Record<string, unknown>)
      : {};
    pending.resolve(result);
  }

  async close(): Promise<void> {
    const connectionId = this.connectionId;
    this.connectionId = null;
    if (connectionId) {
      this.unregister(connectionId);
      await this.request("mcp/disconnect", { connectionId }).catch(() => {});
    }
    for (const pending of this.incoming.values()) {
      pending.reject(new Error("ACP MCP transport closed"));
    }
    this.incoming.clear();
    this.onclose?.();
  }

  handleClientMessage(params: { method?: string; params?: unknown }): Promise<Record<string, unknown>> {
    if (!params.method) {
      return Promise.resolve({});
    }
    const id = `acp-${this.nextIncomingId++}`;
    return new Promise((resolve, reject) => {
      this.incoming.set(id, { resolve, reject });
      this.onmessage?.({
        jsonrpc: "2.0",
        id,
        method: params.method as string,
        params: params.params ?? {},
      } as JSONRPCMessage);
    });
  }

  handleClientNotification(params: { method?: string; params?: unknown }): void {
    if (!params.method) {
      return;
    }
    this.onmessage?.({
      jsonrpc: "2.0",
      method: params.method,
      params: params.params ?? {},
    } as JSONRPCMessage);
  }
}
