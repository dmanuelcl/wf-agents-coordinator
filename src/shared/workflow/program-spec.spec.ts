import { describe, expect, it } from "vitest";
import {
  derivedChildState,
  frontmatterStatus,
  hasProgramSection,
  normalizeRepoPath,
  programChildFeatureName,
  programPathOf,
  programRows,
  programTableErrors,
  programTitle,
  rowDependencies,
  wfNextCommand,
  wfNextSpecOf,
} from "./program-spec";

describe("wfNextCommand / programChildFeatureName", () => {
  it("builds the phrase the architect runs and the child's feature name", () => {
    expect(wfNextCommand("docs/workflow/specs/ventas-programa.md")).toBe("wf next docs/workflow/specs/ventas-programa.md");
    expect(programChildFeatureName("Programa · Ventas", 3, { index: 2, name: "Cobros" })).toBe("Programa · Ventas · 2/3 Cobros");
  });
});

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

  it("an indented row is read by both readers (Biznex 802fb00cb: they used to disagree)", () => {
    const text = TABLE([` ${OK1}`, OK2].join("\n"));
    expect(programRows(text).map((row) => row.index)).toEqual([1, 2]);
    expect(programTableErrors(text, X_SPEC)).toEqual([]);
  });

  it("example rows inside a ``` block are not rows, for either reader", () => {
    const text = TABLE([OK1, "```", "| 9 | Ejemplo | – | – | – | PENDING |", "```", OK2].join("\n"));
    expect(programRows(text).map((row) => row.index)).toEqual([1, 2]);
    expect(programTableErrors(text, X_SPEC)).toEqual([]);
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

  it("the user's exception counts only on its own line; quoted in prose it does not add a child", () => {
    const quoted = `${TABLE([OK1, OK2].join("\n"))}Regla: una excepción va como \`Hijo añadido por el usuario: «…»\` en su propia línea.\n`;
    expect(programTableErrors(quoted, X_SPEC)).toEqual([]);
    const added = `${TABLE([OK1, OK2, "| 3 | Tres | – | – | – | PENDING |"].join("\n"))}Hijo añadido por el usuario: «sí, el 3 entra»\n`;
    expect(programTableErrors(added, X_SPEC)).toEqual([]);
  });
});

describe("checkpoint and phrase helpers", () => {
  const checkpoint = (status: string): string =>
    `---\nfeature: X · 1/2 Uno\nstatus: ${status}\n---\n# ▶ NEXT\n\n# Architect memory\n- **Programa:** ${X_SPEC}\n`;

  it("reads the Programa pointer and the frontmatter status like the workflow", () => {
    expect(programPathOf(checkpoint("DONE"))).toBe(X_SPEC);
    expect(programPathOf("# Architect memory\n- nada\n")).toBeNull();
    expect(programPathOf(`- **Programa:** \`${X_SPEC}\``)).toBe(X_SPEC);
    expect(programPathOf(`- **Programa:** [el programa](${X_SPEC})`)).toBe(X_SPEC);
    expect(programPathOf(`- **Programa:** ${X_SPEC} (hijo 1 de 5)`)).toBe(X_SPEC);
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
