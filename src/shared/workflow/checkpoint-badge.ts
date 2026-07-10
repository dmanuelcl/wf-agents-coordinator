import type { WorkflowRole, WorkflowStatus } from "./workflow-types";

export type BadgeSeverity = "normal" | "attention" | "done";

export interface CheckpointBadge {
  statusLabel: WorkflowStatus;
  activeRoleLabel: WorkflowRole | null;
  severity: BadgeSeverity;
}

function deriveSeverity(status: WorkflowStatus): BadgeSeverity {
  if (status === "BLOCKED") return "attention";
  if (status === "DONE") return "done";
  return "normal";
}

export function deriveCheckpointBadge(checkpoint: {
  status: WorkflowStatus;
  activeRole: WorkflowRole | "none" | "unknown";
}): CheckpointBadge {
  const activeRoleLabel =
    checkpoint.activeRole === "none" || checkpoint.activeRole === "unknown" ? null : checkpoint.activeRole;

  return {
    statusLabel: checkpoint.status,
    activeRoleLabel,
    severity: deriveSeverity(checkpoint.status),
  };
}
