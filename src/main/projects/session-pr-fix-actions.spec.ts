import { describe, expect, it, vi } from "vitest";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import type { ParsedCheckpoint } from "../../shared/workflow/workflow-types";
import type { PrLink, WorkSession } from "../../shared/workflow/work-session";
import type { ResolvedPr } from "../vcs/vcs-provider";
import { createSessionPrFixActions } from "./session-pr-fix-actions";

const CP = "docs/workflow/checkpoints/x-checkpoint.md";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "s1",
    projectId: "p",
    name: "S",
    kind: "feature",
    slug: "s",
    branch: "feature/x",
    baseBranch: null,
    pr: null,
    worktreePath: "/w",
    checkpointPath: CP,
    setupDone: true,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

function checkpoint(status: string, program = false): ParsedCheckpoint {
  return parseCheckpointMarkdown({
    checkpointPath: CP,
    markdown: `---
feature: X
slug: x
kind: feature
status: ${status}
active: none
---

# Architect memory
${program ? "- **Programa:** docs/workflow/specs/p.md" : ""}
`,
  });
}

const RESOLVED: ResolvedPr = {
  host: "bitbucket",
  workspace: "w",
  repo: "r",
  prId: "291",
  url: "https://bitbucket.org/w/r/pull-requests/291",
  source: "feature/x",
  target: "develop",
  title: "Canales",
  headSha: "prhead",
};

function harness(options: {
  current?: WorkSession;
  checkpoint?: ParsedCheckpoint | null;
  resolved?: ResolvedPr;
  contains?: boolean;
  context?: { comments: number; loadError: string | null };
} = {}) {
  const current = options.current ?? session();
  const calls: string[] = [];
  const deps = {
    getSession: vi.fn(async () => current),
    readCheckpoint: vi.fn(async () => (options.checkpoint === undefined ? checkpoint("DONE") : options.checkpoint)),
    resolvePr: vi.fn(async () => options.resolved ?? RESOLVED),
    worktreeHead: vi.fn(async (_session: WorkSession, sha: string) => {
      calls.push(`head:${sha}`);
      return { head: "localhead", contains: options.contains ?? true };
    }),
    writePrContext: vi.fn(async (linked: WorkSession) => {
      calls.push(`context:${linked.pr?.prId}`);
      return options.context ?? { comments: 3, loadError: null };
    }),
    setSessionPr: vi.fn(async (params: { sessionId: string; pr: PrLink }) => {
      calls.push("link");
      return { ...current, pr: params.pr };
    }),
    resetAutopilot: vi.fn(async () => {
      calls.push("reset");
    }),
    runCommand: vi.fn(async (_sessionId: string, role: string, lane: string, _command: string) => {
      calls.push(`run:${role}:${lane}`);
    }),
    broadcastSession: vi.fn(() => {
      calls.push("broadcast");
    }),
  };
  return { actions: createSessionPrFixActions(deps), deps, calls };
}

describe("session PR fix", () => {
  it("links the PR, writes its conversation and hands the reopening to the Reviewer lane that closed the checkpoint", async () => {
    const { actions, deps, calls } = harness();

    const updated = await actions.start("s1", RESOLVED.url);

    expect(calls).toEqual(["head:prhead", "context:291", "link", "reset", "broadcast", "run:reviewer:feature-review/reviewer"]);
    expect(updated.pr).toMatchObject({ prId: "291", url: RESOLVED.url, fixBaseSha: "localhead", lastReviewedSha: null });
    const command = deps.runCommand.mock.calls[0]?.[3] ?? "";
    expect(command).toContain("PR #291");
    expect(command).toContain(CP);
    expect(command).toContain("**Baseline commit:** localhead");
    expect(command).not.toContain("# Hijos");
  });

  it("names the program row when the checkpoint is a program child", async () => {
    const { actions, deps } = harness({ checkpoint: checkpoint("DONE", true) });
    await actions.start("s1", RESOLVED.url);
    expect(deps.runCommand.mock.calls[0]?.[3]).toContain("# Hijos");
  });

  it("keeps the anchor of a PR the session already reviewed", async () => {
    const linked = session({
      pr: { host: "bitbucket", workspace: "w", repo: "r", prId: "291", url: RESOLVED.url, lastReviewedSha: "old", fixBaseSha: "x" },
    });
    const { actions } = harness({ current: linked });
    const updated = await actions.start("s1", RESOLVED.url);
    expect(updated.pr?.lastReviewedSha).toBe("old");
  });

  it("refuses a checkpoint that is still running, before touching the host", async () => {
    const { actions, deps } = harness({ checkpoint: checkpoint("IN_PROGRESS") });
    await expect(actions.start("s1", RESOLVED.url)).rejects.toThrow(/DONE/);
    expect(deps.resolvePr).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("refuses a PR that does not come from this session's branch", async () => {
    const { actions, deps } = harness({ resolved: { ...RESOLVED, source: "feature/otra" } });
    await expect(actions.start("s1", RESOLVED.url)).rejects.toThrow(/feature\/otra.*feature\/x/);
    expect(deps.setSessionPr).not.toHaveBeenCalled();
  });

  it("refuses when the worktree lacks the PR head: someone pushed and the session must pull first", async () => {
    const { actions, deps } = harness({ contains: false });
    await expect(actions.start("s1", RESOLVED.url)).rejects.toThrow(/pull/i);
    expect(deps.writePrContext).not.toHaveBeenCalled();
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("does not start the Reviewer without the PR conversation", async () => {
    const failed = harness({ context: { comments: 0, loadError: "401" } });
    await expect(failed.actions.start("s1", RESOLVED.url)).rejects.toThrow(/401/);
    expect(failed.deps.setSessionPr).not.toHaveBeenCalled();

    const empty = harness({ context: { comments: 0, loadError: null } });
    await expect(empty.actions.start("s1", RESOLVED.url)).rejects.toThrow(/no comments/);
    expect(empty.deps.runCommand).not.toHaveBeenCalled();
  });

  it("uses the fix lanes for a fix checkpoint", async () => {
    const fixCheckpoint = { ...checkpoint("DONE"), kind: "fix" as const };
    const { actions, calls } = harness({ current: session({ kind: "fix" }), checkpoint: fixCheckpoint });
    await actions.start("s1", RESOLVED.url);
    expect(calls).toContain("run:reviewer:fix/reviewer");
  });
});
