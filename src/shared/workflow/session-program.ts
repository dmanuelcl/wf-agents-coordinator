import { wfNextSpecOf } from "./program-spec";
import type { WorkSession } from "./work-session";
import type { ParsedCheckpoint } from "./workflow-types";

type ProgramSessionFields = Pick<WorkSession, "kind" | "program" | "initialPrompt">;

function isWorkflowFeature(session: ProgramSessionFields): boolean {
  return session.kind === "feature" || session.kind === "fix";
}

/**
 * The program a session belongs to, in priority order: the one it advanced
 * through; the `Programa:` of the checkpoint it is bound to (a child); the
 * `wf next <spec>` its checkpoint's NEXT runs (a parent that spawned the program,
 * or a closed child pointing at the next one); the `wf next <spec>` it was
 * created with (a child session still waiting for its checkpoint).
 */
export function sessionProgramSpec(
  session: ProgramSessionFields,
  checkpoint: Pick<ParsedCheckpoint, "program" | "next"> | null,
): string | null {
  if (!isWorkflowFeature(session)) return null;
  if (session.program) return session.program;
  const pointer = checkpoint?.program?.replace(/`/g, "") || null;
  if (pointer) return pointer;
  return wfNextSpecOf(checkpoint?.next?.command) ?? wfNextSpecOf(session.initialPrompt);
}

/** The program whose child a checkpoint-less session waits for; only then is its binding filtered. */
export function watchProgramSpec(session: ProgramSessionFields): string | null {
  if (!isWorkflowFeature(session)) return null;
  return session.program ?? wfNextSpecOf(session.initialPrompt);
}
