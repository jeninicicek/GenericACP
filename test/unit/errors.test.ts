import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { ContextLimitError } from "../../src/openai/context.js";
import { classifyProviderError, logError } from "../../src/errors.js";

describe("classifyProviderError", () => {
  it("classifies AuthenticationError as auth", () => {
    const error = new OpenAI.AuthenticationError(
      401,
      { message: "bad key" },
      "Unauthorized",
      new Headers(),
    );
    const result = classifyProviderError(error);
    expect(result.kind).toBe("auth");
    expect(result.providerMessage).toContain("401");
  });

  it("classifies RateLimitError as rate_limit with retry-after", () => {
    const headers = new Headers({ "retry-after": "30" });
    const error = new OpenAI.RateLimitError(429, { message: "slow down" }, "Too Many Requests", headers);
    const result = classifyProviderError(error);
    expect(result.kind).toBe("rate_limit");
    expect(result.retryAfter).toBe(30);
  });

  it("classifies RateLimitError without retry-after", () => {
    const error = new OpenAI.RateLimitError(
      429,
      { message: "slow down" },
      "Too Many Requests",
      new Headers(),
    );
    const result = classifyProviderError(error);
    expect(result.kind).toBe("rate_limit");
    expect(result.retryAfter).toBeUndefined();
  });

  it("classifies APIConnectionError as network", () => {
    const error = new OpenAI.APIConnectionError({ message: "conn refused" });
    const result = classifyProviderError(error);
    expect(result.kind).toBe("network");
  });

  it("classifies a terminated TypeError as network", () => {
    const error = new TypeError("terminated");
    const result = classifyProviderError(error);
    expect(result.kind).toBe("network");
  });

  it("classifies a fetch-failed TypeError as network", () => {
    const error = new TypeError("fetch failed");
    const result = classifyProviderError(error);
    expect(result.kind).toBe("network");
  });

  it("classifies a fetch inactivity timeout separately from a dropped socket", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "UND_ERR_BODY_TIMEOUT" },
    });
    const result = classifyProviderError(error);
    expect(result.kind).toBe("network");
    expect(result.message).toContain("request timeout");
  });

  it("classifies an UND_ERR_SOCKET cause as network", () => {
    const error = Object.assign(new Error("socket hang up"), {
      cause: { code: "UND_ERR_SOCKET" },
    });
    const result = classifyProviderError(error);
    expect(result.kind).toBe("network");
  });

  it("reports a context limit that blocked the request", () => {
    const result = classifyProviderError(new ContextLimitError(60000, 32768));
    expect(result.kind).toBe("model");
    expect(result.message).toContain("32768");
    expect(result.message).toContain("not sent");
  });

  it("classifies a generic APIError as model", () => {
    const error = new OpenAI.APIError(
      500,
      { message: "server error" },
      "Internal Server Error",
      new Headers(),
    );
    const result = classifyProviderError(error);
    expect(result.kind).toBe("model");
    expect(result.statusCode).toBe(500);
  });

  it("classifies a plain Error as unknown", () => {
    const result = classifyProviderError(new Error("???"));
    expect(result.kind).toBe("unknown");
    expect(result.originalError).toBeInstanceOf(Error);
  });
});

describe("logError", () => {
  it("logs auth error with session id", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError(
      { kind: "auth", message: "bad", providerMessage: "Unauthorized" },
      { sessionId: "abc" },
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});