# PR Review — VCS Host Integration (post-to-PR + progressive) — Design

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation plan
**Repo:** AGENTS (Agent Coordinator desktop app)
**Builds on:** `2026-07-14-pr-review-session-design.md` (the manual branch+base review session).

## Summary

Extend the PR review session so it can be created **from a PR link** (Bitbucket now,
host-agnostic) and post its review **as a comment on that PR**, with **progressive** reviews
(each run receives the full prior review reports + the last-reviewed commit, so it analyzes
only what changed and never re-reads everything). Slack becomes a **secondary summary** with a
link to the posted comment.

The **manual** branch+base review (already built) stays unchanged and uses **no API**. The API
path is used **only** when the review is created from a PR link and host credentials are
configured.

## The decisive constraint (why the app owns VCS)

Creating the worktree needs the **source + target branch**, and that happens **before** the
reviewer launches. A Bitbucket PR link carries only the **PR id**, not the branches — so the
app must call the host API to resolve it. Once the app holds credentials to resolve, it uses
them for the rest (read prior comments, post the review). Bitbucket also has **no standard
CLI** and has **deprecated app passwords → API tokens only**, so an agent-with-curl approach is
both fragile and insufficient. Decision (brainstorming): **app-native `VcsHostProvider`**.

## Goals

- Create a review session by pasting a PR URL → auto-resolve source/target → worktree.
- Post the review as a PR comment; keep the comment identifiable as ours across runs.
- Progressive: feed the reviewer **all prior tool-authored review comments verbatim** + the
  last-reviewed source SHA; instruct it to analyze only `lastReviewedSha..source`.
- Optional Slack **summary** with the posted-comment link.
- Host-agnostic (`VcsHostProvider`): Bitbucket first, GitHub next.
- Credentials stored with Electron `safeStorage` (OS keychain), never plaintext.

## Non-goals

- The manual branch+base flow is untouched and API-free.
- No auto-posting — posting is a human-triggered button (review first).
- No inline/line-level PR comments in v1 — a single PR-level comment (one thread, updated across
  runs by appending new comments).
- Not building every host — only the `VcsHostProvider` seam + Bitbucket (GitHub stub/next).

## Two creation paths (coexist)

`NewSessionDialog` "PR review" kind gets a small **source toggle**:

- **Manual** (default, existing): branch combobox + base. No PR, no API. Review + optional Slack
  (the existing `Post to Slack` button). Unchanged.
- **From PR link** (new; only enabled when the project has VCS creds): a PR-URL input. On submit,
  `sessions.createReviewFromPr(projectId, { url })`:
  1. `provider.resolvePr(url)` → `{ workspace, repo, prId, source, target, title }`.
  2. detached worktree at `source` (fetch first).
  3. store the session with `pr: { host, workspace, repo, prId, url, lastReviewedSha: null }`.
  4. add `.agent-review.md` to the worktree's `.git/info/exclude`.

## `VcsHostProvider` (host-agnostic seam)

`src/main/vcs/vcs-provider.ts`:

```ts
export type VcsHost = "bitbucket" | "github";

export interface PrRef {
  host: VcsHost;
  workspace: string; // Bitbucket workspace / GitHub owner
  repo: string;
  prId: string;
  url: string;
}

export interface ResolvedPr extends PrRef {
  source: string; // source branch name
  target: string; // destination/base branch name
  title: string;
}

export interface ReviewComment {
  id: string;
  body: string;          // raw markdown
  createdAtEpochMs: number;
  authoredByTool: boolean; // detected via the signature marker
}

export interface VcsCredentials {
  token: string;
  // Some hosts need an account/email alongside the token (Bitbucket API tokens use
  // Basic auth email:token; access tokens use Bearer). Optional; provider decides.
  email?: string;
}

export interface VcsHostProvider {
  host: VcsHost;
  parseUrl(url: string): PrRef | null;               // pure, no network
  resolvePr(ref: PrRef, creds: VcsCredentials): Promise<ResolvedPr>;
  listReviewComments(ref: PrRef, creds: VcsCredentials): Promise<ReviewComment[]>;
  postComment(ref: PrRef, body: string, creds: VcsCredentials): Promise<{ url: string }>;
}
```

- **`parseUrl`** is pure → unit-tested (Bitbucket: `…/{workspace}/{repo}/pull-requests/{id}`;
  GitHub: `…/{owner}/{repo}/pull/{id}`).
- **Signature marker:** every posted comment ends with a hidden marker line, e.g.
  `\n\n<!-- agent-coordinator-review -->`. `listReviewComments` sets `authoredByTool` when the
  marker is present — that's how progressive runs find our prior reports (independent of the
  authoring account).
- Bitbucket API (Cloud v2.0): `GET /repositories/{ws}/{repo}/pullrequests/{id}` (source/dest),
  `GET …/{id}/comments?pagelen=…` (paginated), `POST …/{id}/comments` with
  `{ content: { raw } }`. **Exact auth header (Bearer access token vs Basic email:api_token) to
  be confirmed against the user's token type in the plan** — the provider carries `token` +
  optional `email` to support both.

## Credentials (Electron `safeStorage`)

- Per-project VCS config lives in the project record: `vcs: { host, workspace, repo, hasCreds }`.
  The **token is NOT in the DB in plaintext**: `safeStorage.encryptString(token)` → store the
  base64 ciphertext in a separate `vcs_secret` column (or a sibling store); decrypt on use in
  main. `email` (if used) may live in `vcs` (not secret).
