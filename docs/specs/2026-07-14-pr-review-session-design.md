# PR Review Session — Design

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation plan
**Repo:** AGENTS (Agent Coordinator desktop app)

## Summary

A dedicated **PR review session**: pick a branch to review (local **or remote** — most are
remote) + a base branch, and the app opens a session that is **already reviewing** — it
creates a detached worktree at the branch, auto-launches the project's configured **reviewer**
agent, and auto-submits a review kickoff. The agent produces the full review (all findings +
a summary of what to do) using its own skills — for a Biznex project that means the reviewer
invokes `biznex-pr-review` on its own, because the repo's CLAUDE.md tells it to. Then a
**Post to Slack** button tells the reviewer agent to publish the review to the project's
configured Slack channel — the agent posts it via its own Slack access (the app stores only
the channel name; no tokens, no Slack API in the app).

**Key architectural stance:** the app does NOT replicate review logic. Depth comes from the
agent + the project's skills; the app just launches the configured reviewer in the right
worktree, kicks it off, and relays a "post to Slack" instruction.

## Goals

- Open a review session from a branch (local or remote) + base, in ~2 clicks.
- Worktree is **detached** at the branch ref — non-destructive, never conflicts with a branch
  checked out elsewhere, works for remote PR branches.
- The reviewer auto-launches and auto-runs the review kickoff (no manual "which tab / press Enter").
- One button relays "post the review to #channel" to the agent.
- Everything project-configurable: the Slack channel + the kickoff template.

## Non-goals

- No Slack API/bot token in the app (the agent posts — chosen in brainstorming).
- No GitHub `gh` PR-by-number integration in v1 (branch + base only, as the user framed it).
  Noted as a future extension.
- The app does not parse or store the review text (the agent holds it; "post" relays an
  instruction). No review artifact file in v1.
- No architect/implementer/checkpoint machinery — a review session has none.

## Architecture

A review session is a new `WorkSessionKind` (`"review"`) rendered by `SessionView` in a
**review mode** (a sibling of the existing `repoMode`): only a **Reviewer** tab + Shells +
Files + Diff; no architect/implementer, no checkpoint/Log. The reviewer tab reuses the
existing launch + follow-up path — the kickoff rides in the `wfCommand` slot and is
auto-submitted via the `autoSubmitWf` flag built for the conductor.

### Creation flow

```
NewSessionDialog ("Review" kind)
   ├─ branch picker: git.listBranches(projectId) → { local[], remote[] }  (fetch + for-each-ref)
   ├─ base branch field (placeholder: main / develop)
   └─ submit → sessions.createReview(projectId, { reviewBranch, baseBranch, name })
          │
          ▼  main: createReviewSession
   git fetch (best-effort) ─▶ git worktree add --detach <.worktrees/slug> <reviewBranch>
   store WorkSession { kind: "review", branch: reviewBranch, baseBranch, worktreePath, ... }
```

### Review + kickoff

```
SessionView (review mode) opens the Reviewer tab
   └─ buildRoleLaunch(session, "reviewer"):
        wfCommand = substituteReviewKickoff(project.review.kickoff, { branch, base })
   └─ SessionTerminal renders reviewer with autoSubmitWf={true}
        → launches the configured reviewer agent, waits for first output + SETTLE_MS,
          submits the kickoff. Agent starts reviewing (invokes biznex-pr-review on its own).
```

### Post to Slack

```
Topbar "Post to Slack" button (review mode; disabled when project.review.slackChannel is empty)
   └─ terminalHandles.get("reviewer").sendText(buildSlackPostCommand(channel), execute=true)
        → "Publica el resumen completo del review en el canal de Slack <channel>."
```

## New shared module: `review-config.ts`

`src/shared/workflow/review-config.ts` (pure, unit-tested):

```ts
export interface ReviewConfig {
  slackChannel: string; // e.g. "#pr-reviews"; empty = Post-to-Slack disabled
  kickoff: string;      // template with {branch} and {base} placeholders
}

export const DEFAULT_REVIEW_KICKOFF =
  "Revisa los cambios de la rama {branch} contra {base}. Lee y analiza cada archivo " +
  "modificado, reporta todos los hallazgos con su severidad, y termina con un resumen " +
  "de todo lo que hay que hacer antes de mergear.";

export function createDefaultReviewConfig(): ReviewConfig;         // { slackChannel: "", kickoff: DEFAULT_REVIEW_KICKOFF }
export function substituteReviewKickoff(template: string, vars: { branch: string; base: string }): string;
export function buildSlackPostCommand(channel: string): string;   // "Publica el resumen completo del review en el canal de Slack <channel>."
```

`substituteReviewKickoff` replaces **all** occurrences of `{branch}`/`{base}`. If the template
is empty/whitespace it falls back to `DEFAULT_REVIEW_KICKOFF`.

## Model changes

- `WorkSessionKind = "feature" | "fix" | "review"` (`work-session.ts`).
- `WorkSession` gains `baseBranch: string | null` (null for feature/fix).

## Branch listing (main)

New pure parser + IPC:

```ts
// parseGitBranches(localRaw: string, remoteRaw: string): { local: string[]; remote: string[] }
//   - localRaw  = `git for-each-ref --format=%(refname:short) refs/heads`
//   - remoteRaw = `git for-each-ref --format=%(refname:short) refs/remotes`
//   - drops "origin/HEAD" and any bare "HEAD"; trims; dedupes; stable order
```

IPC `git.listBranches(projectId): Promise<{ local: string[]; remote: string[] }>`:
1. `git fetch --all --prune` in the project root (best-effort — swallow failure if offline; the
   list still returns whatever refs exist).
2. Run the two `for-each-ref` commands, feed to `parseGitBranches`.

