export type WorkflowRole = "architect" | "implementer" | "reviewer";
export type WorkflowKind = "feature" | "fix" | "unknown";
export type WorkflowStatus = "IN_PROGRESS" | "BLOCKED" | "DONE" | "UNKNOWN";

export interface WorkflowNext {
  role: WorkflowRole | "unknown";
  command: string | null;
  cwd: string | null;
  tier: string | null;
  task: string | null;
  rawMarkdown: string;
}

export interface LedgerRow {
  index: string;
  plan: string;
  implement: string;
  archReview: string;
  prReview: string;
  state: string;
  rawCells: string[];
}

export interface ParsedCheckpoint {
  checkpointPath: string;
  frontmatter: Record<string, string>;
  feature: string | null;
  slug: string | null;
  kind: WorkflowKind;
  branch: string | null;
  worktree: string | null;
  status: WorkflowStatus;
  activeRole: WorkflowRole | "none" | "unknown";
  next: WorkflowNext | null;
  ledgerRows: LedgerRow[];
  latestLogMarkdown: string | null;
  warnings: string[];
}
