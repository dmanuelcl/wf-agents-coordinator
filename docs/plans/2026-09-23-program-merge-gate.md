# Program Merge Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The coordinator computes the same READY / COMPLETE / BLOCKED verdict as Biznex `pnpm wf:next`, including the "every DONE child is merged into `origin/develop`" gate. It shows that verdict where a developer cannot miss it (session banner on every tab, a «Programa» panel in the Log tab, a rail badge, the new-session dialog), and lets the session that holds a program's worktree advance to the next child or adopt an in-progress child.

**Architecture:** A pure verdict module in `src/shared/workflow` ports the workflow's contract (`programChildren`, `programTableErrors`, `nextChild`). Main adds a git adapter (`childMerge`, a throttled `git fetch`), a reader that feeds the verdict from a worktree or a ref, and a status service that recomputes on checkpoint events and every 5 minutes, then broadcasts. Two session actions (start child / adopt child) re-validate in main before they change the session record, re-arm a program-filtered checkpoint watch, and relaunch the Architect fresh. The renderer only renders the broadcast status.

**Tech Stack:** Electron + React 18 + TypeScript (strict, `noUncheckedIndexedAccess`), vitest, git CLI via `execFile`.

**Spec:** `docs/specs/2026-09-23-program-merge-gate-design.md`

## Global Constraints

- Run tests with `pnpm test` (it rebuilds `better-sqlite3` for Node first). Never raw `vitest`. A single file: `pnpm test -- src/path/file.spec.ts`.
- Typecheck with `pnpm typecheck`. It must pass at the end of every task.
- Merge base is fixed: `origin/develop` (`PROGRAM_MERGE_BASE`), the same as Biznex `a29f1cac4`.
- Verdict semantics mirror Biznex `scripts/wf-next.ts` `nextChild` at `a29f1cac4`, with **one** deliberate difference: a stale `Estado` column is a hint, not a reason.
- Every new UI string is Spanish with **tú** (no voseo). Keep the workflow's own words: «hijo», «programa», «merjeado», `DONE` / `IN_PROGRESS` / `PENDING`.
- No browser dialogs (`alert` / `confirm`). Confirmations are inline.
- An unverifiable merge (git error, missing `origin/develop`) **blocks**. It never yields READY.
- **Do not commit.** The user decides at the end whether to commit, and how.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/shared/workflow/program-spec.ts` | modify | The `# Hijos` contract: tolerant reader, strict contract, checkpoint helpers, `wf next` phrase |
| `src/shared/workflow/program-verdict.ts` | create | Pure `decideProgramVerdict` + verdict types |
| `src/shared/workflow/session-program.ts` | create | Which program a session belongs to / waits on |
| `src/shared/workflow/work-session.ts` | modify | `program?: string` on `WorkSession` |
| `src/main/projects/program-merge.ts` | create | `childMerge` (git), `createMergeBaseRefresher` (throttled fetch) |
| `src/main/projects/program-status.ts` | create | `readProgramVerdict` from a worktree or a ref |
| `src/main/projects/ref-programs.ts` | rewrite | Dialog listing returns verdicts |
| `src/main/projects/program-status-service.ts` | create | Cache + recompute + broadcast per session |
| `src/main/projects/program-session-actions.ts` | create | Start child / adopt child, validated in main |
| `src/main/projects/session-checkpoint-watch-params.ts` | create | One source for session watch params (runtime + IPC) |
| `src/main/projects/session-checkpoint-watch-manager.ts` | modify | `programSpecPath` binding filter |
| `src/main/projects/session-registry.ts` | modify | `updateSessionProgram` |
| `src/main/projects/session-orchestrator.ts` | modify | `beginFreshTurn`, `resetAutopilot`, `forceFresh` option |
| `src/main/ipc/register-ipc-handlers.ts` | modify | Refresher injection, watch params helper, `forceFresh` |
| `src/main/runtime/coordinator-runtime.ts` | modify | Wiring: service, actions, handlers, events |
| `src/shared/ipc/contract.ts`, `src/preload/agent-coordinator-api.ts` | modify | Channels, events, API |
| `src/renderer/components/program-display.ts` | create | Pure banner / badge / label logic |
| `src/renderer/components/use-program-actions.ts` | create | Renderer hook for the three actions |
| `src/renderer/components/ProgramPanel.tsx` | create | `ProgramNotice`, `ProgramPanel`, action buttons |
| `src/renderer/components/session-notice.tsx` | modify | Optional `actions` slot |
| `src/renderer/components/SessionView.tsx`, `ProjectRail.tsx`, `NewSessionDialog.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css` | modify | Render and wire |

---

### Task 1: The `# Hijos` contract in `program-spec.ts`

**Files:**
- Modify: `src/shared/workflow/program-spec.ts` (append; the old `parseProgramSpec` / `resolveProgram` stay until Task 4)
- Test: `src/shared/workflow/program-spec.spec.ts` (append)

**Interfaces:**
- Produces:
  - `interface ProgramRow { index: number; name: string; spec: string; checkpoint: string; dependsOn: string; state: string }`. Empty cells are `""`.
  - `hasProgramSection(markdown: string): boolean`
  - `programRows(markdown: string): ProgramRow[]`
  - `programTableErrors(markdown: string, specPath: string): string[]`
  - `PROGRAM_STATES`
  - `programPathOf(checkpointText: string): string | null`
  - `frontmatterStatus(checkpointText: string): string | null`
  - `derivedChildState(status: string | null): "IN_PROGRESS" | "DONE"`
  - `programTitle(markdown: string): string`
  - `rowDependencies(row: Pick<ProgramRow, "dependsOn">): number[]`
  - `normalizeRepoPath(path: string): string`
  - `wfNextSpecOf(text: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing tests** — append to `src/shared/workflow/program-spec.spec.ts`:

```ts
import {
  derivedChildState,
  frontmatterStatus,
  hasProgramSection,
  normalizeRepoPath,
  programPathOf,
  programRows,
  programTableErrors,
  programTitle,
  rowDependencies,
  wfNextSpecOf,
} from "./program-spec";

// Fixtures ported from Biznex scripts/__tests__/wf-next.spec.ts (a29f1cac4).
const X_SPEC = "docs/workflow/specs/x-programa.md";
const X_CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const X_CP2 = "docs/workflow/checkpoints/x-2-checkpoint.md";
const TABLE = (rows: string, hijos: string | null = "2"): string =>
  `# Programa X\n${hijos === null ? "" : `Hijos: ${hijos}\n`}\n# Hijos\n| # | Hijo | Spec | Checkpoint | Depende de | Estado |\n|---|---|---|---|---|---|\n${rows}\n\n# Contratos\n`;
const OK1 = `| 1 | Uno | docs/workflow/specs/x-1.md | ${X_CP1} | – | DONE |`;
const OK2 = "| 2 | Dos | – | – | 1 | PENDING |";

describe("programRows (the workflow's tolerant reader)", () => {
  it("reads rows by position, `–` as empty, the state upper-cased", () => {
    expect(programRows(TABLE([OK1, OK2].join("\n")))).toEqual([
      { index: 1, name: "Uno", spec: "docs/workflow/specs/x-1.md", checkpoint: X_CP1, dependsOn: "", state: "DONE" },
      { index: 2, name: "Dos", spec: "", checkpoint: "", dependsOn: "1", state: "PENDING" },
    ]);
  });

  it("finds nothing under `## §4. Hijos`: the section must be `# Hijos`", () => {
    const text = TABLE([OK1, OK2].join("\n")).replace("# Hijos", "## §4. Hijos");
    expect(hasProgramSection(text)).toBe(false);
    expect(programRows(text)).toEqual([]);
  });
});

describe("programTableErrors (the strict contract)", () => {
  const errors = (rows: string, hijos: string | null = "2"): string => programTableErrors(TABLE(rows, hijos), X_SPEC).join("\n");

  it("accepts a well-formed table", () => {
    expect(programTableErrors(TABLE([OK1, OK2].join("\n")), X_SPEC)).toEqual([]);
    expect(
      programTableErrors(TABLE([OK1, "| 2 | Dos | – | – | 1, 1 | PENDING |", "| 3 | Tres | – | – | 1,2 | PENDING |"].join("\n"), "3"), X_SPEC),
    ).toEqual([]);
  });

  it("names every invalid shape instead of skipping it", () => {
    expect(errors([OK1, "| 2 | Dos | – | 1 | PENDING |"].join("\n"))).toMatch(/5 celdas/);
    expect(errors([OK1, "| 2 | Dos | – | – | 1 | Hecho |"].join("\n"))).toMatch(/Estado «Hecho»/);
    expect(errors([OK1, "| 2 | Dos | – | – | 1 | done |"].join("\n"))).toMatch(/Estado «done»/);
    expect(errors([OK1, "| 3 | Tres | – | – | 1 | PENDING |"].join("\n"))).toMatch(/se esperaba 2/);
    expect(errors([OK1, "| 2 | Dos | – | – | uno | PENDING |"].join("\n"))).toMatch(/Depende de «uno»/);
    expect(errors(["| 1 | Uno | – | – | 2 | PENDING |", OK2].join("\n"))).toMatch(/hijo 1 depende de 2.*anterior/);
    expect(errors([OK1, `| 2 | Dos | – | ${X_CP2} | 1 | PENDING |`].join("\n"))).toMatch(/PENDING.*Checkpoint/);
    expect(errors([OK1.replace(X_CP1, "docs/workflow/checkpoints/x-1.md"), OK2].join("\n"))).toMatch(/-checkpoint\.md/);
    expect(errors([OK1.replace("docs/workflow/specs/x-1.md", "x-1"), OK2].join("\n"))).toMatch(/Spec «x-1»/);
    expect(errors([OK1, OK2].join("\n"), null)).toMatch(/Hijos: <n>/);
    expect(errors([OK1, OK2].join("\n"), "3")).toMatch(/2 filas.*Hijos: 3/);
    expect(programTableErrors(TABLE(OK1, "1").replace("| Depende de |", "| Deps |"), X_SPEC).join("\n")).toMatch(/cabecera/);
  });
});

describe("checkpoint and phrase helpers", () => {
  const checkpoint = (status: string): string =>
    `---\nfeature: X · 1/2 Uno\nstatus: ${status}\n---\n# ▶ NEXT\n\n# Architect memory\n- **Programa:** ${X_SPEC}\n`;

  it("reads the Programa pointer and the frontmatter status like the workflow", () => {
    expect(programPathOf(checkpoint("DONE"))).toBe(X_SPEC);
    expect(programPathOf("# Architect memory\n- nada\n")).toBeNull();
    expect(frontmatterStatus(checkpoint("IN_PROGRESS"))).toBe("IN_PROGRESS");
    expect(frontmatterStatus("sin frontmatter")).toBeNull();
    expect(derivedChildState("DONE")).toBe("DONE");
    expect(derivedChildState("BLOCKED")).toBe("IN_PROGRESS");
    expect(derivedChildState(null)).toBe("IN_PROGRESS");
  });

  it("titles, dependencies, paths and the `wf next` phrase", () => {
    expect(programTitle(TABLE(OK1, "1"))).toBe("Programa X");
    expect(rowDependencies({ dependsOn: "1, 2" })).toEqual([1, 2]);
    expect(rowDependencies({ dependsOn: "" })).toEqual([]);
    expect(normalizeRepoPath("./docs//workflow/x.md")).toBe("docs/workflow/x.md");
    expect(wfNextSpecOf("wf next docs/workflow/specs/x-programa.md")).toBe(X_SPEC);
    expect(wfNextSpecOf("wf verify docs/workflow/checkpoints/x-checkpoint.md")).toBeNull();
    expect(wfNextSpecOf(undefined)).toBeNull();
  });
});
```

(Merge the new names into the file's existing `import` from `./program-spec` instead of adding a second import line.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/shared/workflow/program-spec.spec.ts`
Expected: FAIL. The new functions are not exported (`programRows is not a function`, or a TS import error).

- [ ] **Step 3: Implement** — append to `src/shared/workflow/program-spec.ts`:

```ts
// ---------------------------------------------------------------------------
// The workflow's own reading of a program, ported from Biznex scripts/wf-done.ts
// and scripts/wf-next.ts at a29f1cac4. The coordinator must reach the verdict the
// architect's `pnpm wf:next` reaches, so these mirror it regex for regex.
// ---------------------------------------------------------------------------

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

export function programRows(markdown: string): ProgramRow[] {
  const start = markdown.search(PROGRAM_SECTION);
  if (start === -1) return [];
  const rest = markdown.slice(start + 1);
  const end = rest.search(/^# /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows: ProgramRow[] = [];
  for (const line of section.split(/\r?\n/)) {
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
  const start = markdown.search(PROGRAM_SECTION);
  if (start === -1) return []; // a missing section is reported by the verdict itself
  const rest = markdown.slice(markdown.indexOf("\n", start) + 1);
  const end = rest.search(/^# /m);
  const lines = (end === -1 ? rest : rest.slice(0, end)).split(/\r?\n/).filter((line) => line.trim().startsWith("|"));
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
  const declared = markdown.match(/^[ \t>·#-]*[`*_]*Hijos[`*_]*\s*:\s*[`*_]*\s*(\d+)/im)?.[1];
  if (!declared) {
    errors.push(`${specPath}: falta \`Hijos: <n>\` a inicio de línea — el programa declara al nacer cuántos hijos tiene`);
  } else {
    const added = markdown.match(/Hijo añadido por el usuario:\s*«/g)?.length ?? 0;
    const total = Number.parseInt(declared, 10) + added;
    if (rows.length !== total) {
      errors.push(`${specPath}: \`# Hijos\` tiene ${rows.length} filas y el programa declara \`Hijos: ${declared}\`${added > 0 ? ` (+${added} añadidos por el usuario)` : ""}`);
    }
  }
  return errors;
}

