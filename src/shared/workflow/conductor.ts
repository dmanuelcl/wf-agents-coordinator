import type { AutoPilotConfig } from "./auto-pilot-config";
import type { SessionAgentRole } from "./session-role-launch";
import type { ParsedCheckpoint } from "./workflow-types";

export type ConductorAction =
  | { kind: "send"; role: SessionAgentRole; lane: string; command: string; reason: string }
  | { kind: "pause"; role: SessionAgentRole | null; command: string | null; reason: string }
  | { kind: "noop"; reason: string };

export interface ConductorState {
  /** The NEXT-content key we last ACTED on (send). Idempotency guard. */
  lastActedKey: string | null;
  /** Per-task count of backward fix-loops auto-run so far. */
  reloopCount: Record<string, number>;
  /** Task keys for which a reviewer step was already acted on (to detect a bounce-back). */
  reviewedTasks: string[];
}

export const INITIAL_CONDUCTOR_STATE: ConductorState = {
  lastActedKey: null,
  reloopCount: {},
  reviewedTasks: [],
};

const AGENT_ROLES = new Set<string>(["architect", "implementer", "reviewer"]);

function isAgentRole(role: string): role is SessionAgentRole {
  return AGENT_ROLES.has(role);
}

function legacyLaneOf(checkpoint: ParsedCheckpoint, role: SessionAgentRole): string | null {
  if (role === "architect") return "architect";
  if (checkpoint.kind === "fix") return `fix/${role}`;
  if (/FEATURE_REVIEW/i.test(checkpoint.next?.task ?? "")) return `feature-review/${role}`;
  const planMatch = (checkpoint.next?.task ?? "").match(/\bPlan-(\d+)\b/i);
  return planMatch ? `plan-${planMatch[1]}/${role}` : null;
}

function scopeKeyOfLane(lane: string): string {
  return lane.replace(/\/(?:implementer|reviewer)$/, "");
}

/** `wf followups` is a manual-only post-workflow step (run via its own button). */
function isFollowupsCommand(command: string | null): boolean {
  return command != null && /^wf\s+followups\b/.test(command);
}

/**
 * Decide what the auto-pilot conductor should do given the freshly-parsed
 * checkpoint and the prior state. Pure and deterministic — no I/O, no timers.
 * See docs/specs/2026-07-10-auto-pilot-conductor-design.md for the decision table.
 */
export function decideConductor(params: {
  prev: ConductorState;
  checkpoint: ParsedCheckpoint;
  config: AutoPilotConfig;
}): { action: ConductorAction; next: ConductorState } {
  const { prev, checkpoint, config } = params;

  // 1–2. Terminal / blocked states never auto-run.
  if (checkpoint.status === "DONE") {
    return { action: { kind: "pause", role: null, command: null, reason: "workflow DONE" }, next: prev };
  }
  if (checkpoint.status === "BLOCKED") {
    return { action: { kind: "pause", role: null, command: null, reason: "BLOCKED" }, next: prev };
  }

  const next = checkpoint.next;

  // followups is a manual-only step (triggered by its button), never auto-run.
  if (isFollowupsCommand(next?.command ?? null)) {
    return { action: { kind: "pause", role: null, command: null, reason: "followups is manual" }, next: prev };
  }

  // 3. Unactionable NEXT.
  if (!next || next.role === "unknown" || !isAgentRole(next.role) || !next.command) {
    return { action: { kind: "pause", role: null, command: null, reason: "NEXT not actionable" }, next: prev };
  }

  const role = next.role;
  const command = next.command;
  const lane = next.sessionLane ?? legacyLaneOf(checkpoint, role);
  if (!lane) {
    return {
      action: { kind: "pause", role, command, reason: "NEXT session lane is missing or cannot be derived" },
      next: prev,
    };
  }
  const tKey = scopeKeyOfLane(lane);
  const nextKey = `${role}|${lane}|${command}|${next.tier ?? ""}|${next.task ?? ""}`;

  // 4. Idempotency: same step we just acted on → noop.
  if (nextKey === prev.lastActedKey) {
    return { action: { kind: "noop", reason: "already handled" }, next: prev };
  }

  // 5. New transition. Detect a same-task bounce back to the implementer.
  const isReloop = role === "implementer" && prev.reviewedTasks.includes(tKey);
  if (isReloop && (prev.reloopCount[tKey] ?? 0) >= config.reloopLimit) {
    return {
      action: { kind: "pause", role, command, reason: `re-loop limit (${config.reloopLimit}) reached for task` },
      next: prev,
    };
  }

  const reloopCount = isReloop
    ? { ...prev.reloopCount, [tKey]: (prev.reloopCount[tKey] ?? 0) + 1 }
    : prev.reloopCount;
  const reviewedTasks =
    role === "reviewer" && !prev.reviewedTasks.includes(tKey) ? [...prev.reviewedTasks, tKey] : prev.reviewedTasks;

  return {
    action: { kind: "send", role, lane, command, reason: isReloop ? "re-loop fix" : "advance" },
    next: { lastActedKey: nextKey, reloopCount, reviewedTasks },
  };
}
