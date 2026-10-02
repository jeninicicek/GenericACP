import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import { Session, SessionStore } from "../../src/acp/session.js";

describe("Session", () => {
  it("creates a session with a unique id", () => {
    const a = new Session("C:/");
    const b = new Session("C:/");
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("stores cwd", () => {
    const session = new Session("C:/project");
    expect(session.cwd).toBe("C:/project");
  });

  it("assigns incrementing assistant message ids per session", () => {
    const session = new Session("C:/");
    expect(session.nextAssistantMessageId()).toBe("assistant-0");
    expect(session.nextAssistantMessageId()).toBe("assistant-1");
    const other = new Session("C:/");
    expect(other.nextAssistantMessageId()).toBe("assistant-0");
  });

  it("touches lastActivityAt", () => {
    const session = new Session("C:/");
    const before = session.lastActivityAt;
    session.touch();
    expect(session.lastActivityAt).toBeGreaterThanOrEqual(before);
  });
});

describe("SessionStore", () => {
  it("creates and retrieves a session by id", () => {
    const store = new SessionStore();
    const session = store.create("C:/");
    expect(store.get(session.id)).toBe(session);
  });

  it("throws resource-not-found on an unknown session id", () => {
    const store = new SessionStore();
    expect(() => store.get("nope")).toThrow(RequestError);
  });

  it("prunes expired sessions on create", () => {
    const store = new SessionStore();
    const session = store.create("C:/");
    session.lastActivityAt = Date.now() - 60 * 60 * 1000 - 1;
    store.create("C:/other");
    expect(() => store.get(session.id)).toThrow(RequestError);
  });

  it("closes the MCP bridge of an expired session", async () => {
    const store = new SessionStore();
    const session = store.create("C:/");
    const close = vi.fn(async () => {});
    session.mcpBridge = { close } as unknown as Session["mcpBridge"];
    session.lastActivityAt = Date.now() - 60 * 60 * 1000 - 1;
    store.create("C:/other");
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("touches session activity on get", () => {
    const store = new SessionStore();
    const session = store.create("C:/");
    session.lastActivityAt = 0;
    const retrieved = store.get(session.id);
    expect(retrieved.lastActivityAt).toBeGreaterThan(0);
  });
});