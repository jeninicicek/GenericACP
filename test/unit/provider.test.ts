import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { OpenAiProvider } from "../../src/openai/provider.js";
import type { StreamDelta } from "../../src/openai/streaming.js";

const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "hi" }];

function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

function sse(res: import("node:http").ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: unknown, finish: string | null) =>
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  res.write(`data: ${chunk({ content }, null)}\n\n`);
  res.write(`data: ${chunk({}, "stop")}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function collect(provider: OpenAiProvider): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const delta of provider.streamChat(messages, [], new AbortController().signal)) {
    out.push(delta);
  }
  return out;
}

describe("OpenAiProvider", () => {
  it("reads the context window, lists models, and streams a chat completion", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server, baseUrl } = await listen((req, res) => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "m", object: "model", context_length: 8192 }, { id: "other", object: "model" }] }));
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        sse(res, "pong");
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const provider = new OpenAiProvider({ baseUrl, apiKey: "k", model: "m", responseSchema: { type: "object" } });
      await expect(provider.modelInfo()).resolves.toMatchObject({ id: "m", contextTokens: 8192 });
      await expect(provider.listModels()).resolves.toEqual(["m", "other"]);
      await expect(collect(provider)).resolves.toEqual([
        { type: "text", text: "pong" },
        { type: "done", finishReason: "stop" },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("8192"));
    } finally {
      warn.mockRestore();
      await new Promise((done) => server.close(() => done(undefined)));
    }
  });

  it("falls back to chat completions when the Responses endpoint is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server, baseUrl } = await listen((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "m", object: "model" }] }));
        return;
      }
      if (req.url?.endsWith("/responses")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
        return;
      }
      sse(res, "fallback");
    });

    try {
      const provider = new OpenAiProvider({ baseUrl, apiKey: "k", model: "m", apiMode: "responses" });
      await expect(collect(provider)).resolves.toContainEqual({ type: "text", text: "fallback" });
      expect(warn.mock.calls.some((call) => String(call[0]).includes("falling back"))).toBe(true);
    } finally {
      warn.mockRestore();
      await new Promise((done) => server.close(() => done(undefined)));
    }
  });

  it("keeps the configured model when the catalog is empty", async () => {
    const { server, baseUrl } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
    });
    try {
      const provider = new OpenAiProvider({ baseUrl, apiKey: "k", model: "configured", contextTokens: 1024 });
      await expect(provider.listModels()).resolves.toEqual(["configured"]);
    } finally {
      await new Promise((done) => server.close(() => done(undefined)));
    }
  });
});
