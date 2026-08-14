/**
 * Whether a session the auto-pilot is waiting on has actually gone dead.
 *
 * Time spent waiting is not evidence by itself: an agent commonly updates
 * `▶ NEXT` and then spends a long while verifying before it runs `wf done`, and
 * alerting on that would cry wolf at every hand-off. What separates the two is
 * the agent's own terminal — one that is working prints continuously (both
 * supported CLIs paint a ticking spinner), one that is hung, out of quota, or
 * waiting on an answer from the user prints nothing at all.
 *
 * This only decides whether to raise an alert. PTY silence is deliberately kept
 * out of the hand-off gate itself: it says nothing about whether a turn is
 * *finished*, only about whether anything is still happening.
 */
export function isHandoffStalled(params: {
  /** When the auto-pilot started waiting for a hand-off, or null if it is not. */
  waitingSinceEpochMs: number | null;
  /** Last output from any of the session's agents; null when none is live. */
  lastAgentOutputAtEpochMs: number | null;
  nowEpochMs: number;
  silenceMs: number;
}): boolean {
  const { waitingSinceEpochMs, lastAgentOutputAtEpochMs, nowEpochMs, silenceMs } = params;
  if (waitingSinceEpochMs === null) return false;

  const waitedFor = nowEpochMs - waitingSinceEpochMs;
  if (waitedFor < silenceMs) return false;

  // No live agent means nothing can ever produce the hand-off being waited for.
  if (lastAgentOutputAtEpochMs === null) return true;

  return nowEpochMs - lastAgentOutputAtEpochMs >= silenceMs;
}
