export interface TerminalFollowUpGate {
  /** Start waiting once the PTY exists. */
  start(): void;
  /** Report agent output; delivery happens after the output settles. */
  onOutput(): void;
  /** Retry after the user answers an interactive startup prompt. */
  onUserInput(): void;
  /** Prevent any pending delivery. */
  cancel(): void;
}

interface TerminalFollowUpGateOptions {
  settleMs: number;
  maxWaitMs: number;
  /** False while an interactive startup confirmation is visible. */
  canDeliver?: () => boolean;
  deliver: () => void;
}

/**
 * Deliver terminal follow-up input after startup output goes quiet, with a hard
 * deadline for TUIs that keep repainting indefinitely. The deadline may retry
 * delivery, but it never bypasses an interactive startup confirmation.
 */
export function createTerminalFollowUpGate(options: TerminalFollowUpGateOptions): TerminalFollowUpGate {
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let started = false;

  function clearTimers(): void {
    if (settleTimer) clearTimeout(settleTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (retryTimer) clearTimeout(retryTimer);
    settleTimer = null;
    deadlineTimer = null;
    retryTimer = null;
  }

  function tryDeliver(): void {
    if (finished) return;
    if (options.canDeliver && !options.canDeliver()) {
      // Blocked by an interactive startup confirmation. Do NOT drop the delivery
      // (the old behavior silently lost it at the deadline): keep polling until
      // the confirmation clears, or until cancel()/finish stops us. onOutput /
      // onUserInput also re-arm the settle path when they fire.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(tryDeliver, options.settleMs);
      return;
    }
    finished = true;
    clearTimers();
    options.deliver();
  }

  function scheduleAfterSettle(): void {
    if (finished || !started) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(tryDeliver, options.settleMs);
  }

  return {
    start() {
      if (finished || started) return;
      started = true;
      // Do not treat a silent-but-still-starting process as ready immediately.
      // Its first output starts the quiet timer; the deadline is the fallback.
      deadlineTimer = setTimeout(tryDeliver, options.maxWaitMs);
    },
    onOutput() {
      scheduleAfterSettle();
    },
    onUserInput() {
      scheduleAfterSettle();
    },
    cancel() {
      if (finished) return;
      finished = true;
      clearTimers();
    },
  };
}
