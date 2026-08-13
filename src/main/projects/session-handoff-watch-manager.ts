import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseSessionHandoff, SESSION_HANDOFF_DIR, SESSION_HANDOFF_FILENAME } from "../../shared/workflow/session-handoff";
import type { SessionHandoff } from "../../shared/workflow/session-handoff";
import { SESSION_HANDOFF_EXCLUDE } from "../../shared/workflow/session-handoff";
import { createCheckpointWatcher } from "./checkpoint-watcher";
import type { CheckpointWatcher, CreateWatcher } from "./checkpoint-watcher";
import { addWorktreeExclude } from "./worktree-exclude";

export interface SessionHandoffWatchManager {
  watchSession(params: { sessionId: string; worktreePath: string }): Promise<void>;
  unwatchSession(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * Watches one session's `.wf/handoff.json` — the file `wf done` writes as an
 * agent's last act — and reports every version of it.
 *
 * Deliberately NOT one-shot, unlike the session checkpoint watcher: the
 * checkpoint watcher exists to open a gate once, this one reports the end of
 * every turn for the life of the session.
 *
 * The watch is pointed at `.wf/`, not at the worktree root. chokidar watches
 * recursively, so a root watch would pull in `node_modules` and every build
 * output in the tree.
 */
export function createSessionHandoffWatchManager(params: {
  createWatcher: CreateWatcher;
  debounceMs?: number;
  onHandoff: (sessionId: string, handoff: SessionHandoff) => void;
}): SessionHandoffWatchManager {
  const { createWatcher, debounceMs, onHandoff } = params;
  const watchers = new Map<string, CheckpointWatcher>();
  const pendingStarts = new Map<string, Promise<void>>();

  async function stop(sessionId: string): Promise<void> {
    await pendingStarts.get(sessionId)?.catch(() => {});
    const watcher = watchers.get(sessionId);
    if (!watcher) return;
    watchers.delete(sessionId);
    await watcher.close();
  }

  async function report(sessionId: string, filePath: string): Promise<void> {
    let json: string;
    try {
      json = await readFile(filePath, "utf8");
    } catch {
      // Removed, or replaced between the event and this read. The next write
      // reports again; a missing hand-off simply leaves the gate waiting.
      return;
    }
    const handoff = parseSessionHandoff(json);
    // Unparseable content is not an error to surface: `wf done` writes through a
    // rename, so the only way to see a partial file is a workflow that does not.
    // Either way the gate must hold rather than act on it.
    if (handoff) onHandoff(sessionId, handoff);
  }

  async function start(sessionId: string, worktreePath: string): Promise<void> {
    const handoffDir = join(worktreePath, SESSION_HANDOFF_DIR);
    const handoffPath = join(handoffDir, SESSION_HANDOFF_FILENAME);

    // Hide the directory from git before creating it. This runs on every watch,
    // not only at session creation, so worktrees made by older app versions gain
    // the exclude too. Best-effort: an unexcluded hand-off is untidy in
    // `git status`, but it must never stop the session from being watched.
    await addWorktreeExclude(worktreePath, SESSION_HANDOFF_EXCLUDE).catch(() => {});

    // chokidar with `ignoreInitial` silently drops a file created inside a
    // directory that did not exist when the watch began, and a fresh worktree
    // has no `.wf/` yet. Materialize it first.
    await mkdir(handoffDir, { recursive: true });

    // A hand-off may already be on disk: the session was reselected, or the
    // runner restarted mid-turn. `ignoreInitial` would never surface it.
    await report(sessionId, handoffPath);

    const watcher = createCheckpointWatcher({
      paths: [handoffDir],
      createWatcher,
      debounceMs,
      onChanged: (filePath) => {
        if (basename(filePath) !== SESSION_HANDOFF_FILENAME) return;
        void report(sessionId, filePath);
      },
      onRemoved: () => {
        // Removing the file does not retract a hand-off already reported, and it
        // never drops the session back to the unguarded fallback.
      },
    });

    watchers.set(sessionId, watcher);
  }

  return {
    watchSession({ sessionId, worktreePath }) {
      if (watchers.has(sessionId)) return Promise.resolve();
      const pending = pendingStarts.get(sessionId);
      if (pending) return pending;

      const startPromise = start(sessionId, worktreePath).finally(() => {
        if (pendingStarts.get(sessionId) === startPromise) pendingStarts.delete(sessionId);
      });
      pendingStarts.set(sessionId, startPromise);
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