/** `- **Programa:** <ruta>` anywhere in a checkpoint — the workflow's `programPathOf`, backticks and all. */
export function programPathOf(checkpointText: string): string | null {
  return checkpointText.match(/^[ \t-]*\*\*Programa:\*\*\s*([^\s]+)/m)?.[1] ?? null;
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/shared/workflow/program-spec.spec.ts`
Expected: PASS (the old `parseProgramSpec` / `resolveProgram` tests still pass too).

- [ ] **Step 5: Typecheck** — `pnpm typecheck` → exit 0.

---

### Task 2: The verdict (`program-verdict.ts`)

**Files:**
- Create: `src/shared/workflow/program-verdict.ts`
- Test: `src/shared/workflow/program-verdict.spec.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces:
  - `PROGRAM_MERGE_BASE = "origin/develop"`
  - `type ProgramChildState = "PENDING" | "IN_PROGRESS" | "DONE"`
  - `type ChildMergeState = "merged" | "unmerged" | "uncommitted" | "unknown"`
  - `interface ChildMerge { state: ChildMergeState; closeSha: string | null; reason: string | null }`
  - `interface ProgramChildView { index; name; spec: string | null; checkpoint: string | null; dependsOn: number[]; state: ProgramChildState; linked: boolean | null; merge: ChildMerge | null }`
  - `type ProgramVerdictKind = "READY" | "COMPLETE" | "BLOCKED"`
  - `interface ProgramVerdict { specPath; title; verdict: ProgramVerdictKind; next: ProgramChildView | null; children: ProgramChildView[]; reasons: string[]; hints: string[]; base: string; fetchNote: string | null; checkedAtEpochMs: number }`
  - `interface ProgramVerdictInput { specPath; programText: string | null; checkpoints: ReadonlyMap<string, string>; merges: ReadonlyMap<number, ChildMerge>; base: string; fetchNote: string | null; checkedAtEpochMs: number }`
  - `decideProgramVerdict(input: ProgramVerdictInput): ProgramVerdict`
  - `doneChildRows(programText: string, checkpoints: ReadonlyMap<string, string>): ProgramRow[]`
  - `blockedProgramVerdict(params: { specPath; reason; base; fetchNote; checkedAtEpochMs }): ProgramVerdict`

- [ ] **Step 1: Write the failing test** — `src/shared/workflow/program-verdict.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideProgramVerdict, doneChildRows } from "./program-verdict";
import type { ChildMerge, ProgramVerdictInput } from "./program-verdict";

const SPEC = "docs/workflow/specs/x-programa.md";
const CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const CP2 = "docs/workflow/checkpoints/x-2-checkpoint.md";
const program = (rows: string[], hijos = 3): string =>
  `# Programa X\nHijos: ${hijos}\n\n# Hijos\n| # | Hijo | Spec | Checkpoint | Depende de | Estado |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n\n# Contratos\n- ninguno\n`;
const ROW1 = (state: string): string => `| 1 | Uno | docs/workflow/specs/x-1.md | ${CP1} | – | ${state} |`;
// No dependency on child 1: exactly the case the old resolver let through.
const ROW2_PENDING = "| 2 | Dos | – | – | – | PENDING |";
const ROW2_OPEN = `| 2 | Dos | docs/workflow/specs/x-2.md | ${CP2} | – | IN_PROGRESS |`;
const ROW3_PENDING = "| 3 | Tres | – | – | 2 | PENDING |";
const checkpoint = (status: string, programPath = SPEC): string =>
  `---\nfeature: X\nstatus: ${status}\n---\n# ▶ NEXT\n\n# Architect memory\n- **Programa:** ${programPath}\n`;
const MERGED: ChildMerge = { state: "merged", closeSha: "a".repeat(40), reason: null };
const UNMERGED: ChildMerge = {
  state: "unmerged",
  closeSha: "b".repeat(40),
  reason: "hijo 1: su commit de cierre bbbbbbbbbb no está en origin/develop — abre el PR",
};

function input(overrides: Partial<ProgramVerdictInput>): ProgramVerdictInput {
  return {
    specPath: SPEC,
    programText: program([ROW1("DONE"), ROW2_PENDING, ROW3_PENDING]),
    checkpoints: new Map([[CP1, checkpoint("DONE")]]),
    merges: new Map([[1, MERGED]]),
    base: "origin/develop",
    fetchNote: null,
    checkedAtEpochMs: 1,
    ...overrides,
  };
}

describe("decideProgramVerdict", () => {
  it("READY: every DONE child merged; the first PENDING child whose dependencies are DONE", () => {
    const verdict = decideProgramVerdict(input({}));
    expect(verdict.verdict).toBe("READY");
    expect(verdict.next?.index).toBe(2);
    expect(verdict.children[0]).toMatchObject({ state: "DONE", linked: true, merge: MERGED });
    expect(verdict.reasons).toEqual([]);
  });

  it("BLOCKED: a DONE child whose PR is not merged, saying why", () => {
    const verdict = decideProgramVerdict(input({ merges: new Map([[1, UNMERGED]]) }));
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.next).toBeNull();
    expect(verdict.reasons).toEqual([UNMERGED.reason]);
    expect(verdict.children[0]?.merge?.state).toBe("unmerged");
  });

  it("BLOCKED: a DONE child with no merge result is unverifiable, never READY", () => {
    const verdict = decideProgramVerdict(input({ merges: new Map() }));
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons.join("\n")).toMatch(/hijo 1: no se pudo verificar su merge en origin\/develop/);
  });

  it("BLOCKED: one at a time — child 1 IN_PROGRESS stops child 2 even without a declared dependency", () => {
    const verdict = decideProgramVerdict(
      input({
        programText: program([ROW1("IN_PROGRESS"), ROW2_PENDING, ROW3_PENDING]),
        checkpoints: new Map([[CP1, checkpoint("IN_PROGRESS")]]),
        merges: new Map(),
      }),
    );
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons.join("\n")).toMatch(/hijo 1 \(Uno\) sigue IN_PROGRESS — los hijos se abren de a uno/);
  });

  it("COMPLETE: every child DONE and merged", () => {
    const verdict = decideProgramVerdict(
      input({
        programText: program([ROW1("DONE"), `| 2 | Dos | docs/workflow/specs/x-2.md | ${CP2} | – | DONE |`], 2),
        checkpoints: new Map([
          [CP1, checkpoint("DONE")],
          [CP2, checkpoint("DONE")],
        ]),
        merges: new Map([
          [1, MERGED],
          [2, MERGED],
        ]),
      }),
    );
    expect(verdict.verdict).toBe("COMPLETE");
    expect(verdict.next).toBeNull();
  });

  it("BLOCKED: a child's checkpoint must point back to the program", () => {
    const verdict = decideProgramVerdict(input({ checkpoints: new Map([[CP1, checkpoint("DONE", "docs/workflow/specs/otro.md")]]) }));
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.children[0]?.linked).toBe(false);
    expect(verdict.reasons.join("\n")).toMatch(/hijo 1: su checkpoint declara `Programa: docs\/workflow\/specs\/otro\.md`/);
  });

  it("BLOCKED: a row that names a checkpoint that does not exist", () => {
    const verdict = decideProgramVerdict(input({ checkpoints: new Map(), merges: new Map() }));
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons.join("\n")).toMatch(/hijo 1: la fila nombra `docs\/workflow\/checkpoints\/x-1-checkpoint\.md` y no existe/);
  });

  it("a stale Estado column is a hint, not a reason — `wf:next --write` rewrites it before deciding", () => {
    const verdict = decideProgramVerdict(input({ programText: program([ROW1("IN_PROGRESS"), ROW2_PENDING, ROW3_PENDING]) }));
    expect(verdict.verdict).toBe("READY");
    expect(verdict.hints.join("\n")).toMatch(/hijo 1: la columna Estado dice IN_PROGRESS y su checkpoint dice DONE/);
  });

  it("BLOCKED: a table that breaks the contract", () => {
    const verdict = decideProgramVerdict(input({ programText: program([ROW1("DONE"), "| 2 | Dos | – | – | – | Pendiente |", ROW3_PENDING]) }));
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons.join("\n")).toMatch(/Estado «Pendiente»/);
  });

  it("BLOCKED: no spec, or a table under `## §4. Hijos` (the real Biznex program on 2026-09-23)", () => {
    expect(decideProgramVerdict(input({ programText: null })).reasons).toEqual([`el spec-programa no existe: ${SPEC}`]);
    const misplaced = decideProgramVerdict(
      input({ programText: program([ROW1("DONE"), ROW2_PENDING, ROW3_PENDING]).replace("# Hijos", "## §4. Hijos") }),
    );
    expect(misplaced.verdict).toBe("BLOCKED");
    expect(misplaced.reasons).toEqual([`${SPEC} no tiene la sección \`# Hijos\` con su tabla`]);
    expect(misplaced.title).toBe("Programa X");
  });
});

