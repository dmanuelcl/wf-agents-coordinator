import { describe, expect, it } from "vitest";
import {
  buildStartFromInput,
  canSubmitStartFrom,
  startFromBranchHint,
  startFromCheckpointHint,
  suggestSessionName,
} from "./session-start-from";
import type { RefCheckpointSummary } from "../../shared/ipc/contract";

describe("canSubmitStartFrom", () => {
  it("requires only a name in the default mode", () => {
    expect(canSubmitStartFrom({ mode: "new", ref: "", name: "Auth rotation" })).toBe(true);
  });

  it("requires a ref once a start point is chosen", () => {
    expect(canSubmitStartFrom({ mode: "continue", ref: "", name: "Auth rotation" })).toBe(false);
    expect(canSubmitStartFrom({ mode: "continue", ref: "feature/auth", name: "Auth rotation" })).toBe(true);
  });

  it("still requires a name when a ref is chosen", () => {
    expect(canSubmitStartFrom({ mode: "fork", ref: "develop", name: "   " })).toBe(false);
  });
});

describe("suggestSessionName", () => {
  it("names a continued session after the branch it picks up", () => {
    expect(suggestSessionName("continue", "feature/auth-rotation")).toBe("Continue feature/auth-rotation");
  });

  it("leaves the name to the user when forking, since the branch is theirs to name", () => {
    expect(suggestSessionName("fork", "develop")).toBe("");
  });

  it("produces nothing without a branch", () => {
    expect(suggestSessionName("continue", "")).toBe("");
  });

  it("truncates a branch too long to be a session name", () => {
    const suggestion = suggestSessionName("continue", `feature/${"x".repeat(200)}`);

    expect(suggestion.length).toBeLessThanOrEqual(100);
    expect(suggestion.endsWith("…")).toBe(true);
  });
});

describe("buildStartFromInput", () => {
  it("omits the start point entirely in the default mode", () => {
    expect(buildStartFromInput({ mode: "new", ref: "develop", checkpointPath: "docs/x-checkpoint.md" })).toBeUndefined();
  });

  it("carries the ref and the adopted checkpoint", () => {
    expect(buildStartFromInput({ mode: "continue", ref: "feature/auth", checkpointPath: "docs/x-checkpoint.md" })).toEqual({
      mode: "continue",
      ref: "feature/auth",
      checkpointPath: "docs/x-checkpoint.md",
    });
  });

  it("normalizes an unselected checkpoint to null so the session starts at Architect", () => {
    expect(buildStartFromInput({ mode: "fork", ref: "develop", checkpointPath: "" })).toEqual({
      mode: "fork",
      ref: "develop",
      checkpointPath: null,
    });
  });
});

describe("startFromBranchHint", () => {
  it("says a continued session writes to the branch itself", () => {
    expect(startFromBranchHint("continue", "feature/auth")).toContain("feature/auth");
    expect(startFromBranchHint("continue", "feature/auth")).toMatch(/writable|commits/i);
  });

  it("says a fork starts from what was published", () => {
    expect(startFromBranchHint("fork", "develop")).toContain("origin/develop");
  });

  it("has nothing to say without a branch", () => {
    expect(startFromBranchHint("continue", "")).toBe("");
  });
});

describe("startFromCheckpointHint", () => {
  const checkpoint: RefCheckpointSummary = {
    path: "docs/checkpoints/session-start-point.md",
    feature: "Session start point",
    slug: "session-start-point",
    status: "PLANNED",
  };

  it("asks for a branch before anything can be listed", () => {
    expect(startFromCheckpointHint({ ref: "", checkpoints: null, checkpointPath: "" })).toBe("Pick a branch first.");
  });

  it("says the session starts at Architect when the branch carries no checkpoint", () => {
    const hint = startFromCheckpointHint({ ref: "develop", checkpoints: [], checkpointPath: "" });

    expect(hint).toContain("No checkpoint committed on this branch");
  });

  it("shows the full path of the adopted checkpoint, not its title", () => {
    const hint = startFromCheckpointHint({
      ref: "develop",
      checkpoints: [checkpoint],
      checkpointPath: "docs/checkpoints/session-start-point.md",
    });

    expect(hint).toBe("Adopting docs/checkpoints/session-start-point.md");
  });

  it("explains what adopting one buys while the list is still being read", () => {
    const hint = startFromCheckpointHint({ ref: "develop", checkpoints: null, checkpointPath: "" });

    expect(hint).toContain("unlocks Implementer and Reviewer");
  });
});
