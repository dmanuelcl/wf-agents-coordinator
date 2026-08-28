import { describe, expect, it } from "vitest";
import { HANDOFF_CONTEXT_FRESH_TOKENS, parseSessionHandoff, shouldForceFreshContext } from "./session-handoff";

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
      contextTokens: null,
    });
  });

  it("reads the publisher's context tokens when wf:done recorded them", () => {
    expect(parseSessionHandoff(handoff({ contextTokens: 630_826 }))?.contextTokens).toBe(630_826);
  });

  it("treats a malformed or negative contextTokens as unknown", () => {
    expect(parseSessionHandoff(handoff({ contextTokens: "big" }))?.contextTokens).toBeNull();
    expect(parseSessionHandoff(handoff({ contextTokens: -5 }))?.contextTokens).toBeNull();
  });

  it("forces a fresh session only above the context ceiling", () => {
    expect(shouldForceFreshContext(null)).toBe(false);
    expect(shouldForceFreshContext(HANDOFF_CONTEXT_FRESH_TOKENS - 1)).toBe(false);
    expect(shouldForceFreshContext(HANDOFF_CONTEXT_FRESH_TOKENS)).toBe(true);
    expect(shouldForceFreshContext(900_000)).toBe(true);
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
