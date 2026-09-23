import {
  derivedChildState,
  frontmatterStatus,
  normalizeRepoPath,
  programPathOf,
  programRows,
  programTableErrors,
  programTitle,
  rowDependencies,
} from "./program-spec";
import type { ProgramRow } from "./program-spec";

/** The branch every child of a program integrates into (Biznex `PROGRAM_MERGE_BASE`). */
export const PROGRAM_MERGE_BASE = "origin/develop";

export type ProgramChildState = "PENDING" | "IN_PROGRESS" | "DONE";
export type ChildMergeState = "merged" | "unmerged" | "uncommitted" | "unknown";

export interface ChildMerge {
  state: ChildMergeState;
  /** The commit that set `status: DONE` in the child's checkpoint, when one exists. */
  closeSha: string | null;
  /** Why this blocks the program; null once merged. */
  reason: string | null;
}

export interface ProgramChildView {
  index: number;
  name: string;
  spec: string | null;
  checkpoint: string | null;
  dependsOn: number[];
  /** From the checkpoint's `status:`, never from the table's column; PENDING while the row has no checkpoint. */
  state: ProgramChildState;
  /** Whether the checkpoint declares `Programa: <this spec>`; null without a readable checkpoint. */
  linked: boolean | null;
  /** DONE children only. */
  merge: ChildMerge | null;
}

export type ProgramVerdictKind = "READY" | "COMPLETE" | "BLOCKED";

export interface ProgramVerdict {
  specPath: string;
  title: string;
  verdict: ProgramVerdictKind;
  /** READY only: the child `wf next` opens. */
  next: ProgramChildView | null;
  children: ProgramChildView[];
  /** BLOCKED: every line, worded like `pnpm wf:next`. */
  reasons: string[];
  /** Never blocking (a stale `Estado` column). */
  hints: string[];
  base: string;
  fetchNote: string | null;
  checkedAtEpochMs: number;
}

export interface ProgramVerdictInput {
  specPath: string;
  /** null: the spec does not exist. */
  programText: string | null;
  /** Checkpoint text by the path the table names; a missing key means the file does not exist. */
  checkpoints: ReadonlyMap<string, string>;
  /** Merge result per DONE child (see `doneChildRows`); a DONE child missing here is unverifiable. */
  merges: ReadonlyMap<number, ChildMerge>;
  /** `programBirthErrors`: the index grew past what the spec was born with (needs git history, so main reads it). */
  birthErrors?: readonly string[];
  base: string;
  fetchNote: string | null;
  checkedAtEpochMs: number;
}

/** The rows whose checkpoint exists and says DONE: the ones whose merge has to be checked. */
export function doneChildRows(programText: string, checkpoints: ReadonlyMap<string, string>): ProgramRow[] {
  return programRows(programText).filter((row) => {
    const text = row.checkpoint ? checkpoints.get(row.checkpoint) : undefined;
    return text !== undefined && frontmatterStatus(text) === "DONE";
  });
}

export function blockedProgramVerdict(params: {
  specPath: string;
  reason: string;
  base: string;
  fetchNote: string | null;
  checkedAtEpochMs: number;
}): ProgramVerdict {
  return {
    specPath: params.specPath,
    title: params.specPath.split("/").pop() ?? params.specPath,
    verdict: "BLOCKED",
    next: null,
    children: [],
    reasons: [params.reason],
    hints: [],
    base: params.base,
    fetchNote: params.fetchNote,
    checkedAtEpochMs: params.checkedAtEpochMs,
  };
}

function tableState(row: ProgramRow): ProgramChildState {
  return row.state === "DONE" || row.state === "PENDING" ? row.state : "IN_PROGRESS";
}

/**
 * `nextChild` of Biznex scripts/wf-next.ts (802fb00cb), without file I/O. The
 * caller reads the files and the merge state; this decides. Same order of
 * reasons, same verdict — except that a stale `Estado` column is a hint,
 * because the architect runs `wf:next --write`, which rewrites it first.
 */
export function decideProgramVerdict(input: ProgramVerdictInput): ProgramVerdict {
  const { specPath, programText, checkpoints, merges, base, fetchNote, checkedAtEpochMs } = input;
  const common = { specPath, base, fetchNote, checkedAtEpochMs };
  if (programText === null) return blockedProgramVerdict({ ...common, reason: `el spec-programa no existe: ${specPath}` });
  const title = programTitle(programText);
  const rows = programRows(programText);
  if (rows.length === 0) {
    return { ...blockedProgramVerdict({ ...common, reason: `${specPath} no tiene la sección \`# Hijos\` con su tabla` }), title };
  }

  const reasons = [...programTableErrors(programText, specPath), ...(input.birthErrors ?? [])];
  const hints: string[] = [];
  const done = new Set<number>();
  const children: ProgramChildView[] = [];
  const pending: ProgramChildView[] = [];
  for (const row of rows) {
    const view = {
      index: row.index,
      name: row.name,
      spec: row.spec || null,
      checkpoint: row.checkpoint || null,
      dependsOn: rowDependencies(row),
    };
    if (!row.checkpoint) {
      const child: ProgramChildView = { ...view, state: "PENDING", linked: null, merge: null };
      children.push(child);
      pending.push(child);
      continue;
    }
    const text = checkpoints.get(row.checkpoint);
    if (text === undefined) {
      reasons.push(`hijo ${row.index}: la fila nombra \`${row.checkpoint}\` y no existe`);
      children.push({ ...view, state: tableState(row), linked: null, merge: null });
      continue;
    }
    const declared = programPathOf(text);
    const linked = declared !== null && normalizeRepoPath(declared) === normalizeRepoPath(specPath);
    if (!linked) {
      reasons.push(
        `hijo ${row.index}: su checkpoint declara \`Programa: ${declared ?? "(nada)"}\` y tiene que ser \`- **Programa:** ${specPath}\` — el enlace va en los dos sentidos`,
      );
    }
    const status = frontmatterStatus(text);
    const state = derivedChildState(status);
    if (row.state !== state) {
      hints.push(`hijo ${row.index}: la columna Estado dice ${row.state || "(vacío)"} y su checkpoint dice ${state} — \`pnpm wf:next ${specPath} --write\` la corrige`);
    }
    if (status === "DONE") done.add(row.index);
    else reasons.push(`hijo ${row.index} (${row.name}) sigue ${status ?? "sin status:"} — los hijos se abren de a uno: ciérralo antes de abrir otro`);
    children.push({ ...view, state, linked, merge: null });
  }

  for (const child of children) {
    if (!done.has(child.index)) continue;
    const merge = merges.get(child.index) ?? {
      state: "unknown",
      closeSha: null,
      reason: `hijo ${child.index}: no se pudo verificar su merge en ${base}`,
    };
    child.merge = merge;
    if (merge.reason) reasons.push(merge.reason);
  }

  const verdict = { specPath, title, children, hints, base, fetchNote, checkedAtEpochMs };
  if (reasons.length > 0) return { ...verdict, verdict: "BLOCKED", next: null, reasons };
  if (pending.length === 0) return { ...verdict, verdict: "COMPLETE", next: null, reasons: [] };
  const ready = pending.find((child) => child.dependsOn.every((index) => done.has(index)));
  if (ready) return { ...verdict, verdict: "READY", next: ready, reasons: [] };
  const waiting = pending.map((child) => `hijo ${child.index} espera ${child.dependsOn.filter((index) => !done.has(index)).join(", ")}`);
  return { ...verdict, verdict: "BLOCKED", next: null, reasons: [`ningún hijo PENDING tiene sus dependencias DONE: ${waiting.join(" · ")}`] };
}
