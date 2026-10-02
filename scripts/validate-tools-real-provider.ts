import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { ClientApp, methods, ndJsonStream } from "@agentclientprotocol/sdk";

// Reusable Phase-1 tool-call validation against a live OpenAI-compatible
// provider. Drives dist/main.js and exercises the full tool-call loop:
// agent emits tool_call + requestPermission -> client auto-allows once,
// agent calls back via fs/read_text_file -> client serves the real file,
// tool result is fed back and the model produces a final answer.
//
//   GENERIC_ACP_BASE_URL=http://10.211.67.199:1234/v1 \
//   GENERIC_ACP_API_KEY=unused \
//   GENERIC_ACP_MODEL=qwen3.6-27b-mtp \
//   npx tsx scripts/validate-tools-real-provider.ts

const baseUrl = process.env.GENERIC_ACP_BASE_URL;
const apiKey = process.env.GENERIC_ACP_API_KEY;
const model = process.env.GENERIC_ACP_MODEL;

if (!baseUrl || !apiKey || !model) {
  console.error("Missing config: set GENERIC_ACP_BASE_URL, GENERIC_ACP_API_KEY, GENERIC_ACP_MODEL");
  process.exit(2);
}

const targetPath = "C:/DEV/GenericACP/package.json";

const child = spawn(process.execPath, [resolve("dist/main.js")], {
  cwd: resolve("."),
  env: { ...process.env, GENERIC_ACP_BASE_URL: baseUrl, GENERIC_ACP_API_KEY: apiKey, GENERIC_ACP_MODEL: model },
  stdio: ["pipe", "pipe", "inherit"],
});

const stream = ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

const events = {
  permissionRequested: 0 as number,
  readTextFileCalled: 0 as number,
  toolCallSeen: false,
  finalText: "",
};

try {
  const app = new ClientApp()
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      events.permissionRequested += 1;
      console.log(`[client] permission requested: ${ctx.params.toolCall.title}`);
      const option = ctx.params.options.find((o) => o.kind === "allow_once");
      return { outcome: { outcome: "selected" as const, optionId: (option ?? ctx.params.options[0]).optionId } };
    })
    .onRequest(methods.client.fs.readTextFile, async (ctx) => {
      events.readTextFileCalled += 1;
      console.log(`[client] read_text_file ${ctx.params.path}`);
      return { content: readFileSync(ctx.params.path, "utf8") };
    });

  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true } },
    });
    console.log(`provider: ${baseUrl}`);
    console.log(`model: ${model}`);

    const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();
    const started = Date.now();

    await session.prompt([
      {
        type: "text",
        text: `Use the read_file tool to read the file at ${targetPath}, then report the value of its "name" field. ` +
          `If the answer is not in the file, say so.`,
      },
    ]);

    for (;;) {
      const update = await session.nextUpdate();
      if (update.kind === "stop") {
        console.log(`\n--- stopReason: ${update.stopReason} (${Date.now() - started}ms)`);
        break;
      }
      if (update.kind !== "session_update") {
        continue;
      }
      const u = update.update;
      if (u.sessionUpdate === "tool_call") {
        if (u.name === "read_file") {
          events.toolCallSeen = true;
        }
        console.log(`[agent] tool_call: ${u.name} (${u.status}) ${u.title ?? ""}`);
      } else if (u.sessionUpdate === "tool_call_update") {
        console.log(`[agent] tool_call_update: ${u.toolCallId} -> ${u.status}`);
      } else if (u.sessionUpdate === "agent_message_chunk") {
        const content = u.content;
        if (content && content.type === "text") {
          events.finalText += content.text;
          process.stdout.write(content.text);
        }
      }
    }
  });

  const passed =
    events.toolCallSeen &&
    events.readTextFileCalled > 0 &&
    events.permissionRequested > 0 &&
    events.finalText.includes("generic-acp-agent");

  console.log("\n--- results ---");
  console.log(`tool_call(read_file) streamed: ${events.toolCallSeen}`);
  console.log(`permission requests handled: ${events.permissionRequested}`);
  console.log(`fs/read_text_file calls served: ${events.readTextFileCalled}`);
  console.log(`final answer mentions the package name: ${events.finalText.includes("generic-acp-agent")}`);
  console.log(passed ? "RESULT: SUCCESS" : "RESULT: FAIL");
  process.exitCode = passed ? 0 : 1;
} finally {
  child.stdin.end();
  await new Promise<void>((res) => {
    child.once("exit", () => res());
    setTimeout(() => child.kill(), 5000);
  });
}