## Review worktree (main)

Extend `createWorktree` with a `detach?: boolean` option:
- `detach` → `git worktree add --detach <path> <ref>` (works for `feature/x` and `origin/feature/x`).

`createReviewSession({ projectId, projectRoot, name, reviewBranch, baseBranch })` in the
session registry:
- `slug = slugifySessionName(name)` (name defaults, in the dialog, to the branch — e.g.
  `origin/feature/xyz` → "review origin feature xyz" → slug). Guard empty slug.
- `git fetch` best-effort (so a just-pushed remote branch resolves), then
  `createWorktree({ ..., branch: reviewBranch, detach: true })`.
- Store `WorkSession { kind: "review", slug, branch: reviewBranch, baseBranch, worktreePath, checkpointPath: null, ... }`.
- No env copy (review doesn't run the app).

IPC `sessions.createReview(projectId, input: ReviewSessionCreateInput)` where
`ReviewSessionCreateInput = { name: string; reviewBranch: string; baseBranch: string }`.

## Project config (thread like `autoPilot`)

Add `review: ReviewConfig` to `ProjectRecord` (sibling of `runtimeConfig`/`autoPilot`), through
`project-registry.ts`, `sqlite-project-registry.ts` (ADD COLUMN `review` backfill), and
`contract.ts` (`ProjectCreateInput`/`ProjectUpdateInput`). Default `createDefaultReviewConfig()`.

## `buildRoleLaunch` change (register-ipc-handlers)

When `session.kind === "review"` and `role === "reviewer"`:
- `wfCommand = substituteReviewKickoff(project.review.kickoff, { branch: session.branch, base: session.baseBranch ?? "" })`
- (feature/fix sessions keep `wfCommandForSessionRole` unchanged.)

## UI

### NewSessionDialog — add "Review"
- Third segmented kind: **Review**. When selected, the form swaps to:
  - **Branch to review** — a picker populated by `git.listBranches` (Local group + Remote group,
    remotes shown as `origin/…`); loading state while fetching.
  - **Base branch** — text input, placeholder `main` / `develop`.
  - Name auto-fills from the chosen branch (editable).
  - Submit → `sessions.createReview`.
- feature/fix keep the existing form (name + copyEnv).

### SessionView — review mode (`session.kind === "review"`)
- Reuse the `repoMode`-style gating: no architect/implementer tabs, no checkpoint/Log tab.
- Show ONE agent tab: **Reviewer** (auto-opened), plus Shells + Files + Diff.
- Reviewer tab rendered with `autoSubmitWf={true}` so the kickoff auto-runs.
- Topbar: a gold **REVIEW** chip (like the REPO ROOT chip) + a **Post to Slack** button
  (disabled when `project.review.slackChannel` is empty).
- Diff view defaults to `branch` vs `base` (pass the base so the diff is the review diff).

### ProjectModal — review section
- A "PR Review" section: **Slack channel** input + **Review kickoff** textarea (placeholder =
  `DEFAULT_REVIEW_KICKOFF`; empty = use default). Passed through add/update like `autoPilot`.

## Files

**New**
- `src/shared/workflow/review-config.ts` + `.spec.ts`
- `src/main/projects/git-branches.ts` (`parseGitBranches` + `listGitBranches`) + `.spec.ts` (parser)
- `src/renderer/components/ReviewSessionForm.tsx` (or inline in NewSessionDialog)

**Modify**
- `src/shared/workflow/work-session.ts` (kind + baseBranch)
- `src/main/projects/worktree-manager.ts` (`detach` option)
- `src/main/projects/session-registry.ts` (`createReviewSession`)
- `src/main/ipc/register-ipc-handlers.ts` (createReview IPC, listBranches IPC, buildRoleLaunch review branch)
- `src/main/projects/project-registry.ts` + `sqlite-project-registry.ts` + `src/shared/ipc/contract.ts` (`review` config)
- `src/preload/index.ts` (git.listBranches, sessions.createReview)
- `src/renderer/components/NewSessionDialog.tsx` (Review kind + branch pickers)
- `src/renderer/components/SessionView.tsx` (review mode + Post-to-Slack + reviewer autoSubmit)
- `src/renderer/components/ProjectModal.tsx` (review config inputs)
- `src/renderer/App.tsx` (pass project.review to SessionView; handle review-session create)
- `src/renderer/styles.css`

## Testing strategy

- **Unit (Vitest node):** `review-config.spec.ts` (substitution — all occurrences, empty-template
  fallback, slack command), `git-branches.spec.ts` (parser — drops HEAD/origin/HEAD, dedupe,
  trim), registry (`createReviewSession` slug/branch/baseBranch; `review` config round-trip),
  worktree `detach` arg shape.
- **Device-verified:** the review-mode UI, the auto-kickoff actually launching + submitting, the
  branch picker listing remotes, Post-to-Slack relaying, the detached worktree checkout.

## Risks / open items

1. **Slack MCP availability (accepted).** Post-to-Slack only works if the reviewer terminal has
   Slack access. If it doesn't, the agent will say so; fallback is manual copy or (later) a
   native Slack integration. Documented, not solved.
2. **Detached worktree + base ref.** The diff `base...branch` needs both refs present. `git fetch`
   before create makes remote base/branch available; a base that exists only locally is fine too.
   If the base ref is unknown, the reviewer's diff command will error visibly — acceptable.
3. **`git.listBranches` latency.** `git fetch --all` can be slow on big remotes. The dialog shows
   a loading state; failure is swallowed so stale refs still list.
4. **Auto-kickoff timing** reuses the proven SessionTerminal follow-up (first output + SETTLE_MS);
   same residual timing caveat as the conductor's forward open.
