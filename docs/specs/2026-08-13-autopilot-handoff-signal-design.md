# Auto-pilot Hand-off Signal — Design

**Date:** 2026-08-13
**Status:** Approved, not yet implemented

## Problem

Auto-pilot has to know one thing before it launches the next role: that the outgoing agent's turn
is over. Getting that wrong puts two agents in one worktree, and they fight over it.

The first answer was a timer. `settleDelayMs` after the checkpoint file stopped changing, launch
the next role. That measures the wrong thing. `▶ NEXT` is workflow bookkeeping, so an agent
routinely writes it while it still has work to do, and no delay measured from that write can tell
such a turn apart from a finished one. Raising the delay to 30s narrowed the window without
closing it.

The second answer was the hand-off commit (`checkpoint-commit-gate.ts`). The workflow's contract
is that an agent's last act is to write NEXT and commit it, so "this NEXT is in HEAD" was a signal
that could be verified rather than guessed. It closed the overlap, at a price: auto-pilot only
advances if every hand-off is committed. In one feature that meant 46 of 64 commits carried
nothing but the checkpoint — a second commit per turn, made solely to satisfy the gate.

The commit was never valuable *because* it was git. It was valuable because it was a **separate,
single-purpose, final act**, which is exactly what `▶ NEXT` is not. Any act with those three
properties works as well, and one that is not a commit costs no history.

## Model

`wf done` is the last thing an agent runs in a turn. It writes a hand-off file that says nothing
except "turn over, handing to this step". Auto-pilot watches that file.

Responsibilities stay split:

- **The checkpoint says WHAT.** Role, lane, command, tier, task, plus `DONE`/`BLOCKED` and the
  re-loop history — the whole `decideConductor` decision table keeps reading the parsed checkpoint
  it already reads. Nothing about that changes.
- **The hand-off file says WHEN.** It carries the *identity* of the step it hands to, never the
  command, so there are not two sources of truth that can drift.

Git leaves the picture entirely. Committing checkpoints becomes a matter of history hygiene, free
to happen once per plan, folded into a work commit, or not at all.

## The hand-off file

Path `<worktree>/.agent-handoff.json`, at the worktree root beside `.agent-review.md`.

Registered with `addWorktreeExclude(worktreePath, ".agent-handoff.json")` when the session is
created, alongside the existing `REVIEW_ARTIFACT` and `PR_CONTEXT_ARTIFACT` calls. That puts the
pattern in the repository's local `info/exclude`, so the file never appears in `git status`, never
reaches a diff, and never requires a commit to the tracked `.gitignore`.

```json
{
  "turn": 7,
  "checkpoint": "docs/workflow/checkpoints/auth-checkpoint.md",
  "next": { "role": "reviewer", "sessionLane": "plan-1/reviewer" }
}
```

- `turn` — monotonically increasing per session. This is what makes edge detection reliable when
  two consecutive turns hand to the same lane, where content alone would be identical.
- `checkpoint` — worktree-relative path, so a worktree holding more than one checkpoint cannot
  have a hand-off attributed to the wrong session.
- `next.role` / `next.sessionLane` — the step being handed to. Identity only.

`wf done` writes it atomically (temp file plus rename) so a watcher can never observe a half-written
file. Malformed or unparseable content is treated as "no new hand-off": the gate holds and says so,
rather than acting on a guess.

## The gate

Replaces `checkpointCommitState` and the two-second git poll around it. `runAutopilot` consults it
after `decideConductor` returns a `send`, and commits nothing to conductor state until it clears.

| State | Action |
|---|---|
| New hand-off, `role`+`sessionLane` match the NEXT on disk | Run `settleDelayMs` from the moment the hand-off was seen, then launch |
| New hand-off, identity does **not** match | Wait — the checkpoint on disk is not updated yet |
| File exists, no new `turn` | Wait — the outgoing agent has not finished |
| File has never existed for this session | Fall back: today's behavior, NEXT change plus `settleDelayMs`, with the reason visible in the auto-pilot message |

The comparison is always against the checkpoint **on disk**, never against HEAD. What the gate
requires of the checkpoint is that it be current, not that it be committed.

`settleDelayMs` keeps its meaning and its configured value: time measured from the confirmation,
which is now the hand-off rather than the commit.

### Fallback stickiness

The "has never existed" test is sticky per session. Once a hand-off file has been observed, the
session stays in hand-off mode, and later absence of the file means "waiting", not "fall back".
Otherwise deleting the file would silently downgrade a session to the weaker signal.

### Accepted risk

A session whose workflow does not emit the signal runs on the fallback, which is the pre-gate
behavior — including its overlap risk. This is deliberate: it keeps every existing session working.
The auto-pilot message names the fallback so a session running unguarded is visible rather than
assumed safe.

## Watching

A session-scoped watcher, sibling to `session-checkpoint-watch-manager`, over that single file in
the worktree. It reuses `createCheckpointWatcher` for its debounce. Unlike the checkpoint watcher,
it is **not** one-shot: it reports every change for the life of the session.

Checkpoint changes keep updating `latestCheckpoint` and keep scheduling a re-check. That re-check is
cheap and the gate holds unless a new hand-off is pending, which is what resolves the race where the
hand-off lands before the checkpoint write is flushed.

## Removed

- `checkpoint-commit-gate.ts` and its spec.
- `handoffCommittedAt` and `HANDOFF_COMMIT_POLL_MS` in `session-orchestrator.ts`.
- The two-second git polling loop. The watcher is event-driven; nothing needs polling.

## Tests

- **Watcher** — fake watcher, as in `session-checkpoint-watch-manager.spec.ts`: reports each change,
  ignores unrelated files, survives a malformed write.
- **Gate** — a pure table function over (pending hand-off, NEXT on disk, delay, now) returning
  `fire | wait | fallback`. Every row of the table above, plus a repeated `turn`, a mismatched lane,
  and unparseable content.
- **Orchestrator** — end to end: holds while no hand-off exists, launches on a matching hand-off
  after the delay, and falls back for a session that never had the file.

## Out of scope

`wf done` itself lives outside this repo. Until it exists, every session takes the fallback and
behavior is unchanged, so the workflow command should land first.

PTY-silence detection was measured (`codex` and `claude` both emit zero bytes across 45s idle) and
would work, but with `wf done` as an explicit final act it adds a second mechanism for no gain.
Not adopted.
