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
