import { describe, expect, it } from "vitest";
import { parseProgramSpec, programChildFeatureName, resolveProgram, wfNextCommand } from "./program-spec";

const PROGRAM = `# Programa · Ventas

## Decisiones compartidas
- P1 …

# Hijos
| # | Hijo | Spec | Checkpoint | Depende de | Estado |
|---|------|------|------------|------------|--------|
| 1 | Catálogo | docs/workflow/specs/v-1.md | docs/workflow/checkpoints/v-1-checkpoint.md | – | IN_PROGRESS |
| 2 | Cobros | – | – | 1 | PENDING |
| 3 | Reportes | – | – | 1, 2 | PENDING |

# Orden
1 → 2 → 3.
`;

describe("parseProgramSpec", () => {
  it("returns null for a file without a # Hijos table", () => {
    expect(parseProgramSpec("# Un spec normal\n\n## §1\n")).toBeNull();
  });

  it("parses the children by column position, `–` as empty, dependencies as numbers", () => {
    const spec = parseProgramSpec(PROGRAM);
    expect(spec?.title).toBe("Programa · Ventas");
    expect(spec?.children).toHaveLength(3);
    expect(spec?.children[0]).toEqual({
      index: 1,
      name: "Catálogo",
      spec: "docs/workflow/specs/v-1.md",
      checkpoint: "docs/workflow/checkpoints/v-1-checkpoint.md",
      dependsOn: [],
      state: "IN_PROGRESS",
    });
    expect(spec?.children[2]?.dependsOn).toEqual([1, 2]);
    expect(spec?.children[1]?.spec).toBeNull();
  });
});

describe("resolveProgram", () => {
  const spec = parseProgramSpec(PROGRAM);
  if (!spec) throw new Error("fixture");

  it("takes the state from the checkpoint, not from the table, and picks the first ready child", () => {
    const resolved = resolveProgram(spec, (path) => (path.endsWith("v-1-checkpoint.md") ? "DONE" : null));
    expect(resolved.children[0]?.state).toBe("DONE");
    expect(resolved.next?.index).toBe(2);
    expect(resolved.complete).toBe(false);
  });

  it("keeps the table's state when the checkpoint cannot be read", () => {
    const resolved = resolveProgram(spec, () => null);
    expect(resolved.children[0]?.state).toBe("IN_PROGRESS");
    expect(resolved.next).toBeNull();
  });

  it("does not open a child whose dependency is not DONE, and reports complete when all are", () => {
    const allDone = {
      ...spec,
      children: spec.children.map((child) => ({ ...child, checkpoint: `docs/workflow/checkpoints/v-${child.index}-checkpoint.md` })),
    };
    const resolved = resolveProgram(allDone, () => "DONE");
    expect(resolved.next).toBeNull();
    expect(resolved.complete).toBe(true);
  });
});

describe("wfNextCommand / programChildFeatureName", () => {
  it("builds the phrase the architect runs and the child's feature name", () => {
    const spec = parseProgramSpec(PROGRAM);
    if (!spec) throw new Error("fixture");
    expect(wfNextCommand("docs/workflow/specs/ventas-programa.md")).toBe("wf next docs/workflow/specs/ventas-programa.md");
    expect(programChildFeatureName(spec, spec.children[1] as (typeof spec.children)[number])).toBe("Programa · Ventas · 2/3 Cobros");
  });
});
