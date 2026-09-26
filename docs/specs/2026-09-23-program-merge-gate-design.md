# Program Merge Gate — Design

**Date:** 2026-09-23
**Status:** Implemented on `feature/program-merge-gate` (not committed yet)

## Problem

A *program* splits a feature into children, each a normal checkpoint. The workflow says two
things about moving from one child to the next: children are opened **one at a time**, and a
`DONE` child is **merged into `develop` through its PR** before the next one opens. Until
2026-09-23 both were prose, and architects ignored them.

Biznex commit `a29f1cac4` made the workflow enforce them: `pnpm wf:next <program spec>` returns
`READY` / `COMPLETE` / `BLOCKED`, and `wf:done` refuses to publish a turn of one child while another
`DONE` child is not in `origin/develop`.

The coordinator still contradicts that, and hides it:

- `resolveProgram` offers the first `PENDING` child whose dependencies are `DONE`. It ignores
  merges and the one-at-a-time rule. With child 1 `IN_PROGRESS`, it already offers «Iniciar hijo
  2», because child 2 declares no dependency (measured on the real Biznex program).
- Inside an open session, a program shows up only as `· programa <file>.md` in the checkpoint
  header. There is no list of children, no merge state, no warning. The developer can't tell.
- «Iniciar hijo N» goes through New session → Continue → branch. Children share the program's
  branch and worktree by default, and Continue aborts on a branch that is already checked out
  («Git allows a branch in only one worktree»). So the path the rules document can't work while
  the session that holds the program is alive.
- A session with no checkpoint binds to the **first** `*-checkpoint.md` that changes in its
  worktree. In a shared worktree, that can be the parent's checkpoint or a sibling's.
- A spec with a malformed table (`## §4. Hijos` instead of `# Hijos`) is silently not a program.

## Decisions (user, 2026-09-23)

1. **The session advances.** The session that holds the program's worktree moves from child to
   child. There is one coordinator session per program, not one per child.
2. **The coordinator mirrors `wf:next`.** It computes the same verdict and shows it. The gate
   lives in the workflow; the coordinator makes it visible and refuses to start a child the
   workflow would block.
3. **Visibility is a requirement, not polish.** A blocked program must be impossible to miss.
4. The merge base is `origin/develop`, the same as Biznex `PROGRAM_MERGE_BASE`. It is not configurable.

## Model

### The verdict — one computation, the same as `wf:next`

`src/shared/workflow/program-verdict.ts` (pure) ports, from Biznex `scripts/wf-done.ts` and
`scripts/wf-next.ts` at `a29f1cac4`, updated to `802fb00cb`. That commit changed three things that
reach `nextChild`:
- One table reader for both readers: rows are trimmed, and rows inside ``` blocks don't count.
- `Hijos:` read without crossing lines, and the user's exception counted only on its own line.
- `programBirthErrors`: the index is frozen by git. Main reads it from the spec's history
  (`git log --follow`) and passes it in as `birthErrors`.

`programPathOf` also now reads backticked or linked paths, and the checkpoint parser uses it too.
The fetch runs without prompts: `GIT_TERMINAL_PROMPT=0`, and ssh in batch mode unless the user
configured their own. The rest of that commit (the follow-ups sweep and the new `wf:done` gates) is
publish-time only and does not change the verdict. The ported pieces:

- `programChildren`: the tolerant `# Hijos` reader, cell for cell (replaces the parsing in
  `program-spec.ts`, whose `resolveProgram`/`next`/`complete` are deleted so there are never two
  answers).
- `programTableErrors`: the strict contract (header, separator, 6 cells, `#` in order, exact
  `Estado`, path shapes, `PENDING` without a checkpoint, dependencies only on earlier children,
  `Hijos: <n>` equal to the rows).
- `programPathOf`, `frontmatterStatus`, `derivedChildState`: same regexes.
- `decideProgramVerdict(input)`: `nextChild` without file I/O. Its input is the program markdown, a
  reader for each child checkpoint's text, and the merge result for each `DONE` child. Its output:

```ts
type ProgramVerdict = {
  specPath: string;
  title: string;
  verdict: "READY" | "COMPLETE" | "BLOCKED";
  next: ProgramChildView | null;          // READY only
  children: ProgramChildView[];           // every row, with real state + merge state
  reasons: string[];                      // BLOCKED: every line, worded like wf:next
  hints: string[];                        // non-blocking (a stale Estado column)
  base: string;                           // "origin/develop"
  fetchNote: string | null;               // "no se pudo actualizar origin/develop…"
  checkedAtEpochMs: number;
};
type ProgramChildView = {
  index: number; name: string; spec: string | null; checkpoint: string | null;
  dependsOn: number[];
  state: "PENDING" | "IN_PROGRESS" | "DONE";       // from the checkpoint's status:, never the column
  merge: { state: "merged" | "unmerged" | "uncommitted" | "unknown"; closeSha: string | null } | null; // DONE only
};
```

