import type { AgentConfig, ApiMode } from "./config.js";

export interface EndpointConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiMode?: ApiMode;
  headers?: Record<string, string>;
  contextTokens?: number;
  requestTimeoutMs?: number;
}

const ENDPOINT_ID = /^[A-Za-z0-9_-]+$/;

export function configEndpoints(config: AgentConfig): EndpointConfig[] {
  if (config.endpoints && config.endpoints.length > 0) return config.endpoints;
  return [
    {
      id: "default",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      ...(config.apiMode ? { apiMode: config.apiMode } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.contextTokens ? { contextTokens: config.contextTokens } : {}),
      ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    },
  ];
}

export function endpointAgentConfig(shared: AgentConfig, endpoint: EndpointConfig): AgentConfig {
  return {
    ...shared,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    apiMode: endpoint.apiMode ?? shared.apiMode,
    ...(endpoint.headers || shared.headers ? { headers: endpoint.headers ?? shared.headers } : {}),
    ...(endpoint.contextTokens || shared.contextTokens
      ? { contextTokens: endpoint.contextTokens ?? shared.contextTokens }
      : {}),
    requestTimeoutMs: endpoint.requestTimeoutMs ?? shared.requestTimeoutMs,
    endpoints: [endpoint],
  };
}

export function modelOptionId(endpointId: string, model: string, multiple: boolean): string {
  return multiple ? `${endpointId}:${model}` : model;
}

export function resolveModelOption(
  value: string | undefined,
  endpoints: EndpointConfig[],
): { endpointId: string; model: string } {
  const first = endpoints[0];
  if (!first) throw new Error("No endpoints are configured.");
  if (!value) return { endpointId: first.id, model: first.model };
  if (endpoints.length === 1) {
    const prefix = `${first.id}:`;
    return { endpointId: first.id, model: value.startsWith(prefix) ? value.slice(prefix.length) : value };
  }
  const colon = value.indexOf(":");
  if (colon > 0) {
    const endpointId = value.slice(0, colon);
    const model = value.slice(colon + 1);
    if (model.length > 0 && endpoints.some((endpoint) => endpoint.id === endpointId)) {
      return { endpointId, model };
    }
  }
  const owners = endpoints.filter((endpoint) => endpoint.model === value);
  if (owners.length === 1) return { endpointId: owners[0].id, model: value };
  return { endpointId: first.id, model: value };
}

export function parseEndpointList(value: unknown, label: string): EndpointConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}[${index}] must be an object.`);
    const id = requiredString(entry.id, `${label}[${index}].id`);
    if (!ENDPOINT_ID.test(id)) {
      throw new Error(`${label}[${index}].id "${id}" must contain only letters, digits, "_" and "-".`);
    }
    if (seen.has(id)) throw new Error(`${label} contains duplicate id "${id}".`);
    seen.add(id);
    const apiMode = entry.apiMode === undefined ? undefined : readApiMode(entry.apiMode, `${label}[${index}].apiMode`);
    return {
      id,
      baseUrl: requiredString(entry.baseUrl, `${label}[${index}].baseUrl`),
      apiKey: requiredString(entry.apiKey, `${label}[${index}].apiKey`),
      model: requiredString(entry.model, `${label}[${index}].model`),
      ...(apiMode ? { apiMode } : {}),
      ...(entry.headers === undefined ? {} : { headers: readHeaders(entry.headers, `${label}[${index}].headers`) }),
      ...(positiveInt(entry.contextTokens) ? { contextTokens: entry.contextTokens } : {}),
      ...(positiveInt(entry.requestTimeoutMs) ? { requestTimeoutMs: entry.requestTimeoutMs } : {}),
    };
  });
}

function readApiMode(value: unknown, label: string): ApiMode {
  if (value === "chat-completions" || value === "responses") return value;
  throw new Error(`Invalid ${label} "${String(value)}". Expected "chat-completions" or "responses".`);
}

function readHeaders(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header !== "string") throw new Error(`${label}.${key} must be a string.`);
    headers[key] = header;
  }
  return headers;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
