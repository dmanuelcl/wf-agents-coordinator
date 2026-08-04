# Session Start Point — Design

**Date:** 2026-08-04
**Status:** Approved, not yet implemented

## Problem

A session can only ever start one way: `git worktree add -b <kind>/<slug>` off whatever the repo
root has checked out (`session-registry.ts:277-287`). Two real workflows have no entry point.

**Another dev started the work.** Their branch carries the spec, the plan and the checkpoint, but
there is no way to open a session on it. Creating a same-named session reopens the local branch by
accident of `branchPreexisted`, never a chosen one, and never a remote-only branch.

**A global architect wrote the specs on `develop`.** Even when the new session inherits those files
through the checkout, the workflow gate stays shut: the checkpoint watcher deliberately ignores any
`*-checkpoint.md` whose `mtime` predates `createdAtEpochMs`, because such files came from the
checkout rather than from this session's architect (`session-checkpoint-watch-manager.ts:34`).
Implementer and Reviewer stay disabled with a valid checkpoint sitting on disk.

The machinery to attach to an existing branch already exists — `createReviewSession` (detached) and
`createFixSession` (writable) — but it is reachable only through PR sessions.

## Model

A continued or forked session is still `kind: "feature" | "fix"`. Same record, same three roles,
same gating. Only its start point changes, and whether it is born with a checkpoint.

