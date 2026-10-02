export interface ModelInfo {
  id: string;
  contextTokens?: number;
  maxContextTokens?: number;
}

export async function listModelIds(options: {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}): Promise<string[]> {
  const headers = { Authorization: `Bearer ${options.apiKey}`, ...(options.headers ?? {}) };
  const ids = await readIds(`${trimSlash(options.baseUrl)}/models`, headers);
  return ids.length > 0 ? ids : readIds(`${new URL(options.baseUrl).origin}/api/v0/models`, headers);
}

async function readIds(url: string, headers: Record<string, string>): Promise<string[]> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return [];
    return body.data.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []));
  } catch {
    return [];
  }
}

export async function loadModelInfo(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  contextTokens?: number;
}): Promise<ModelInfo> {
  if (options.contextTokens && options.contextTokens > 0) {
    return { id: options.model, contextTokens: options.contextTokens, maxContextTokens: options.contextTokens };
  }

  const headers = {
    Authorization: `Bearer ${options.apiKey}`,
    ...(options.headers ?? {}),
  };
  const listed = await readModel(`${trimSlash(options.baseUrl)}/models`, options.model, headers);
  if (listed?.contextTokens) {
    return listed;
  }
  const native = await readModel(`${new URL(options.baseUrl).origin}/api/v0/models`, options.model, headers);
  return native?.contextTokens ? native : (listed ?? native ?? { id: options.model });
}

async function readModel(url: string, model: string, headers: Record<string, string>): Promise<ModelInfo | undefined> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { data?: unknown; id?: unknown };
    const record = findModel(body, model);
    return record ? limitsFromRecord(model, record) : undefined;
  } catch {
    return undefined;
  }
}

function findModel(body: { data?: unknown; id?: unknown }, model: string): Record<string, unknown> | undefined {
  if (Array.isArray(body.data)) {
    const match = body.data.find((entry) => isRecord(entry) && entry.id === model);
    return isRecord(match) ? match : undefined;
  }
  if (body.id === model && isRecord(body)) {
    return body;
  }
  return undefined;
}

function limitsFromRecord(id: string, record: Record<string, unknown>): ModelInfo {
  const loaded = positiveInt(record.loaded_context_length);
  const max =
    positiveInt(record.max_context_length) ??
    positiveInt(record.context_length) ??
    positiveInt(record.context_window) ??
    positiveInt(record.max_model_len);
  const contextTokens = loaded ?? max;
  return {
    id,
    ...(contextTokens ? { contextTokens } : {}),
    ...(max ? { maxContextTokens: max } : {}),
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}
