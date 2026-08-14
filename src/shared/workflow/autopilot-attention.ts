/**
 * Why a session stopped advancing on its own and wants a human.
 *
 * - `paused`      the conductor will not act: BLOCKED, an unactionable NEXT, a
 *                 missing lane, the re-loop cap, or a manual-only step.
 * - `done`        the workflow finished. Not a problem, but it is the other
 *                 moment the auto-pilot stops and the turn passes to a person.
 * - `setup-failed` the worktree needs repairing before any agent can run.
 * - `stalled`     nothing is wrong on paper, but the agent it is waiting on has
 *                 gone quiet — hung, out of quota, or waiting on an answer.
 */
export type AutoPilotAttentionKind = "paused" | "done" | "setup-failed" | "stalled";

export interface AutoPilotAttention {
  kind: AutoPilotAttentionKind;
  reason: string;
  sinceEpochMs: number;
}

/**
 * Stable identity of one call for help. The runner republishes a session's
 * runtime for many reasons, so alerting keys on this rather than on the object.
 */
export function attentionKey(sessionId: string, attention: AutoPilotAttention): string {
  return `${sessionId}|${attention.kind}|${attention.reason}|${attention.sinceEpochMs}`;
}

/** One line for a notification body. */
export function describeAttention(attention: AutoPilotAttention): string {
  switch (attention.kind) {
    case "done":
      return "Workflow finished";
    case "setup-failed":
      return attention.reason;
    case "stalled":
      return `Agent has gone quiet · ${attention.reason}`;
    default:
      return `Auto-pilot paused · ${attention.reason}`;
  }
}
