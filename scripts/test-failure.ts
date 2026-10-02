import { McpBridge } from "../src/mcp/bridge.js";

const bridge = new McpBridge();
await bridge.connectAll([
  { name: "bad", command: "nonexistent-command-xyz", args: [], env: {} },
  {
    name: "mock",
    command: process.execPath,
    args: ["--experimental-strip-types", "scripts/mock-mcp-server.ts"],
    env: {},
  },
]);

console.log("after failures, hasTool(mock_echo):", bridge.hasTool("mock_echo"));
const result = await bridge.callTool("mock_echo", { message: "still works" });
console.log("result:", result);
await bridge.close();