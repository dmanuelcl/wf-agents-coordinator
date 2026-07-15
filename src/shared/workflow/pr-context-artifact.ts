export interface PrContextComment {
  body: string;
  authoredByTool: boolean;
  inline?: { path: string; line: number | null };
}

export interface PrContextArtifactParams {
  mode: "review" | "fix";
  /** All PR comments, oldest → newest. */
  comments: PrContextComment[];
  /** Present when the provider could not load the conversation. */
  loadError?: string | null;
}

/** Build the complete, local PR conversation consumed by reviewer/implementer. */
export function buildPrContextArtifact(params: PrContextArtifactParams): string {
  const purpose =
    params.mode === "review"
      ? "Contexto completo para revisar el PR"
      : "Contexto completo para resolver los comentarios del PR";
  const parts = [
    `# ${purpose}`,
    "Los comentarios aparecen completos y en orden cronológico. Los marcados como reporte previo fueron publicados por Agent Coordinator.",
  ];

  if (params.loadError) {
    parts.push(`> No se pudo descargar la conversación del PR: ${params.loadError}`);
  } else if (params.comments.length === 0) {
    parts.push("_El PR no tiene comentarios todavía._");
  } else {
    parts.push(
      params.comments
        .map((comment, index) => {
          const heading = `## Comentario ${index + 1}${comment.authoredByTool ? " — reporte previo de Agent Coordinator" : ""}`;
          const location = comment.inline
            ? `**Ubicación:** \`${comment.inline.path}${comment.inline.line === null ? "" : `:${comment.inline.line}`}\``
            : null;
          return [heading, location, comment.body].filter((part): part is string => part !== null).join("\n\n");
        })
        .join("\n\n"),
    );
  }

  return `${parts.join("\n\n")}\n`;
}
