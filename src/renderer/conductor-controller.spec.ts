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
    next: {
      role,
      command: `wf ${verb} docs/x-checkpoint.md`,
      cwd: ".worktrees/x",
      tier: null,
      task,
      sessionLane: role === "architect" ? "architect" : `plan-1/${role}`,
      rawMarkdown: "",
    },
    ledgerRows: [],
    correctionPlan: null,
    findings: [],
    findingCounts: { open: 0, closed: 0, total: 0 },
    followUps: [],
    followUpCounts: { total: 0, open: 0, keep: 0, promoted: 0, done: 0, dropped: 0 },
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
      onAction: async (action) => {
        actions.push(action);
      },
    });
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(10000);
    expect(actions).toEqual([]);
  });

  it("acts after the settle delay once enabled", async () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: async (action) => {
        actions.push(action);
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(3999);
    expect(actions).toEqual([]);
    vi.advanceTimersByTime(1);
    await vi.runAllTicks();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "send", role: "implementer" });
  });

  it("debounces rapid changes into a single action (quiescence)", async () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: async (action) => {
        actions.push(action);
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(2000);
    c.notifyCheckpoint(cp("implementer", "P1")); // resets the timer
    vi.advanceTimersByTime(2000);
    expect(actions).toEqual([]); // window restarted, not elapsed
    vi.advanceTimersByTime(2000);
    await vi.runAllTicks();
    expect(actions).toHaveLength(1);
  });

  it("catches up on enable when a checkpoint is already stored", async () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: async (action) => {
        actions.push(action);
      },
    });
    c.notifyCheckpoint(cp("implementer", "P1")); // while disabled
    c.setEnabled(true);
    vi.advanceTimersByTime(4000);
    await vi.runAllTicks();
    expect(actions).toHaveLength(1);
  });

  it("does not fire after dispose", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: async (action) => {
        actions.push(action);
      },
    });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    c.dispose();
    vi.advanceTimersByTime(10000);
    expect(actions).toEqual([]);
  });

  it("does not consume a NEXT key until dispatch resolves", async () => {
    const pending: { release?: () => void } = {};
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => CONFIG,
      onAction: (action) =>
        new Promise<void>((resolve) => {
          actions.push(action);
          pending.release = resolve;
        }),
    });

    c.setEnabled(true);
    c.notifyCheckpoint(cp("architect", "P1"));
    vi.advanceTimersByTime(4000);
    c.notifyCheckpoint(cp("architect", "P1"));
    vi.advanceTimersByTime(4000);
    expect(actions).toHaveLength(1);

    if (!pending.release) throw new Error("expected pending dispatch");
    pending.release();
    await vi.runAllTicks();
    c.notifyCheckpoint(cp("architect", "P1"));
    vi.advanceTimersByTime(4000);
    expect(actions).toHaveLength(1);
  });

  it("resets the re-loop limit after a manual off/on cycle", async () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({
      getConfig: () => ({ ...CONFIG, reloopLimit: 1 }),
      onAction: async (action) => {
        actions.push(action);
      },
    });
    const actOn = async (checkpoint: ParsedCheckpoint): Promise<void> => {
      c.notifyCheckpoint(checkpoint);
      vi.advanceTimersByTime(CONFIG.settleDelayMs);
      await vi.runAllTicks();
    };

    c.setEnabled(true);
    await actOn(cp("reviewer", "P1"));
    await actOn(cp("implementer", "P1"));
    await actOn(cp("reviewer", "P1"));
    await actOn(cp("implementer", "P1"));
    expect(actions.at(-1)).toMatchObject({ kind: "pause", reason: "re-loop limit (1) reached for task" });

    c.setEnabled(false);
    c.setEnabled(true);
    vi.advanceTimersByTime(CONFIG.settleDelayMs);
    await vi.runAllTicks();

    expect(actions.at(-1)).toMatchObject({ kind: "send", role: "implementer" });
  });
});
