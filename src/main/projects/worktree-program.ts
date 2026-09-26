import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { frontmatterField, frontmatterStatus, localBranchName, programPathOf } from "../../shared/workflow/program-spec";

const CHECKPOINT_DIR_SEGMENTS = ["docs", "workflow", "checkpoints"] as const;

/**
 * The program whose children were made on THIS branch. A program's children
 * share its branch, so the session holding that branch is the program's session
 * even while it is bound to another checkpoint — the parent that spawned the
 * program, whose NEXT soon stops saying `wf next`.
 *
 * Every worktree also holds the checkpoints of every feature merged into its
 * branch through develop, other programs' children included; they are told
 * apart by their frontmatter `branch:`. Counting them showed another feature's
 * program in the wrong session (deploy-platform showed sales-channels,
 * 2026-09-25). When several programs of this branch qualify, one with an open
 * child wins, then the most recently touched.
 */
export async function worktreeProgramSpec(worktreePath: string, branch: string): Promise<string | null> {
  const own = localBranchName(branch);
  const dir = join(worktreePath, ...CHECKPOINT_DIR_SEGMENTS);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith("-checkpoint.md"));
  } catch {
    return null;
  }
  const candidates: { spec: string; open: boolean; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const path = join(dir, name);
      const text = await readFile(path, "utf8");
      const spec = programPathOf(text);
      const childBranch = frontmatterField(text, "branch");
      if (spec && childBranch !== null && localBranchName(childBranch) === own) candidates.push({ spec, open: frontmatterStatus(text) !== "DONE", mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // A checkpoint removed while reading is simply not a candidate.
    }
  }
  candidates.sort((a, b) => Number(b.open) - Number(a.open) || b.mtimeMs - a.mtimeMs);
  return candidates[0]?.spec ?? null;
}
