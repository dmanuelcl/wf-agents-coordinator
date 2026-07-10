import { describe, expect, it } from "vitest";
import { parseCheckpointMarkdown } from "./checkpoint-parser";

const FEATURE_CHECKPOINT = `---
feature: Frontend rich-text editor
slug: frontend-rich-text-editor
kind: feature
branch: feature/frontend-rich-text
worktree: .worktrees/frontend-rich-text
spec: docs/workflow/specs/2026-07-08-frontend-rich-text-editor-design.md
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** implementer
- **Corre:** \`wf implement docs/workflow/checkpoints/2026-07-08-frontend-rich-text-editor-checkpoint.md\`
- **Abre sesión fresca en:** capacidad económica · esfuerzo moderado · cwd \`.worktrees/frontend-rich-text\`
- **Tarea:** Plan-1 (foundation) — implementación fresca desde el plan.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | plan-1-foundation.md | ⏳ | – | – | ACTIVE |
| 2 | plan-2-editor.md | – | – | – | PENDING |
> leyenda: – pendiente · ⏳ en curso · ⚠ con issues · ✅ pass

# Log  (append-only, lo nuevo abajo)

## 2026-07-08 · architect · INIT
Spec + plans written. Plan sufficiency: PASS.
`;

const FIX_CHECKPOINT = `---
feature: Banking duplicate sync
slug: banking-duplicate-sync
kind: fix
branch: fix/banking-duplicate-sync
worktree: .worktrees/banking-duplicate-sync
status: BLOCKED
active: implementer
---

# ▶ NEXT
- **Rol:** architect
- **Corre:** \`wf verify docs/workflow/checkpoints/2026-07-08-banking-duplicate-sync-checkpoint.md\`
- **Abre sesión fresca en:** capacidad alta · esfuerzo alto · cwd \`.worktrees/banking-duplicate-sync\`
- **Tarea:** Responder bloqueo de implementer.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | fix-brief | ⚠ | – | – | BLOCKED |

# Log

## 2026-07-08 · implementer · BLOCKED · fix-brief
Question: exact acceptance test is missing.
`;

const ENGLISH_FEATURE_CHECKPOINT = `---
feature: Frontend rich-text editor
slug: frontend-rich-text-editor
kind: feature
branch: feature/frontend-rich-text
worktree: .worktrees/frontend-rich-text
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Role:** implementer
- **Run:** \`wf implement docs/workflow/checkpoints/2026-07-08-frontend-rich-text-editor-checkpoint.md\`
- **Open fresh session in:** economical capacity · moderate effort · cwd \`.worktrees/frontend-rich-text\`
- **Task:** Plan-1 (foundation) — fresh implementation from the plan.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Status |
|---|------|-----------|-------------|-----------|--------|
| 1 | plan-1-foundation.md | ⏳ | – | – | ACTIVE |
`;

describe("parseCheckpointMarkdown", () => {
  it("parses the Spanish feature checkpoint sample", () => {
    const result = parseCheckpointMarkdown({
      checkpointPath: "docs/workflow/checkpoints/2026-07-08-frontend-rich-text-editor-checkpoint.md",
      markdown: FEATURE_CHECKPOINT,
    });

    expect(result.next?.role).toBe("implementer");
    expect(result.next?.command).toBe(
      "wf implement docs/workflow/checkpoints/2026-07-08-frontend-rich-text-editor-checkpoint.md",
    );
    expect(result.next?.cwd).toBe(".worktrees/frontend-rich-text");
    expect(result.status).toBe("IN_PROGRESS");
    expect(result.activeRole).toBe("none");
    expect(result.ledgerRows).toHaveLength(2);
    expect(result.latestLogMarkdown?.startsWith("## 2026-07-08")).toBe(true);
  });

  it("parses the fix checkpoint sample", () => {
    const result = parseCheckpointMarkdown({
      checkpointPath: "docs/workflow/checkpoints/2026-07-08-banking-duplicate-sync-checkpoint.md",
      markdown: FIX_CHECKPOINT,
    });

    expect(result.kind).toBe("fix");
    expect(result.status).toBe("BLOCKED");
    expect(result.activeRole).toBe("implementer");
    expect(result.next?.role).toBe("architect");
    expect(result.next?.command).toBe(
      "wf verify docs/workflow/checkpoints/2026-07-08-banking-duplicate-sync-checkpoint.md",
    );
  });

  it("returns next: null with a warning when the NEXT section is missing", () => {
    const markdown = `---
feature: No next section
slug: no-next-section
kind: feature
status: IN_PROGRESS
active: none
---

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | plan-1-foundation.md | – | – | – | PENDING |
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.next).toBeNull();
    expect(result.warnings.some((warning) => /next/i.test(warning))).toBe(true);
  });

  it("returns cwd: null with a warning when cwd is missing from the NEXT block", () => {
    const markdown = `---
feature: Missing cwd
slug: missing-cwd
kind: feature
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** implementer
- **Corre:** \`wf implement docs/workflow/checkpoints/missing-cwd-checkpoint.md\`
- **Tarea:** Do the thing.

# Log
## 2026-07-08 · architect · INIT
Started.
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.next?.cwd).toBeNull();
    expect(result.warnings.some((warning) => /cwd/i.test(warning))).toBe(true);
  });

  it("returns role: unknown with a warning when the NEXT role is not recognized", () => {
    const markdown = `---
feature: Unknown role
slug: unknown-role
kind: feature
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** superagent
- **Corre:** \`wf status docs/workflow/checkpoints/unknown-role-checkpoint.md\`
- **Abre sesión fresca en:** capacidad baja · esfuerzo bajo · cwd \`.\`
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.next?.role).toBe("unknown");
    expect(result.next?.cwd).toBe(".");
    expect(result.warnings.some((warning) => /role/i.test(warning))).toBe(true);
  });

  it("matches accented Spanish labels and preserves the accented text", () => {
    const result = parseCheckpointMarkdown({
      checkpointPath: "checkpoint.md",
      markdown: FEATURE_CHECKPOINT,
    });

    expect(result.next?.tier).toContain("capacidad económica");
    expect(result.next?.cwd).toBe(".worktrees/frontend-rich-text");
  });

  it("parses Spanish and English labeled checkpoints identically", () => {
    const spanish = parseCheckpointMarkdown({
      checkpointPath: "checkpoint.md",
      markdown: FEATURE_CHECKPOINT,
    });
    const english = parseCheckpointMarkdown({
      checkpointPath: "checkpoint.md",
      markdown: ENGLISH_FEATURE_CHECKPOINT,
    });

    expect(english.next?.role).toBe(spanish.next?.role);
    expect(english.next?.command).toBe(spanish.next?.command);
    expect(english.next?.cwd).toBe(spanish.next?.cwd);
  });

  it("strips a trailing template comment from a frontmatter value", () => {
    const markdown = `---
feature: Comment test
slug: comment-test
kind: feature   # feature | fix
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** implementer
- **Corre:** \`wf implement checkpoint.md\`
- **cwd:** \`.\`
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.kind).toBe("feature");
    expect(result.frontmatter["kind"]).toBe("feature");
  });
});
