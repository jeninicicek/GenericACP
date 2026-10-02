import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEndpointList, type EndpointConfig } from "./endpoints.js";
import { readCommands, readModes, readRequestSettings, type RequestSettings, type SessionModeConfig, type SlashCommandConfig } from "./settings.js";

export type ApiMode = "chat-completions" | "responses";

export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpoints?: EndpointConfig[];
  apiMode?: ApiMode;
  responseSchema?: Record<string, unknown>;
  imageSupport?: boolean;
  headers?: Record<string, string>;
  contextTokens?: number;
  requestTimeoutMs?: number;
  request?: RequestSettings;
  modes?: SessionModeConfig[];
  commands?: SlashCommandConfig[];
  audioSupport?: boolean;
  includeOpenDocuments?: boolean;
  sessionDir?: string;
}

function readConfigFile(path: string): Partial<AgentConfig> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadConfig(): AgentConfig {
  const configPath = process.env.GENERIC_ACP_CONFIG ?? resolve(process.cwd(), "config.json");
  const fromFile = existsSync(configPath) ? readConfigFile(configPath) : {};

  const apiMode = (process.env.GENERIC_ACP_API_MODE ?? fromFile.apiMode ?? "chat-completions") as ApiMode;
  if (apiMode !== "chat-completions" && apiMode !== "responses") {
    throw new Error(`Invalid apiMode "${apiMode}". Expected "chat-completions" or "responses".`);
  }

  const envSchema = process.env.GENERIC_ACP_RESPONSE_SCHEMA
    ? (JSON.parse(process.env.GENERIC_ACP_RESPONSE_SCHEMA) as Record<string, unknown>)
    : undefined;

  const envHeaders = process.env.GENERIC_ACP_HEADERS
    ? (JSON.parse(process.env.GENERIC_ACP_HEADERS) as Record<string, string>)
    : undefined;

  const imageSupport =
    process.env.GENERIC_ACP_SUPPORT_IMAGES !== undefined
      ? process.env.GENERIC_ACP_SUPPORT_IMAGES === "true"
      : (fromFile.imageSupport ?? true);

  const contextTokens = readContextTokens(process.env.GENERIC_ACP_CONTEXT_TOKENS, fromFile.contextTokens);
  const requestTimeoutMs = readRequestTimeout(process.env.GENERIC_ACP_REQUEST_TIMEOUT_MS, fromFile.requestTimeoutMs);
  const audioSupport =
    process.env.GENERIC_ACP_AUDIO !== undefined ? process.env.GENERIC_ACP_AUDIO === "true" : (fromFile.audioSupport ?? false);
  const includeOpenDocuments =
    process.env.GENERIC_ACP_INCLUDE_OPEN_DOCUMENTS !== undefined
      ? process.env.GENERIC_ACP_INCLUDE_OPEN_DOCUMENTS === "true"
      : (fromFile.includeOpenDocuments ?? false);
  const sessionDir = process.env.GENERIC_ACP_SESSION_DIR ?? fromFile.sessionDir;
  const request = readRequestSettings(fromFile.request, process.env);
  const modes = readModes(fromFile.modes, process.env.GENERIC_ACP_MODES);
  const commands = readCommands(fromFile.commands, process.env.GENERIC_ACP_COMMANDS);

  const single = {
    baseUrl: process.env.GENERIC_ACP_BASE_URL ?? fromFile.baseUrl,
    apiKey: process.env.GENERIC_ACP_API_KEY ?? fromFile.apiKey,
    model: process.env.GENERIC_ACP_MODEL ?? fromFile.model,
  };
  const endpoints = readEndpoints(process.env.GENERIC_ACP_ENDPOINTS, fromFile.endpoints, single);
  const primary = endpoints[0];
  if (!primary) {
    const missing = (["baseUrl", "apiKey", "model"] as const).filter((key) => !single[key]);
    throw new Error(
      `Missing configuration: ${missing.join(", ")}. Provide them via ${configPath}, ` +
        "GENERIC_ACP_BASE_URL / GENERIC_ACP_API_KEY / GENERIC_ACP_MODEL, or GENERIC_ACP_ENDPOINTS.",
    );
  }

  const config: Partial<AgentConfig> = {
    baseUrl: primary.baseUrl,
    apiKey: primary.apiKey,
    model: primary.model,
    endpoints,
    apiMode,
    imageSupport,
    ...(contextTokens ? { contextTokens } : {}),
    requestTimeoutMs,
    ...(Object.keys(request).length > 0 ? { request } : {}),
    ...(modes.length > 0 ? { modes } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    audioSupport,
    includeOpenDocuments,
    ...(sessionDir ? { sessionDir } : {}),
    ...(envSchema ?? fromFile.responseSchema ? { responseSchema: envSchema ?? fromFile.responseSchema } : {}),
    ...(envHeaders ?? fromFile.headers ? { headers: envHeaders ?? fromFile.headers } : {}),
  };

  return config as AgentConfig;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function readRequestTimeout(fromEnv: string | undefined, fromFile: number | undefined): number {
  if (fromEnv === undefined) {
    return positiveInt(fromFile) ? fromFile : DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(fromEnv);
  if (!positiveInt(parsed)) {
    throw new Error(`Invalid GENERIC_ACP_REQUEST_TIMEOUT_MS "${fromEnv}". Expected a positive integer.`);
  }
  return parsed;
}

function readEndpoints(
  fromEnv: string | undefined,
  fromFile: unknown,
  single: { baseUrl?: string; apiKey?: string; model?: string },
): EndpointConfig[] {
  if (fromEnv !== undefined) return parseEndpointList(JSON.parse(fromEnv), "GENERIC_ACP_ENDPOINTS");
  if (fromFile !== undefined) return parseEndpointList(fromFile, "endpoints");
  if (!single.baseUrl || !single.apiKey || !single.model) return [];
  return [{ id: "default", baseUrl: single.baseUrl, apiKey: single.apiKey, model: single.model }];
}

function readContextTokens(fromEnv: string | undefined, fromFile: number | undefined): number | undefined {
  if (fromEnv === undefined) {
    return positiveInt(fromFile) ? fromFile : undefined;
  }
  const parsed = Number(fromEnv);
  if (!positiveInt(parsed)) {
    throw new Error(`Invalid GENERIC_ACP_CONTEXT_TOKENS "${fromEnv}". Expected a positive integer.`);
  }
  return parsed;
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
