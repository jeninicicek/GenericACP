import type { ContentBlock, SessionConfigOption, SessionMode, SessionModeState } from "@agentclientprotocol/sdk";
import type { RequestSettings, SessionModeConfig, SlashCommandConfig } from "../config/settings.js";
import type { Session } from "./session.js";

export function modeState(session: Session, modes: SessionModeConfig[]): SessionModeState {
  const available = availableModes(modes);
  const current = available.some((mode) => mode.id === session.modeId) ? session.modeId : "default";
  return { currentModeId: current, availableModes: available };
}

export function applyMode(session: Session, base: RequestSettings, modes: SessionModeConfig[], modeId: string): void {
  const mode = availableModes(modes).find((entry) => entry.id === modeId);
  if (!mode) return;
  const defined = modes.find((entry) => entry.id === modeId);
  session.modeId = modeId;
  session.settings = { ...base };
  session.model = defined?.model;
  if (defined?.temperature !== undefined) session.settings.temperature = defined.temperature;
  if (defined?.instructions !== undefined) session.settings.instructions = defined.instructions;
  if (defined?.toolChoice !== undefined) session.settings.toolChoice = defined.toolChoice;
}

export function configOptions(
  session: Session,
  modelIds: string[],
  includeBoolean: boolean,
  imageSupport: boolean,
): SessionConfigOption[] {
  const model = session.model ?? modelIds[0] ?? "model";
  const models = modelIds.includes(model) ? modelIds : [model, ...modelIds];
  const options: SessionConfigOption[] = [
    select("model", "Model", "model", model, models.map((id) => ({ value: id, name: id }))),
    select("tool_choice", "Tool choice", "model_config", session.settings.toolChoice ?? "auto", [
      { value: "auto", name: "Auto" },
      { value: "none", name: "None" },
      { value: "required", name: "Required" },
    ]),
    select("reasoning_effort", "Reasoning effort", "thought_level", session.settings.reasoningEffort ?? "default", [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ]),
  ];
  if (imageSupport) {
    options.push(
      select("image_detail", "Image detail", "model_config", session.settings.imageDetail ?? "auto", [
        { value: "auto", name: "Auto" },
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ]),
    );
  }
  if (includeBoolean) {
    options.push({
      id: "parallel_tool_calls",
      name: "Parallel tool calls",
      category: "model_config",
      type: "boolean",
      currentValue: session.settings.parallelToolCalls ?? true,
    });
  }
  return options;
}

export function applyConfigValue(session: Session, configId: string, value: string | boolean): boolean {
  if (configId === "model" && typeof value === "string") {
    session.model = value;
    return true;
  }
  if (configId === "tool_choice" && (value === "none" || value === "auto" || value === "required")) {
    session.settings.toolChoice = value;
    return true;
  }
  if (configId === "reasoning_effort" && typeof value === "string") {
    if (value === "default") delete session.settings.reasoningEffort;
    else if (value === "low" || value === "medium" || value === "high") session.settings.reasoningEffort = value;
    else return false;
    return true;
  }
  if (configId === "image_detail" && (value === "auto" || value === "low" || value === "high")) {
    session.settings.imageDetail = value;
    return true;
  }
  if (configId === "parallel_tool_calls" && typeof value === "boolean") {
    session.settings.parallelToolCalls = value;
    return true;
  }
  return false;
}

export function applyCommandPrefix(blocks: ContentBlock[], commands: SlashCommandConfig[]): ContentBlock[] {
  if (commands.length === 0) return blocks;
  return blocks.map((block) => {
    if (block.type !== "text") return block;
    const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(block.text.trim());
    if (!match) return block;
    const command = commands.find((entry) => entry.name === match[1]);
    if (!command) return block;
    const rest = match[2]?.trim();
    return { ...block, text: rest ? `${command.description}\n${rest}` : command.description };
  });
}

export function commandUpdate(commands: SlashCommandConfig[]) {
  return {
    sessionUpdate: "available_commands_update" as const,
    availableCommands: commands.map((command) => ({
      name: command.name,
      description: command.description,
      input: { hint: command.hint ?? "arguments" },
    })),
  };
}

function availableModes(modes: SessionModeConfig[]): SessionMode[] {
  const extra = modes.filter((mode) => mode.id !== "default");
  return [
    { id: "default", name: "Default", description: "Use the configured model settings" },
    ...extra.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
    })),
  ];
}

function select(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: Array<{ value: string; name: string }>,
): SessionConfigOption {
  return { id, name, category, type: "select", currentValue, options };
}
