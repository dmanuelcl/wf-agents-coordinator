import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionAgentUuidStore } from "./session-agent-uuid-store";

let dir: string;
let storeFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-uuid-store-"));
  storeFilePath = join(dir, "session-agents.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createSessionAgentUuidStore", () => {
  it("returns null for an unknown (session, lane)", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    expect(await store.get({ sessionId: "s1", lane: "plan-1/implementer" })).toBeNull();
  });

  it("persists and reads back a provider binding for a (session, lane)", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    await store.set({
      sessionId: "s1",
      lane: "plan-1/implementer",
      binding: { agentKind: "codex", sessionUuid: "uuid-1" },
    });

    // A fresh instance reads from disk, proving it persisted.
    const reopened = createSessionAgentUuidStore({ storeFilePath });
    expect(await reopened.get({ sessionId: "s1", lane: "plan-1/implementer" })).toEqual({
      agentKind: "codex",
      sessionUuid: "uuid-1",
    });
  });

  it("keeps plan lanes within a session independent", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    await store.set({
      sessionId: "s1",
      lane: "plan-1/reviewer",
      binding: { agentKind: "claude", sessionUuid: "rev-1" },
    });
    await store.set({
      sessionId: "s1",
      lane: "plan-2/reviewer",
      binding: { agentKind: "claude", sessionUuid: "rev-2" },
    });

    expect(await store.get({ sessionId: "s1", lane: "plan-1/reviewer" })).toEqual({
      agentKind: "claude",
      sessionUuid: "rev-1",
    });
    expect(await store.get({ sessionId: "s1", lane: "plan-2/reviewer" })).toEqual({
      agentKind: "claude",
      sessionUuid: "rev-2",
    });
  });

  it("overwrites a lane binding when its provider changes", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    await store.set({
      sessionId: "s1",
      lane: "architect",
      binding: { agentKind: "claude", sessionUuid: "old" },
    });
    await store.set({
      sessionId: "s1",
      lane: "architect",
      binding: { agentKind: "codex", sessionUuid: "new" },
    });
    expect(await store.get({ sessionId: "s1", lane: "architect" })).toEqual({
      agentKind: "codex",
      sessionUuid: "new",
    });
  });

  it("reads the old role-to-uuid shape as a legacy binding", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(storeFilePath, JSON.stringify({ s1: { architect: "legacy-uuid" } }), "utf8");

    const store = createSessionAgentUuidStore({ storeFilePath });
    expect(await store.get({ sessionId: "s1", lane: "architect" })).toEqual({
      agentKind: null,
      sessionUuid: "legacy-uuid",
    });
  });
});
