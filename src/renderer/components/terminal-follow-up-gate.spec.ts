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

  it("never bypasses a startup confirmation, including at the hard deadline", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    let ready = false;
    const gate = createTerminalFollowUpGate({
      settleMs: 1_200,
      maxWaitMs: 10_000,
      canDeliver: () => ready,
      deliver,
    });

    gate.start();
    vi.advanceTimersByTime(10_000);
    expect(deliver).not.toHaveBeenCalled();

    ready = true;
    gate.onUserInput();
    vi.advanceTimersByTime(1_200);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps polling after the deadline until the confirmation clears (no further output)", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    let ready = false;
    const gate = createTerminalFollowUpGate({
      settleMs: 1_200,
      maxWaitMs: 10_000,
      canDeliver: () => ready,
      deliver,
    });

    gate.start();
    vi.advanceTimersByTime(10_000); // deadline fires but the confirmation blocks it
    expect(deliver).not.toHaveBeenCalled();

    // The prompt is answered elsewhere; the agent produces no new output, so
    // there is no onOutput/onUserInput to re-arm the settle timer. The gate must
    // keep polling on its own instead of silently dropping the delivery.
    ready = true;
    vi.advanceTimersByTime(1_200);
    expect(deliver).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(deliver).toHaveBeenCalledTimes(1); // never twice
  });

  it("stops polling after cancellation even while blocked", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const gate = createTerminalFollowUpGate({
      settleMs: 1_200,
      maxWaitMs: 10_000,
      canDeliver: () => false,
      deliver,
    });

    gate.start();
    vi.advanceTimersByTime(10_000); // deadline blocked → poll armed
    gate.cancel();
    vi.runAllTimers();

    expect(deliver).not.toHaveBeenCalled();
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
