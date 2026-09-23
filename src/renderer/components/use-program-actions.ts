import { useCallback, useState } from "react";
import { ipcErrorMessage } from "./program-display";
import type { ProgramAction } from "./program-display";

export interface ProgramActionsState {
  busy: boolean;
  error: string | null;
  run(action: ProgramAction): Promise<void>;
}

/** One instance per session view, shared by its banner and its Log panel. */
export function useProgramActions(sessionId: string): ProgramActionsState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: ProgramAction): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        if (action.kind === "start") await window.agentCoordinator.sessions.startProgramChild(sessionId);
        else if (action.kind === "adopt") await window.agentCoordinator.sessions.adoptProgramChild(sessionId, action.index);
        else await window.agentCoordinator.programs.refresh(sessionId);
      } catch (caught) {
        setError(ipcErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );
  return { busy, error, run };
}
