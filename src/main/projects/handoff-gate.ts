import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";

export interface PendingHandoff {
  turn: number;
  role: SessionAgentRole;
  sessionLane: string;
  /** When the runner first saw this turn. The settle delay runs from here. */
  seenAtEpochMs: number;
}

export type HandoffGateDecision =
  | { kind: "run"; viaHandoff: boolean }
  | { kind: "wait"; reason: string; retryInMs: number };

/**
 * Whether the auto-pilot may launch the step the conductor decided on.
 *
 * The signal is the hand-off `wf done` writes as an agent's last act, not a
 * delay measured from the checkpoint write: `▶ NEXT` is bookkeeping an agent
 * edits mid-turn, so a timer started there cannot tell a finished turn from one
 * that is still going. The project's settle delay keeps its meaning and simply
 * runs from the hand-off instead.
 *
 * The hand-off is matched against the NEXT *on disk*. What this requires of the
 * checkpoint is that it be current, never that it be committed.
 */
export function decideHandoffGate(params: {
  /** False only while a session has never produced a hand-off file. */
  handoffModeActive: boolean;
  pending: PendingHandoff | null;
  step: { role: SessionAgentRole; lane: string };
  settleDelayMs: number;
  nowEpochMs: number;
  /** How soon to look again while waiting on something other than the delay. */
  retryMs: number;
}): HandoffGateDecision {
  const { handoffModeActive, pending, step, settleDelayMs, nowEpochMs, retryMs } = params;

  // A workflow that does not emit the signal keeps the behavior it had before
  // the gate existed; the caller's own scheduling has already applied the delay.
  if (!handoffModeActive) return { kind: "run", viaHandoff: false };

  if (!pending) {
    return { kind: "wait", reason: "waiting · the current agent has not handed off yet", retryInMs: retryMs };
  }

  if (pending.role !== step.role || pending.sessionLane !== step.lane) {
    return {
      kind: "wait",
      reason: "waiting · hand-off does not match the checkpoint's NEXT yet",
      retryInMs: retryMs,
    };
  }

  // A timestamp ahead of `now` (clock jump) must not read as an elapsed delay,
  // nor stretch the wait beyond the delay the project actually configured.
  const settledFor = Math.min(Math.max(nowEpochMs - pending.seenAtEpochMs, 0), settleDelayMs);
  if (settledFor < settleDelayMs) {
    return { kind: "wait", reason: "hand-off received · settling", retryInMs: settleDelayMs - settledFor };
  }

  return { kind: "run", viaHandoff: true };
}
