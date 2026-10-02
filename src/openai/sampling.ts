export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  toolChoice?: "none" | "auto" | "required";
  parallelToolCalls?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface SamplingState extends SamplingOptions {
  useMaxCompletionTokens: boolean;
}

export function samplingState(options: SamplingOptions | undefined): SamplingState {
  return { ...(options ?? {}), useMaxCompletionTokens: true };
}

export function chatSamplingFields(state: SamplingState): Record<string, unknown> {
  return {
    ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
    ...(state.topP !== undefined ? { top_p: state.topP } : {}),
    ...(state.maxTokens !== undefined
      ? { [state.useMaxCompletionTokens ? "max_completion_tokens" : "max_tokens"]: state.maxTokens }
      : {}),
    ...(state.stop && state.stop.length > 0 ? { stop: state.stop } : {}),
    ...(state.seed !== undefined ? { seed: state.seed } : {}),
    ...(state.presencePenalty !== undefined ? { presence_penalty: state.presencePenalty } : {}),
    ...(state.frequencyPenalty !== undefined ? { frequency_penalty: state.frequencyPenalty } : {}),
    ...(state.toolChoice ? { tool_choice: state.toolChoice } : {}),
    ...(state.parallelToolCalls !== undefined ? { parallel_tool_calls: state.parallelToolCalls } : {}),
    ...(state.reasoningEffort ? { reasoning_effort: state.reasoningEffort } : {}),
  };
}

export function responsesSamplingFields(state: SamplingState): Record<string, unknown> {
  return {
    ...(state.temperature !== undefined ? { temperature: state.temperature } : {}),
    ...(state.topP !== undefined ? { top_p: state.topP } : {}),
    ...(state.maxTokens !== undefined ? { max_output_tokens: state.maxTokens } : {}),
    ...(state.parallelToolCalls !== undefined ? { parallel_tool_calls: state.parallelToolCalls } : {}),
    ...(state.reasoningEffort ? { reasoning: { effort: state.reasoningEffort } } : {}),
  };
}

export function dropRejectedSampling(state: SamplingState, error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const drops: Array<[RegExp, () => boolean]> = [
    [/max_completion_tokens/i, () => take(state.useMaxCompletionTokens && state.maxTokens !== undefined, () => { state.useMaxCompletionTokens = false; })],
    [/max_output_tokens|max_tokens/i, () => take(state.maxTokens !== undefined, () => { state.maxTokens = undefined; })],
    [/temperature/i, () => take(state.temperature !== undefined, () => { state.temperature = undefined; })],
    [/top_p/i, () => take(state.topP !== undefined, () => { state.topP = undefined; })],
    [/\bstop\b/i, () => take(Boolean(state.stop?.length), () => { state.stop = undefined; })],
    [/\bseed\b/i, () => take(state.seed !== undefined, () => { state.seed = undefined; })],
    [/presence_penalty/i, () => take(state.presencePenalty !== undefined, () => { state.presencePenalty = undefined; })],
    [/frequency_penalty/i, () => take(state.frequencyPenalty !== undefined, () => { state.frequencyPenalty = undefined; })],
    [/tool_choice/i, () => take(Boolean(state.toolChoice), () => { state.toolChoice = undefined; })],
    [/parallel_tool_calls/i, () => take(state.parallelToolCalls !== undefined, () => { state.parallelToolCalls = undefined; })],
    [/reasoning_effort|\breasoning\b/i, () => take(Boolean(state.reasoningEffort), () => { state.reasoningEffort = undefined; })],
  ];
  for (const [pattern, clear] of drops) {
    if (pattern.test(message) && clear()) return pattern.source;
  }
  return undefined;
}

function take(present: boolean, clear: () => void): boolean {
  if (!present) return false;
  clear();
  return true;
}
