import { describe, expect, it } from "vitest";
import { normalizeStartRef, resolveStartPoint } from "./session-start-point";
import type { BranchState, StartPointMode } from "./session-start-point";

const CLEAN: BranchState = { hasLocal: true, remote: "origin", ahead: 0, behind: 0, checkedOutAt: null };

function plan(mode: StartPointMode, state: Partial<BranchState>, ref: string | null = "feature/auth") {
  return resolveStartPoint({
    mode,
    ref,
    sessionBranch: "feature/auth-rotation",
    state: { ...CLEAN, ...state },
  });
}

describe("resolveStartPoint · continue", () => {
  it("aborts when the branch diverged from its remote", () => {
    const result = plan("continue", { ahead: 2, behind: 3 });

    expect(result).toEqual({
      action: "abort",
      reason:
        'Branch "feature/auth" has diverged from its remote: 2 local commits it does not have, 3 remote ' +
        "commits you do not have. Reconcile it before continuing the session.",
    });
  });

  it("aborts when the branch is already checked out in another worktree", () => {
    const result = plan("continue", { checkedOutAt: "/repo/.worktrees/auth" });

    expect(result).toEqual({
      action: "abort",
      reason: 'Branch "feature/auth" is already checked out at /repo/.worktrees/auth. Git allows a branch in only one worktree.',
    });
  });

  it("fast-forwards a branch that is behind its remote", () => {
    expect(plan("continue", { behind: 4 })).toEqual({
      action: "checkout",
      branch: "feature/auth",
      fastForward: true,
    });
  });

  it("checks out an up-to-date branch without fast-forwarding", () => {
    expect(plan("continue", {})).toEqual({
      action: "checkout",
      branch: "feature/auth",
      fastForward: false,
    });
  });

  it("checks out a branch holding unpushed commits without aborting", () => {
    expect(plan("continue", { ahead: 2 })).toEqual({
      action: "checkout",
      branch: "feature/auth",
      fastForward: false,
    });
  });

  it("checks out a remote-only branch, letting git create the tracking branch", () => {
    expect(plan("continue", { hasLocal: false })).toEqual({
      action: "checkout",
      branch: "feature/auth",
      fastForward: false,
    });
  });

  it("checks out a local-only branch without touching any remote", () => {
    expect(plan("continue", { remote: null })).toEqual({
      action: "checkout",
      branch: "feature/auth",
      fastForward: false,
    });
  });

  it("aborts when the ref no longer resolves", () => {
    expect(plan("continue", { hasLocal: false, remote: null })).toEqual({
      action: "abort",
      reason: 'Branch "feature/auth" no longer exists locally or on any remote.',
    });
  });
});

describe("resolveStartPoint · fork", () => {
  it("branches off the published ref when the base has a remote", () => {
    expect(plan("fork", {}, "develop")).toEqual({
      action: "new-branch",
      branch: "feature/auth-rotation",
      from: "origin/develop",
    });
  });

  it("branches off the local ref when the base has no remote", () => {
    expect(plan("fork", { remote: null }, "develop")).toEqual({
      action: "new-branch",
      branch: "feature/auth-rotation",
      from: "develop",
    });
  });

  it("aborts when the base ref no longer resolves", () => {
    expect(plan("fork", { hasLocal: false, remote: null }, "develop")).toEqual({
      action: "abort",
      reason: 'Branch "develop" no longer exists locally or on any remote.',
    });
  });
});

describe("resolveStartPoint · new", () => {
  it("creates the session branch off the repo root's HEAD", () => {
    expect(plan("new", { hasLocal: false, remote: null }, null)).toEqual({
      action: "new-branch",
      branch: "feature/auth-rotation",
      from: "HEAD",
    });
  });

  it("reopens a session branch that outlived a deleted session", () => {
    expect(plan("new", { remote: null }, null)).toEqual({
      action: "checkout",
      branch: "feature/auth-rotation",
      fastForward: false,
    });
  });
});

describe("normalizeStartRef", () => {
  it("strips a known remote prefix so the checkout is writable", () => {
    expect(normalizeStartRef("origin/feature/auth", ["origin"])).toBe("feature/auth");
  });

  it("leaves a local branch that merely looks like a remote alone", () => {
    expect(normalizeStartRef("origin/feature/auth", ["upstream"])).toBe("origin/feature/auth");
  });

  it("leaves a plain branch name alone", () => {
    expect(normalizeStartRef("develop", ["origin"])).toBe("develop");
  });

  it("does not strip a remote name that is the whole ref", () => {
    expect(normalizeStartRef("origin", ["origin"])).toBe("origin");
  });
});
