import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Add a pattern to a worktree's LOCAL git exclude (`<gitdir>/info/exclude`), so
 * a generated file (e.g. `.agent-review.md`) stays out of `git status`/diffs
 * WITHOUT modifying the tracked `.gitignore` on the branch. For a linked
 * worktree, `<worktree>/.git` is a file pointing at the real gitdir; resolve it.
 * Idempotent and best-effort at the call site.
 */
export async function addWorktreeExclude(worktreePath: string, pattern: string): Promise<void> {
  const gitPath = join(worktreePath, ".git");
  const info = await stat(gitPath);

  let gitDir: string;
  if (info.isDirectory()) {
    gitDir = gitPath;
  } else {
    const content = await readFile(gitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error(`Unrecognized .git file at ${gitPath}`);
    const raw = (match[1] ?? "").trim();
    gitDir = isAbsolute(raw) ? raw : resolve(worktreePath, raw);
  }

  const excludePath = join(gitDir, "info", "exclude");
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    // no exclude file yet — we'll create it
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === pattern)) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
  await writeFile(excludePath, `${prefix}${pattern}\n`, "utf8");
}
