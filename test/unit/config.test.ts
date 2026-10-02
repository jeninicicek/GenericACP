import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REQUEST_TIMEOUT_MS, loadConfig } from "../../src/config/config.js";

const ENV_KEYS = [
  "GENERIC_ACP_CONFIG",
  "GENERIC_ACP_BASE_URL",
  "GENERIC_ACP_API_KEY",
  "GENERIC_ACP_MODEL",
  "GENERIC_ACP_API_MODE",
  "GENERIC_ACP_RESPONSE_SCHEMA",
  "GENERIC_ACP_HEADERS",
  "GENERIC_ACP_SUPPORT_IMAGES",
  "GENERIC_ACP_CONTEXT_TOKENS",
  "GENERIC_ACP_AUDIO",
  "GENERIC_ACP_INCLUDE_OPEN_DOCUMENTS",
  "GENERIC_ACP_SESSION_DIR",
  "GENERIC_ACP_MODES",
  "GENERIC_ACP_COMMANDS",
  "GENERIC_ACP_INSTRUCTIONS",
  "GENERIC_ACP_TEMPERATURE",
  "GENERIC_ACP_TOP_P",
  "GENERIC_ACP_MAX_TOKENS",
  "GENERIC_ACP_SEED",
  "GENERIC_ACP_PRESENCE_PENALTY",
  "GENERIC_ACP_FREQUENCY_PENALTY",
  "GENERIC_ACP_STOP",
  "GENERIC_ACP_TOOL_CHOICE",
  "GENERIC_ACP_PARALLEL_TOOL_CALLS",
  "GENERIC_ACP_REASONING_EFFORT",
  "GENERIC_ACP_IMAGE_DETAIL",
  "GENERIC_ACP_REQUEST_TIMEOUT_MS",
  "GENERIC_ACP_ENDPOINTS",
];

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

function withEnv(overrides: Record<string, string>): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

function writeConfigFile(partial: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(partial));
  return path;
}

describe("loadConfig", () => {
  it("loads config from file", () => {
    const path = writeConfigFile({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "file-key",
      model: "file-model",
    });
    withEnv({ GENERIC_ACP_CONFIG: path });

    const config = loadConfig();
    expect(config.baseUrl).toBe("http://localhost:1234/v1");
    expect(config.apiKey).toBe("file-key");
    expect(config.model).toBe("file-model");
    expect(config.apiMode).toBe("chat-completions");
    expect(config.imageSupport).toBe(true);
  });

  it("env vars override file config", () => {
    const path = writeConfigFile({
      baseUrl: "http://file/v1",
      apiKey: "file-key",
      model: "file-model",
    });
    withEnv({
      GENERIC_ACP_CONFIG: path,
      GENERIC_ACP_BASE_URL: "http://env/v1",
      GENERIC_ACP_API_KEY: "env-key",
      GENERIC_ACP_MODEL: "env-model",
    });

    const config = loadConfig();
    expect(config.baseUrl).toBe("http://env/v1");
    expect(config.apiKey).toBe("env-key");
    expect(config.model).toBe("env-model");
  });

  it("throws on missing fields", () => {
    withEnv({ GENERIC_ACP_BASE_URL: "http://localhost/v1" });
    expect(() => loadConfig()).toThrow(/Missing configuration: apiKey, model/);
  });

  it("uses GENERIC_ACP_CONFIG env for custom path", () => {
    const path = writeConfigFile({
      baseUrl: "http://custom/v1",
      apiKey: "custom-key",
      model: "custom-model",
    });
    withEnv({ GENERIC_ACP_CONFIG: path });

    const config = loadConfig();
    expect(config.baseUrl).toBe("http://custom/v1");
  });

  it("supports apiMode and responseSchema from env", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
      GENERIC_ACP_API_MODE: "responses",
      GENERIC_ACP_RESPONSE_SCHEMA: '{"type":"object"}',
    });

    const config = loadConfig();
    expect(config.apiMode).toBe("responses");
    expect(config.responseSchema).toEqual({ type: "object" });
  });

  it("rejects an invalid apiMode", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
      GENERIC_ACP_API_MODE: "bogus",
    });

    expect(() => loadConfig()).toThrow(/Invalid apiMode "bogus"/);
  });

  it("parses headers from GENERIC_ACP_HEADERS", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
      GENERIC_ACP_HEADERS: '{"x-test":"1"}',
    });

    expect(loadConfig().headers).toEqual({ "x-test": "1" });
  });

  it("honors imageSupport=false", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
      GENERIC_ACP_SUPPORT_IMAGES: "false",
    });

    expect(loadConfig().imageSupport).toBe(false);
  });

  it("defaults the request timeout to 30 minutes", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
    });

    expect(loadConfig().requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("reads GENERIC_ACP_REQUEST_TIMEOUT_MS", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
      GENERIC_ACP_REQUEST_TIMEOUT_MS: "600000",
    });

    expect(loadConfig().requestTimeoutMs).toBe(600_000);
  });

  it("rejects an invalid request timeout", () => {
    withEnv({
      GENERIC_ACP_BASE_URL: "http://localhost/v1",
      GENERIC_ACP_API_KEY: "k",
      GENERIC_ACP_MODEL: "m",
      GENERIC_ACP_REQUEST_TIMEOUT_MS: "later",
    });

    expect(() => loadConfig()).toThrow(/GENERIC_ACP_REQUEST_TIMEOUT_MS/);
  });

  it("reads several endpoints and uses the first as the default model", () => {
    withEnv({
      GENERIC_ACP_ENDPOINTS: JSON.stringify([
        { id: "lmstudio", baseUrl: "http://lm/v1", apiKey: "a", model: "bonsai" },
        { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "ling:free" },
      ]),
    });

    const config = loadConfig();
    expect(config.endpoints?.map((endpoint) => endpoint.id)).toEqual(["lmstudio", "openrouter"]);
    expect(config.model).toBe("bonsai");
    expect(config.baseUrl).toBe("http://lm/v1");
  });

  it("rejects an endpoint id that would break model namespacing", () => {
    withEnv({
      GENERIC_ACP_ENDPOINTS: JSON.stringify([{ id: "lm:studio", baseUrl: "http://lm/v1", apiKey: "a", model: "m" }]),
    });

    expect(() => loadConfig()).toThrow(/letters, digits/);
  });
});