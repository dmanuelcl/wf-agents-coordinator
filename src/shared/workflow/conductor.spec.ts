import { describe, expect, it } from "vitest";
import { decideConductor, INITIAL_CONDUCTOR_STATE } from "./conductor";
import type { ConductorState } from "./conductor";
import type { AutoPilotConfig } from "./auto-pilot-config";
import type { ParsedCheckpoint, WorkflowNext, WorkflowRole, WorkflowStatus } from "./workflow-types";

const CONFIG: AutoPilotConfig = { reloopLimit: 3, settleDelayMs: 4000 };

function checkpoint(params: {
  role?: WorkflowRole | "unknown";
  command?: string | null;
  tier?: string | null;
  task?: string | null;
  status?: WorkflowStatus;
  hasNext?: boolean;
}): ParsedCheckpoint {
  const next: WorkflowNext | null =
    params.hasNext === false
      ? null
      : {
          role: params.role ?? "implementer",
          command: params.command === undefined ? "wf implement docs/x-checkpoint.md" : params.command,
          cwd: ".worktrees/x",
          tier: params.tier ?? null,
          task: params.task ?? null,
          rawMarkdown: "",
        };
  return {
    checkpointPath: "docs/x-checkpoint.md",
    frontmatter: {},
    feature: null,
    slug: "x",
    kind: "feature",
    branch: null,
    worktree: null,
    status: params.status ?? "IN_PROGRESS",
    activeRole: "none",
    next,
    ledgerRows: [],
    latestLogMarkdown: null,
    warnings: [],
  };
}

describe("decideConductor — guardrails", () => {
  it("pauses on status DONE", () => {
    const { action } = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ status: "DONE" }),
      config: CONFIG,
    });
    expect(action.kind).toBe("pause");
  });

  it("pauses on status BLOCKED", () => {
    const { action } = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ status: "BLOCKED" }),
      config: CONFIG,
    });
    expect(action.kind).toBe("pause");
  });

  it("pauses when NEXT is absent", () => {
    const { action } = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ hasNext: false }),
      config: CONFIG,
    });
    expect(action.kind).toBe("pause");
  });

  it("pauses when role is unknown or command missing", () => {
    expect(
      decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ role: "unknown" }), config: CONFIG })
        .action.kind,
    ).toBe("pause");
    expect(
      decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ command: null }), config: CONFIG })
        .action.kind,
    ).toBe("pause");
  });
});

describe("decideConductor — forward progress", () => {
  it("sends the implementer command on a fresh NEXT and records lastActedKey", () => {
    const { action, next } = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    });
    expect(action).toMatchObject({ kind: "send", role: "implementer", command: "wf implement docs/x-checkpoint.md" });
    expect(next.lastActedKey).not.toBeNull();
  });

  it("is idempotent: the same NEXT twice in a row is a noop", () => {
    const cp = checkpoint({ role: "implementer", task: "P1" });
    const first = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: cp, config: CONFIG });
    const second = decideConductor({ prev: first.next, checkpoint: cp, config: CONFIG });
    expect(second.action.kind).toBe("noop");
  });

  it("runs both tiers: implement P1 then implement P2 (different task) both send", () => {
    const p1 = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ role: "implementer", task: "P1" }),
      config: CONFIG,
    });
    const p2 = decideConductor({
      prev: p1.next,
      checkpoint: checkpoint({ role: "implementer", task: "P2" }),
      config: CONFIG,
    });
    expect(p1.action.kind).toBe("send");
    expect(p2.action.kind).toBe("send");
  });

  it("re-runs review after a fix: review X → implement X → review X, the final review sends (not swallowed)", () => {
    const rev1 = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    });
    const impl = decideConductor({
      prev: rev1.next,
      checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    });
    const rev2 = decideConductor({
      prev: impl.next,
      checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    });
    expect(rev1.action.kind).toBe("send");
    expect(impl.action.kind).toBe("send"); // first bounce, under cap
    expect(rev2.action.kind).toBe("send");
  });
});

describe("decideConductor — re-loop cap", () => {
  function afterFirstReview(): ConductorState {
    return decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    }).next;
  }

  it("counts a reviewer→implementer bounce against the cap and pauses at the limit", () => {
    let state = afterFirstReview();
    for (let i = 0; i < 3; i++) {
      const impl = decideConductor({
        prev: state,
        checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }),
        config: CONFIG,
      });
      expect(impl.action.kind).toBe("send");
      state = impl.next;
      const rev = decideConductor({
        prev: state,
        checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }),
        config: CONFIG,
      });
      state = rev.next;
    }
    const fourth = decideConductor({
      prev: state,
      checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    });
    expect(fourth.action.kind).toBe("pause");
  });

  it("keeps re-loop counts independent per task", () => {
    let state = afterFirstReview();
    for (let i = 0; i < 3; i++) {
      state = decideConductor({
        prev: state,
        checkpoint: checkpoint({ role: "implementer", task: "P1" }),
        config: CONFIG,
      }).next;
      state = decideConductor({
        prev: state,
        checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }),
        config: CONFIG,
      }).next;
    }
    state = decideConductor({
      prev: state,
      checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P2" }),
      config: CONFIG,
    }).next;
    const p2Impl = decideConductor({
      prev: state,
      checkpoint: checkpoint({ role: "implementer", task: "P2" }),
      config: CONFIG,
    });
    expect(p2Impl.action.kind).toBe("send");
  });
});
