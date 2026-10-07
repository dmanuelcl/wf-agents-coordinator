import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Where the review skill leaves its 🔵 Notas: one ledger file per branch, written uncommitted in the
 * review worktree. They must reach develop with the PR, so posting the review pushes them first.
 */
export const REVIEW_NOTES_DIR = "docs/workflow/review-notes";

export type ReviewNotesPublishResult = { committed: false } | { committed: true; sha: string };

/** A git command that failed, with what git printed. */
class GitCommandError extends Error {
  constructor(
    readonly command: string,
    readonly output: string,
    readonly exitCode: number | null,
  ) {
    super(`${command}\n${output}`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout).trim() : "";
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : null;
    const output = [stderr, stdout].filter(Boolean).join("\n") || (error instanceof Error ? error.message : String(error));
    throw new GitCommandError(`git ${args.join(" ")}`, output, code);
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    if (existsSync(resolve(cwd, await git(cwd, ["rev-parse", "--git-path", name])))) return true;
  }
  return false;
}

/**
 * Push HEAD to the branch, fast-forward only. When the branch advanced meanwhile, replay the single
 * notes commit on top of it and push once more; a conflict stops the replay and fails.
 */
async function pushNotesCommit(cwd: string, sourceBranch: string): Promise<void> {
  const refspec = `HEAD:refs/heads/${sourceBranch}`;
  try {
    await git(cwd, ["push", "origin", refspec]);
    return;
  } catch (pushError) {
    await git(cwd, ["fetch", "origin", sourceBranch]);
    // The branch did not move, so the push failed for another reason (auth, a hook…): report that one.
    if (await isAncestor(cwd, "FETCH_HEAD", "HEAD")) throw pushError;
  }
  // --autostash: unrelated local edits in the review worktree must not block the replay.
  await git(cwd, ["rebase", "--autostash", "--onto", "FETCH_HEAD", "HEAD~1"]);
  await git(cwd, ["push", "origin", refspec]);
}

/**
 * Put the worktree back as Post found it: on the reviewed commit, with the notes uncommitted, so the
 * next Post commits them again and records the reviewed commit, not the notes one. Returns what went
 * wrong if it could not.
 */
async function undoNotesCommit(cwd: string, reviewedSha: string, notesSha: string): Promise<string | null> {
  try {
    if (await rebaseInProgress(cwd)) await git(cwd, ["rebase", "--abort"]);
    // A replay moved the checkout onto commits nobody reviewed: back to the notes commit first,
    // keeping any local edit outside the files that differ.
    if ((await git(cwd, ["rev-parse", "HEAD"])) !== notesSha) await git(cwd, ["reset", "-q", "--keep", notesSha]);
    await git(cwd, ["reset", "-q", "--soft", reviewedSha]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function notPushedError(sourceBranch: string, cause: unknown, undoProblem: string | null = null): Error {
  const parts = [
    `Could not push the review notes (${REVIEW_NOTES_DIR}/) to ${sourceBranch}, so the review comment was NOT posted — fix the cause and press Post again.`,
    cause instanceof Error ? cause.message : String(cause),
  ];
  if (undoProblem) parts.push(`The notes commit could not be undone either; fix the worktree before posting again:\n${undoProblem}`);
  return new Error(parts.join("\n\n"));
}

/**
 * Commit the review notes left under REVIEW_NOTES_DIR (and nothing else) and push them to the PR's
 * source branch. Throws when they cannot reach the branch; the worktree is then back on the reviewed
 * commit with the notes uncommitted.
 */
export async function publishReviewNotes(params: {
  cwd: string;
  sourceBranch: string;
  prLabel: string;
}): Promise<ReviewNotesPublishResult> {
  const { cwd, sourceBranch, prLabel } = params;
  const pending = await git(cwd, ["status", "--porcelain", "--untracked-files=all", "--", REVIEW_NOTES_DIR]);
  if (!pending) return { committed: false };

  const reviewedSha = await git(cwd, ["rev-parse", "HEAD"]);
  try {
    await git(cwd, ["add", "-A", "--", REVIEW_NOTES_DIR]);
    // Pathspec commit: other staged or dirty files cannot slip into it.
    await git(cwd, ["commit", "-m", `docs(review-notes): notas del review de ${prLabel}`, "--", REVIEW_NOTES_DIR]);
  } catch (error) {
    throw notPushedError(sourceBranch, error);
  }

  const notesSha = await git(cwd, ["rev-parse", "HEAD"]);
  try {
    await pushNotesCommit(cwd, sourceBranch);
  } catch (error) {
    throw notPushedError(sourceBranch, error, await undoNotesCommit(cwd, reviewedSha, notesSha));
  }
  return { committed: true, sha: await git(cwd, ["rev-parse", "HEAD"]) };
}