describe("doneChildRows", () => {
  it("returns the rows whose checkpoint exists and says DONE", () => {
    const rows = doneChildRows(
      program([ROW1("DONE"), ROW2_OPEN, ROW3_PENDING]),
      new Map([
        [CP1, checkpoint("DONE")],
        [CP2, checkpoint("IN_PROGRESS")],
      ]),
    );
    expect(rows.map((row) => row.index)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/shared/workflow/program-verdict.spec.ts`
Expected: FAIL, `Cannot find module './program-verdict'`.

- [ ] **Step 3: Implement** — `src/shared/workflow/program-verdict.ts`:

```ts
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
 * `nextChild` of Biznex scripts/wf-next.ts (a29f1cac4), without file I/O. The
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

  const reasons = [...programTableErrors(programText, specPath)];
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/shared/workflow/program-verdict.spec.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck** — `pnpm typecheck` → exit 0.

---

### Task 3: Merge check and throttled fetch (`program-merge.ts`)

**Files:**
- Create: `src/main/projects/program-merge.ts`
- Test: `src/main/projects/program-merge.spec.ts`

**Interfaces:**
- Consumes: `frontmatterStatus` (Task 1), `ChildMerge` (Task 2).
- Produces:
  - `type GitRunner = (args: string[]) => Promise<string | null>`
  - `createGitRunner(cwd: string): GitRunner`
  - `childMerge(params: { git: GitRunner; index: number; checkpointPath: string; ref: string; base: string; fetchNote: string | null }): Promise<ChildMerge>`
  - `interface MergeBaseRefresher { refresh(projectRoot: string, base: string, force: boolean): Promise<string | null> }`
  - `createMergeBaseRefresher(params?: { intervalMs?: number; now?: () => number; runGit?: (cwd: string, args: string[]) => Promise<string | null> }): MergeBaseRefresher`

- [ ] **Step 1: Write the failing test** — `src/main/projects/program-merge.spec.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childMerge, createGitRunner, createMergeBaseRefresher } from "./program-merge";

const SPEC = "docs/workflow/specs/x-programa.md";
const CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const checkpoint = (status: string): string =>
  `---\nfeature: X · 1/2 Uno\nstatus: ${status}\n---\n# ▶ NEXT\n\n# Architect memory\n- **Programa:** ${SPEC}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `develop` with child 1 open, and `feature/x` where child 1 closes in its own commit (Biznex's wf-next fixture). */
function programRepo(): { root: string; git: (...args: string[]) => string; closeSha: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-coordinator-program-merge-"));
  roots.push(root);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  mkdirSync(join(root, "docs/workflow/checkpoints"), { recursive: true });
  writeFileSync(join(root, CP1), checkpoint("IN_PROGRESS"));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/develop", "develop");
  git("checkout", "-q", "-b", "feature/x");
  writeFileSync(join(root, "work.ts"), "export const x = 1;\n");
  writeFileSync(join(root, CP1), checkpoint("DONE"));
  git("add", ".");
  git("commit", "-q", "-m", "cierre hijo 1");
  return { root, git, closeSha: git("rev-parse", "HEAD") };
}

const merge = (root: string, ref = "HEAD") =>
  childMerge({ git: createGitRunner(root), index: 1, checkpointPath: CP1, ref, base: "origin/develop", fetchNote: null });

describe("childMerge", () => {
  it("unmerged: the close commit is not in origin/develop, named by its SHA", async () => {
    const { root, closeSha } = programRepo();
    const result = await merge(root);
    expect(result.state).toBe("unmerged");
    expect(result.closeSha).toBe(closeSha);
    expect(result.reason).toContain(closeSha.slice(0, 10));
    expect(result.reason).toMatch(/origin\/develop/);
  });

  it("merged: a merge commit makes the close commit an ancestor", async () => {
    const { root, git } = programRepo();
    git("checkout", "-q", "develop");
    git("merge", "-q", "--no-ff", "-m", "Merged in feature/x (pull request #1)", "feature/x");
    git("update-ref", "refs/remotes/origin/develop", "develop");
    git("checkout", "-q", "feature/x");
    expect(await merge(root)).toMatchObject({ state: "merged", reason: null });
  });

  it("merged: a squash leaves no ancestor, but origin/develop already has the checkpoint DONE", async () => {
    const { root, git } = programRepo();
    git("checkout", "-q", "develop");
    git("merge", "-q", "--squash", "feature/x");
    git("commit", "-q", "-m", "squash hijo 1");
    git("update-ref", "refs/remotes/origin/develop", "develop");
    git("checkout", "-q", "feature/x");
    expect((await merge(root)).state).toBe("merged");
  });

  it("uncommitted: `status: DONE` exists only in the working tree", async () => {
    const { root, git } = programRepo();
    git("reset", "-q", "--soft", "HEAD~1");
    git("reset", "-q");
    const result = await merge(root);
    expect(result.state).toBe("uncommitted");
    expect(result.reason).toMatch(/no está commiteado/);
  });

  it("unknown: origin/develop does not exist, or the directory is not a repository", async () => {
    const { root, git } = programRepo();
    git("update-ref", "-d", "refs/remotes/origin/develop");
    expect(await merge(root)).toMatchObject({ state: "unknown" });
    const plain = mkdtempSync(join(tmpdir(), "agent-coordinator-not-a-repo-"));
    roots.push(plain);
    expect((await merge(plain)).reason).toMatch(/no es un repositorio git/);
  });

  it("reads another ref without checking it out", async () => {
    const { root, git, closeSha } = programRepo();
    git("checkout", "-q", "develop");
    expect(await merge(root, "feature/x")).toMatchObject({ state: "unmerged", closeSha });
  });
});

describe("createMergeBaseRefresher", () => {
  it("fetches at most once per interval unless forced, and reports a failed fetch", async () => {
    let now = 0;
    const runGit = vi.fn(async (_cwd: string, _args: string[]): Promise<string | null> => "");
    const refresher = createMergeBaseRefresher({ intervalMs: 1_000, now: () => now, runGit });
    expect(await refresher.refresh("/repo", "origin/develop", false)).toBeNull();
    expect(runGit).toHaveBeenCalledWith("/repo", ["fetch", "--quiet", "origin", "develop"]);
    now = 500;
    await refresher.refresh("/repo", "origin/develop", false);
    expect(runGit).toHaveBeenCalledTimes(1);
    await refresher.refresh("/repo", "origin/develop", true);
    expect(runGit).toHaveBeenCalledTimes(2);
    runGit.mockResolvedValueOnce(null);
    now = 5_000;
    expect(await refresher.refresh("/repo", "origin/develop", false)).toMatch(/no se pudo actualizar origin\/develop/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/main/projects/program-merge.spec.ts`
Expected: FAIL, `Cannot find module './program-merge'`.

- [ ] **Step 3: Implement** — `src/main/projects/program-merge.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { frontmatterStatus } from "../../shared/workflow/program-spec";
import type { ChildMerge } from "../../shared/workflow/program-verdict";

const execFileAsync = promisify(execFile);

/** Runs git in one directory: trimmed stdout, or null when git fails (a non-zero exit included). */
export type GitRunner = (args: string[]) => Promise<string | null>;

export function createGitRunner(cwd: string): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
}

const HOW = "abre el PR del hijo contra develop y espera a que esté merjeado: el siguiente hijo no se abre sobre un hijo sin merjear";

/**
 * `childMergeError` of Biznex scripts/wf-done.ts (a29f1cac4), reading `ref`
 * (HEAD for a worktree, a branch for the dialog) instead of always HEAD. The
 * close commit is the last one on `ref` that put `status: DONE` in the child's
 * checkpoint; merged means that commit is an ancestor of `base`. A squash merge
 * leaves no ancestor, so then it is enough that `base` already has the
 * checkpoint DONE. Anything unverifiable blocks.
 */
export async function childMerge(params: {
  git: GitRunner;
  index: number;
  checkpointPath: string;
  ref: string;
  base: string;
  fetchNote: string | null;
}): Promise<ChildMerge> {
  const { git, index, checkpointPath, ref, base, fetchNote } = params;
  const note = fetchNote ? ` (${fetchNote})` : "";
  if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") {
    return { state: "unknown", closeSha: null, reason: `hijo ${index}: no se pudo verificar su merge en ${base} — no es un repositorio git` };
  }
  if ((await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`])) === null) {
    return { state: "unknown", closeSha: null, reason: `hijo ${index}: no se pudo verificar su merge — \`${base}\` no existe${note}` };
  }
  const closeSha = (await git(["log", "-1", "--format=%H", "-G", "^status:[[:space:]]*DONE", ref, "--", checkpointPath])) || null;
  const closedAtSha = closeSha ? frontmatterStatus((await git(["show", `${closeSha}:${checkpointPath}`])) ?? "") === "DONE" : false;
  if (closeSha && closedAtSha && (await git(["merge-base", "--is-ancestor", closeSha, base])) !== null) {
    return { state: "merged", closeSha, reason: null };
  }
  if (frontmatterStatus((await git(["show", `${base}:${checkpointPath}`])) ?? "") === "DONE") {
    return { state: "merged", closeSha, reason: null };
  }
  if (!closeSha || !closedAtSha) {
    return {
      state: "uncommitted",
      closeSha: null,
      reason: `hijo ${index}: el cierre (\`status: DONE\` en ${checkpointPath}) no está commiteado — commitéalo, ${HOW}${note}`,
    };
  }
  return { state: "unmerged", closeSha, reason: `hijo ${index}: su commit de cierre ${closeSha.slice(0, 10)} no está en ${base} — ${HOW}${note}` };
}

export interface MergeBaseRefresher {
  /**
   * Refresh `<remote>/<branch>` at most once per interval per repo (always when
   * `force`). Returns the note to show when the fetch failed, else null. A stale
   * local copy can only block more, never let a child through.
   */
  refresh(projectRoot: string, base: string, force: boolean): Promise<string | null>;
}

export function createMergeBaseRefresher(
  params: { intervalMs?: number; now?: () => number; runGit?: (cwd: string, args: string[]) => Promise<string | null> } = {},
): MergeBaseRefresher {
  const intervalMs = params.intervalMs ?? 120_000;
  const now = params.now ?? Date.now;
  const runGit = params.runGit ?? ((cwd: string, args: string[]) => createGitRunner(cwd)(args));
  const last = new Map<string, { at: number; note: string | null }>();
  const inFlight = new Map<string, Promise<string | null>>();
  return {
    refresh(projectRoot, base, force) {
      const slash = base.indexOf("/");
      if (slash <= 0) return Promise.resolve(null);
      const key = `${projectRoot}\u0000${base}`;
      const previous = last.get(key);
      if (!force && previous && now() - previous.at < intervalMs) return Promise.resolve(previous.note);
      const running = inFlight.get(key);
      if (running) return running;
      const task = runGit(projectRoot, ["fetch", "--quiet", base.slice(0, slash), base.slice(slash + 1)]).then((output) => {
        const note = output === null ? `no se pudo actualizar ${base} con \`git fetch\`: se leyó la copia local` : null;
        last.set(key, { at: now(), note });
        inFlight.delete(key);
        return note;
      });
      inFlight.set(key, task);
      return task;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/main/projects/program-merge.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck** — `pnpm typecheck` → exit 0.

---

### Task 4: Read verdicts from a worktree or a ref; the dialog listing returns verdicts

**Files:**
- Create: `src/main/projects/program-status.ts`
- Test: `src/main/projects/program-status.spec.ts`
- Rewrite: `src/main/projects/ref-programs.ts`, `src/main/projects/ref-programs.spec.ts`
- Modify: `src/shared/workflow/program-spec.ts` (delete the old resolver), `src/shared/workflow/program-spec.spec.ts` (delete its tests)
- Modify: `src/shared/ipc/contract.ts`, `src/main/ipc/register-ipc-handlers.ts`
- Modify: `src/renderer/components/NewSessionDialog.tsx` (compile fix only; the UI comes in Task 9)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `type ProgramSource = { kind: "worktree"; worktreePath: string } | { kind: "ref"; ref: string }`
  - `readProgramVerdict(params: { projectRoot: string; specPath: string; source: ProgramSource; fetchNote: string | null; base?: string; now?: () => number }): Promise<ProgramVerdict>`
  - `listRefPrograms(params: { projectRoot: string; ref: string; fetchNote?: string | null }): Promise<ProgramVerdict[]>`
  - `programChildFeatureName(title: string, total: number, child: { index: number; name: string }): string`
  - `registerIpcHandlers` accepts `mergeBaseRefresher?: MergeBaseRefresher`
  - `AgentCoordinatorApi.git.listRefPrograms` resolves `ProgramVerdict[]`

- [ ] **Step 1: Write the failing test** — `src/main/projects/program-status.spec.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProgramVerdict } from "./program-status";

const SPEC = "docs/workflow/specs/x-programa.md";
const CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const program = (row1State: string): string =>
  `# Programa X\nHijos: 2\n\n# Hijos\n| # | Hijo | Spec | Checkpoint | Depende de | Estado |\n|---|---|---|---|---|---|\n| 1 | Uno | docs/workflow/specs/x-1.md | ${CP1} | – | ${row1State} |\n| 2 | Dos | – | – | 1 | PENDING |\n`;
const checkpoint = (status: string): string =>
  `---\nfeature: X · 1/2 Uno\nstatus: ${status}\n---\n# ▶ NEXT\n\n# Architect memory\n- **Programa:** ${SPEC}\n`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function programRepo(): { root: string; git: (...args: string[]) => string; closeSha: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-coordinator-program-status-"));
  roots.push(root);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  mkdirSync(join(root, "docs/workflow/specs"), { recursive: true });
  mkdirSync(join(root, "docs/workflow/checkpoints"), { recursive: true });
  writeFileSync(join(root, "docs/workflow/specs/x-1.md"), "# Uno\n");
  writeFileSync(join(root, SPEC), program("IN_PROGRESS"));
  writeFileSync(join(root, CP1), checkpoint("IN_PROGRESS"));
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/develop", "develop");
  git("checkout", "-q", "-b", "feature/x");
  writeFileSync(join(root, CP1), checkpoint("DONE"));
  writeFileSync(join(root, SPEC), program("DONE"));
  git("add", ".");
  git("commit", "-q", "-m", "cierre hijo 1");
  return { root, git, closeSha: git("rev-parse", "HEAD") };
}

describe("readProgramVerdict", () => {
  it("worktree: child 1 closed but not merged → BLOCKED, naming the close commit", async () => {
    const { root, closeSha } = programRepo();
    const verdict = await readProgramVerdict({ projectRoot: root, specPath: SPEC, source: { kind: "worktree", worktreePath: root }, fetchNote: null });
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons.join("\n")).toContain(closeSha.slice(0, 10));
    expect(verdict.children.map((child) => [child.index, child.state, child.merge?.state ?? null])).toEqual([
      [1, "DONE", "unmerged"],
      [2, "PENDING", null],
    ]);
  });

  it("worktree: with child 1's PR merged → READY child 2", async () => {
    const { root, git } = programRepo();
    git("checkout", "-q", "develop");
    git("merge", "-q", "--no-ff", "-m", "Merged in feature/x (pull request #1)", "feature/x");
    git("update-ref", "refs/remotes/origin/develop", "develop");
    git("checkout", "-q", "feature/x");
    const verdict = await readProgramVerdict({ projectRoot: root, specPath: SPEC, source: { kind: "worktree", worktreePath: root }, fetchNote: null });
    expect(verdict.verdict).toBe("READY");
    expect(verdict.next?.index).toBe(2);
  });

  it("ref: reads a branch without checking it out", async () => {
    const { root, git } = programRepo();
    git("checkout", "-q", "develop"); // the working tree now says IN_PROGRESS; the ref says DONE
    const verdict = await readProgramVerdict({ projectRoot: root, specPath: SPEC, source: { kind: "ref", ref: "feature/x" }, fetchNote: null });
    expect(verdict.children[0]?.state).toBe("DONE");
    expect(verdict.children[0]?.merge?.state).toBe("unmerged");
  });

  it("a spec that does not exist → BLOCKED, never a throw", async () => {
    const { root } = programRepo();
    const verdict = await readProgramVerdict({
      projectRoot: root,
      specPath: "docs/workflow/specs/nope.md",
      source: { kind: "worktree", worktreePath: root },
      fetchNote: "no se pudo actualizar origin/develop",
    });
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons).toEqual(["el spec-programa no existe: docs/workflow/specs/nope.md"]);
    expect(verdict.fetchNote).toBe("no se pudo actualizar origin/develop");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/main/projects/program-status.spec.ts`
Expected: FAIL, `Cannot find module './program-status'`.

- [ ] **Step 3: Implement** — `src/main/projects/program-status.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { programRows } from "../../shared/workflow/program-spec";
import { PROGRAM_MERGE_BASE, blockedProgramVerdict, decideProgramVerdict, doneChildRows } from "../../shared/workflow/program-verdict";
import type { ChildMerge, ProgramVerdict } from "../../shared/workflow/program-verdict";
import { childMerge, createGitRunner } from "./program-merge";

/**
 * Where a program is read from: a session's worktree (the files on disk and
 * HEAD, which is what `pnpm wf:next` reads) or a ref with no checkout (the
 * new-session dialog, before any worktree exists).
 */
export type ProgramSource = { kind: "worktree"; worktreePath: string } | { kind: "ref"; ref: string };

export async function readProgramVerdict(params: {
  projectRoot: string;
  specPath: string;
  source: ProgramSource;
  fetchNote: string | null;
  base?: string;
  now?: () => number;
}): Promise<ProgramVerdict> {
  const { projectRoot, specPath, source, fetchNote } = params;
  const base = params.base ?? PROGRAM_MERGE_BASE;
  const checkedAtEpochMs = (params.now ?? Date.now)();
  const git = createGitRunner(source.kind === "worktree" ? source.worktreePath : projectRoot);
  const ref = source.kind === "worktree" ? "HEAD" : source.ref;
  const read = async (path: string): Promise<string | null> => {
    if (source.kind === "ref") return git(["show", `${source.ref}:${path}`]);
    try {
      return await readFile(join(source.worktreePath, path), "utf8");
    } catch {
      return null;
    }
  };

  try {
    const programText = await read(specPath);
    const checkpoints = new Map<string, string>();
    const merges = new Map<number, ChildMerge>();
    if (programText !== null) {
      for (const row of programRows(programText)) {
        if (!row.checkpoint || checkpoints.has(row.checkpoint)) continue;
        const text = await read(row.checkpoint);
        if (text !== null) checkpoints.set(row.checkpoint, text);
      }
      for (const row of doneChildRows(programText, checkpoints)) {
        merges.set(row.index, await childMerge({ git, index: row.index, checkpointPath: row.checkpoint, ref, base, fetchNote }));
      }
    }
    return decideProgramVerdict({ specPath, programText, checkpoints, merges, base, fetchNote, checkedAtEpochMs });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return blockedProgramVerdict({ specPath, reason: `no se pudo leer el programa: ${detail}`, base, fetchNote, checkedAtEpochMs });
  }
}
```

- [ ] **Step 4: Rewrite `src/main/projects/ref-programs.ts`**:

```ts
import { hasProgramSection } from "../../shared/workflow/program-spec";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import { createGitRunner } from "./program-merge";
import { readProgramVerdict } from "./program-status";

const SPEC_DIR = "docs/workflow/specs/";

/**
 * The programs committed on a ref, each with the verdict `wf:next` would give —
 * WITHOUT checking the ref out, because the new-session dialog offers «Iniciar
 * hijo N» before any worktree exists. A spec is a program when it has a
 * `# Hijos` section; a broken table is listed as BLOCKED rather than hidden.
 * An unresolvable ref yields an empty list.
 */
export async function listRefPrograms(params: { projectRoot: string; ref: string; fetchNote?: string | null }): Promise<ProgramVerdict[]> {
  const git = createGitRunner(params.projectRoot);
  const tree = await git(["ls-tree", "-r", "--name-only", params.ref]);
  if (tree === null) return [];
  const paths = tree
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SPEC_DIR) && line.endsWith(".md") && !line.slice(SPEC_DIR.length).includes("/"))
    .sort();

  const found: ProgramVerdict[] = [];
  for (const path of paths) {
    const markdown = await git(["show", `${params.ref}:${path}`]);
    if (markdown === null || !hasProgramSection(markdown)) continue;
    found.push(
      await readProgramVerdict({
        projectRoot: params.projectRoot,
        specPath: path,
        source: { kind: "ref", ref: params.ref },
        fetchNote: params.fetchNote ?? null,
      }),
    );
  }
  return found;
}
```

- [ ] **Step 5: Rewrite `src/main/projects/ref-programs.spec.ts`**. Keep the existing file header, the `repoDir` / `git` / `write` helpers and `afterEach`. Replace the fixture, `beforeEach` and `describe`:

```ts
const PROGRAM = `# Programa · Ventas
Hijos: 2

# Hijos
| # | Hijo | Spec | Checkpoint | Depende de | Estado |
|---|------|------|------------|------------|--------|
| 1 | Catálogo | docs/workflow/specs/v-1.md | docs/workflow/checkpoints/v-1-checkpoint.md | – | IN_PROGRESS |
| 2 | Cobros | – | – | 1 | PENDING |
`;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-coordinator-refprog-"));
  git("init", "-q", "-b", "develop");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  write("docs/workflow/specs/ventas-programa.md", PROGRAM);
  write("docs/workflow/specs/otro-design.md", "# Un spec normal\n\n## §1\n");
  write("docs/workflow/specs/v-1.md", "# Hijo 1\n");
  write(
    "docs/workflow/checkpoints/v-1-checkpoint.md",
    [
      "---",
      "feature: Ventas · 1/2 Catálogo",
      "slug: v-1",
      "status: DONE",
      "---",
      "",
      "# ▶ NEXT",
      "- x",
      "",
      "# Architect memory",
      "- **Programa:** docs/workflow/specs/ventas-programa.md",
      "",
      "# Log",
      "",
    ].join("\n"),
  );
  git("add", ".");
  git("commit", "-q", "-m", "base");
  // Child 1 closed on develop itself, so it is merged.
  git("update-ref", "refs/remotes/origin/develop", "develop");
});

describe("listRefPrograms", () => {
  it("finds the program on the ref, ignores plain specs, and returns the verdict wf:next would give", async () => {
    const programs = await listRefPrograms({ projectRoot: repoDir, ref: "develop" });
    expect(programs).toHaveLength(1);
    expect(programs[0]).toMatchObject({ specPath: "docs/workflow/specs/ventas-programa.md", title: "Programa · Ventas", verdict: "READY" });
    expect(programs[0]?.children[0]?.state).toBe("DONE"); // the table said IN_PROGRESS; the checkpoint says DONE
    expect(programs[0]?.next?.index).toBe(2);
  });

  it("lists a spec whose `# Hijos` table is broken as BLOCKED instead of hiding it", async () => {
    write("docs/workflow/specs/roto-programa.md", "# Roto\nHijos: 1\n\n# Hijos\n| # | Hijo |\n|---|---|\n| 1 | Uno |\n");
    git("add", ".");
    git("commit", "-q", "-m", "roto");
    const programs = await listRefPrograms({ projectRoot: repoDir, ref: "develop" });
    const broken = programs.find((program) => program.specPath.endsWith("roto-programa.md"));
    expect(broken?.verdict).toBe("BLOCKED");
  });

  it("yields an empty list for a ref that does not resolve", async () => {
    expect(await listRefPrograms({ projectRoot: repoDir, ref: "no-such-ref" })).toEqual([]);
  });
});
```

- [ ] **Step 6: Delete the old resolver in `src/shared/workflow/program-spec.ts`.** Remove:
  - the file-top docblock's claim that `resolveProgram` exists (reword it to describe the contract);
  - `ProgramChildState`, `ProgramChild`, `ProgramSpec`, `ResolvedProgram`, `EMPTY_CELL`, `cleanCell`, `parseState`, `parseProgramSpec` and `resolveProgram`.

  Keep `wfNextCommand`. Replace `programChildFeatureName` with:

```ts
/** `feature:` of a child, as the workflow rules write it: `<Programa> · <n>/<N> <hijo>`. */
export function programChildFeatureName(title: string, total: number, child: { index: number; name: string }): string {
  return `${title} · ${child.index}/${total} ${child.name}`;
}
```

  In `program-spec.spec.ts`, delete the `PROGRAM` fixture and the `parseProgramSpec` / `resolveProgram` describes. Replace the `wfNextCommand / programChildFeatureName` describe with:

```ts
describe("wfNextCommand / programChildFeatureName", () => {
  it("builds the phrase the architect runs and the child's feature name", () => {
    expect(wfNextCommand("docs/workflow/specs/ventas-programa.md")).toBe("wf next docs/workflow/specs/ventas-programa.md");
    expect(programChildFeatureName("Programa · Ventas", 3, { index: 2, name: "Cobros" })).toBe("Programa · Ventas · 2/3 Cobros");
  });
});
```

- [ ] **Step 7: Contract.** In `src/shared/ipc/contract.ts`:
  - Delete `RefProgramChild` and `RefProgramSummary`, plus the two comment lines above them that describe a program on a ref.
  - Add `import type { ProgramVerdict } from "../workflow/program-verdict";` next to the other `../workflow/*` type imports.
  - Change `listRefPrograms(projectId: string, ref: string): Promise<RefProgramSummary[]>;` to:

```ts
    // Program specs committed on `ref` (a `# Hijos` section), each with the verdict `wf:next` would give.
    listRefPrograms(projectId: string, ref: string): Promise<ProgramVerdict[]>;
```

- [ ] **Step 8: IPC handler.** In `src/main/ipc/register-ipc-handlers.ts`:
  - Add imports:

```ts
import { PROGRAM_MERGE_BASE } from "../../shared/workflow/program-verdict";
import { createMergeBaseRefresher } from "../projects/program-merge";
import type { MergeBaseRefresher } from "../projects/program-merge";
```

  - Add `mergeBaseRefresher?: MergeBaseRefresher;` to the `registerIpcHandlers` params type (after `onSessionRemoved`). Destructure it as `mergeBaseRefresher = createMergeBaseRefresher(),`.
  - Replace the `gitListRefPrograms` handler body:

```ts
  ipc.handle(IPC_CHANNELS.gitListRefPrograms, async (_event, projectId: string, ref: string) => {
    const project = await findProject(projectRegistry, projectId);
    const fetchNote = await mergeBaseRefresher.refresh(project.rootPath, PROGRAM_MERGE_BASE, false);
    return listRefPrograms({ projectRoot: project.rootPath, ref, fetchNote });
  });
```

- [ ] **Step 9: Dialog compile fix** (`src/renderer/components/NewSessionDialog.tsx`). This is type plumbing only; Task 9 rebuilds the block.
  - Import: replace `RefProgramSummary` in the contract type import with nothing, and add `import type { ProgramVerdict } from "../../shared/workflow/program-verdict";`.
  - State: `useState<ProgramVerdict[] | null>(null)` for `refPrograms`.
  - In the program block: `program.path` → `program.specPath` (3 places). `program.complete` → `program.verdict === "COMPLETE"`. `programChildFeatureName(program, next)` → `programChildFeatureName(program.title, program.children.length, next)`. Guard the start button with `program.verdict === "READY" && program.next`.

- [ ] **Step 10: Run the tests and typecheck**

Run: `pnpm test -- src/main/projects/program-status.spec.ts src/main/projects/ref-programs.spec.ts src/shared/workflow/program-spec.spec.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exit 0. If anything else imported `parseProgramSpec`, `resolveProgram`, `RefProgramSummary` or `RefProgramChild`, `grep -rn` for it and migrate it the same way.

---

### Task 5: Which program a session belongs to, and a binding that cannot grab the wrong checkpoint

**Files:**
- Modify: `src/shared/workflow/work-session.ts`
- Create: `src/shared/workflow/session-program.ts`, test `src/shared/workflow/session-program.spec.ts`
- Create: `src/main/projects/session-checkpoint-watch-params.ts`, test `src/main/projects/session-checkpoint-watch-params.spec.ts`
- Modify: `src/main/projects/session-checkpoint-watch-manager.ts`, test `src/main/projects/session-checkpoint-watch-manager.spec.ts` (append)
- Modify: `src/main/ipc/register-ipc-handlers.ts`, `src/main/runtime/coordinator-runtime.ts` (use the params helper)

**Interfaces:**
- Consumes: `wfNextSpecOf`, `programPathOf`, `frontmatterStatus`, `normalizeRepoPath` (Task 1).
- Produces:
  - `WorkSession.program?: string`
  - `sessionProgramSpec(session: Pick<WorkSession, "kind" | "program" | "initialPrompt">, checkpoint: Pick<ParsedCheckpoint, "program" | "next"> | null): string | null`
  - `watchProgramSpec(session: Pick<WorkSession, "kind" | "program" | "initialPrompt">): string | null`
  - `export interface WatchSessionParams { …; programSpecPath?: string }`
  - `sessionCheckpointWatchParams(session: WorkSession): WatchSessionParams`

- [ ] **Step 1: Write the failing tests.**

`src/shared/workflow/session-program.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sessionProgramSpec, watchProgramSpec } from "./session-program";
import type { WorkflowNext } from "./workflow-types";

const next = (command: string): WorkflowNext => ({
  role: "architect",
  command,
  cwd: null,
  tier: null,
  task: null,
  sessionLane: "architect",
  rawMarkdown: "",
});
const feature = { kind: "feature" as const, program: undefined, initialPrompt: undefined };

describe("sessionProgramSpec", () => {
  it("prefers the persisted program, then the checkpoint's Programa pointer, then its NEXT, then the initial prompt", () => {
    expect(sessionProgramSpec({ ...feature, program: "a.md" }, { program: "b.md", next: null })).toBe("a.md");
    expect(sessionProgramSpec(feature, { program: "`b.md`", next: null })).toBe("b.md");
    expect(sessionProgramSpec(feature, { program: null, next: next("wf next c.md") })).toBe("c.md");
    expect(sessionProgramSpec({ ...feature, initialPrompt: "wf next d.md" }, null)).toBe("d.md");
    expect(sessionProgramSpec(feature, { program: null, next: next("wf verify x-checkpoint.md") })).toBeNull();
  });

  it("PR sessions never belong to a program", () => {
    expect(sessionProgramSpec({ kind: "pr-fix", program: "a.md", initialPrompt: undefined }, null)).toBeNull();
  });
});

describe("watchProgramSpec", () => {
  it("filters the binding only for a session waiting on a program child", () => {
    expect(watchProgramSpec({ ...feature, program: "a.md" })).toBe("a.md");
    expect(watchProgramSpec({ ...feature, initialPrompt: "wf next d.md" })).toBe("d.md");
    expect(watchProgramSpec(feature)).toBeNull();
  });
});
```

`src/main/projects/session-checkpoint-watch-params.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prFixCompletionCheckpointPath } from "../../shared/workflow/pr-fix-kickoff";
import type { WorkSession } from "../../shared/workflow/work-session";
import { sessionCheckpointWatchParams } from "./session-checkpoint-watch-params";

function session(overrides: Partial<WorkSession>): WorkSession {
  return {
    id: "s1",
    projectId: "p",
    name: "S",
    kind: "feature",
    slug: "s",
    branch: "feature/s",
    baseBranch: null,
    pr: null,
    worktreePath: "/repo/.worktrees/s",
    checkpointPath: null,
    setupDone: true,
    createdAtEpochMs: 7,
    ...overrides,
  };
}

describe("sessionCheckpointWatchParams", () => {
  it("a PR fix waits for its exact completion checkpoint", () => {
    expect(sessionCheckpointWatchParams(session({ kind: "pr-fix", slug: "fix-pr-1" }))).toMatchObject({
      expectedCheckpointPath: prFixCompletionCheckpointPath("fix-pr-1"),
      programSpecPath: undefined,
    });
  });

  it("a session waiting on a program child only accepts that program's checkpoints", () => {
    expect(sessionCheckpointWatchParams(session({ initialPrompt: "wf next docs/workflow/specs/p.md" })).programSpecPath).toBe(
      "docs/workflow/specs/p.md",
    );
    expect(sessionCheckpointWatchParams(session({ program: "docs/workflow/specs/q.md" })).programSpecPath).toBe("docs/workflow/specs/q.md");
  });

  it("an ordinary feature session keeps the unfiltered gate", () => {
    expect(sessionCheckpointWatchParams(session({}))).toEqual({
      sessionId: "s1",
      worktreePath: "/repo/.worktrees/s",
      createdAtEpochMs: 7,
      expectedCheckpointPath: undefined,
      programSpecPath: undefined,
    });
  });
});
```

Append to `src/main/projects/session-checkpoint-watch-manager.spec.ts`, inside the outer `describe` (add `mkdirSync` and `writeFileSync` to its `node:fs` import if missing):

```ts
  describe("with a program filter", () => {
    const SPEC = "docs/workflow/specs/x-programa.md";
    const checkpointsDir = (): string => join(worktree, "docs", "workflow", "checkpoints");
    const write = (name: string, body: string): string => {
      mkdirSync(checkpointsDir(), { recursive: true });
      const path = join(checkpointsDir(), name);
      writeFileSync(path, body);
      return path;
    };
    const child = (status: string): string => `---\nstatus: ${status}\n---\n# Architect memory\n- **Programa:** ${SPEC}\n`;
    const parent = "---\nstatus: IN_PROGRESS\n---\n# Architect memory\n- nada\n";

    it("ignores the parent's checkpoint and a DONE sibling, and binds the child that declares the program", async () => {
      const { createWatcher, watchers } = makeFakeCreateWatcher();
      const onCheckpointDetected = vi.fn();
      const manager = createSessionCheckpointWatchManager({ createWatcher, debounceMs: 0, onCheckpointDetected });
      await manager.watchSession({ sessionId: "s1", worktreePath: worktree, createdAtEpochMs: 0, programSpecPath: SPEC });

      watchers[0]?.emitChange(write("parent-checkpoint.md", parent));
      watchers[0]?.emitChange(write("x-1-checkpoint.md", child("DONE")));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onCheckpointDetected).not.toHaveBeenCalled();

      watchers[0]?.emitChange(write("x-2-checkpoint.md", child("IN_PROGRESS")));
      await vi.waitFor(() => expect(onCheckpointDetected).toHaveBeenCalledWith("s1", "docs/workflow/checkpoints/x-2-checkpoint.md"));
      expect(onCheckpointDetected).toHaveBeenCalledTimes(1);
    });

    it("applies the same filter to checkpoints that already exist when the watch starts", async () => {
      write("x-2-checkpoint.md", child("IN_PROGRESS"));
      write("parent-checkpoint.md", parent); // newer: unfiltered, it would win
      const onCheckpointDetected = vi.fn();
      const { createWatcher } = makeFakeCreateWatcher();
      const manager = createSessionCheckpointWatchManager({ createWatcher, debounceMs: 0, onCheckpointDetected });
      await manager.watchSession({ sessionId: "s1", worktreePath: worktree, createdAtEpochMs: 0, programSpecPath: SPEC });
      expect(onCheckpointDetected).toHaveBeenCalledWith("s1", "docs/workflow/checkpoints/x-2-checkpoint.md");
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test -- src/shared/workflow/session-program.spec.ts src/main/projects/session-checkpoint-watch-params.spec.ts src/main/projects/session-checkpoint-watch-manager.spec.ts`
Expected: FAIL. The two new modules are missing, and the filter tests bind the parent.

- [ ] **Step 3: Implement.**

`src/shared/workflow/work-session.ts`: add to `WorkSession`, after `initialPrompt`:

```ts
  // The program this session advances through (repo-relative spec path), set
  // once it starts or adopts one of the program's children.
  program?: string;
```

`src/shared/workflow/session-program.ts`:

```ts
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
```

`src/main/projects/session-checkpoint-watch-params.ts`:

```ts
import { prFixCompletionCheckpointPath } from "../../shared/workflow/pr-fix-kickoff";
import { watchProgramSpec } from "../../shared/workflow/session-program";
import type { WorkSession } from "../../shared/workflow/work-session";
import type { WatchSessionParams } from "./session-checkpoint-watch-manager";

/**
 * The one place that decides how a session's checkpoint gate is watched. The
 * runtime (on start) and the IPC layer (on create/list) both used to build this
 * inline, and the program filter must reach both.
 */
export function sessionCheckpointWatchParams(session: WorkSession): WatchSessionParams {
  return {
    sessionId: session.id,
    worktreePath: session.worktreePath,
    createdAtEpochMs: session.createdAtEpochMs,
    expectedCheckpointPath: session.kind === "pr-fix" ? prFixCompletionCheckpointPath(session.slug) : undefined,
    programSpecPath: watchProgramSpec(session) ?? undefined,
  };
}
```

`src/main/projects/session-checkpoint-watch-manager.ts`:
  - imports: `import { mkdir, readdir, readFile, stat } from "node:fs/promises";` and `import { frontmatterStatus, normalizeRepoPath, programPathOf } from "../../shared/workflow/program-spec";`
  - add, above `existingSessionCheckpoint`:

```ts
/**
 * A session waiting on a program's next child shares its worktree with the
 * parent's checkpoint and with every closed sibling. The architect may touch
 * those first, so "the first checkpoint that changes" is not the child's: only
 * a checkpoint that declares `Programa: <this spec>` and is not DONE is.
 */
async function acceptsCheckpoint(absolutePath: string, programSpecPath: string | undefined): Promise<boolean> {
  if (!programSpecPath) return true;
  try {
    const text = await readFile(absolutePath, "utf8");
    const declared = programPathOf(text);
    return declared !== null && normalizeRepoPath(declared) === normalizeRepoPath(programSpecPath) && frontmatterStatus(text) !== "DONE";
  } catch {
    return false;
  }
}
```

  - `existingSessionCheckpoint(dir, createdAtEpochMs, expectedFilename?, programSpecPath?)`: add the 4th parameter. Inside the per-entry `map`, after the `info.isFile() && info.mtimeMs > createdAtEpochMs` check, require `await acceptsCheckpoint(path, programSpecPath)`:

```ts
        try {
          const info = await stat(path);
          if (!info.isFile() || info.mtimeMs <= createdAtEpochMs) return null;
          return (await acceptsCheckpoint(path, programSpecPath)) ? { path, mtimeMs: info.mtimeMs } : null;
        } catch {
          return null;
        }
```

  - `interface WatchSessionParams` → `export interface WatchSessionParams`, adding:

```ts
  /** A program child's session: bind only a checkpoint of this program that is not DONE. */
  programSpecPath?: string;
```

  - In `start`: destructure `programSpecPath`, pass it to `existingSessionCheckpoint(checkpointDir, createdAtEpochMs, expectedFilename, programSpecPath)`, and replace `handleCandidate`:

```ts
    let bound = false;
    const handleCandidate = (absoluteFilePath: string): void => {
      if (!watchers.has(sessionId)) return;
      if (!CHECKPOINT_FILENAME_PATTERN.test(basename(absoluteFilePath))) return;
      if (expectedFilename && basename(absoluteFilePath) !== expectedFilename) return;
      void acceptsCheckpoint(absoluteFilePath, programSpecPath).then((accepted) => {
        // Reading the file is async: another accepted event may have bound first.
        if (!accepted || bound || !watchers.has(sessionId)) return;
        bound = true;
        const checkpointPath = relative(worktreePath, absoluteFilePath);
        // One checkpoint per session: once the gate flips, stop watching.
        void stop(sessionId);
        onCheckpointDetected(sessionId, checkpointPath);
      });
    };
```

`src/main/ipc/register-ipc-handlers.ts`: import `sessionCheckpointWatchParams` from `"../projects/session-checkpoint-watch-params"`. In `watchSessionCheckpoint`, replace the inline object with:

```ts
    await sessionCheckpointWatchManager.watchSession(sessionCheckpointWatchParams(session));
```

If `prFixCompletionCheckpointPath` is now unused in that file, drop its import.

`src/main/runtime/coordinator-runtime.ts`: import the helper and replace the startup `.map((session) => sessionCheckpointWatchManager.watchSession({ … }))` with `.map((session) => sessionCheckpointWatchManager.watchSession(sessionCheckpointWatchParams(session)))`. Drop the `prFixCompletionCheckpointPath` import if it is now unused.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test -- src/shared/workflow/session-program.spec.ts src/main/projects/session-checkpoint-watch-params.spec.ts src/main/projects/session-checkpoint-watch-manager.spec.ts`
Expected: PASS. The existing watch-manager tests pass unchanged, because there is no filter without `programSpecPath`.

- [ ] **Step 5: Typecheck** — `pnpm typecheck` → exit 0.

---

### Task 6: Program status service and its IPC

**Files:**
- Create: `src/main/projects/program-status-service.ts`, test `src/main/projects/program-status-service.spec.ts`
- Modify: `src/shared/ipc/contract.ts`, `src/preload/agent-coordinator-api.ts`, `src/main/runtime/coordinator-runtime.ts`

**Interfaces:**
- Consumes: `readProgramVerdict` (Task 4), `sessionProgramSpec` (Task 5), `MergeBaseRefresher` (Task 3).
- Produces:
  - Contract:
    - `IPC_CHANNELS.programsGetStatus = "programs:get-status"`
    - `IPC_CHANNELS.programsRefresh = "programs:refresh"`
    - `PROGRAM_IPC_CHANNELS = { statusChanged: "programs:status-changed" }`
    - `interface ProgramStatusChangedEvent { sessionId: string; status: ProgramVerdict | null }`
    - `AgentCoordinatorApi.programs: { getStatus(sessionId): Promise<ProgramVerdict | null>; refresh(sessionId): Promise<ProgramVerdict | null>; onStatusChanged(cb): () => void }`
  - Service:
    - `interface ProgramStatusService { get(sessionId): Promise<ProgramVerdict | null>; refresh(sessionId, options?: { force?: boolean }): Promise<ProgramVerdict | null>; onCheckpointChanged(projectId, checkpointPath): void; forget(sessionId): void; close(): void }`
    - `createProgramStatusService(deps)`

- [ ] **Step 1: Contract + preload** (the test imports `PROGRAM_IPC_CHANNELS`).

  In `src/shared/ipc/contract.ts`:
  - Add to `IPC_CHANNELS`:

```ts
  programsGetStatus: "programs:get-status",
  programsRefresh: "programs:refresh",
```

  - Add after `SESSION_IPC_CHANNELS`:

```ts
export const PROGRAM_IPC_CHANNELS = {
  statusChanged: "programs:status-changed",
} as const;

/** A session's program verdict changed (or it stopped/started belonging to a program: `status` null). */
export interface ProgramStatusChangedEvent {
  sessionId: string;
  status: ProgramVerdict | null;
}
```

  - Add to `AgentCoordinatorApi`, after `sessions`:

```ts
  programs: {
    // The verdict `wf:next` would give for the session's program; null when it belongs to none.
    getStatus(sessionId: string): Promise<ProgramVerdict | null>;
    // Recompute now, forcing `git fetch origin develop`.
    refresh(sessionId: string): Promise<ProgramVerdict | null>;
    onStatusChanged(cb: (e: ProgramStatusChangedEvent) => void): () => void;
  };
```

  In `src/preload/agent-coordinator-api.ts`, import `PROGRAM_IPC_CHANNELS` and `ProgramStatusChangedEvent`, then add after `sessions: { … },`:

```ts
    programs: {
      getStatus: (sessionId) => invoke(IPC_CHANNELS.programsGetStatus, sessionId) as ReturnType<AgentCoordinatorApi["programs"]["getStatus"]>,
      refresh: (sessionId) => invoke(IPC_CHANNELS.programsRefresh, sessionId) as ReturnType<AgentCoordinatorApi["programs"]["refresh"]>,
      onStatusChanged: (callback) => on<ProgramStatusChangedEvent>(PROGRAM_IPC_CHANNELS.statusChanged, callback),
    },
```

- [ ] **Step 2: Write the failing test** — `src/main/projects/program-status-service.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PROGRAM_IPC_CHANNELS } from "../../shared/ipc/contract";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import type { WorkSession } from "../../shared/workflow/work-session";
import { createProgramStatusService } from "./program-status-service";
import type { readProgramVerdict } from "./program-status";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "s1",
    projectId: "p",
    name: "S",
    kind: "feature",
    slug: "s",
    branch: "feature/s",
    baseBranch: null,
    pr: null,
    worktreePath: "/repo/.worktrees/s",
    checkpointPath: null,
    setupDone: true,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

const VERDICT = { specPath: "docs/workflow/specs/p.md", verdict: "READY" } as ProgramVerdict;

function harness(sessions: WorkSession[]) {
  const computeVerdict = vi.fn(async (_params: Parameters<typeof readProgramVerdict>[0]) => VERDICT);
  const refresh = vi.fn(async (_root: string, _base: string, _force: boolean): Promise<string | null> => null);
  const broadcast = vi.fn();
  const service = createProgramStatusService({
    getSession: async (id) => sessions.find((candidate) => candidate.id === id) ?? null,
    listSessions: async () => sessions,
    projectRootOf: async () => "/repo",
    readSessionCheckpoint: async () => null,
    refresher: { refresh },
    broadcast,
    computeVerdict,
    debounceMs: 0,
    intervalMs: 60_000,
  });
  return { service, computeVerdict, refresh, broadcast };
}

describe("createProgramStatusService", () => {
  it("a session outside any program has no status and costs no git work", async () => {
    const { service, computeVerdict, refresh, broadcast } = harness([session()]);
    expect(await service.get("s1")).toBeNull();
    expect(computeVerdict).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(PROGRAM_IPC_CHANNELS.statusChanged, { sessionId: "s1", status: null });
    service.close();
  });

  it("computes a program session from its worktree once, then serves the cache", async () => {
    const { service, computeVerdict, refresh } = harness([session({ program: "docs/workflow/specs/p.md" })]);
    expect(await service.get("s1")).toBe(VERDICT);
    expect(await service.get("s1")).toBe(VERDICT);
    expect(computeVerdict).toHaveBeenCalledTimes(1);
    expect(computeVerdict).toHaveBeenCalledWith({
      projectRoot: "/repo",
      specPath: "docs/workflow/specs/p.md",
      source: { kind: "worktree", worktreePath: "/repo/.worktrees/s" },
      fetchNote: null,
    });
    expect(refresh).toHaveBeenCalledWith("/repo", "origin/develop", false);
    service.close();
  });

  it("refresh recomputes and can force the fetch", async () => {
    const { service, refresh, computeVerdict } = harness([session({ program: "docs/workflow/specs/p.md" })]);
    await service.get("s1");
    await service.refresh("s1", { force: true });
    expect(computeVerdict).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith("/repo", "origin/develop", true);
    service.close();
  });

  it("a checkpoint change inside a session's worktree recomputes that session only", async () => {
    const inside = session({ id: "a", program: "p.md", worktreePath: "/repo/.worktrees/a" });
    const other = session({ id: "b", program: "p.md", worktreePath: "/repo/.worktrees/b" });
    const { service, computeVerdict } = harness([inside, other]);
    service.onCheckpointChanged("p", ".worktrees/a/docs/workflow/checkpoints/x-checkpoint.md");
    await vi.waitFor(() => expect(computeVerdict).toHaveBeenCalledTimes(1));
    expect(computeVerdict.mock.calls[0]?.[0]).toMatchObject({ source: { kind: "worktree", worktreePath: "/repo/.worktrees/a" } });
    service.close();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test -- src/main/projects/program-status-service.spec.ts`
Expected: FAIL, `Cannot find module './program-status-service'`.

- [ ] **Step 4: Implement** — `src/main/projects/program-status-service.ts`:

```ts
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
```

- [ ] **Step 5: Wire it** in `src/main/runtime/coordinator-runtime.ts`:
  - Imports:

```ts
import { createMergeBaseRefresher } from "../projects/program-merge";
import { createProgramStatusService } from "../projects/program-status-service";
```

  - Right after `readSessionCheckpointForRunner` is defined:

```ts
  const mergeBaseRefresher = createMergeBaseRefresher();
  const programStatusService = createProgramStatusService({
    getSession: (sessionId) => sessionRegistry.getSession({ sessionId }),
    listSessions: (projectId) => sessionRegistry.listSessions({ projectId }),
    projectRootOf: async (projectId) =>
      (await projectRegistry.listProjects()).find((candidate) => candidate.id === projectId)?.rootPath ?? null,
    readSessionCheckpoint: (session) => readSessionCheckpointForRunner(session.id),
    refresher: mergeBaseRefresher,
    broadcast,
  });
```

  - In `createCheckpointWatchManager({ onCheckpointChanged })`, first line of the callback: `programStatusService.onCheckpointChanged(projectId, checkpoint.checkpointPath);`. In `onCheckpointRemoved`, make it a block that broadcasts as today and then calls `programStatusService.onCheckpointChanged(projectId, checkpointPath);`.
  - In `onCheckpointDetected`, inside the `.then(async () => { … })`, after `sessionOrchestrator?.onCheckpoint(...)`: `void programStatusService.refresh(sessionId).catch(() => {});`
  - Pass `mergeBaseRefresher` to `registerIpcHandlers({ …, mergeBaseRefresher })`.
  - Change `onSessionRemoved` to `(sessionId) => { programStatusService.forget(sessionId); return sessionOrchestrator!.remove(sessionId); }`.
  - Handlers, next to the other `transport.handle` calls:

```ts
  transport.handle(IPC_CHANNELS.programsGetStatus, (_event, sessionId: string) => programStatusService.get(sessionId));
  transport.handle(IPC_CHANNELS.programsRefresh, (_event, sessionId: string) =>
    programStatusService.refresh(sessionId, { force: true }),
  );
```

  - In `close()`: `programStatusService.close();` before the watcher `closeAll`s.

- [ ] **Step 6: Run the test and typecheck**

Run: `pnpm test -- src/main/projects/program-status-service.spec.ts`
Expected: PASS (4 tests).
Run: `pnpm typecheck`
Expected: exit 0. If a test double builds a full `AgentCoordinatorApi` (`grep -rn "AgentCoordinatorApi" src --include=*.spec.ts`), add a `programs` stub to it.

---

### Task 7: Session actions — start the next child, adopt an in-progress child

**Files:**
- Modify: `src/main/projects/session-registry.ts`, test `src/main/projects/session-registry.spec.ts` (append)
- Modify: `src/main/projects/session-orchestrator.ts`, test `src/main/projects/session-orchestrator.spec.ts` (append)
- Modify: `src/main/ipc/register-ipc-handlers.ts` (`forceFresh`)
- Create: `src/main/projects/program-session-actions.ts`, test `src/main/projects/program-session-actions.spec.ts`
- Modify: `src/shared/ipc/contract.ts`, `src/preload/agent-coordinator-api.ts`, `src/main/runtime/coordinator-runtime.ts`

**Interfaces:**
- Consumes: `ProgramStatusService.refresh` (Task 6), `sessionCheckpointWatchParams` (Task 5), `wfNextCommand` (Task 1).
- Produces:
  - `SessionRegistry.updateSessionProgram(params: { sessionId: string; checkpointPath: string | null; program: string; initialPrompt: string | null }): Promise<WorkSession>`
  - `SessionOrchestrator.beginFreshTurn(sessionId: string, role: SessionAgentRole, command: string): Promise<void>`
  - `SessionOrchestrator.resetAutopilot(sessionId: string): Promise<void>`
  - The auto-pilot launch builder options become `{ targetTokens: number | null; forceFresh?: boolean }`.
  - `createProgramSessionActions(deps): ProgramSessionActions` with `startChild(sessionId): Promise<WorkSession>` and `adoptChild(sessionId, index): Promise<WorkSession>`.
  - Contract:
    - `IPC_CHANNELS.sessionsStartProgramChild = "sessions:start-program-child"`
    - `IPC_CHANNELS.sessionsAdoptProgramChild = "sessions:adopt-program-child"`
    - `SESSION_IPC_CHANNELS.sessionUpdated = "session:updated"`
    - `SessionUpdatedEvent { session: WorkSession }`
    - API `sessions.startProgramChild`, `sessions.adoptProgramChild`, `sessions.onSessionUpdated`

- [ ] **Step 1: Write the failing tests.**

Append to `src/main/projects/session-registry.spec.ts` (inside `describe("SessionRegistry", …)`):

```ts
  it("updateSessionProgram rebinds a session to a program child and drops a spent initial prompt", async () => {
    writeFileSync(
      storeFilePath,
      JSON.stringify([
        {
          id: "s1",
          projectId: "p",
          name: "S",
          kind: "feature",
          slug: "s",
          branch: "feature/s",
          baseBranch: null,
          pr: null,
          worktreePath: "/tmp/w",
          checkpointPath: "docs/workflow/checkpoints/padre-checkpoint.md",
          initialPrompt: "old",
          setupDone: true,
          createdAtEpochMs: 0,
        },
      ]),
    );
    const registry = createSessionRegistry({ storeFilePath });
    const started = await registry.updateSessionProgram({
      sessionId: "s1",
      checkpointPath: null,
      program: "docs/workflow/specs/p.md",
      initialPrompt: "wf next docs/workflow/specs/p.md",
    });
    expect(started).toMatchObject({ checkpointPath: null, program: "docs/workflow/specs/p.md", initialPrompt: "wf next docs/workflow/specs/p.md" });
    const adopted = await registry.updateSessionProgram({
      sessionId: "s1",
      checkpointPath: "docs/workflow/checkpoints/x-2-checkpoint.md",
      program: "docs/workflow/specs/p.md",
      initialPrompt: null,
    });
    expect(adopted.initialPrompt).toBeUndefined();
    expect(await registry.getSession({ sessionId: "s1" })).toEqual(adopted);
  });
```

Append to `src/main/projects/session-orchestrator.spec.ts` (inside the top `describe`):

```ts
  it("beginFreshTurn relaunches the role in a NEW conversation with the command submitted", async () => {
    const current = session({ kind: "feature", setupDone: true, branch: "feature/x", checkpointPath: null });
    const replaces: Parameters<RunnerTerminalController["replace"]>[0][] = [];
    const autopilotBuilder = vi.fn(async () => ({
      command: "claude",
      agentKind: "claude" as const,
      cwd: current.worktreePath,
      environment: {},
      typePrompt: "wf next docs/workflow/specs/p.md",
    }));
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()],
        addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: { getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn() } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async () => ({ sessionId: "architect-pty", reused: false }),
        replace: async (input) => {
          replaces.push(input);
          return { sessionId: "fresh-pty", reused: false };
        },
        attach: vi.fn(async () => null),
        kill: vi.fn(),
        write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async () => ({
      agentCommand: "claude", agentKind: "claude", environment: {},
      wfCommand: null, cwd: current.worktreePath, sessionUuid: null, warnings: [],
    }));
    orchestrator.setAutopilotLaunchBuilder(autopilotBuilder);

    await orchestrator.beginFreshTurn(current.id, "architect", "wf next docs/workflow/specs/p.md");

    expect(autopilotBuilder).toHaveBeenCalledWith(current.id, "architect", "architect", "wf next docs/workflow/specs/p.md", {
      targetTokens: null,
      forceFresh: true,
    });
    expect(replaces[0]).toMatchObject({
      persistKey: `${current.id}::role::architect`,
      initialInput: { text: "wf next docs/workflow/specs/p.md", submit: true },
    });
    const architect = (await orchestrator.runtime(current.id))?.terminals.find(
      (terminal) => terminal.kind === "agent" && terminal.role === "architect",
    );
    expect(architect?.mode).toBe("fresh");
    await orchestrator.remove(current.id);
  });

  it("resetAutopilot forgets the previous checkpoint's conductor state but keeps auto-pilot on", async () => {
    const current = session({ kind: "feature", setupDone: true, branch: "feature/x", checkpointPath: "docs/workflow/checkpoints/x-checkpoint.md" });
    const store = memoryStore();
    await store.put({
      sessionId: current.id,
      phase: "ready",
      terminals: [],
      error: null,
      autoPilot: {
        enabled: true,
        state: { lastActedKey: "k", reloopCount: { t: 2 }, reviewedTasks: ["t"] },
        message: "→ wf implement",
        attention: { kind: "paused", reason: "x", sinceEpochMs: 1 },
      },
    });
    const orchestrator = createSessionOrchestrator({
      projectRegistry: { listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn() } as unknown as ProjectRegistry,
      sessionRegistry: { getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn() } as unknown as SessionRegistry,
      runtimeStore: store,
      terminals: { create: vi.fn(), replace: vi.fn(), attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn() },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });

    await orchestrator.resetAutopilot(current.id);

    expect((await orchestrator.runtime(current.id))?.autoPilot).toMatchObject({
      enabled: true,
      state: INITIAL_CONDUCTOR_STATE,
      attention: null,
    });
  });
```

`src/main/projects/program-session-actions.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { ProgramChildView, ProgramVerdict } from "../../shared/workflow/program-verdict";
import type { WorkSession } from "../../shared/workflow/work-session";
import { createProgramSessionActions } from "./program-session-actions";

const SPEC = "docs/workflow/specs/p.md";
const CP2 = "docs/workflow/checkpoints/x-2-checkpoint.md";

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "s1",
    projectId: "p",
    name: "S",
    kind: "feature",
    slug: "s",
    branch: "feature/s",
    baseBranch: null,
    pr: null,
    worktreePath: "/w",
    checkpointPath: "docs/workflow/checkpoints/padre-checkpoint.md",
    setupDone: true,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

function child(overrides: Partial<ProgramChildView>): ProgramChildView {
  return { index: 2, name: "Dos", spec: null, checkpoint: null, dependsOn: [], state: "PENDING", linked: null, merge: null, ...overrides };
}

function verdict(overrides: Partial<ProgramVerdict>): ProgramVerdict {
  return {
    specPath: SPEC,
    title: "P",
    verdict: "READY",
    next: child({}),
    children: [child({})],
    reasons: [],
    hints: [],
    base: "origin/develop",
    fetchNote: null,
    checkedAtEpochMs: 0,
    ...overrides,
  };
}

function harness(status: ProgramVerdict | null) {
  const current = session();
  const calls: string[] = [];
  const deps = {
    getSession: vi.fn(async () => current),
    refreshStatus: vi.fn(async () => status),
    updateSessionProgram: vi.fn(async (params: { sessionId: string; checkpointPath: string | null; program: string; initialPrompt: string | null }) => {
      calls.push("update");
      return { ...current, checkpointPath: params.checkpointPath, program: params.program, ...(params.initialPrompt ? { initialPrompt: params.initialPrompt } : {}) };
    }),
    rewatchCheckpoint: vi.fn(async () => { calls.push("rewatch"); }),
    unwatchCheckpoint: vi.fn(async () => { calls.push("unwatch"); }),
    resetAutopilot: vi.fn(async () => { calls.push("reset"); }),
    beginFreshTurn: vi.fn(async () => { calls.push("fresh"); }),
    announceCheckpoint: vi.fn(async () => { calls.push("announce"); }),
    broadcastSession: vi.fn(() => { calls.push("broadcast"); }),
  };
  return { actions: createProgramSessionActions(deps), deps, calls };
}

describe("startChild", () => {
  it("re-checks with a forced fetch, then unbinds, re-arms the filtered watch and starts the Architect fresh", async () => {
    const { actions, deps, calls } = harness(verdict({}));
    const updated = await actions.startChild("s1");
    expect(deps.refreshStatus).toHaveBeenCalledWith("s1", true);
    expect(deps.updateSessionProgram).toHaveBeenCalledWith({
      sessionId: "s1",
      checkpointPath: null,
      program: SPEC,
      initialPrompt: `wf next ${SPEC}`,
    });
    expect(deps.beginFreshTurn).toHaveBeenCalledWith("s1", "architect", `wf next ${SPEC}`);
    expect(calls).toEqual(["update", "rewatch", "reset", "broadcast", "fresh"]);
    expect(updated.checkpointPath).toBeNull();
  });

  it("refuses anything but READY, listing the reasons, and changes nothing", async () => {
    const { actions, deps } = harness(verdict({ verdict: "BLOCKED", next: null, reasons: ["hijo 1: su commit de cierre abc no está en origin/develop"] }));
    await expect(actions.startChild("s1")).rejects.toThrow(/hijo 1: su commit de cierre abc/);
    expect(deps.updateSessionProgram).not.toHaveBeenCalled();
    expect(deps.beginFreshTurn).not.toHaveBeenCalled();
  });

  it("refuses a session outside any program", async () => {
    const { actions } = harness(null);
    await expect(actions.startChild("s1")).rejects.toThrow(/no pertenece a ningún programa/);
  });
});

describe("adoptChild", () => {
  it("binds the session to an IN_PROGRESS child that points back to the program, leaving the Architect alone", async () => {
    const open = child({ checkpoint: CP2, state: "IN_PROGRESS", linked: true });
    const { actions, deps, calls } = harness(verdict({ verdict: "BLOCKED", next: null, children: [open] }));
    await actions.adoptChild("s1", 2);
    expect(deps.updateSessionProgram).toHaveBeenCalledWith({ sessionId: "s1", checkpointPath: CP2, program: SPEC, initialPrompt: null });
    expect(deps.announceCheckpoint).toHaveBeenCalledWith("s1", CP2);
    expect(deps.beginFreshTurn).not.toHaveBeenCalled();
    expect(calls).toEqual(["unwatch", "update", "reset", "broadcast", "announce"]);
  });

  it("refuses a child that is DONE, has no checkpoint, or does not point back", async () => {
    for (const bad of [child({ checkpoint: CP2, state: "DONE", linked: true }), child({}), child({ checkpoint: CP2, state: "IN_PROGRESS", linked: false })]) {
      const { actions, deps } = harness(verdict({ children: [bad] }));
      await expect(actions.adoptChild("s1", 2)).rejects.toThrow(/no se puede seguir/);
      expect(deps.updateSessionProgram).not.toHaveBeenCalled();
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test -- src/main/projects/session-registry.spec.ts src/main/projects/session-orchestrator.spec.ts src/main/projects/program-session-actions.spec.ts`
Expected: FAIL (`updateSessionProgram` / `beginFreshTurn` / `resetAutopilot` are not functions; `program-session-actions` module missing).

- [ ] **Step 3: Implement the registry method** (`src/main/projects/session-registry.ts`).
  - Interface, after `updateSessionCheckpoint`:

```ts
  /**
   * Move a session along its program: bind it to a child's checkpoint, or clear
   * the binding (null) while the next child's INIT writes one. `initialPrompt`
   * null removes a prompt that has served its purpose.
   */
  updateSessionProgram(params: {
    sessionId: string;
    checkpointPath: string | null;
    program: string;
    initialPrompt: string | null;
  }): Promise<WorkSession>;
```

  - Implementation, after `updateSessionCheckpoint`:

```ts
    updateSessionProgram({ sessionId, checkpointPath, program, initialPrompt }) {
      return runExclusive(async () => {
        const records = await readAll();
        const index = records.findIndex((record) => record.id === sessionId);
        if (index === -1) throw new Error(`Session not found: ${sessionId}`);
        const updated: WorkSession = { ...(records[index] as WorkSession), checkpointPath, program };
        if (initialPrompt) updated.initialPrompt = initialPrompt;
        else delete updated.initialPrompt;
        records[index] = updated;
        await writeAll(records);
        return updated;
      });
    },
```

- [ ] **Step 4: Implement the orchestrator methods** (`src/main/projects/session-orchestrator.ts`).
  - In the `SessionOrchestrator` interface, change the `setAutopilotLaunchBuilder` options type to `options?: { targetTokens: number | null; forceFresh?: boolean }`. Make the same change to the local `AutopilotLaunchBuilder` type alias. Add:

```ts
  /** Relaunch `role` in a NEW provider conversation with `command` submitted: a program's next child starts its own turn. */
  beginFreshTurn(sessionId: string, role: SessionAgentRole, command: string): Promise<void>;
  /** Forget what auto-pilot knew about the session's previous checkpoint: the session now follows another one. */
  resetAutopilot(sessionId: string): Promise<void>;
```

  - Implementation, next to `runCommand` in the returned object:

```ts
    beginFreshTurn(sessionId, role, command) {
      return serial(sessionId, async () => {
        if (!buildAutopilotLaunch) throw new Error("Session orchestrator was started before its command launch builder was registered.");
        const session = await sessionFor(sessionId);
        const runtime = await ensureSetupOrPrimary(sessionId);
        if (runtime.phase !== "ready") throw new Error("Worktree setup has not completed.");
        const launch = await buildAutopilotLaunch(sessionId, role, role, command, { targetTokens: null, forceFresh: true });
        let terminal = runtime.terminals.find((candidate) => candidate.kind === "agent" && candidate.role === role);
        if (!terminal) {
          terminal = { key: roleKey(sessionId, role), kind: "agent", role, mode: "fresh", generation: 0 };
          runtime.terminals.push(terminal);
        }
        const created = await terminals.replace({
          cwd: launch.cwd,
          cols: RUNNER_COLS,
          rows: RUNNER_ROWS,
          launchCommand: launch.command,
          environment: launch.environment,
          persistKey: terminal.key,
          initialInput: launch.typePrompt === null ? null : { text: launch.typePrompt, submit: true },
        });
        liveTerminal.set(created.sessionId, { sessionId, key: terminal.key, agentKind: launch.agentKind, sessionLane: role });
        lastLaunchedLane.set(sessionId, role);
        lastAgentOutputAt.set(sessionId, Date.now());
        laneContextTokens.delete(`${sessionId}::${role}`);
        terminal.mode = launch.typePrompt === null ? "resume" : "fresh";
        terminal.generation = (terminal.generation ?? 0) + 1;
        await publish(sessionId, session.setupDone, runtime);
      });
    },
    resetAutopilot(sessionId) {
      return serial(sessionId, async () => {
        const timer = autoPilotTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        autoPilotTimers.delete(sessionId);
        latestCheckpoint.delete(sessionId);
        pendingHandoff.delete(sessionId);
        handoffWaitingSince.delete(sessionId);
        const runtime = await runtimeStore.get(sessionId);
        if (!runtime) return;
        runtime.autoPilot.state = INITIAL_CONDUCTOR_STATE;
        clearAttention(runtime);
        if (runtime.autoPilot.enabled) runtime.autoPilot.message = "Auto-pilot reset: the session follows another checkpoint of its program";
        await publish(sessionId, (await sessionFor(sessionId)).setupDone, runtime);
      });
    },
```

- [ ] **Step 5: `forceFresh` in the launch builder** (`src/main/ipc/register-ipc-handlers.ts`).
  - In `RegisteredIpcServices.buildRoleAutopilot` and in `buildRoleAutopilotForRunner`, change `options?: { targetTokens: number | null }` to `options?: { targetTokens: number | null; forceFresh?: boolean }`.
  - In `buildRoleAutopilotForRunner`, change the first resolve's `forceFresh` to:

```ts
        // A program's next child asks for a new conversation outright; otherwise
        // only a lane over the context ceiling starts fresh.
        forceFresh: options?.forceFresh === true || shouldForceFreshContext(options?.targetTokens ?? null),
```

- [ ] **Step 6: Implement the actions** — `src/main/projects/program-session-actions.ts`:

```ts
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
```

- [ ] **Step 7: Contract, preload, wiring.**

  `src/shared/ipc/contract.ts`:
  - Add to `IPC_CHANNELS`:

```ts
  sessionsStartProgramChild: "sessions:start-program-child",
  sessionsAdoptProgramChild: "sessions:adopt-program-child",
```

  - Add `sessionUpdated: "session:updated",` to `SESSION_IPC_CHANNELS`.
  - Add after `SessionCheckpointDetectedEvent`:

```ts
/** A session record changed wholesale (a program action rebound it). */
export interface SessionUpdatedEvent {
  session: WorkSession;
}
```

  - Add to `AgentCoordinatorApi.sessions`:

```ts
    // Advance to the program's next child in this session (only when READY; main re-checks).
    startProgramChild(sessionId: string): Promise<WorkSession>;
    // Bind this session to a program child that is already IN_PROGRESS.
    adoptProgramChild(sessionId: string, index: number): Promise<WorkSession>;
    onSessionUpdated(cb: (e: SessionUpdatedEvent) => void): () => void;
```

  `src/preload/agent-coordinator-api.ts` (import `SessionUpdatedEvent`), inside `sessions`:

```ts
      startProgramChild: (sessionId) => invoke(IPC_CHANNELS.sessionsStartProgramChild, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["startProgramChild"]>,
      adoptProgramChild: (sessionId, index) => invoke(IPC_CHANNELS.sessionsAdoptProgramChild, sessionId, index) as ReturnType<AgentCoordinatorApi["sessions"]["adoptProgramChild"]>,
      onSessionUpdated: (callback) => on<SessionUpdatedEvent>(SESSION_IPC_CHANNELS.sessionUpdated, callback),
```

  `src/main/runtime/coordinator-runtime.ts`:
  - Imports: `createProgramSessionActions` from `"../projects/program-session-actions"`, `sessionCheckpointWatchParams` (already imported in Task 5), and `type SessionUpdatedEvent` from the contract.
  - Extract the body of the session watch's `onCheckpointDetected` into a function declared **before** `createSessionCheckpointWatchManager`:

```ts
  // What a newly bound checkpoint means to everyone else: viewers flip their
  // gate, auto-pilot starts reading it, the program verdict is recomputed.
  async function announceSessionCheckpoint(sessionId: string, checkpointPath: string): Promise<void> {
    broadcast(SESSION_IPC_CHANNELS.checkpointDetected, { sessionId, checkpointPath });
    const checkpoint = await readSessionCheckpointForRunner(sessionId);
    if (checkpoint) sessionOrchestrator?.onCheckpoint(sessionId, checkpoint);
    void programStatusService.refresh(sessionId).catch(() => {});
  }
```

    and make `onCheckpointDetected` call `sessionRegistry.updateSessionCheckpoint(...).then(() => announceSessionCheckpoint(sessionId, checkpointPath)).catch(...)`. This replaces the Task 6 `refresh` line, which now lives inside `announceSessionCheckpoint`.
  - After `sessionOrchestrator.setRepoAgentLaunchBuilder(...)`:

```ts
  const programSessionActions = createProgramSessionActions({
    getSession: (sessionId) => sessionRegistry.getSession({ sessionId }),
    refreshStatus: (sessionId, force) => programStatusService.refresh(sessionId, { force }),
    updateSessionProgram: (params) => sessionRegistry.updateSessionProgram(params),
    rewatchCheckpoint: async (session) => {
      await sessionCheckpointWatchManager.unwatchSession(session.id);
      await sessionCheckpointWatchManager.watchSession(sessionCheckpointWatchParams(session));
    },
    unwatchCheckpoint: (sessionId) => sessionCheckpointWatchManager.unwatchSession(sessionId),
    resetAutopilot: (sessionId) => sessionOrchestrator!.resetAutopilot(sessionId),
    beginFreshTurn: (sessionId, role, command) => sessionOrchestrator!.beginFreshTurn(sessionId, role, command),
    announceCheckpoint: announceSessionCheckpoint,
    broadcastSession: (session) => broadcast(SESSION_IPC_CHANNELS.sessionUpdated, { session } satisfies SessionUpdatedEvent),
  });
  transport.handle(IPC_CHANNELS.sessionsStartProgramChild, (_event, sessionId: string) => programSessionActions.startChild(sessionId));
  transport.handle(IPC_CHANNELS.sessionsAdoptProgramChild, (_event, sessionId: string, index: number) =>
    programSessionActions.adoptChild(sessionId, index),
  );
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `pnpm test -- src/main/projects/session-registry.spec.ts src/main/projects/session-orchestrator.spec.ts src/main/projects/program-session-actions.spec.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exit 0. A test double typed as a full `SessionRegistry` or `SessionOrchestrator` gets the new methods as `vi.fn()`.

---

### Task 8: Visible everywhere — banner, Log panel, rail badge

**Files:**
- Create: `src/renderer/components/program-display.ts`, test `src/renderer/components/program-display.spec.ts`
- Create: `src/renderer/components/use-program-actions.ts`, `src/renderer/components/ProgramPanel.tsx`
- Modify: `src/renderer/components/session-notice.tsx`, `SessionView.tsx`, `ProjectRail.tsx`, `src/renderer/App.tsx`, `src/renderer/styles.css`

**Interfaces:**
- Consumes: the verdict types (Task 2), `programs.*` / `sessions.startProgramChild` / `adoptProgramChild` / `onSessionUpdated` (Tasks 6–7).
- Produces:
  - `type ProgramAction = { kind: "start"; index: number } | { kind: "adopt"; index: number } | { kind: "refresh" }`
  - `interface ProgramBanner { tone: SessionNoticeTone; title: string; lines: string[]; actions: ProgramAction[] }`
  - `programBanner(verdict, sessionCheckpointPath): ProgramBanner | null`
  - `panelActions(banner): ProgramAction[]`
  - `interface RailBadge { symbol: string; tone: "danger" | "warning" | "ready"; title: string }`
  - `programRailBadge(verdict | null, sessionCheckpointPath): RailBadge | null`
  - `boundChild`, `mergeLabel`, `childStateClass`, `verdictBadgeClass`, `checkedAgo`, `ipcErrorMessage`, `sessionHoldingBranch`
  - `useProgramActions(sessionId): ProgramActionsState`
  - `ProgramNotice`, `ProgramPanel`, `ProgramActionButtons`

- [ ] **Step 1: Write the failing test** — `src/renderer/components/program-display.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChildMerge, ProgramChildView, ProgramVerdict } from "../../shared/workflow/program-verdict";
import {
  checkedAgo,
  ipcErrorMessage,
  mergeLabel,
  panelActions,
  programBanner,
  programRailBadge,
  sessionHoldingBranch,
} from "./program-display";

const CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const CP2 = "docs/workflow/checkpoints/x-2-checkpoint.md";
const PARENT = "docs/workflow/checkpoints/padre-checkpoint.md";
const UNMERGED: ChildMerge = { state: "unmerged", closeSha: "abc", reason: "hijo 1: su commit de cierre abc no está en origin/develop" };
const MERGED: ChildMerge = { state: "merged", closeSha: "abc", reason: null };

function child(overrides: Partial<ProgramChildView>): ProgramChildView {
  return { index: 1, name: "Uno", spec: null, checkpoint: null, dependsOn: [], state: "PENDING", linked: null, merge: null, ...overrides };
}
function verdict(overrides: Partial<ProgramVerdict>): ProgramVerdict {
  return {
    specPath: "docs/workflow/specs/x-programa.md",
    title: "Programa X",
    verdict: "READY",
    next: null,
    children: [],
    reasons: [],
    hints: [],
    base: "origin/develop",
    fetchNote: null,
    checkedAtEpochMs: 0,
    ...overrides,
  };
}
const done1 = (merge: ChildMerge) => child({ checkpoint: CP1, state: "DONE", linked: true, merge });
const two = child({ index: 2, name: "Dos" });

describe("programBanner", () => {
  it("no banner for the session that IS the child in progress", () => {
    const open = child({ checkpoint: CP1, state: "IN_PROGRESS", linked: true });
    expect(programBanner(verdict({ verdict: "BLOCKED", children: [open] }), CP1)).toBeNull();
  });

  it("offers to adopt a child in progress when the session looks at another checkpoint", () => {
    const open = child({ checkpoint: CP1, state: "IN_PROGRESS", linked: true });
    expect(programBanner(verdict({ verdict: "BLOCKED", children: [open] }), PARENT)).toMatchObject({
      tone: "warning",
      actions: [{ kind: "adopt", index: 1 }],
    });
  });

  it("danger when a DONE child is not merged, with the git reason and the fetch note", () => {
    const banner = programBanner(
      verdict({ verdict: "BLOCKED", children: [done1(UNMERGED), two], reasons: [UNMERGED.reason ?? ""], fetchNote: "sin red" }),
      CP1,
    );
    expect(banner).toMatchObject({ tone: "danger", actions: [{ kind: "refresh" }] });
    expect(banner?.lines).toEqual([UNMERGED.reason, "sin red"]);
  });

  it("warning with every reason for any other block", () => {
    expect(programBanner(verdict({ verdict: "BLOCKED", reasons: ["tabla rota"] }), PARENT)).toMatchObject({
      tone: "warning",
      lines: ["tabla rota"],
    });
  });

  it("while the child's INIT runs (no checkpoint yet) it says it is waiting — no second start", () => {
    const banner = programBanner(verdict({ next: two, children: [done1(MERGED), two] }), null);
    expect(banner).toMatchObject({ tone: "info", actions: [] });
    expect(banner?.title).toMatch(/Esperando el checkpoint del hijo 2/);
  });

  it("READY offers to start the next child in this session; COMPLETE says so", () => {
    expect(programBanner(verdict({ next: two, children: [done1(MERGED), two] }), CP1)).toMatchObject({
      tone: "success",
      actions: [{ kind: "start", index: 2 }],
    });
    expect(programBanner(verdict({ verdict: "COMPLETE", children: [done1(MERGED)] }), CP1)?.title).toMatch(/Programa completo/);
  });
});

describe("programRailBadge / panelActions", () => {
  it("⛔ for a merge block, ⚠ for other trouble, ▶ when a child can start, nothing otherwise", () => {
    expect(programRailBadge(verdict({ verdict: "BLOCKED", children: [done1(UNMERGED)] }), CP1)?.symbol).toBe("⛔");
    expect(programRailBadge(verdict({ verdict: "BLOCKED", reasons: ["x"] }), PARENT)?.symbol).toBe("⚠");
    expect(programRailBadge(verdict({ next: two, children: [done1(MERGED), two] }), CP1)?.symbol).toBe("▶");
    expect(programRailBadge(verdict({ verdict: "COMPLETE", children: [done1(MERGED)] }), CP1)).toBeNull();
    expect(programRailBadge(null, CP1)).toBeNull();
  });

  it("the panel always offers Re-comprobar", () => {
    expect(panelActions(null)).toEqual([{ kind: "refresh" }]);
    expect(panelActions({ tone: "success", title: "", lines: [], actions: [{ kind: "start", index: 2 }] })).toEqual([
      { kind: "start", index: 2 },
      { kind: "refresh" },
    ]);
  });
});

describe("small helpers", () => {
  it("labels merges, ages and IPC errors in Spanish", () => {
    expect(mergeLabel(MERGED)?.text).toBe("✓ merjeado");
    expect(mergeLabel(UNMERGED)?.text).toBe("✗ sin merge");
    expect(mergeLabel(null)).toBeNull();
    expect(checkedAgo(0, 30_000)).toBe("hace menos de 1 min");
    expect(checkedAgo(0, 5 * 60_000)).toBe("hace 5 min");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'sessions:start-program-child': Error: No se puede iniciar"))).toBe(
      "No se puede iniciar",
    );
  });

  it("finds the session that holds a branch, local or origin-qualified", () => {
    const sessions = [{ name: "A", branch: "feature/a" }];
    expect(sessionHoldingBranch(sessions, "origin/feature/a")?.name).toBe("A");
    expect(sessionHoldingBranch(sessions, "feature/a")?.name).toBe("A");
    expect(sessionHoldingBranch(sessions, "feature/b")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- src/renderer/components/program-display.spec.ts`
Expected: FAIL, `Cannot find module './program-display'`.

- [ ] **Step 3: Implement** — `src/renderer/components/program-display.ts`:

```ts
import { normalizeRepoPath } from "../../shared/workflow/program-spec";
import type { ChildMerge, ProgramChildState, ProgramChildView, ProgramVerdict, ProgramVerdictKind } from "../../shared/workflow/program-verdict";
import type { SessionNoticeTone } from "./session-notice";

export type ProgramAction = { kind: "start"; index: number } | { kind: "adopt"; index: number } | { kind: "refresh" };

export interface ProgramBanner {
  tone: SessionNoticeTone;
  title: string;
  lines: string[];
  actions: ProgramAction[];
}

export interface RailBadge {
  symbol: string;
  tone: "danger" | "warning" | "ready";
  title: string;
}

/** The child whose checkpoint this session is bound to, if any. */
export function boundChild(verdict: ProgramVerdict, sessionCheckpointPath: string | null): ProgramChildView | null {
  if (!sessionCheckpointPath) return null;
  const bound = normalizeRepoPath(sessionCheckpointPath);
  return verdict.children.find((child) => child.checkpoint !== null && normalizeRepoPath(child.checkpoint) === bound) ?? null;
}

function hasMergeBlock(verdict: ProgramVerdict): boolean {
  return verdict.children.some((child) => child.merge !== null && child.merge.state !== "merged");
}

/**
 * What the session banner says, in order of what the developer must act on
 * first. The session that IS the child in progress gets no banner: the Log
 * panel shows the program; there is nothing to decide.
 */
export function programBanner(verdict: ProgramVerdict, sessionCheckpointPath: string | null): ProgramBanner | null {
  const bound = boundChild(verdict, sessionCheckpointPath);
  if (bound?.state === "IN_PROGRESS") return null;
  const open = verdict.children.find((child) => child.state === "IN_PROGRESS" && child.linked === true && child !== bound);
  if (open) {
    return {
      tone: "warning",
      title: sessionCheckpointPath
        ? `El hijo ${open.index} («${open.name}») está en curso y esta sesión mira otro checkpoint.`
        : `El hijo ${open.index} («${open.name}») ya tiene checkpoint: engancha esta sesión a él.`,
      lines: [],
      actions: [{ kind: "adopt", index: open.index }],
    };
  }
  if (hasMergeBlock(verdict)) {
    const lines = verdict.children.flatMap((child) => (child.merge?.reason ? [child.merge.reason] : []));
    return {
      tone: "danger",
      title: "⛔ Programa bloqueado: hay un hijo DONE que no está merjeado en develop.",
      lines: verdict.fetchNote ? [...lines, verdict.fetchNote] : lines,
      actions: [{ kind: "refresh" }],
    };
  }
  if (verdict.verdict === "BLOCKED") {
    return { tone: "warning", title: "Programa bloqueado.", lines: verdict.reasons, actions: [{ kind: "refresh" }] };
  }
  if (sessionCheckpointPath === null) {
    const waitingFor = verdict.next ? `del hijo ${verdict.next.index} («${verdict.next.name}»)` : "del hijo";
    return { tone: "info", title: `Esperando el checkpoint ${waitingFor}: el Architect lo escribe al cerrar el INIT.`, lines: [], actions: [] };
  }
  if (verdict.verdict === "READY" && verdict.next) {
    return {
      tone: "success",
      title: `▶ El hijo ${verdict.next.index} («${verdict.next.name}») puede empezar.`,
      lines: [],
      actions: [{ kind: "start", index: verdict.next.index }],
    };
  }
  return { tone: "success", title: "Programa completo: todos los hijos DONE y merjeados.", lines: [], actions: [] };
}

/** The Log panel always lets the developer re-check, whatever the banner offers. */
export function panelActions(banner: ProgramBanner | null): ProgramAction[] {
  const actions = banner?.actions ?? [];
  return actions.some((action) => action.kind === "refresh") ? actions : [...actions, { kind: "refresh" }];
}

export function programRailBadge(verdict: ProgramVerdict | null, sessionCheckpointPath: string | null): RailBadge | null {
  if (!verdict) return null;
  const banner = programBanner(verdict, sessionCheckpointPath);
  if (!banner) return null;
  if (banner.tone === "danger") return { symbol: "⛔", tone: "danger", title: banner.title };
  if (banner.tone === "warning") return { symbol: "⚠", tone: "warning", title: banner.title };
  if (banner.actions.some((action) => action.kind === "start")) return { symbol: "▶", tone: "ready", title: banner.title };
  return null;
}

export function mergeLabel(merge: ChildMerge | null): { text: string; className: string } | null {
  if (!merge) return null;
  if (merge.state === "merged") return { text: "✓ merjeado", className: "badge badge-done" };
  if (merge.state === "unmerged") return { text: "✗ sin merge", className: "badge badge-attention" };
  if (merge.state === "uncommitted") return { text: "✗ cierre sin commitear", className: "badge badge-attention" };
  return { text: "? sin verificar", className: "badge badge-attention" };
}

export function childStateClass(state: ProgramChildState): string {
  return state === "DONE" ? "badge badge-done" : "badge";
}

export function verdictBadgeClass(verdict: ProgramVerdictKind): string {
  return verdict === "BLOCKED" ? "badge badge-attention" : "badge badge-done";
}

export function checkedAgo(epochMs: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - epochMs) / 60_000);
  if (minutes < 1) return "hace menos de 1 min";
  if (minutes < 60) return `hace ${minutes} min`;
  return `hace ${Math.floor(minutes / 60)} h`;
}

/** Electron wraps a handler's error as "Error invoking remote method '<channel>': Error: <message>". */
export function ipcErrorMessage(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/** Which session holds `ref` checked out (git allows a branch in one worktree only). */
export function sessionHoldingBranch<T extends { branch: string }>(sessions: readonly T[], ref: string): T | null {
  const local = ref.replace(/^origin\//, "");
  return sessions.find((session) => session.branch === ref || session.branch === local) ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test -- src/renderer/components/program-display.spec.ts`
Expected: PASS.

- [ ] **Step 5: The action hook** — `src/renderer/components/use-program-actions.ts`:

```ts
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
```

- [ ] **Step 6: `SessionNotice` gets an actions slot** (`src/renderer/components/session-notice.tsx`):

```tsx
export function SessionNotice(props: { tone: SessionNoticeTone; children: ReactNode; actions?: ReactNode }): JSX.Element {
  const { tone, children, actions } = props;
  const urgent = tone === "warning" || tone === "danger";
  return (
    <div
      className={`session-notice session-notice-${tone}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
    >
      <span className="session-notice-icon" aria-hidden="true">
        {NOTICE_ICON[tone]}
      </span>
      <div className="session-notice-copy">{children}</div>
      {actions && <div className="session-notice-actions">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 7: The components** — `src/renderer/components/ProgramPanel.tsx`:

```tsx
import { useState } from "react";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import {
  boundChild,
  checkedAgo,
  childStateClass,
  mergeLabel,
  panelActions,
  programBanner,
  verdictBadgeClass,
} from "./program-display";
import type { ProgramAction } from "./program-display";
import { SessionNotice } from "./session-notice";
import type { ProgramActionsState } from "./use-program-actions";

function actionLabel(action: ProgramAction): string {
  if (action.kind === "start") return `Iniciar hijo ${action.index} en esta sesión`;
  if (action.kind === "adopt") return `Seguir el hijo ${action.index} en esta sesión`;
  return "Re-comprobar";
}

/** Starting a child replaces the Architect's conversation, so it asks inline first (never a browser dialog). */
export function ProgramActionButtons(props: { actions: ProgramAction[]; state: ProgramActionsState }): JSX.Element | null {
  const { actions, state } = props;
  const [confirming, setConfirming] = useState<number | null>(null);
  if (actions.length === 0) return null;
  return (
    <span className="program-actions">
      {actions.map((action) => {
        const key = action.kind === "refresh" ? "refresh" : `${action.kind}-${action.index}`;
        if (action.kind === "start" && confirming === action.index) {
          return (
            <span key={key} className="program-confirm">
              Reemplaza la conversación actual del Architect. ¿Seguir?
              <button
                type="button"
                disabled={state.busy}
                onClick={() => {
                  setConfirming(null);
                  void state.run(action);
                }}
              >
                Sí, iniciar hijo {action.index}
              </button>
              <button type="button" disabled={state.busy} onClick={() => setConfirming(null)}>
                Cancelar
              </button>
            </span>
          );
        }
        return (
          <button
            key={key}
            type="button"
            disabled={state.busy}
            onClick={() => (action.kind === "start" ? setConfirming(action.index) : void state.run(action))}
          >
            {state.busy && action.kind === "refresh" ? "Comprobando…" : actionLabel(action)}
          </button>
        );
      })}
    </span>
  );
}

/** The banner at the top of the session, on every tab. */
export function ProgramNotice(props: { verdict: ProgramVerdict; sessionCheckpointPath: string | null; state: ProgramActionsState }): JSX.Element | null {
  const { verdict, sessionCheckpointPath, state } = props;
  const banner = programBanner(verdict, sessionCheckpointPath);
  if (!banner && !state.error) return null;
  return (
    <SessionNotice
      tone={banner?.tone ?? "danger"}
      actions={banner ? <ProgramActionButtons actions={banner.actions} state={state} /> : undefined}
    >
      {banner && <strong>{banner.title}</strong>}
      {banner && banner.lines.length > 0 && (
        <ul className="program-notice-lines">
          {banner.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="program-error">{state.error}</p>}
    </SessionNotice>
  );
}

/** The whole program, above the checkpoint in the Log tab. */
export function ProgramPanel(props: {
  verdict: ProgramVerdict;
  sessionCheckpointPath: string | null;
  state: ProgramActionsState;
  now: number;
}): JSX.Element {
  const { verdict, sessionCheckpointPath, state, now } = props;
  const bound = boundChild(verdict, sessionCheckpointPath);
  const doneCount = verdict.children.filter((child) => child.state === "DONE").length;
  return (
    <section className="program-panel" aria-label="Programa">
      <header className="program-panel-header">
        <span className="program-panel-title">{verdict.title}</span>
        <span className={verdictBadgeClass(verdict.verdict)}>{verdict.verdict}</span>
        <span className="session-view-muted">
          {doneCount}/{verdict.children.length} DONE · {verdict.base} comprobado {checkedAgo(verdict.checkedAtEpochMs, now)}
        </span>
      </header>
      {verdict.fetchNote && <p className="program-fetch-note">⚠ {verdict.fetchNote}</p>}
      {verdict.children.length > 0 && (
        <ol className="program-children">
          {verdict.children.map((child) => {
            const merge = mergeLabel(child.merge);
            const here = child === bound;
            return (
              <li key={child.index} className={`program-child${here ? " program-child-bound" : ""}`}>
                <span className="program-child-index">{child.index}</span>
                <span className="program-child-name">{child.name}</span>
                <span className={childStateClass(child.state)}>{child.state}</span>
                {merge && <span className={merge.className}>{merge.text}</span>}
                {child.dependsOn.length > 0 && <span className="session-view-muted">depende de {child.dependsOn.join(", ")}</span>}
                {here && <span className="program-child-here">← esta sesión</span>}
              </li>
            );
          })}
        </ol>
      )}
      {verdict.reasons.length > 0 && (
        <div className="program-reasons" role="alert">
          <strong>BLOCKED</strong>
          <ul>
            {verdict.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.hints.length > 0 && (
        <ul className="program-hints">
          {verdict.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
      <div className="program-panel-actions">
        <ProgramActionButtons actions={panelActions(programBanner(verdict, sessionCheckpointPath))} state={state} />
      </div>
      {state.error && <p className="program-error">{state.error}</p>}
    </section>
  );
}
```

- [ ] **Step 8: Render them in `SessionView.tsx`.**
  - Imports:

```ts
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import { ProgramNotice, ProgramPanel } from "./ProgramPanel";
import { useProgramActions } from "./use-program-actions";
```

  - Add `programStatus?: ProgramVerdict | null;` to `SessionViewProps`. Destructure it (`programStatus = null`) in `SessionView`.
  - Top level of `SessionView`, with the other hooks: `const programActions = useProgramActions(session.id);`
  - After the `{prSession && reviewPostMsg && (…)}` notice:

```tsx
      {!repoMode && !prSession && programStatus && (
        <ProgramNotice verdict={programStatus} sessionCheckpointPath={session.checkpointPath} state={programActions} />
      )}
```

  - Log tab: inside `<div className="session-log-scroll">`, before `<LogPanel …/>`:

```tsx
            {programStatus && (
              <ProgramPanel
                verdict={programStatus}
                sessionCheckpointPath={session.checkpointPath}
                state={programActions}
                now={Date.now()}
              />
            )}
```

- [ ] **Step 9: Rail badge in `ProjectRail.tsx`.**
  - `import type { RailBadge } from "./program-display";`
  - Props: `programBadges?: Record<string, RailBadge | null>;`, destructured.
  - In `renderSessions`, inside the session `<button>` after `<span className="session-row-name">…</span>`:

```tsx
              {(() => {
                const badge = programBadges?.[session.id];
                return badge ? (
                  <span
                    className={`session-row-program-badge session-row-program-badge-${badge.tone}`}
                    title={badge.title}
                    aria-label={badge.title}
                  >
                    {badge.symbol}
                  </span>
                ) : null;
              })()}
```

- [ ] **Step 10: Wire it in `App.tsx`.**
  - Imports: `useMemo`, `useRef` if missing; `import type { ProgramVerdict } from "../shared/workflow/program-verdict";`; `import { programRailBadge } from "./components/program-display";`.
  - State and effects, next to the other session effects:

```tsx
  // Program verdicts are computed and pushed by main; the UI only renders them.
  const [programStatuses, setProgramStatuses] = useState<Record<string, ProgramVerdict | null>>({});
  const requestedProgramStatus = useRef(new Set<string>());

  useEffect(() => {
    return window.agentCoordinator.programs.onStatusChanged((event) => {
      setProgramStatuses((current) => ({ ...current, [event.sessionId]: event.status }));
    });
  }, []);

  useEffect(() => {
    for (const sessions of Object.values(sessionsByProject)) {
      for (const session of sessions) {
        if ((session.kind !== "feature" && session.kind !== "fix") || requestedProgramStatus.current.has(session.id)) continue;
        requestedProgramStatus.current.add(session.id);
        void window.agentCoordinator.programs
          .getStatus(session.id)
          .then((status) => setProgramStatuses((current) => ({ ...current, [session.id]: status })))
          .catch(() => requestedProgramStatus.current.delete(session.id));
      }
    }
  }, [sessionsByProject]);

  // A program action rebinds a session wholesale (checkpoint, program, prompt).
  useEffect(() => {
    return window.agentCoordinator.sessions.onSessionUpdated(({ session: updated }) => {
      setSessionsByProject((current) => {
        const list = current[updated.projectId];
        if (!list?.some((session) => session.id === updated.id)) return current;
        return { ...current, [updated.projectId]: list.map((session) => (session.id === updated.id ? updated : session)) };
      });
    });
  }, []);

  const programBadges = useMemo(() => {
    const badges: Record<string, ReturnType<typeof programRailBadge>> = {};
    for (const sessions of Object.values(sessionsByProject)) {
      for (const session of sessions) badges[session.id] = programRailBadge(programStatuses[session.id] ?? null, session.checkpointPath);
    }
    return badges;
  }, [sessionsByProject, programStatuses]);
```

  - `<ProjectRail … programBadges={programBadges} />`
  - `<SessionView … programStatus={programStatuses[session.id] ?? null} />`

- [ ] **Step 11: Styles** — append to `src/renderer/styles.css`:

```css
/* ── Programs ───────────────────────────────────────────────── */
.session-notice-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.program-notice-lines {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12px;
  font-weight: 500;
}
.program-actions,
.program-confirm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.program-confirm {
  font-size: 12px;
}
.program-error {
  margin: 4px 0 0;
  color: var(--danger-fg);
  font-size: 12px;
  white-space: pre-wrap;
}
.program-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
  padding: 10px 12px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.program-panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.program-panel-title {
  font-weight: 600;
}
.program-fetch-note {
  margin: 0;
  color: var(--gold);
  font-size: 12px;
}
.program-children {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.program-child {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 3px 6px;
  border-radius: 6px;
  font-size: 12px;
}
.program-child-bound {
  background: rgba(212, 168, 75, 0.1);
}
.program-child-index {
  min-width: 1.5em;
  color: var(--muted-fg);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  text-align: right;
}
.program-child-here {
  color: var(--gold);
  font-weight: 600;
}
.program-reasons {
  padding: 8px 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  background: var(--danger-bg);
  color: var(--danger-fg);
  font-size: 12px;
}
.program-reasons ul,
.program-hints {
  margin: 4px 0 0;
  padding-left: 18px;
}
.program-hints {
  color: var(--muted-fg);
  font-size: 12px;
}
.program-panel-actions {
  display: flex;
  gap: 6px;
}
.session-row-program-badge {
  margin-left: auto;
  padding: 1px 4px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1;
}
.session-row-program-badge-danger {
  background: var(--danger-bg);
  color: var(--danger-fg);
}
.session-row-program-badge-warning {
  color: var(--gold);
}
.session-row-program-badge-ready {
  color: var(--green);
}
```

- [ ] **Step 12: Run the tests and typecheck**

Run: `pnpm test -- src/renderer/components/program-display.spec.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: exit 0.

---

### Task 9: The new-session dialog shows the verdict and never walks into git's error

**Files:**
- Modify: `src/renderer/components/NewSessionDialog.tsx`, `src/renderer/App.tsx`

**Interfaces:**
- Consumes: `ProgramVerdict` (Task 2), `mergeLabel`, `verdictBadgeClass`, `sessionHoldingBranch` (Task 8), `programChildFeatureName`, `wfNextCommand` (Tasks 1/4).
- Produces: `NewSessionDialogProps` gains `sessions: WorkSession[]` and `onSelectSession(session: WorkSession): void`.

- [ ] **Step 1: Props and App wiring.**
  - In `NewSessionDialogProps` add:

```ts
  // The project's sessions: a branch one of them holds cannot be continued (git allows one worktree per branch).
  sessions: WorkSession[];
  onSelectSession: (session: WorkSession) => void;
```

    and destructure both.
  - In `App.tsx`, pass them:

```tsx
          sessions={sessionsByProject[newSessionProjectId] ?? []}
          onSelectSession={(session) => {
            setNewSessionProjectId(null);
            handleSelectSession(session);
          }}
```

- [ ] **Step 2: Replace the program block** (the `{refPrograms && refPrograms.length > 0 && (…)}` JSX) with:

```tsx
                    {refPrograms && refPrograms.length > 0 && (
                      <div className="new-session-field">
                        <span className="field-label">Programa</span>
                        {refPrograms.map((program) => {
                          const heldBy = sessionHoldingBranch(sessions, startRef);
                          const command = wfNextCommand(program.specPath);
                          const selected = initialPrompt === command;
                          const doneCount = program.children.filter((child) => child.state === "DONE").length;
                          return (
                            <div key={program.specPath} className="new-session-program">
                              <p className="field-preview">
                                <strong>{program.title}</strong> · {doneCount}/{program.children.length} hijos DONE ·{" "}
                                <span className={verdictBadgeClass(program.verdict)}>{program.verdict}</span>
                              </p>
                              <ul className="new-session-program-children">
                                {program.children.map((child) => {
                                  const merge = mergeLabel(child.merge);
                                  return (
                                    <li key={child.index}>
                                      {child.index}. {child.name} · <code>{child.state}</code>
                                      {merge && (
                                        <>
                                          {" "}
                                          · <span className={merge.className}>{merge.text}</span>
                                        </>
                                      )}
                                      {child.dependsOn.length > 0 && <> · depende de {child.dependsOn.join(", ")}</>}
                                    </li>
                                  );
                                })}
                              </ul>
                              {heldBy ? (
                                <p className="field-hint">
                                  La rama está en la sesión «{heldBy.name}»: avanza el programa desde ahí (tab Log → Programa).{" "}
                                  <button type="button" onClick={() => onSelectSession(heldBy)}>
                                    Ir a la sesión
                                  </button>
                                </p>
                              ) : program.verdict === "READY" && program.next ? (
                                <button
                                  type="button"
                                  className={selected ? "selected" : undefined}
                                  onClick={() => {
                                    const next = program.next;
                                    if (!next) return;
                                    setStartCheckpoint("");
                                    setInitialPrompt(command);
                                    if (!nameTouched) {
                                      setName(truncateSessionName(programChildFeatureName(program.title, program.children.length, next)));
                                    }
                                  }}
                                >
                                  Iniciar hijo {program.next.index}: {program.next.name}
                                </button>
                              ) : program.verdict === "COMPLETE" ? (
                                <p className="field-hint">Programa completo.</p>
                              ) : (
                                <div className="program-reasons" role="alert">
                                  <strong>Bloqueado: el siguiente hijo no puede empezar.</strong>
                                  <ul>
                                    {program.reasons.map((reason) => (
                                      <li key={reason}>{reason}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {program.fetchNote && <p className="field-hint">⚠ {program.fetchNote}</p>}
                              {selected && !heldBy && (
                                <p className="field-hint">
                                  Sin checkpoint: el Architect abre con <code>{initialPrompt}</code> pre-escrito y crea el checkpoint del hijo.
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
```

  Add the imports: `import { mergeLabel, sessionHoldingBranch, verdictBadgeClass } from "./program-display";`. Keep `programChildFeatureName` and `wfNextCommand` from `program-spec`.

- [ ] **Step 3: Typecheck and the full suite**

Run: `pnpm typecheck` → exit 0.
Run: `pnpm test` → every suite PASS. (Before this plan the baseline was 546 tests; the count grows.)

---

### Task 10: Verify against the real Biznex program and the bundle

**Files:** none changed (a scratch script outside the repo).

- [ ] **Step 1: Real data, read-only.** Write a script in the session scratchpad (not the repo):

```ts
// <scratchpad>/program-smoke.ts — read-only against the real Biznex worktree
import { readProgramVerdict } from "/Users/dmcl/Projects/AGENTS/src/main/projects/program-status";
const root = "/Users/dmcl/Projects/Biznex/App/biznex";
const worktree = `${root}/.worktrees/corp-filing-form-mapping`;
const verdict = await readProgramVerdict({
  projectRoot: root,
  specPath: "docs/workflow/specs/2026-09-23-corp-filing-edicion-completa-programa.md",
  source: { kind: "worktree", worktreePath: worktree },
  fetchNote: null,
});
console.log(JSON.stringify({ verdict: verdict.verdict, reasons: verdict.reasons, children: verdict.children.map((c) => [c.index, c.state, c.merge?.state ?? null]) }, null, 2));
```

Run: `npx tsx <scratchpad>/program-smoke.ts`
Expected, with the spec as it is on disk: if the table is still under `## §4. Hijos`, the result is `BLOCKED` with `… no tiene la sección \`# Hijos\` con su tabla`. If the architect already fixed it to `# Hijos`, the verdict must match what `pnpm wf:next <spec>` prints in that worktree. Run `wf:next` too and compare the verdict and the reason lines. **This does not modify Biznex.**

- [ ] **Step 2: Bundle check.** Run `pnpm exec electron-vite build`. Expected: exit 0.
  Do **not** run `pnpm build` or package the app. Rebuilding native modules and restarting are the user's call, because they have live sessions.

- [ ] **Step 3: Report to the user.** List what changed, the test counts, the smoke output, and what still needs them:
  - `pnpm build` / `pnpm package:mac` + restart, when their live sessions allow it.
  - The Biznex rules' `Coordinador:` bullet (reviewer.md, FEATURE_REVIEW step 7) still says "New session → Continue → la rama". It should become "tab Log → Programa → Iniciar hijo N en esta sesión". That is a rules change for `develop` in Biznex, outside this repo.
  - Whether to commit this, and how.
