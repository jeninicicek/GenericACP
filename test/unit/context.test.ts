import { describe, expect, it, vi } from "vitest";
import { applyContextLimit, fitChatPayload } from "../../src/openai/context.js";

describe("fitChatPayload", () => {
  it("keeps a prompt that already fits", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const fitted = fitChatPayload(messages, [], { promptTokens: 10, contextTokens: 32768 });
    expect(fitted.messages).toEqual(messages);
  });

  it("drops trailing tools and shortens the user message when the prompt is far over the window", () => {
    const fitted = fitChatPayload(
      [{ role: "user", content: "q".repeat(8_000) }],
      [
        { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
        { type: "function", function: { name: "mcp_tool", description: "z".repeat(8_000), parameters: { type: "object" } } },
      ],
      { promptTokens: 59894, contextTokens: 32768 },
    );
    const content = fitted.messages[0]?.content;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThan(8_000);
    expect(fitted.tools.every((tool) => tool.type !== "function" || tool.function.name !== "mcp_tool")).toBe(true);
  });
});

describe("applyContextLimit", () => {
  it("leaves a prompt unchanged when it fits the advertised context", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(applyContextLimit(messages, [], 32768).messages).toEqual(messages);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("shrinks before the request when the estimate exceeds the advertised context", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fitted = applyContextLimit([{ role: "user", content: "q".repeat(20_000) }], [], 1000);
      expect((fitted.messages[0]?.content as string).length).toBeLessThan(20_000);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
