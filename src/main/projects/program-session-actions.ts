import { wfNextCommand } from "../../shared/workflow/program-spec";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import type { WorkSession } from "../../shared/workflow/work-session";

export interface ProgramSessionActions {
  /** «Iniciar hijo N en esta sesión»: only on READY, re-checked here with a forced fetch. */
  startChild(sessionId: string): Promise<WorkSession>;
  /** «Seguir el hijo N en esta sesión»: bind to a child already IN_PROGRESS. */
  adoptChild(sessionId: string, index: number): Promise<WorkSession>;
}

/**
 * The session that holds a program's worktree advances from child to child
 * (children share the branch, and git allows a branch in one worktree only).
 * Nothing here trusts what the UI showed: the verdict is recomputed first, and
 * the session record changes only once it allows the move.
 */
export function createProgramSessionActions(deps: {
  getSession(sessionId: string): Promise<WorkSession | null>;
  refreshStatus(sessionId: string, force: boolean): Promise<ProgramVerdict | null>;
  updateSessionProgram(params: { sessionId: string; checkpointPath: string | null; program: string; initialPrompt: string | null }): Promise<WorkSession>;
  /** Drop any running gate watch and start one with the session's current (program-filtered) params. */
  rewatchCheckpoint(session: WorkSession): Promise<void>;
  unwatchCheckpoint(sessionId: string): Promise<void>;
  resetAutopilot(sessionId: string): Promise<void>;
  beginFreshTurn(sessionId: string, role: SessionAgentRole, command: string): Promise<void>;
  /** Same signal as a detected checkpoint: viewers flip their gate, auto-pilot reads it. */
  announceCheckpoint(sessionId: string, checkpointPath: string): Promise<void>;
  broadcastSession(session: WorkSession): void;
}): ProgramSessionActions {
  async function sessionOrThrow(sessionId: string): Promise<WorkSession> {
    const session = await deps.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  async function verdictOrThrow(sessionId: string, force: boolean): Promise<ProgramVerdict> {
    const verdict = await deps.refreshStatus(sessionId, force);
    if (!verdict) throw new Error("Esta sesión no pertenece a ningún programa.");
    return verdict;
  }

  return {
    async startChild(sessionId) {
      await sessionOrThrow(sessionId);
      const verdict = await verdictOrThrow(sessionId, true);
      if (verdict.verdict !== "READY" || !verdict.next) {
        throw new Error(["No se puede iniciar el siguiente hijo:", ...verdict.reasons.map((reason) => `· ${reason}`)].join("\n"));
      }
      const command = wfNextCommand(verdict.specPath);
      const updated = await deps.updateSessionProgram({ sessionId, checkpointPath: null, program: verdict.specPath, initialPrompt: command });
      await deps.rewatchCheckpoint(updated);
      await deps.resetAutopilot(sessionId);
      deps.broadcastSession(updated);
      try {
        await deps.beginFreshTurn(sessionId, "architect", command);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `La sesión quedó lista para el hijo ${verdict.next.index}, pero no se pudo relanzar el Architect: ${detail}. Escribe \`${command}\` en el tab Architect.`,
        );
      } finally {
        void deps.refreshStatus(sessionId, false).catch(() => {});
      }
      return updated;
    },

    async adoptChild(sessionId, index) {
      await sessionOrThrow(sessionId);
      const verdict = await verdictOrThrow(sessionId, false);
      const child = verdict.children.find((candidate) => candidate.index === index);
      if (!child?.checkpoint || child.state !== "IN_PROGRESS" || child.linked !== true) {
        throw new Error(
          `El hijo ${index} no se puede seguir desde esta sesión: tiene que tener checkpoint, estar IN_PROGRESS y declarar \`Programa: ${verdict.specPath}\`.`,
        );
      }
      await deps.unwatchCheckpoint(sessionId);
      const updated = await deps.updateSessionProgram({ sessionId, checkpointPath: child.checkpoint, program: verdict.specPath, initialPrompt: null });
      await deps.resetAutopilot(sessionId);
      deps.broadcastSession(updated);
      await deps.announceCheckpoint(sessionId, child.checkpoint);
      void deps.refreshStatus(sessionId, false).catch(() => {});
      return updated;
    },
  };
}