- If `safeStorage.isEncryptionAvailable()` is false (rare), fall back to refusing to store and
  telling the user (don't write plaintext).
- The renderer never sees the token — it only sends it once (in the ProjectModal save) and reads
  back a boolean `hasCreds`.

## Progressive review

- Session carries `pr.lastReviewedSha` (null on first run).
- On opening/re-running a PR review, before the kickoff, main gathers:
  - `priorReports` = `listReviewComments(...)` filtered to `authoredByTool`, **full bodies**,
    oldest→newest.
  - `lastReviewedSha`.
- The kickoff (host-provider-aware) becomes:
  > "Estás revisando el PR «{title}» ({source} → {target}). Reportes previos de esta herramienta
  > (del más viejo al más nuevo):\n\n{priorReports}\n\nAnaliza SOLO lo nuevo desde el último
  > review: `git diff {lastReviewedSha}..HEAD` (si no hay SHA previo, revisá todo). Ten en cuenta
  > lo ya reportado — marca lo resuelto y lo que sigue pendiente. Escribe el review completo a
  > `.agent-review.md`."
- If `priorReports` is empty and `lastReviewedSha` is null → the normal full-review kickoff.
- The reviewer writes its report to **`.agent-review.md`** (gitignored via info/exclude).

## Post to PR

- The review-mode topbar's button becomes **Post to PR** (replaces "Post to Slack" when the
  session has a `pr`; manual sessions keep "Post to Slack").
- Flow (`sessions.postReview(sessionId)` in main):
  1. Read `<worktree>/.agent-review.md` (error if missing → tell the user to let the review
     finish / write the file).
  2. `body = artifact + "\n\n<!-- agent-coordinator-review -->"`.
  3. `provider.postComment(pr, body, creds)` → `{ url }`.
  4. Update session `pr.lastReviewedSha` = current `HEAD` SHA of the worktree (so the next run is
     incremental).
  5. If the project has a Slack channel: relay a **summary** to the reviewer terminal to post to
     Slack — *"Publica en Slack {channel} un resumen de 2–3 líneas del review que subiste al PR:
     {url}"* — (keeps the agent-posts-Slack model; the app supplies the comment URL).
- Button disabled until `.agent-review.md` exists.

## `.agent-review.md` gitignore

On review-session creation, append `.agent-review.md` to the worktree's local exclude file
(`<worktree>/.git` resolves to the worktree gitdir; the exclude path is
`<gitdir>/info/exclude`). This keeps the artifact out of `git status`/diffs **without modifying
the tracked `.gitignore`** in the PR branch. Best-effort (a failure just means the file shows in
status).

## Model / config changes

- `WorkSession.pr: { host, workspace, repo, prId, url, lastReviewedSha } | null` (null for
  manual + non-review).
- `ProjectRecord.vcs: { host: VcsHost | "none", workspace: string, repo: string, email: string }`
  + encrypted token stored separately. Threaded like `review`/`autoPilot`.

## IPC (new)

- `git.parsePrUrl(projectId, url)` (optional preview) / `sessions.createReviewFromPr(projectId, { url })`
- `sessions.postReview(sessionId)` → `{ commentUrl }`
- `projects.setVcsToken(projectId, token)` (write-only; encrypts via safeStorage)

## UI

- **ProjectModal → "VCS host" section:** host select (none/bitbucket/github), workspace, repo,
  email (if needed), token input (write-only; shows "configured ✓" when set). Under the existing
  "PR Review" section.
- **NewSessionDialog → PR review:** a Manual / From-PR-link toggle; the link field with a
  "Resolve" affordance that shows the detected source→target before create. From-link disabled
  when no creds.
- **SessionView review mode:** `Post to PR` (pr sessions) or `Post to Slack` (manual); a small
  PR chip linking to `pr.url`.

## Phasing (each phase ships something usable)

- **Phase 1 — VCS config + provider seam + Bitbucket read.** `VcsHostProvider`, `parseUrl`
  (tested), Bitbucket `resolvePr`; ProjectModal VCS section + `safeStorage` token; `parsePrUrl`
  IPC. Deliverable: configure creds, paste a URL, see resolved source→target.
- **Phase 2 — Create from PR link.** `createReviewFromPr` (resolve → worktree → session.pr) +
  the dialog toggle + `.git/info/exclude`. Deliverable: a review session created from a link.
- **Phase 3 — Artifact + Post to PR.** kickoff writes `.agent-review.md`; `postReview` reads it,
  `postComment` (Bitbucket), updates `lastReviewedSha`; the Post-to-PR button. Deliverable:
  review posted to the PR.
- **Phase 4 — Progressive.** `listReviewComments` + marker; inject full prior reports +
  `lastReviewedSha` into the kickoff. Deliverable: incremental reviews.
- **Phase 5 — Slack summary + GitHub provider.** Post-to-PR also relays a Slack summary w/ link;
  add `GitHubProvider`. Deliverable: full loop + a second host.

## Testing strategy

- **Unit (node):** `parseUrl` per host; the marker detection in `listReviewComments`
  (parse fixture JSON); kickoff assembly (prior reports + sha substitution); the exclude-append
  helper (writes to a temp gitdir). Provider network calls are integration/device (mock the
  fetch in a thin test if useful).
- **Device:** real Bitbucket resolve/list/post round-trips (needs a real PR + token),
  safeStorage on the real OS, the progressive loop across two runs.

## Risks

1. **Bitbucket auth exactness** — Bearer access token vs Basic email:api_token. The provider
   carries both; the plan confirms against the user's actual token before shipping Phase 1.
2. **Writing to a real PR** — irreversible outward action. Post is button-gated + shows the
   comment URL; the marker makes our comments identifiable. Never auto-posts.
3. **safeStorage availability** — refuse to store rather than plaintext if unavailable.
4. **Artifact reliability** — the agent must actually write `.agent-review.md`; the button is
   disabled until it exists, and `postReview` errors clearly if missing.
5. **Rate limits / pagination** — `listReviewComments` must paginate; large PRs → many comments.
