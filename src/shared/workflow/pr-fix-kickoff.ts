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
- **Session lane:** \`fix/reviewer\`
- **Ejecuta sesión en:** capacidad alta (juicio) · esfuerzo moderado · cwd \`.\`
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

/** Valid Architect → Implementer handoff for the optional diagnose-first flow. */
export function buildPrFixDiagnosisCheckpoint(params: {
  slug: string;
  branch: string;
  worktreePath: string;
  completionCheckpoint: string;
  contextFile: string;
  fixBaseSha?: string | null;
}): string {
  const baseline = params.fixBaseSha ?? "<full PR head SHA captured before diagnosis>";
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
- **Rol:** implementer
- **Corre:** \`wf implement ${params.completionCheckpoint}\`
- **Session lane:** \`fix/implementer\`
- **Ejecuta sesión en:** capacidad alta (ejecución) · esfuerzo moderado · cwd \`.\`
- **Tarea:** Ejecutar el plan de corrección de comentarios del PR, probarlo y dejarlo listo para PR review.

# Plans ledger
| # | Plan | IMPLEMENT | ARCH_REVIEW | PR_REVIEW | Estado |
|---|------|-----------|-------------|-----------|--------|
| 1 | PR comments correction plan | ⏳ | – | – | PLANNED |

# Plan de corrección

**Alcance de revisión:**
- **Baseline commit:** ${baseline}
- **Comentarios fuente:** \`${params.contextFile}\`
- **Archivos previstos:** <rutas exactas>

#### Paso 1 — <acción concreta> [origen: <comentario del PR>]

- **Archivos:** <rutas exactas>
- **Qué hacer:** <cambio ejecutable, sin decisiones pendientes>
- **Aceptación:** <prueba o evidencia concreta>

**Plan sufficiency:** PASS — executable by the Implementer without inventing.

# Log

## <YYYY-MM-DD HH:mm> · architect · DIAGNOSE · PR comments → ✅

El Architect leyó \`${params.contextFile}\`, inspeccionó el código y convirtió todos los comentarios aplicables en el plan ejecutable anterior.`;
}

/**
 * The Architect has the PR discussion but must not edit the branch. Its only
 * output is the durable plan/checkpoint that makes the Implementer available.
 */
export function buildPrFixArchitectKickoff(p: PrFixKickoffParams): string {
  const header = `Vas a diagnosticar los comentarios del PR «${p.title}» (${p.source} → ${p.target}) antes de implementar.`;
  const context =
    `Lee COMPLETO \`${p.contextFile}\` en la raíz del worktree; contiene la conversación completa del PR, incluidos comentarios inline. ` +
    "Si se trunca, léelo por partes hasta llegar al final. Después inspecciona el código y el diff necesario para entender cada comentario.";
  const scope =
    "No implementes cambios, no hagas commit y no hagas push. Convierte los comentarios aplicables en un plan concreto y ordenado, " +
    "con archivos, cambios, pruebas y criterios de aceptación. Marca explícitamente los comentarios ya resueltos u obsoletos con evidencia.";
  const checkpoint = buildPrFixDiagnosisCheckpoint({
    ...p,
    branch: p.source,
  });
  const handoff =
    `Como último paso escribe el checkpoint \`${p.completionCheckpoint}\` usando esta plantilla. Reemplaza todo \`<...>\` con información observada ` +
    "y conserva los encabezados, el ledger y el bloque ▶ NEXT exactamente: su creación desbloquea al Implementer. " +
    "El archivo es gitignored; no lo añadas al commit.\n\n" +
    `\`\`\`markdown\n${checkpoint}\n\`\`\``;

  return [header, context, scope, handoff].join("\n\n");
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
 * A PR fix has one custom entrypoint: either its initial Implementer kickoff
 * or its optional Architect diagnosis. Once its checkpoint exists, every stage
 * follows the canonical workflow command so NEXT, ledger, findings and
 * correction loops all share one source of truth.
 */
export function buildPrFixRoleCommand(
  params: PrFixKickoffParams & {
    role: SessionAgentRole;
    checkpointPath: string | null;
    diagnoseFirst?: boolean;
  },
): string | null {
  if (params.diagnoseFirst && params.role === "architect" && !params.checkpointPath) {
    return buildPrFixArchitectKickoff(params);
  }
  if (!params.diagnoseFirst && params.role === "implementer" && !params.checkpointPath) {
    return buildPrFixKickoff(params);
  }
  return wfCommandForSessionRole(params.role, params.checkpointPath);
}
