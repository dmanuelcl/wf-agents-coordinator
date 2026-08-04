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
Agents (Claude, Codex, Kimi, Gemini, Copilot, OpenCode) run as real terminal processes;
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
`codex`, `kimi`, …) must be installed and on your `PATH`.

### Agent CLIs

Every agent is a separate CLI **you install and authenticate yourself** — the app
only launches it, wires the per-stage flags, and (where supported) resumes its
session. None is privileged: choose a different agent per role (Architect /
Implementer / Reviewer) in a project's stage config. New stages default to
`claude` / `opus`.

| Agent | Executable | Default model | Effort | "Dangerous" maps to | Session resume |
| --- | --- | --- | --- | --- | --- |
| Claude | `claude` | `opus` | `low…max` → `--effort` | `--dangerously-skip-permissions` | ✅ app-minted id (`--session-id` / `--resume`) |
| Codex | `codex` | `gpt-5.5` | `none…xhigh` → `-c model_reasoning_effort` | `--ask-for-approval never --sandbox danger-full-access` | fresh (warns) |
| Kimi | `kimi` | `kimi-code/kimi-for-coding` | `low…max` → `KIMI_MODEL_THINKING_EFFORT` (env) | `--yolo` | ✅ CLI-minted id, captured → `--session` |
| Gemini | `gemini` | `gemini-2.5-pro` | — | `--yolo` | fresh (warns) |
| Copilot | `copilot` | — (no model flag) | — | `--allow-all` | fresh (warns) |
| OpenCode | `opencode` | `anthropic/claude-opus-4-8` | — | — | fresh (warns) |

Model fields are editable — most CLIs accept custom aliases, and clearing the
field lets the CLI fall back to its own default. Effort is only sent to agents
that document the flag and is ignored (with a warning) for the rest; it is always
applied per launch — Kimi through a scoped `KIMI_MODEL_THINKING_EFFORT`, so your
global config is untouched. An `agy` (Antigravity) runtime is also wired but
**unverified** — adjust its launcher once checked against the real binary.

**Session resume.** Only Claude and Kimi reopen the exact prior conversation.
Claude accepts an app-minted id; Kimi mints its own `session_<uuid>` on a fresh
launch, which the app captures and replays with `kimi --session <id>` (never
`--continue` — all roles share one worktree, so "most recent for this directory"
could resume the wrong agent). Every other agent relaunches fresh and warns.

