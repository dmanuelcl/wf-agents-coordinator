/**
 * Detect startup screens that require a human response before Coordinator may
 * submit an initial workflow prompt. This lives in shared code because the
 * runner, rather than a browser view, owns deferred prompt delivery.
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
