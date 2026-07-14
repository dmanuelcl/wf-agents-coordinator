import { REVIEW_COMMENT_MARKER } from "./vcs-provider";
import type { PrRef, ResolvedPr, ReviewComment, VcsCredentials, VcsHostProvider } from "./vcs-provider";

const API = "https://api.bitbucket.org/2.0";

// Bitbucket API tokens authenticate with Basic (email:token); workspace/repo
// access tokens use Bearer (no email). Pick by whether an email is configured.
function authHeader(creds: VcsCredentials): string {
  if (creds.email) {
    return `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString("base64")}`;
  }
  return `Bearer ${creds.token}`;
}

interface BitbucketPr {
  title?: string;
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
}

/** Pure JSON → ResolvedPr mapping (unit-tested; no network). */
export function mapPullRequest(json: unknown, ref: PrRef): ResolvedPr {
  const pr = json as BitbucketPr;
  const source = pr.source?.branch?.name;
  const target = pr.destination?.branch?.name;
  if (!source || !target) {
    throw new Error("Bitbucket PR response is missing a source/destination branch");
  }
  return { ...ref, source, target, title: pr.title ?? ref.url };
}

interface BitbucketComment {
  id?: number | string;
  content?: { raw?: string };
  created_on?: string;
  links?: { html?: { href?: string } };
}

/** Pure paginated-comments JSON → ReviewComment[] mapping (unit-tested). */
export function mapComments(values: BitbucketComment[]): ReviewComment[] {
  return values.map((c) => {
    const body = c.content?.raw ?? "";
    return {
      id: String(c.id ?? ""),
      body,
      createdAtEpochMs: c.created_on ? Date.parse(c.created_on) : 0,
      authoredByTool: body.includes(REVIEW_COMMENT_MARKER),
    };
  });
}

async function bbFetch(url: string, creds: VcsCredentials, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: authHeader(creds), Accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`Bitbucket ${init?.method ?? "GET"} ${url} → ${res.status}: ${await res.text()}`);
  }
  return res;
}

export const bitbucketProvider: VcsHostProvider = {
  host: "bitbucket",

  async resolvePr(ref, creds) {
    const res = await bbFetch(`${API}/repositories/${ref.workspace}/${ref.repo}/pullrequests/${ref.prId}`, creds);
    return mapPullRequest(await res.json(), ref);
  },

  async listReviewComments(ref, creds) {
    const out: ReviewComment[] = [];
    let next: string | null = `${API}/repositories/${ref.workspace}/${ref.repo}/pullrequests/${ref.prId}/comments?pagelen=50`;
    // Follow Bitbucket's cursor pagination until there are no more pages.
    while (next) {
      const res = await bbFetch(next, creds);
      const page = (await res.json()) as { values?: BitbucketComment[]; next?: string };
      out.push(...mapComments(page.values ?? []));
      next = page.next ?? null;
    }
    return out;
  },

  async postComment(ref, body, creds) {
    const res = await bbFetch(`${API}/repositories/${ref.workspace}/${ref.repo}/pullrequests/${ref.prId}/comments`, creds, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: { raw: body } }),
    });
    const json = (await res.json()) as { links?: { html?: { href?: string } } };
    return { url: json.links?.html?.href ?? ref.url };
  },
};
