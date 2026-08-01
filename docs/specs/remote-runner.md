# Remote Coordinator runner

## Goal

Run projects, worktrees, agent CLIs, and PTYs on a private Linux host while
allowing the existing desktop UI and browser UI to control them over a private
network. Closing a client must never stop an active agent.

## Deployment shape

```text
Electron or browser client
        │ HTTPS + WebSocket (Tailscale-only)
        ▼
Coordinator runner             ← serves UI and owns state, watchers, and PTYs
        ├─ projects and worktrees
        ├─ agent CLIs and credentials
        └─ SQLite/session/scrollback state
```

The runner is a long-lived service. The UI is static and can be replaced with
the next runner deploy. This milestone guarantees persistence across browser
and desktop-client disconnects. A future PTY broker will let the runner itself
restart without ending an agent process.

## Scope and security for the first remote milestone

- One trusted operator per runner host.
- The service binds to loopback; Tailscale Serve exposes it only to the
  tailnet. Funnel and public HTTP are out of scope.
- The runner has a dedicated OS user and state directory. Agent credential
  homes (`.codex`, `.claude`, etc.) are never sent to clients.
- Tailscale restricts network reachability. The Coordinator API also requires
  an explicit bearer token so VPN membership alone is not application auth.
- The remote host must be Linux. Electron local mode remains supported and
  unchanged.

## Transport boundary

Domain handlers use `IpcTransport` as the compatibility seam:

- Electron adapts `ipcMain` to `IpcTransport` for local mode.
- The runner registers the exact same handlers in an in-memory registry.
- The WebSocket gateway turns RPC frames into registry invocations and relays
  terminal/checkpoint events back to subscribers.

This keeps project/session/worktree logic in one place and prevents the web
implementation from becoming a second Coordinator.

## Upgrade rules

1. Back up the runner state and use additive database migrations.
2. Updating a browser or desktop client is safe: it reconnects to the unchanged
   runner and reattaches its persisted terminals.
3. A runner update currently stops its child PTYs. Drain or finish active agent
   work first; do not restart the runner merely to update the UI.
4. Never use a container replacement that owns child PTYs as the normal deploy
   path: that would kill active agents.

The first browser client deliberately does not upload a dropped local file or
open the runner's file manager on the client machine. Put files in the runner
workspace first; project paths and worktrees always belong to the runner.

## First deployment / test

The runner needs Node/Electron build dependencies, Git, the selected agent CLIs
and Tailscale installed for the dedicated OS user. Authenticate each agent as
that same user before starting the service (for example, run Codex device-login
there; the browser used for OAuth can remain on your Mac).

1. Build the checked-out source on the runner with `pnpm build`.
2. Create a private environment file (mode `600`) outside the repository:

   ```dotenv
   AGENT_COORDINATOR_STATE_DIR=/srv/agent-coordinator/state
   AGENT_COORDINATOR_REMOTE_HOST=127.0.0.1
   AGENT_COORDINATOR_REMOTE_PORT=4765
   AGENT_COORDINATOR_REMOTE_TOKEN=<random application token>
   AGENT_COORDINATOR_DATA_KEY=<base64 32-byte key>
   ```

   Generate the two secrets once with `openssl rand -base64 32`. The data key
   encrypts VCS tokens with AES-256-GCM; do not rotate it without migrating the
   encrypted token file.
3. Start `pnpm remote:runner` with that environment. It serves a health check
   at `http://127.0.0.1:4765/health`, the browser UI at `/`, and private RPC at
   `/rpc`.
4. Publish only that loopback HTTP service inside the tailnet:

   ```sh
   tailscale serve --https=443 http://127.0.0.1:4765
   ```

   Do not use Funnel. Open the resulting `https://<machine>.<tailnet>.ts.net/`
   URL on a device in the tailnet, enter the application token, and add a
   project using a path that exists on the runner (for example `/srv/projects/x`).
   Tailscale Serve handles HTTPS and WebSocket proxying on the same endpoint.

`deploy/agent-coordinator-runner.service` is a systemd user-service template
for keeping the runner alive. Copy it to `~/.config/systemd/user/`, update its
two paths, then use `systemctl --user enable --now agent-coordinator-runner`.
