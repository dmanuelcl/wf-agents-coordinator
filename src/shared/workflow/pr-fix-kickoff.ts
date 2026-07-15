export interface FixComment {
  body: string;
  inline?: { path: string; line: number | null };
}

export interface PrFixKickoffParams {
  title: string;
  source: string;
  target: string;
  /** All PR comments, oldest → newest. */
  comments: FixComment[];
}

/**
 * Assemble the implementer kickoff for a PR-fix session: feed all PR comments
 * (verbatim, with inline file:line context) and instruct implement + commit but
 * NOT push (the user pushes with the gated button).
 */
export function buildPrFixKickoff(p: PrFixKickoffParams): string {
  const header = `Estás resolviendo los comentarios del PR «${p.title}» (${p.source} → ${p.target}).`;

  const list =
    p.comments.length > 0
      ? p.comments
          .map((c, i) => {
            const loc = c.inline
              ? ` (en ${c.inline.path}${c.inline.line != null ? `:${c.inline.line}` : ""})`
              : "";
            return `${i + 1}.${loc} ${c.body}`;
          })
          .join("\n\n")
      : "(No hay comentarios en el PR todavía — revisa igual la conversación y el diff.)";

  const instructions =
    "Implementa los cambios pedidos en este branch (es escribible). Haz **commit** de cada cambio " +
    "con un mensaje claro. **NO hagas push** — yo reviso y pusheo. Si algún comentario ya está " +
    "resuelto en el código, anótalo y sigue.";

  return [header, `Comentarios del PR (en orden):\n\n${list}`, instructions].join("\n\n");
}
