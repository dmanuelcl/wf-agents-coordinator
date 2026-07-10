import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckpointWatcher } from "./checkpoint-watcher";
import type { WatcherHandle } from "./checkpoint-watcher";

interface FakeWatcher extends WatcherHandle {
  emitAdd(path: string): void;
  emitChange(path: string): void;
  emitUnlink(path: string): void;
  closeCalled: boolean;
}

function createFakeWatcher(): FakeWatcher {
  let addCb: ((path: string) => void) | null = null;
  let changeCb: ((path: string) => void) | null = null;
  let unlinkCb: ((path: string) => void) | null = null;

  const fake: FakeWatcher = {
    closeCalled: false,
    onAdd(cb) {
      addCb = cb;
    },
    onChange(cb) {
      changeCb = cb;
    },
    onUnlink(cb) {
      unlinkCb = cb;
    },
    async close() {
      fake.closeCalled = true;
    },
    emitAdd(path) {
      addCb?.(path);
    },
    emitChange(path) {
      changeCb?.(path);
    },
    emitUnlink(path) {
      unlinkCb?.(path);
    },
  };

  return fake;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCheckpointWatcher", () => {
  it("collapses N rapid change events on one file into a single re-parse", () => {
    const fakeWatcher = createFakeWatcher();
    const onChanged = vi.fn();
    const onRemoved = vi.fn();
    createCheckpointWatcher({
      paths: ["/repo/checkpoints/*.md"],
      createWatcher: () => fakeWatcher,
      debounceMs: 300,
      onChanged,
      onRemoved,
    });

    fakeWatcher.emitChange("/repo/checkpoints/x.md");
    vi.advanceTimersByTime(100);
    fakeWatcher.emitChange("/repo/checkpoints/x.md");
    vi.advanceTimersByTime(100);
    fakeWatcher.emitChange("/repo/checkpoints/x.md");
    vi.advanceTimersByTime(300);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith("/repo/checkpoints/x.md");
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("debounces add events the same as change events", () => {
    const fakeWatcher = createFakeWatcher();
    const onChanged = vi.fn();
    createCheckpointWatcher({
      paths: ["/repo/checkpoints/*.md"],
      createWatcher: () => fakeWatcher,
      debounceMs: 300,
      onChanged,
      onRemoved: vi.fn(),
    });

    fakeWatcher.emitAdd("/repo/checkpoints/new.md");
    vi.advanceTimersByTime(300);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith("/repo/checkpoints/new.md");
  });

  it("debounces independently per file path", () => {
    const fakeWatcher = createFakeWatcher();
    const onChanged = vi.fn();
    createCheckpointWatcher({
      paths: ["/repo/checkpoints/*.md"],
      createWatcher: () => fakeWatcher,
      debounceMs: 300,
      onChanged,
      onRemoved: vi.fn(),
    });

    fakeWatcher.emitChange("/repo/checkpoints/a.md");
    fakeWatcher.emitChange("/repo/checkpoints/b.md");
    vi.advanceTimersByTime(300);

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledWith("/repo/checkpoints/a.md");
    expect(onChanged).toHaveBeenCalledWith("/repo/checkpoints/b.md");
  });

  it("calls onRemoved (debounced) when a file is unlinked, not onChanged", () => {
    const fakeWatcher = createFakeWatcher();
    const onChanged = vi.fn();
    const onRemoved = vi.fn();
    createCheckpointWatcher({
      paths: ["/repo/checkpoints/*.md"],
      createWatcher: () => fakeWatcher,
      debounceMs: 300,
      onChanged,
      onRemoved,
    });

    fakeWatcher.emitUnlink("/repo/checkpoints/x.md");
    vi.advanceTimersByTime(300);

    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith("/repo/checkpoints/x.md");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a change followed by an unlink before the debounce settles only fires removal", () => {
    const fakeWatcher = createFakeWatcher();
    const onChanged = vi.fn();
    const onRemoved = vi.fn();
    createCheckpointWatcher({
      paths: ["/repo/checkpoints/*.md"],
      createWatcher: () => fakeWatcher,
      debounceMs: 300,
      onChanged,
      onRemoved,
    });

    fakeWatcher.emitChange("/repo/checkpoints/x.md");
    vi.advanceTimersByTime(100);
    fakeWatcher.emitUnlink("/repo/checkpoints/x.md");
    vi.advanceTimersByTime(300);

    expect(onChanged).not.toHaveBeenCalled();
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it("closes the underlying watcher and clears pending timers", async () => {
    const fakeWatcher = createFakeWatcher();
    const onChanged = vi.fn();
    const watcher = createCheckpointWatcher({
      paths: ["/repo/checkpoints/*.md"],
      createWatcher: () => fakeWatcher,
      debounceMs: 300,
      onChanged,
      onRemoved: vi.fn(),
    });

    fakeWatcher.emitChange("/repo/checkpoints/x.md");
    await watcher.close();
    vi.advanceTimersByTime(300);

    expect(fakeWatcher.closeCalled).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
