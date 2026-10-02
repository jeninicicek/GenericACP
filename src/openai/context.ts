import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export interface ContextOverflow {
  promptTokens: number;
  contextTokens: number;
}

const TRUNCATION_NOTE = "\n\n[truncated to fit the model context window]";

export class ContextLimitError extends Error {
  constructor(promptTokens: number, contextTokens: number) {
    super(
      `The prompt is about ${promptTokens} tokens and the model context is ${contextTokens} tokens. The request was not sent.`,
    );
    this.name = "ContextLimitError";
  }
}

export function estimateTokens(messages: unknown, tools: unknown): number {
  return Math.max(1, Math.ceil((jsonWeight(messages) + jsonWeight(tools)) / 4));
}

export function applyContextLimit(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  contextTokens: number | undefined,
): { messages: ChatCompletionMessageParam[]; tools: ChatCompletionTool[] } {
  if (!contextTokens || contextTokens <= 0) {
    return { messages, tools };
  }
  const promptTokens = estimateTokens(messages, tools);
  if (promptTokens <= contextTokens) {
    return { messages, tools };
  }
  const fitted = fitChatPayload(messages, tools, { promptTokens, contextTokens });
  const fittedTokens = estimateTokens(fitted.messages, fitted.tools);
  if (fittedTokens > contextTokens) {
    throw new ContextLimitError(promptTokens, contextTokens);
  }
  console.warn(
    `[context] estimated ${promptTokens} tokens exceeds model context ${contextTokens}; shrinking before the request.`,
  );
  return fitted;
}

export function fitChatPayload(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  overflow: ContextOverflow,
): { messages: ChatCompletionMessageParam[]; tools: ChatCompletionTool[] } {
  const reserve = Math.min(1024, Math.max(256, Math.floor(overflow.contextTokens / 16)));
  const budgetTokens = Math.max(1, overflow.contextTokens - reserve);
  if (overflow.promptTokens <= budgetTokens) {
    return { messages, tools };
  }

  const scale = (budgetTokens / overflow.promptTokens) * 0.9;
  const nextMessages = messages.map((message) => structuredClone(message));
  let nextTools = tools.map((tool) => structuredClone(tool));
  const targetWeight = Math.max(1, Math.floor((jsonWeight(nextMessages) + jsonWeight(nextTools)) * scale));

  while (overWeight(nextMessages, nextTools, targetWeight) && nextTools.length > 0 && jsonWeight(nextTools) > jsonWeight(nextMessages)) {
    nextTools = nextTools.slice(0, -1);
  }

  while (overWeight(nextMessages, nextTools, targetWeight) && nextMessages.length > 1) {
    nextMessages.shift();
    while (nextMessages[0]?.role === "tool") {
      nextMessages.shift();
    }
  }

  for (let step = 0; step < 24 && overWeight(nextMessages, nextTools, targetWeight); step++) {
    if (!shrinkLongestText(nextMessages)) {
      break;
    }
  }

  while (overWeight(nextMessages, nextTools, targetWeight) && nextTools.length > 0) {
    nextTools = nextTools.slice(0, -1);
  }

  return { messages: nextMessages, tools: nextTools };
}

function overWeight(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  targetWeight: number,
): boolean {
  return jsonWeight(messages) + jsonWeight(tools) > targetWeight;
}

function shrinkLongestText(messages: ChatCompletionMessageParam[]): boolean {
  let best: { index: number; length: number; part?: number } | undefined;
  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]?.content;
    if (typeof content === "string") {
      if (!best || content.length > best.length) {
        best = { index, length: content.length };
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (let part = 0; part < content.length; part++) {
      const block = content[part];
      if (block?.type === "text" && block.text.length > (best?.length ?? 0)) {
        best = { index, length: block.text.length, part };
      }
    }
  }
  if (!best || best.length < 2) {
    return false;
  }

  const message = messages[best.index];
  if (!message) {
    return false;
  }
  const nextLength = Math.floor(best.length * 0.6);
  const clip = (text: string) => text.slice(0, nextLength) + TRUNCATION_NOTE;

  if (typeof message.content === "string") {
    messages[best.index] = { ...message, content: clip(message.content) };
    return true;
  }
  if (Array.isArray(message.content) && best.part !== undefined) {
    const part = message.content[best.part];
    if (part?.type === "text") {
      part.text = clip(part.text);
      return true;
    }
  }
  return false;
}

function jsonWeight(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

