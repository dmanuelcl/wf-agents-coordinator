import type { AutoPilotConfig } from "../shared/workflow/auto-pilot-config";
import { decideConductor, INITIAL_CONDUCTOR_STATE } from "../shared/workflow/conductor";
import type { ConductorAction, ConductorState } from "../shared/workflow/conductor";
import type { ParsedCheckpoint } from "../shared/workflow/workflow-types";

export interface ConductorController {
  notifyCheckpoint(checkpoint: ParsedCheckpoint): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * The renderer-side timing + dispatch layer around the pure `decideConductor`.
 * Holds the conductor state, the enabled flag, and the latest checkpoint; a
 * single quiescence-debounce timer waits `settleDelayMs` after the last change
 * before deciding, so it never fires while the agent is still writing.
 */
export function createConductorController(deps: {
  getConfig: () => AutoPilotConfig;
  onAction: (action: ConductorAction) => Promise<void>;
}): ConductorController {
  let state: ConductorState = INITIAL_CONDUCTOR_STATE;
  let enabled = false;
  let latest: ParsedCheckpoint | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let rerunAfterFlight = false;
  // Incremented when a person turns auto-pilot off. An action already being
  // launched may still settle afterwards; it must not restore the old guard
  // state over the manual reset.
  let resetGeneration = 0;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    if (!enabled || !latest) return;
    if (inFlight) {
      rerunAfterFlight = true;
      return;
    }
    const { action, next } = decideConductor({ prev: state, checkpoint: latest, config: deps.getConfig() });
    if (action.kind === "noop") return;
    if (action.kind === "pause") {
      state = next;
      void deps.onAction(action);
      return;
    }
    inFlight = true;
    const actionGeneration = resetGeneration;
    void deps.onAction(action).then(
      () => {
        if (actionGeneration === resetGeneration) state = next;
        inFlight = false;
        if (enabled && rerunAfterFlight) {
          rerunAfterFlight = false;
          schedule();
        }
      },
      () => {
        inFlight = false;
        if (enabled && rerunAfterFlight) {
          rerunAfterFlight = false;
          schedule();
        }
      },
    );
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(fire, deps.getConfig().settleDelayMs);
  }

  return {
    notifyCheckpoint(checkpoint) {
      latest = checkpoint;
      if (enabled && inFlight) {
        rerunAfterFlight = true;
      } else if (enabled) {
        schedule();
      }
    },
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      if (enabled && latest) schedule();
      if (!enabled) {
        clearTimer();
        rerunAfterFlight = false;
        // A deliberate off/on cycle is the user's escape hatch after the
        // re-loop cap. Start the next activation from a clean conductor state.
        state = INITIAL_CONDUCTOR_STATE;
        resetGeneration += 1;
      }
    },
    dispose() {
      clearTimer();
    },
  };
}
