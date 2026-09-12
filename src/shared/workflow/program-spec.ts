/**
 * A PROGRAM spec: a short spec that splits a feature too big for one checkpoint
 * into CHILDREN, each a normal checkpoint. The machine contract is the
 * `# Hijos` table (`| # | Hijo | Spec | Checkpoint | Depende de | Estado |`);
 * everything else in the file is prose for the architect. The children's REAL
 * state comes from each child's checkpoint `status:`, never from the table
 * alone — the table is a promise the architect refreshes, the checkpoint is
 * the fact. Mirrors `programChildren` in the workflow's `wf-done.ts`.
 */

export type ProgramChildState = "PENDING" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "UNKNOWN";

export interface ProgramChild {
  index: number;
  name: string;
  /** Repo-relative path, or null while the child has not been started. */
  spec: string | null;
  checkpoint: string | null;
  /** Child indexes this one depends on, as written (`1, 2`). */
  dependsOn: number[];
  /** State as written in the table; `resolveProgram` replaces it with the checkpoint's. */
  state: ProgramChildState;
}

export interface ProgramSpec {
  title: string;
  children: ProgramChild[];
}

export interface ResolvedProgram extends ProgramSpec {
  /** The child `wf next` would open: first PENDING whose dependencies are all DONE. */
  next: ProgramChild | null;
  /** Every child DONE. */
  complete: boolean;
}

const EMPTY_CELL = /^[–\-—]?$/;

function cleanCell(cell: string): string {
  const trimmed = cell.replace(/[`*]/g, "").trim();
  return EMPTY_CELL.test(trimmed) ? "" : trimmed;
}

function parseState(raw: string): ProgramChildState {
  const upper = raw.toUpperCase();
  if (upper === "PENDING" || upper === "IN_PROGRESS" || upper === "BLOCKED" || upper === "DONE") return upper;
  return "UNKNOWN";
}

/** `# Hijos` rows, by column position; returns null when the file is not a program. */
export function parseProgramSpec(markdown: string): ProgramSpec | null {
  const start = markdown.search(/^# Hijos[^\n]*$/m);
  if (start === -1) return null;
  const rest = markdown.slice(start + 1);
  const end = rest.search(/^# /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const children: ProgramChild[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.replace(/\\\|/g, "").split("|");
    if (cells.length < 8) continue;
    const dependsOn = cleanCell(cells[5] ?? "")
      .split(/[,\s]+/)
      .map((token) => Number.parseInt(token, 10))
      .filter((value) => Number.isFinite(value));
    children.push({
      index: Number.parseInt(cells[1] ?? "", 10),
      name: cleanCell(cells[2] ?? ""),
      spec: cleanCell(cells[3] ?? "") || null,
      checkpoint: cleanCell(cells[4] ?? "") || null,
      dependsOn,
      state: parseState(cleanCell(cells[6] ?? "")),
    });
  }
  if (children.length === 0) return null;
  const title = markdown.match(/^#\s+(?!Hijos)([^\n]+)$/m)?.[1]?.trim() ?? "Programa";
  return { title, children };
}

/**
 * Replace the table's state with each checkpoint's real `status:` (when the
 * caller could read it) and compute what `wf next` would do.
 */
export function resolveProgram(
  spec: ProgramSpec,
  checkpointStatus: (checkpointPath: string) => string | null,
): ResolvedProgram {
  const children = spec.children.map((child) => {
    if (!child.checkpoint) return { ...child, state: "PENDING" as const };
    const status = checkpointStatus(child.checkpoint);
    return status === null ? child : { ...child, state: parseState(status) };
  });
  const done = new Set(children.filter((child) => child.state === "DONE").map((child) => child.index));
  const next =
    children.find((child) => child.state === "PENDING" && child.dependsOn.every((dependency) => done.has(dependency))) ??
    null;
  const complete = children.length > 0 && children.every((child) => child.state === "DONE");
  return { ...spec, children, next, complete };
}

/** The exact phrase the architect runs to open the next child; the path is repo-relative. */
export function wfNextCommand(programSpecPath: string): string {
  return `wf next ${programSpecPath}`;
}

/** `feature:` of a child, as the workflow rules write it. */
export function programChildFeatureName(program: ProgramSpec, child: ProgramChild): string {
  return `${program.title} · ${child.index}/${program.children.length} ${child.name}`;
}
