# PR Review — VCS Host Integration — Implementation Plan (phased)

> Implement phase-by-phase. Phase 1 is detailed to TDD steps; Phases 2–5 are task-level and get
> stepped out when reached (later phases depend on Phase 1 learnings — esp. Bitbucket auth).

**Design doc:** `docs/specs/2026-07-14-pr-review-vcs-integration-design.md`

**Goal:** Create PR reviews from a PR link (host-agnostic, Bitbucket first), post the review as a
PR comment, and run progressively (full prior reports + last-reviewed SHA). Slack = summary.

## Global Constraints

- TS strict; Vitest `environment: node` (no DOM) — only plain-TS gets unit tests; provider network
  calls + safeStorage + React are device/integration-verified.
- Renderer can't import `node:*`; the token never reaches the renderer (write-only in, boolean out).
- Native ABI: after `pnpm test`, `pnpm build` before `pnpm dev`.
- Gates per task: `pnpm typecheck` + `pnpm test` green. **Baseline: 199.**
- **Irreversible outward action:** posting to a real PR (Phase 3+) is button-gated, marker-tagged,
  never auto. Verify against a throwaway/test PR first.

## BLOCKER to confirm before Phase 1 ships

Bitbucket Cloud auth for the token the user has:
- **Workspace/Repo Access Token** → `Authorization: Bearer <token>` (no email).
- **Atlassian API token** (replaces app passwords) → `Authorization: Basic base64(<email>:<token>)`.

The provider carries `token` + optional `email` and supports both; the plan's Phase 1 device step
confirms which one against the user's real token before relying on it.

---

## Phase 1 — VCS config + provider seam + Bitbucket read

### Task 1.1: `VcsHostProvider` types + `parseUrl` (pure, tested)

**Files:** Create `src/main/vcs/vcs-provider.ts` (types + `parseBitbucketUrl`/`parseGithubUrl` +
a `getProvider(host)` registry stub), `src/main/vcs/vcs-provider.spec.ts`.

- [ ] **Test first:**
```ts
import { describe, expect, it } from "vitest";
import { parseBitbucketUrl, parseGithubUrl } from "./vcs-provider";

describe("parseBitbucketUrl", () => {
  it("extracts workspace/repo/prId", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/acme/web/pull-requests/482")).toEqual({
      host: "bitbucket", workspace: "acme", repo: "web", prId: "482",
      url: "https://bitbucket.org/acme/web/pull-requests/482",
    });
  });
  it("tolerates a trailing path/query and returns null on non-PR urls", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/acme/web/pull-requests/482/diff")?.prId).toBe("482");
    expect(parseBitbucketUrl("https://bitbucket.org/acme/web/src/main")).toBeNull();
  });
});

describe("parseGithubUrl", () => {
  it("extracts owner/repo/prId", () => {
    expect(parseGithubUrl("https://github.com/acme/web/pull/17")).toMatchObject({
      host: "github", workspace: "acme", repo: "web", prId: "17",
    });
  });
});
```
- [ ] Implement the `PrRef`/`ResolvedPr`/`ReviewComment`/`VcsCredentials`/`VcsHostProvider` types
  (per the spec) + the two pure parsers (regex on the path). Run → green. Commit.

### Task 1.2: Bitbucket provider — `resolvePr` (device-verified network)

**Files:** Create `src/main/vcs/bitbucket-provider.ts` (implements `VcsHostProvider`); wire into
`getProvider`.

- [ ] Implement `resolvePr(ref, creds)`: `GET https://api.bitbucket.org/2.0/repositories/{ws}/{repo}/pullrequests/{prId}`
  with the auth header (Bearer if no email, else Basic email:token). Map
  `source.branch.name`→`source`, `destination.branch.name`→`target`, `title`→`title`.
  `listReviewComments`/`postComment` are Phase 3/4 — stub with `throw new Error("not implemented")`.
- [ ] Use Node 20+ global `fetch` (available in Electron main). No unit test (network); a small
  parser helper for the JSON→ResolvedPr mapping CAN be unit-tested with a fixture.
- [ ] **Device step:** confirm auth type + a real resolve against the user's PR. Commit.

### Task 1.3: Project `vcs` config + encrypted token

**Files:** `project-registry.ts`, `sqlite-project-registry.ts`, `contract.ts`, a new
`src/main/vcs/vcs-secret-store.ts` (safeStorage wrapper).

- [ ] `ProjectRecord.vcs: { host: VcsHost | "none"; workspace: string; repo: string; email: string }`
  threaded like `review` (default `{ host: "none", workspace: "", repo: "", email: "" }`). Add
  column `vcs` + `vcs_secret` (encrypted token ciphertext, nullable). Round-trip test for `vcs`.
- [ ] `vcs-secret-store.ts`: `encryptToken(token): string` (base64 of `safeStorage.encryptString`),
  `decryptToken(cipher): string`, `isAvailable(): boolean`. Guard: if not available, throw a
  clear error (never store plaintext).
- [ ] Registry: store/read `vcs_secret`; expose `getVcsCredentials(projectId): { token, email } | null`
  (decrypts) for main-side use; NEVER return the token to the renderer.
