import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import type { ParsedCheckpoint } from "../../shared/workflow/workflow-types";
import { resolveScanRoots } from "./checkpoint-scanner";
import { createCheckpointWatcher } from "./checkpoint-watcher";
import type { CheckpointWatcher, CreateWatcher, WatcherHandle } from "./checkpoint-watcher";
import type { ProjectRecord } from "./project-registry";

export interface CheckpointWatchManager {
  watchProject(project: ProjectRecord): Promise<void>;
  unwatchProject(projectId: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface WatchTarget {
  dirPath: string;
  filenamePattern: RegExp;
}

// chokidar v4+ dropped glob support (paths are matched literally against the
// filesystem), so watching "<dir>/*-checkpoint.md" directly watches nothing.
// Watch the containing directory instead and filter events against the glob
// ourselves.
function globToWatchTarget(root: string, glob: string): WatchTarget | null {
  const segments = glob.split("/");
  const fileNamePattern = segments.pop();
  if (!fileNamePattern) return null;

  const escaped = fileNamePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return {
    dirPath: join(root, ...segments),
    filenamePattern: new RegExp(`^${escaped}$`),
  };
}

function matchesAnyTarget(targets: WatchTarget[], filePath: string): boolean {
  const dir = dirname(filePath);
  const base = basename(filePath);
  return targets.some((target) => target.dirPath === dir && target.filenamePattern.test(base));
}

function createFilteredWatcher(createWatcher: CreateWatcher, targets: WatchTarget[]): CreateWatcher {
  return (paths) => {
    const raw = createWatcher(paths);
    const filtered: WatcherHandle = {
      onAdd: (cb) => raw.onAdd((path) => matchesAnyTarget(targets, path) && cb(path)),
      onChange: (cb) => raw.onChange((path) => matchesAnyTarget(targets, path) && cb(path)),
      onUnlink: (cb) => raw.onUnlink((path) => matchesAnyTarget(targets, path) && cb(path)),
      close: () => raw.close(),
    };
    return filtered;
  };
}

export function createCheckpointWatchManager(params: {
  createWatcher: CreateWatcher;
  debounceMs?: number;
  onCheckpointChanged: (projectId: string, checkpoint: ParsedCheckpoint) => void;
  onCheckpointRemoved: (projectId: string, checkpointPath: string) => void;
}): CheckpointWatchManager {
  const { createWatcher, debounceMs, onCheckpointChanged, onCheckpointRemoved } = params;
  const watchers = new Map<string, CheckpointWatcher>();
  const operationTails = new Map<string, Promise<void>>();

  function runExclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = operationTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    operationTails.set(projectId, tail);
    void tail.finally(() => {
      if (operationTails.get(projectId) === tail) operationTails.delete(projectId);
    });
    return result;
  }

  async function handleChanged(project: ProjectRecord, absoluteFilePath: string): Promise<void> {
    try {
      const markdown = await readFile(absoluteFilePath, "utf8");
      const checkpointPath = relative(project.rootPath, absoluteFilePath);
      const parsed = parseCheckpointMarkdown({ checkpointPath, markdown });
      onCheckpointChanged(project.id, parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Editors sometimes fire a change event just before an unlink lands; treat as removed.
        onCheckpointRemoved(project.id, relative(project.rootPath, absoluteFilePath));
        return;
      }
      throw error;
    }
  }

  function handleRemoved(project: ProjectRecord, absoluteFilePath: string): void {
    onCheckpointRemoved(project.id, relative(project.rootPath, absoluteFilePath));
  }

  return {
    watchProject(project) {
      return runExclusive(project.id, async () => {
        if (watchers.has(project.id)) return;

        const roots = await resolveScanRoots(project.rootPath);
        const targets = roots
          .flatMap((root) => project.checkpointGlobs.map((glob) => globToWatchTarget(root, glob)))
          .filter((target): target is WatchTarget => target !== null);
        const dirPaths = Array.from(new Set(targets.map((target) => target.dirPath)));

        const watcher = createCheckpointWatcher({
          paths: dirPaths,
          createWatcher: createFilteredWatcher(createWatcher, targets),
          debounceMs,
          onChanged: (filePath) => void handleChanged(project, filePath),
          onRemoved: (filePath) => handleRemoved(project, filePath),
        });

        watchers.set(project.id, watcher);
      });
    },

    unwatchProject(projectId) {
      return runExclusive(projectId, async () => {
        const watcher = watchers.get(projectId);
        if (!watcher) return;
        watchers.delete(projectId);
        await watcher.close();
      });
    },

    async closeAll() {
      await Promise.all(Array.from(operationTails.values()));
      const all = Array.from(watchers.values());
      watchers.clear();
      await Promise.all(all.map((watcher) => watcher.close()));
    },
  };
}
