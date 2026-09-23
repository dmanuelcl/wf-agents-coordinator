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

  it("BLOCKED: an index that grew past its birth (read from git by main) blocks like a contract error", () => {
    const verdict = decideProgramVerdict(input({ birthErrors: ["x-programa.md: nació con `Hijos: 2` (commit abc) y ahora dice `Hijos: 3`"] }));
    expect(verdict.verdict).toBe("BLOCKED");
    expect(verdict.reasons).toEqual(["x-programa.md: nació con `Hijos: 2` (commit abc) y ahora dice `Hijos: 3`"]);
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
