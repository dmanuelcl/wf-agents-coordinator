import { REVIEW_COMMENT_MARKER } from "./vcs-provider";
import type { PrRef, ResolvedPr, ReviewComment, VcsCredentials, VcsHostProvider } from "./vcs-provider";

const API = "https://api.bitbucket.org/2.0";

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

// Auth schemes to try, in order, for the given creds:
// - email set → Atlassian API token: Basic(email:token).
// - no email → an Access Token (ATCTT…): try Bearer first, then the
//   `x-token-auth:token` Basic scheme (what `git clone` uses) — some access
//   tokens only accept one of the two on the REST API.
function authSchemes(creds: VcsCredentials): string[] {
  if (creds.email) return [basic(creds.email, creds.token)];
  return [`Bearer ${creds.token}`, basic("x-token-auth", creds.token)];
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
  inline?: { path?: string; to?: number | null; from?: number | null };
}

/** Pure paginated-comments JSON → ReviewComment[] mapping (unit-tested). */
export function mapComments(values: BitbucketComment[]): ReviewComment[] {
  return values.map((c) => {
    const body = c.content?.raw ?? "";
    const comment: ReviewComment = {
      id: String(c.id ?? ""),
      body,
      createdAtEpochMs: c.created_on ? Date.parse(c.created_on) : 0,
      authoredByTool: body.includes(REVIEW_COMMENT_MARKER),
    };
    if (c.inline?.path) {
      comment.inline = { path: c.inline.path, line: c.inline.to ?? c.inline.from ?? null };
    }
    return comment;
  });
}

async function bbFetch(url: string, creds: VcsCredentials, init?: RequestInit): Promise<Response> {
  const schemes = authSchemes(creds);
  let lastStatus = 0;
  let lastBody = "";
  for (const auth of schemes) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: auth, Accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (res.ok) return res;
    lastStatus = res.status;
    lastBody = await res.text();
    // Only an auth rejection is worth retrying with the next scheme; a 404 etc.
    // means the request is wrong, so stop.
    if (res.status !== 401 && res.status !== 403) break;
  }
  // Bitbucket Access Tokens return 401 with an EMPTY body when they lack a scope
  // (a repo read passes, but /pullrequests fails). Point at the likely cause.
  const scopeHint =
    lastStatus === 401 && !lastBody.trim()
      ? " — a 401 with an empty body usually means the Bitbucket Access Token is missing a scope (check 'Pull requests: Read')"
      : "";
  throw new Error(`Bitbucket ${init?.method ?? "GET"} ${url} → ${lastStatus}: ${lastBody}${scopeHint}`);
}

export const bitbucketProvider: VcsHostProvider = {
  host: "bitbucket",

  async verifyAccess(target, creds) {
    const res = await bbFetch(`${API}/repositories/${target.workspace}/${target.repo}`, creds);
    const json = (await res.json()) as { full_name?: string };
    return { detail: json.full_name ?? `${target.workspace}/${target.repo}` };
  },

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
