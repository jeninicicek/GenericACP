import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelInfo } from "../../src/openai/model-info.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadModelInfo", () => {
  it("reads loaded_context_length from the native model list when /v1/models omits it", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/models")) {
        return json({ data: [{ id: "qwen/qwen2.5-coder-14b", object: "model", owned_by: "organization_owner" }] });
      }
      if (url.endsWith("/api/v0/models")) {
        return json({
          data: [
            {
              id: "qwen/qwen2.5-coder-14b",
              max_context_length: 32768,
              loaded_context_length: 32768,
            },
          ],
        });
      }
      throw new Error(url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await loadModelInfo({
      baseUrl: "http://10.211.67.199:1234/v1",
      apiKey: "a",
      model: "qwen/qwen2.5-coder-14b",
    });

    expect(info.contextTokens).toBe(32768);
    expect(info.maxContextTokens).toBe(32768);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a context field on the OpenAI model object and skips the native list", async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ id: "m", context_length: 8192 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const info = await loadModelInfo({ baseUrl: "http://host/v1", apiKey: "a", model: "m" });

    expect(info.contextTokens).toBe(8192);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit contextTokens override and does not call the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const info = await loadModelInfo({
      baseUrl: "http://host/v1",
      apiKey: "a",
      model: "m",
      contextTokens: 4096,
    });

    expect(info.contextTokens).toBe(4096);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
