import { describe, expect, it } from "vitest";
import { prFixCompletionCheckpointPath } from "../../shared/workflow/pr-fix-kickoff";
import type { WorkSession } from "../../shared/workflow/work-session";
import { sessionCheckpointWatchParams } from "./session-checkpoint-watch-params";

function session(overrides: Partial<WorkSession>): WorkSession {
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
    createdAtEpochMs: 7,
    ...overrides,
  };
}

describe("sessionCheckpointWatchParams", () => {
  it("a PR fix waits for its exact completion checkpoint", () => {
    expect(sessionCheckpointWatchParams(session({ kind: "pr-fix", slug: "fix-pr-1" }))).toMatchObject({
      expectedCheckpointPath: prFixCompletionCheckpointPath("fix-pr-1"),
      programSpecPath: undefined,
    });
  });

  it("a session waiting on a program child only accepts that program's checkpoints", () => {
    expect(sessionCheckpointWatchParams(session({ initialPrompt: "wf next docs/workflow/specs/p.md" })).programSpecPath).toBe(
      "docs/workflow/specs/p.md",
    );
    expect(sessionCheckpointWatchParams(session({ program: "docs/workflow/specs/q.md" })).programSpecPath).toBe("docs/workflow/specs/q.md");
  });

  it("an ordinary feature session keeps the unfiltered gate", () => {
    expect(sessionCheckpointWatchParams(session({}))).toEqual({
      sessionId: "s1",
      worktreePath: "/repo/.worktrees/s",
      createdAtEpochMs: 7,
      expectedCheckpointPath: undefined,
      programSpecPath: undefined,
    });
  });
});
