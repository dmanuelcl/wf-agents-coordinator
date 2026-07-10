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
  it("returns null for an unknown (session, role)", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    expect(await store.get({ sessionId: "s1", role: "implementer" })).toBeNull();
  });

  it("persists and reads back a uuid for a (session, role)", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    await store.set({ sessionId: "s1", role: "implementer", uuid: "uuid-1" });

    // A fresh instance reads from disk, proving it persisted.
    const reopened = createSessionAgentUuidStore({ storeFilePath });
    expect(await reopened.get({ sessionId: "s1", role: "implementer" })).toBe("uuid-1");
  });

  it("keeps roles within a session independent", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    await store.set({ sessionId: "s1", role: "architect", uuid: "arch" });
    await store.set({ sessionId: "s1", role: "reviewer", uuid: "rev" });

    expect(await store.get({ sessionId: "s1", role: "architect" })).toBe("arch");
    expect(await store.get({ sessionId: "s1", role: "reviewer" })).toBe("rev");
    expect(await store.get({ sessionId: "s1", role: "implementer" })).toBeNull();
  });

  it("overwrites the uuid on a repeat set (a fresh launch re-mints)", async () => {
    const store = createSessionAgentUuidStore({ storeFilePath });
    await store.set({ sessionId: "s1", role: "implementer", uuid: "old" });
    await store.set({ sessionId: "s1", role: "implementer", uuid: "new" });
    expect(await store.get({ sessionId: "s1", role: "implementer" })).toBe("new");
  });
});
