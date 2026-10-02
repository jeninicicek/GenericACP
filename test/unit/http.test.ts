import { describe, expect, it } from "vitest";
import { Agent } from "undici";
import { openAiHttpOptions } from "../../src/openai/http.js";

describe("openAiHttpOptions", () => {
  it("applies the same timeout to the SDK and the undici dispatcher", () => {
    const options = openAiHttpOptions(1_800_000);

    expect(options.timeout).toBe(1_800_000);
    expect(options.fetch).toBeTypeOf("function");
    expect(options.fetchOptions?.dispatcher).toBeInstanceOf(Agent);
  });
});