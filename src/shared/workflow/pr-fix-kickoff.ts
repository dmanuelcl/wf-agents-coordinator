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
  /** Gitignored handoff checkpoint that unlocks the reviewer. */
  completionCheckpoint: string;
}

export function prFixCompletionCheckpointPath(slug: string): string {
  return `docs/workflow/checkpoints/${slug}-pr-fix-checkpoint.md`;
}

/** Valid workflow checkpoint used as the implementer → reviewer handoff. */
export function buildPrFixCompletionCheckpoint(params: {
  slug: string;
  completionCheckpoint: string;
}): string {
  return `---
feature: PR fix
slug: ${params.slug}
kind: fix
status: IN_PROGRESS
active: none
---

# ▶ NEXT
- **Rol:** reviewer
- **Corre:** \`wf review ${params.completionCheckpoint}\`
- **Abre sesión fresca en:** reviewer · cwd \`.\`
- **Tarea:** Revisar las correcciones del PR antes del push.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | PR comments | ✅ | – | ⏳ | REVIEW |

# Log

## implementer · READY_FOR_REVIEW
Correcciones implementadas, probadas y commiteadas; listas para revisión.`;
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
    "resuelto en el código, anótalo y sigue.";

  const checkpoint = buildPrFixCompletionCheckpoint(p);

  const handoff =
    `Como ÚLTIMO paso, solo después de terminar los cambios, ejecutar las pruebas y crear los commits, escribe ` +
    `el checkpoint \`${p.completionCheckpoint}\` con el contenido exacto de abajo. ` +
    "Está gitignored: no lo añadas al commit. Su creación desbloquea el Reviewer, así que no lo crees antes de tiempo.\n\n" +
    `\`\`\`markdown\n${checkpoint}\n\`\`\``;

  return [header, context, instructions, handoff].join("\n\n");
}

/**
 * Assemble the second PR-fix stage. It reviews the committed correction against
 * the original PR conversation without modifying or pushing the branch.
 */
export function buildPrFixReviewKickoff(p: PrFixContextParams): string {
  const header = `Revisa las correcciones realizadas para el PR «${p.title}» (${p.source} → ${p.target}).`;
  const context =
    `Antes de comenzar, lee COMPLETO el archivo \`${p.contextFile}\` en la raíz del worktree. ` +
    "Contiene la conversación completa del PR en orden cronológico, incluidos los comentarios inline. " +
    "Si una lectura se trunca, continúa por partes hasta llegar al final.";
  const diff = p.fixBaseSha ? `git diff ${p.fixBaseSha}..HEAD` : `git diff ${p.target}...HEAD`;
  const instructions =
    `Revisa el estado actual del branch y el diff \`${diff}\`. ` +
    "Comprueba uno por uno que los comentarios del PR quedaron resueltos, busca regresiones y ejecuta las pruebas " +
    "relevantes. No modifiques archivos, no hagas commit y **NO hagas push**. Reporta primero los problemas " +
    "accionables con archivo y línea; si no encuentras ninguno, aprueba explícitamente las correcciones.";

  return [header, context, instructions].join("\n\n");
}
