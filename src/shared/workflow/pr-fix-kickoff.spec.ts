import { describe, expect, it } from "vitest";
import {
  buildPrFixCompletionCheckpoint,
  buildPrFixKickoff,
  buildPrFixReviewKickoff,
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
      slug: "fix-pr-42",
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
  });

  it("does not embed comment bodies in the terminal prompt", () => {
    const out = buildPrFixKickoff({
      title: "x",
      source: "a",
      target: "b",
      contextFile: ".context.md",
      slug: "x",
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
      completionCheckpoint: checkpointPath,
    });
    const parsed = parseCheckpointMarkdown({ checkpointPath, markdown });

    expect(parsed.status).toBe("IN_PROGRESS");
    expect(parsed.activeRole).toBe("none");
    expect(parsed.next?.role).toBe("reviewer");
    expect(parsed.next?.command).toBe(`wf review ${checkpointPath}`);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("buildPrFixReviewKickoff", () => {
  it("reviews each PR comment and the branch diff without changing or pushing", () => {
    const out = buildPrFixReviewKickoff({
      title: "Add contacts",
      source: "feature/contacts",
      target: "develop",
      contextFile: ".agent-pr-context.md",
    });

    expect(out).toContain("Add contacts");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).toContain("git diff develop...HEAD");
    expect(out).toMatch(/uno por uno.*comentarios/i);
    expect(out).toMatch(/pruebas/i);
    expect(out).toMatch(/no modifiques/i);
    expect(out).toMatch(/no hagas commit/i);
    expect(out).toMatch(/no hagas push/i);
    expect(out).toMatch(/aprueba explícitamente/i);
  });

  it("scopes the review to changes made since the PR-fix session started", () => {
    const out = buildPrFixReviewKickoff({
      title: "x",
      source: "feature/x",
      target: "origin/main",
      contextFile: ".agent-pr-context.md",
      fixBaseSha: "abc123",
    });

    expect(out).toContain("git diff abc123..HEAD");
    expect(out).not.toContain("git diff origin/main...HEAD");
  });
});
