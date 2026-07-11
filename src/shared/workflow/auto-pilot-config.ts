/** Per-project auto-pilot conductor settings. */
export interface AutoPilotConfig {
  /** Max reviewer→implementer fix-loops auto-run per task before pausing. 1..10. */
  reloopLimit: number;
  /** Quiescence-debounce window (ms) before acting on a checkpoint change. */
  settleDelayMs: number;
}

const DEFAULT_RELOOP_LIMIT = 3;
const DEFAULT_SETTLE_DELAY_MS = 4000;
const MIN_RELOOP_LIMIT = 1;
const MAX_RELOOP_LIMIT = 10;
const MIN_SETTLE_DELAY_MS = 500;

export function createDefaultAutoPilotConfig(): AutoPilotConfig {
  return { reloopLimit: DEFAULT_RELOOP_LIMIT, settleDelayMs: DEFAULT_SETTLE_DELAY_MS };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Normalize a partial/untrusted config (persisted or from the modal) into a valid one. */
export function clampAutoPilotConfig(input: Partial<AutoPilotConfig>): AutoPilotConfig {
  const reloopLimit =
    input.reloopLimit === undefined
      ? DEFAULT_RELOOP_LIMIT
      : clampInt(input.reloopLimit, MIN_RELOOP_LIMIT, MAX_RELOOP_LIMIT, DEFAULT_RELOOP_LIMIT);
  const settleDelayMs =
    input.settleDelayMs === undefined
      ? DEFAULT_SETTLE_DELAY_MS
      : Math.max(
          MIN_SETTLE_DELAY_MS,
          Math.floor(Number.isFinite(input.settleDelayMs) ? input.settleDelayMs : DEFAULT_SETTLE_DELAY_MS),
        );
  return { reloopLimit, settleDelayMs };
}
