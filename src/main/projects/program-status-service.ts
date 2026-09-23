import { resolve, sep } from "node:path";
import { PROGRAM_IPC_CHANNELS } from "../../shared/ipc/contract";
import type { ProgramStatusChangedEvent } from "../../shared/ipc/contract";
import { PROGRAM_MERGE_BASE } from "../../shared/workflow/program-verdict";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import { sessionProgramSpec } from "../../shared/workflow/session-program";
import type { WorkSession } from "../../shared/workflow/work-session";
import type { ParsedCheckpoint } from "../../shared/workflow/workflow-types";
import type { MergeBaseRefresher } from "./program-merge";
import { readProgramVerdict } from "./program-status";

export interface ProgramStatusService {
  /** The cached verdict, computed on first request. */
  get(sessionId: string): Promise<ProgramVerdict | null>;
  /** Recompute now; `force` refreshes `origin/develop` regardless of the throttle. */
  refresh(sessionId: string, options?: { force?: boolean }): Promise<ProgramVerdict | null>;
  /** A checkpoint changed (path relative to the project root): recompute the sessions whose worktree holds it. */
  onCheckpointChanged(projectId: string, checkpointPath: string): void;
  forget(sessionId: string): void;
  close(): void;
}

/**
 * One verdict per session, owned by main and pushed to every viewer. A PR merged
 * on the VCS host changes nothing on disk, so besides checkpoint events a slow
 * timer re-reads every program session; the fetch itself is throttled per repo.
 */
export function createProgramStatusService(deps: {
  getSession(sessionId: string): Promise<WorkSession | null>;
  listSessions(projectId: string): Promise<WorkSession[]>;
  projectRootOf(projectId: string): Promise<string | null>;
  readSessionCheckpoint(session: WorkSession): Promise<ParsedCheckpoint | null>;
  refresher: MergeBaseRefresher;
  broadcast(channel: string, payload: unknown): void;
  computeVerdict?: typeof readProgramVerdict;
  intervalMs?: number;
  debounceMs?: number;
}): ProgramStatusService {
  const computeVerdict = deps.computeVerdict ?? readProgramVerdict;
  const debounceMs = deps.debounceMs ?? 750;
  const cache = new Map<string, ProgramVerdict | null>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function compute(sessionId: string, force: boolean): Promise<ProgramVerdict | null> {
    const session = await deps.getSession(sessionId);
    let status: ProgramVerdict | null = null;
    if (session) {
      const checkpoint = await deps.readSessionCheckpoint(session).catch(() => null);
      const specPath = sessionProgramSpec(session, checkpoint);
      const projectRoot = specPath ? await deps.projectRootOf(session.projectId) : null;
      if (specPath && projectRoot) {
        const fetchNote = await deps.refresher.refresh(projectRoot, PROGRAM_MERGE_BASE, force);
        status = await computeVerdict({
          projectRoot,
          specPath,
          source: { kind: "worktree", worktreePath: session.worktreePath },
          fetchNote,
        });
      }
    }
    cache.set(sessionId, status);
    deps.broadcast(PROGRAM_IPC_CHANNELS.statusChanged, { sessionId, status } satisfies ProgramStatusChangedEvent);
    return status;
  }

  function schedule(sessionId: string): void {
    const pending = timers.get(sessionId);
    if (pending) clearTimeout(pending);
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        compute(sessionId, false).catch((error: unknown) => {
          console.error(`Could not refresh the program status of ${sessionId}:`, error);
        });
      }, debounceMs),
    );
  }

  const interval = setInterval(() => {
    for (const [sessionId, status] of cache) if (status) schedule(sessionId);
  }, deps.intervalMs ?? 300_000);
  interval.unref?.();

  return {
    async get(sessionId) {
      if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
      return compute(sessionId, false);
    },
    refresh(sessionId, options) {
      return compute(sessionId, options?.force === true);
    },
    onCheckpointChanged(projectId, checkpointPath) {
      void Promise.all([deps.projectRootOf(projectId), deps.listSessions(projectId)])
        .then(([projectRoot, sessions]) => {
          if (!projectRoot) return;
          const changed = resolve(projectRoot, checkpointPath);
          for (const session of sessions) {
            if (session.kind !== "feature" && session.kind !== "fix") continue;
            if (changed.startsWith(resolve(session.worktreePath) + sep)) schedule(session.id);
          }
        })
        .catch((error: unknown) => {
          console.error(`Could not route checkpoint ${checkpointPath} to program status:`, error);
        });
    },
    forget(sessionId) {
      cache.delete(sessionId);
      const pending = timers.get(sessionId);
      if (pending) clearTimeout(pending);
      timers.delete(sessionId);
    },
    close() {
      clearInterval(interval);
      for (const pending of timers.values()) clearTimeout(pending);
      timers.clear();
    },
  };
}
