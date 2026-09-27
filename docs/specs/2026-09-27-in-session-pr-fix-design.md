# PR fix inside the session — Design

**Date:** 2026-09-27
**Status:** Implemented (app side)
**Builds on:** `2026-07-14-pr-fix-session-design.md`

## Problem

A feature/fix session opens a PR from its own branch. When the PR comes back with comments, **New session → PR
fix** cannot open that branch: `createFixSession` runs `git worktree add <source>` and git allows a branch in one
worktree only. The user had to delete the session's worktree to fix its own PR. In a program this is the normal
case: the session stays bound to the DONE child until its PR merges.

## Design

A **PR fix** topbar button on every feature/fix session with a DONE checkpoint (program child or not). The separate
PR-fix session stays for working from another machine.

1. The dialog asks for the PR link, prefilled once the session is linked (`WorkSession.pr`, now also set on
   feature/fix sessions).
2. Main (`session-pr-fix-actions.ts`) re-checks everything before changing anything: checkpoint `DONE`; PR source
   branch = session branch; after a fetch, HEAD contains the PR head (otherwise: pull first); the PR conversation
   downloaded with at least one comment.
3. It writes `.agent-pr-context.md`, links the PR, resets auto-pilot and runs the **Reviewer** on the lane that
   closed the checkpoint (`feature-review/reviewer`, or `fix/reviewer` for a `kind: fix`), resuming its conversation
   when the context allows.
4. The Reviewer reopens the same checkpoint as a `⚠ ISSUES` round (`FEATURE_REVIEW`, or `PR_REVIEW` for a fix):
   the PR report's `Plan de corrección` verified against the code, `PLAN_REVIEW:` satisfied by the report's audit
   receipt, `▶ NEXT` → implementer, `wf:done`. A program child also sets its `# Hijos` row back to `IN_PROGRESS`.
   From there the canonical loop runs: FIX → re-review of the delta → DONE.
5. **Push to PR** appears on linked sessions with the PR-fix gate (DONE, zero open findings, passing `PR_REVIEW`)
   and pushes `HEAD:refs/heads/<branch>` (the branch may have no upstream).

### Why the Reviewer, not the Architect

The PR review report already carries a diagnosed, audited correction plan: the exact shape of a Reviewer
`⚠ ISSUES` entry, which the existing correction loop consumes. It reuses the same checkpoint (no new `kind: fix`
checkpoint, no rebinding, and program watchers only accept their program's checkpoints), and resumes the reviewer
lane that gave the DONE. Redesign requests still route `BLOCKED → architect`.

## Workflow manual

The kickoff (`buildSessionPrFixReviewerKickoff`) is the complete entry: a session's branch may carry an older
manual. A durable **PR fix · reapertura** entry in the project's `reviewer.md` is pending a decision: biznex's
`reviewer.md` is at 26,871 of its 27,000-byte cap (`ai-agent-rules/sync/manifest.json`), and rules land directly on
`develop`.

`wf:done` needs no change: it does not police DONE → IN_PROGRESS, only asks an `⚠ ISSUES` entry for
`Follow-ups added:` and a `PLAN_REVIEW:` line, and rejects a program index row still `DONE` while its checkpoint is
open, which the kickoff covers.
