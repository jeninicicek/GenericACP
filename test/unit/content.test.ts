import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  contentBlocksToMessageContent,
  contentBlocksToText,
  messageContentToContentBlocks,
} from "../../src/acp/content.js";

describe("contentBlocksToText", () => {
  it("converts text blocks", () => {
    expect(contentBlocksToText([{ type: "text", text: "hello" }])).toBe("hello");
  });

  it("converts resource_link blocks", () => {
    expect(
      contentBlocksToText([{ type: "resource_link", name: "file.txt", uri: "file:///a.txt" }]),
    ).toBe("[file.txt](file:///a.txt)");
  });

  it("converts resource blocks with text", () => {
    expect(contentBlocksToText([{ type: "resource", resource: { text: "contents" } }])).toBe("contents");
  });

  it("skips empty blocks", () => {
    expect(
      contentBlocksToText([
        { type: "text", text: "" },
        { type: "resource", resource: { mimeType: "image/png", data: "aGk=" } },
      ]),
    ).toBe("");
  });

  it("joins multiple blocks with newlines", () => {
    expect(
      contentBlocksToText([
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });
});

describe("contentBlocksToMessageContent", () => {
  it("returns a string for text-only content", () => {
    const result = contentBlocksToMessageContent([{ type: "text", text: "hi" }]);
    expect(result).toBe("hi");
  });

  it("returns an array for mixed content (text + image)", () => {
    const result = contentBlocksToMessageContent([
      { type: "text", text: "see:" },
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("converts image data blocks to data URLs", () => {
    const result = contentBlocksToMessageContent([
      { type: "image", mimeType: "image/png", data: "aGk=" },
    ]);
    expect(result).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
    ]);
  });

  it("returns [] for empty input (no text part to unwrap)", () => {
    expect(contentBlocksToMessageContent([])).toEqual([]);
  });
});

describe("messageContentToContentBlocks", () => {
  it("converts a plain string back to a text block", () => {
    expect(messageContentToContentBlocks("hi")).toEqual([{ type: "text", text: "hi" }]);
  });

  it("returns [] for an empty string", () => {
    expect(messageContentToContentBlocks("")).toEqual([]);
  });

  it("round-trips image parts as image blocks", () => {
    const blocks = messageContentToContentBlocks([
      { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
    ]);
    expect(blocks).toEqual([{ type: "image", mimeType: "image/png", data: "aGk=" }]);
  });
});