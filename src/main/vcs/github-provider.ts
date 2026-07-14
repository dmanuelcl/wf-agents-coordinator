import { REVIEW_COMMENT_MARKER } from "./vcs-provider";
import type { PrRef, ResolvedPr, ReviewComment, VcsCredentials, VcsHostProvider } from "./vcs-provider";

const API = "https://api.github.com";

function headers(creds: VcsCredentials): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-coordinator",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

interface GithubPr {
  title?: string;
  head?: { ref?: string };
  base?: { ref?: string };
}

/** Pure JSON → ResolvedPr mapping (unit-tested). */
export function mapPullRequest(json: unknown, ref: PrRef): ResolvedPr {
  const pr = json as GithubPr;
  const source = pr.head?.ref;
  const target = pr.base?.ref;
  if (!source || !target) throw new Error("GitHub PR response is missing a head/base ref");
  return { ...ref, source, target, title: pr.title ?? ref.url };
}

interface GithubComment {
  id?: number | string;
  body?: string;
  created_at?: string;
  html_url?: string;
}

/** Pure issue-comments JSON → ReviewComment[] mapping (unit-tested). */
export function mapIssueComments(values: GithubComment[]): ReviewComment[] {
  return values.map((c) => {
    const body = c.body ?? "";
    return {
      id: String(c.id ?? ""),
      body,
      createdAtEpochMs: c.created_at ? Date.parse(c.created_at) : 0,
      authoredByTool: body.includes(REVIEW_COMMENT_MARKER),
    };
  });
}

/** Extract the `rel="next"` URL from a GitHub Link header (pure, unit-tested). */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1] ?? null;
  }
  return null;
}

async function ghFetch(url: string, creds: VcsCredentials, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...headers(creds), ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? "GET"} ${url} → ${res.status}: ${await res.text()}`);
  return res;
}

export const githubProvider: VcsHostProvider = {
  host: "github",

  async verifyAccess(target, creds) {
    const res = await ghFetch(`${API}/repos/${target.workspace}/${target.repo}`, creds);
    const json = (await res.json()) as { full_name?: string };
    return { detail: json.full_name ?? `${target.workspace}/${target.repo}` };
  },

  async resolvePr(ref, creds) {
    const res = await ghFetch(`${API}/repos/${ref.workspace}/${ref.repo}/pulls/${ref.prId}`, creds);
    return mapPullRequest(await res.json(), ref);
  },

  async listReviewComments(ref, creds) {
    const out: ReviewComment[] = [];
    let next: string | null = `${API}/repos/${ref.workspace}/${ref.repo}/issues/${ref.prId}/comments?per_page=100`;
    while (next) {
      const res = await ghFetch(next, creds);
      out.push(...mapIssueComments((await res.json()) as GithubComment[]));
      next = parseNextLink(res.headers.get("link"));
    }
    return out;
  },

  async postComment(ref, body, creds) {
    const res = await ghFetch(`${API}/repos/${ref.workspace}/${ref.repo}/issues/${ref.prId}/comments`, creds, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const json = (await res.json()) as { html_url?: string };
    return { url: json.html_url ?? ref.url };
  },
};
