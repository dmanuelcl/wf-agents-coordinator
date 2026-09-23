import { prFixCompletionCheckpointPath } from "../../shared/workflow/pr-fix-kickoff";
import { watchProgramSpec } from "../../shared/workflow/session-program";
import type { WorkSession } from "../../shared/workflow/work-session";
import type { WatchSessionParams } from "./session-checkpoint-watch-manager";

/**
 * The one place that decides how a session's checkpoint gate is watched. The
 * runtime (on start) and the IPC layer (on create/list) both used to build this
 * inline, and the program filter must reach both.
 */
export function sessionCheckpointWatchParams(session: WorkSession): WatchSessionParams {
  return {
    sessionId: session.id,
    worktreePath: session.worktreePath,
    createdAtEpochMs: session.createdAtEpochMs,
    expectedCheckpointPath: session.kind === "pr-fix" ? prFixCompletionCheckpointPath(session.slug) : undefined,
    programSpecPath: watchProgramSpec(session) ?? undefined,
  };
}
