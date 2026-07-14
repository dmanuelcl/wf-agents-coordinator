import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveWorkflowCwd } from "../../shared/workflow/worktree-resolver";

const execFileAsync = promisify(execFile);

export interface WorktreeDetection {
  exists: boolean;
  path: string;
}

export interface WorktreeCreatePlan {
  path: string;
  command: string;
  rollbackCommand: string;
  safe: boolean;
  warnings: string[];
}

function resolveWorktreePath(projectRoot: string, slug: string): { path: string; outsideProjectRoot: boolean; warnings: string[] } {
  const result = resolveWorkflowCwd({
    projectRoot,
    nextCwd: join(".worktrees", slug),
    frontmatterWorktree: null,
  });
  return { path: result.cwd, outsideProjectRoot: result.outsideProjectRoot, warnings: result.warnings };
}

export function detectWorktree(params: { projectRoot: string; slug: string }): WorktreeDetection {
  const { path } = resolveWorktreePath(params.projectRoot, params.slug);
  return { exists: existsSync(path), path };
}

export function buildWorktreeCreatePlan(params: {
  projectRoot: string;
  slug: string;
  branch: string;
}): WorktreeCreatePlan {
  const { path, outsideProjectRoot, warnings } = resolveWorktreePath(params.projectRoot, params.slug);

  return {
    path,
    command: `git worktree add ${path} ${params.branch}`,
    rollbackCommand: `git worktree remove ${path}`,
    safe: !outsideProjectRoot,
    warnings,
  };
}

export async function createWorktree(params: {
  projectRoot: string;
  slug: string;
  branch: string;
  /** When true, create the branch with the worktree (`-b`) instead of checking out an existing one. */
  createBranch?: boolean;
  /** When true, check out `branch` in DETACHED HEAD (for reviewing an existing ref, incl. `origin/…`). */
  detach?: boolean;
  execFileImpl?: typeof execFileAsync;
}): Promise<void> {
  const plan = buildWorktreeCreatePlan(params);
  if (!plan.safe) {
    throw new Error(
      `Refusing to create worktree: path "${plan.path}" resolves outside the project root "${params.projectRoot}".`,
    );
  }

  const exec = params.execFileImpl ?? execFileAsync;
  const args = params.detach
    ? ["worktree", "add", "--detach", plan.path, params.branch]
    : params.createBranch
      ? ["worktree", "add", "-b", params.branch, plan.path]
      : ["worktree", "add", plan.path, params.branch];
  await exec("git", args, { cwd: params.projectRoot });
}

export async function removeWorktree(params: {
  projectRoot: string;
  worktreePath: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<void> {
  const exec = params.execFileImpl ?? execFileAsync;
  try {
    // --force so a live agent's cwd or uncommitted changes don't block removal
    // (the user has already confirmed). The git branch is intentionally kept.
    await exec("git", ["worktree", "remove", "--force", params.worktreePath], { cwd: params.projectRoot });
  } catch (error) {
    // Already gone (manually removed / pruned) is fine; surface anything else.
    if (existsSync(params.worktreePath)) throw error;
  }
}
