import { truncateSessionName } from "../../shared/workflow/work-session";
import type { SessionStartFromInput } from "../../shared/ipc/contract";

/**
 * Where a new feature/fix session starts. `new` is today's behavior — a fresh
 * branch off the repo root — and stays the default so the common path is
 * unchanged.
 */
export type StartFromMode = "new" | "continue" | "fork";

export function canSubmitStartFrom(params: { mode: StartFromMode; ref: string; name: string }): boolean {
  if (!params.name.trim()) return false;
  return params.mode === "new" || params.ref.length > 0;
}

/**
 * Continuing someone else's branch has an obvious name — the branch. Forking
 * does not: the session's branch is minted FROM the name, so suggesting the
 * base would produce `feature/develop`.
 */
export function suggestSessionName(mode: StartFromMode, ref: string): string {
  if (mode !== "continue" || !ref) return "";
  return truncateSessionName(`Continue ${ref}`);
}

export function buildStartFromInput(params: {
  mode: StartFromMode;
  ref: string;
  checkpointPath: string;
}): SessionStartFromInput | undefined {
  if (params.mode === "new") return undefined;
  return {
    mode: params.mode,
    ref: params.ref,
    checkpointPath: params.checkpointPath || null,
  };
}

/** Spell out what the chosen mode will actually do to the branch. */
export function startFromBranchHint(mode: StartFromMode, ref: string): string {
  if (!ref || mode === "new") return "";
  if (mode === "continue") {
    return `The worktree checks out ${ref} itself — writable, so your commits land on that branch.`;
  }
  return `A new branch is cut from origin/${ref} when it is published, so you start from what was pushed rather than from local commits.`;
}