The order of reasons and the verdict follow `nextChild` exactly: a missing spec, a missing `# Hijos`
section, contract errors, a missing checkpoint file, a missing or wrong back-link, any child with a
checkpoint that is not `DONE` («de a uno»), and any `DONE` child that is not merged. Then `COMPLETE`
if no child is pending, then `READY` for the first pending child whose dependencies are all `DONE`,
otherwise `BLOCKED` naming what each pending child waits for.

**One deliberate difference:** a stale `Estado` column is a *hint*, not a reason. The rules make the
architect run `wf:next --write` first, which rewrites the column before it decides. The
coordinator's verdict is therefore the one the architect will actually get.

### Merge check (main)

`src/main/projects/program-merge.ts` ports `childMergeError` and `refreshMergeBase`, parameterized
by the ref the program is read from:

- The **close commit** is `git log -1 --format=%H -G '^status:[[:space:]]*DONE' <ref> -- <checkpoint>`,
  and it only counts if the checkpoint at that commit really is `DONE`.
- **merged**: the close commit is an ancestor of `origin/develop`, or (squash)
  `git show origin/develop:<checkpoint>` is `DONE`.
- **uncommitted**: no such close commit exists (the `DONE` lives only in the working tree).
- **unknown**: not a repo, or `origin/develop` does not exist. This blocks, like `wf:next`: an
  unverifiable merge never lets a child through.
- **Fetch policy:** `git fetch --quiet origin develop` in the project root, at most once every 2
  minutes per project, plus forced on «Re-comprobar» and before any action. A failed fetch keeps the
  local copy and sets `fetchNote`. A stale copy can only block more, never less.

Two sources feed the same verdict:

- **Session (worktree):** files from disk and `<ref>` = `HEAD`, which is what `wf:next` reads.
- **Dialog (ref, no checkout):** files via `git show <ref>:<path>` and `<ref>` = the chosen branch
  (`ref-programs.ts`, which now returns verdicts). It lists only the ref's **own** programs: one of their
  children declares `branch: <ref>`, or, with no child checkpoint yet, the spec is not in
  `origin/develop` (it was born on this branch). The programs merged into develop are not the
  branch's.

### Which program a session belongs to

In priority order:

1. `session.program` (new persisted field, set when the session advances).
2. The bound checkpoint's `Programa:` pointer (a child).
3. The bound checkpoint's `▶ NEXT` command, when it is `wf next <spec>`. That is a parent that
   spawned the program, or a closed child pointing to the next one.
4. `session.initialPrompt`, when it is `wf next <spec>` (a child session with no checkpoint yet).
5. Otherwise (feature/fix only): the program whose children were made on the session's **branch**,
   meaning a checkpoint that declares `Programa:` and whose frontmatter `branch:` is the session's
   branch. A program with an open child wins, then the most recently touched one. The branch filter
   is required: every worktree also holds the checkpoints of every feature merged in through develop,
   other programs' children included. Without it, `deploy-platform` showed the `sales-channels`
   program (2026-09-25). This covers a session bound to the parent after the parent's `▶ NEXT` stops saying
   `wf next`: on 2026-09-23 the real `corp-filing-form-mapping` session moved on to `wf followups` and
   lost its program, while child 1 lived in the same worktree.

A session that matches none of these has no program UI.

### Program status service (main)

`src/main/projects/program-status-service.ts` keeps one `ProgramVerdict | ProgramStatusError` per
program session, and:

- recomputes on project checkpoint-watcher events inside that session's worktree, on session
  changes, and every 5 minutes (so a PR merged on Bitbucket shows up with no click);
- broadcasts `programs:status-changed { sessionId, status }`;
- serves `programs:get-status(sessionId)` and `programs:refresh(sessionId)`, which forces the fetch.

Any failure produces a `BLOCKED` verdict with the reason. It never throws into the UI and never
shows `READY`.

## UI

All copy is Spanish, matching the existing program UI.

### Session banner — every tab

The banner is a `SessionNotice` at the top of the session, next to the existing auto-pilot notices:

