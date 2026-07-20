import type { AutoPilotConfig } from "../shared/workflow/auto-pilot-config";
import { decideConductor, INITIAL_CONDUCTOR_STATE } from "../shared/workflow/conductor";
import type { ConductorAction, ConductorState } from "../shared/workflow/conductor";
import type { ParsedCheckpoint } from "../shared/workflow/workflow-types";

export interface ConductorController {
  notifyCheckpoint(checkpoint: ParsedCheckpoint): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/** How long to wait before re-attempting a `send` whose delivery didn't land. */
const RETRY_DELAY_MS = 700;
/** How many times to re-attempt a failed `send` before giving up and waiting for
 *  the next checkpoint change — bounds the loop so a persistently-dead agent tab
 *  can't spin forever. */
const MAX_DELIVERY_RETRIES = 3;

/**
 * The renderer-side timing + dispatch layer around the pure `decideConductor`.
 * Holds the conductor state, the enabled flag, and the latest checkpoint; a
 * single quiescence-debounce timer waits `settleDelayMs` after the last change
 * before deciding, so it never fires while the agent is still writing.
 *
 * `onAction` returns whether the action was actually delivered. A `send` that
 * could not reach a live agent tab is NOT committed to the conductor state — so
 * the step is retried (bounded) instead of being silently marked done, which is
 * what previously left auto-pilot stuck after a missed hand-off.
 */
export function createConductorController(deps: {
  getConfig: () => AutoPilotConfig;
  onAction: (action: ConductorAction) => boolean;
}): ConductorController {
  let state: ConductorState = INITIAL_CONDUCTOR_STATE;
  let enabled = false;
  let latest: ParsedCheckpoint | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deliveryRetries = 0;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    if (!enabled || !latest) return;
    const { action, next } = decideConductor({ prev: state, checkpoint: latest, config: deps.getConfig() });
    if (action.kind === "noop") {
      deliveryRetries = 0;
      return;
    }
    const delivered = deps.onAction(action);
    // Only a `send` needs confirmed delivery; pause never mutates state.
    if (action.kind === "send" && !delivered) {
      if (deliveryRetries < MAX_DELIVERY_RETRIES) {
        deliveryRetries += 1;
        timer = setTimeout(fire, RETRY_DELAY_MS);
      } else {
        deliveryRetries = 0; // give up; a future checkpoint change re-attempts
      }
      return; // leave `state` uncommitted so the step is re-decided next time
    }
    deliveryRetries = 0;
    state = next;
  }

  function schedule(): void {
    clearTimer();
    deliveryRetries = 0;
    timer = setTimeout(fire, deps.getConfig().settleDelayMs);
  }

  return {
    notifyCheckpoint(checkpoint) {
      latest = checkpoint;
      if (enabled) schedule();
    },
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      if (enabled && latest) schedule();
      if (!enabled) clearTimer();
    },
    dispose() {
      clearTimer();
    },
  };
}
