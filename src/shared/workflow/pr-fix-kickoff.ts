import type { SessionAgentRole } from "./session-role-launch";
import { wfCommandForSessionRole } from "./session-role-launch";

export interface PrFixContextParams {
  title: string;
  source: string;
  target: string;
  /** Gitignored markdown file containing the complete PR conversation. */
  contextFile: string;
  /** HEAD captured before fixes began; absent on sessions created by older builds. */
  fixBaseSha?: string | null;
}

export interface PrFixKickoffParams extends PrFixContextParams {
  slug: string;
  worktreePath: string;
  /** Gitignored handoff checkpoint that unlocks the reviewer. */
  completionCheckpoint: string;
}

export function prFixCompletionCheckpointPath(slug: string): string {
  return `docs/workflow/checkpoints/${slug}-pr-fix-checkpoint.md`;
}

/** Valid workflow checkpoint used as the implementer → reviewer handoff. */
export function buildPrFixCompletionCheckpoint(params: {
  slug: string;
  branch: string;
  worktreePath: string;
  completionCheckpoint: string;
  contextFile: string;
  fixBaseSha?: string | null;
}): string {
  const baseline = params.fixBaseSha ?? "<full baseline commit SHA captured before first edit>";
  return `---
feature: PR fix
slug: ${params.slug}
kind: fix
branch: ${params.branch}
worktree: ${params.worktreePath}
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** reviewer
- **Corre:** \`wf review ${params.completionCheckpoint}\`
- **Abre sesión fresca en:** capacidad alta (juicio) · esfuerzo moderado · cwd \`.\`
- **Tarea:** Revisar las correcciones del PR antes del push.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | fix-brief | ✅ | – | ⏳ | REVIEW |

# Log

## <YYYY-MM-DD HH:mm> · implementer · IMPLEMENT_START · fix-brief → ⏳
Review scope baseline:
- **Baseline commit:** ${baseline}
- **Pre-existing dirty paths:** <exact paths, or none>
- **Planned paths:** <exact paths planned before editing>

Acceptance context: read \`${params.contextFile}\` completely and reconcile every PR comment.

## <YYYY-MM-DD HH:mm> · implementer · IMPLEMENT · fix-brief → ✅
Correcciones implementadas, probadas y commiteadas; listas para revisión.

Review scope:
- **Baseline commit:** ${baseline}
- **Ending commit:** <full ending commit SHA>
- **Committed range:** ${baseline}..<full ending commit SHA>
- **Included files:** <exact paths included in the review>
- **Excluded paths:** <exact paths excluded from the review>

Gates executed:
- <exact command> — <PASS or FAIL plus concise evidence>

PR comment outcomes (same order as \`${params.contextFile}\`):
- <comment identifier/location> — <resolved, already resolved, obsolete, or still open; include evidence>`;
}

/**
 * Assemble the implementer kickoff for a PR-fix session. The potentially large
 * PR conversation lives in contextFile so the terminal prompt cannot truncate
 * it. The user pushes with the gated button.
 */
export function buildPrFixKickoff(p: PrFixKickoffParams): string {
  const header = `Estás resolviendo los comentarios del PR «${p.title}» (${p.source} → ${p.target}).`;
  const context =
    `Antes de comenzar, lee COMPLETO el archivo \`${p.contextFile}\` en la raíz del worktree. ` +
    "Contiene la conversación completa del PR en orden cronológico, incluidos los comentarios inline. " +
    "Si una lectura se trunca, continúa leyéndolo por partes hasta llegar al final del archivo. " +
    "No implementes nada hasta haberlo leído hasta el final.";

  const instructions =
    "Implementa los cambios pedidos en este branch (es escribible). Haz **commit** de cada cambio " +
    "con un mensaje claro. **NO hagas push** — yo reviso y pusheo. Si algún comentario ya está " +
    "resuelto en el código, anótalo y sigue. Antes de la primera edición, captura el commit base, " +
    "los paths que ya estaban dirty y los paths que planeas tocar; esos datos forman el scope auditable del review.";

  const checkpoint = buildPrFixCompletionCheckpoint({
    ...p,
    branch: p.source,
  });

  const handoff =
    `Como ÚLTIMO paso, solo después de terminar los cambios, ejecutar las pruebas y crear los commits, escribe ` +
    `el checkpoint \`${p.completionCheckpoint}\` usando la plantilla de abajo. Reemplaza cada marcador ` +
    "`<...>` con valores observados y no dejes placeholders; conserva los encabezados y labels porque el workflow los parsea. " +
    "Está gitignored: no lo añadas al commit. Su creación desbloquea el Reviewer, así que no lo crees antes de tiempo.\n\n" +
    `\`\`\`markdown\n${checkpoint}\n\`\`\``;

  return [header, context, instructions, handoff].join("\n\n");
}

/**
 * A PR fix has one custom entrypoint only: the first implementer kickoff. Once
 * its checkpoint exists, every stage follows the canonical workflow command so
 * NEXT, ledger, findings and correction loops all share one source of truth.
 */
export function buildPrFixRoleCommand(
  params: PrFixKickoffParams & {
    role: SessionAgentRole;
    checkpointPath: string | null;
  },
): string | null {
  if (params.role === "implementer" && !params.checkpointPath) {
    return buildPrFixKickoff(params);
  }
  return wfCommandForSessionRole(params.role, params.checkpointPath);
}
