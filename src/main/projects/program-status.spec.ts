import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner } from "./program-merge";
import { programBirthErrors, readProgramVerdict } from "./program-status";

const SPEC = "docs/workflow/specs/x-programa.md";
const CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const program = (row1State: string): string =>
  `# Programa X\nHijos: 2\n\n# Hijos\n| # | Hijo | Spec | Checkpoint | Depende de | Estado |\n|---|---|---|---|---|---|\n| 1 | Uno | docs/workflow/specs/x-1.md | ${CP1} | – | ${row1State} |\n| 2 | Dos | – | – | 1 | PENDING |\n`;
const ROW3 = "| 3 | Tres | – | – | 2 | PENDING |";
const grownProgram = (hijos: number, extra = ""): string => `${program("DONE").replace("Hijos: 2", `Hijos: ${hijos}`)}${ROW3}\n${extra}`;
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

// Biznex 802fb00cb: the index is frozen by git — `Hijos:` never grows past the commit that created the spec.
describe("programBirthErrors", () => {
  const birth = (root: string, specPath: string) =>
    programBirthErrors({ git: createGitRunner(root), ref: "HEAD", specPath, programText: readFileSync(join(root, specPath), "utf8") });

  it("raising `Hijos:` and adding a row does not pass; the user's own-line exception does", async () => {
    const { root } = programRepo();
    writeFileSync(join(root, SPEC), grownProgram(3));
    expect((await birth(root, SPEC)).join("\n")).toMatch(/nació con `Hijos: 2`/);
    const verdict = await readProgramVerdict({ projectRoot: root, specPath: SPEC, source: { kind: "worktree", worktreePath: root }, fetchNote: null });
    expect(verdict.reasons.join("\n")).toMatch(/nació con `Hijos: 2`/);
    writeFileSync(join(root, SPEC), grownProgram(2, "Hijo añadido por el usuario: «sí, el 3 entra»\n"));
    expect(await birth(root, SPEC)).toEqual([]);
  });

  it("renaming the spec and raising `Hijos:` in the same commit does not escape (git log --follow)", async () => {
    const { root, git } = programRepo();
    const renamed = "docs/workflow/specs/x-programa-v2.md";
    git("mv", SPEC, renamed);
    writeFileSync(join(root, renamed), grownProgram(3));
    git("add", ".");
    git("commit", "-q", "-m", "rename + crecer");
    expect((await birth(root, renamed)).join("\n")).toMatch(/nació con `Hijos: 2`/);
  });

  it("a spec that was never committed is being born: nothing to compare against", async () => {
    const { root } = programRepo();
    const draft = "docs/workflow/specs/nuevo-programa.md";
    writeFileSync(join(root, draft), grownProgram(5));
    expect(await birth(root, draft)).toEqual([]);
  });
});

