import { useEffect, useRef } from "react";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import { createConductorController } from "../conductor-controller";
import type { ConductorController } from "../conductor-controller";
import type { ConductorAction } from "../../shared/workflow/conductor";
import type { WorkSession } from "../../shared/ipc/contract";

/** Join a base dir and a relative path with "/" (the renderer can't use node:path). */
function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/**
 * Drives one session's auto-pilot: subscribes to checkpoint changes, matches
 * them to THIS session by absolute path, debounces via the controller, and
 * dispatches the decided action through `onAction`. `repoRoot` is the project
 * root, used to resolve the broadcast's project-root-relative path (the session's
 * own checkpointPath is worktree-relative, so the two must both go absolute).
 * Dormant until the session has a checkpoint.
 */
export function useConductor(params: {
  session: WorkSession;
  repoRoot: string;
  enabled: boolean;
  getConfig: () => AutoPilotConfig;
  onAction: (action: ConductorAction) => void;
}): void {
  const { session, repoRoot, enabled } = params;
  const controllerRef = useRef<ConductorController | null>(null);
  const onActionRef = useRef(params.onAction);
  const getConfigRef = useRef(params.getConfig);
  useEffect(() => {
    onActionRef.current = params.onAction;
    getConfigRef.current = params.getConfig;
  });

  const checkpointPath = session.checkpointPath;
  const worktreePath = session.worktreePath;
  useEffect(() => {
    if (!checkpointPath) return; // dormant until a checkpoint exists
    const sessionAbs = joinPath(worktreePath, checkpointPath);

    const controller = createConductorController({
      getConfig: () => getConfigRef.current(),
      onAction: (action) => onActionRef.current(action),
    });
    controllerRef.current = controller;

    const unsubscribe = window.agentCoordinator.checkpoints.onChanged((event) => {
      const changedAbs = joinPath(repoRoot, event.checkpoint.checkpointPath);
      if (changedAbs !== sessionAbs) return;
      controller.notifyCheckpoint(event.checkpoint);
    });

    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [session.id, worktreePath, checkpointPath, repoRoot]);

  useEffect(() => {
    controllerRef.current?.setEnabled(enabled);
  }, [enabled]);
}
