import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { frontmatterStatus, programPathOf } from "../../shared/workflow/program-spec";

const CHECKPOINT_DIR_SEGMENTS = ["docs", "workflow", "checkpoints"] as const;

/**
 * The program whose children live in this worktree. A program's children share
 * its worktree, so the session holding that worktree is the program's session
 * even while it is bound to another checkpoint — the parent that spawned the
 * program, whose NEXT soon stops saying `wf next`. When several programs have
 * children here, one with an open child wins, then the most recently touched.
 */
export async function worktreeProgramSpec(worktreePath: string): Promise<string | null> {
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
      if (spec) candidates.push({ spec, open: frontmatterStatus(text) !== "DONE", mtimeMs: (await stat(path)).mtimeMs });
    } catch {
      // A checkpoint removed while reading is simply not a candidate.
    }
  }
  candidates.sort((a, b) => Number(b.open) - Number(a.open) || b.mtimeMs - a.mtimeMs);
  return candidates[0]?.spec ?? null;
}
