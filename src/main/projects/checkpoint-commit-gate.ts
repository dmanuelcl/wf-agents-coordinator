import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `unknown` means git could not answer — never treated as a green light. */
export type CheckpointCommitState = "committed" | "uncommitted" | "unknown";

/**
 * Whether the session's checkpoint, as it stands on disk, is already committed.
 *
 * The workflow's contract is that an agent's very last act is to write `▶ NEXT`
 * and commit it — after that it does nothing. So "the NEXT on disk is in HEAD"
 * is a fact-based end-of-turn signal, where a delay measured from the file
 * write is only a guess: an agent that writes NEXT early in its turn still has
 * work to do, and no timer can tell that apart from one that has finished.
 *
 * Trackedness is checked separately because `git status` is silent about a file
 * the repo ignores, and silence would otherwise read as "clean, so committed".
 */
export async function checkpointCommitState(params: {
  worktreePath: string;
  checkpointPath: string;
}): Promise<CheckpointCommitState> {
  const { worktreePath, checkpointPath } = params;
  try {
    const tracked = await execFileAsync("git", ["ls-files", "--", checkpointPath], { cwd: worktreePath });
    if (tracked.stdout.trim() === "") return "uncommitted";
    const status = await execFileAsync("git", ["status", "--porcelain", "--", checkpointPath], { cwd: worktreePath });
    return status.stdout.trim() === "" ? "committed" : "uncommitted";
  } catch {
    return "unknown";
  }
}
