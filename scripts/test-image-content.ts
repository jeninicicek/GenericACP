import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

const captured: Array<{ url: string; body: unknown }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendSse(res: ServerResponse, lines: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const line of lines) {
    res.write(`data: ${line}\n\n`);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }));
    return;
  }
  const raw = await readBody(req);
  const body = JSON.parse(raw);
  captured.push({ url: req.url ?? "", body });

  if (req.url?.endsWith("/v1/chat/completions")) {
    const user = (body.messages as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === "user")
      .pop();
    const echoed = `received ${JSON.stringify(user?.content)}`;
    sendSse(res, [
      JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta: { role: "assistant", content: echoed.slice(0, 8) }, finish_reason: null }],
      }),
      JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [{ index: 0, delta: { content: echoed.slice(8) }, finish_reason: null }],
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
  } else if (req.url?.endsWith("/v1/responses")) {
    const user = (body.input as Array<{ role: string; content: unknown }>)
      .filter((m) => m.role === "user")
      .pop();
    const echoed = `received ${JSON.stringify(user?.content)}`;
    sendSse(res, [
      JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: echoed,
      }),
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "r1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "mock",
          output: [],
          incomplete_details: null,
        },
      }),
    ]);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const IMAGE_BLOCK = {
  type: "image",
  data: "iVBORw0KGgo=",
  mimeType: "image/png",
} as const;

const PROMPT = [
  { type: "text", text: "Describe this image:" },
  IMAGE_BLOCK,
];

async function drive(extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [resolve("dist/main.js")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      GENERIC_ACP_BASE_URL: baseUrl,
      GENERIC_ACP_API_KEY: "test-key",
      GENERIC_ACP_MODEL: "mock-model",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  const app = new ClientApp();
  const out: { image?: boolean; text?: string } = {};

  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", { protocolVersion: 1 });
    const promptCaps = init.agentCapabilities.promptCapabilities;
    out.image = promptCaps.image;

    const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();
    await session.prompt(PROMPT);

    let text = "";
    for (;;) {
      const update = await session.nextUpdate();
      if (update.kind === "stop") {
        break;
      }
      if (update.kind === "session_update" && update.update.sessionUpdate === "agent_message_chunk") {
        const content = update.update.content;
        const blocks = Array.isArray(content) ? content : content ? [content] : [];
        for (const block of blocks) {
          if (block && block.type === "text") {
            text += block.text;
          }
        }
      }
    }
    out.text = text;
  });

  child.stdin.end();
  await new Promise((res) => {
    child.once("exit", res);
    setTimeout(() => child.kill(), 5000);
  });
  return out;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
  console.log(`ok: ${msg}`);
}

let base = captured.length;
const a = await drive({});
const aReq = captured[base];
const aUser = (aReq.body as { messages: Array<{ role: string; content: unknown }> }).messages
  .filter((m) => m.role === "user")
  .pop();
const aContent = aUser?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
assert(a.image === true, "A: initialize advertises image: true");
assert(Array.isArray(aUser?.content), "A: user message content is a part array");
assert(aContent.some((p) => p.type === "text" && p.text === "Describe this image:"), "A: text part present");
assert(
  aContent.some((p) => p.type === "image_url" && p.image_url?.url === "data:image/png;base64,iVBORw0KGgo="),
  "A: image_url part with base64 data URL present",
);
assert(a.text?.includes("received") === true, `A: final text arrives (${a.text})`);

base = captured.length;
const b = await drive({ GENERIC_ACP_SUPPORT_IMAGES: "false" });
const bReq = captured[base];
const bUser = (bReq.body as { messages: Array<{ role: string; content: unknown }> }).messages
  .filter((m) => m.role === "user")
  .pop();
assert(b.image === false, "B: imageSupport=false advertises image: false");
assert(typeof bUser?.content === "string", "B: user message flattened to plain text");
assert(bUser?.content === "Describe this image:", "B: image block dropped in text mode");
assert(b.text?.includes("received") === true, `B: final text arrives (${b.text})`);

base = captured.length;
const c = await drive({ GENERIC_ACP_API_MODE: "responses" });
const cReq = captured[base];
const cUser = (cReq.body as { input: Array<{ role: string; content: unknown }> }).input
  .filter((m) => m.role === "user")
  .pop();
const cContent = cUser?.content as Array<{ type: string; image_url?: string }>;
assert(c.image === true, "C: responses mode advertises image: true");
assert(
  cContent.some((p) => p.type === "input_image" && p.image_url === "data:image/png;base64,iVBORw0KGgo="),
  "C: responses input_image part present",
);
assert(c.text?.includes("received") === true, `C: final text arrives (${c.text})`);

server.close();
console.log("ALL CHECKS PASSED");