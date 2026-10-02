import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { DEFAULT_REQUEST_TIMEOUT_MS, type AgentConfig, type ApiMode } from "../config/config.js";
import type { SamplingOptions } from "./sampling.js";
import { applyContextLimit } from "./context.js";
import { openAiHttpOptions } from "./http.js";
import { listModelIds, loadModelInfo, type ModelInfo } from "./model-info.js";
import { chatMessagesToResponseInput, streamResponses, type ResponsesTextFormat } from "./responses.js";
import { streamChatCompletion, type ResponseFormat, type StreamDelta } from "./streaming.js";
import { chatToolToResponseTool } from "./tools.js";

export class OpenAiProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly apiMode: ApiMode;
  private readonly responseFormat: ResponseFormat | undefined;
  private readonly responsesTextFormat: ResponsesTextFormat | undefined;
  private readonly modelInfoPromise: Promise<ModelInfo>;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string> | undefined;

  constructor(config: AgentConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.headers = config.headers;
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      ...openAiHttpOptions(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      ...(config.headers ? { defaultHeaders: config.headers } : {}),
    });
    this.model = config.model;
    this.apiMode = config.apiMode ?? "chat-completions";
    this.modelInfoPromise = loadModelInfo({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      headers: config.headers,
      contextTokens: config.contextTokens,
    }).then((info) => {
      if (info.contextTokens) {
        const max =
          info.maxContextTokens && info.maxContextTokens !== info.contextTokens
            ? ` (model max ${info.maxContextTokens})`
            : "";
        console.warn(`[model] ${info.id} context window is ${info.contextTokens} tokens${max}`);
      }
      return info;
    });
    this.responseFormat = config.responseSchema
      ? {
          type: "json_schema",
          json_schema: { name: "generic_acp_output", strict: true, schema: config.responseSchema },
        }
      : undefined;
    this.responsesTextFormat = config.responseSchema
      ? { type: "json_schema", name: "generic_acp_output", strict: true, schema: config.responseSchema }
      : undefined;
  }

  modelInfo(): Promise<ModelInfo> {
    return this.modelInfoPromise;
  }

  async listModels(): Promise<string[]> {
    const ids = await listModelIds({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      headers: this.headers,
    });
    return ids.length > 0 ? ids : [this.model];
  }

  async *streamChat(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal: AbortSignal,
    call?: { model?: string; sampling?: SamplingOptions },
  ): AsyncGenerator<StreamDelta> {
    const info = await this.modelInfoPromise;
    const fitted = applyContextLimit(messages, tools, info.contextTokens);
    const model = call?.model || this.model;
    if (this.apiMode === "responses") {
      yield* this.streamResponsesWithFallback(fitted.messages, fitted.tools, signal, model, call?.sampling);
      return;
    }
    yield* streamChatCompletion(
      this.client,
      model,
      fitted.messages,
      fitted.tools,
      signal,
      this.responseFormat,
      call?.sampling,
    );
  }

  private async *streamResponsesWithFallback(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    signal: AbortSignal,
    model: string,
    sampling?: SamplingOptions,
  ): AsyncGenerator<StreamDelta> {
    const responseTools = tools.filter((tool) => tool.type === "function").map(chatToolToResponseTool);

    try {
      yield* streamResponses(
        this.client,
        model,
        chatMessagesToResponseInput(messages),
        responseTools,
        signal,
        this.responsesTextFormat,
        sampling,
      );
    } catch (error) {
      if (signal.aborted || !isUnsupportedEndpointError(error)) {
        throw error;
      }
      console.warn(
        "[api-mode=responses] provider does not support the Responses API; falling back to chat completions.",
      );
      yield* streamChatCompletion(this.client, model, messages, tools, signal, this.responseFormat, sampling);
    }
  }
}

function isUnsupportedEndpointError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) {
    return false;
  }
  if (error.status === 404) {
    return true;
  }
  if (error.status === 400) {
    const message = error instanceof Error ? error.message : String(error);
    return /not.?support|unsupported/i.test(message);
  }
  return false;
}