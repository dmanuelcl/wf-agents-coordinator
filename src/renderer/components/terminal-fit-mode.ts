/** Who decides this terminal's grid: the runner's PTY, or the local view. */
export type TerminalFitMode = "runner" | "local";

/**
 * A runner-owned PTY is sized by the runner, so that every viewer sees the same
 * grid and a resize cannot disturb the running process. That only holds while
 * the PTY is alive: the runner discards a terminal's screen model the moment the
 * process exits, and from then on answers every resize request with nothing.
 *
 * Staying in runner mode past that point freezes the grid at whatever the runner
 * last had — the pane keeps rendering a 160x44 screen into a smaller box and
 * clips its own final lines, which is exactly what a failed setup command leaves
 * on screen. Fitting goes back to the view instead.
 */
export function terminalFitMode(params: {
  /** A PTY is attached to this view. */
  attached: boolean;
  /** The attach carried the runner's screen model, which the view restored. */
  runnerScreenAdopted: boolean;
  /** The attached PTY's process has exited. */
  ptyExited: boolean;
}): TerminalFitMode {
  const { attached, runnerScreenAdopted, ptyExited } = params;
  return attached && runnerScreenAdopted && !ptyExited ? "runner" : "local";
}
