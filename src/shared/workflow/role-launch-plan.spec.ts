import { describe, expect, it } from "vitest";
import { buildRoleLaunchPlan } from "./role-launch-plan";
import type { ParsedCheckpoint, WorkflowNext } from "./workflow-types";

function makeNext(overrides: Partial<WorkflowNext> = {}): WorkflowNext {
  return {
    role: "implementer",
    command: "wf implement docs/workflow/checkpoints/example-checkpoint.md",
    cwd: ".worktrees/example",
    tier: null,
    task: null,
    rawMarkdown: "",
    ...overrides,
  };
}

function makeCheckpoint(
  overrides: Partial<Omit<ParsedCheckpoint, "correctionPlan" | "findings" | "findingCounts">> = {},
): ParsedCheckpoint {
  return {
    checkpointPath: ".worktrees/example/docs/workflow/checkpoints/example-checkpoint.md",
    frontmatter: {},
    feature: "Example feature",
    slug: "example",
    kind: "feature",
    branch: "feature/example",
    worktree: ".worktrees/example",
    status: "IN_PROGRESS",
    activeRole: "none",
    next: makeNext(),
    ledgerRows: [],
    ...overrides,
    correctionPlan: null,
    findings: [],
    findingCounts: { open: 0, closed: 0, total: 0 },
    latestLogMarkdown: overrides.latestLogMarkdown ?? null,
    warnings: overrides.warnings ?? [],
  };
}

const PROJECT_ROOT = "/repo";

// The scanner reports checkpointPath relative to the PROJECT root (e.g.
// ".worktrees/example/docs/workflow/checkpoints/example-checkpoint.md"), but
// wf commands run with cwd set to the resolved worktree, so they need the
// path relative to THAT root (e.g. "docs/workflow/checkpoints/example-checkpoint.md").
const CHECKPOINT_RELATIVE_PATH = ".worktrees/example/docs/workflow/checkpoints/example-checkpoint.md";
const WORKTREE_RELATIVE_CHECKPOINT_PATH = "docs/workflow/checkpoints/example-checkpoint.md";

describe("buildRoleLaunchPlan", () => {
  it("builds a shell plan with a null command", () => {
    const plan = buildRoleLaunchPlan({
      projectRoot: PROJECT_ROOT,
      checkpointRelativePath: CHECKPOINT_RELATIVE_PATH,
      checkpoint: makeCheckpoint(),
      requestedRole: "shell",
    });

    expect(plan.command).toBeNull();
    expect(plan.cwd).toBe("/repo/.worktrees/example");
    expect(plan.outOfTurn).toBe(false);
  });

  it("builds a status command relative to the resolved worktree cwd, not the project root", () => {
    const plan = buildRoleLaunchPlan({
      projectRoot: PROJECT_ROOT,
      checkpointRelativePath: CHECKPOINT_RELATIVE_PATH,
      checkpoint: makeCheckpoint(),
      requestedRole: "status",
    });

    expect(plan.command).toBe(`wf status ${WORKTREE_RELATIVE_CHECKPOINT_PATH}`);
  });

  it("builds a status command unchanged when the checkpoint lives at the project root", () => {
    const plan = buildRoleLaunchPlan({
      projectRoot: PROJECT_ROOT,
      checkpointRelativePath: WORKTREE_RELATIVE_CHECKPOINT_PATH,
      checkpoint: makeCheckpoint({
        worktree: null,
        next: makeNext({ cwd: "." }),
      }),
      requestedRole: "status",
    });

    expect(plan.command).toBe(`wf status ${WORKTREE_RELATIVE_CHECKPOINT_PATH}`);
  });

  it("uses the NEXT command when the requested role matches", () => {
    const plan = buildRoleLaunchPlan({
      projectRoot: PROJECT_ROOT,
      checkpointRelativePath: CHECKPOINT_RELATIVE_PATH,
      checkpoint: makeCheckpoint({ next: makeNext({ role: "implementer", command: "wf implement custom.md" }) }),
      requestedRole: "implementer",
    });

    expect(plan.command).toBe("wf implement custom.md");
    expect(plan.outOfTurn).toBe(false);
  });

  it("still builds a command out of turn, relative to the worktree cwd, but flags it", () => {
    const plan = buildRoleLaunchPlan({
      projectRoot: PROJECT_ROOT,
      checkpointRelativePath: CHECKPOINT_RELATIVE_PATH,
      checkpoint: makeCheckpoint({ next: makeNext({ role: "implementer" }) }),
      requestedRole: "reviewer",
    });

    expect(plan.outOfTurn).toBe(true);
    expect(plan.command).toBe(`wf review ${WORKTREE_RELATIVE_CHECKPOINT_PATH}`);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("infers the command from the role command map, relative to the worktree cwd, when NEXT command is missing", () => {
    const plan = buildRoleLaunchPlan({
      projectRoot: PROJECT_ROOT,
      checkpointRelativePath: CHECKPOINT_RELATIVE_PATH,
      checkpoint: makeCheckpoint({ next: makeNext({ role: "architect", command: null }) }),
      requestedRole: "architect",
    });

    expect(plan.command).toBe(`wf verify ${WORKTREE_RELATIVE_CHECKPOINT_PATH}`);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});
