import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  DeleteSessionRequest,
  DeleteSessionResponse,
  DidChangeDocumentNotification,
  DidCloseDocumentNotification,
  DidFocusDocumentNotification,
  DidOpenDocumentNotification,
  DidSaveDocumentNotification,
  DisableProviderRequest,
  DisableProviderResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetProviderRequest,
  SetProviderResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ToolCallLocation,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentConfig } from "../config/config.js";
import { configEndpoints, endpointAgentConfig, modelOptionId, resolveModelOption, type EndpointConfig } from "../config/endpoints.js";
import { classifyProviderError, logError } from "../errors.js";
import { AcpMcpTransport } from "../mcp/acp-transport.js";
import { launchesFromMcpServers, mcpFingerprint, McpBridge } from "../mcp/bridge.js";
import { OpenAiProvider } from "../openai/provider.js";
import type { StreamDelta, TurnUsage } from "../openai/streaming.js";
import { getTools } from "../openai/tools.js";
import {
  applyCommandPrefix,
  applyConfigValue,
  applyMode,
  commandUpdate,
  configOptions,
  modeState,
} from "./controls.js";
import { contentBlocksToMessageContent, contentBlocksToText, messageContentToContentBlocks } from "./content.js";
import { SessionStore, type PendingToolCall, type Session } from "./session.js";
import type { RequestSettings, SessionModeConfig, SlashCommandConfig } from "../config/settings.js";
import type { SamplingOptions } from "../openai/sampling.js";

const MAX_TOOL_ITERATIONS = 10;

type ChatClient = Pick<OpenAiProvider, "streamChat"> & Partial<Pick<OpenAiProvider, "listModels" | "modelInfo">>;

const AGENT_NAME = "Generic ACP Agent";

const AGENT_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const TOOL_KIND_MAP: Record<string, ToolKind> = {
  read_file: "read",
  write_file: "edit",
  run_terminal: "execute",
};

