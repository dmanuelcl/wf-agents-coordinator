import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStateStore } from "./session-state-store";

let dir: string;
let storeFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-session-state-"));
  storeFilePath = join(dir, "session-state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createSessionStateStore", () => {
  it("returns null for a project with no stored state", async () => {
    const store = createSessionStateStore({ storeFilePath });
    await expect(store.get("project-1")).resolves.toBeNull();
  });

  it("round-trips state for a project across store instances", async () => {
    const store = createSessionStateStore({ storeFilePath });
    const state = {
      selectedCheckpointPath: "docs/workflow/checkpoints/example-checkpoint.md",
      openPanesByCheckpoint: {
        "docs/workflow/checkpoints/example-checkpoint.md": ["implementer" as const, "shell" as const],
      },
      activeRoleByCheckpoint: {
        "docs/workflow/checkpoints/example-checkpoint.md": "implementer" as const,
      },
    };

    await store.set("project-1", state);

    const reloaded = createSessionStateStore({ storeFilePath });
    await expect(reloaded.get("project-1")).resolves.toEqual(state);
  });

  it("keeps state for different projects independent", async () => {
    const store = createSessionStateStore({ storeFilePath });
    const stateA = {
      selectedCheckpointPath: "a.md",
      openPanesByCheckpoint: {},
      activeRoleByCheckpoint: {},
    };
    const stateB = {
      selectedCheckpointPath: "b.md",
      openPanesByCheckpoint: {},
      activeRoleByCheckpoint: {},
    };

    await store.set("project-a", stateA);
    await store.set("project-b", stateB);

    await expect(store.get("project-a")).resolves.toEqual(stateA);
    await expect(store.get("project-b")).resolves.toEqual(stateB);
  });

  it("overwrites only the given project's entry", async () => {
    const store = createSessionStateStore({ storeFilePath });
    await store.set("project-a", {
      selectedCheckpointPath: "a.md",
      openPanesByCheckpoint: {},
      activeRoleByCheckpoint: {},
    });
    await store.set("project-b", {
      selectedCheckpointPath: "b.md",
      openPanesByCheckpoint: {},
      activeRoleByCheckpoint: {},
    });

    await store.set("project-a", {
      selectedCheckpointPath: "a2.md",
      openPanesByCheckpoint: {},
      activeRoleByCheckpoint: {},
    });

    await expect(store.get("project-a").then((s) => s?.selectedCheckpointPath)).resolves.toBe("a2.md");
    await expect(store.get("project-b").then((s) => s?.selectedCheckpointPath)).resolves.toBe("b.md");
  });
});
