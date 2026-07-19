import { describe, expect, it } from "vitest";
import { parseCheckpointMarkdown } from "./checkpoint-parser";
import { getPrFixPushGate } from "./pr-fix-push-gate";

function checkpoint(input: { status: "IN_PROGRESS" | "DONE"; prReview: string; log?: string }) {
  return parseCheckpointMarkdown({
    checkpointPath: "docs/workflow/checkpoints/fix-pr-42-pr-fix-checkpoint.md",
    markdown: `---
feature: PR fix
slug: fix-pr-42
kind: fix
status: ${input.status}
active: none
---

# ▶ NEXT
- **Rol:** reviewer
- **Corre:** \`wf review docs/workflow/checkpoints/fix-pr-42-pr-fix-checkpoint.md\`
- **Abre sesión fresca en:** reviewer · cwd \`.\`
- **Tarea:** Review.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | fix-brief | ✅ | – | ${input.prReview} | ${input.status === "DONE" ? "✅ DONE" : "REVIEW"} |

# Log
${input.log ?? "## 2026-07-18 · reviewer · PR_REVIEW · fix-brief → ✅\nNo findings."}`,
  });
}

describe("getPrFixPushGate", () => {
  it("blocks while no checkpoint has been written", () => {
    expect(getPrFixPushGate(null)).toEqual({
      allowed: false,
      reason: "Waiting for the implementer checkpoint.",
    });
  });

  it("blocks before the reviewer marks the workflow DONE", () => {
    expect(getPrFixPushGate(checkpoint({ status: "IN_PROGRESS", prReview: "⏳" })).allowed).toBe(false);
  });

  it("blocks DONE checkpoints that still contain open findings", () => {
    const result = getPrFixPushGate(
      checkpoint({
        status: "DONE",
        prReview: "✅",
        log: "## 2026-07-18 · reviewer · PR_REVIEW · fix-brief → ⚠️\n- [ ] V1 PENDING — Regression remains.",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("1 open finding");
  });

  it("blocks DONE unless the ledger records PR_REVIEW as passed", () => {
    const result = getPrFixPushGate(checkpoint({ status: "DONE", prReview: "⏳" }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/PR_REVIEW/i);
  });

  it("allows push only after reviewer pass with zero open findings", () => {
    expect(getPrFixPushGate(checkpoint({ status: "DONE", prReview: "✅" }))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});