export class GenericAcpAgent implements Agent {
  private readonly endpoints: EndpointConfig[];
  private readonly multipleEndpoints: boolean;
  private readonly clients: Map<string, ChatClient>;
  private readonly sessions: SessionStore;
  private readonly imageSupport: boolean;
  private readonly audioSupport: boolean;
  private readonly includeOpenDocuments: boolean;
  private readonly baseSettings: RequestSettings;
  private readonly modes: SessionModeConfig[];
  private readonly commands: SlashCommandConfig[];
  private readonly defaultModel: string;
  private readonly acpTransports = new Map<string, AcpMcpTransport>();
  private clientSupportsBooleanConfig = false;
  private readonly contextByEndpoint = new Map<string, number | undefined>();

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly config: AgentConfig,
    provider?: ChatClient,
    clients?: Record<string, ChatClient>,
  ) {
    this.endpoints = configEndpoints(config);
    this.multipleEndpoints = this.endpoints.length > 1;
    this.clients = new Map(
      this.endpoints.map((endpoint) => [
        endpoint.id,
        clients?.[endpoint.id] ?? provider ?? new OpenAiProvider(endpointAgentConfig(config, endpoint)),
      ]),
    );
    this.sessions = new SessionStore(config.sessionDir);
    this.imageSupport = config.imageSupport ?? true;
    this.audioSupport = config.audioSupport ?? false;
    this.includeOpenDocuments = config.includeOpenDocuments ?? false;
    this.baseSettings = { ...(config.request ?? {}) };
    this.modes = config.modes ?? [];
    this.commands = config.commands ?? [];
    const first = this.endpoints[0];
    this.defaultModel = first ? modelOptionId(first.id, first.model, this.multipleEndpoints) : config.model;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientSupportsBooleanConfig = params.clientCapabilities?.session?.configOptions?.boolean != null;
    return {
      protocolVersion: 1,
      agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
      agentCapabilities: {
        loadSession: true,
        providers: {},
        mcpCapabilities: { http: true, sse: true, acp: true },
        sessionCapabilities: { close: {}, list: {}, delete: {}, resume: {}, fork: {} },
        promptCapabilities: {
          image: this.imageSupport,
          audio: this.audioSupport,
          embeddedContext: true,
        },
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const session = this.sessions.create(params.cwd);
    this.prepareSession(session);
    await this.connectMcpServers(session, params.mcpServers);
    await this.publishCommands(session.id);
    this.sessions.save(session);
    return { sessionId: session.id, ...(await this.sessionControls(session)) };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const session = this.sessions.get(params.sessionId);

    if (session.cwd !== params.cwd) {
      throw RequestError.invalidParams(
        `cwd ${params.cwd} does not match the session's cwd ${session.cwd}`,
      );
    }

    await this.connectMcpServers(session, params.mcpServers);

    let messageIndex = 0;
    for (const message of session.messages) {
      const messageId = `load-${messageIndex}`;

      if (message.role === "user") {
        for (const block of messageContentToContentBlocks(message.content)) {
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: "user_message_chunk", content: block, messageId },
          });
        }
      } else if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) {
          if (call.type !== "function") {
            continue;
          }
          const result = session.messages.find(
            (m) => m.role === "tool" && m.tool_call_id === call.id,
          );
          const parsed = parseToolArguments(call.function.arguments);
          const rawInput = parsed.ok ? parsed.args : undefined;
          const stored = session.toolOutcomes.get(call.id);
          const locations = stored?.locations ?? (parsed.ok ? toolLocations(session.cwd, call.function.name, parsed.args) : undefined);
          const rawOutput = typeof result?.content === "string" ? result.content : undefined;
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: call.id,
              title: `${call.function.name}: ${formatToolTitle(call.function.name, rawInput ?? {})}`,
              name: call.function.name,
              kind: TOOL_KIND_MAP[call.function.name] ?? "other",
              status: stored?.status ?? (parsed.ok && !isFailedToolContent(rawOutput) ? "completed" : "failed"),
              ...(rawInput ? { rawInput } : {}),
              ...(rawOutput !== undefined ? { rawOutput } : {}),
              ...(locations ? { locations } : {}),
            },
          });
        }
        for (const block of messageContentToContentBlocks(message.content)) {
          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: "agent_message_chunk", content: block, messageId },
          });
        }
      }

      messageIndex += 1;
    }

    await this.publishCommands(session.id);
    return this.sessionControls(session);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const page = this.sessions.list(params.cwd, params.cursor);
    return {
      sessions: page.sessions.map((snapshot) => ({
        sessionId: snapshot.sessionId,
        cwd: snapshot.cwd,
        ...(snapshot.title ? { title: snapshot.title } : {}),
        updatedAt: snapshot.updatedAt,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    session.abortController?.abort();
    await session.closeResources();
    this.sessions.removeStored(session.id);
    return {};
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session.cwd !== params.cwd) {
      throw RequestError.invalidParams(`cwd ${params.cwd} does not match the session's cwd ${session.cwd}`);
    }
    await this.connectMcpServers(session, params.mcpServers ?? []);
    await this.publishCommands(session.id);
    return this.sessionControls(session);
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const source = this.sessions.get(params.sessionId);
    const session = this.sessions.create(params.cwd);
    session.messages.push(...structuredClone(source.messages));
    session.modeId = source.modeId;
    session.model = source.model;
    session.settings = { ...source.settings };
    session.systemInjected = source.systemInjected;
    session.title = source.title ? `${source.title} (fork)` : undefined;
    await this.connectMcpServers(session, params.mcpServers ?? []);
    await this.publishCommands(session.id);
    this.sessions.save(session);
    return { sessionId: session.id, ...(await this.sessionControls(session)) };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId);
    const known = modeState(session, this.modes).availableModes.some((mode) => mode.id === params.modeId);
    if (!known) throw RequestError.invalidParams(`Unknown mode ${params.modeId}`);
    applyMode(session, this.baseSettings, this.modes, params.modeId);
    this.sessions.save(session);
    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "current_mode_update", currentModeId: session.modeId },
    });
    return {};
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    const value = "type" in params && params.type === "boolean" ? params.value : params.value;
    if (!applyConfigValue(session, params.configId, value)) {
      throw RequestError.invalidParams(`Unknown config option ${params.configId}`);
    }
    this.sessions.save(session);
    const options = await this.optionsFor(session);
    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "config_option_update", configOptions: options },
    });
    return { configOptions: options };
  }

  async unstable_listProviders(_params: ListProvidersRequest): Promise<ListProvidersResponse> {
    return {
      providers: this.endpoints.map((endpoint) => ({
        providerId: this.multipleEndpoints ? endpoint.id : "openai",
        supported: ["openai"],
        required: true,
        current: { apiType: "openai", baseUrl: endpoint.baseUrl },
      })),
    };
  }

  async unstable_setProvider(params: SetProviderRequest): Promise<SetProviderResponse> {
    const known =
      (!this.multipleEndpoints && params.providerId === "openai") ||
      this.endpoints.some((endpoint) => endpoint.id === params.providerId);
    if (!known) throw RequestError.invalidParams(`Unknown provider ${params.providerId}`);
    return {};
  }

  async unstable_disableProvider(params: DisableProviderRequest): Promise<DisableProviderResponse> {
    throw RequestError.invalidParams(`Provider ${params.providerId} is required`);
  }

  async unstable_didOpenDocument(params: DidOpenDocumentNotification): Promise<void> {
    if (!this.includeOpenDocuments) return;
    this.sessions.get(params.sessionId).documents.open(params.uri, params.languageId, params.version, params.text);
  }

  async unstable_didChangeDocument(params: DidChangeDocumentNotification): Promise<void> {
    if (!this.includeOpenDocuments) return;
    this.sessions.get(params.sessionId).documents.change(params.uri, params.version, params.contentChanges);
  }

  async unstable_didCloseDocument(params: DidCloseDocumentNotification): Promise<void> {
    if (!this.includeOpenDocuments) return;
    this.sessions.get(params.sessionId).documents.close(params.uri);
  }

  async unstable_didSaveDocument(params: DidSaveDocumentNotification): Promise<void> {
    if (!this.includeOpenDocuments) return;
    this.sessions.get(params.sessionId);
  }

  async unstable_didFocusDocument(params: DidFocusDocumentNotification): Promise<void> {
    if (!this.includeOpenDocuments) return;
    this.sessions.get(params.sessionId).documents.focus(params.uri, params.version);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session.abortController) {
      throw RequestError.invalidParams(undefined, "A prompt is already running for this session");
    }
    const abortController = new AbortController();
    session.abortController = abortController;

    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0, cachedReadTokens: 0 };
    let sawUsage = false;
    const pending = { text: "", messageId: "" };
    const finishCancelled = () => {
      commitPending(session, pending);
      return cancelledResult(session, sawUsage, usage);
    };

    try {
      syncInstructions(session, session.settings.instructions);
      const prompted = applyCommandPrefix(params.prompt, this.commands);
      const blocks = this.includeOpenDocuments ? [...prompted, ...session.documents.contextBlocks()] : prompted;
      if (!session.title) {
        const text = contentBlocksToText(blocks).trim();
        if (text) session.title = text.slice(0, 80);
      }
      session.messages.push({
        role: "user",
        content:
          this.imageSupport || this.audioSupport
            ? contentBlocksToMessageContent(blocks, {
                images: this.imageSupport,
                audio: this.audioSupport,
                imageDetail: session.settings.imageDetail,
              })
            : contentBlocksToText(blocks),
      });

      const tools = getTools(session.mcpBridge ?? undefined);
      const sampling = samplingFrom(session.settings);

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (abortController.signal.aborted) {
          return finishCancelled();
        }

        pending.text = "";
        pending.messageId = session.nextAssistantMessageId();
        const toolCalls = new Map<number, PendingToolCall>();

        const selection = resolveModelOption(session.model, this.endpoints);
        const client = this.clientFor(selection.endpointId);
        for await (const delta of client.streamChat(session.messages, tools, abortController.signal, {
          model: selection.model,
          sampling,
        })) {
          if (abortController.signal.aborted) {
            return finishCancelled();
          }

          switch (delta.type) {
            case "text":
              pending.text += delta.text;
              await this.conn.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: delta.text },
                  messageId: pending.messageId,
                },
              });
              break;

            case "reasoning":
              await this.conn.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: delta.text },
                  messageId: pending.messageId,
                },
              });
              break;

            case "tool_call": {
              const existing = toolCalls.get(delta.index) ?? { id: "", name: "", arguments: "" };
              if (delta.id) existing.id = delta.id;
              if (delta.name) existing.name = delta.name;
              if (delta.arguments) existing.arguments += delta.arguments;
              toolCalls.set(delta.index, existing);
              break;
            }

            case "done":
              if (delta.usage) {
                sawUsage = true;
                usage.inputTokens += delta.usage.inputTokens;
                usage.outputTokens += delta.usage.outputTokens;
                usage.totalTokens += delta.usage.totalTokens;
                usage.thoughtTokens += delta.usage.thoughtTokens ?? 0;
                usage.cachedReadTokens += delta.usage.cachedReadTokens ?? 0;
                await this.publishUsage(session, delta.usage.inputTokens);
              }
              if (delta.finishReason !== "tool_calls") {
                commitPending(session, pending);
                return withUsage(stopReasonForFinish(delta.finishReason), sawUsage, usage);
              }
              break;
          }
        }

        if (abortController.signal.aborted) {
          return finishCancelled();
        }

        if (toolCalls.size === 0) {
          commitPending(session, pending);
          return withUsage("end_turn", sawUsage, usage);
        }

        const assistantToolCalls = Array.from(toolCalls.values()).map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));

        const assistantText = pending.text;
        pending.text = "";
        session.messages.push({
          role: "assistant",
          content: assistantText || null,
          tool_calls: assistantToolCalls,
        });

        for (const [, tc] of toolCalls) {
          if (abortController.signal.aborted) {
            return finishCancelled();
          }

          const toolCallId = tc.id;
          const kind = TOOL_KIND_MAP[tc.name] ?? "other";
          const parsed = parseToolArguments(tc.arguments);
          if (!parsed.ok) {
            session.recordToolOutcome(toolCallId, { status: "failed" });
            await this.conn.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: `${tc.name}: ${tc.name}`,
                name: tc.name,
                kind,
                status: "failed",
                rawOutput: parsed.error,
              },
            });
            session.messages.push({ role: "tool", tool_call_id: toolCallId, content: parsed.error });
            continue;
          }
          const args = parsed.args;
          const locations = toolLocations(session.cwd, tc.name, args);

          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: `${tc.name}: ${formatToolTitle(tc.name, args)}`,
              name: tc.name,
              kind,
              status: "pending",
              rawInput: args,
              ...(locations ? { locations } : {}),
            },
          });

          let permResponse;
          try {
            permResponse = await raceSignal(
              this.conn.requestPermission({
                sessionId: session.id,
                toolCall: {
                  toolCallId,
                  status: "pending",
                  kind,
                  name: tc.name,
                  title: `${tc.name}: ${formatToolTitle(tc.name, args)}`,
                  rawInput: args,
                },
                options: [
                  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
                  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
                ],
              }),
              abortController.signal,
            );
          } catch (error) {
            if (abortController.signal.aborted) {
              return cancelledResult(session, sawUsage, usage);
            }
            throw error;
          }

          if (permResponse.outcome.outcome === "cancelled" || permResponse.outcome.outcome === "selected" && permResponse.outcome.optionId === "reject_once") {
            session.recordToolOutcome(toolCallId, { status: "failed", ...(locations ? { locations } : {}) });
            session.messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              content: "Tool call rejected by user.",
            });
            await this.conn.sessionUpdate({
              sessionId: session.id,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId,
                status: "failed",
                rawInput: args,
                rawOutput: "Tool call rejected by user.",
              },
            });
            continue;
          }

          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: "in_progress",
              rawInput: args,
              ...(locations ? { locations } : {}),
            },
          });

          let result: string;
          let failed = false;
          try {
            result = await this.executeTool(session.id, tc.name, args, abortController.signal);
          } catch (error) {
            if (abortController.signal.aborted) {
              return cancelledResult(session, sawUsage, usage);
            }
            failed = true;
            result = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }

          await this.conn.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: failed ? "failed" : "completed",
              content: [{ type: "content", content: { type: "text", text: result } }],
              rawInput: args,
              rawOutput: result,
              ...(locations ? { locations } : {}),
            },
          });

          session.recordToolOutcome(toolCallId, {
            status: failed ? "failed" : "completed",
            ...(locations ? { locations } : {}),
          });
          session.messages.push({ role: "tool", tool_call_id: toolCallId, content: result });
        }
      }

      return withUsage("max_turn_requests", sawUsage, usage);
    } catch (error) {
      if (abortController.signal.aborted) {
        return finishCancelled();
      }

      const agentError = classifyProviderError(error);
      logError(agentError, { sessionId: session.id });
      const errorText = `\n\n[Error: ${agentError.message}]`;
      const messageId = pending.messageId || session.nextAssistantMessageId();
      if (pending.text) {
        session.messages.push({ role: "assistant", content: `${pending.text}${errorText}` });
        pending.text = "";
      } else if (!hasOpenToolCalls(session.messages)) {
        session.messages.push({ role: "assistant", content: errorText.trim() });
      }
      closeOpenToolCalls(session, errorText.trim());

      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: errorText },
          messageId,
        },
      });

      return { stopReason: "end_turn" };
    } finally {
      session.abortController = null;
      this.sessions.save(session);
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session.abortController?.abort();
  }

  async closeSession(params: CloseSessionRequest): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    session.abortController?.abort();
    this.sessions.save(session);
    await session.closeResources();
    this.sessions.delete(session.id);
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== "mcp/message") {
      throw RequestError.methodNotFound(method);
    }
    const transport = this.acpTransport(params);
    return transport.handleClientMessage({
      method: typeof params.method === "string" ? params.method : undefined,
      params: params.params,
    });
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method !== "mcp/message") {
      return;
    }
    this.acpTransport(params).handleClientNotification({
      method: typeof params.method === "string" ? params.method : undefined,
      params: params.params,
    });
  }

  private prepareSession(session: Session): void {
    applyMode(session, this.baseSettings, this.modes, "default");
  }

  private async sessionControls(session: Session) {
    return { modes: modeState(session, this.modes), configOptions: await this.optionsFor(session) };
  }

  private async optionsFor(session: Session) {
    const ids = await this.modelIds();
    if (session.model && !ids.includes(session.model)) ids.unshift(session.model);
    if (!ids.includes(this.defaultModel)) ids.unshift(this.defaultModel);
    return configOptions(session, ids, this.clientSupportsBooleanConfig, this.imageSupport);
  }

  private async modelIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const endpoint of this.endpoints) {
      const listed = await this.modelsFor(endpoint);
      for (const model of listed) ids.push(modelOptionId(endpoint.id, model, this.multipleEndpoints));
    }
    return ids.length > 0 ? ids : [this.defaultModel];
  }

  private async modelsFor(endpoint: EndpointConfig): Promise<string[]> {
    const client = this.clients.get(endpoint.id);
    if (!client?.listModels) return [endpoint.model];
    try {
      const ids = await client.listModels();
      return ids.length > 0 ? ids : [endpoint.model];
    } catch {
      return [endpoint.model];
    }
  }

  private clientFor(endpointId: string): ChatClient {
    const client = this.clients.get(endpointId) ?? this.clients.get(this.endpoints[0]?.id ?? "");
    if (!client) throw new Error(`No client for endpoint ${endpointId}`);
    return client;
  }

  private async publishCommands(sessionId: string): Promise<void> {
    if (this.commands.length === 0) return;
    await this.conn.sessionUpdate({ sessionId, update: commandUpdate(this.commands) });
  }

  private async publishUsage(session: Session, used: number): Promise<void> {
    const size = await this.contextSize(session);
    if (!size || used <= 0) return;
    await this.conn.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "usage_update", used, size },
    });
  }

  private async contextSize(session: Session): Promise<number | undefined> {
    const selection = resolveModelOption(session.model, this.endpoints);
    if (this.contextByEndpoint.has(selection.endpointId)) return this.contextByEndpoint.get(selection.endpointId);
    const endpoint = this.endpoints.find((entry) => entry.id === selection.endpointId);
    const override = endpoint?.contextTokens ?? this.config.contextTokens;
    if (override) {
      this.contextByEndpoint.set(selection.endpointId, override);
      return override;
    }
    const client = this.clients.get(selection.endpointId);
    if (!client?.modelInfo) return undefined;
    try {
      const info = await client.modelInfo();
      this.contextByEndpoint.set(selection.endpointId, info.contextTokens);
      return info.contextTokens;
    } catch {
      return undefined;
    }
  }

  private acpTransport(params: Record<string, unknown>): AcpMcpTransport {
    const connectionId = typeof params.connectionId === "string" ? params.connectionId : "";
    const transport = this.acpTransports.get(connectionId);
    if (!transport) {
      throw RequestError.invalidParams(`Unknown MCP connection ${connectionId}`);
    }
    return transport;
  }

  private async connectMcpServers(session: Session, mcpServers: McpServer[]): Promise<void> {
    const fingerprint = mcpFingerprint(mcpServers);
    if (session.mcpBridge && session.mcpFingerprint === fingerprint && session.mcpBridge.connectedServers > 0) {
      return;
    }
    if (session.mcpBridge) {
      await session.closeResources();
    }
    session.mcpFingerprint = fingerprint;
    if (mcpServers.length === 0) {
      return;
    }

    const bridge = new McpBridge();
    await bridge.connectAll(launchesFromMcpServers(mcpServers), (serverId) =>
      new AcpMcpTransport(
        (method, requestParams) => this.conn.request(method, requestParams),
        (method, requestParams) => this.conn.notify(method, requestParams),
        serverId,
        (connectionId, transport) => {
          this.acpTransports.set(connectionId, transport);
        },
        (connectionId) => {
          this.acpTransports.delete(connectionId);
        },
      ),
    );
    session.mcpBridge = bridge.connectedServers > 0 ? bridge : null;
    if (!session.mcpBridge) {
      await bridge.close();
    }
  }

  private async executeTool(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);

    if (session.mcpBridge?.hasTool(name)) {
      return raceSignal(session.mcpBridge.callTool(name, args), signal);
    }

    switch (name) {
      case "read_file": {
        const resp = await raceSignal(this.conn.readTextFile({ sessionId, path: String(args.path) }), signal);
        return resp.content;
      }
      case "write_file": {
        await raceSignal(
          this.conn.writeTextFile({ sessionId, path: String(args.path), content: String(args.content) }),
          signal,
        );
        return "File written successfully.";
      }
      case "run_terminal": {
        const terminal = await raceSignal(
          this.conn.createTerminal({
            sessionId,
            command: String(args.command),
            cwd: args.cwd ? String(args.cwd) : undefined,
          }),
          signal,
        );
        try {
          const exit = await raceSignal(terminal.waitForExit(), signal);
          const output = await terminal.currentOutput();
          return output.output + `\n\nExit code: ${exit.exitCode ?? "unknown"}`;
        } catch (error) {
          if (signal.aborted) {
            await terminal.kill().catch(() => {});
          }
          throw error;
        } finally {
          await terminal.release().catch(() => {});
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

function parseToolArguments(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Tool arguments must be a JSON object" };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid tool arguments: ${detail}` };
  }
}

function isFailedToolContent(content: string | undefined): boolean {
  if (!content) {
    return false;
  }
  return content === "Cancelled." || content === "Tool call rejected by user." || content.startsWith("Error:") || content.startsWith("Invalid tool arguments:");
}

function hasOpenToolCalls(messages: ChatCompletionMessageParam[]): boolean {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      answered.add(message.tool_call_id);
    }
  }
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.tool_calls?.some((call) => call.type === "function" && call.id && !answered.has(call.id)),
  );
}

