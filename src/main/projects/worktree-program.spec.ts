import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { worktreeProgramSpec } from "./worktree-program";

let worktree: string;
const dir = (): string => join(worktree, "docs", "workflow", "checkpoints");
const write = (name: string, body: string, mtimeSeconds?: number): void => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), name), body);
  if (mtimeSeconds !== undefined) utimesSync(join(dir(), name), mtimeSeconds, mtimeSeconds);
};
const checkpoint = (status: string, program?: string): string =>
  `---\nstatus: ${status}\n---\n# ▶ NEXT\n- x\n\n# Architect memory\n${program ? `- **Programa:** \`${program}\`\n` : "- nada\n"}`;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "agent-coordinator-worktree-program-"));
});
afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("worktreeProgramSpec", () => {
  it("names the program whose child lives in the worktree, even when the session is bound to the parent", async () => {
    write("2026-08-24-padre-checkpoint.md", checkpoint("IN_PROGRESS"));
    write("2026-09-23-hijo-1-checkpoint.md", checkpoint("IN_PROGRESS", "docs/workflow/specs/p-programa.md"));
    expect(await worktreeProgramSpec(worktree)).toBe("docs/workflow/specs/p-programa.md");
  });

  it("prefers a program with an open child over a newer one whose child is DONE", async () => {
    write("a-checkpoint.md", checkpoint("IN_PROGRESS", "docs/workflow/specs/abierto.md"), 1_000);
    write("b-checkpoint.md", checkpoint("DONE", "docs/workflow/specs/cerrado.md"), 2_000);
    expect(await worktreeProgramSpec(worktree)).toBe("docs/workflow/specs/abierto.md");
  });

  it("null when no checkpoint declares a program, or the worktree has no checkpoints", async () => {
    expect(await worktreeProgramSpec(worktree)).toBeNull();
    write("padre-checkpoint.md", checkpoint("IN_PROGRESS"));
    expect(await worktreeProgramSpec(worktree)).toBeNull();
  });
});
