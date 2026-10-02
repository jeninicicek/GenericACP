import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

// Live checks that the text/tools drivers do not cover: an image prompt, and a
// json_schema response. Config is GENERIC_ACP_BASE_URL / GENERIC_ACP_API_KEY /
// GENERIC_ACP_MODEL, same as scripts/validate-real-provider.ts.

const baseUrl = process.env.GENERIC_ACP_BASE_URL;
const apiKey = process.env.GENERIC_ACP_API_KEY;
const model = process.env.GENERIC_ACP_MODEL;

if (!baseUrl || !apiKey || !model) {
  console.error("Missing config: set GENERIC_ACP_BASE_URL, GENERIC_ACP_API_KEY, GENERIC_ACP_MODEL");
  process.exit(2);
}

const only = process.argv[2];
if (only !== undefined && only !== "vision" && only !== "structured") {
  console.error("Usage: validate-live-extras.ts [vision|structured]");
  process.exit(2);
}

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

async function drive(prompt: Array<{ type: string; text?: string; mimeType?: string; data?: string }>, extraEnv: Record<string, string>): Promise<{ stopReason: string; text: string }> {
  const child = spawn(process.execPath, [resolve("dist/main.js")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      GENERIC_ACP_BASE_URL: baseUrl,
      GENERIC_ACP_API_KEY: apiKey,
      GENERIC_ACP_MODEL: model,
      GENERIC_ACP_TOOL_CHOICE: "none",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );

  try {
    return await new ClientApp().connectWith(stream, async (ctx) => {
      await ctx.request("initialize", { protocolVersion: 1 });
      const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();
      await session.prompt(prompt);
      let text = "";
      let stopReason = "";
      for (;;) {
        const update = await session.nextUpdate();
        if (update.kind === "stop") {
          stopReason = update.stopReason;
          break;
        }
        if (update.kind === "session_update" && update.update.sessionUpdate === "agent_message_chunk") {
          const content = update.update.content;
          const blocks = Array.isArray(content) ? content : content ? [content] : [];
          for (const block of blocks) {
            if (block && block.type === "text") text += block.text;
          }
        }
      }
      return { stopReason, text };
    });
  } finally {
    child.stdin.end();
    await new Promise<void>((res) => {
      child.once("exit", () => res());
      setTimeout(() => child.kill(), 5000);
    });
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (only !== "structured") {
  const vision = await drive(
    [
      { type: "text", text: "What color is this solid square? Reply with one word." },
      { type: "image", mimeType: "image/png", data: solidPng(32, 255, 0, 0) },
    ],
    {},
  );
  console.log(`vision stopReason: ${vision.stopReason}`);
  console.log(`vision text: ${vision.text}`);
  if (vision.stopReason !== "end_turn" || vision.text.includes("[Error:")) fail("vision request failed");
  if (!/red/i.test(vision.text)) fail("vision answer did not identify the red square");
  console.log("vision: SUCCESS");
}

if (only !== "vision") {
  const structured = await drive([{ type: "text", text: "Set answer to the single word pong." }], {
    GENERIC_ACP_RESPONSE_SCHEMA: JSON.stringify(schema),
  });
  console.log(`structured stopReason: ${structured.stopReason}`);
  console.log(`structured text: ${structured.text}`);
  if (structured.stopReason !== "end_turn" || structured.text.includes("[Error:")) fail("structured request failed");
  const parsed = JSON.parse(jsonObject(structured.text)) as { answer?: unknown };
  if (parsed.answer !== "pong") fail(`structured answer was ${JSON.stringify(parsed.answer)}`);
  console.log("structured: SUCCESS");
}

function jsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return text;
  return text.slice(start, end + 1);
}

function solidPng(size: number, r: number, g: number, b: number): string {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}
