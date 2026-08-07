import type { RefCheckpointSummary } from "../../shared/ipc/contract";

/**
 * What to call a checkpoint in a picker. A checkpoint whose markdown carried
 * neither a feature title nor a slug still has to be nameable, so the path is
 * the last resort rather than an empty row.
 */
export function checkpointLabel(checkpoint: RefCheckpointSummary): string {
  return checkpoint.feature ?? checkpoint.slug ?? checkpoint.path;
}

/**
 * Everything a query may reasonably be typed against. The path is included so
 * two checkpoints sharing a title can still be told apart by typing a folder.
 */
export function checkpointSearchText(checkpoint: RefCheckpointSummary): string {
  return [checkpoint.feature, checkpoint.slug, checkpoint.path, checkpoint.status]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

/**
 * Badge styling for a workflow status. Typed on `string` rather than
 * `WorkflowStatus` because a checkpoint read from a ref carries whatever its
 * markdown said (`RefCheckpointSummary.status`).
 */
export function statusBadgeClass(status: string): string {
  if (status === "BLOCKED") return "badge badge-attention";
  if (status === "DONE") return "badge badge-done";
  return "badge";
}
