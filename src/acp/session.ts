import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RequestError, type ToolCallLocation } from "@agentclientprotocol/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { RequestSettings } from "../config/settings.js";
import { DocumentStore } from "./documents.js";
import type { McpBridge } from "../mcp/bridge.js";

export interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolOutcome {
  status: "completed" | "failed";
  locations?: ToolCallLocation[];
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionSnapshot {
  sessionId: string;
  cwd: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatCompletionMessageParam[];
  modeId: string;
  model?: string;
  settings: RequestSettings;
  systemInjected: boolean;
}

export class Session {
  readonly id: string;
  readonly messages: ChatCompletionMessageParam[] = [];
  readonly toolOutcomes = new Map<string, ToolOutcome>();
  readonly documents = new DocumentStore();
  abortController: AbortController | null = null;
  mcpBridge: McpBridge | null = null;
  mcpFingerprint: string | undefined;
  lastActivityAt = Date.now();
  createdAt = new Date().toISOString();
  modeId = "default";
  model: string | undefined;
  settings: RequestSettings = {};
  systemInjected = false;
  title: string | undefined;
  private assistantMessageCounter = 0;

  constructor(readonly cwd: string, id?: string) {
    this.id = id ?? randomUUID();
  }

  nextAssistantMessageId(): string {
    return `assistant-${this.assistantMessageCounter++}`;
  }

  recordToolOutcome(toolCallId: string, outcome: ToolOutcome): void {
    if (!toolCallId) {
      return;
    }
    this.toolOutcomes.set(toolCallId, outcome);
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      ...(this.title ? { title: this.title } : {}),
      createdAt: this.createdAt,
      updatedAt: new Date(this.lastActivityAt).toISOString(),
      messages: this.messages,
      modeId: this.modeId,
      ...(this.model ? { model: this.model } : {}),
      settings: this.settings,
      systemInjected: this.systemInjected,
    };
  }

  static restore(snapshot: SessionSnapshot): Session {
    const session = new Session(snapshot.cwd, snapshot.sessionId);
    session.messages.push(...snapshot.messages);
    session.createdAt = snapshot.createdAt;
    session.lastActivityAt = Date.parse(snapshot.updatedAt) || Date.now();
    session.modeId = snapshot.modeId || "default";
    session.model = snapshot.model;
    session.settings = snapshot.settings ?? {};
    session.systemInjected = snapshot.systemInjected;
    session.title = snapshot.title;
    return session;
  }

  async closeResources(): Promise<void> {
    const bridge = this.mcpBridge;
    this.mcpBridge = null;
    await bridge?.close();
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly sessionDir?: string) {
    if (sessionDir) mkdirSync(sessionDir, { recursive: true });
  }

  create(cwd: string): Session {
    this.pruneExpired();
    this.pruneFiles();
    const session = new Session(cwd);
    this.sessions.set(session.id, session);
    this.save(session);
    return session;
  }

  get(sessionId: string): Session {
    const live = this.sessions.get(sessionId);
    if (live) {
      live.touch();
      return live;
    }
    const restored = this.read(sessionId);
    if (!restored) {
      throw RequestError.resourceNotFound(sessionId);
    }
    restored.touch();
    this.sessions.set(restored.id, restored);
    return restored;
  }

  save(session: Session): void {
    if (!this.sessionDir) return;
    writeFileSync(this.file(session.id), JSON.stringify(session.snapshot()));
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  removeStored(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (!this.sessionDir) return;
    try {
      unlinkSync(this.file(sessionId));
    } catch {
      // already gone
    }
  }

  list(cwd?: string | null, cursor?: string | null): { sessions: SessionSnapshot[]; nextCursor?: string } {
    const all = this.snapshots()
      .filter((snapshot) => !cwd || snapshot.cwd === cwd)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + 50);
    const next = start + page.length;
    return { sessions: page, ...(next < all.length ? { nextCursor: String(next) } : {}) };
  }

  private snapshots(): SessionSnapshot[] {
    const byId = new Map<string, SessionSnapshot>();
    for (const session of this.sessions.values()) {
      byId.set(session.id, session.snapshot());
    }
    if (!this.sessionDir) return Array.from(byId.values());
    for (const name of readdirSync(this.sessionDir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (byId.has(id)) continue;
      const restored = this.read(id);
      if (restored) byId.set(id, restored.snapshot());
    }
    return Array.from(byId.values());
  }

  private read(sessionId: string): Session | undefined {
    if (!this.sessionDir) return undefined;
    try {
      const snapshot = JSON.parse(readFileSync(this.file(sessionId), "utf8")) as SessionSnapshot;
      if (snapshot.sessionId !== sessionId) return undefined;
      return Session.restore(snapshot);
    } catch {
      return undefined;
    }
  }

  private file(sessionId: string): string {
    return join(this.sessionDir ?? "", `${sessionId}.json`);
  }

  private pruneFiles(): void {
    if (!this.sessionDir) return;
    const cutoff = Date.now() - FILE_TTL_MS;
    for (const name of readdirSync(this.sessionDir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const restored = this.read(id);
      if (restored && Date.parse(restored.snapshot().updatedAt) < cutoff) {
        this.removeStored(id);
      }
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    const expired: Session[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > SESSION_TTL_MS) {
        expired.push(session);
        this.sessions.delete(id);
      }
    }
    for (const session of expired) {
      void session.closeResources().catch((error) => {
        console.error(`Failed to close MCP bridge for expired session ${session.id}:`, error);
      });
    }
  }
}
