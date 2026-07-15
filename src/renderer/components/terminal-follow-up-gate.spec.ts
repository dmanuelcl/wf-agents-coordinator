import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalFollowUpGate } from "./terminal-follow-up-gate";

afterEach(() => {
  vi.useRealTimers();
});

describe("createTerminalFollowUpGate", () => {
  it("delivers once after startup output becomes quiet", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const gate = createTerminalFollowUpGate({ settleMs: 1_200, maxWaitMs: 10_000, deliver });

    gate.start();
    gate.onOutput();
    vi.advanceTimersByTime(900);
    gate.onOutput();
    vi.advanceTimersByTime(1_199);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("uses the hard deadline when a TUI never becomes quiet", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const gate = createTerminalFollowUpGate({ settleMs: 1_200, maxWaitMs: 10_000, deliver });

    gate.start();
    for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
      gate.onOutput();
      vi.advanceTimersByTime(500);
    }

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not deliver after cancellation", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const gate = createTerminalFollowUpGate({ settleMs: 1_200, maxWaitMs: 10_000, deliver });

    gate.start();
    gate.onOutput();
    gate.cancel();
    vi.runAllTimers();

    expect(deliver).not.toHaveBeenCalled();
  });
});
