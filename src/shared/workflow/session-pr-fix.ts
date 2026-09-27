import { getPrFixPushGate } from "./pr-fix-push-gate";
import type { PrFixPushGate } from "./pr-fix-push-gate";
import type { PrLink, WorkSession } from "./work-session";
import type { ParsedCheckpoint, WorkflowKind } from "./workflow-types";

/**
 * PR fix inside the session that built the branch. The PR's source branch is
 * already checked out in this session's worktree and git allows a branch in one
 * worktree only, so a separate PR-fix session cannot open it. Instead the
 * Reviewer that closed the checkpoint reopens it with the PR report as a
 * `⚠ ISSUES` round, and the workflow's own correction loop takes it from there.
 */

export type SessionPrFixGate = PrFixPushGate;

export function getSessionPrFixGate(
  session: Pick<WorkSession, "kind" | "checkpointPath">,
  checkpoint: ParsedCheckpoint | null,
): SessionPrFixGate {
  if (session.kind !== "feature" && session.kind !== "fix") {
    return { allowed: false, reason: "PR sessions have their own fix flow." };
  }
  if (!session.checkpointPath || !checkpoint) {
    return { allowed: false, reason: "The session has no checkpoint to reopen." };
  }
  if (checkpoint.status !== "DONE") {
    return { allowed: false, reason: "PR fix reopens a DONE checkpoint; this one is still running." };
  }
  return { allowed: true, reason: null };
}

/** Push from a feature/fix session: only once a PR fix linked its PR, then the same gate as a PR-fix session. */
export function getSessionPrPushGate(
  session: { pr: Pick<PrLink, "prId"> | null },
  checkpoint: ParsedCheckpoint | null,
): PrFixPushGate {
  if (!session.pr) return { allowed: false, reason: "Start a PR fix first: it links this session to its PR." };
  return getPrFixPushGate(checkpoint);
}

export interface SessionPrFixLanes {
  /** The review stage that closed the checkpoint, and the one its reopening entry names. */
  stage: "FEATURE_REVIEW" | "PR_REVIEW";
  reviewer: string;
  implementer: string;
}

/** A feature closes in FEATURE_REVIEW and a fix in PR_REVIEW; the reopening resumes that reviewer lane. */
export function sessionPrFixLanes(kind: WorkflowKind): SessionPrFixLanes {
  if (kind === "fix") return { stage: "PR_REVIEW", reviewer: "fix/reviewer", implementer: "fix/implementer" };
  return { stage: "FEATURE_REVIEW", reviewer: "feature-review/reviewer", implementer: "feature-review/implementer" };
}

export interface SessionPrFixKickoffParams {
  prId: string;
  title: string;
  source: string;
  target: string;
  /** Gitignored markdown file with the complete PR conversation. */
  contextFile: string;
  checkpointPath: string;
  checkpointKind: WorkflowKind;
  /** Program spec when the checkpoint is one of its children. */
  program: string | null;
  /** HEAD when the fix starts: the review scope of the correction begins here. */
  baselineSha: string;
}

/**
 * The prompt typed into the Reviewer tab. It is complete on its own because the
 * session's branch may carry a workflow manual older than this entry; the
 * potentially large PR conversation stays in `contextFile`.
 */
export function buildSessionPrFixReviewerKickoff(p: SessionPrFixKickoffParams): string {
  const lanes = sessionPrFixLanes(p.checkpointKind);
  const header =
    `Sos el REVIEWER de \`${p.checkpointPath}\` y el PR #${p.prId} «${p.title}» (${p.source} → ${p.target}) volvió con comentarios. ` +
    "Esta es la entrada **PR fix · reapertura**, pedida por el usuario desde el coordinador: tu mismo loop de corrección de `reviewer.md`, con el reporte del PR como hallazgos de entrada, sobre el mismo checkpoint y la misma rama.";
  const context =
    `Lee COMPLETO \`${p.contextFile}\` en la raíz del worktree: la conversación del PR en orden, con el reporte del PR review y su \`Plan de corrección\`. ` +
    "Si se trunca, seguí por partes hasta el final. Ese reporte es el diagnóstico de un revisor limpio: no rehagas la revisión holística; verificá contra el código cada hallazgo que cites. " +
    "Un hallazgo que el código ya no muestra se cierra en tu entrada con su evidencia, no se planifica. No edites código.";

  const reopen = [
    `Reabrí \`${p.checkpointPath}\` (hoy \`status: DONE\`):`,
    "- Frontmatter: `status: IN_PROGRESS`, `active: none`.",
    ...(p.program
      ? [`- Hijo de \`${p.program}\`: su fila de \`# Hijos\` vuelve a \`IN_PROGRESS\` (\`wf:done\` rechaza un índice DONE con el checkpoint abierto).`]
      : []),
    ...(lanes.stage === "PR_REVIEW" ? ["- Ledger: la celda `PR_REVIEW` de la fila vuelve a `⚠`."] : []),
    `- Entrada nueva, la última del \`# Log\`: \`## <YYYY-MM-DD HH:mm> · reviewer · ${lanes.stage} · PR fix #${p.prId} → ⚠ ISSUES\`, con:`,
    `  - \`**Baseline commit:** ${p.baselineSha}\` — el scope de la corrección empieza acá.`,
    "  - Cada comentario del PR reconciliado con su hallazgo (IDs nuevos y monotónicos, con el comentario de origen) o con su evidencia de que ya no aplica.",
    "  - El `Plan de corrección` ejecutable: el del reporte, verificado contra el código y ajustado. Un paso con bloque literal lleva `Literal verificado: sí — <quién abrió el fichero>`.",
    "  - `Plan sufficiency: PASS — executable by a lower-capability implementer without inventing.`",
    "  - `PLAN_REVIEW:` — con el recibo de auditoría del reporte (`### … review audit report`): `PLAN_REVIEW: recibo del reporte del PR — no se repite`; sin recibo, corré el loop acotado y registrá sus rondas.",
    "  - `Follow-ups added: <IDs | none>`.",
    "- `▶ NEXT`, la ÚLTIMA edición del fichero:",
    "  - **Rol:** implementer",
    `  - **Corre:** \`wf implement ${p.checkpointPath}\``,
    `  - **Session lane:** \`${lanes.implementer}\``,
    `  - **Tarea:** corregir el PR #${p.prId} según el Plan de corrección.`,
  ].join("\n");

  const blocked =
    "Si un comentario pide una decisión de producto o un rediseño que el spec y los planes no cubren: `status: BLOCKED`, `▶ NEXT` → architect con lane `architect`, y publicás hacia él.";
  const publish =
    `Último paso, siempre: \`pnpm wf:done --role implementer --lane ${lanes.implementer} --checkpoint ${p.checkpointPath}\` ` +
    "(o `--role architect --lane architect` si bloqueaste). Nunca `git push`: el usuario pushea con el botón cuando el loop cierre en DONE.";

  return [header, context, reopen, blocked, publish].join("\n\n");
}
