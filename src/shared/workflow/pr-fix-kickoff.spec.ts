import { describe, expect, it } from "vitest";
import {
  buildPrFixCompletionCheckpoint,
  buildPrFixKickoff,
  buildPrFixRoleCommand,
  prFixCompletionCheckpointPath,
} from "./pr-fix-kickoff";
import { parseCheckpointMarkdown } from "./checkpoint-parser";

describe("buildPrFixKickoff", () => {
  it("names the PR and requires reading the complete local context", () => {
    const out = buildPrFixKickoff({
      title: "Add contacts",
      source: "feature/contacts",
      target: "develop",
      contextFile: ".agent-pr-context.md",
      fixBaseSha: "abc123",
      slug: "fix-pr-42",
      worktreePath: "/repo/.worktrees/fix-pr-42",
      completionCheckpoint: "docs/workflow/checkpoints/fix-pr-42-pr-fix-checkpoint.md",
    });
    expect(out).toContain("Add contacts");
    expect(out).toContain("feature/contacts");
    expect(out).toContain("develop");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).toMatch(/lee COMPLETO/i);
    expect(out).toMatch(/por partes.*final del archivo/i);
    expect(out).toMatch(/no implementes nada hasta/i);
    expect(out).toMatch(/commit/i);
    expect(out).toMatch(/no.*push/i);
    expect(out).toMatch(/último paso/i);
    expect(out).toContain("docs/workflow/checkpoints/fix-pr-42-pr-fix-checkpoint.md");
    expect(out).toMatch(/desbloquea el Reviewer/i);
    expect(out).toMatch(/no lo crees antes/i);
    expect(out).toContain("**Rol:** reviewer");
    expect(out).toContain("**Baseline commit:** abc123");
    expect(out).toContain("**Ending commit:** <full ending commit SHA>");
    expect(out).toContain("**Included files:** <exact paths included in the review>");
    expect(out).toContain("**Excluded paths:** <exact paths excluded from the review>");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).toMatch(/reemplaza cada marcador/i);
  });

  it("does not embed comment bodies in the terminal prompt", () => {
    const out = buildPrFixKickoff({
      title: "x",
      source: "a",
      target: "b",
      contextFile: ".context.md",
      slug: "x",
      worktreePath: "/repo/.worktrees/x",
      completionCheckpoint: "docs/workflow/checkpoints/x-pr-fix-checkpoint.md",
    });
    expect(out).not.toContain("Comentarios del PR (en orden)");
  });
});

describe("prFixCompletionCheckpointPath", () => {
  it("builds a session-specific path accepted by the checkpoint watcher", () => {
    expect(prFixCompletionCheckpointPath("fix-pr-42")).toBe(
      "docs/workflow/checkpoints/fix-pr-42-pr-fix-checkpoint.md",
    );
  });
});

describe("buildPrFixCompletionCheckpoint", () => {
  it("produces a valid reviewer NEXT checkpoint", () => {
    const checkpointPath = prFixCompletionCheckpointPath("fix-pr-42");
    const markdown = buildPrFixCompletionCheckpoint({
      slug: "fix-pr-42",
      branch: "feature/contacts",
      worktreePath: "/repo/.worktrees/fix-pr-42",
      completionCheckpoint: checkpointPath,
      contextFile: ".agent-pr-context.md",
      fixBaseSha: "abc123",
    });
    const parsed = parseCheckpointMarkdown({ checkpointPath, markdown });

    expect(parsed.status).toBe("IN_PROGRESS");
    expect(parsed.activeRole).toBe("none");
    expect(parsed.branch).toBe("feature/contacts");
    expect(parsed.worktree).toBe("/repo/.worktrees/fix-pr-42");
    expect(parsed.next?.role).toBe("reviewer");
    expect(parsed.next?.command).toBe(`wf review ${checkpointPath}`);
    expect(parsed.warnings).toEqual([]);
    expect(markdown).toContain("implementer · IMPLEMENT_START · fix-brief → ⏳");
    expect(markdown).toContain("implementer · IMPLEMENT · fix-brief → ✅");
    expect(markdown).toContain("**Baseline commit:** abc123");
    expect(markdown).toContain("**Ending commit:** <full ending commit SHA>");
    expect(markdown).toContain("**Committed range:** abc123..<full ending commit SHA>");
    expect(markdown).toContain("**Included files:** <exact paths included in the review>");
    expect(markdown).toContain("**Excluded paths:** <exact paths excluded from the review>");
    expect(markdown).toContain("`.agent-pr-context.md`");
  });
});

describe("buildPrFixRoleCommand", () => {
  const params = {
    title: "Add contacts",
    source: "feature/contacts",
    target: "develop",
    contextFile: ".agent-pr-context.md",
    fixBaseSha: "abc123",
    slug: "fix-pr-42",
    worktreePath: "/repo/.worktrees/fix-pr-42",
    completionCheckpoint: "docs/workflow/checkpoints/fix-pr-42-pr-fix-checkpoint.md",
  };

  it("uses the PR-comments kickoff only for the first implementer stage", () => {
    const out = buildPrFixRoleCommand({ ...params, role: "implementer", checkpointPath: null });

    expect(out).toContain("Add contacts");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).not.toMatch(/^wf implement /);
  });

  it("routes the reviewer through the canonical checkpoint workflow", () => {
    const out = buildPrFixRoleCommand({
      ...params,
      role: "reviewer",
      checkpointPath: params.completionCheckpoint,
    });

    expect(out).toBe(`wf review ${params.completionCheckpoint}`);
  });

  it("routes a correction loop back through wf implement", () => {
    const out = buildPrFixRoleCommand({
      ...params,
      role: "implementer",
      checkpointPath: params.completionCheckpoint,
    });

    expect(out).toBe(`wf implement ${params.completionCheckpoint}`);
  });
});
