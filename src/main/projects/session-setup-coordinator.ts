export interface SessionSetupCoordinator {
  tryClaim(sessionId: string): boolean;
  release(sessionId: string): void;
}

/**
 * Process-local single-flight guard for worktree setup. The renderer still
 * controls the visible PTY, but only one caller may receive the setup command
 * for a session at a time. Other callers wait and retry after the owner either
 * persists setupDone or releases the claim on failure/unmount.
 */
export function createSessionSetupCoordinator(): SessionSetupCoordinator {
  const claimedSessionIds = new Set<string>();

  return {
    tryClaim(sessionId) {
      if (claimedSessionIds.has(sessionId)) return false;
      claimedSessionIds.add(sessionId);
      return true;
    },

    release(sessionId) {
      claimedSessionIds.delete(sessionId);
    },
  };
}
