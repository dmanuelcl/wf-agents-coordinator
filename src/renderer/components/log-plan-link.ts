const MARKDOWN_FILE = /\.mdx?$/i;

/** Extract a markdown plan path from the ledger's plain, code or link formats. */
export function planFileToken(planCell: string): string | null {
  const value = planCell.trim();
  const markdownLink = value.match(/^\[[^\]]*\]\(\s*<?([^)>]+\.mdx?)>?\s*\)$/i)?.[1];
  if (markdownLink) return markdownLink.trim();

  const codePath = value.match(/^`([^`]+\.mdx?)`$/i)?.[1];
  if (codePath) return codePath.trim();

  return MARKDOWN_FILE.test(value) && !/[|\n\r]/.test(value) ? value : null;
}

/**
 * Ledger rows conventionally store only a basename while plans live under
 * docs/workflow/plans. Explicit paths retain terminal-link semantics.
 */
export function planFileCandidates(planCell: string): string[] {
  const token = planFileToken(planCell);
  if (!token) return [];
  const explicit = /[/\\]/.test(token) || token.startsWith("~");
  return explicit ? [token] : [`docs/workflow/plans/${token}`, token];
}
