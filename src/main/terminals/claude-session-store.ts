import { access, open, readdir, stat } from "node:fs/promises";
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

/**
 * Context tokens of the LAST assistant turn recorded in the session's transcript
 * (input + cache_read + cache_creation). This is the authoritative "how full is
 * the session we are about to RESUME" reading — measured on the target, at
 * launch time, unlike the hand-off's contextTokens which describe the publisher.
 * `null` for a missing transcript or one with no readable usage.
 */
export async function claudeSessionContextTokens(
  sessionUuid: string,
  projectsDir: string = join(homedir(), ".claude", "projects"),
): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(projectsDir, entry.name, `${sessionUuid}.jsonl`);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      continue;
    }
    try {
      const span = Math.min(size, 262_144);
      const handle = await open(path, "r");
      let tail: string;
      try {
        const buffer = Buffer.alloc(span);
        await handle.read(buffer, 0, span, size - span);
        tail = buffer.toString("utf8");
      } finally {
        await handle.close();
      }
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line || !line.includes('"assistant"')) continue;
        try {
          const record = JSON.parse(line) as { type?: unknown; message?: { usage?: Record<string, unknown> } };
          if (record.type !== "assistant") continue;
          const usage = record.message?.usage;
          if (!usage) continue;
          const total = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
            .map((key) => (typeof usage[key] === "number" && Number.isFinite(usage[key] as number) ? (usage[key] as number) : 0))
            .reduce((a, b) => a + b, 0);
          if (total > 0) return total;
        } catch {
          // Torn or foreign line — keep scanning upward.
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}
