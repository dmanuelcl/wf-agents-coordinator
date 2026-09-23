/**
 * A PROGRAM spec: a short spec that splits a feature too big for one checkpoint
 * into CHILDREN, each a normal checkpoint. The machine contract is the
 * `# Hijos` table (`| # | Hijo | Spec | Checkpoint | Depende de | Estado |`);
 * everything else in the file is prose for the architect. The children's REAL
 * state comes from each child's checkpoint `status:`, never from the table
 * alone — the table is a promise the architect refreshes, the checkpoint is
 * the fact.
 *
 * The coordinator must reach the verdict the architect's `pnpm wf:next`
 * reaches, so this ports the workflow's reading of a program from Biznex
 * `scripts/wf-done.ts` and `scripts/wf-next.ts` at 802fb00cb, regex for regex.
 * The verdict itself is `program-verdict.ts`.
 */

/** A `# Hijos` row exactly as the workflow's tolerant reader (`programChildren`) sees it. Empty cells (`–`) are "". */
export interface ProgramRow {
  index: number;
  name: string;
  spec: string;
  checkpoint: string;
  dependsOn: string;
  state: string;
}

const PROGRAM_SECTION = /^# Hijos[^\n]*$/m;

/** The machine contract needs a level-1 `# Hijos` heading; `## §4. Hijos` is invisible to it. */
export function hasProgramSection(markdown: string): boolean {
  return PROGRAM_SECTION.test(markdown);
}

/**
 * The `# Hijos` table lines, trimmed and outside ``` / ~~~ blocks — the SAME set
 * for the tolerant and the strict reader (`programTableLines`). When they
 * differed, an indented row was seen by one and not the other.
 */
export function programTableLines(markdown: string): string[] {
  const start = markdown.search(PROGRAM_SECTION);
  if (start === -1) return [];
  const rest = markdown.slice(markdown.indexOf("\n", start) + 1);
  const end = rest.search(/^# /m);
  const lines: string[] = [];
  let fenced = false;
  for (const line of (end === -1 ? rest : rest.slice(0, end)).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && line.trim().startsWith("|")) lines.push(line.trim());
  }
  return lines;
}

