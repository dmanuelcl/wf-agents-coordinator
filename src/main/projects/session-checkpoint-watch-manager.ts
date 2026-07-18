import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createCheckpointWatcher } from "./checkpoint-watcher";
import type { CheckpointWatcher, CreateWatcher } from "./checkpoint-watcher";

// A session's checkpoint always lands here, inside that session's own worktree.
const CHECKPOINT_DIR_SEGMENTS = ["docs", "workflow", "checkpoints"] as const;
const CHECKPOINT_FILENAME_PATTERN = /-checkpoint\.md$/;

// The newest checkpoint created/modified after this session started, or null.
// Files materialized by `git worktree add` predate `createdAtEpochMs` and belong
// to the checked-out branch's history, not automatically to the new session.
async function existingSessionCheckpoint(
  dir: string,
  createdAtEpochMs: number,
  expectedFilename?: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates = await Promise.all(
    entries
      .filter(
        (name) => CHECKPOINT_FILENAME_PATTERN.test(name) && (!expectedFilename || name === expectedFilename),
      )
      .map(async (name) => {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          return info.isFile() && info.mtimeMs > createdAtEpochMs ? { path, mtimeMs: info.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
  );
  return (
    candidates
      .filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))[0]?.path ?? null
  );
}

interface WatchSessionParams {
  sessionId: string;
  worktreePath: string;
  createdAtEpochMs: number;
  /** When set, no other checkpoint in the worktree may flip this gate. */
  expectedCheckpointPath?: string;
}

export interface SessionCheckpointWatchManager {
  watchSession(params: WatchSessionParams): Promise<void>;
  unwatchSession(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * Watches a single session's worktree for the FIRST checkpoint file to appear,
 * then stops. This is the one-way gate the session UI hangs on: while a session
 * has no checkpoint, its next role stays disabled. For PR fixes an exact
 * expected path prevents an unrelated checkpoint from unlocking Reviewer.
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
  const pendingStarts = new Map<string, Promise<void>>();

  async function stop(sessionId: string): Promise<void> {
    // If start-up is between its filesystem scan and watchers.set(), wait for
    // it. Otherwise deletion could return and the orphan watcher would appear
    // immediately afterward.
    await pendingStarts.get(sessionId)?.catch(() => {});
    const watcher = watchers.get(sessionId);
    if (!watcher) return;
    watchers.delete(sessionId);
    await watcher.close();
  }

  async function start(params: WatchSessionParams): Promise<void> {
    const { sessionId, worktreePath, createdAtEpochMs, expectedCheckpointPath } = params;
    const checkpointDir = join(worktreePath, ...CHECKPOINT_DIR_SEGMENTS);
    const expectedFilename = expectedCheckpointPath ? basename(expectedCheckpointPath) : undefined;

    // A checkpoint may already exist — re-selecting a session, or a checkpoint
    // that landed between session creation and this watch. chokidar's
    // `ignoreInitial` would never surface it, leaving the gate stuck with the
    // tabs disabled despite a real checkpoint on disk. Detect it up front.
    const existing = await existingSessionCheckpoint(checkpointDir, createdAtEpochMs, expectedFilename);
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
      if (expectedFilename && basename(absoluteFilePath) !== expectedFilename) return;
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
  }

  return {
    watchSession(params) {
      if (watchers.has(params.sessionId)) return Promise.resolve();
      const pending = pendingStarts.get(params.sessionId);
      if (pending) return pending;

      const startPromise = start(params).finally(() => {
        if (pendingStarts.get(params.sessionId) === startPromise) {
          pendingStarts.delete(params.sessionId);
        }
      });
      pendingStarts.set(params.sessionId, startPromise);
      return startPromise;
    },

    unwatchSession(sessionId) {
      return stop(sessionId);
    },

    async closeAll() {
      await Promise.all(Array.from(pendingStarts.values()).map((pending) => pending.catch(() => {})));
      const all = Array.from(watchers.values());
      watchers.clear();
      await Promise.all(all.map((watcher) => watcher.close()));
    },
  };
}
