import { describe, expect, it } from "vitest";
import { readCommands, readModes, readRequestSettings } from "../../src/config/settings.js";

describe("readRequestSettings", () => {
  it("reads sampling fields from the environment", () => {
    const settings = readRequestSettings(undefined, {
      GENERIC_ACP_INSTRUCTIONS: "be brief",
      GENERIC_ACP_TEMPERATURE: "0.2",
      GENERIC_ACP_TOP_P: "0.9",
      GENERIC_ACP_MAX_TOKENS: "32",
      GENERIC_ACP_SEED: "7",
      GENERIC_ACP_PRESENCE_PENALTY: "0.1",
      GENERIC_ACP_FREQUENCY_PENALTY: "0.2",
      GENERIC_ACP_STOP: "END, STOP",
      GENERIC_ACP_TOOL_CHOICE: "none",
      GENERIC_ACP_PARALLEL_TOOL_CALLS: "true",
      GENERIC_ACP_REASONING_EFFORT: "low",
      GENERIC_ACP_IMAGE_DETAIL: "high",
    });
    expect(settings).toEqual({
      instructions: "be brief",
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 32,
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stop: ["END", "STOP"],
      toolChoice: "none",
      parallelToolCalls: true,
      reasoningEffort: "low",
      imageDetail: "high",
    });
  });

  it("rejects a sampling value that is not a number or an allowed choice", () => {
    expect(() => readRequestSettings(undefined, { GENERIC_ACP_TEMPERATURE: "hot" })).toThrow(/temperature/);
    expect(() => readRequestSettings(undefined, { GENERIC_ACP_MAX_TOKENS: "1.5" })).toThrow(/maxTokens/);
    expect(() => readRequestSettings(undefined, { GENERIC_ACP_TOOL_CHOICE: "maybe" })).toThrow(/GENERIC_ACP_TOOL_CHOICE/);
    expect(() => readRequestSettings({ toolChoice: "sideways" }, {})).toThrow(/toolChoice/);
  });
});

describe("readModes", () => {
  it("reads presets from JSON and rejects a bad entry", () => {
    expect(readModes(undefined, undefined)).toEqual([]);
    const modes = readModes(undefined, JSON.stringify([{ id: "brief", name: "Brief", model: "small", temperature: 0, toolChoice: "none", description: "short", instructions: "be brief" }]));
    expect(modes[0]).toMatchObject({ id: "brief", toolChoice: "none", temperature: 0 });
    expect(() => readModes({ id: "x" }, undefined)).toThrow(/array/);
    expect(() => readModes([{ id: 1, name: "n" }], undefined)).toThrow(/id and name/);
    expect(() => readModes([{ id: "a", name: "n", toolChoice: "nope" }], undefined)).toThrow(/toolChoice/);
  });
});

describe("readCommands", () => {
  it("reads commands and rejects a bad entry", () => {
    expect(readCommands(undefined, undefined)).toEqual([]);
    expect(readCommands(undefined, JSON.stringify([{ name: "explain", description: "Explain", hint: "what" }]))).toEqual([
      { name: "explain", description: "Explain", hint: "what" },
    ]);
    expect(() => readCommands("nope", undefined)).toThrow(/array/);
    expect(() => readCommands([{ name: "explain" }], undefined)).toThrow(/name and description/);
  });
});
