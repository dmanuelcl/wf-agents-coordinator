export interface WatcherHandle {
  onAdd(cb: (path: string) => void): void;
  onChange(cb: (path: string) => void): void;
  onUnlink(cb: (path: string) => void): void;
  close(): Promise<void>;
}

export type CreateWatcher = (paths: string[]) => WatcherHandle;

export interface CheckpointWatcher {
  close(): Promise<void>;
}

export function createCheckpointWatcher(params: {
  paths: string[];
  createWatcher: CreateWatcher;
  debounceMs?: number;
  onChanged: (filePath: string) => void;
  onRemoved: (filePath: string) => void;
}): CheckpointWatcher {
  const { paths, createWatcher, onChanged, onRemoved } = params;
  const debounceMs = params.debounceMs ?? 300;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function schedule(filePath: string, fire: (filePath: string) => void): void {
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      timers.delete(filePath);
      fire(filePath);
    }, debounceMs);
    timers.set(filePath, timer);
  }

  const watcher = createWatcher(paths);
  watcher.onAdd((filePath) => schedule(filePath, onChanged));
  watcher.onChange((filePath) => schedule(filePath, onChanged));
  watcher.onUnlink((filePath) => schedule(filePath, onRemoved));

  return {
    async close() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      await watcher.close();
    },
  };
}
