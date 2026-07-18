import { substituteReviewKickoff } from "./review-config";

export interface PrReviewKickoffParams {
  /** The project's review kickoff template ({branch}/{base}). */
  template: string;
  /** Worktree ref under review (e.g. origin/feature/x). */
  branch: string;
  /** Base ref to diff against (e.g. origin/develop). */
  base: string;
  /** Gitignored markdown file containing the complete PR conversation. */
  contextFile: string;
  /** Source SHA of the last posted review; null on first run. */
  lastReviewedSha: string | null;
  /** The gitignored file the reviewer must write its report to. */
  artifactFile: string;
}

/**
 * Assemble the reviewer kickoff for a PR-link review. The potentially large PR
 * conversation lives in contextFile so the terminal prompt cannot truncate it.
 * The diff is scoped to what changed since the last review.
 */
export function buildPrReviewKickoff(p: PrReviewKickoffParams): string {
  const parts: string[] = [substituteReviewKickoff(p.template, { branch: p.branch, base: p.base })];

  parts.push(
    `Antes de comenzar, lee COMPLETO el archivo \`${p.contextFile}\` en la raíz del worktree. ` +
      "Contiene toda la conversación del PR en orden cronológico y marca los reportes previos de Agent Coordinator. " +
      "Tenlos en cuenta: identifica lo resuelto, conserva lo pendiente y no repitas hallazgos ya corregidos. " +
      "Si una lectura se trunca, continúa leyéndolo por partes hasta llegar al final del archivo. " +
      "No empieces el review hasta haber leído el archivo hasta el final.",
  );

  if (p.lastReviewedSha) {
    parts.push(`Analiza SOLO los cambios nuevos desde el último review: \`git diff ${p.lastReviewedSha}..HEAD\`.`);
  } else {
    parts.push(`Es el primer review: analiza el diff completo \`git diff ${p.base}...HEAD\`.`);
  }

  parts.push(
    `Escribe el review COMPLETO en markdown al archivo \`${p.artifactFile}\` en la raíz del worktree ` +
      `(está gitignored — no lo commitees). Ese archivo es lo que se publicará como comentario del PR.`,
  );

  return parts.join("\n\n");
}
