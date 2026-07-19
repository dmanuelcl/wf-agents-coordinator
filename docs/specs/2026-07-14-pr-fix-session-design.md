# PR Fix Session — Design + Plan

**Date:** 2026-07-14
**Status:** Approved, implementing
**Builds on:** the PR review + VCS integration (`2026-07-14-pr-review-vcs-integration-design.md`).

## Summary

The inverse of a PR review: given the same PR link, open a **PR Fix** session that checks out
the PR's source branch **writable**, reads the PR's comment sequence, and has the **implementer**
address them. The agent implements **and commits**, but **does not push** — the user pushes with
a gated **Push to PR** button (decided in brainstorming). Reuses the VCS provider, `PrLink`,
link-resolution, comment fetching, and the PR-session UI.

## Key differences from PR review

| | PR review | PR fix |
|---|---|---|
| Agent | reviewer | implementer |
| Worktree | detached (read-only) at `origin/<source>` | **writable** tracking branch `<source>` |
| Comments | prior tool reports (progressive) | **all** PR comments (the review sequence) fed to implement |
| Output | a PR comment | commits on the branch (push is manual, gated) |

## Model

- `WorkSessionKind += "pr-fix"`. `WorkSession.pr` (already exists) is set for pr-fix too.
- The full PR conversation lives in the gitignored `.agent-pr-context.md`; the workflow checkpoint is gitignored too.

## Writable worktree

`createFixSession` mirrors `createReviewSession` but:
- `fetchFirst: true`, then `git worktree add <path> <source>` with the **plain** branch name
  (not `origin/…`, not `--detach`). After a fetch, git DWIMs: if `<source>` exists locally it's
  checked out; if not, git creates a local branch tracking `origin/<source>`. Writable, and a
  later `git push` updates the PR. If `<source>` is already checked out elsewhere, git errors
  clearly.
- `reviewBranch = <source>` (plain), `baseBranch = origin/<target>` (diff context), `kind: "pr-fix"`.

## Comments (all, with inline context)

Extend `ReviewComment` with `inline?: { path: string; line: number | null }`. The Bitbucket
mapper fills it from the comment's `inline` field (`path`, `to ?? from`). The fix kickoff feeds
**all** comments (human + tool), oldest→newest, each prefixed with `on <path>:<line>` when inline.

## Fix kickoff (`buildPrFixKickoff`, pure, tested)

> "Estás resolviendo los comentarios del PR «{title}» ({source} → {target}). Comentarios (en
> orden):\n\n{comments}\n\nImplementa los cambios pedidos en este branch (es escribible). Haz
> **commit** de cada cambio con un mensaje claro. **NO hagas push** — yo reviso y pusheo. Si un
> comentario ya está resuelto en el código, anótalo y sigue."

Delivered via the same auto-submit path. The initial implementer is the only custom entrypoint: it reads the
gitignored context artifact, captures the review baseline/scope, implements, tests and commits, then writes the
session checkpoint. Once that checkpoint exists, the normal workflow is authoritative: reviewer launches with
`wf review <checkpoint>` and a correction loop launches with `wf implement <checkpoint>`.

## Push to PR

Gated topbar button (pr-fix only) → `sessions.pushFixBranch(sessionId)` → `git push` in the
worktree (the branch tracks `origin/<source>`). The renderer and IPC both require a live checkpoint
with `status: DONE`, zero open findings and a passing `PR_REVIEW` ledger cell. Shows the result.
Outward action → button-only, never automatic.

## SessionView generalization

Generalize the current `reviewMode` handling into a **PR-session** concept:
- `prSession = kind === "review" || kind === "pr-fix"`; `prRole = kind === "pr-fix" ? "implementer" : "reviewer"`.
- One agent tab (`prRole`), auto-submit its kickoff, no architect/implementer/checkpoint/Log.
- Topbar chip: `PR REVIEW` (green) or `PR FIX` (amber); PR chip links `pr.url`.
- Actions: review+pr → **Post to PR**; review-manual → **Post to Slack**; pr-fix → **Push to PR**.
- `roleHint` per kind.

## Creation

`NewSessionDialog`: add a **PR fix** kind. It's link-only (no manual mode) — reuse the PR-URL
input + Check preview; submit → `sessions.createFixFromPr(projectId, { url })`. Disabled without
VCS creds.

## Tasks

- **F1** `WorkSessionKind += "pr-fix"` + `WorkSession.pr` already there; fixtures/label maps. (tested)
- **F2** `ReviewComment.inline` + Bitbucket mapper fills it. (unit)
- **F3** `buildPrFixKickoff` (pure) + spec. (unit)
- **F4** `createFixSession` (writable tracking worktree) in the registry. (registry test)
- **F5** IPC: `sessions.createFixFromPr` (resolve → createFixSession), `sessions.pushFixBranch`;
  wire the fix kickoff (all comments) into `buildReviewOrWfCommand`; preload + contract.
- **F6** NewSessionDialog: "PR fix" kind (link-only). (device)
- **F7** SessionView: generalize to PR-session (role reviewer|implementer), PR FIX chip, Push-to-PR
  button, kind-aware hint. App unchanged (reviewConfig already passed). (device)

## Testing / risks

- Unit: kind label maps, inline comment mapping, fix kickoff assembly, createFixSession
  (writable worktree exists + on the branch).
- Device: real writable checkout + git push to a **throwaway PR** first (push is irreversible,
  button-gated). If `<source>` is checked out in the user's main worktree, creation errors — use
  a dedicated clone or free the branch.
