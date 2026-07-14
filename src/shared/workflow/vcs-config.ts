export type VcsHost = "bitbucket" | "github";

/** Per-project VCS host config. The API token is NOT here — it is stored
 * encrypted in the secret store (see `vcs-secret-store.ts`); this holds only the
 * non-secret bits. `host: "none"` disables the PR-link flow. */
export interface VcsConfig {
  host: VcsHost | "none";
  workspace: string; // Bitbucket workspace / GitHub owner
  repo: string;
  email: string; // set → Bitbucket Basic auth (email:token); empty → Bearer
}

export function createDefaultVcsConfig(): VcsConfig {
  return { host: "none", workspace: "", repo: "", email: "" };
}
