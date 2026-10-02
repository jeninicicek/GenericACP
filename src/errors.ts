import OpenAI from "openai";
import { ContextLimitError } from "./openai/context.js";

export type AgentError =
  | { kind: "auth"; message: string; providerMessage?: string }
  | { kind: "rate_limit"; message: string; retryAfter?: number }
  | { kind: "network"; message: string }
  | { kind: "model"; message: string; statusCode?: number; providerMessage?: string }
  | { kind: "unknown"; message: string; originalError?: unknown };

function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function isInactivityTimeout(error: unknown): boolean {
  const code = causeCode(error);
  return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}

function isDroppedConnection(error: unknown): boolean {
  if (
    error instanceof TypeError &&
    /terminated|fetch failed|other side closed|UND_ERR_SOCKET/i.test(error.message)
  ) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "UND_ERR_SOCKET"
  );
}

export function classifyProviderError(error: unknown): AgentError {
  if (isInactivityTimeout(error)) {
    return {
      kind: "network",
      message:
        "The provider sent no data for longer than the request timeout. A long prompt can sit silent while a local model processes it. Raise GENERIC_ACP_REQUEST_TIMEOUT_MS if the model is still working.",
    };
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return {
      kind: "auth",
      message: "Authentication failed. Please verify your API key in the configuration.",
      providerMessage: error.message,
    };
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfterHeader = error.headers?.get("retry-after");
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
    return {
      kind: "rate_limit",
      message:
        retryAfter !== undefined && Number.isFinite(retryAfter)
          ? `The provider is rate-limiting requests. Try again in about ${retryAfter} seconds.`
          : "The provider is rate-limiting requests. Please wait a moment and try again.",
      retryAfter,
    };
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return {
      kind: "network",
      message: "Could not connect to the provider. Please check your network connection and the baseUrl configuration.",
    };
  }
  if (isDroppedConnection(error)) {
    return {
      kind: "network",
      message: "The connection to the provider was lost mid-stream. Please check your network connection and try again.",
    };
  }
  if (error instanceof ContextLimitError) {
    return { kind: "model", message: error.message };
  }
  if (error instanceof OpenAI.APIError) {
    return {
      kind: "model",
      message: error.message
        ? `The provider returned an error (HTTP ${error.status ?? "unknown"}): ${error.message}`
        : `The provider returned an error (HTTP ${error.status ?? "unknown"}). This may be a temporary issue or a configuration problem.`,
      statusCode: error.status,
      providerMessage: error.message,
    };
  }
  return { kind: "unknown", message: "An unexpected error occurred. Please check the agent logs for details.", originalError: error };
}

export function logError(error: AgentError, context?: { sessionId?: string }): void {
  const prefix = context?.sessionId ? `[session:${context.sessionId}]` : "[agent]";
  console.error(`${prefix} [${error.kind}] ${error.message}`);
  if ("providerMessage" in error && error.providerMessage) {
    console.error(`${prefix} Provider message: ${error.providerMessage}`);
  }
  if (error.kind === "unknown" && error.originalError) {
    console.error(`${prefix} Original error:`, error.originalError);
  }
}