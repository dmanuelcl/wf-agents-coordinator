/** Per-project PR-review settings. */
export interface ReviewConfig {
  /** Slack channel to post the review to, e.g. "#pr-reviews". Empty = Post-to-Slack disabled. */
  slackChannel: string;
  /** Review kickoff template with {branch} and {base} placeholders. */
  kickoff: string;
}

export const DEFAULT_REVIEW_KICKOFF =
  "Revisa los cambios de la rama {branch} contra {base}. Lee y analiza cada archivo " +
  "modificado, reporta todos los hallazgos con su severidad, y termina con un resumen " +
  "de todo lo que hay que hacer antes de mergear.";

export function createDefaultReviewConfig(): ReviewConfig {
  return { slackChannel: "", kickoff: DEFAULT_REVIEW_KICKOFF };
}

/** Fill {branch}/{base} in the kickoff template (all occurrences). Blank template → default. */
export function substituteReviewKickoff(template: string, vars: { branch: string; base: string }): string {
  const base = template.trim() ? template : DEFAULT_REVIEW_KICKOFF;
  return base.split("{branch}").join(vars.branch).split("{base}").join(vars.base);
}

/** The instruction the app relays to the reviewer agent to publish the review. */
export function buildSlackPostCommand(channel: string): string {
  return `Publica el resumen completo del review en el canal de Slack ${channel}.`;
}
