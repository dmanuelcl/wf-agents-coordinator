export interface PrFixKickoffParams {
  title: string;
  source: string;
  target: string;
  /** Gitignored markdown file containing the complete PR conversation. */
  contextFile: string;
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

  return [header, context, instructions].join("\n\n");
}