function commitPending(session: Session, pending: { text: string }): void {
  if (!pending.text) {
    return;
  }
  session.messages.push({ role: "assistant", content: pending.text });
  pending.text = "";
}

function toolLocations(cwd: string, name: string, args: Record<string, unknown>): ToolCallLocation[] | undefined {
  if ((name === "read_file" || name === "write_file") && typeof args.path === "string" && args.path.length > 0) {
    return [{ path: resolve(cwd, args.path) }];
  }
  return undefined;
}

function stopReasonForFinish(finishReason: string): PromptResponse["stopReason"] {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function syncInstructions(session: Session, instructions: string | undefined): void {
  const first = session.messages[0];
  if (!instructions) {
    if (session.systemInjected && first?.role === "system") session.messages.shift();
    session.systemInjected = false;
    return;
  }
  if (session.systemInjected && first?.role === "system") {
    session.messages[0] = { role: "system", content: instructions };
    return;
  }
  session.messages.unshift({ role: "system", content: instructions });
  session.systemInjected = true;
}

function samplingFrom(settings: RequestSettings): SamplingOptions {
  return {
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.topP !== undefined ? { topP: settings.topP } : {}),
    ...(settings.maxTokens !== undefined ? { maxTokens: settings.maxTokens } : {}),
    ...(settings.stop ? { stop: settings.stop } : {}),
    ...(settings.seed !== undefined ? { seed: settings.seed } : {}),
    ...(settings.presencePenalty !== undefined ? { presencePenalty: settings.presencePenalty } : {}),
    ...(settings.frequencyPenalty !== undefined ? { frequencyPenalty: settings.frequencyPenalty } : {}),
    ...(settings.toolChoice ? { toolChoice: settings.toolChoice } : {}),
    ...(settings.parallelToolCalls !== undefined ? { parallelToolCalls: settings.parallelToolCalls } : {}),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
  };
}

