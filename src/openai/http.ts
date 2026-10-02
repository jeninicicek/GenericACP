import type { ClientOptions } from "openai";
import { Agent, fetch as undiciFetch } from "undici";

export function openAiHttpOptions(timeoutMs: number): Pick<ClientOptions, "timeout" | "fetch" | "fetchOptions"> {
  return {
    timeout: timeoutMs,
    fetch: undiciFetch as ClientOptions["fetch"],
    fetchOptions: {
      dispatcher: new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
    },
  };
}
