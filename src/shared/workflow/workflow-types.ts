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

export type FindingStatus = "PENDING" | "RESOLVED" | "OBSOLETE";

export interface WorkflowFinding {
  plan: string | null;
  id: string;
  status: FindingStatus;
  summary: string;
}

export interface FindingCounts {
  open: number;
  closed: number;
  total: number;
}

export type FollowUpState = "OPEN" | "KEEP" | "PROMOTED" | "DONE" | "DROPPED" | "UNKNOWN";

export interface WorkflowFollowUp {
  id: string;
  title: string;
  origin: string;
  state: FollowUpState;
  promotedTo: string | null;
  detail: string | null;
  rawCells: string[];
}

export interface FollowUpCounts {
  total: number;
  open: number;
  keep: number;
  promoted: number;
  done: number;
  dropped: number;
}

export interface CorrectionPlan {
  title: string;
  markdown: string;
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
  correctionPlan: CorrectionPlan | null;
  findings: WorkflowFinding[];
  findingCounts: FindingCounts;
  followUps: WorkflowFollowUp[];
  followUpCounts: FollowUpCounts;
  latestLogMarkdown: string | null;
  warnings: string[];
}
