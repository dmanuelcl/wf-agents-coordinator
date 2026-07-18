import { describe, expect, it } from "vitest";
import {
  agentRolesForSessionKind,
  isSessionRoleUnlocked,
  shouldInjectRoleCommand,
  stageForSessionRole,
  wfCommandForSessionRole,
} from "./session-role-launch";

describe("agentRolesForSessionKind", () => {
  it("gives PR fixes an implementer followed by a reviewer", () => {
    expect(agentRolesForSessionKind("pr-fix")).toEqual(["implementer", "reviewer"]);
  });

  it("keeps PR review reviewer-only and regular workflows at three roles", () => {
    expect(agentRolesForSessionKind("review")).toEqual(["reviewer"]);
    expect(agentRolesForSessionKind("feature")).toEqual(["architect", "implementer", "reviewer"]);
    expect(agentRolesForSessionKind("fix")).toEqual(["architect", "implementer", "reviewer"]);
  });
});

describe("isSessionRoleUnlocked", () => {
  it("keeps the PR-fix reviewer locked until the implementer checkpoint exists", () => {
    expect(isSessionRoleUnlocked("pr-fix", "implementer", false)).toBe(true);
    expect(isSessionRoleUnlocked("pr-fix", "reviewer", false)).toBe(false);
    expect(isSessionRoleUnlocked("pr-fix", "reviewer", true)).toBe(true);
  });

  it("preserves the existing gates for regular workflows and PR review", () => {
    expect(isSessionRoleUnlocked("feature", "architect", false)).toBe(true);
    expect(isSessionRoleUnlocked("feature", "implementer", false)).toBe(false);
    expect(isSessionRoleUnlocked("fix", "reviewer", true)).toBe(true);
    expect(isSessionRoleUnlocked("review", "reviewer", false)).toBe(true);
  });
});

describe("stageForSessionRole", () => {
  it("maps each session role onto the matching runtime-config stage", () => {
    expect(stageForSessionRole("architect")).toBe("architect");
    expect(stageForSessionRole("implementer")).toBe("implementer");
    expect(stageForSessionRole("reviewer")).toBe("reviewer");
  });
});

describe("shouldInjectRoleCommand", () => {
  it("injects the kickoff when a PR review or fix is first opened", () => {
    expect(shouldInjectRoleCommand("review", "fresh")).toBe(true);
    expect(shouldInjectRoleCommand("pr-fix", "fresh")).toBe(true);
  });

  it("does not inject the kickoff when a PR review or fix is restored", () => {
    expect(shouldInjectRoleCommand("review", "resume")).toBe(false);
    expect(shouldInjectRoleCommand("pr-fix", "resume")).toBe(false);
  });

  it("preserves command pre-typing for restored workflow sessions", () => {
    expect(shouldInjectRoleCommand("feature", "resume")).toBe(true);
    expect(shouldInjectRoleCommand("fix", "resume")).toBe(true);
  });
});

describe("wfCommandForSessionRole", () => {
  const checkpoint = "docs/workflow/checkpoints/add-widget-checkpoint.md";

  it("builds the implement command against the worktree-relative checkpoint path", () => {
    expect(wfCommandForSessionRole("implementer", checkpoint)).toBe(`wf implement ${checkpoint}`);
  });

  it("builds the review command", () => {
    expect(wfCommandForSessionRole("reviewer", checkpoint)).toBe(`wf review ${checkpoint}`);
  });

  it("builds the architect verify command when a checkpoint exists", () => {
    expect(wfCommandForSessionRole("architect", checkpoint)).toBe(`wf verify ${checkpoint}`);
  });

  it("returns null when there is no checkpoint yet (architect still brainstorming)", () => {
    expect(wfCommandForSessionRole("architect", null)).toBeNull();
  });
});
