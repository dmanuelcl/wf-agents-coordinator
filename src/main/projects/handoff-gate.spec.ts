import { describe, expect, it } from "vitest";
import { decideHandoffGate } from "./handoff-gate";

const NOW = 1_000_000;
const STEP = { role: "reviewer" as const, lane: "plan-1/reviewer" };

function gate(overrides: Partial<Parameters<typeof decideHandoffGate>[0]> = {}) {
  return decideHandoffGate({
    handoffModeActive: true,
    pending: { turn: 7, role: "reviewer", sessionLane: "plan-1/reviewer", seenAtEpochMs: NOW - 30_000 },
    step: STEP,
    settleDelayMs: 30_000,
    nowEpochMs: NOW,
    retryMs: 3_000,
    ...overrides,
  });
}

describe("decideHandoffGate", () => {
  it("runs a hand-off that matches the NEXT once the settle delay has passed", () => {
    expect(gate()).toEqual({ kind: "run", viaHandoff: true });
  });

  it("waits out the remainder of the settle delay, measured from the hand-off", () => {
    expect(gate({ pending: { turn: 7, role: "reviewer", sessionLane: "plan-1/reviewer", seenAtEpochMs: NOW - 8_000 } }))
      .toEqual({ kind: "wait", reason: "hand-off received · settling", retryInMs: 22_000, awaiting: "settle" });
  });

  it("waits when the outgoing agent has not handed off yet", () => {
    expect(gate({ pending: null })).toEqual({
      kind: "wait",
      reason: "waiting · the current agent has not handed off yet",
      retryInMs: 3_000,
      awaiting: "handoff",
    });
  });

  // The hand-off can land before the checkpoint write is flushed. That is not an
  // error, just "not yet" — the NEXT on disk still names the previous step.
  it("waits when the hand-off names a different lane than the NEXT on disk", () => {
    expect(gate({ step: { role: "implementer", lane: "plan-2/implementer" } })).toEqual({
      kind: "wait",
      reason: "waiting · hand-off does not match the checkpoint's NEXT yet",
      retryInMs: 3_000,
      awaiting: "handoff",
    });
  });

  it("waits when the hand-off names a different role for the same lane", () => {
    expect(gate({ step: { role: "implementer", lane: "plan-1/reviewer" } })).toEqual({
      kind: "wait",
      reason: "waiting · hand-off does not match the checkpoint's NEXT yet",
      retryInMs: 3_000,
      awaiting: "handoff",
    });
  });

  // A session whose workflow never writes the file keeps the old behavior. The
  // caller has already applied the settle delay through its own scheduling.
  it("runs without a hand-off for a session that has never produced one", () => {
    expect(gate({ handoffModeActive: false, pending: null })).toEqual({ kind: "run", viaHandoff: false });
  });

  it("still requires a hand-off once the session has produced one", () => {
    expect(gate({ handoffModeActive: true, pending: null }).kind).toBe("wait");
  });

  // A clock that jumps backwards must not read as "the delay already elapsed".
  it("waits the full delay when the hand-off timestamp is in the future", () => {
    expect(gate({ pending: { turn: 7, role: "reviewer", sessionLane: "plan-1/reviewer", seenAtEpochMs: NOW + 5_000 } }))
      .toEqual({ kind: "wait", reason: "hand-off received · settling", retryInMs: 30_000, awaiting: "settle" });
  });

  it("runs immediately when the project configured no settle delay", () => {
    expect(gate({ settleDelayMs: 0, pending: { turn: 7, role: "reviewer", sessionLane: "plan-1/reviewer", seenAtEpochMs: NOW } }))
      .toEqual({ kind: "run", viaHandoff: true });
  });
});