function withUsage(stopReason: PromptResponse["stopReason"], sawUsage: boolean, usage: TurnUsage): PromptResponse {
  return { stopReason, ...(sawUsage ? { usage: toAcpUsage(usage) } : {}) };
}

function cancelledResult(session: Session, sawUsage: boolean, usage: TurnUsage): PromptResponse {
  closeOpenToolCalls(session, "Cancelled.");
  return withUsage("cancelled", sawUsage, usage);
}

function closeOpenToolCalls(session: Session, content: string): void {
  const answered = new Set<string>();
  for (const message of session.messages) {
    if (message.role === "tool") {
      answered.add(message.tool_call_id);
    }
  }
  const pending: string[] = [];
  for (const message of session.messages) {
    if (message.role !== "assistant" || !message.tool_calls) {
      continue;
    }
    for (const call of message.tool_calls) {
      if (call.type === "function" && call.id && !answered.has(call.id)) {
        pending.push(call.id);
        answered.add(call.id);
      }
    }
  }
  for (const id of pending) {
    session.recordToolOutcome(id, { status: "failed" });
    session.messages.push({ role: "tool", tool_call_id: id, content });
  }
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function toAcpUsage(usage: TurnUsage): Usage {
  const result: Usage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
  if ((usage.thoughtTokens ?? 0) > 0) {
    result.thoughtTokens = usage.thoughtTokens;
  }
  if ((usage.cachedReadTokens ?? 0) > 0) {
    result.cachedReadTokens = usage.cachedReadTokens;
  }
  return result;
}

function formatToolTitle(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return `Read ${args.path ?? "file"}`;
    case "write_file":
      return `Write ${args.path ?? "file"}`;
    case "run_terminal":
      return `Run: ${args.command ?? "command"}`;
    default:
      return name;
  }
}
