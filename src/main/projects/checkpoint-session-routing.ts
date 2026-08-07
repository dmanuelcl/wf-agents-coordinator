import { resolve } from "node:path";
import type { WorkSession } from "../../shared/workflow/work-session";

/**
 * Pick the sessions whose own checkpoint file is the one that just changed.
 *
 * The two sides speak different path spaces. The project watcher reports a path
 * relative to the PROJECT ROOT, so a session's own file arrives as
 * `.worktrees/<slug>/docs/workflow/checkpoints/<slug>-checkpoint.md`, while the
 * session stores that same file relative to its OWN WORKTREE
 * (`docs/workflow/checkpoints/<slug>-checkpoint.md`). Comparing the strings
 * directly only ever matches a session living at the project root, which is why
 * auto-pilot never saw a checkpoint update. Resolve both against their own base.
 */
export function sessionsOwningCheckpoint(params: {
  projectRoot: string;
  sessions: WorkSession[];
  changedCheckpointPath: string;
}): WorkSession[] {
  const changedPath = resolve(params.projectRoot, params.changedCheckpointPath);
  return params.sessions.filter(
    (session) =>
      session.checkpointPath !== null && resolve(session.worktreePath, session.checkpointPath) === changedPath,
  );
}
