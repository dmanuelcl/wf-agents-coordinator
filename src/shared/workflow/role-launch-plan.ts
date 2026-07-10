import { relative, resolve } from "node:path";
import { resolveWorkflowCwd } from "./worktree-resolver";
import type { ParsedCheckpoint, WorkflowRole } from "./workflow-types";

export type LaunchRole = WorkflowRole | "status" | "shell";

export interface RoleLaunchPlan {
  role: LaunchRole;
  command: string | null;
  cwd: string;
  outOfTurn: boolean;
  warnings: string[];
}

const ROLE_COMMAND_MAP: Record<WorkflowRole, string> = {
  architect: "wf verify",
  implementer: "wf implement",
  reviewer: "wf review",
};

export function buildRoleLaunchPlan(params: {
  projectRoot: string;
  checkpointRelativePath: string;
  checkpoint: ParsedCheckpoint;
  requestedRole: LaunchRole;
}): RoleLaunchPlan {
  const { projectRoot, checkpointRelativePath, checkpoint, requestedRole } = params;
  const warnings: string[] = [];

  const cwdResult = resolveWorkflowCwd({
    projectRoot,
    nextCwd: checkpoint.next?.cwd ?? null,
    frontmatterWorktree: checkpoint.worktree,
  });
  warnings.push(...cwdResult.warnings);

  // checkpointRelativePath is relative to the PROJECT root, but commands run
  // with cwd set to the resolved worktree — re-root the path onto that cwd so
  // a checkpoint found inside a worktree doesn't get a doubled path segment
  // (e.g. ".worktrees/x/docs/..." run from cwd ".worktrees/x" would look for
  // ".worktrees/x/.worktrees/x/docs/...", which doesn't exist).
  const commandRelativePath = relative(cwdResult.cwd, resolve(projectRoot, checkpointRelativePath));

  let command: string | null;
  let outOfTurn = false;

  if (requestedRole === "shell") {
    command = null;
  } else if (requestedRole === "status") {
    command = `wf status ${commandRelativePath}`;
  } else {
    const nextRole = checkpoint.next?.role ?? null;
    const isMatch = nextRole === requestedRole;
    outOfTurn = !isMatch;

    if (isMatch && checkpoint.next?.command) {
      command = checkpoint.next.command;
    } else {
      command = `${ROLE_COMMAND_MAP[requestedRole]} ${commandRelativePath}`;
      if (isMatch) {
        warnings.push(`NEXT command is missing; inferred "${command}" from the role.`);
      } else {
        warnings.push(`Requested role "${requestedRole}" does not match NEXT role "${nextRole ?? "unknown"}".`);
      }
    }
  }

  return {
    role: requestedRole,
    command,
    cwd: cwdResult.cwd,
    outOfTurn,
    warnings,
  };
}
