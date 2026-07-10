import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 24 * 1024 * 1024;
// Bound the per-file work for untracked files so a huge new-file set can't hang.
const MAX_UNTRACKED = 200;
// Lines of unchanged context shown above/below each change (git's default is 3).
// More context makes it easier to see where a change sits.
const DIFF_CONTEXT_LINES = 8;

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch {
    return null;
  }
}

// `git diff --no-index` exits 1 when the inputs differ but still writes the diff
// to stdout — capture it regardless of exit code.
async function gitCaptureStdout(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

async function resolveBaseRef(cwd: string): Promise<string | null> {
  for (const ref of ["main", "master"]) {
    if ((await tryGit(cwd, ["rev-parse", "--verify", "--quiet", ref])) !== null) return ref;
  }
  return null;
}

/**
 * The full diff of a session's work: tracked changes since the branch point
 * (committed + uncommitted) PLUS untracked new files — `git diff` ignores those,
 * but they're exactly the new files the agent creates, so we synthesize an
 * all-added diff for each (respecting .gitignore). Empty string means no changes.
 */
export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const base = await resolveBaseRef(worktreePath);
  let from = "HEAD";
  if (base) {
    const mergeBase = await tryGit(worktreePath, ["merge-base", base, "HEAD"]);
    if (mergeBase && mergeBase.trim()) from = mergeBase.trim();
  }

  let diff = (await tryGit(worktreePath, ["diff", `-U${DIFF_CONTEXT_LINES}`, from])) ?? "";

  const untrackedList = (await tryGit(worktreePath, ["ls-files", "--others", "--exclude-standard"])) ?? "";
  const untracked = untrackedList
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);

  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    const fileDiff = await gitCaptureStdout(worktreePath, ["diff", "--no-index", devNull, file]);
    if (fileDiff.trim()) {
      if (diff && !diff.endsWith("\n")) diff += "\n";
      diff += fileDiff;
    }
  }

  return diff;
}
