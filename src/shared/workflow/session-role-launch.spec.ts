import { describe, expect, it } from "vitest";
import { shouldInjectRoleCommand, stageForSessionRole, wfCommandForSessionRole } from "./session-role-launch";

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
