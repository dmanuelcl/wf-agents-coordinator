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
    ["---", "feature: Ventas · 1/2 Catálogo", "slug: v-1", "status: DONE", "---", "", "# ▶ NEXT", "- x", "", "# Plans ledger", "", "# Log", ""].join("\n"),
  );
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("listRefPrograms", () => {
  it("finds the program on the ref, ignores plain specs, and reads each child's state from its checkpoint", async () => {
    const programs = await listRefPrograms({ projectRoot: repoDir, ref: "develop" });
    expect(programs).toHaveLength(1);
    const program = programs[0];
    expect(program?.path).toBe("docs/workflow/specs/ventas-programa.md");
    expect(program?.title).toBe("Programa · Ventas");
    expect(program?.children[0]?.state).toBe("DONE"); // the table said IN_PROGRESS; the checkpoint says DONE
    expect(program?.next?.index).toBe(2);
    expect(program?.complete).toBe(false);
  });

  it("yields an empty list for a ref that does not resolve", async () => {
    expect(await listRefPrograms({ projectRoot: repoDir, ref: "no-such-ref" })).toEqual([]);
  });
});
