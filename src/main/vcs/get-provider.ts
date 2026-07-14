import { bitbucketProvider } from "./bitbucket-provider";
import type { VcsHost, VcsHostProvider } from "./vcs-provider";

/**
 * Resolve the host-specific provider. GitHub is added in Phase 5; until then it
 * throws a clear error rather than silently doing nothing.
 */
export function getProvider(host: VcsHost): VcsHostProvider {
  if (host === "bitbucket") return bitbucketProvider;
  throw new Error(`VCS host "${host}" is not supported yet`);
}
