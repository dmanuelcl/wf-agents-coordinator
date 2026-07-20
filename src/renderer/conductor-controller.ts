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
  onAction: (action: ConductorAction) => void;
}): ConductorController {
  let state: ConductorState = INITIAL_CONDUCTOR_STATE;
  let enabled = false;
  let latest: ParsedCheckpoint | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
    state = next;
    if (action.kind !== "noop") deps.onAction(action);
  }

  function schedule(): void {
    clearTimer();
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
