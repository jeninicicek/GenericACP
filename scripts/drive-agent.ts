import { Writable, Readable } from "node:stream";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ClientApp, ndJsonStream } from "@agentclientprotocol/sdk";

const child = spawn(process.execPath, [resolve("dist/main.js")], {
  cwd: resolve("."),
  stdio: ["pipe", "pipe", "inherit"],
});

const stream = ndJsonStream(
  Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

const app = new ClientApp();

try {
  await app.connectWith(stream, async (ctx) => {
    const initResp = await ctx.request("initialize", { protocolVersion: 1 });
    console.log("initialize:", JSON.stringify(initResp));

    const sessionBuilder = ctx.buildSession({
      cwd: resolve("."),
      mcpServers: [
        {
          name: "mock",
          command: process.execPath,
          args: ["--experimental-strip-types", "scripts/mock-mcp-server.ts"],
          env: [],
        },
      ],
    });

    const session = await sessionBuilder.start();
    console.log("session/new sessionId:", session.sessionId);

    await ctx.notify("session/cancel", { sessionId: session.sessionId });
    console.log("session/cancel sent");
  });
  console.log("connection closed cleanly");
} finally {
  child.stdin.end();
  await new Promise((res) => {
    child.once("exit", () => res(undefined));
    setTimeout(() => child.kill(), 5000);
  });
}