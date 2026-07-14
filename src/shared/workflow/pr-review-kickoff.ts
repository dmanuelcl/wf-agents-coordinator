import { substituteReviewKickoff } from "./review-config";

export interface PrReviewKickoffParams {
  /** The project's review kickoff template ({branch}/{base}). */
  template: string;
  /** Worktree ref under review (e.g. origin/feature/x). */
  branch: string;
  /** Base ref to diff against (e.g. origin/develop). */
  base: string;
  /** Full bodies of this tool's prior review comments on the PR, oldest → newest. */
  priorReports: string[];
  /** Source SHA of the last posted review; null on first run. */
  lastReviewedSha: string | null;
  /** The gitignored file the reviewer must write its report to. */
  artifactFile: string;
}

/**
 * Assemble the reviewer kickoff for a PR-link review. Progressive: prior reports
 * are passed VERBATIM (not summarized, so nothing is lost) and the diff is scoped
 * to what changed since the last review.
 */
export function buildPrReviewKickoff(p: PrReviewKickoffParams): string {
  const parts: string[] = [substituteReviewKickoff(p.template, { branch: p.branch, base: p.base })];

  if (p.priorReports.length > 0) {
    const joined = p.priorReports.map((r, i) => `--- Review previo ${i + 1} ---\n${r}`).join("\n\n");
    parts.push(
      "Reportes previos de esta herramienta en este PR (del más viejo al más nuevo). Tenlos en cuenta: " +
        "marca lo que ya se resolvió y lo que sigue pendiente, y no repitas lo ya dicho salvo que siga sin resolverse:\n\n" +
        joined,
    );
  }

  if (p.lastReviewedSha) {
    parts.push(`Analiza SOLO los cambios nuevos desde el último review: \`git diff ${p.lastReviewedSha}..HEAD\`.`);
  } else {
    parts.push(`Es el primer review: analiza el diff completo \`git diff ${p.base}..HEAD\`.`);
  }

  parts.push(
    `Escribe el review COMPLETO en markdown al archivo \`${p.artifactFile}\` en la raíz del worktree ` +
      `(está gitignored — no lo commitees). Ese archivo es lo que se publicará como comentario del PR.`,
  );

  return parts.join("\n\n");
}
