import type { VcsHost } from "../../shared/workflow/vcs-config";

export type { VcsHost };

// The hidden marker appended to every review comment this tool posts, so a
// later (progressive) run can find its own prior reports regardless of which
// account authored them.
export const REVIEW_COMMENT_MARKER = "<!-- agent-coordinator-review -->";

export interface PrRef {
  host: VcsHost;
  workspace: string; // Bitbucket workspace / GitHub owner
  repo: string;
  prId: string;
  url: string; // canonical PR url
}

export interface ResolvedPr extends PrRef {
  source: string; // source branch name
  target: string; // destination / base branch name
  title: string;
  headSha: string; // latest commit on the source branch ("" if the host didn't report it)
}

export interface ReviewComment {
  id: string;
  body: string; // raw markdown
  createdAtEpochMs: number;
  authoredByTool: boolean; // body contains REVIEW_COMMENT_MARKER
  // Set for an inline (file/line) comment; absent for a general PR comment.
  inline?: { path: string; line: number | null };
}

export interface VcsCredentials {
  token: string;
  // Bitbucket API tokens use Basic auth (email:token); access tokens use Bearer
  // (no email). When email is set → Basic, else → Bearer. GitHub → Bearer.
  email?: string;
}

export interface VcsHostProvider {
  host: VcsHost;
  // Authenticated read of the repo — used by the "Test" button to confirm the
  // host, workspace/repo, and token all work. Returns the repo's full name.
  verifyAccess(target: { workspace: string; repo: string }, creds: VcsCredentials): Promise<{ detail: string }>;
  resolvePr(ref: PrRef, creds: VcsCredentials): Promise<ResolvedPr>;
  listReviewComments(ref: PrRef, creds: VcsCredentials): Promise<ReviewComment[]>;
  postComment(ref: PrRef, body: string, creds: VcsCredentials): Promise<{ url: string }>;
}

export function parseBitbucketUrl(url: string): PrRef | null {
  const match = url.match(/^https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
  if (!match) return null;
  const [, workspace, repo, prId] = match;
  return {
    host: "bitbucket",
    workspace: workspace as string,
    repo: repo as string,
    prId: prId as string,
    url: `https://bitbucket.org/${workspace}/${repo}/pull-requests/${prId}`,
  };
}

export function parseGithubUrl(url: string): PrRef | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  const [, workspace, repo, prId] = match;
  return {
    host: "github",
    workspace: workspace as string,
    repo: repo as string,
    prId: prId as string,
    url: `https://github.com/${workspace}/${repo}/pull/${prId}`,
  };
}

export function parsePrUrl(host: VcsHost | "none", url: string): PrRef | null {
  if (host === "bitbucket") return parseBitbucketUrl(url);
  if (host === "github") return parseGithubUrl(url);
  return null;
}
