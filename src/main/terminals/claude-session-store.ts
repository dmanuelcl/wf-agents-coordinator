import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether Claude Code has a persisted conversation for `sessionUuid`.
 *
 * Claude stores each conversation as `~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`.
 * Session ids are globally unique, so we scan for `<uuid>.jsonl` across every
 * project dir instead of reconstructing Claude's cwd-escaping (which is brittle
 * to replicate). A tab that was opened but whose pre-typed command was never
 * sent leaves no file — `claude --resume <uuid>` would then fail with
 * "No conversation found", so callers use this to fall back to a fresh launch.
 */
export async function claudeConversationExists(
  sessionUuid: string,
  projectsDir: string = join(homedir(), ".claude", "projects"),
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(projectsDir, entry.name, `${sessionUuid}.jsonl`));
      return true;
    } catch {
      // Not in this project dir — keep looking.
    }
  }
  return false;
}
