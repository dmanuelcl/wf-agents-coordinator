import { describe, expect, it } from "vitest";
import { parseSessionHandoff } from "./session-handoff";

function handoff(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    turn: 7,
    checkpoint: "docs/workflow/checkpoints/auth-checkpoint.md",
    next: { role: "reviewer", sessionLane: "plan-1/reviewer" },
    ...overrides,
  });
}

describe("parseSessionHandoff", () => {
  it("reads the turn, checkpoint and the step being handed to", () => {
    expect(parseSessionHandoff(handoff())).toEqual({
      turn: 7,
      checkpointPath: "docs/workflow/checkpoints/auth-checkpoint.md",
      role: "reviewer",
      sessionLane: "plan-1/reviewer",
    });
  });

  it("accepts a hand-off that names no checkpoint", () => {
    expect(parseSessionHandoff(handoff({ checkpoint: undefined }))?.checkpointPath).toBeNull();
  });

  // Anything unreadable must read as "no hand-off" so the gate holds, rather
  // than as a hand-off the auto-pilot could act on.
  it("rejects content that is not JSON", () => {
    expect(parseSessionHandoff("{ half written")).toBeNull();
  });

  it("rejects a JSON value that is not an object", () => {
    expect(parseSessionHandoff("[1, 2, 3]")).toBeNull();
    expect(parseSessionHandoff("null")).toBeNull();
  });

  it("rejects a role that is not an agent role", () => {
    expect(parseSessionHandoff(handoff({ next: { role: "wizard", sessionLane: "plan-1/wizard" } }))).toBeNull();
  });

  it("rejects a missing or empty session lane", () => {
    expect(parseSessionHandoff(handoff({ next: { role: "reviewer" } }))).toBeNull();
    expect(parseSessionHandoff(handoff({ next: { role: "reviewer", sessionLane: "  " } }))).toBeNull();
  });

  it("rejects a turn that is not a finite number", () => {
    expect(parseSessionHandoff(handoff({ turn: "7" }))).toBeNull();
    expect(parseSessionHandoff(handoff({ turn: Number.NaN }))).toBeNull();
    expect(parseSessionHandoff(handoff({ turn: undefined }))).toBeNull();
  });
});