| Situation | Tone | Copy (shape) | Action |
|---|---|---|---|
| BLOCKED by merge / uncommitted close | danger | «⛔ Programa bloqueado — hijo 1 está DONE y su PR a develop no está merjeado (cierre a1b2c3d4 no está en origin/develop).» | Re-comprobar |
| BLOCKED by contract / back-link / missing section | warning | «Programa: la tabla `# Hijos` no cumple el contrato» + the reasons | Re-comprobar |
| A child is IN_PROGRESS and the session is bound to another checkpoint | warning | «El hijo N está en curso y esta sesión mira otro checkpoint.» | Seguir el hijo N en esta sesión |
| READY and the session's own child is DONE and merged (or the session is the parent) | success | «▶ El hijo N puede empezar.» | Iniciar hijo N en esta sesión |
| The session has a program but no checkpoint yet (the child's INIT is running) | info | «Esperando el checkpoint del hijo N: el Architect lo escribe al cerrar el INIT.» | — |
| COMPLETE | success | «Programa completo: todos los hijos DONE y merjeados.» | — |
| The session is the child in progress | — | no banner (the Log panel shows the program) | — |

### Log tab — «Programa» panel

The panel renders above the checkpoint header, and also when the session has no checkpoint yet.
It shows:

- the title, `n/N DONE`, and «origin/develop comprobado hace X» (plus `fetchNote` if any);
- one row per child: `#`, name, state badge, merge badge (`✓ merjeado` / `✗ sin merge` /
  `✗ cierre sin commitear` / `? sin verificar`), «depende de …», and «← esta sesión» on the bound child;
- the verdict with every reason, and the hints;
- the same action buttons as the banner.

### Rail badge

The session row in `ProjectRail` gets a small badge from the status map: `⛔` for a merge or close
block, `⚠` for a contract block or a session looking at the wrong checkpoint, `▶` for READY. Its
tooltip is the first reason. This is what makes a block visible without opening the session.

### New-session dialog

- Programs on the ref show the same children view and verdict. «Iniciar hijo N» is enabled only on
  `READY`. Otherwise it is disabled and the reasons are listed.
- If the chosen branch is held by a session (the renderer already knows every session's branch),
  the program block says «La rama está en la sesión «X»: avanza el programa desde ahí» and offers
  «Ir a la sesión». No Continue can then fail with git's error.
- A spec whose `▶ NEXT` points at it but has no `# Hijos` section is only detectable from a session.
  In the dialog, only specs with a `# Hijos` section are listed, as today.

## Session actions

Both actions are IPC calls to main, and main re-validates them. The UI is never trusted: main
recomputes the verdict with a forced fetch before acting.

### «Iniciar hijo N en esta sesión» — `sessions:start-program-child(sessionId)`

1. Recompute the verdict. Anything but `READY` → refuse with the reasons.
2. Persist `checkpointPath: null`, `program: <spec>`, `initialPrompt: "wf next <spec>"`.
   Implementer and Reviewer lock again, as in any session without a checkpoint.
3. Re-arm the session checkpoint watcher with the program filter (below).
4. Reset the auto-pilot conductor state to its initial state.
5. Relaunch the Architect **fresh** through the same `terminals.replace` path auto-pilot uses, with
   `wf next <spec>` typed **and submitted**. The click is the confirmation. Because this replaces
   the current Architect conversation, the button asks inline first («Reemplaza la conversación
   actual del Architect — ¿seguir?»). There is no browser dialog.

### «Seguir el hijo N en esta sesión» — `sessions:adopt-program-child(sessionId, index)`

The checkpoint must be listed in the program's `# Hijos`, declare `Programa: <spec>`, and not be
`DONE`. The action persists `checkpointPath` and `program`, stops the watcher, and signals
`checkpointDetected` plus `onCheckpoint` exactly like a detected checkpoint. The Architect
conversation is left untouched: in practice it is the one that just wrote that child's INIT.

### Binding filter (the gate fix)

`createSessionCheckpointWatchManager.watchSession` takes an optional `programSpecPath`. When it is
set, both the initial scan and live events accept a `*-checkpoint.md` only if its text declares
`Programa: <programSpecPath>` (same `programPathOf`) and its `status:` is not `DONE`. A rejected
candidate is ignored and the watch continues. Sessions with a program (rules 1 and 4 above) always
watch with the filter. Sessions without one keep today's behaviour.

## Error handling

- git or file errors → a `BLOCKED` verdict with a «no se pudo verificar» reason. Never `READY`.
- A failed fetch → the local copy plus a visible `fetchNote`.
- If the action IPCs are refused, the reasons appear in the banner. The session record changes only
  after validation passes. If the Architect relaunch fails after persisting, the session is left
  without a checkpoint and with `initialPrompt` set, so opening the Architect tab still pre-types
  `wf next`, and the error is shown.

## Testing (vitest, `pnpm test`)

- `program-verdict.spec.ts`: port the Biznex `wf-next.spec.ts` and contract cases, with merge results
  as inputs. Cases:
  - unmerged close → BLOCKED naming the SHA;
  - merged → READY child 2;
  - squash → READY;
  - uncommitted → BLOCKED;
  - a child not DONE → BLOCKED (de a uno);
  - all DONE and merged → COMPLETE;
  - dependency on a later child → contract error;
  - every invalid table shape named;
  - back-link missing or wrong;
  - stale `Estado` is a hint, not a reason;
  - the real Biznex program with `## §4. Hijos` → «no tiene la sección `# Hijos`».
- `program-merge.spec.ts`: temp git repos (merge commit, squash, soft-reset uncommitted, no
  `origin/develop`, a ref other than HEAD), plus the fetch throttle.
- `session-checkpoint-watch-manager.spec.ts`: with the filter, the parent's and a DONE sibling's
  checkpoint changes are ignored, and the child's is bound. Without the filter, behaviour is unchanged.
- Session actions: refusal when not READY, the persisted fields, the watcher re-armed, the conductor
  reset, and the architect relaunched with the submitted prompt (orchestrator fakes); adopt validation.
- Renderer pure helpers: banner situation/tone selection and the rail badge mapping.

## Out of scope

- A per-project merge base (fixed at `origin/develop`).
- One coordinator session per child (the rejected «traspaso» option).
- Writing the `Estado` column. The workflow's `wf:next --write` owns it.
- Opening the PR from the coordinator.
