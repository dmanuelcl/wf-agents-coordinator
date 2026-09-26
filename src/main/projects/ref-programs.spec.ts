import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRefPrograms } from "./ref-programs";

let repoDir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repoDir });
}

function write(relative: string, content: string): void {
  const absolute = join(repoDir, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

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
      "branch: develop",
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

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
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

  it("does not list a program whose children belong to another branch — it only arrived here through develop", async () => {
    git("checkout", "-q", "-b", "feature/deploy-platform");
    const programs = await listRefPrograms({ projectRoot: repoDir, ref: "feature/deploy-platform" });
    expect(programs.map((program) => program.specPath)).toEqual([]);
  });

  it("lists a program born on the branch that has no child checkpoint yet and is not in origin/develop", async () => {
    git("checkout", "-q", "-b", "feature/nuevo");
    write("docs/workflow/specs/nuevo-programa.md", "# Nuevo\nHijos: 1\n\n# Hijos\n| # | Hijo | Spec | Checkpoint | Depende de | Estado |\n|---|---|---|---|---|---|\n| 1 | Uno | – | – | – | PENDING |\n");
    git("add", ".");
    git("commit", "-q", "-m", "nace el programa");
    const programs = await listRefPrograms({ projectRoot: repoDir, ref: "feature/nuevo" });
    expect(programs.map((program) => program.specPath)).toEqual(["docs/workflow/specs/nuevo-programa.md"]);
    expect(await listRefPrograms({ projectRoot: repoDir, ref: "origin/feature/nuevo" })).toEqual([]); // unresolvable: no remote branch
  });
});

