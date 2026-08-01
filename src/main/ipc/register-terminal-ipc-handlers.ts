import { IPC_CHANNELS, TERMINAL_IPC_CHANNELS } from "../../shared/ipc/contract";
import type { TerminalScreenSnapshot } from "../../shared/ipc/contract";
import { resolveShell, resolveShellForCommand } from "../terminals/shell-resolver";
import type { PtySessionManager } from "../terminals/pty-session-manager";
import type { ProjectSessionState, SessionStateStore } from "../terminals/session-state-store";
import type { TerminalScrollbackStore } from "../terminals/terminal-scrollback-store";
import type { TerminalScreenStore } from "../terminals/terminal-screen-store";
import type { IpcTransport } from "./ipc-transport";

export function registerTerminalIpcHandlers(params: {
  ptySessionManager: PtySessionManager;
  sessionStateStore: SessionStateStore;
  scrollbackStore: TerminalScrollbackStore;
  screenStore: TerminalScreenStore;
  transport: IpcTransport;
  broadcast(channel: string, payload: unknown): void;
  onSetupExit?: (params: { sessionId: string; code: number }) => Promise<void>;
}): void {
  const { ptySessionManager, sessionStateStore, scrollbackStore, screenStore, transport, broadcast, onSetupExit } = params;
  const ipc = transport;
  const terminalByPersistKey = new Map<string, string>();

  async function attachPersistentTerminal(persistKey: string): Promise<{
    sessionId: string;
    reused: true;
    alternateScreen?: true;
    snapshot?: TerminalScreenSnapshot;
  } | null> {
    const existingSessionId = terminalByPersistKey.get(persistKey);
    if (!existingSessionId) return null;
    if (!ptySessionManager.has(existingSessionId)) {
      terminalByPersistKey.delete(persistKey);
      return null;
    }
    const snapshot = await screenStore.snapshot(existingSessionId);
    return {
      sessionId: existingSessionId,
      reused: true,
      ...(scrollbackStore.isInAlternateScreen(persistKey) ? { alternateScreen: true as const } : {}),
      ...(snapshot ? { snapshot } : {}),
    };
  }

  ipc.handle(
    TERMINAL_IPC_CHANNELS.create,
    async (
      _event,
      input: {
        cwd: string;
        cols: number;
        rows: number;
        launchCommand?: string | null;
        environment?: Record<string, string>;
        persistKey?: string | null;
        setupSessionId?: string | null;
      },
    ) => {
    const persistKey = input.persistKey ?? null;
    const attached = persistKey ? await attachPersistentTerminal(persistKey) : null;
    if (attached) {
      // This is a read-only lookup. The runner broadcasts the PTY stream to
      // every authenticated client; no browser owns or mutates the terminal
      // merely by opening/reloading a view.
      return attached;
    }

    const shell = input.launchCommand
      ? resolveShellForCommand({ platform: process.platform, env: process.env, command: input.launchCommand })
      : resolveShell({ platform: process.platform, env: process.env });
    // A previous PTY may have died while a full-screen TUI was active. Its
    // replacement (agent fallback shell, fresh run) starts in the normal
    // screen, so do not carry that stale state across processes.
    if (persistKey) scrollbackStore.resetAlternateScreen(persistKey);
    const sessionId = ptySessionManager.create({
      cwd: input.cwd,
      shell,
      cols: input.cols,
      rows: input.rows,
      environment: input.environment,
    });

    if (persistKey) terminalByPersistKey.set(persistKey, sessionId);
    screenStore.create(sessionId, { cols: input.cols, rows: input.rows });
    ptySessionManager.onData(sessionId, (data) => {
      // Bounded scrollback capture (opt-in per terminal) before forwarding.
      if (persistKey) scrollbackStore.record(persistKey, data);
      screenStore.write(sessionId, data);
      // PTY ownership belongs to the runner, not to the browser that created
      // it. Broadcast to all currently authenticated views so reconnecting or
      // second clients immediately receive the live stream.
      broadcast(TERMINAL_IPC_CHANNELS.data, { sessionId, data });
    });
    ptySessionManager.onExit(sessionId, (code) => {
      if (persistKey && terminalByPersistKey.get(persistKey) === sessionId) terminalByPersistKey.delete(persistKey);
      if (input.setupSessionId && onSetupExit) {
        void onSetupExit({ sessionId: input.setupSessionId, code }).catch((error: unknown) => {
          console.error(`Could not finalize setup for session ${input.setupSessionId}:`, error);
        });
      }
      screenStore.remove(sessionId);
      broadcast(TERMINAL_IPC_CHANNELS.exit, { sessionId, code });
    });

    return { sessionId, reused: false };
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.attach, (_event, persistKey: string) => attachPersistentTerminal(persistKey));

  ipc.on(TERMINAL_IPC_CHANNELS.write, (_event, sessionId: string, data: string) => {
    ptySessionManager.write(sessionId, data);
  });

  ipc.on(TERMINAL_IPC_CHANNELS.resize, (_event, sessionId: string, cols: number, rows: number) => {
    ptySessionManager.resize(sessionId, cols, rows);
    screenStore.resize(sessionId, { cols, rows });
  });

  ipc.on(TERMINAL_IPC_CHANNELS.kill, (_event, sessionId: string) => {
    ptySessionManager.kill(sessionId);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.readScrollback, async (_event, persistKey: string) => {
    return scrollbackStore.read(persistKey);
  });

  ipc.handle(TERMINAL_IPC_CHANNELS.clearScrollback, async (_event, persistKey: string) => {
    await scrollbackStore.clear(persistKey);
  });

  ipc.handle(IPC_CHANNELS.sessionStateGet, async (_event, projectId: string) => {
    return sessionStateStore.get(projectId);
  });

  ipc.handle(IPC_CHANNELS.sessionStateSet, async (_event, projectId: string, state: ProjectSessionState) => {
    await sessionStateStore.set(projectId, state);
  });
}
