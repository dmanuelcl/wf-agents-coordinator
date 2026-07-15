export interface TerminalFollowUpGate {
  /** Start the hard deadline once the PTY exists. */
  start(): void;
  /** Report agent output; delivery happens after the output settles. */
  onOutput(): void;
  /** Prevent any pending delivery. */
  cancel(): void;
}

interface TerminalFollowUpGateOptions {
  settleMs: number;
  maxWaitMs: number;
  deliver: () => void;
}

/**
 * Deliver terminal follow-up input after startup output goes quiet, with a hard
 * deadline for TUIs that keep repainting indefinitely. Delivery is at-most-once.
 */
export function createTerminalFollowUpGate(options: TerminalFollowUpGateOptions): TerminalFollowUpGate {
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  function clearTimers(): void {
    if (settleTimer) clearTimeout(settleTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    settleTimer = null;
    deadlineTimer = null;
  }

  function deliverOnce(): void {
    if (finished) return;
    finished = true;
    clearTimers();
    options.deliver();
  }

  return {
    start() {
      if (finished || deadlineTimer) return;
      deadlineTimer = setTimeout(deliverOnce, options.maxWaitMs);
    },
    onOutput() {
      if (finished) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(deliverOnce, options.settleMs);
    },
    cancel() {
      if (finished) return;
      finished = true;
      clearTimers();
    },
  };
}
