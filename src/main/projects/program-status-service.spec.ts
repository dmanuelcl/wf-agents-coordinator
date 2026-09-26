import { describe, expect, it, vi } from "vitest";
import { PROGRAM_IPC_CHANNELS } from "../../shared/ipc/contract";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import type { WorkSession } from "../../shared/workflow/work-session";
import { createProgramStatusService } from "./program-status-service";
import type { readProgramVerdict } from "./program-status";

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
    worktreePath: "/repo/.worktrees/s",
    checkpointPath: null,
    setupDone: true,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

const VERDICT = { specPath: "docs/workflow/specs/p.md", verdict: "READY" } as ProgramVerdict;

function harness(sessions: WorkSession[], worktreeProgram: string | null = null) {
  const findWorktreeProgram = vi.fn(async (_worktreePath: string, _branch: string) => worktreeProgram);
  const computeVerdict = vi.fn(async (_params: Parameters<typeof readProgramVerdict>[0]) => VERDICT);
  const refresh = vi.fn(async (_root: string, _base: string, _force: boolean): Promise<string | null> => null);
  const broadcast = vi.fn();
  const service = createProgramStatusService({
    getSession: async (id) => sessions.find((candidate) => candidate.id === id) ?? null,
    listSessions: async () => sessions,
    projectRootOf: async () => "/repo",
    readSessionCheckpoint: async () => null,
    refresher: { refresh },
    broadcast,
    computeVerdict,
    findWorktreeProgram,
    debounceMs: 0,
    intervalMs: 60_000,
  });
  return { service, computeVerdict, refresh, broadcast, findWorktreeProgram };
}

describe("createProgramStatusService", () => {
  it("a session outside any program has no status and costs no git work", async () => {
    const { service, computeVerdict, refresh, broadcast } = harness([session()]);
    expect(await service.get("s1")).toBeNull();
    expect(computeVerdict).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(PROGRAM_IPC_CHANNELS.statusChanged, { sessionId: "s1", status: null });
    service.close();
  });

  it("computes a program session from its worktree once, then serves the cache", async () => {
    const { service, computeVerdict, refresh } = harness([session({ program: "docs/workflow/specs/p.md" })]);
    expect(await service.get("s1")).toBe(VERDICT);
    expect(await service.get("s1")).toBe(VERDICT);
    expect(computeVerdict).toHaveBeenCalledTimes(1);
    expect(computeVerdict).toHaveBeenCalledWith({
      projectRoot: "/repo",
      specPath: "docs/workflow/specs/p.md",
      source: { kind: "worktree", worktreePath: "/repo/.worktrees/s" },
      fetchNote: null,
    });
    expect(refresh).toHaveBeenCalledWith("/repo", "origin/develop", false);
    service.close();
  });

  it("refresh recomputes and can force the fetch", async () => {
    const { service, refresh, computeVerdict } = harness([session({ program: "docs/workflow/specs/p.md" })]);
    await service.get("s1");
    await service.refresh("s1", { force: true });
    expect(computeVerdict).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith("/repo", "origin/develop", true);
    service.close();
  });

  it("a checkpoint change inside a session's worktree recomputes that session only", async () => {
    const inside = session({ id: "a", program: "p.md", worktreePath: "/repo/.worktrees/a" });
    const other = session({ id: "b", program: "p.md", worktreePath: "/repo/.worktrees/b" });
    const { service, computeVerdict } = harness([inside, other]);
    service.onCheckpointChanged("p", ".worktrees/a/docs/workflow/checkpoints/x-checkpoint.md");
    await vi.waitFor(() => expect(computeVerdict).toHaveBeenCalledTimes(1));
    expect(computeVerdict.mock.calls[0]?.[0]).toMatchObject({ source: { kind: "worktree", worktreePath: "/repo/.worktrees/a" } });
    service.close();
  });

  it("a session bound to the parent still belongs to the program whose child lives in its worktree", async () => {
    // corp-filing-form-mapping, 2026-09-23: the parent's NEXT moved on to `wf followups`, but child 1 lives here.
    const { service, computeVerdict, findWorktreeProgram } = harness(
      [session({ checkpointPath: "docs/workflow/checkpoints/padre-checkpoint.md" })],
      "docs/workflow/specs/p.md",
    );
    expect(await service.get("s1")).toBe(VERDICT);
    // Only children of THIS branch count: other programs' children arrive in every worktree through develop.
    expect(findWorktreeProgram).toHaveBeenCalledWith("/repo/.worktrees/s", "feature/s");
    expect(computeVerdict).toHaveBeenCalledWith(expect.objectContaining({ specPath: "docs/workflow/specs/p.md" }));
    service.close();
  });

  it("PR sessions never look for a program in their worktree", async () => {
    const { service, findWorktreeProgram, computeVerdict } = harness([session({ kind: "pr-fix" })], "docs/workflow/specs/p.md");
    expect(await service.get("s1")).toBeNull();
    expect(findWorktreeProgram).not.toHaveBeenCalled();
    expect(computeVerdict).not.toHaveBeenCalled();
    service.close();
  });
});
