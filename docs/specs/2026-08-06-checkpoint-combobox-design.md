# Checkpoint Combobox — Design

**Date:** 2026-08-06
**Status:** Approved, not yet implemented

## Problem

The new-session dialog picks a start branch with a searchable combobox and a checkpoint with a
native `<select>` (`NewSessionDialog.tsx:388-402`). The two sit one field apart and behave nothing
alike.

The `<select>` cannot be filtered. On a long-lived branch every checkpoint the project ever
committed is listed, and the only way through is scrolling a native popup. Worse, each option
renders as `feature ?? slug ?? path · status` — the path appears **only** when both the feature
title and the slug are missing. Two checkpoints titled "Session log tabs" are indistinguishable, and
the value actually being submitted (`checkpointPath`) is never shown. The user picks a title and
hopes.

Everything needed to fix this is already in the renderer: `listRefCheckpoints` returns
`{ path, feature, slug, status }` per checkpoint (`contract.ts:104-109`). No main-process or IPC
change.

## Model

One interaction, two presentations. `BranchCombobox` and the new `CheckpointCombobox` share their
state machine — query, open, highlight, filtering, outside-click, arrow/Enter/Escape — and differ
only in how a row is drawn.

The shared layer works on an opaque entry:

```ts
interface ComboboxEntry {
  id: string;         // the committed value
  label: string;      // what the input shows once picked
  searchText: string; // what the query matches against
}
```

This separation is what the checkpoint picker needs and the branch picker never did. For a branch,
all three are the branch name. For a checkpoint, `id` is the path (what `buildStartFromInput`
consumes, `session-start-from.ts:26-37`), `label` is the human title, and `searchText` concatenates
title, slug, path and status. `BranchCombobox` today conflates them — it compares `query === value`
to decide whether to re-show the full list (`BranchCombobox.tsx:51`) — which breaks the moment the
displayed text stops being the value.

### Filtering

The query is split on whitespace; every term must appear in `searchText` (case-insensitive
substring, AND across terms). So `session plan` finds *Session start point · PLANNED*, and
`checkpoints/ log` finds a path-and-title combination.

For a single term this is byte-for-byte today's branch behavior, so moving branches onto the shared
filter changes nothing for them.

The existing `MAX_SHOWN = 60` cap and the "+N more — keep typing to narrow" line
(`BranchCombobox.tsx:20,138`) move into the shared layer unchanged.

## Modules

`use-combobox.ts` — the shared layer. Exports the pure `filterComboboxEntries(entries, query)` and
the `useCombobox` hook (query/open/highlight state, keyboard handler, outside-click effect, the
`MAX_SHOWN` slice and overflow count). The pure export is tested directly; the hook's stateful half
has no test — the renderer has no DOM harness — and is verified by exercising both fields in the
dialog.

`checkpoint-display.ts` — checkpoint presentation, pure:

| Function | Behavior |
|---|---|
| `checkpointLabel(cp)` | `feature ?? slug ?? path` — the title shown in the input and on row line 1 |
| `checkpointSearchText(cp)` | `feature`, `slug`, `path`, `status` joined, lowercased |
| `statusBadgeClass(status)` | `BLOCKED → badge badge-attention`, `DONE → badge badge-done`, else `badge` |

`statusBadgeClass` is today module-private in `SessionView.tsx:228-232` and typed on
`WorkflowStatus`. `RefCheckpointSummary.status` is a plain `string`, so the shared version widens to
`string` and `SessionView` imports it instead of keeping its own copy. One mapping, one spec.

`CheckpointCombobox.tsx` — markup, on top of `useCombobox`.

## The row

```
┌────────────────────────────────────────────────┐
│ session_                                       │
├────────────────────────────────────────────────┤
│ None — start at Architect                      │
│                                                │
│ Session start point                 [PLANNED]  │
│ docs/checkpoints/session-start-point.md        │
│                                                │
│ Session log tabs                    [REVIEW]   │
│ docs/checkpoints/session-log-tabs.md           │
├────────────────────────────────────────────────┤
│ +12 more — keep typing to narrow               │
└────────────────────────────────────────────────┘
```

Title on line 1, the **full** repo-relative path on line 2 in monospace and muted, status badge
right-aligned on line 1 reusing `.badge` / `.badge-attention` / `.badge-done` (`styles.css:2335`).

The row is an exported stateless `CheckpointOptionRow`, so its markup is render-tested without
driving the parent's open state.

### "None" is a pinned row, not a match

*None — start at Architect* sits above the list, is never filtered out, and commits `""` —
`buildStartFromInput` already maps that to `checkpointPath: null`. Editing the input down to an
empty string clears the committed value the same way, so a checkpoint is never left adopted behind
a field that no longer names it.

### After selection the path stays visible

The input shows the title; the field hint below shows the chosen checkpoint's full path. Picking by
title and still seeing exactly which file was adopted is the point of the change, and the hint is
where that fits without a two-line input.

### States

| Condition | Input | Hint |
|---|---|---|
| No branch picked | disabled | "Pick a branch first." |
| Loading | disabled, placeholder "Reading the branch…" | unchanged |
| Ref has no checkpoints | disabled | "No checkpoint committed on this branch — the session starts at Architect." |
| Checkpoints available, none picked | enabled, placeholder "Type to search checkpoints…" | "Adopting one unlocks Implementer and Reviewer right away, with wf implement pre-typed." |
| One picked | shows the title | the checkpoint's full path |
| Query matches nothing | enabled | list shows "No matching checkpoints" |

The first four hints are the ones already in `NewSessionDialog.tsx:403-409`, kept verbatim.

## CSS

`.branch-combobox-*` is renamed to `.combobox-*` (`styles.css:2710-2773`); the classes are used by a
single component, so the rename is contained. `.combobox-scope` keeps the branch-only remote/local
colouring. New: `.combobox-option-checkpoint` (two-line grid), `.combobox-option-title`,
`.combobox-option-path` (monospace, muted, ellipsis on overflow). No new theme tokens.

## Tests

Run with `pnpm test` — never raw vitest, since `pretest` rebuilds `better-sqlite3` for Node.

- `use-combobox.spec.ts` — `filterComboboxEntries`: single term, multi-term AND, case-insensitivity,
  no-match, empty query returns everything.
- `checkpoint-display.spec.ts` — the `feature → slug → path` fallback chain including a checkpoint
  with neither title nor slug; `searchText` covering all four fields; the three badge classes.
- `CheckpointCombobox.spec.ts` — `renderToStaticMarkup` of `CheckpointOptionRow`, following
  `session-notice.spec.ts:14-22`: title, full path and badge class all present in the markup.
- `session-start-from.spec.ts` is untouched — `buildStartFromInput` still receives a path string.

`BranchCombobox` has no tests today and gains none; its refactor is verified by the shared filter's
spec plus manual check of the branch field in the dialog.

## Out of scope

- Any change to `listRefCheckpoints`, the IPC contract, or checkpoint parsing.
- Grouping checkpoints by status or directory — rejected during design; it breaks the path ordering
  and complicates arrow-key traversal.
- Replacing any other native `<select>` in the app.
- Component tests for `BranchCombobox`.
