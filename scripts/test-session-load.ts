import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

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
    const userCount = (body.messages as Array<{ role: string }>).filter((m) => m.role === "user").length;
    const echoed = `received ${userCount} user messages`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const line of [
      JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta: { role: "assistant", content: echoed }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      "[DONE]",
    ]) {
      res.write(`data: ${line}\n\n`);
    }
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
  loadSession?: boolean;
  loadResponse?: unknown;
  replay?: Array<{ kind?: string; text?: string; messageId?: string }>;
  text2?: string;
  wrongCwdError?: string;
  missingError?: string;
} = {};

const app = new ClientApp();

await app.connectWith(stream, async (ctx) => {
  const init = await ctx.request("initialize", { protocolVersion: 1 });
  results.loadSession = init.agentCapabilities.loadSession;

  const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();

  const readUntilStop = async (): Promise<string> => {
    let text = "";
    for (;;) {
      const update = await session.nextUpdate();
      if (update.kind === "stop") {
        break;
      }
      if (update.kind === "session_update" && update.update.sessionUpdate === "agent_message_chunk") {
        const content = update.update.content;
        if (content && content.type === "text") {
          text += content.text;
        }
      }
    }
    return text;
  };

  await session.prompt([{ type: "text", text: "first" }]);
  await readUntilStop();

  results.loadResponse = await ctx.request("session/load", {
    sessionId: session.sessionId,
    cwd: resolve("."),
    mcpServers: [],
  });

  const replay: typeof results.replay = [];
  for (let i = 0; i < 2; i++) {
    const update = await session.nextUpdate();
    if (update.kind === "session_update") {
      const u = update.update;
      if (u.sessionUpdate === "user_message_chunk") {
        const content = u.content;
        replay.push({ kind: "user", text: content.type === "text" ? content.text : undefined, messageId: u.messageId ?? undefined });
      } else if (u.sessionUpdate === "agent_message_chunk") {
        const content = u.content;
        replay.push({ kind: "agent", text: content.type === "text" ? content.text : undefined, messageId: u.messageId ?? undefined });
      }
    }
  }
  results.replay = replay;

  try {
    await ctx.request("session/load", {
      sessionId: session.sessionId,
      cwd: "C:/WRONG/DOES-NOT-MATCH",
      mcpServers: [],
    });
  } catch (error) {
    results.wrongCwdError = String((error as { message?: string }).message ?? error);
  }

  try {
    await ctx.request("session/load", {
      sessionId: "does-not-exist",
      cwd: resolve("."),
      mcpServers: [],
    });
  } catch (error) {
    results.missingError = String((error as { message?: string }).message ?? error);
  }

  await session.prompt([{ type: "text", text: "second" }]);
  results.text2 = await readUntilStop();
});

assert(results.loadSession === true, "initialize advertises loadSession: true");
assert(typeof results.loadResponse === "object" && results.loadResponse !== null, "session/load returns a response object");
assert(results.replay?.length === 2, "session/load replays 2 history chunks as notifications");
assert(results.replay?.[0]?.kind === "user" && results.replay[0].text === "first" && results.replay[0].messageId === "load-0", "user message replayed as user_message_chunk with messageId load-0");
assert(results.replay?.[1]?.kind === "agent" && results.replay[1].text?.includes("received 1") && results.replay[1].messageId === "load-1", "assistant message replayed as agent_message_chunk with messageId load-1");
assert(results.text2?.includes("received 2") === true, `history preserved across load (second prompt sees 2 user messages) (text2=${results.text2})`);
assert(typeof results.wrongCwdError === "string" && results.wrongCwdError.length > 0, `mismatched cwd rejected (${results.wrongCwdError})`);
assert(typeof results.missingError === "string", `unknown sessionId rejected (${results.missingError})`);
const raw = rawFrames.join("");
assert(raw.includes('"method":"session/update"'), "replayed history observed on the wire as session/update notifications");

child.stdin.end();
await new Promise<void>((res) => {
  child.once("exit", () => res());
  setTimeout(() => child.kill(), 5000);
});
server.close();
console.log("ALL CHECKS PASSED");