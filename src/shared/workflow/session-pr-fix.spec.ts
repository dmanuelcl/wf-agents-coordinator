import { describe, expect, it } from "vitest";
import { parseCheckpointMarkdown } from "./checkpoint-parser";
import {
  buildSessionPrFixReviewerKickoff,
  getSessionPrFixGate,
  getSessionPrPushGate,
  sessionPrFixLanes,
} from "./session-pr-fix";

function checkpoint(status: string, kind = "feature") {
  return parseCheckpointMarkdown({
    checkpointPath: "docs/workflow/checkpoints/x-checkpoint.md",
    markdown: `---
feature: X
slug: x
kind: ${kind}
branch: feature/x
status: ${status}
active: none
---

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | plan-1 | ✅ | ✅ | ✅ | DONE |
`,
  });
}

const feature = { kind: "feature" as const, checkpointPath: "docs/workflow/checkpoints/x-checkpoint.md" };

describe("getSessionPrFixGate", () => {
  it("opens for a feature or fix session whose checkpoint closed", () => {
    expect(getSessionPrFixGate(feature, checkpoint("DONE"))).toEqual({ allowed: true, reason: null });
    expect(getSessionPrFixGate({ ...feature, kind: "fix" }, checkpoint("DONE", "fix")).allowed).toBe(true);
  });

  it("stays closed while the workflow is still running: the fix reopens a DONE checkpoint", () => {
    const gate = getSessionPrFixGate(feature, checkpoint("IN_PROGRESS"));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/DONE/);
  });

  it("stays closed without a checkpoint", () => {
    expect(getSessionPrFixGate({ ...feature, checkpointPath: null }, null).allowed).toBe(false);
    expect(getSessionPrFixGate(feature, null).allowed).toBe(false);
  });

  it("never applies to PR sessions, which have their own flow", () => {
    expect(getSessionPrFixGate({ ...feature, kind: "pr-fix" }, checkpoint("DONE")).allowed).toBe(false);
    expect(getSessionPrFixGate({ ...feature, kind: "review" }, checkpoint("DONE")).allowed).toBe(false);
  });
});

describe("getSessionPrPushGate", () => {
  it("needs a linked PR before the checkpoint gate even matters", () => {
    const gate = getSessionPrPushGate({ pr: null }, checkpoint("DONE"));
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/PR fix/);
  });

  it("with a linked PR, applies the same gate as a PR-fix session", () => {
    const pr = { prId: "7" };
    expect(getSessionPrPushGate({ pr }, checkpoint("DONE")).allowed).toBe(true);
    expect(getSessionPrPushGate({ pr }, checkpoint("IN_PROGRESS")).allowed).toBe(false);
  });
});

describe("sessionPrFixLanes", () => {
  it("resumes the lane that closed the checkpoint: FEATURE_REVIEW for a feature, PR_REVIEW for a fix", () => {
    expect(sessionPrFixLanes("feature")).toEqual({
      stage: "FEATURE_REVIEW",
      reviewer: "feature-review/reviewer",
      implementer: "feature-review/implementer",
    });
    expect(sessionPrFixLanes("fix")).toEqual({ stage: "PR_REVIEW", reviewer: "fix/reviewer", implementer: "fix/implementer" });
    expect(sessionPrFixLanes("unknown").stage).toBe("FEATURE_REVIEW");
  });
});

describe("buildSessionPrFixReviewerKickoff", () => {
  const base = {
    prId: "291",
    title: "Canales de venta",
    source: "feature/sales-channels",
    target: "develop",
    contextFile: ".agent-pr-context.md",
    checkpointPath: "docs/workflow/checkpoints/2026-09-20-sales-channels-checkpoint.md",
    checkpointKind: "feature" as const,
    program: null,
    baselineSha: "abc1234def",
  };

  it("reopens the same checkpoint as a FEATURE_REVIEW ⚠ ISSUES round routed to the implementer", () => {
    const out = buildSessionPrFixReviewerKickoff(base);
    expect(out).toContain("PR #291");
    expect(out).toContain("feature/sales-channels → develop");
    expect(out).toContain(".agent-pr-context.md");
    expect(out).toMatch(/lee COMPLETO/i);
    expect(out).toContain(base.checkpointPath);
    expect(out).toContain("status: IN_PROGRESS");
    expect(out).toContain("· reviewer · FEATURE_REVIEW · PR fix #291 → ⚠ ISSUES");
    expect(out).toContain("`wf implement docs/workflow/checkpoints/2026-09-20-sales-channels-checkpoint.md`");
    expect(out).toContain("`feature-review/implementer`");
    expect(out).toContain("**Baseline commit:** abc1234def");
  });

  it("carries every field wf:done demands of an ⚠ ISSUES entry, and lets the PR report's audit receipt stand for PLAN_REVIEW", () => {
    const out = buildSessionPrFixReviewerKickoff(base);
    expect(out).toContain("Follow-ups added:");
    expect(out).toContain("PLAN_REVIEW:");
    expect(out).toMatch(/recibo/);
    expect(out).toContain("Literal verificado: sí");
    expect(out).toContain("Plan sufficiency: PASS");
  });

  it("ends with the wf:done publish and forbids pushing", () => {
    const out = buildSessionPrFixReviewerKickoff(base);
    expect(out).toContain(
      "pnpm wf:done --role implementer --lane feature-review/implementer --checkpoint docs/workflow/checkpoints/2026-09-20-sales-channels-checkpoint.md",
    );
    expect(out).toMatch(/nunca `git push`/i);
  });

  it("does not ask for a program row unless the checkpoint belongs to a program", () => {
    expect(buildSessionPrFixReviewerKickoff(base)).not.toContain("# Hijos");
    const child = buildSessionPrFixReviewerKickoff({ ...base, program: "docs/workflow/specs/deploy-platform.md" });
    expect(child).toContain("# Hijos");
    expect(child).toContain("docs/workflow/specs/deploy-platform.md");
    expect(child).toMatch(/IN_PROGRESS/);
  });

  it("a fix checkpoint reopens as PR_REVIEW on the fix lanes and resets its ledger cell", () => {
    const out = buildSessionPrFixReviewerKickoff({ ...base, checkpointKind: "fix" });
    expect(out).toContain("· reviewer · PR_REVIEW · PR fix #291 → ⚠ ISSUES");
    expect(out).toContain("`fix/implementer`");
    expect(out).toContain("--lane fix/implementer");
    expect(out).toMatch(/celda `PR_REVIEW`/);
  });

  it("keeps the comment bodies out of the terminal prompt", () => {
    expect(buildSessionPrFixReviewerKickoff(base)).not.toMatch(/## Comentario 1/);
  });
});
