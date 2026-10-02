export type ToolChoice = "none" | "auto" | "required";
export type ReasoningEffort = "low" | "medium" | "high";
export type ImageDetail = "auto" | "low" | "high";

export interface RequestSettings {
  instructions?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  reasoningEffort?: ReasoningEffort;
  imageDetail?: ImageDetail;
}

export interface SessionModeConfig {
  id: string;
  name: string;
  description?: string;
  model?: string;
  temperature?: number;
  instructions?: string;
  toolChoice?: ToolChoice;
}

export interface SlashCommandConfig {
  name: string;
  description: string;
  hint?: string;
}

export function readRequestSettings(
  file: Partial<RequestSettings> | undefined,
  env: NodeJS.ProcessEnv,
): RequestSettings {
  const settings: RequestSettings = { ...(file ?? {}) };
  if (env.GENERIC_ACP_INSTRUCTIONS !== undefined) settings.instructions = env.GENERIC_ACP_INSTRUCTIONS;
  assignNumber(settings, "temperature", env.GENERIC_ACP_TEMPERATURE);
  assignNumber(settings, "topP", env.GENERIC_ACP_TOP_P);
  assignInt(settings, "maxTokens", env.GENERIC_ACP_MAX_TOKENS);
  assignInt(settings, "seed", env.GENERIC_ACP_SEED);
  assignNumber(settings, "presencePenalty", env.GENERIC_ACP_PRESENCE_PENALTY);
  assignNumber(settings, "frequencyPenalty", env.GENERIC_ACP_FREQUENCY_PENALTY);
  if (env.GENERIC_ACP_STOP !== undefined) settings.stop = env.GENERIC_ACP_STOP.split(",").map((part) => part.trim()).filter(Boolean);
  if (env.GENERIC_ACP_TOOL_CHOICE !== undefined) settings.toolChoice = oneOf(env.GENERIC_ACP_TOOL_CHOICE, ["none", "auto", "required"] as const, "GENERIC_ACP_TOOL_CHOICE");
  if (env.GENERIC_ACP_PARALLEL_TOOL_CALLS !== undefined) settings.parallelToolCalls = env.GENERIC_ACP_PARALLEL_TOOL_CALLS === "true";
  if (env.GENERIC_ACP_REASONING_EFFORT !== undefined) {
    settings.reasoningEffort = oneOf(env.GENERIC_ACP_REASONING_EFFORT, ["low", "medium", "high"] as const, "GENERIC_ACP_REASONING_EFFORT");
  }
  if (env.GENERIC_ACP_IMAGE_DETAIL !== undefined) {
    settings.imageDetail = oneOf(env.GENERIC_ACP_IMAGE_DETAIL, ["auto", "low", "high"] as const, "GENERIC_ACP_IMAGE_DETAIL");
  }
  if (file?.toolChoice) settings.toolChoice = oneOf(file.toolChoice, ["none", "auto", "required"] as const, "toolChoice");
  if (file?.reasoningEffort) settings.reasoningEffort = oneOf(file.reasoningEffort, ["low", "medium", "high"] as const, "reasoningEffort");
  if (file?.imageDetail) settings.imageDetail = oneOf(file.imageDetail, ["auto", "low", "high"] as const, "imageDetail");
  return settings;
}

export function readModes(file: unknown, envJson: string | undefined): SessionModeConfig[] {
  const raw = envJson !== undefined ? JSON.parse(envJson) : file;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("modes must be an array");
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") {
      throw new Error("each mode needs a string id and name");
    }
    return {
      id: entry.id,
      name: entry.name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.model === "string" ? { model: entry.model } : {}),
      ...(typeof entry.temperature === "number" ? { temperature: entry.temperature } : {}),
      ...(typeof entry.instructions === "string" ? { instructions: entry.instructions } : {}),
      ...(typeof entry.toolChoice === "string"
        ? { toolChoice: oneOf(entry.toolChoice, ["none", "auto", "required"] as const, "mode.toolChoice") }
        : {}),
    };
  });
}

export function readCommands(file: unknown, envJson: string | undefined): SlashCommandConfig[] {
  const raw = envJson !== undefined ? JSON.parse(envJson) : file;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("commands must be an array");
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.description !== "string") {
      throw new Error("each command needs a string name and description");
    }
    return {
      name: entry.name,
      description: entry.description,
      ...(typeof entry.hint === "string" ? { hint: entry.hint } : {}),
    };
  });
}

function assignNumber(settings: RequestSettings, key: "temperature" | "topP" | "presencePenalty" | "frequencyPenalty", raw: string | undefined): void {
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${key} "${raw}". Expected a number.`);
  settings[key] = value;
}

function assignInt(settings: RequestSettings, key: "maxTokens" | "seed", raw: string | undefined): void {
  if (raw === undefined) return;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`Invalid ${key} "${raw}". Expected an integer.`);
  settings[key] = value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${label} "${value}". Expected ${allowed.join(", ")}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
