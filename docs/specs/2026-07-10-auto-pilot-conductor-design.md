# Auto-pilot Conductor — Design

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation plan
**Repo:** AGENTS (Agent Coordinator desktop app)

## Summary

A **deterministic conductor** that drives the `wf` multi-stage workflow tab-by-tab
automatically. Today the user must manually read the checkpoint's `▶ NEXT` block,
know which agent tab to run it in, and press Enter at every hand-off. The conductor
removes that burden: when a session's checkpoint changes, it reads `▶ NEXT`, opens
the correct role tab, and runs its command — with guardrails, a per-project re-loop
cap, and a settle delay so it never fires while the agent is still writing.

**No LLM.** The `▶ NEXT` block is already fully machine-readable
(`parseCheckpointMarkdown` → `next.role` / `next.command` / `next.cwd` / `next.task`).
"Which tab + which command" is a pure function of that block — the architect already
encoded the intelligence into the checkpoint. The conductor is deterministic glue over
primitives that already exist in the renderer (`selectRole`, `sendText`). Zero tokens,
zero API key, fully unit-testable.

## Goals

- Auto-advance a session through architect → implementer → reviewer (and tier to tier)
  once the human has kicked off the architect and a checkpoint exists.
- Auto-run reviewer→implementer fix loops up to a configurable cap, then pause.
- Never fire while the writing agent may still be mid-write (settle delay).
- Be visibly controllable: a per-session on/off switch in the topbar, with feedback
  on every action.
- Stop safely on terminal/blocked states — never run blind.

## Non-goals

- No LLM/model in the loop (explicitly rejected in brainstorming; the happy path is
  deterministic and the exceptions are handled by pausing for the human, not by a model).
- No auto-start of the architect — brainstorming needs a human; the conductor is dormant
  until a checkpoint exists.
- No cross-session global orchestration — each session's conductor is independent.

## Architecture

Two layers, matching the codebase's "pure shared logic + thin adapter" style (cf.
`buildRoleLaunchPlan`):

1. **Pure decision function** — `src/shared/workflow/conductor.ts`. Given the previous
   conductor state, the freshly-parsed checkpoint, and the project's auto-pilot config,
   it returns an **action** (`send` / `pause` / `noop`) plus the next state. No I/O, no
   timers — 100% deterministic and TDD'd.

2. **Renderer adapter** — `src/renderer/hooks/useConductor.ts` (used by `SessionView`).
   Owns all the I/O and timing: subscribes to checkpoint changes for this session,
   applies the settle-delay debounce, calls `decideConductor`, and performs the action
   via the existing `selectRole` + `sendText` primitives. Holds the conductor state and
   the auto-pilot on/off flag.

### Data flow

```
checkpoint file changes
      │  main: checkpointWatchManager (300ms write-coalesce debounce) re-emits on
      │  EVERY add/change → broadcasts checkpoint.changed { projectId, checkpoint }
      │  — the parsed ParsedCheckpoint rides along, so the renderer never re-reads.
      ▼
useConductor (renderer, this session — matches broadcast to session by absolute path)
      │  restart quiescence timer on every matching change
      │  ── settleDelayMs of no further changes ──▶ use the last payload's checkpoint
      ▼
decideConductor({ prev, checkpoint, config }) ──▶ { action, next }
      │
      ├─ send  → selectRole(role); sendText(command, execute=true); feedback line
      ├─ pause → selectRole(role); pre-type command (no Enter); feedback line
      └─ noop  → nothing
```

*(Confirmed: `checkpoint-watch-manager.ts` calls `parseCheckpointMarkdown` and
`onCheckpointChanged(projectId, parsed)` on every change; `main/index.ts` broadcasts it
as `checkpoint.changed`. The 300ms debounce is per-file write-coalescing; our
`settleDelayMs` is the "agent is done writing" wait and stacks on top.)*

## The decision function

`src/shared/workflow/conductor.ts`

### Types

```ts
import type { ParsedCheckpoint } from "./workflow-types";
import type { SessionAgentRole } from "./session-role-launch";

export interface AutoPilotConfig {
  /** Max reviewer→implementer fix-loops auto-run per task before pausing. Default 3, range 1–10. */
  reloopLimit: number;
  /** Quiescence-debounce window (ms) before acting on a checkpoint change. Default 4000. */
  settleDelayMs: number;
}

export type ConductorAction =
  | { kind: "send"; role: SessionAgentRole; command: string; reason: string }
  | { kind: "pause"; role: SessionAgentRole | null; command: string | null; reason: string }
  | { kind: "noop"; reason: string };

export interface ConductorState {
  /** The NEXT-content key we last ACTED on (send). Used for idempotency. */
  lastActedKey: string | null;
  /** Per-task count of backward fix-loops auto-run so far. */
  reloopCount: Record<string, number>;
  /** Task keys for which a reviewer step has already been acted on (to detect a bounce-back). */
  reviewedTasks: string[];
}

export const INITIAL_CONDUCTOR_STATE: ConductorState = {
  lastActedKey: null,
  reloopCount: {},
  reviewedTasks: [],
};
```

