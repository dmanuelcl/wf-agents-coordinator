import { describe, expect, it } from "vitest";
import { isHandoffStalled } from "./handoff-stall";

const NOW = 10_000_000;
const SILENCE = 120_000;

function stalled(overrides: Partial<Parameters<typeof isHandoffStalled>[0]> = {}): boolean {
  return isHandoffStalled({
    waitingSinceEpochMs: NOW - 10 * 60_000,
    lastAgentOutputAtEpochMs: NOW - 10 * 60_000,
    nowEpochMs: NOW,
    silenceMs: SILENCE,
    ...overrides,
  });
}

describe("isHandoffStalled", () => {
  it("reports a stall when the auto-pilot has waited and the agent has gone quiet", () => {
    expect(stalled()).toBe(true);
  });

  // The case that matters: an agent routinely updates NEXT and then spends a
  // long time verifying its work before running `wf done`. It prints the whole
  // time, so a long wait on its own must never read as a stall.
  it("does not report a stall while the agent is still printing", () => {
    expect(stalled({ lastAgentOutputAtEpochMs: NOW - 5_000 })).toBe(false);
  });

  it("does not report a stall before the wait itself is old enough", () => {
    expect(stalled({ waitingSinceEpochMs: NOW - 30_000 })).toBe(false);
  });

  it("is not stalled when the auto-pilot is not waiting at all", () => {
    expect(stalled({ waitingSinceEpochMs: null })).toBe(false);
  });

  // Nothing is running that could ever produce the hand-off being waited for.
  it("treats a session with no live agent as quiet", () => {
    expect(stalled({ lastAgentOutputAtEpochMs: null })).toBe(true);
  });

  it("needs both conditions, not either one", () => {
    expect(stalled({ waitingSinceEpochMs: NOW - 1_000, lastAgentOutputAtEpochMs: NOW - 60 * 60_000 })).toBe(false);
    expect(stalled({ waitingSinceEpochMs: NOW - 60 * 60_000, lastAgentOutputAtEpochMs: NOW - 1_000 })).toBe(false);
  });

  it("does not read a clock jump as elapsed silence", () => {
    expect(stalled({ lastAgentOutputAtEpochMs: NOW + 60_000 })).toBe(false);
    expect(stalled({ waitingSinceEpochMs: NOW + 60_000 })).toBe(false);
  });
});