| Mode | Session branch | `baseBranch` |
|---|---|---|
| `new` (default, today's behavior) | `<kind>/<slug>` off the repo root's HEAD | the repo root's current branch |
| `continue` | **the chosen branch**, writable checkout | the repo root's current branch |
| `fork` | `<kind>/<slug>` off the chosen ref | **the chosen ref** |

`SessionCreateInput` gains:

```ts
startFrom?: {
  mode: "continue" | "fork";
  ref: string;                     // branch name, local or remote-tracking
  checkpointPath: string | null;   // path within the ref, or null to start at Architect
}
```

Absent `startFrom` means `new`, so every existing call site keeps working. No new creation IPC
channel — `sessionsCreate` carries it.

`checkpointPath` is stored relative to the worktree root, matching what the watcher writes
(`relative(worktreePath, …)`) and what `wfCommandForSessionRole` expects. `git ls-tree` already
yields repo-root-relative paths, which are the same paths inside the worktree.

### The agent conversation is not resumed

Claude and Kimi session ids live in the *originating machine's* `userData`. A continued session
starts a fresh agent with `wf implement <checkpoint>` pre-typed and unsubmitted. That is precisely
the handoff the `wf` workflow already defines, so nothing is lost.

### `baseBranch` starts feeding the diff

`getWorktreeDiff` computes `merge-base` against `main`/`master` (`worktree-diff.ts:34-53`). Since
sessions branch off the repo root — in practice `develop` — every session's diff already carries the
develop-vs-main delta as noise. Recording the real base fixes that for all three modes.

`getWorktreeDiff(worktreePath, baseRef?)` uses `baseRef` when given, and falls back to today's
`main`/`master` resolution when it is null or when the ref no longer resolves. Sessions created
before this change have no `baseBranch` and behave exactly as they do now.

When the repo root is in detached HEAD there is no current branch, so `new` and `continue` record
`baseBranch: null` and fall back. `fork` always has a ref, so it always records one.

## Start-point resolution

New module `src/main/projects/session-start-point.ts`. Pure: it receives already-read branch state
and returns a plan. No `execFile` inside, so the whole matrix is tested without a repo.

```ts
resolveStartPoint({ mode, ref, sessionBranch, state: { hasLocal, remote, ahead, behind, checkedOutAt } })
  → { action: "new-branch"; branch: string; from: string }
  | { action: "checkout";   branch: string; fastForward: boolean }
  | { action: "abort";      reason: string }
```

Two refinements over the shape sketched during design, both found while writing the tests:

`remote` is the **name** of the remote carrying the branch rather than a boolean. A fork's base and
a teammate's branch can live on different remotes, and hardcoding `origin/` would branch off the
wrong place — or off nothing — in a repo with an `upstream`.

There is no separate `track-remote` action. Checking out a remote-only branch and checking out a
local one execute the identical `git worktree add <path> <branch>`; git DWIMs the tracking branch
when no local one exists. A distinct action would have been a distinction the executor could not
act on.

`session-registry.ts` fetches, reads the branch state with git, calls the resolver, and executes the
plan. Decision and execution stay separate. All three modes go through the resolver, so there is a
single creation path rather than a conditional bypass.

**The fetch happens before resolution, not inside a plan.** `ahead`/`behind` are computed against
remote-tracking refs, so resolving before fetching would call a branch that is behind up to date and
skip the fast-forward. When the ref has a remote and the fetch failed, creation aborts naming the
fetch error rather than resolving against state it cannot trust.

`new` resolves to `{ action: "new-branch", branch: "<kind>/<slug>", from: "HEAD" }`, except when
that local branch already exists — a session recreated under a name whose branch outlived its
deletion — where it resolves to `{ action: "checkout", fastForward: false }`. That is exactly
today's `createBranch: !branchPreexisted` behavior (`session-registry.ts:283-287`), now expressed as
a resolver case instead of an inline flag.

### `continue` — the branch is shared with the other dev

All rows below are evaluated *after* the up-front fetch.

| State of the chosen branch | Plan |
|---|---|
| Local + remote, local **behind** | `git fetch <remote> <b>:<b>` (fast-forward), then `worktree add <path> <b>` |
| Local + remote, **up to date** | `worktree add <path> <b>` |
| Local + remote, **ahead only** (unpushed work) | `worktree add <path> <b>` — not a conflict |
| Local + remote, **diverged** | **abort**, reporting ahead/behind counts |
| **remote only** | `worktree add <path> <b>` — git DWIMs a tracking branch from the fetched ref |
| **local only** (no remote configured, or branch never pushed) | `worktree add <path> <b>` as-is; no fetch guard |
| Neither | **abort** — the ref no longer resolves |
| Already checked out in another worktree | **abort**, naming the session holding it |

The design called for reusing the existing session when one already holds the branch, mirroring
`createFixSession`. That is right for PR fixes, where the app creates sessions from a link and the
name is derived — but here the user has typed a name, and silently returning a differently-named
session hides what happened. Instead the abort **names the session**, so the message points at the
thing the user has to go open:

> Branch "feature/auth" is already checked out at "Auth work" (…/.worktrees/auth-work).
> Git allows a branch in only one worktree.

Matching worktree paths goes through `realpath`: git reports `/private/var/…` on macOS while a
stored record can hold the symlinked `/var/…`, and plain `resolve` would treat one directory as two.

`git fetch origin <b>:<b>` on a branch that is not checked out is already fast-forward-only and
fails on divergence. The policy is one command rather than a hand-rolled comparison.

### `fork` — the ref is only a starting point and is never written

| State of the chosen ref | Plan |
|---|---|
| Exists on origin | `fetch`, then branch off **`origin/<ref>`** |
| Local only | branch off the local ref |

There is no divergence case: that branch is never touched, and branching off `origin/<ref>` means
always starting from what the architect **published**. The dialog states this explicitly
("from `origin/develop`") so local commits on `develop` are not silently skipped.

### Slug allocation

In `continue` the branch is fixed, so `allocateSlug` is called without `branchForSlug` — only the
worktree path needs to be free — plus the separate "already checked out" check above. `fork` keeps
today's behavior: the slug must yield both a free path and a free `<kind>/<slug>` branch.

## Checkpoint adoption

**Listing without a checkout.** `git ls-tree -r --name-only <ref>` filtered by the project's
`checkpointGlobs`, with contents read via `git show <ref>:<path>` and parsed by the existing
`parseCheckpointMarkdown`, so the dropdown shows title, slug and status. New channel
`git.listCheckpoints(projectId, ref)`. Nothing touches disk until the session is confirmed.

**Adopting** means writing `record.checkpointPath` at creation. It is the same value the watcher
would have written, so the rest follows with no new machinery:

- `watchSessionCheckpoint` returns early because `checkpointPath` is already set
  (`register-ipc-handlers.ts:172`). The watcher and its `mtime` filter are untouched, and keep
  behaving as they do today for sessions created without adoption.
- `isSessionRoleUnlocked` unlocks Implementer and Reviewer immediately.
- `wfCommandForSessionRole` pre-types `wf implement <path>` without submitting.

**One behavior change.** `primaryRole()` returns `architect` for feature/fix
(`session-orchestrator.ts:64-68`). A session born with a checkpoint must open on **Implementer**, so
the rule becomes: `feature|fix` with a non-null `checkpointPath` → `implementer`. Side effect,
accepted deliberately: an ordinary session that already has a checkpoint and whose runtime record
was lost would also reopen on Implementer instead of Architect. That is the correct stage — the
architect's work is done — and `ensureSetupOrPrimary` re-ensures every other recorded terminal
regardless, so no tab is lost.

## UI

`NewSessionDialog` gains a **Start from** segmented control, shown only for feature/fix:

```
 Kind       [New feature][Bug fix][PR review][PR fix]

 Start from  [ New branch ][ Continue ][ Fork ]
              ^ default

 Branch *    [ develop                    ▾]
 Checkpoint  [ 2026-08-01-auth-checkpoint ▾]   (none — start at Architect)
 Session name [ Auth refresh rotation      ]
 ☐ Copy .env files   ☐ Reuse dist/generated
```

- `BranchCombobox` is reused as-is; it already lists local + remote branches via `git.listBranches`.
- The checkpoint dropdown is populated from the chosen ref and always offers "none".
- In `continue` the session name auto-fills from the branch through `truncateSessionName`, the way
  review already auto-fills from the branch it reviews.
- `Copy .env files` and `Reuse dist/generated` apply in all three modes.

The enable/auto-name logic moves into a pure helper with its own spec, following
`setup-recovery.spec.ts`, since the renderer has no component tests.

## Errors

Every failure aborts with rollback; `createSession`'s existing `try/catch` already removes the
worktree and deletes a branch it created.

| Case | Message |
|---|---|
| Branch diverged from origin | ahead/behind counts and what to do about it |
| Branch checked out elsewhere | names the worktree path holding it |
| Ref deleted between listing and creation | states the ref no longer resolves |
| Fetch fails while a remote exists | aborts naming the fetch failure, rather than starting on stale code — same stance as `staleWorktreeError` |
| Branch has no remote | no fetch is attempted, so no failure to report |

## Tests

- `session-start-point.spec.ts` — the full matrix, pure, no git.
- `session-registry.spec.ts` — real temporary repos via `execFileSync` + `mkdtempSync`, as that file
  already does, extended with a local bare remote to cover divergence, behind, and origin-only.
- `worktree-diff` with an explicit `baseRef`, plus the null and unresolvable-ref fallbacks.
- The dialog helper's spec.

Run with `pnpm test` (never raw vitest — the `pretest` hook rebuilds `better-sqlite3` for Node), and
`npx electron-rebuild -f -w node-pty,better-sqlite3` before launching the app afterward.

## Out of scope

- Editing `baseBranch` after creation.
- Continuing a session across machines with its agent conversation intact.
- Any change to how PR review and PR fix sessions provision their worktrees. Their duplicated fetch
  and freshness guards are worth unifying later, but not in this change.
