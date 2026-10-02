import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";
import type { InitializeResponse, PromptResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";

const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

  if (req.url?.endsWith("/v1/chat/completions")) {
    const usageChunk = {
      id: "c-u",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    let frames: object[];
    const toolCalls = body.messages.filter((m: { role: string }) => m.role === "tool").length;
    if (toolCalls === 0) {
      frames = [
        {
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking step one" }, finish_reason: null }],
        },
        {
          id: "c2",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [{ index: 0, delta: { content: "Reading util." }, finish_reason: null }],
        },
        {
          id: "c3",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"src/lib/util.ts"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "c4",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
        usageChunk,
      ];
    } else if (toolCalls === 1) {
      frames = [
        {
          id: "c5",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_2",
                    type: "function",
                    function: { name: "bogus_tool", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        usageChunk,
      ];
    } else {
      frames = [
        {
          id: "c6",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [{ index: 0, delta: { role: "assistant", content: "Conformance done." }, finish_reason: "stop" }],
        },
        usageChunk,
      ];
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const child = spawn(process.execPath, [resolve("dist/main.js")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    GENERIC_ACP_BASE_URL: baseUrl,
    GENERIC_ACP_API_KEY: "test-key",
    GENERIC_ACP_MODEL: "mock-model",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const rawFrames: string[] = [];
const recorder = new TransformStream<Uint8Array, Uint8Array>({
  transform(chunk, controller) {
    rawFrames.push(Buffer.from(chunk).toString("utf-8"));
    controller.enqueue(chunk);
  },
});

const stream = ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(recorder),
);

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  console.log(`ok: ${msg}`);
}

const results: {
  init?: InitializeResponse;
  promptResponse?: PromptResponse;
  updates: Array<Record<string, unknown>>;
} = { updates: [] };

const app = new ClientApp()
  .onRequest("session/request_permission", () => ({
    outcome: { outcome: "selected" as const, optionId: "allow_once" },
  }))
  .onRequest("fs/read_text_file", (ctx: { params: { path: string } }) => ({
    content: `content of ${ctx.params.path}`,
  }))
  .onRequest("fs/write_text_file", () => ({}));

await app.connectWith(stream, async (ctx) => {
  results.init = await ctx.request("initialize", { protocolVersion: 1 });

  const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();
  results.promptResponse = await session.prompt([{ type: "text", text: "do work" }]);

  for (;;) {
    const update = await session.nextUpdate();
    if (update.kind === "stop") {
      break;
    }
    if (update.kind === "session_update") {
      const u = update.update as Record<string, unknown>;
      results.updates.push(u);
    }
  }
});

const upd = results.updates;
const agentInfo = results.init?.agentInfo;
assert(typeof agentInfo?.name === "string" && agentInfo.name.length > 0, `initialize advertises agentInfo.name (${agentInfo?.name})`);
assert(typeof agentInfo?.version === "string" && agentInfo.version.length > 0, `initialize advertises agentInfo.version (${agentInfo?.version})`);
assert(
  (results.promptResponse?.stopReason ?? "") === "end_turn",
  `final stop reason is end_turn (${results.promptResponse?.stopReason})`,
);
const usage = results.promptResponse?.usage;
assert(typeof usage?.totalTokens === "number" && usage.totalTokens > 0, `PromptResponse.usage.totalTokens reported (${usage?.totalTokens})`);
assert(typeof usage?.inputTokens === "number" && usage.inputTokens > 0, `PromptResponse.usage.inputTokens reported (${usage?.inputTokens})`);
assert(typeof usage?.outputTokens === "number" && usage.outputTokens > 0, `PromptResponse.usage.outputTokens reported (${usage?.outputTokens})`);

const textChunks = upd.filter(
  (u) => u.sessionUpdate === "agent_message_chunk" && (u.content as { type: string }).type === "text",
);
assert(textChunks.length >= 2, `agent_message_chunk delivered per stream (${textChunks.length})`);
assert(
  textChunks.every((c) => typeof c.messageId === "string"),
  "agent_message_chunk includes messageId",
);
const thoughtChunks = upd.filter((u) => u.sessionUpdate === "agent_thought_chunk");
assert(thoughtChunks.length >= 1, `reasoning deltas surfaced as agent_thought_chunk (${thoughtChunks.length})`);
assert(
  thoughtChunks.some((c) => c.messageId === textChunks[0]?.messageId),
  "agent_thought_chunk shares messageId with the following text",
);

const readCall = upd.find((u) => u.sessionUpdate === "tool_call" && (u as { name?: string }).name === "read_file");
assert(Boolean(readCall), "read_file tool_call emitted");
assert(
  (readCall as { rawInput?: { path?: string } }).rawInput?.path === "src/lib/util.ts",
  "pending tool_call carries rawInput",
);
const readLocations = (readCall as { locations?: Array<{ path: string }> }).locations;
assert(
  Array.isArray(readLocations) && readLocations[0]?.path === resolve("src/lib/util.ts"),
  `file tool_call carries absolute locations (${readLocations?.[0]?.path})`,
);

const completed = upd.find(
  (u) => u.sessionUpdate === "tool_call_update" && (u as { toolCallId: string }).toolCallId === "call_1" && (u as { status?: string }).status === "completed",
);
assert(Boolean(completed), "completed tool_call_update emitted");
assert(
  (completed as { status?: string }).status === "completed",
  "successful tool resolves to status completed",
);
assert(
  (completed as { rawOutput?: string }).rawOutput === "content of src/lib/util.ts",
  `completed tool_call_update carries rawOutput from execution (rawOutput=${JSON.stringify((completed as { rawOutput?: string }).rawOutput)})`,
);
assert(
  (completed as { rawInput?: { path?: string } }).rawInput?.path === "src/lib/util.ts",
  "completed tool_call_update carries rawInput",
);

const failed = upd.find(
  (u) => u.sessionUpdate === "tool_call_update" && (u as { toolCallId: string }).toolCallId === "call_2" && (u as { status?: string }).status === "failed",
);
assert(Boolean(failed), "failing tool_call_update emitted");
assert(
  (failed as { status?: string }).status === "failed",
  `tool execution failure resolves to status failed (${(failed as { status?: string }).status})`,
);
assert(
  String((failed as { rawOutput?: unknown }).rawOutput).includes("Unknown tool: bogus_tool"),
  "failed tool_call_update carries rawOutput error detail",
);

const raw = rawFrames.join("");
assert(raw.includes('"status":"in_progress"'), "in_progress tool_call_update observed on the wire");
assert(raw.includes('"status":"failed"'), "failed tool_call_update observed on the wire");
assert(raw.includes('"agent_thought_chunk"'), "agent_thought_chunk observed on the wire");

child.stdin.end();
await new Promise<void>((res) => {
  child.once("exit", () => res());
  setTimeout(() => child.kill(), 5000);
});
server.close();
console.log("ALL CHECKS PASSED");