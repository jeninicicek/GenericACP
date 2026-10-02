import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

export function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks.map(contentBlockToText).filter((text) => text.length > 0).join("\n");
}

export interface ContentMapOptions {
  images?: boolean;
  audio?: boolean;
  imageDetail?: "auto" | "low" | "high";
}

export function contentBlocksToMessageContent(
  blocks: ContentBlock[],
  options: ContentMapOptions = {},
): string | ChatCompletionContentPart[] {
  const parts: ChatCompletionContentPart[] = [];
  let text = "";

  const flushText = () => {
    if (text.length > 0) {
      parts.push({ type: "text", text });
      text = "";
    }
  };

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        text += text.length > 0 ? "\n" : "";
        text += block.text;
        break;
      case "image":
        if (options.images === false) break;
        flushText();
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.mimeType};base64,${block.data}`,
            ...(options.imageDetail ? { detail: options.imageDetail } : {}),
          },
        });
        break;
      case "audio": {
        if (!options.audio) break;
        const format = audioFormat(block.mimeType);
        if (!format) {
          text += text.length > 0 ? "\n" : "";
          text += `[audio ${block.mimeType} omitted]`;
          break;
        }
        flushText();
        parts.push({ type: "input_audio", input_audio: { data: block.data, format } });
        break;
      }
      case "resource_link":
        text += text.length > 0 ? "\n" : "";
        text += `[${block.name}](${block.uri})`;
        break;
      case "resource":
        if ("text" in block.resource) {
          text += text.length > 0 ? "\n" : "";
          text += block.resource.text;
        }
        break;
      default:
        break;
    }
  }
  flushText();

  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

export function messageContentToContentBlocks(
  content: ChatCompletionMessageParam["content"],
): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "image_url": {
        const match = DATA_URL_PATTERN.exec(part.image_url.url);
        if (match) {
          blocks.push({ type: "image", mimeType: match[1], data: match[2] });
        }
        break;
      }
      case "input_audio":
        blocks.push({
          type: "audio",
          mimeType: part.input_audio.format === "wav" ? "audio/wav" : "audio/mpeg",
          data: part.input_audio.data,
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

export function messagesHaveAudio(messages: ChatCompletionMessageParam[]): boolean {
  return messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "input_audio"));
}

export function stripAudio(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content) || message.role !== "user") return message;
    const content = message.content.flatMap((part) =>
      part.type === "input_audio" ? [{ type: "text" as const, text: "[audio omitted]" }] : [part],
    );
    return { ...message, content };
  });
}

function audioFormat(mimeType: string): "wav" | "mp3" | undefined {
  const mime = mimeType.toLowerCase();
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return undefined;
}

function contentBlockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[${block.name}](${block.uri})`;
    case "resource":
      return "text" in block.resource ? block.resource.text : "";
    default:
      return "";
  }
}
