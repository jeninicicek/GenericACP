import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type {
  FunctionTool as ResponsesFunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseUsage,
} from "openai/resources/responses/responses";
import { responsesSamplingFields, dropRejectedSampling, samplingState, type SamplingOptions } from "./sampling.js";
import type { StreamDelta, TurnUsage } from "./streaming.js";

export interface ResponsesTextFormat {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: Record<string, unknown>;
}

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export function chatMessagesToResponseInput(messages: ChatCompletionMessageParam[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "user":
        input.push({
          role: "user",
          content: contentToResponseInputContent(message.content),
        });
        break;
      case "system":
        input.push({
          role: "system",
          content: [{ type: "input_text", text: contentToText(message.content) }],
        });
        break;
      case "assistant": {
        const text = contentToText(message.content);
        if (text.length > 0) {
          input.push({
            role: "assistant",
            content: [{ type: "input_text", text }],
          });
        }
        for (const call of message.tool_calls ?? []) {
          if (call.type !== "function") {
            continue;
          }
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        if (text.length === 0 && (message.tool_calls?.length ?? 0) === 0) {
          input.push({
            role: "assistant",
            content: [{ type: "input_text", text: "" }],
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: contentToText(message.content),
        });
        break;
    }
  }

  return input;
}

function contentToResponseInputContent(
  content: ChatCompletionMessageParam["content"],
): string | ResponseInputContent[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (Array.isArray(content)) {
    const items: ResponseInputContent[] = [];
    for (const part of content) {
      if (part.type === "text") {
        items.push({ type: "input_text", text: part.text });
      } else if (part.type === "image_url") {
        items.push({
          type: "input_image",
          image_url: part.image_url.url,
          detail: part.image_url.detail ?? "auto",
        });
      } else if (part.type === "input_audio") {
        items.push({
          type: "input_audio",
          input_audio: { data: part.input_audio.data, format: part.input_audio.format },
        } as unknown as ResponseInputContent);
      }
    }
    return items;
  }
  return [{ type: "input_text", text: "" }];
}

export async function* streamResponses(
  client: OpenAI,
  model: string,
  input: string | ResponseInputItem[],
  tools: ResponsesFunctionTool[],
  signal: AbortSignal,
  textFormat?: ResponsesTextFormat,
  sampling?: SamplingOptions,
): AsyncGenerator<StreamDelta> {
  const samplingFields = samplingState(sampling);
  let withFormat = Boolean(textFormat);
  const create = () =>
    client.responses.create(
      {
        model,
        input,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(withFormat && textFormat ? { text: { format: textFormat } } : {}),
        ...responsesSamplingFields(samplingFields),
      },
      { signal },
    );

  let stream: Awaited<ReturnType<typeof create>>;
  for (;;) {
    try {
      stream = await create();
      break;
    } catch (error) {
      const dropped = dropRejectedSampling(samplingFields, error);
      if (dropped) {
        console.warn(`[sampling] provider rejected ${dropped}; retrying without it.`);
        continue;
      }
      if (signal.aborted || !withFormat || !textFormat || !isResponsesSchemaRejection(error)) {
        throw error;
      }
      console.warn("[structured-output] provider rejected Responses text.format; retrying without it.");
      withFormat = false;
    }
  }

  const toolCalls = new Map<number, ToolCallAccumulator>();

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        yield { type: "text", text: event.delta };
        break;

      case "response.reasoning_text.delta":
        yield { type: "reasoning", text: event.delta };
        break;

      case "response.reasoning_summary_text.delta":
        yield { type: "reasoning", text: event.delta };
        break;

      case "response.output_item.added":
        if (event.item.type === "function_call") {
          const call = event.item as ResponseFunctionToolCall;
          yield {
            type: "tool_call",
            index: event.output_index,
            ...(call.call_id || call.id ? { id: call.call_id ?? call.id } : {}),
            ...(call.name ? { name: call.name } : {}),
          };
        }
        break;

      case "response.function_call_arguments.delta": {
        const acc = toolCalls.get(event.output_index);
        if (acc) {
          acc.arguments += event.delta;
        }
        yield {
          type: "tool_call",
          index: event.output_index,
          ...(acc?.id ? { id: acc.id } : {}),
          ...(acc?.name ? { name: acc.name } : {}),
          arguments: event.delta,
        };
        break;
      }

      case "response.output_item.done":
        if (event.item.type === "function_call") {
          const call = event.item as ResponseFunctionToolCall;
          const acc = toolCalls.get(event.output_index) ?? {
            index: event.output_index,
            id: "",
            name: "",
            arguments: "",
          };
          acc.id = call.call_id ?? call.id ?? acc.id;
          acc.name = call.name ?? acc.name;
          acc.arguments = call.arguments || acc.arguments;
          toolCalls.set(event.output_index, acc);
        }
        break;

      case "response.completed": {
        const hasFunctionCalls = event.response.output.some(
          (item: ResponseOutputItem) => item.type === "function_call",
        );
        const usage = event.response.usage ? mapResponsesUsage(event.response.usage) : undefined;
        yield {
          type: "done",
          finishReason: hasFunctionCalls ? "tool_calls" : finishReasonFor(event.response),
          ...(usage ? { usage } : {}),
        };
        break;
      }
    }
  }
}

function isResponsesSchemaRejection(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) {
    return false;
  }
  if (error.status !== 400 && error.status !== 422) {
    return false;
  }
  return /json_schema|text\.format|response_format|unsupported/i.test(error.message);
}

function finishReasonFor(response: Response): string {
  if (response.status === "incomplete" && response.incomplete_details?.reason) {
    switch (response.incomplete_details.reason) {
      case "max_output_tokens":
        return "length";
      case "content_filter":
        return "content_filter";
      default:
        return "incomplete";
    }
  }
  return "stop";
}

function mapResponsesUsage(usage: ResponseUsage): TurnUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens != null
      ? { cachedReadTokens: usage.input_tokens_details.cached_tokens }
      : {}),
    ...(usage.output_tokens_details?.reasoning_tokens != null
      ? { thoughtTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
  };
}

function contentToText(content: ChatCompletionMessageParam["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : "[non-text content]"))
      .join("\n");
  }
  return "";
}