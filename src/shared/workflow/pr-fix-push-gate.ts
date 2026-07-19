import type { ParsedCheckpoint } from "./workflow-types";

export interface PrFixPushGate {
  allowed: boolean;
  reason: string | null;
}

function ledgerRecordsReviewerPass(checkpoint: ParsedCheckpoint): boolean {
  return checkpoint.ledgerRows.some((row) => {
    const value = row.prReview.trim();
    return value.includes("✅") || /^(?:PASS|PASSED)$/i.test(value);
  });
}

/** Canonical safety gate shared by the renderer and the push IPC handler. */
export function getPrFixPushGate(checkpoint: ParsedCheckpoint | null): PrFixPushGate {
  if (!checkpoint) {
    return { allowed: false, reason: "Waiting for the implementer checkpoint." };
  }
  if (checkpoint.findingCounts.open > 0) {
    const count = checkpoint.findingCounts.open;
    return {
      allowed: false,
      reason: `${count} open finding${count === 1 ? "" : "s"} must be resolved before push.`,
    };
  }
  if (checkpoint.status !== "DONE") {
    return { allowed: false, reason: "Waiting for the reviewer to finish the workflow." };
  }
  if (!ledgerRecordsReviewerPass(checkpoint)) {
    return { allowed: false, reason: "The checkpoint does not record a passing PR_REVIEW." };
  }
  return { allowed: true, reason: null };
}
