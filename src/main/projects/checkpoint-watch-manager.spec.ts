import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProjectRuntimeConfig } from "../../shared/workflow/agent-runtime-config";
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import { createDefaultReviewConfig } from "../../shared/workflow/review-config";
import { createDefaultVcsConfig } from "../../shared/workflow/vcs-config";
import { createCheckpointWatchManager } from "./checkpoint-watch-manager";
import type { WatcherHandle } from "./checkpoint-watcher";
import type { ProjectRecord } from "./project-registry";

let dir: string;

function checkpointMarkdown(slug: string): string {
  return `---
feature: Example ${slug}
slug: ${slug}
kind: feature
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** implementer
- **Corre:** \`wf implement docs/workflow/checkpoints/${slug}-checkpoint.md\`
- **cwd:** \`.\`
`;
}

function writeCheckpoint(root: string, slug: string): string {
  const checkpointDir = join(root, "docs", "workflow", "checkpoints");
  mkdirSync(checkpointDir, { recursive: true });
  const filePath = join(checkpointDir, `${slug}-checkpoint.md`);
  writeFileSync(filePath, checkpointMarkdown(slug), "utf8");
  return filePath;
}

function makeProject(rootPath: string): ProjectRecord {
  return {
    id: "test-project",
    name: "test-project",
    rootPath,
    checkpointGlobs: ["docs/workflow/checkpoints/*-checkpoint.md"],
    iconDataUrl: null,
    runtimeConfig: createDefaultProjectRuntimeConfig(),
    autoPilot: createDefaultAutoPilotConfig(),
    review: createDefaultReviewConfig(),
    vcs: createDefaultVcsConfig(),
    setupCommand: "",
    createdAtEpochMs: 0,
    updatedAtEpochMs: 0,
  };
}

interface FakeWatcher extends WatcherHandle {
  emitChange(path: string): void;
  emitUnlink(path: string): void;
  watchedPaths: string[];
  closeCalled: boolean;
}

function makeFakeCreateWatcher(): { createWatcher: (paths: string[]) => WatcherHandle; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = [];

  const createWatcher = (paths: string[]): WatcherHandle => {
    let changeCb: ((path: string) => void) | null = null;
    let unlinkCb: ((path: string) => void) | null = null;

    const fake: FakeWatcher = {
      watchedPaths: paths,
      closeCalled: false,
      onAdd() {},
      onChange(cb) {
        changeCb = cb;
      },
      onUnlink(cb) {
        unlinkCb = cb;
      },
      async close() {
        // A real watcher stops emitting once closed; simulate that so tests can
        // verify unwatchProject actually severs event delivery, not just that
        // close() was called.
        fake.closeCalled = true;
        changeCb = null;
        unlinkCb = null;
      },
      emitChange(path) {
        changeCb?.(path);
      },
      emitUnlink(path) {
        unlinkCb?.(path);
      },
    };
    watchers.push(fake);
    return fake;
  };

  return { createWatcher, watchers };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-watch-manager-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createCheckpointWatchManager", () => {
  it("re-parses just the changed file and reports it with a scanner-compatible checkpointPath", async () => {
    const filePath = writeCheckpoint(dir, "root-example");
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointChanged = vi.fn();

    const manager = createCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointChanged,
      onCheckpointRemoved: vi.fn(),
    });

    await manager.watchProject(makeProject(dir));
    watchers[0]?.emitChange(filePath);
    await vi.waitFor(() => expect(onCheckpointChanged).toHaveBeenCalled());

    expect(onCheckpointChanged).toHaveBeenCalledWith(
      "test-project",
      expect.objectContaining({
        checkpointPath: "docs/workflow/checkpoints/root-example-checkpoint.md",
        slug: "root-example",
      }),
    );
  });

  it("reports a scanner-compatible checkpointPath on removal", async () => {
    const filePath = writeCheckpoint(dir, "root-example");
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointRemoved = vi.fn();

    const manager = createCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointChanged: vi.fn(),
      onCheckpointRemoved,
    });

    await manager.watchProject(makeProject(dir));
    watchers[0]?.emitUnlink(filePath);
    await vi.waitFor(() => expect(onCheckpointRemoved).toHaveBeenCalled());

    expect(onCheckpointRemoved).toHaveBeenCalledWith(
      "test-project",
      "docs/workflow/checkpoints/root-example-checkpoint.md",
    );
  });

  it("ignores changes to files in the watched directory that do not match the checkpoint glob", async () => {
    writeCheckpoint(dir, "root-example");
    const unrelatedFilePath = join(dir, "docs", "workflow", "checkpoints", "notes.txt");
    writeFileSync(unrelatedFilePath, "not a checkpoint", "utf8");

    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointChanged = vi.fn();

    const manager = createCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointChanged,
      onCheckpointRemoved: vi.fn(),
    });

    await manager.watchProject(makeProject(dir));
    watchers[0]?.emitChange(unrelatedFilePath);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCheckpointChanged).not.toHaveBeenCalled();
  });

  it("watches directories, not chokidar v4+ glob strings (which are no longer supported)", async () => {
    writeCheckpoint(dir, "root-example");
    const { createWatcher, watchers } = makeFakeCreateWatcher();

    const manager = createCheckpointWatchManager({
      createWatcher,
      onCheckpointChanged: vi.fn(),
      onCheckpointRemoved: vi.fn(),
    });

    await manager.watchProject(makeProject(dir));

    const watchedPaths = watchers[0]?.watchedPaths ?? [];
    expect(watchedPaths).toEqual([join(dir, "docs", "workflow", "checkpoints")]);
  });

  it("watches worktree-nested checkpoint locations too (D5), not just the project root", async () => {
    writeCheckpoint(join(dir, ".worktrees", "feature-x"), "feature-x-example");
    const { createWatcher, watchers } = makeFakeCreateWatcher();

    const manager = createCheckpointWatchManager({
      createWatcher,
      onCheckpointChanged: vi.fn(),
      onCheckpointRemoved: vi.fn(),
    });

    await manager.watchProject(makeProject(dir));

    const watchedPaths = watchers[0]?.watchedPaths ?? [];
    expect(watchedPaths.some((p) => p.includes(join(".worktrees", "feature-x")))).toBe(true);
  });

  it("stops forwarding events after unwatchProject", async () => {
    const filePath = writeCheckpoint(dir, "root-example");
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointChanged = vi.fn();

    const manager = createCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointChanged,
      onCheckpointRemoved: vi.fn(),
    });

    await manager.watchProject(makeProject(dir));
    await manager.unwatchProject("test-project");

    expect(watchers[0]?.closeCalled).toBe(true);

    watchers[0]?.emitChange(filePath);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onCheckpointChanged).not.toHaveBeenCalled();
  });

  it("does not create duplicate watchers for concurrent project starts", async () => {
    writeCheckpoint(dir, "root-example");
    const { createWatcher, watchers } = makeFakeCreateWatcher();

    const manager = createCheckpointWatchManager({
      createWatcher,
      onCheckpointChanged: vi.fn(),
      onCheckpointRemoved: vi.fn(),
    });

    const project = makeProject(dir);
    await Promise.all([manager.watchProject(project), manager.watchProject(project)]);

    expect(watchers).toHaveLength(1);
  });
});
