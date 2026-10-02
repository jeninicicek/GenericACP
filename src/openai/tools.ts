import type { ChatCompletionFunctionTool, ChatCompletionTool } from "openai/resources/chat/completions";
import type { FunctionTool as ResponsesFunctionTool } from "openai/resources/responses/responses";
import type { McpBridge } from "../mcp/bridge.js";

const BUILTIN_TOOLS: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal",
      description: "Run a terminal command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["command"],
      },
    },
  },
];

export function getTools(bridge?: McpBridge): ChatCompletionFunctionTool[] {
  const mcpTools = bridge?.getTools() ?? [];
  return [...BUILTIN_TOOLS, ...mcpTools];
}

export function chatToolToResponseTool(tool: ChatCompletionTool): ResponsesFunctionTool {
  if (tool.type !== "function" || !tool.function) {
    throw new Error(`Cannot map non-function tool to Responses API: ${JSON.stringify(tool).slice(0, 200)}`);
  }
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? null,
    strict: tool.function.strict ?? false,
  };
}
