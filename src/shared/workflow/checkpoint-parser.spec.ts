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

  it("extracts the latest correction plan and counts its open findings", () => {
    const markdown = `${FEATURE_CHECKPOINT.trim()}

## 2026-07-18 · architect · ARCH_REVIEW · Plan-1 → ⚠ ISSUES

- [ ] I1 (blocking): The acceptance case is ambiguous.

### Plan de corrección

#### Paso 1 — Decide the acceptance case [origen: I1]

- **Archivos:** docs/workflow/plans/plan-1.md

## 2026-07-18 · implementer · FIX · Plan-1 → ✅

- [x] I1 RESOLVED — Evidencia: docs/workflow/plans/plan-1.md:18

## 2026-07-18 · reviewer · PR_REVIEW · Plan-1 → ⚠ ISSUES

### PR Review Report — Plan-1

#### 🔴 Errors (Must Fix)

- [ ] V1 [logic][src/auth.ts:18]: The timeout is ignored.

#### 🟡 Warnings (Should Fix)

- [ ] V2 [rule][src/auth.spec.ts:9]: The edge case has no test.

#### Plan de corrección (ejecutable por biznex-implementer)

**Orden y dependencias:** Paso 1 antes que Paso 2.

##### Paso 1 — Aplicar el timeout [origen: V1 🔴]

- **Archivos:** src/auth.ts
- **Qué hacer:** Pass the configured timeout to the client.

##### Paso 2 — Cubrir el borde [origen: V2 🟡]

- **Archivos:** src/auth.spec.ts
- **Aceptación:** Add the timeout regression and run the scoped suite.

**Plan sufficiency:** PASS — executable by a lower-capability implementer without inventing.
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.correctionPlan?.title).toBe("Plan de corrección (ejecutable por biznex-implementer)");
    expect(result.correctionPlan?.markdown).toContain("##### Paso 1 — Aplicar el timeout");
    expect(result.correctionPlan?.markdown).toContain("Plan sufficiency:** PASS");
    expect(result.findingCounts).toEqual({ open: 2, closed: 1, total: 3 });
    expect(result.findings.map(({ plan, id, status }) => ({ plan, id, status }))).toEqual([
      { plan: "Plan-1", id: "I1", status: "RESOLVED" },
      { plan: "Plan-1", id: "V1", status: "PENDING" },
      { plan: "Plan-1", id: "V2", status: "PENDING" },
    ]);
  });

  it("reconciles durable finding ids across fixes and re-reviews", () => {
    const markdown = `${FEATURE_CHECKPOINT.trim()}

## 2026-07-18 · reviewer · PR_REVIEW · Plan-1 → ⚠ ISSUES

- [ ] V1 [logic][src/auth.ts:18]: Timeout ignored.
- [ ] V2 [rule][src/auth.spec.ts:9]: Missing test.
- [ ] V3 [dup][src/auth.ts:4]: Duplicate helper.

### Plan de corrección

#### Paso 1 — First review plan [origen: V1 V2 V3]

- **Archivos:** src/auth.ts, src/auth.spec.ts

## 2026-07-18 · implementer · FIX · Plan-1 → ✅

- [x] V1 RESOLVED — Evidencia: src/auth.ts:18 · tests 4/4

## 2026-07-18 · reviewer · PR_REVIEW · Plan-1 → ⚠ ISSUES

### Estado de hallazgos previos

- [x] V1 RESOLVED — Evidencia: src/auth.ts:18
- [ ] V2 PENDING — Evidencia: src/auth.spec.ts:9
- [x] V3 OBSOLETE — The helper was removed with its caller.

### 🟡 Warnings (Should Fix)

- [ ] V4 [design][src/auth.ts:22]: Cancellation may emit RESOLVED before it is actually done.

### Plan de corrección

**Orden y dependencias:** pasos independientes.

#### Paso 1 — Add both regressions [origen: V2 V4]

- **Archivos:** src/auth.ts, src/auth.spec.ts

**Plan sufficiency:** PASS — executable by a lower-capability implementer without inventing.

## 2026-07-18 · implementer · FIX · Plan-1 → ⏳

Started the latest correction plan.
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.correctionPlan?.markdown).toContain("Add both regressions");
    expect(result.correctionPlan?.markdown).not.toContain("First review plan");
    expect(result.findingCounts).toEqual({ open: 2, closed: 2, total: 4 });
    expect(result.findings.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "V1", status: "RESOLVED" },
      { id: "V2", status: "PENDING" },
      { id: "V3", status: "OBSOLETE" },
      { id: "V4", status: "PENDING" },
    ]);
  });

  it("counts the same finding id independently in different plans", () => {
    const markdown = `${FEATURE_CHECKPOINT.trim()}

## 2026-07-18 · reviewer · PR_REVIEW · Plan-1 → ✅ PASS

- [x] V1 RESOLVED — Evidencia: src/first.ts:4

## 2026-07-18 · reviewer · PR_REVIEW · Plan-2 → ⚠ ISSUES

- [ ] V1 [logic][src/second.ts:8]: A new finding in a different plan.
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.findingCounts).toEqual({ open: 1, closed: 1, total: 2 });
    expect(result.findings.map(({ plan, id, status }) => ({ plan, id, status }))).toEqual([
      { plan: "Plan-1", id: "V1", status: "RESOLVED" },
      { plan: "Plan-2", id: "V1", status: "PENDING" },
    ]);
  });

  it("reconciles FEATURE_REVIEW findings as feature-wide F ids", () => {
    const markdown = `${FEATURE_CHECKPOINT.trim()}

## 2026-07-19 · reviewer · FEATURE_REVIEW → ⚠ ISSUES

- [ ] **F1** · [integration] · src/contracts.ts:8 — Plans disagree on the shared contract.
- [ ] F2 [flow][src/feature.ts:20]: The assembled flow skips cancellation.

### Plan de corrección

#### Paso 1 — Unify the contract [origen: F1]

- **Archivos:** src/contracts.ts

## 2026-07-19 · implementer · FIX · FEATURE_REVIEW → ✅

- [x] **F1** RESOLVED — Evidencia: src/contracts.ts:8 · tests 6/6

## 2026-07-19 · reviewer · FEATURE_REVIEW → ⚠ ISSUES

- [x] **F1** RESOLVED — Evidencia: src/contracts.ts:8
- [ ] F2 PENDING — Evidencia: src/feature.ts:20
- [ ] F3 [dup][src/shared.ts:4]: Two plans introduced equivalent helpers.
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.findingCounts).toEqual({ open: 2, closed: 1, total: 3 });
    expect(result.findings.map(({ plan, id, status }) => ({ plan, id, status }))).toEqual([
      { plan: null, id: "F1", status: "RESOLVED" },
      { plan: null, id: "F2", status: "PENDING" },
      { plan: null, id: "F3", status: "PENDING" },
    ]);
  });

  it("does not duplicate plan-scoped I/V findings repeated by FEATURE_REVIEW", () => {
    const markdown = `${FEATURE_CHECKPOINT.trim()}

## 2026-07-19 · architect · ARCH_REVIEW · Plan-1 → ⚠ ISSUES

- [ ] I1 (blocking): The plan contract is incomplete.

## 2026-07-19 · implementer · FIX · Plan-1 → ✅

- [x] I1 RESOLVED — Evidencia: docs/workflow/plans/plan-1.md:20

## 2026-07-19 · reviewer · PR_REVIEW · Plan-1 → ⚠ ISSUES

- [ ] V1 [logic][src/feature.ts:8]: The plan implementation skips an edge.

## 2026-07-19 · reviewer · PR_REVIEW · Plan-1 → ✅ PASS

- [x] V1 RESOLVED — Evidencia: src/feature.ts:8 · tests 5/5

## 2026-07-19 · reviewer · FEATURE_REVIEW → ✅ PASS

- [x] I1 RESOLVED — confirmed against the assembled branch.
- [x] V1 RESOLVED — confirmed against the assembled branch.
`;

    const result = parseCheckpointMarkdown({ checkpointPath: "checkpoint.md", markdown });

    expect(result.findingCounts).toEqual({ open: 0, closed: 2, total: 2 });
    expect(result.findings.map(({ plan, id, status }) => ({ plan, id, status }))).toEqual([
      { plan: "Plan-1", id: "I1", status: "RESOLVED" },
      { plan: "Plan-1", id: "V1", status: "RESOLVED" },
    ]);
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
