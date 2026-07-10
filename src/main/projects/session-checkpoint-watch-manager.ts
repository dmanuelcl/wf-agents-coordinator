import { mkdir, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createCheckpointWatcher } from "./checkpoint-watcher";
import type { CheckpointWatcher, CreateWatcher } from "./checkpoint-watcher";

// A session's checkpoint always lands here, inside that session's own worktree.
const CHECKPOINT_DIR_SEGMENTS = ["docs", "workflow", "checkpoints"] as const;
const CHECKPOINT_FILENAME_PATTERN = /-checkpoint\.md$/;

// The absolute path of the first checkpoint already present in `dir`, or null.
// A missing directory just means "none yet".
async function firstExistingCheckpoint(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const match = entries.filter((name) => CHECKPOINT_FILENAME_PATTERN.test(name)).sort()[0];
  return match ? join(dir, match) : null;
}

export interface SessionCheckpointWatchManager {
  watchSession(params: { sessionId: string; worktreePath: string }): Promise<void>;
  unwatchSession(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * Watches a single session's worktree for the FIRST checkpoint file to appear,
 * then stops. This is the one-way gate the session UI hangs on: while a session
 * has no checkpoint, only its Architect tab is usable; the moment the architect
 * writes `docs/workflow/checkpoints/<slug>-checkpoint.md`, this fires so the
 * caller can persist the path and enable the Implementer/Reviewer tabs.
 *
 * Deliberately NOT built on `createCheckpointWatchManager`: that manager expands
 * a project root through `git worktree list`, which from inside a worktree would
 * pull in every sibling worktree. Here we watch exactly one directory.
 */
export function createSessionCheckpointWatchManager(params: {
  createWatcher: CreateWatcher;
  debounceMs?: number;
  onCheckpointDetected: (sessionId: string, checkpointPath: string) => void;
}): SessionCheckpointWatchManager {
  const { createWatcher, debounceMs, onCheckpointDetected } = params;
  const watchers = new Map<string, CheckpointWatcher>();

  async function stop(sessionId: string): Promise<void> {
    const watcher = watchers.get(sessionId);
    if (!watcher) return;
    watchers.delete(sessionId);
    await watcher.close();
  }

  return {
    async watchSession({ sessionId, worktreePath }) {
      if (watchers.has(sessionId)) return;

      const checkpointDir = join(worktreePath, ...CHECKPOINT_DIR_SEGMENTS);

      // A checkpoint may already exist — re-selecting a session, or a checkpoint
      // that landed between session creation and this watch. chokidar's
      // `ignoreInitial` would never surface it, leaving the gate stuck with the
      // tabs disabled despite a real checkpoint on disk. Detect it up front.
      const existing = await firstExistingCheckpoint(checkpointDir);
      if (existing) {
        onCheckpointDetected(sessionId, relative(worktreePath, existing));
        return;
      }

      // chokidar v5 with `ignoreInitial` silently drops a file created inside a
      // directory that did not exist when the watch began — and a fresh worktree
      // has no `docs/workflow/checkpoints/` yet (verified empirically against
      // chokidar 5.0.0). Materialize the empty directory first so the very first
      // checkpoint the architect writes is detected. Git does not track empty
      // directories, so this leaves no footprint in the worktree.
      await mkdir(checkpointDir, { recursive: true });

      const handleCandidate = (absoluteFilePath: string): void => {
        // A second event before `stop()` finishes closing would re-enter here;
        // the delete inside `stop()` is synchronous, so this guard bails.
        if (!watchers.has(sessionId)) return;
        if (!CHECKPOINT_FILENAME_PATTERN.test(basename(absoluteFilePath))) return;
        const checkpointPath = relative(worktreePath, absoluteFilePath);
        // One checkpoint per session: once the gate flips, stop watching.
        void stop(sessionId);
        onCheckpointDetected(sessionId, checkpointPath);
      };

      const watcher = createCheckpointWatcher({
        paths: [checkpointDir],
        createWatcher,
        debounceMs,
        onChanged: handleCandidate,
        onRemoved: () => {
          // The gate is one-way (null -> path); a later removal does not reopen it.
        },
      });

      watchers.set(sessionId, watcher);
    },

    unwatchSession(sessionId) {
      return stop(sessionId);
    },

    async closeAll() {
      const all = Array.from(watchers.values());
      watchers.clear();
      await Promise.all(all.map((watcher) => watcher.close()));
    },
  };
}
