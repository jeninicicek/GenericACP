import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

// Reusable Phase-1 provider validation: drives dist/main.js against any
// OpenAI-compatible provider configured via GENERIC_ACP_BASE_URL /
// GENERIC_ACP_API_KEY / GENERIC_ACP_MODEL (see PROVIDERS.md). Prints the
// initialize capabilities and streams one prompt to completion.
//
//   GENERIC_ACP_BASE_URL=https://api.openai.com/v1 \
//   GENERIC_ACP_API_KEY=sk-... \
//   GENERIC_ACP_MODEL=gpt-4o \
//   npx tsx scripts/validate-real-provider.ts "Explain what an ACP agent is in 3 sentences."

const promptText = process.argv[2] ?? "Say hello in one short sentence.";

const baseUrl = process.env.GENERIC_ACP_BASE_URL;
const apiKey = process.env.GENERIC_ACP_API_KEY;
const model = process.env.GENERIC_ACP_MODEL;

if (!baseUrl || !apiKey || !model) {
  console.error("Missing config: set GENERIC_ACP_BASE_URL, GENERIC_ACP_API_KEY, GENERIC_ACP_MODEL");
  process.exit(2);
}

const child = spawn(process.execPath, [resolve("dist/main.js")], {
  cwd: resolve("."),
  env: { ...process.env, GENERIC_ACP_BASE_URL: baseUrl, GENERIC_ACP_API_KEY: apiKey, GENERIC_ACP_MODEL: model },
  stdio: ["pipe", "pipe", "inherit"],
});

const stream = ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

try {
  await new ClientApp().connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", { protocolVersion: 1 });
    console.log(`provider: ${baseUrl}`);
    console.log(`model: ${model}`);
    console.log(`capabilities: ${JSON.stringify(init.agentCapabilities)}`);

    const started = Date.now();
    const session = await ctx.buildSession({ cwd: resolve("."), mcpServers: [] }).start();

    await session.prompt([{ type: "text", text: promptText }]);

    let text = "";
    for (;;) {
      const update = await session.nextUpdate();
      if (update.kind === "stop") {
        console.log(`\n--- stopReason: ${update.stopReason} (${Date.now() - started}ms)`);
        break;
      }
      if (update.kind === "session_update") {
        const u = update.update;
        if (u.sessionUpdate === "agent_message_chunk") {
          const content = u.content;
          if (content && content.type === "text") {
            text += content.text;
            process.stdout.write(content.text);
          }
        }
      }
    }

    // Second turn to sanity-check history accumulation with the real provider.
    await session.prompt([{ type: "text", text: "Repeat the previous answer using the exact same words." }]);
    let text2 = "";
    for (;;) {
      const update = await session.nextUpdate();
      if (update.kind === "stop") {
        console.log(`\n--- turn 2 stopReason: ${update.stopReason}`);
        break;
      }
      if (update.kind === "session_update" && update.update.sessionUpdate === "agent_message_chunk") {
        const content = update.update.content;
        if (content && content.type === "text") {
          text2 += content.text;
        }
      }
    }
    console.log(`turn 1 length: ${text.length} chars`);
    console.log(`turn 2 length: ${text2.length} chars`);
    console.log("RESULT: SUCCESS");
    process.exitCode = 0;
  });
} finally {
  child.stdin.end();
  await new Promise<void>((res) => {
    child.once("exit", () => res());
    setTimeout(() => child.kill(), 5000);
  });
}