- [ ] Fixtures missing `vcs` updated (same two ProjectRecord literals as before). typecheck + tests.
  Commit.

### Task 1.4: IPC — set token + parse/resolve preview

**Files:** `register-ipc-handlers.ts`, `preload/index.ts`, `contract.ts`.

- [ ] `projects.setVcsToken(projectId, token)` → encrypt + persist; returns void. Renderer reads
  `project.vcs` + a derived `hasVcsCreds` boolean (present when `vcs_secret` non-null) — token never
  sent back.
- [ ] `git.resolvePrUrl(projectId, url)` → parse (provider by `project.vcs.host`) → `resolvePr` with
  the project's creds → `ResolvedPr` (for the dialog preview). Errors surface to the renderer.
- [ ] Commit.

### Task 1.5: ProjectModal — VCS host section (device)

**Files:** `ProjectModal.tsx`, `styles.css`.

- [ ] A "VCS host" section: host `<select>` (none/bitbucket/github), workspace, repo, email inputs
  (bound to `project.vcs`), and a token input that's **write-only** (placeholder shows
  "configured ✓" when `hasVcsCreds`; typing a new value calls `projects.setVcsToken` on save).
- [ ] Pass `vcs` through add/update; call `setVcsToken` when the token field is non-empty. typecheck.
  Commit.

**Phase 1 deliverable:** configure Bitbucket creds on a project, paste a PR URL in a preview, and
see the resolved `source → target`.

---

## Phase 2 — Create review from PR link

- **2.1** `WorkSession.pr` field (`{host,workspace,repo,prId,url,lastReviewedSha}|null`); default
  `null` in `createSession`/`createReviewSession`; fixtures updated. (tested: type + a registry case)
- **2.2** `createReviewFromPr({projectId, url})` in the session registry: `resolvePr` → detached
  worktree at `source` → session with `kind:"review"`, `branch:source`, `baseBranch:target`, `pr`.
  IPC `sessions.createReviewFromPr`. (device: creates a session from a link)
- **2.3** `.git/info/exclude` append helper (`src/main/projects/worktree-exclude.ts`, tested against
  a temp gitdir) + call it on review-session creation for `.agent-review.md`.
- **2.4** NewSessionDialog: Manual / From-PR-link toggle; URL field + Resolve preview
  (`git.resolvePrUrl`) showing `source → target`; From-link disabled when `!hasVcsCreds`.
  (device)

**Deliverable:** a review session created from a PR link, worktree at the source branch.

---

## Phase 3 — Artifact + Post to PR

- **3.1** Kickoff (review-mode, pr sessions): instruct the reviewer to write the full report to
  `.agent-review.md`. Extend the review kickoff assembly (main) to append that instruction for pr
  sessions.
- **3.2** Bitbucket `postComment(ref, body, creds)`: `POST …/pullrequests/{id}/comments`
  `{content:{raw}}`; return the created comment's `links.html.href`.
- **3.3** `sessions.postReview(sessionId)` (main): read `<worktree>/.agent-review.md` (error if
  missing) → append marker → `postComment` → set `pr.lastReviewedSha = git rev-parse HEAD` → return
  `{commentUrl}`.
- **3.4** SessionView: `Post to PR` button for pr sessions (replaces Post-to-Slack), disabled until
  `.agent-review.md` exists (poll/check via a small `sessions.reviewArtifactExists` IPC or fs check);
  a PR chip linking `pr.url`. (device: posts to a test PR)

**Deliverable:** review posted as a PR comment; `lastReviewedSha` recorded.

---

## Phase 4 — Progressive

- **4.1** Bitbucket `listReviewComments(ref, creds)`: paginate `GET …/comments`; set
  `authoredByTool` when the body contains the marker. (unit: marker detection + pagination merge via
  fixture)
- **4.2** Kickoff assembly (main): when `pr` set, gather `authoredByTool` comments (full bodies,
  oldest→newest) + `lastReviewedSha`; build the progressive kickoff (per spec). Empty prior + null
  sha → full-review kickoff. (unit: kickoff assembly)
- **4.3** Wire the progressive kickoff into `buildRoleLaunch` for pr review sessions (replaces the
  simple substitution when `pr` is present).

**Deliverable:** re-running a PR review reads all prior reports + diffs only new commits.

---

## Phase 5 — Slack summary + GitHub provider

- **5.1** `postReview` also relays a Slack summary (reviewer terminal) with the comment URL when the
  project has a Slack channel — keeps the agent-posts-Slack model, app supplies the URL.
- **5.2** `GitHubProvider` (`resolvePr`/`listReviewComments`/`postComment` via the GitHub REST API;
  Bearer token) + `parseGithubUrl` already done. Register in `getProvider`.

**Deliverable:** full loop (PR comment + Slack summary) and a second host.

## Self-review checklist (per phase)
- Token never crosses to the renderer; no plaintext token in the DB.
- Every posted comment carries the marker; `postReview` is button-gated and returns the URL.
- Manual review sessions unaffected (no `pr`, no API, Post-to-Slack unchanged).
- Fixtures updated for each new required ProjectRecord/WorkSession field.
