import { isSessionAgentRole } from "./session-role-launch";
import type { SessionAgentRole } from "./session-role-launch";

/**
 * `wf done` writes this as an agent's last act of a turn. It is the auto-pilot's
 * end-of-turn signal: a separate, single-purpose, final act, which is the one
 * property `▶ NEXT` cannot have — NEXT is workflow bookkeeping an agent edits
 * while it still has work to do.
 *
 * It lives in its own directory because a watcher must be pointed at a leaf
 * directory, never at the worktree root, and the directory is excluded from git
 * so no hand-off ever costs a commit.
 */
export const SESSION_HANDOFF_DIR = ".wf";
export const SESSION_HANDOFF_FILENAME = "handoff.json";
/** Pattern for the worktree's local git exclude. */
export const SESSION_HANDOFF_EXCLUDE = `${SESSION_HANDOFF_DIR}/`;

export interface SessionHandoff {
  /** Monotonic per session. Two turns handing to the same lane differ by this. */
  turn: number;
  /** Worktree-relative, so a worktree holding several checkpoints is unambiguous. */
  checkpointPath: string | null;
  /** Identity of the step being handed to — never the command to run. */
  role: SessionAgentRole;
  sessionLane: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Null for anything unreadable — malformed JSON, a half-written file, an
 * unknown role. The gate treats null as "no hand-off yet" and holds, which is
 * the safe reading: acting on a guess is what puts two agents in one worktree.
 */
export function parseSessionHandoff(json: string): SessionHandoff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  const next = asRecord(record?.next);
  if (!record || !next) return null;

  const turn = record.turn;
  if (typeof turn !== "number" || !Number.isFinite(turn)) return null;

  const role = next.role;
  if (typeof role !== "string" || !isSessionAgentRole(role)) return null;

  const sessionLane = next.sessionLane;
  if (typeof sessionLane !== "string" || sessionLane.trim() === "") return null;

  const checkpoint = record.checkpoint;

  return {
    turn,
    checkpointPath: typeof checkpoint === "string" && checkpoint !== "" ? checkpoint : null,
    role,
    sessionLane,
  };
}
