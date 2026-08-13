import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionHandoffWatchManager } from "./session-handoff-watch-manager";
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
      onAdd(cb) { changeCb = cb; },
      onChange(cb) { changeCb = cb; },
      onUnlink() {},
      async close() {
        fake.closeCalled = true;
        changeCb = null;
      },
      emitChange(path) { changeCb?.(path); },
    };
    watchers.push(fake);
    return fake;
  };

  return { createWatcher, watchers };
}

function handoffPath(): string {
  return join(worktree, ".wf", "handoff.json");
}

function writeHandoff(turn: number, lane = "plan-1/reviewer", role = "reviewer"): string {
  mkdirSync(join(worktree, ".wf"), { recursive: true });
  const path = handoffPath();
  writeFileSync(path, JSON.stringify({ turn, next: { role, sessionLane: lane } }), "utf8");
  return path;
}

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "agent-coordinator-handoff-watch-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("createSessionHandoffWatchManager", () => {
  // Watching the worktree root would make chokidar walk node_modules and every
  // build output, so the watch is pointed at the leaf directory.
  it("watches only the worktree's .wf directory", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff: vi.fn() });

    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    expect(watchers[0]?.watchedPaths).toEqual([join(worktree, ".wf")]);
    await manager.closeAll();
  });

  it("reports every hand-off, not just the first", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onHandoff = vi.fn();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff });
    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    watchers[0]?.emitChange(writeHandoff(1, "plan-1/implementer", "implementer"));
    await vi.waitFor(() => expect(onHandoff).toHaveBeenCalledTimes(1));
    watchers[0]?.emitChange(writeHandoff(2));
    await vi.waitFor(() => expect(onHandoff).toHaveBeenCalledTimes(2));

    expect(onHandoff.mock.calls[0]?.[1]).toMatchObject({ turn: 1, role: "implementer", sessionLane: "plan-1/implementer" });
    expect(onHandoff.mock.calls[1]?.[1]).toMatchObject({ turn: 2, role: "reviewer", sessionLane: "plan-1/reviewer" });
    await manager.closeAll();
  });

  // A hand-off written before the watch began — session reselected, or the
  // runner restarted mid-turn — would never surface through `ignoreInitial`.
  it("reports a hand-off that already existed when the watch started", async () => {
    writeHandoff(4);
    const { createWatcher } = makeFakeCreateWatcher();
    const onHandoff = vi.fn();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff });

    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    await vi.waitFor(() => expect(onHandoff).toHaveBeenCalledWith("session", expect.objectContaining({ turn: 4 })));
    await manager.closeAll();
  });

  it("creates the .wf directory so the very first hand-off is seen", async () => {
    const { createWatcher } = makeFakeCreateWatcher();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff: vi.fn() });

    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    expect(() => writeFileSync(join(worktree, ".wf", "probe"), "", "utf8")).not.toThrow();
    await manager.closeAll();
  });

  it("ignores other files that land in the directory", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onHandoff = vi.fn();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff });
    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    mkdirSync(join(worktree, ".wf"), { recursive: true });
    const other = join(worktree, ".wf", "notes.json");
    writeFileSync(other, JSON.stringify({ turn: 9, next: { role: "reviewer", sessionLane: "plan-1/reviewer" } }), "utf8");
    watchers[0]?.emitChange(other);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onHandoff).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it("stays silent on content it cannot parse rather than reporting a guess", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onHandoff = vi.fn();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff });
    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    mkdirSync(join(worktree, ".wf"), { recursive: true });
    writeFileSync(handoffPath(), "{ half writ", "utf8");
    watchers[0]?.emitChange(handoffPath());

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onHandoff).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it("stops reporting after unwatchSession", async () => {
    const { createWatcher, watchers } = makeFakeCreateWatcher();
    const onHandoff = vi.fn();
    const manager = createSessionHandoffWatchManager({ createWatcher, debounceMs: 0, onHandoff });
    await manager.watchSession({ sessionId: "session", worktreePath: worktree });

    await manager.unwatchSession("session");
    watchers[0]?.emitChange(writeHandoff(3));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onHandoff).not.toHaveBeenCalled();
    expect(watchers[0]?.closeCalled).toBe(true);
  });
});
