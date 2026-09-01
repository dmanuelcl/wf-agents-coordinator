import { substituteReviewKickoff } from "./review-config";

export interface PrReviewKickoffParams {
  /** The project's review kickoff template ({branch}/{base}). */
  template: string;
  /** Worktree ref under review (e.g. origin/feature/x). */
  branch: string;
  /** Base ref to diff against (e.g. origin/develop). */
  base: string;
  /** Source SHA of the last posted review; null on first run. */
  lastReviewedSha: string | null;
}

/**
 * Assemble the reviewer kickoff for a PR-link review.
 *
 * The kickoff carries the project's template and nothing else procedural: the
 * template names the review protocol (for Biznex, the `biznex-pr-review` skill),
 * and that protocol owns how the context file is read, which diff is run and how
 * the report is written and verified. Injecting our own version of those steps
 * produced a review that only RESEMBLED the protocol — so the app stopped.
 *
 * The one thing we still pass is `lastReviewedSha`, and it goes as DATA, not as
 * an instruction: the published report never records the HEAD it reviewed, so
 * the session cannot recover the previous round's head from the context file.
 * The registry is the only authoritative source for it.
 */
export function buildPrReviewKickoff(p: PrReviewKickoffParams): string {
  const parts: string[] = [substituteReviewKickoff(p.template, { branch: p.branch, base: p.base })];

  if (p.lastReviewedSha) {
    parts.push(
      "Dato del coordinador (no es una instrucción): el último commit ya revisado y publicado " +
        `en este PR es \`${p.lastReviewedSha}\`.`,
    );
  }

  return parts.join("\n\n");
}
