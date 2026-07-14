import { bitbucketProvider } from "./bitbucket-provider";
import { githubProvider } from "./github-provider";
import type { VcsHost, VcsHostProvider } from "./vcs-provider";

/** Resolve the host-specific provider. */
export function getProvider(host: VcsHost): VcsHostProvider {
  if (host === "bitbucket") return bitbucketProvider;
  if (host === "github") return githubProvider;
  throw new Error(`VCS host "${host}" is not supported yet`);
}
