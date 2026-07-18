/**
 * Detect startup screens that must be answered by the user before an automated
 * prompt may be pasted. Keep this deliberately narrow: normal agent chrome can
 * mention permission mode, but a confirmation also contains an explicit choice.
 */
export function hasBlockingStartupConfirmation(visibleText: string): boolean {
  const text = visibleText.replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return false;

  const hasPermissionBypassWarning =
    /(?:bypass|skip).{0,100}permissions?/.test(text) || /permissions?.{0,100}(?:bypass|skip)/.test(text);
  const hasTrustWarning =
    /(?:trust|untrusted).{0,100}(?:folder|workspace|directory)/.test(text) ||
    /(?:folder|workspace|directory).{0,100}(?:trust|untrusted)/.test(text);
  const hasExplicitChoice =
    /\b(?:yes|no|accept|cancel|confirm|continue|exit)\b/.test(text) ||
    /(?:press|hit) (?:enter|return)/.test(text);

  return (hasPermissionBypassWarning || hasTrustWarning) && hasExplicitChoice;
}
