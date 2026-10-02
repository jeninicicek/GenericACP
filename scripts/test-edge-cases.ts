import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import type { ActiveSession, ClientContext } from "@agentclientprotocol/sdk";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

const LONG_CHUNKS = 300;
const LONG_CHUNK_SIZE = 300;

const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));

  if (!req.url?.endsWith("/v1/chat/completions")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  const userMessages = (body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user");
  const lastUser = userMessages.at(-1)?.content ?? "";
  const userCount = userMessages.length;

  const sendChunk = (sse: ServerResponse, lines: string[]) => {
    for (const line of lines) {
      sse.write(`data: ${line}\n\n`);
    }
  };

  res.writeHead(200, { "content-type": "text/event-stream" });

  if (lastUser.startsWith("ABORT")) {
    sendChunk(res, [
      JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta: { role: "assistant", content: "partial-" }, finish_reason: null }],
      }),
    ]);
    setTimeout(() => res.destroy(), 50);
    return;
  }

  if (lastUser.startsWith("LONG")) {
    for (let i = 0; i < LONG_CHUNKS; i++) {
      sendChunk(res, [
        JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [{ index: 0, delta: { content: "x".repeat(LONG_CHUNK_SIZE) }, finish_reason: null }],
        }),
      ]);
    }
    sendChunk(res, [
      JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      "[DONE]",
    ]);
    res.end();
    return;
  }

  const echoed = `Echo ${lastUser} (${userCount} user messages)`;
  sendChunk(res, [
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
  ]);
  res.end();
});

await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

async function drive(onRun: (ctx: ClientContext) => Promise<void>): Promise<void> {
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

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  try {
    await new ClientApp().connectWith(stream, onRun);
  } finally {
    child.stdin.end();
    await new Promise<void>((res) => {
      child.once("exit", () => res());
      setTimeout(() => child.kill(), 5000);
    });
  }
}

async function readUntilStop(session: ActiveSession): Promise<string> {
  let text = "";
  for (;;) {
    const update = await session.nextUpdate();
    if (update.kind === "stop") {
      return text;
    }
    if (update.kind === "session_update" && update.update.sessionUpdate === "agent_message_chunk") {
      const content = update.update.content;
      if (content && content.type === "text") {
        text += content.text;
      }
    }
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  console.log(`ok: ${msg}`);
}

// Scenario 1: concurrent sessions do not interfere (spec 3.5)
await drive(async (ctx) => {
  await ctx.request("initialize", { protocolVersion: 1 });

  const sessionA = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();
  const sessionB = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();

  await sessionA.prompt([{ type: "text", text: "alpha-A" }]);
  await sessionB.prompt([{ type: "text", text: "beta-B" }]);

  const [aFull, bFull] = await Promise.all([readUntilStop(sessionA), readUntilStop(sessionB)]);

  console.log("A text:", aFull);
  console.log("B text:", bFull);
  assert(aFull.includes("alpha-A") && !aFull.includes("beta-B"), "session A stream contains only A's prompt");
  assert(bFull.includes("beta-B") && !bFull.includes("alpha-A"), "session B stream contains only B's prompt");
});

// Scenario 2: large streamed response is not truncated and lands in history (spec 3.4)
await drive(async (ctx) => {
  await ctx.request("initialize", { protocolVersion: 1 });
  const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();

  await session.prompt([{ type: "text", text: "LONG" }]);
  const longText = await readUntilStop(session, () => undefined);
  assert(longText.length === LONG_CHUNKS * LONG_CHUNK_SIZE, `large response streamed fully without truncation (len=${longText.length})`);

  await session.prompt([{ type: "text", text: "more" }]);
  const nextText = await readUntilStop(session, () => undefined);
  assert(nextText.includes("2 user messages"), `long history retained across turns (${nextText})`);
});

// Scenario 3: long conversation accumulates history (spec 3.3)
await drive(async (ctx) => {
  await ctx.request("initialize", { protocolVersion: 1 });
  const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();

  for (let i = 0; i < 10; i++) {
    await session.prompt([{ type: "text", text: `turn ${i}` }]);
    const text = await readUntilStop(session, () => undefined);
    assert(text.includes("Echo turn"), `turn ${i} streamed (${text})`);
  }
});

// Scenario 4: mid-stream network failure → friendly error, session recovers (spec 3.1)
await drive(async (ctx) => {
  await ctx.request("initialize", { protocolVersion: 1 });
  const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();

  await session.prompt([{ type: "text", text: "ABORT" }]);
  const partial = await readUntilStop(session, () => undefined);
  assert(partial.includes("partial-"), `first chunks streamed before abort (${partial.slice(0, 40)})`);
  assert(partial.includes("[Error:"), `mid-stream failure reported as [Error: ...] (${partial.slice(-120)})`);

  await session.prompt([{ type: "text", text: "recover" }]);
  const recovered = await readUntilStop(session, () => undefined);
  assert(recovered.includes("Echo recover") && recovered.includes("2 user messages"), `session recovers after network error (${recovered})`);
});

server.close();
console.log("ALL CHECKS PASSED");