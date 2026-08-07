import { describe, expect, it } from "vitest";
import type { WorkSession } from "../../shared/workflow/work-session";
import { sessionsOwningCheckpoint } from "./checkpoint-session-routing";

function session(overrides: Partial<WorkSession> & Pick<WorkSession, "id" | "worktreePath" | "checkpointPath">): WorkSession {
  return {
    projectId: "project-1",
    name: overrides.id,
    kind: "feature",
    slug: overrides.id,
    branch: `feature/${overrides.id}`,
    baseBranch: null,
    pr: null,
    setupDone: true,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

const AUTH = session({
  id: "auth",
  worktreePath: "/repo/.worktrees/auth",
  checkpointPath: "docs/workflow/checkpoints/auth-checkpoint.md",
});

describe("sessionsOwningCheckpoint", () => {
  it("matches a session in a worktree, whose checkpoint the watcher reports project-root-relative", () => {
    const matched = sessionsOwningCheckpoint({
      projectRoot: "/repo",
      sessions: [AUTH],
      changedCheckpointPath: ".worktrees/auth/docs/workflow/checkpoints/auth-checkpoint.md",
    });

    expect(matched.map((candidate) => candidate.id)).toEqual(["auth"]);
  });

  it("does not match a sibling worktree that carries the same checkpoint filename", () => {
    const adopted = session({
      id: "auth-continued",
      worktreePath: "/repo/.worktrees/auth-continued",
      checkpointPath: "docs/workflow/checkpoints/auth-checkpoint.md",
    });

    const matched = sessionsOwningCheckpoint({
      projectRoot: "/repo",
      sessions: [AUTH, adopted],
      changedCheckpointPath: ".worktrees/auth-continued/docs/workflow/checkpoints/auth-checkpoint.md",
    });

    expect(matched.map((candidate) => candidate.id)).toEqual(["auth-continued"]);
  });

  it("matches a session whose worktree is the project root", () => {
    const atRoot = session({
      id: "root",
      worktreePath: "/repo",
      checkpointPath: "docs/workflow/checkpoints/root-checkpoint.md",
    });

    const matched = sessionsOwningCheckpoint({
      projectRoot: "/repo",
      sessions: [atRoot],
      changedCheckpointPath: "docs/workflow/checkpoints/root-checkpoint.md",
    });

    expect(matched.map((candidate) => candidate.id)).toEqual(["root"]);
  });

  it("ignores sessions that have no checkpoint yet", () => {
    const pending = session({ id: "pending", worktreePath: "/repo/.worktrees/pending", checkpointPath: null });

    expect(
      sessionsOwningCheckpoint({
        projectRoot: "/repo",
        sessions: [pending],
        changedCheckpointPath: ".worktrees/pending/docs/workflow/checkpoints/pending-checkpoint.md",
      }),
    ).toEqual([]);
  });

  it("tolerates a trailing separator on either base path", () => {
    const matched = sessionsOwningCheckpoint({
      projectRoot: "/repo/",
      sessions: [session({ id: "auth", worktreePath: "/repo/.worktrees/auth/", checkpointPath: "docs/workflow/checkpoints/auth-checkpoint.md" })],
      changedCheckpointPath: ".worktrees/auth/docs/workflow/checkpoints/auth-checkpoint.md",
    });

    expect(matched.map((candidate) => candidate.id)).toEqual(["auth"]);
  });
});