/** `Hijos: <n>` at the start of a line, never across a line break (`HIJOS_DECLARED`). */
export const HIJOS_DECLARED = /^[ \t>·#-]*[`*_]*Hijos[`*_]*[ \t]*:[ \t]*[`*_]*[ \t]*(\d+)/m;
/** The user's exception counts only as its own line; quoted mid-sentence in prose it adds nothing. */
const CHILD_ADDED = /^[ \t>*_-]*Hijo añadido por el usuario:[ \t]*«/gm;

export function childrenAddedByUser(markdown: string): number {
  return markdown.match(CHILD_ADDED)?.length ?? 0;
}

export function programRows(markdown: string): ProgramRow[] {
  const rows: ProgramRow[] = [];
  for (const line of programTableLines(markdown)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line
      .replace(/\\\|/g, "\u0001")
      .split("|")
      .map((cell) => cell.replace(/[`*]/g, "").trim());
    if (cells.length < 8) continue;
    const clean = (cell: string): string => (/^[–\-—]?$/.test(cell) ? "" : cell);
    rows.push({
      index: Number.parseInt(cells[1] ?? "", 10),
      name: cells[2] ?? "",
      spec: clean(cells[3] ?? ""),
      checkpoint: clean(cells[4] ?? ""),
      dependsOn: clean(cells[5] ?? ""),
      state: (cells[6] ?? "").toUpperCase(),
    });
  }
  return rows;
}

export const PROGRAM_STATES = ["PENDING", "IN_PROGRESS", "DONE"] as const;
const PROGRAM_HEADER = ["#", "Hijo", "Spec", "Checkpoint", "Depende de", "Estado"];
const STRICT_EMPTY_CELL = /^[–\-—]$/;

/**
 * The STRICT `# Hijos` contract (`programTableErrors`): anything the machine
 * cannot read is a named error, never silently skipped. `programRows` is the
 * tolerant reader that ignores a broken row; this names it.
 */
export function programTableErrors(markdown: string, specPath: string): string[] {
  if (!hasProgramSection(markdown)) return []; // a missing section is reported by the verdict itself
  const lines = programTableLines(markdown);
  const errors: string[] = [];
  const where = `${specPath} · # Hijos`;
  const cellsOf = (line: string): string[] =>
    line
      .trim()
      .replace(/\\\|/g, "\u0001")
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.replace(/[`*]/g, "").trim());
  const [header, separator, ...rows] = lines;
  if (!header || cellsOf(header).join(" | ") !== PROGRAM_HEADER.join(" | ")) {
    return [`${where}: la cabecera tiene que ser \`| ${PROGRAM_HEADER.join(" | ")} |\` (leída: \`${header?.trim() ?? "(ninguna)"}\`)`];
  }
  if (!separator || !/^\|(\s*:?-+:?\s*\|)+$/.test(separator.trim())) {
    errors.push(`${where}: falta la línea separadora \`|---|---|…|\` bajo la cabecera`);
  }
  rows.forEach((line, i) => {
    const cells = cellsOf(line);
    const expected = i + 1;
    const label = `${where}, fila ${expected}`;
    if (cells.length !== 6) {
      errors.push(`${label}: ${cells.length} celdas, se esperan 6 (${PROGRAM_HEADER.join(" · ")}): \`${line.trim()}\``);
      return;
    }
    const [index, name, spec, checkpoint, dependsOn, state] = cells as [string, string, string, string, string, string];
    if (index !== String(expected)) errors.push(`${label}: \`#\` es «${index}» y se esperaba ${expected} — los hijos se numeran 1, 2, 3… en orden`);
    if (!name) errors.push(`${label}: \`Hijo\` vacío`);
    if (!(PROGRAM_STATES as readonly string[]).includes(state)) {
      errors.push(`${label}: Estado «${state}» — tiene que ser ${PROGRAM_STATES.join(" | ")}, en mayúsculas exactas`);
    }
    if (!STRICT_EMPTY_CELL.test(spec) && !/^\S+\.md$/.test(spec)) errors.push(`${label}: Spec «${spec}» — una ruta \`.md\` relativa al worktree, o \`–\``);
    if (!STRICT_EMPTY_CELL.test(checkpoint) && !/^\S+-checkpoint\.md$/.test(checkpoint)) {
      errors.push(`${label}: Checkpoint «${checkpoint}» — una ruta \`*-checkpoint.md\` relativa al worktree, o \`–\``);
    }
    if (state === "PENDING" && !STRICT_EMPTY_CELL.test(checkpoint)) {
      errors.push(`${label}: está PENDING y nombra un Checkpoint — un hijo con checkpoint está IN_PROGRESS o DONE`);
    }
    if (!STRICT_EMPTY_CELL.test(dependsOn)) {
      if (!/^\d+(\s*,\s*\d+)*$/.test(dependsOn)) {
        errors.push(`${label}: Depende de «${dependsOn}» — números de hijo separados por comas, o \`–\``);
      } else {
        for (const dependency of dependsOn.split(",").map((value) => Number.parseInt(value.trim(), 10))) {
          if (dependency < 1 || dependency >= expected) {
            errors.push(`${label}: el hijo ${expected} depende de ${dependency} — sólo se depende de un hijo anterior`);
          }
        }
      }
    }
  });
  const declared = markdown.match(HIJOS_DECLARED)?.[1];
  if (!declared) {
    errors.push(`${specPath}: falta \`Hijos: <n>\` a inicio de línea — el programa declara al nacer cuántos hijos tiene`);
  } else {
    const added = childrenAddedByUser(markdown);
    const total = Number.parseInt(declared, 10) + added;
    if (rows.length !== total) {
      errors.push(`${specPath}: \`# Hijos\` tiene ${rows.length} filas y el programa declara \`Hijos: ${declared}\`${added > 0 ? ` (+${added} añadidos por el usuario)` : ""}`);
    }
  }
  return errors;
}

/** `- **Programa:** <ruta>` anywhere in a checkpoint. Backticks and `[texto](ruta)` name the path, not the format. */
export function programPathOf(checkpointText: string): string | null {
  const raw = checkpointText.match(/^[ \t-]*\*\*Programa:\*\*[ \t]*([^\n]+)/m)?.[1]?.trim();
  if (!raw) return null;
  return (raw.match(/\]\(([^)\s]+)\)/)?.[1] ?? raw.replace(/`/g, "").split(/\s+/)[0]) || null;
}

export function frontmatterStatus(checkpointText: string): string | null {
  const frontmatter = checkpointText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return frontmatter?.[1]?.match(/^status:\s*([A-Z_]+)/m)?.[1] ?? null;
}

/** The `Estado` a checkpoint's `status:` dictates: DONE when it closed, IN_PROGRESS otherwise. */
export function derivedChildState(status: string | null): "IN_PROGRESS" | "DONE" {
  return status === "DONE" ? "DONE" : "IN_PROGRESS";
}

export function programTitle(markdown: string): string {
  return markdown.match(/^#\s+(?!Hijos)([^\n]+)$/m)?.[1]?.trim() ?? "Programa";
}

export function rowDependencies(row: Pick<ProgramRow, "dependsOn">): number[] {
  return (row.dependsOn.match(/\d+/g) ?? []).map((value) => Number.parseInt(value, 10));
}

/** Repo-relative paths as the table and checkpoints write them, compared without `./` or doubled slashes. */
export function normalizeRepoPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

/** The program spec a `wf next <spec>` phrase names, or null for anything else. */
export function wfNextSpecOf(text: string | null | undefined): string | null {
  return text?.match(/^\s*wf next\s+(\S+\.md)\s*$/)?.[1] ?? null;
}

/** The exact phrase the architect runs to open the next child; the path is repo-relative. */
export function wfNextCommand(programSpecPath: string): string {
  return `wf next ${programSpecPath}`;
}

/** `feature:` of a child, as the workflow rules write it: `<Programa> · <n>/<N> <hijo>`. */
export function programChildFeatureName(title: string, total: number, child: { index: number; name: string }): string {
  return `${title} · ${child.index}/${total} ${child.name}`;
}
