import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCheckpointWatchManager } from "./session-checkpoint-watch-manager";
import type { WatcherHandle } from "./checkpoint-watcher";

let worktree: string;

interface FakeWatcher extends WatcherHandle {
  emitChange(path: string): void;
  watchedPaths: string[];
  closeCalled: boolean;
}

function makeFakeCreateWatcher(): { createWatcher: (paths: string[]) => WatcherHandle; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = [];

  const createWatcher = (paths: string[]): WatcherHandle => {
    let changeCb: ((path: string) => void) | null = null;

    const fake: FakeWatcher = {
      watchedPaths: paths,
      closeCalled: false,
      onAdd(cb) {
        // The primitive routes both add and change to onChanged; a real "add"
        // (a new file appearing) is what we simulate through emitChange.
        changeCb = cb;
      },
      onChange(cb) {
        changeCb = cb;
      },
      onUnlink() {},
      async close() {
        fake.closeCalled = true;
        changeCb = null;
      },
      emitChange(path) {
        changeCb?.(path);
      },
    };
    watchers.push(fake);
    return fake;
  };

  return { createWatcher, watchers };
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "agent-coordinator-session-watch-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("createSessionCheckpointWatchManager", () => {
  it("watches the session worktree's checkpoint directory", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointDetected: vi.fn(),
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });

    expect(watchers[0]?.watchedPaths).toEqual([join(worktree, "docs", "workflow", "checkpoints")]);
  });

  it("fires with a worktree-relative checkpoint path when a checkpoint file appears", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointDetected = vi.fn();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointDetected,
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });
    const filePath = join(worktree, "docs", "workflow", "checkpoints", "add-widget-checkpoint.md");
    watchers[0]?.emitChange(filePath);

    await vi.waitFor(() => expect(onCheckpointDetected).toHaveBeenCalled());
    expect(onCheckpointDetected).toHaveBeenCalledWith("s1", "docs/workflow/checkpoints/add-widget-checkpoint.md");
  });

  it("ignores files in the directory that are not checkpoints", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointDetected = vi.fn();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointDetected,
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });
    watchers[0]?.emitChange(join(worktree, "docs", "workflow", "checkpoints", "notes.md"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCheckpointDetected).not.toHaveBeenCalled();
  });

  it("stops watching after the first checkpoint is detected (one-shot gate)", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointDetected = vi.fn();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointDetected,
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });
    const filePath = join(worktree, "docs", "workflow", "checkpoints", "add-widget-checkpoint.md");
    watchers[0]?.emitChange(filePath);
    await vi.waitFor(() => expect(onCheckpointDetected).toHaveBeenCalledTimes(1));

    expect(watchers[0]?.closeCalled).toBe(true);
    watchers[0]?.emitChange(filePath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onCheckpointDetected).toHaveBeenCalledTimes(1);
  });

  it("stops forwarding events after unwatchSession", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointDetected = vi.fn();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointDetected,
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });
    await manager.unwatchSession("s1");
    expect(watchers[0]?.closeCalled).toBe(true);

    watchers[0]?.emitChange(join(worktree, "docs", "workflow", "checkpoints", "add-widget-checkpoint.md"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onCheckpointDetected).not.toHaveBeenCalled();
  });

  it("detects a checkpoint that already exists when the watch starts (no watcher needed)", async () => {
    const checkpointDir = join(worktree, "docs", "workflow", "checkpoints");
    mkdirSync(checkpointDir, { recursive: true });
    writeFileSync(join(checkpointDir, "add-widget-checkpoint.md"), "# existing", "utf8");

    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onCheckpointDetected = vi.fn();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      debounceMs: 0,
      onCheckpointDetected,
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });

    expect(onCheckpointDetected).toHaveBeenCalledWith("s1", "docs/workflow/checkpoints/add-widget-checkpoint.md");
    expect(watchers).toHaveLength(0);
  });

  it("does not create a second watcher for a session already being watched", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const manager = createSessionCheckpointWatchManager({
      createWatcher,
      onCheckpointDetected: vi.fn(),
    });

    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });
    await manager.watchSession({ sessionId: "s1", worktreePath: worktree });

    expect(watchers).toHaveLength(1);
  });
});
