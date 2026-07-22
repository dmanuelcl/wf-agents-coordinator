/**
 * Strip terminal artifacts a review/PR-comment body should never contain and
 * that break the API's JSON encoding. Bitbucket rejects NUL (0x00) with a 400
 * ("A string literal cannot contain NUL characters."), so remove NUL and the
 * other C0 control characters, plus ANSI escape sequences — while keeping tab,
 * newline, and carriage return, which are valid in markdown.
 */
export function sanitizeCommentBody(text: string): string {
  return text
    // ANSI CSI escape sequences (colors, cursor moves) leaked from terminal output.
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // NUL and other C0 control chars, keeping \t (0x09), \n (0x0A), \r (0x0D).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
