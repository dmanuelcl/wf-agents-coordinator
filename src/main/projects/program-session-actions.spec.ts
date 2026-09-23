import { describe, expect, it, vi } from "vitest";
import type { ProgramChildView, ProgramVerdict } from "../../shared/workflow/program-verdict";
import type { WorkSession } from "../../shared/workflow/work-session";
import { createProgramSessionActions } from "./program-session-actions";

const SPEC = "docs/workflow/specs/p.md";
const CP2 = "docs/workflow/checkpoints/x-2-checkpoint.md";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "s1",
    projectId: "p",
    name: "S",
    kind: "feature",
    slug: "s",
    branch: "feature/s",
    baseBranch: null,
    pr: null,
    worktreePath: "/w",
    checkpointPath: "docs/workflow/checkpoints/padre-checkpoint.md",
    setupDone: true,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

function child(overrides: Partial<ProgramChildView>): ProgramChildView {
  return { index: 2, name: "Dos", spec: null, checkpoint: null, dependsOn: [], state: "PENDING", linked: null, merge: null, ...overrides };
}

function verdict(overrides: Partial<ProgramVerdict>): ProgramVerdict {
  return {
    specPath: SPEC,
    title: "P",
    verdict: "READY",
    next: child({}),
    children: [child({})],
    reasons: [],
    hints: [],
    base: "origin/develop",
    fetchNote: null,
    checkedAtEpochMs: 0,
    ...overrides,
  };
}

function harness(status: ProgramVerdict | null) {
  const current = session();
  const calls: string[] = [];
  const deps = {
    getSession: vi.fn(async () => current),
    refreshStatus: vi.fn(async () => status),
    updateSessionProgram: vi.fn(
      async (params: { sessionId: string; checkpointPath: string | null; program: string; initialPrompt: string | null }): Promise<WorkSession> => {
        calls.push("update");
        return {
          ...current,
          checkpointPath: params.checkpointPath,
          program: params.program,
          ...(params.initialPrompt ? { initialPrompt: params.initialPrompt } : {}),
        };
      },
    ),
    rewatchCheckpoint: vi.fn(async () => {
      calls.push("rewatch");
    }),
    unwatchCheckpoint: vi.fn(async () => {
      calls.push("unwatch");
    }),
    resetAutopilot: vi.fn(async () => {
      calls.push("reset");
    }),
    beginFreshTurn: vi.fn(async () => {
      calls.push("fresh");
    }),
    announceCheckpoint: vi.fn(async () => {
      calls.push("announce");
    }),
    broadcastSession: vi.fn(() => {
      calls.push("broadcast");
    }),
  };
  return { actions: createProgramSessionActions(deps), deps, calls };
}

describe("startChild", () => {
  it("re-checks with a forced fetch, then unbinds, re-arms the filtered watch and starts the Architect fresh", async () => {
    const { actions, deps, calls } = harness(verdict({}));
    const updated = await actions.startChild("s1");
    expect(deps.refreshStatus).toHaveBeenCalledWith("s1", true);
    expect(deps.updateSessionProgram).toHaveBeenCalledWith({
      sessionId: "s1",
      checkpointPath: null,
      program: SPEC,
      initialPrompt: `wf next ${SPEC}`,
    });
    expect(deps.beginFreshTurn).toHaveBeenCalledWith("s1", "architect", `wf next ${SPEC}`);
    expect(calls).toEqual(["update", "rewatch", "reset", "broadcast", "fresh"]);
    expect(updated.checkpointPath).toBeNull();
  });

  it("refuses anything but READY, listing the reasons, and changes nothing", async () => {
    const { actions, deps } = harness(
      verdict({ verdict: "BLOCKED", next: null, reasons: ["hijo 1: su commit de cierre abc no está en origin/develop"] }),
    );
    await expect(actions.startChild("s1")).rejects.toThrow(/hijo 1: su commit de cierre abc/);
    expect(deps.updateSessionProgram).not.toHaveBeenCalled();
    expect(deps.beginFreshTurn).not.toHaveBeenCalled();
  });

  it("refuses a session outside any program", async () => {
    const { actions } = harness(null);
    await expect(actions.startChild("s1")).rejects.toThrow(/no pertenece a ningún programa/);
  });
});

describe("adoptChild", () => {
  it("binds the session to an IN_PROGRESS child that points back to the program, leaving the Architect alone", async () => {
    const open = child({ checkpoint: CP2, state: "IN_PROGRESS", linked: true });
    const { actions, deps, calls } = harness(verdict({ verdict: "BLOCKED", next: null, children: [open] }));
    await actions.adoptChild("s1", 2);
    expect(deps.updateSessionProgram).toHaveBeenCalledWith({ sessionId: "s1", checkpointPath: CP2, program: SPEC, initialPrompt: null });
    expect(deps.announceCheckpoint).toHaveBeenCalledWith("s1", CP2);
    expect(deps.beginFreshTurn).not.toHaveBeenCalled();
    expect(calls).toEqual(["unwatch", "update", "reset", "broadcast", "announce"]);
  });

  it("refuses a child that is DONE, has no checkpoint, or does not point back", async () => {
    for (const bad of [
      child({ checkpoint: CP2, state: "DONE", linked: true }),
      child({}),
      child({ checkpoint: CP2, state: "IN_PROGRESS", linked: false }),
    ]) {
      const { actions, deps } = harness(verdict({ children: [bad] }));
      await expect(actions.adoptChild("s1", 2)).rejects.toThrow(/no se puede seguir/);
      expect(deps.updateSessionProgram).not.toHaveBeenCalled();
    }
  });
});
