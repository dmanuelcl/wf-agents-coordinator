import type { WorkflowStage } from "./agent-runtime-config";
import type { WorkSessionKind } from "./work-session";

// The three agent tabs a session can launch. Shell tabs are plain terminals
// with no agent, so they are not launchable agent roles.
export type SessionAgentRole = "architect" | "implementer" | "reviewer";

export const SESSION_AGENT_ROLES: readonly SessionAgentRole[] = ["architect", "implementer", "reviewer"];

export function isSessionAgentRole(value: string): value is SessionAgentRole {
  return (SESSION_AGENT_ROLES as readonly string[]).includes(value);
}

// architect | implementer | reviewer are all valid WorkflowStage values, so a
// session role maps straight onto the project's per-stage runtime config.
export function stageForSessionRole(role: SessionAgentRole): WorkflowStage {
  return role;
}

/**
 * Restoring a PR session must only resume its conversation. Re-injecting the
 * kickoff would start the review/fix a second time as soon as the app opens.
 * Regular workflow sessions keep their existing pre-type-on-restore behavior.
 */
export function shouldInjectRoleCommand(kind: WorkSessionKind, mode: "fresh" | "resume"): boolean {
  const prSession = kind === "review" || kind === "pr-fix";
  return !prSession || mode === "fresh";
}

const WF_VERB: Record<SessionAgentRole, string> = {
  architect: "wf verify",
  implementer: "wf implement",
  reviewer: "wf review",
};

/**
 * The `wf` message to PRE-TYPE into the agent for a role. No trailing newline is
 * implied — the caller controls whether/when it is submitted (the user presses
 * Enter). `checkpointPath` is already relative to the worktree, which is where
 * the agent runs, so it is used verbatim.
 *
 * Returns null when there is no checkpoint yet: only the architect reaches here
 * in that state (implementer/reviewer tabs are gated off until a checkpoint
 * exists), and a brainstorming architect has nothing to point `wf` at.
 */
export function wfCommandForSessionRole(role: SessionAgentRole, checkpointPath: string | null): string | null {
  if (!checkpointPath) return null;
  return `${WF_VERB[role]} ${checkpointPath}`;
}
