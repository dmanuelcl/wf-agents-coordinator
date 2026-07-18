# Agent Coordinator

A cross-platform **Electron** desktop app for driving many coding-agent terminal
sessions across your projects — built around a git-**worktree**-per-task model and
the Biznex `wf` multi-session workflow (architect → implementer → reviewer,
coordinated through one checkpoint file).

```text
Project  ─►  Session (= a git worktree on its own branch)  ─►  Role tabs + shells
                                                                (Architect · Implementer · Reviewer · Log · shells)
```

Each session gets an isolated worktree so several tasks in one repo never collide.
Agents (Claude, Codex, Gemini, Copilot, OpenCode) run as real terminal processes;
the app just orchestrates them, watches for the workflow checkpoint, and gives you
files/diff/compose tooling around each one.

---

## Quick start (development)

```bash
pnpm install          # installs deps; postinstall rebuilds native modules for Electron
pnpm dev              # rebuilds native modules + starts electron-vite with hot reload
```

`pnpm dev` opens the app. Add a project (a git repo), expand it, and create a
session — see [How it works](#how-it-works).

**Requirements:** Node 20+ and `pnpm`. Agents you want to launch (`claude`,
`codex`, …) must be installed and on your `PATH`.

---

## Building & packaging

`electron-builder` produces installers per OS. Because the app links **native
modules** (`node-pty`, `better-sqlite3`), you must build **on each target OS**
(or in CI) — you can't cross-compile them locally.

```bash
pnpm build            # type-safe production bundle (main + preload + renderer)

pnpm package:mac      # → dist-packages/  (unpackaged .app; change the mac target to dmg/zip if you want an installer)
pnpm package:win      # NSIS installer
pnpm package:linux    # AppImage
pnpm package          # package for the host OS
```

The app icon is `build/icon.png` (macOS-squircle template; `build/icon-source.png`
is the original square art). electron-builder generates the platform icons from it.

### Native-module gotcha (important)

`node-pty` and `better-sqlite3` are compiled against a specific ABI:

- `pnpm dev` / `pnpm build` run `electron-rebuild` first → built for **Electron**. ✅
- `pnpm test` runs `pretest: pnpm rebuild better-sqlite3` → built for **Node** (so Vitest can load it). ❌ for Electron.

So **after running `pnpm test`, rebuild before launching the app**:

```bash
npx electron-rebuild -f -w node-pty,better-sqlite3
# or just run `pnpm dev` / `pnpm build`, which do it for you
```

---

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Rebuild native (Electron) + `electron-vite dev` with hot reload |
| `pnpm build` | Rebuild native (Electron) + production bundle to `out/` |
| `pnpm typecheck` | `tsc --noEmit` (strict) |
| `pnpm test` | Vitest (rebuilds `better-sqlite3` for Node first) |
| `pnpm package[:mac\|:win\|:linux]` | Build + electron-builder |

---

## How it works

### Projects & the rail
The left rail lists your projects (git repos). Expand one to see:
- **⌂ Repo root** (gold) — a workspace rooted at the repo itself: shells + files +
  diff, **no** agent/checkpoint tabs. Always available, even with no session.
- Its **work sessions**, each with its own worktree.

### Sessions = worktrees
Creating a session mints a git **worktree** at `<repo>/.worktrees/<slug>` on a new
branch (`feature/…` or `fix/…`), optionally copying `.env*` files into it
(recursively, for monorepos). A session can also reuse ignored `dist`/`generated`
output from the repo root and skip the configured setup command. That fast path
only runs when the root is clean and both checkouts are at the same commit; it
uses filesystem copy-on-write clones when supported. The user should select it
only when the root output is current. Removing a session removes the worktree
(after confirmation). Everything the session's agents do happens inside that
worktree.

### The workflow (`wf`)
The app is built for the Biznex multi-session workflow. A session's tabs are the
three roles plus a Log:

- **Architect** (labelled **Diagnose** for a fix) — you brainstorm/plan (feature)
  or `wf fix <bug>` (fix). The architect writes the **spec + plan + checkpoint** and
  hands off — it does not implement.
- **Implementer / Reviewer** — **disabled until a checkpoint exists**. The app
  watches the worktree for a checkpoint matching the project's glob (default
  `docs/workflow/checkpoints/*-checkpoint.md`); the moment one appears, these tabs
  light up.
- **Log** — renders the checkpoint's `▶ NEXT` block (with a copy button).

Opening a role tab spawns the agent (`claude --resume …`, `codex …`, etc.) and
**pre-types** the matching `wf` command (e.g. `wf implement <checkpoint>`) without
submitting — you press Enter. Each tab shows a green "how to start" hint for its
state. When an agent quits, the tab drops to a usable shell instead of dying.

### Shells
`+` opens a plain shell in the worktree; the **⌂** button opens one in the **repo
root** (gold `ROOT` badge). Shells persist a bounded scrollback across restarts,
have clickable file paths, and accept **drag-and-drop** — drop a file/image onto a
terminal to insert its absolute path (so the agent can read it).

### Files, Diff & the Composer
- **Files** (right sidebar, toggle in the topbar): browse/open/edit any file.
  Markdown opens as a rendered preview + editor; a **Worktree ⇄ Repo root** toggle
  switches roots. A Refresh button re-scans for new files.
- **Diff**: the session's changes vs. the branch point (tracked + untracked),
  per-file, with 8 lines of context.
- **Composer** (per file / per diff): select lines → **Add** stages a GitHub-style
  `path#Lx-Ly` reference (not the code — the agent reads the file). Accumulate
  references + notes, then **Send** (paste into a chosen agent tab) or **Send &
  Run** (paste + Enter) — pick the target tab per send.

### Persistence
Per-user state lives in Electron's `userData`: the project registry
(`better-sqlite3`), `sessions.json`, `workspace-layout.json` (which tabs were open),
per-shell scrollback, and per-agent session ids (for `--resume`). Reopening the app
restores your open sessions and tabs.

---

## Architecture

electron-vite with the standard three-process split:

```
src/
├── main/        # Electron main: PTYs (node-pty), git worktrees, project registry
│   │            # (better-sqlite3), checkpoint watchers (chokidar), IPC handlers
│   ├── ipc/           # registerIpcHandlers / registerTerminalIpcHandlers
│   ├── projects/      # project registry, worktrees, diff, checkpoint watch, layout
│   └── terminals/     # pty manager, scrollback, agent session/uuid stores
├── preload/     # contextBridge: exposes the typed AgentCoordinatorApi to the renderer
├── renderer/    # React 18 UI (SessionView, SessionTerminal, FileTree, GitDiffView, Composer, …)
└── shared/      # IPC contract + workflow types shared by main/preload/renderer
```

- **Terminals**: `node-pty` processes rendered with `@xterm/xterm`. The renderer
  writes to a PTY via IPC; a bracketed-paste helper inserts multi-line text without
  submitting.
- **Contract**: `src/shared/ipc/contract.ts` is the single source of truth — channel
  names, the `AgentCoordinatorApi` interface, and payload types.
- **TypeScript strict** throughout; **Vitest** covers the main-process stores,
  registries, and workflow helpers.

Reference material from ADE may live under `reference-not-commit/` (git-ignored).
