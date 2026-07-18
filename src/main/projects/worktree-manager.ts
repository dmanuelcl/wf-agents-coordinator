import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * Drop Git's administration entries for worktrees whose directories no longer
 * exist. A killed app or a manually removed directory can otherwise make the
 * next `git worktree add` fail even though nothing is visible on disk.
 */
export async function pruneWorktrees(params: {
  projectRoot: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<void> {
  const exec = params.execFileImpl ?? execFileAsync;
  await exec("git", ["worktree", "prune", "--expire", "now"], { cwd: params.projectRoot });
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
  // Reconcile stale Git metadata before adding. This is safe: only entries
  // whose linked working directory is already gone are pruned.
  await pruneWorktrees({ projectRoot: params.projectRoot, execFileImpl: exec });
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
  const worktreesRoot = resolve(params.projectRoot, ".worktrees");
  const target = resolve(params.projectRoot, params.worktreePath);
  const targetRelative = relative(worktreesRoot, target);
  if (
    !targetRelative ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error(`Refusing to remove worktree outside "${worktreesRoot}": "${target}".`);
  }

  async function isRegistered(): Promise<boolean> {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: params.projectRoot });
    return String(stdout)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(params.projectRoot, line.slice("worktree ".length).trim()))
      .includes(target);
  }

  async function removeOrphanDirectory(): Promise<void> {
    await rm(target, { recursive: true, force: true });
    await pruneWorktrees({ projectRoot: params.projectRoot, execFileImpl: exec });
  }

  // The session record can outlive Git's administration entry (manual cleanup,
  // interrupted prior deletion, copied app state). In that case `git worktree
  // remove` says "is not a working tree" even though the orphan directory is
  // still visible. The user already confirmed deletion, so remove it directly.
  if (!(await isRegistered())) {
    await removeOrphanDirectory();
    return;
  }

  try {
    // --force so a live agent's cwd or uncommitted changes don't block removal
    // (the user has already confirmed). The git branch is intentionally kept.
    await exec("git", ["worktree", "remove", "--force", target], { cwd: params.projectRoot });
  } catch (error) {
    // Already gone (manually removed) is fine, but prune the stale admin entry
    // immediately so recreating the same session cannot inherit the conflict.
    if (!existsSync(target)) {
      await pruneWorktrees({ projectRoot: params.projectRoot, execFileImpl: exec });
      return;
    }
    // Registration may have disappeared between the preflight and removal.
    if (!(await isRegistered())) {
      await removeOrphanDirectory();
      return;
    }
    throw error;
  }
}
