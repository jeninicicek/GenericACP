import { McpBridge } from "../src/mcp/bridge.js";

const bridge = new McpBridge();
await bridge.connectAll([
  {
    name: "mock",
    command: process.execPath,
    args: ["--experimental-strip-types", "scripts/mock-mcp-server.ts"],
    env: {},
  },
]);

const tools = bridge.getTools();
console.log("Discovered tools:", tools.map((t) => t.function.name).join(", "));

for (const name of ["mock_echo", "mock_add"]) {
  console.log(`hasTool("${name}"):`, bridge.hasTool(name));
}

const echoResult = await bridge.callTool("mock_echo", { message: "hello world" });
console.log("echo result:", echoResult);

const addResult = await bridge.callTool("mock_add", { a: 2, b: 3 });
console.log("add result:", addResult);

try {
  await bridge.callTool("unknown_tool", {});
} catch (err) {
  console.log("unknown tool error:", err instanceof Error ? err.message : String(err));
}

await bridge.close();
console.log("Bridge closed cleanly.");