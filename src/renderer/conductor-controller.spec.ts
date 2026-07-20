import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConductorController } from "./conductor-controller";
import type { ConductorAction } from "../shared/workflow/conductor";
import type { AutoPilotConfig } from "../shared/workflow/auto-pilot-config";
import type { ParsedCheckpoint, WorkflowRole } from "../shared/workflow/workflow-types";

const CONFIG: AutoPilotConfig = { reloopLimit: 3, settleDelayMs: 4000 };

function cp(role: WorkflowRole, task: string): ParsedCheckpoint {
  const verb = role === "implementer" ? "implement" : role === "reviewer" ? "review" : "verify";
  return {
    checkpointPath: "docs/x-checkpoint.md",
    frontmatter: {},
    feature: null,
    slug: "x",
    kind: "feature",
    branch: null,
    worktree: null,
    status: "IN_PROGRESS",
    activeRole: "none",
    next: { role, command: `wf ${verb} docs/x-checkpoint.md`, cwd: ".worktrees/x", tier: null, task, rawMarkdown: "" },
    ledgerRows: [],
    correctionPlan: null,
    findings: [],
    findingCounts: { open: 0, closed: 0, total: 0 },
    latestLogMarkdown: null,
    warnings: [],
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createConductorController", () => {
  it("does nothing while disabled", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return true;
      },
    });
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(10000);
    expect(actions).toEqual([]);
  });

  it("acts after the settle delay once enabled", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return true;
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(3999);
    expect(actions).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "send", role: "implementer" });
  });

  it("debounces rapid changes into a single action (quiescence)", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return true;
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(2000);
    c.notifyCheckpoint(cp("implementer", "P1")); // resets the timer
    vi.advanceTimersByTime(2000);
    expect(actions).toEqual([]); // window restarted, not elapsed
    vi.advanceTimersByTime(2000);
    expect(actions).toHaveLength(1);
  });

  it("catches up on enable when a checkpoint is already stored", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return true;
      },
    });
    c.notifyCheckpoint(cp("implementer", "P1")); // while disabled
    c.setEnabled(true);
    vi.advanceTimersByTime(4000);
    expect(actions).toHaveLength(1);
  });

  it("does not commit a step whose delivery failed, and retries until it lands", () => {
    const actions: ConductorAction[] = [];
    let deliverable = false;
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return deliverable;
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(4000); // first attempt — the agent tab isn't live yet
    expect(actions).toHaveLength(1);

    deliverable = true;
    vi.advanceTimersByTime(700); // retry — now it lands
    expect(actions).toHaveLength(2);

    // Committed now: an identical re-save of the same NEXT is a no-op (not re-sent).
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(4000);
    expect(actions).toHaveLength(2);
  });

  it("stops retrying a persistently failing delivery instead of spinning forever", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return false; // the target never becomes live
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(4000 + 700 * 10); // drain every retry
    expect(actions).toHaveLength(4); // 1 attempt + 3 bounded retries
  });

  it("does not fire after dispose", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (a) => {
        actions.push(a);
        return true;
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    c.dispose();
    vi.advanceTimersByTime(10000);
    expect(actions).toEqual([]);
  });
});
