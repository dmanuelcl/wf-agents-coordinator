import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceLayoutStore } from "./workspace-layout-store";
import type { WorkspaceLayout } from "./workspace-layout-store";

let dir: string;
let storeFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-layout-"));
  storeFilePath = join(dir, "workspace-layout.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LAYOUT: WorkspaceLayout = {
  openedSessions: [
    {
      sessionId: "s1",
      openedRoleTabs: ["architect", "implementer"],
      shellTabs: [{ id: "sh-1", title: "Shell 1" }],
      activeTab: "implementer",
    },
    { sessionId: "s2", openedRoleTabs: ["architect"], shellTabs: [], activeTab: "log" },
  ],
  selectedSessionId: "s1",
};

describe("createWorkspaceLayoutStore", () => {
  it("returns null before anything is persisted", async () => {
    const store = createWorkspaceLayoutStore({ storeFilePath });
    expect(await store.get()).toBeNull();
  });

  it("persists and reads back the layout", async () => {
    const store = createWorkspaceLayoutStore({ storeFilePath });
    await store.set(LAYOUT);

    const reopened = createWorkspaceLayoutStore({ storeFilePath });
    expect(await reopened.get()).toEqual(LAYOUT);
  });

  it("overwrites the layout on a repeat set", async () => {
    const store = createWorkspaceLayoutStore({ storeFilePath });
    await store.set(LAYOUT);
    await store.set({ openedSessions: [], selectedSessionId: null });
    expect(await store.get()).toEqual({ openedSessions: [], selectedSessionId: null });
  });
});