### Keys

- **`nextKey`** = `${role}|${command}|${tier}|${task}` — the semantic identity of a NEXT step.
- **`taskKey`** = `${tier}|${task}`, falling back to `command` when both tier and task are empty
  — the unit of work being iterated.

(`tier` = `next.tier`, `task` = `next.task`, both already parsed; empty string when null.)

### Decision table

Given the parsed checkpoint's `next` (role, command, tier, task) and `status`:

1. **`status === "DONE"`** → `pause` (reason `"workflow DONE"`). State unchanged.
2. **`status === "BLOCKED"`** → `pause` (reason `"BLOCKED"`). State unchanged.
3. **`next` is null, `role === "unknown"`, or `command` is null** → `pause`
   (reason `"NEXT not actionable"`). State unchanged.
4. **`nextKey === prev.lastActedKey`** → `noop` (reason `"already handled"`). State unchanged.
   *(This is the idempotency guard: a checkpoint re-save that leaves NEXT identical to the
   step we just ran is a no-op. Keying on the LAST acted step — not a growing set — is what
   lets a legitimate `review X → implement X → review X` loop re-run review the second time,
   while still swallowing duplicate saves.)*
5. **Otherwise it is a transition to a new step. Detect a re-loop:**
   `isReloop = role === "implementer" && prev.reviewedTasks.includes(taskKey)`
   *(reviewer already ran for this task, so we've bounced back to fix it).*
   - If `isReloop` and `(prev.reloopCount[taskKey] ?? 0) >= config.reloopLimit`
     → `pause` (reason `"re-loop limit (N) reached for task"`). State unchanged.
   - Else → `send { role, command }`. Update state:
     - `lastActedKey = nextKey`
     - if `isReloop`: `reloopCount[taskKey] = (prev ?? 0) + 1`
     - if `role === "reviewer"`: add `taskKey` to `reviewedTasks`

Forward progress (architect→implementer→reviewer, and each new tier's first
implementer/review) is always `send`. Only a same-task bounce back to implementer counts
against `reloopLimit`.

### Test cases (drive TDD)

- Happy path: architect NEXT→implementer→reviewer, each a distinct `send`.
- Idempotent re-save: same `nextKey` twice in a row → second is `noop`.
- Tier progression: `implement P1` then `implement P2` (different task) → both `send`.
- Legit review re-run after fix: `review X` → `implement X` → `review X` → the final
  `review X` is `send` (not swallowed), because `lastActedKey` was `implement X`.
- Re-loop under cap: reviewer→implementer bounce → `send`, `reloopCount[X] === 1`.
- Re-loop at cap: with `reloopLimit: 3`, the 4th bounce → `pause`.
- Re-loop counter resets across tasks: bounces on task X don't affect task Y.
- `status: DONE` / `BLOCKED` → `pause`, regardless of NEXT.
- `role: unknown` or missing command → `pause`.
- Enabling with a current actionable NEXT and `lastActedKey: null` → `send` (catch-up).

## The renderer adapter

`src/renderer/hooks/useConductor.ts`, consumed by `SessionView`.

Responsibilities (all the I/O the pure function avoids):

- **Subscribe** to `checkpoint.changed` broadcasts, matching each to this session by
  **absolute checkpoint path**: resolve the broadcast's project-root-relative
  `checkpoint.checkpointPath` against the project root, and the session's worktree-relative
  `session.checkpointPath` against `session.worktreePath`, then compare. (Absolute path, not
  slug — matching by slug would assume the architect wrote a checkpoint `slug` identical to
  the session's, which is not guaranteed. The two relative paths are rooted differently, so
  they must both be resolved to absolute first.) Only active once `session.checkpointPath` is
  set. Independent of which tab is active — the conductor must work on any tab.
- **Settle-delay debounce:** restart a timer on every matching change; only after
  `settleDelayMs` of quiescence call `decideConductor` with the **last payload's already-parsed
  `checkpoint`** (no re-read needed — the broadcast carries it). This is the "the model may
  still be writing" guard — we wait for the checkpoint to stop changing before acting.
- **Perform the action:**
  - `send` → `selectRole(role)` to open/activate the tab, then deliver the command to that
    tab's terminal, executed. **Requirement:** exactly one copy of the command reaches the
    tab, and only after the agent CLI is ready to receive it (see Risk 1).
  - `pause` → `selectRole(role)` (if any) and pre-type the command without Enter; surface
    the reason.
  - `noop` → nothing.
- **State:** hold `ConductorState` and the auto-pilot `enabled` flag (per session, default
  off). When `enabled` flips off, stop acting; when it flips on and there's a current
  actionable NEXT that differs from `lastActedKey`, act on it (catch-up).
- **Feedback:** append a short line per action — e.g. `auto-pilot → wf implement … (Implementer)`
  or `auto-pilot paused: BLOCKED`. Dedupe consecutive identical pause lines.

## Project config

Add an `autoPilot: AutoPilotConfig` field to the `Project` type, a sibling of
`runtimeConfig`, threaded through the same places:

- `src/main/projects/project-registry.ts` — `Project`, create/update inputs, defaults
  (`createDefaultAutoPilotConfig()` → `{ reloopLimit: 3, settleDelayMs: 4000 }`).
- `src/shared/ipc/contract.ts` — the create/update payload shape.
- `src/shared/workflow/agent-runtime-config.ts` (or a new `auto-pilot-config.ts`) — the
  `AutoPilotConfig` type + default factory. Defaults: `reloopLimit: 3`, `settleDelayMs: 4000`.

Persisted alongside `runtimeConfig` in the SQLite project registry. Existing projects
without the field fall back to the default factory (no migration required — mirror how
`runtimeConfig` handles absence at `project-registry.ts:77/99`).

## UI

### Auto-pilot switch (SessionView topbar)

A toggle labelled **Auto-pilot** in `session-topbar-meta`, next to the `checkpoint ready`
chip / branch / Files controls. Per session, default **off**.

- Disabled/dormant styling until `session.checkpointPath` exists (dormant until a checkpoint).
- On → the adapter starts acting; a subtle "on" state (e.g. green, mirroring the
  existing `session-topbar-chip-ok` treatment) so it's obvious at a glance.
- A small feedback area (reuse the Log/next styling) shows the last conductor action so the
  user always sees what it did and why, and can flip the switch to pause.

Not shown in `repoMode` sessions (they have no agent/checkpoint tabs).

### ProjectModal auto-pilot section

A small "Auto-pilot" section in the Add/Edit Project modal, below the per-stage model rows:

- **Re-loop limit** — number input, default 3, min 1 max 10.
- **Settle delay (seconds)** — number input, default 4 (stored as ms).

## Files

**New**
- `src/shared/workflow/conductor.ts` — pure decision function + types.
- `src/shared/workflow/conductor.spec.ts` — decision-table tests.
- `src/renderer/hooks/useConductor.ts` — renderer adapter (subscribe + debounce + drive).
- (config) `AutoPilotConfig` type + default factory — in `agent-runtime-config.ts` or a
  new `src/shared/workflow/auto-pilot-config.ts`.

**Modify**
- `src/main/projects/project-registry.ts` — `Project.autoPilot`, defaults, create/update threading.
- `src/main/projects/sqlite-project-registry.ts` — persist/read the new field.
- `src/shared/ipc/contract.ts` — create/update payload shape.
- `src/renderer/components/ProjectModal.tsx` — the two config inputs.
- `src/renderer/components/SessionView.tsx` — the topbar switch + `useConductor` wiring + feedback line.
- CSS (the session-view stylesheet) — switch + "on" state + feedback line.

## Risks & open implementation questions (for the plan to resolve)

1. **Single-command delivery + agent readiness (main risk).** When the conductor opens a
   role tab, `SessionTerminal` launches the agent CLI and *pre-types* its `wf` command
   (from `wfCommandForSessionRole`). If the conductor then also sends `next.command`, the
   command is duplicated. The plan must read `SessionTerminal`'s launch/pre-type sequence and
   choose one of:
   - **(a) Enter-only on fresh open** — when the conductor opened the tab and the pre-typed
     line equals `next.command`, send only Enter to execute it; send the full command only
     when the tab was already open (re-loop case).
   - **(b) Suppress pre-type under conductor** — plumb a `viaConductor` flag so a
     conductor-initiated open does not pre-type, and the conductor is the single source of
     the command.

   (b) is cleaner (one source of truth) but needs a launch-path flag; (a) reuses existing
   behavior. Either way, the command must be sent **only after the agent is ready** — reuse
   whatever readiness signal the pre-type sequence already relies on; the settle delay is a
   backstop, not the primary guarantee.

2. **Terminal busy on re-loop.** A reviewer→implementer bounce sends `wf implement` to the
   implementer tab that just finished. After an agent completes its turn the CLI is back at a
   prompt, so sending should be safe; the settle delay adds margin. A full PTY-idle detector is
   out of scope for v1 — note the limitation.

3. **Early fire if an agent pauses > settleDelayMs mid-write.** Mitigated by the visible
   feedback line + the pause switch. Acceptable for v1; revisit if it bites.

4. **checkpoint.changed coverage — CONFIRMED.** The project-level `checkpointWatchManager`
   re-emits on *every* add/change with the full parsed checkpoint
   (`checkpoint-watch-manager.ts` → `onCheckpointChanged`; `main/index.ts` → broadcast). The
   first-detection-only behavior is the *separate* session-level watcher and does not apply
   here. Residual detail (not a risk): join broadcast→session by `slug`, since the two paths
   are rooted differently — join by absolute path (see adapter), not slug.

## Testing strategy

- **Unit (Vitest):** `conductor.spec.ts` covers the full decision table above — this is where
  correctness lives, and it needs no Electron/DOM. TDD red→green per case.
- **Config:** extend `project-registry` / `agent-runtime-config` specs for the default factory
  and threading.
- **Adapter/UI:** the timing + terminal-send is device-verified (StrictMode + real PTY);
  the pure function carries the logic, so the adapter stays thin. Manual verification steps
  belong in the plan.
