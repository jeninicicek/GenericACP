import { describe, expect, it } from "vitest";
import { modelOptionId, resolveModelOption, type EndpointConfig } from "../../src/config/endpoints.js";

const endpoints: EndpointConfig[] = [
  { id: "lmstudio", baseUrl: "http://lm/v1", apiKey: "a", model: "bonsai" },
  { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "ling:free" },
];

describe("model options", () => {
  it("leaves model ids bare when only one endpoint is configured", () => {
    expect(modelOptionId("default", "gpt-4o", false)).toBe("gpt-4o");
    expect(resolveModelOption("small", [endpoints[0]])).toEqual({ endpointId: "lmstudio", model: "small" });
  });

  it("keeps a colon inside the model id when the endpoint prefix is stripped", () => {
    expect(modelOptionId("openrouter", "ling:free", true)).toBe("openrouter:ling:free");
    expect(resolveModelOption("openrouter:ling:free", endpoints)).toEqual({
      endpointId: "openrouter",
      model: "ling:free",
    });
  });

  it("uses the first endpoint when the selection is empty", () => {
    expect(resolveModelOption(undefined, endpoints)).toEqual({ endpointId: "lmstudio", model: "bonsai" });
  });
});
