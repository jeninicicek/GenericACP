import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { messagesHaveAudio, stripAudio } from "../acp/content.js";
import { chatSamplingFields, dropRejectedSampling, samplingState, type SamplingOptions } from "./sampling.js";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
}

export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; finishReason: string; usage?: TurnUsage };

export interface ResponseFormat {
  type: "json_schema";
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
}

export async function* streamChatCompletion(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  signal: AbortSignal,
  responseFormat?: ResponseFormat,
  sampling?: SamplingOptions,
): AsyncGenerator<StreamDelta> {
  let payload = messages;
  let strippedAudio = false;
  const samplingFields = samplingState(sampling);
  const create = (withFormat: boolean, withUsage: boolean) =>
    client.chat.completions.create(
      {
        model,
        messages: payload,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(withFormat && responseFormat ? { response_format: responseFormat } : {}),
        ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        ...chatSamplingFields(samplingFields),
      },
      { signal },
    );

  let withFormat = Boolean(responseFormat);
  let withUsage = true;
  let stream: Awaited<ReturnType<typeof create>>;
  for (;;) {
    try {
      stream = await create(withFormat, withUsage);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!strippedAudio && messagesHaveAudio(payload) && /input_audio|audio/i.test(message)) {
        payload = stripAudio(payload);
        strippedAudio = true;
        console.warn("[audio] provider rejected input_audio; retrying without it.");
        continue;
      }
      const dropped = dropRejectedSampling(samplingFields, error);
      if (dropped) {
        console.warn(`[sampling] provider rejected ${dropped}; retrying without it.`);
        continue;
      }
      if (signal.aborted || !isOptionalParamRejection(error)) {
        throw error;
      }
      const next = nextChatAttempt({ withFormat, withUsage }, error);
      if (!next) {
        throw error;
      }
      if (withUsage && !next.withUsage) {
        console.warn("[usage] provider rejected stream_options.include_usage; retrying without it.");
      }
      if (withFormat && !next.withFormat) {
        console.warn("[structured-output] provider rejected response_format; retrying without it.");
      }
      withFormat = next.withFormat;
      withUsage = next.withUsage;
    }
  }

  let finishReason: string | undefined;
  let usage: TurnUsage | undefined;

  for await (const chunk of stream) {
    finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
    if (chunk.usage) {
      usage = mapChatUsage(chunk.usage);
    }

    const delta = chunk.choices[0]?.delta;
    if (delta && typeof delta === "object") {
      const reasoningContent = (delta as { reasoning_content?: string | null }).reasoning_content;
      if (reasoningContent) {
        yield { type: "reasoning", text: reasoningContent };
      }
      if (delta.content) {
        yield { type: "text", text: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          yield {
            type: "tool_call",
            index: tc.index,
            id: tc.id ?? undefined,
            name: tc.function?.name ?? undefined,
            arguments: tc.function?.arguments ?? undefined,
          };
        }
      }
    }
  }

  if (finishReason) {
    yield { type: "done", finishReason, ...(usage ? { usage } : {}) };
  }
}

interface ChatAttempt {
  withFormat: boolean;
  withUsage: boolean;
}

function isOptionalParamRejection(error: unknown): boolean {
  return error instanceof OpenAI.APIError && (error.status === 400 || error.status === 422);
}

function nextChatAttempt(current: ChatAttempt, error: unknown): ChatAttempt | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const formatHit = /response_format|json_schema/i.test(message);
  const usageHit = /stream_options|include_usage/i.test(message);

  if (usageHit && !formatHit) {
    return current.withUsage ? { withFormat: current.withFormat, withUsage: false } : undefined;
  }
  if (formatHit && !usageHit) {
    return current.withFormat ? { withFormat: false, withUsage: current.withUsage } : undefined;
  }
  if (current.withUsage) {
    return { withFormat: current.withFormat, withUsage: false };
  }
  if (current.withFormat) {
    return { withFormat: false, withUsage: false };
  }
  return undefined;
}

function mapChatUsage(usage: NonNullable<ChatCompletionChunk["usage"]>): TurnUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.completion_tokens_details?.reasoning_tokens != null
      ? { thoughtTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(usage.prompt_tokens_details?.cached_tokens != null
      ? { cachedReadTokens: usage.prompt_tokens_details.cached_tokens }
      : {}),
  };
}