**Install note (Kimi):** its TypeScript
[`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code) CLI (executable
`kimi`) is **not** the legacy Python `kimi-cli` package — install `kimi-code`
(`brew install kimi-code`, `npm i -g @moonshot-ai/kimi-code`, or the official
installer) and run `kimi` once to `/login`.

---

## Running it: local or remote

Same app, same UI, two topologies. Pick by where you want the repos and the
agents to live.

| | **Local** | **Remote** |
| --- | --- | --- |
| Runs | the Electron app on your machine | a headless Node **runner** on one machine + a client anywhere |
| Repos, worktrees, agent logins | on your machine | on the runner |
| Client | the app window | any browser, or the desktop app pointed at the runner |
| Survives closing the client | n/a | yes — terminals, agents and Auto Pilot keep running |
| Use it for | ordinary solo work | a big always-on box, or driving sessions from a laptop/iPad |

### Local

```bash
pnpm dev              # development, hot reload
pnpm package:mac      # or :win / :linux for an installable build
```

Everything stays on your machine. This is the default and needs no extra setup.

### Remote

The runner owns the repos, worktrees, PTYs and agent OAuth; the client only
draws the UI and sends your keystrokes. Reloading, closing a tab, or switching
devices never restarts setup, agents, tabs or Auto Pilot.

On the runner machine:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --ignore-scripts
pnpm remote:build                                  # builds native modules for Node, not Electron
set -a; source ~/.config/agent-coordinator/runner.env; set +a
pnpm remote:runner                                 # listens on 127.0.0.1:4765
```

It binds **loopback only** — no router port is opened. To reach it from another
device, put one of these in front:

- **Tailscale Serve** — a private HTTPS URL on your tailnet. Nothing is exposed
  to the Internet. Simplest, and the right default.
- **Cloudflare Tunnel** — serves it on **your own domain**
  (`https://coordinator.yourdomain.com`). This publishes to the public
  Internet, so put Cloudflare Access in front of it or treat the Coordinator
  token as the only thing guarding shells on that machine.

Then open the URL and enter the token, or point the desktop app at it:

```bash
AGENT_COORDINATOR_REMOTE_URL="wss://coordinator.yourdomain.com/rpc" \
AGENT_COORDINATOR_REMOTE_TOKEN="your-token" \
"/Applications/Agent Coordinator.app/Contents/MacOS/Agent Coordinator"
```

Browser and desktop can be connected to the same runner at once.

**[`deploy/README.md`](deploy/README.md)** has the full walkthrough: generating the
secrets, both proxies step by step, and keeping the runner alive across reboots
with `launchd` (macOS) or `systemd` (Linux).

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

### Starting from work that already exists
A feature/fix session can start somewhere other than a fresh branch — pick **Start from** in the
new-session dialog:

- **Continue** — check out an existing branch *writable*, to pick up a session a teammate started
  (or your own from another machine). The branch is fetched and fast-forwarded first; if it has
  diverged from its remote, or another session already holds it, creation stops and says so rather
  than starting on the wrong code.
- **Fork** — cut a new `feature/<slug>` branch from a base an architect published the specs and plan
  on (typically `develop`), starting from `origin/<base>` rather than from local commits.

Either way you can **adopt a checkpoint** committed on that branch: the picker reads it straight out
of the ref without checking it out, and the session is born past the gate — Implementer and Reviewer
unlocked, `wf implement <checkpoint>` pre-typed. The agent conversation is not resumed (those ids
live on the machine that created them); the checkpoint *is* the handoff.

A session also records the branch it started from, so **Diff** compares against that base instead of
always against `main`.

If the configured setup command fails, its terminal stays open as a repair shell
while agent tabs remain gated. After fixing the worktree there, use **Continue
with agents** to persist the setup as ready and resume the session's normal
agent/kickoff flow.

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
- **Log** — renders the checkpoint's `▶ NEXT` block (with a copy button), the
  latest **Plan de corrección** as a dedicated card, and reconciled open/closed
  finding counts across review and fix rounds.

Opening a role tab spawns the agent (`claude --resume …`, `kimi --session …`,
`codex …`, etc.) and
**pre-types** the matching `wf` command (e.g. `wf implement <checkpoint>`) without
submitting — you press Enter. Each tab shows a green "how to start" hint for its
state. When an agent quits, the tab drops to a usable shell instead of dying.

### Session kinds
The **New session** dialog offers four, and the kind decides which role tabs
exist and where the session starts:

| Kind | Tabs | Starts in | Worktree |
| --- | --- | --- | --- |
| **New feature** / **Bug fix** | Architect · Implementer · Reviewer | Architect (or Implementer if it adopts a checkpoint) | new branch, or an existing one — see *Starting from work that already exists* |
| **PR review** | Reviewer | Reviewer, auto-submitted | **detached** at the branch under review — read-only by construction |
| **PR fix** | Implementer · Reviewer (+ Architect when *Diagnose first*) | Implementer, or Architect when diagnosing first | **writable** checkout of the PR's source branch |

PR sessions can be created from a branch pair, or from a **PR link** once the
project has a VCS host and API token (**Bitbucket** and **GitHub**). From a link
the app resolves source/target, pulls the whole PR conversation into a gitignored
`.agent-pr-context.md`, and refuses to create a stale worktree if the checkout
does not land on the PR's head commit. A PR fix commits but never pushes — push
is a separate gated button.

### Auto Pilot
Per session, a conductor can drive the workflow without you pressing Enter: it
watches the checkpoint, waits for it to settle (default 4s), and launches the
next role's `wf` command itself. It stops on its own at a configurable re-loop
limit (default 3 reviewer→implementer rounds) so a disagreeing pair cannot spin
forever, and pauses with a reason instead of guessing whenever the checkpoint
does not say clearly what comes next. Both values are per-project settings.

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
per-shell scrollback, and per-agent session ids (for exact resume flags). Reopening the app
restores your open sessions and tabs.

---

## Architecture

electron-vite with the standard three-process split:

```
src/
├── main/        # Electron main: PTYs (node-pty), git worktrees, project registry
│   │            # (better-sqlite3), checkpoint watchers (chokidar), IPC handlers
│   ├── ipc/           # registerIpcHandlers / registerTerminalIpcHandlers
│   ├── projects/      # project registry, worktrees, start points, diff, checkpoint watch, layout
│   ├── terminals/     # pty manager, scrollback, agent session/uuid stores
│   ├── vcs/           # Bitbucket + GitHub providers, encrypted token store
│   ├── remote/        # headless runner: WebSocket server + CLI entry point
│   ├── runtime/       # the process-agnostic coordinator wiring both entry points share
│   └── platform/      # Electron-specific system integration behind an interface
├── preload/     # contextBridge: exposes the typed AgentCoordinatorApi to the renderer
├── renderer/    # React 18 UI (SessionView, SessionTerminal, FileTree, GitDiffView, Composer, …)
└── shared/      # IPC contract + workflow types shared by main/preload/renderer
```

The desktop app and the headless runner are the **same coordinator** with
different hosts: `runtime/coordinator-runtime.ts` owns sessions, terminals and
watchers, while Electron and the WebSocket server only supply transport and
system integration. That is why a browser client can attach to a session the
desktop app started, and why reloading a client restarts nothing.

- **Terminals**: `node-pty` processes rendered with `@xterm/xterm`. The renderer
  writes to a PTY via IPC; a bracketed-paste helper inserts multi-line text without
  submitting.
- **Contract**: `src/shared/ipc/contract.ts` is the single source of truth — channel
  names, the `AgentCoordinatorApi` interface, and payload types.
- **TypeScript strict** throughout; **Vitest** covers the main-process stores,
  registries, and workflow helpers.

Reference material from ADE may live under `reference-not-commit/` (git-ignored).
