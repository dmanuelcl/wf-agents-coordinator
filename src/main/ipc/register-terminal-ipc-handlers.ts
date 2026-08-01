import { IPC_CHANNELS, TERMINAL_IPC_CHANNELS } from "../../shared/ipc/contract";
import { resolveShell, resolveShellForCommand } from "../terminals/shell-resolver";
import type { PtySessionManager } from "../terminals/pty-session-manager";
import type { ProjectSessionState, SessionStateStore } from "../terminals/session-state-store";
import type { TerminalScrollbackStore } from "../terminals/terminal-scrollback-store";
import type { IpcTransport } from "./ipc-transport";

export function registerTerminalIpcHandlers(params: {
  ptySessionManager: PtySessionManager;
  sessionStateStore: SessionStateStore;
  scrollbackStore: TerminalScrollbackStore;
  transport: IpcTransport;
}): void {
  const { ptySessionManager, sessionStateStore, scrollbackStore, transport } = params;
  const ipc = transport;
  const terminalByPersistKey = new Map<string, string>();

  ipc.handle(
    TERMINAL_IPC_CHANNELS.create,
    (
      event,
      input: {
        cwd: string;
        cols: number;
        rows: number;
        launchCommand?: string | null;
        environment?: Record<string, string>;
        persistKey?: string | null;
      },
    ) => {
    const persistKey = input.persistKey ?? null;
    const existingSessionId = persistKey ? terminalByPersistKey.get(persistKey) : undefined;
    if (existingSessionId && ptySessionManager.has(existingSessionId)) {
      // The browser/desktop client was recreated, but the runner (and its PTY)
      // survived. Attach this sender to the live stream instead of launching a
      // second agent for the same persisted tab.
      ptySessionManager.onData(existingSessionId, (data) => {
        if (!event.sender.isDestroyed()) event.sender.send(TERMINAL_IPC_CHANNELS.data, { sessionId: existingSessionId, data });
      });
      ptySessionManager.onExit(existingSessionId, (code) => {
        if (!event.sender.isDestroyed()) event.sender.send(TERMINAL_IPC_CHANNELS.exit, { sessionId: existingSessionId, code });
      });
      return { sessionId: existingSessionId, reused: true };
    }

    const shell = input.launchCommand
      ? resolveShellForCommand({ platform: process.platform, env: process.env, command: input.launchCommand })
      : resolveShell({ platform: process.platform, env: process.env });
    const sessionId = ptySessionManager.create({
      cwd: input.cwd,
      shell,
      cols: input.cols,
      rows: input.rows,
      environment: input.environment,
    });

    if (persistKey) terminalByPersistKey.set(persistKey, sessionId);
    ptySessionManager.onData(sessionId, (data) => {
      // Bounded scrollback capture (opt-in per terminal) before forwarding.
      if (persistKey) scrollbackStore.record(persistKey, data);
      // A PTY can emit during shutdown, after the window's webContents is gone
      // ("Object has been destroyed"). Guard every send.
      if (event.sender.isDestroyed()) return;
      event.sender.send(TERMINAL_IPC_CHANNELS.data, { sessionId, data });
    });
    ptySessionManager.onExit(sessionId, (code) => {
      if (persistKey && terminalByPersistKey.get(persistKey) === sessionId) terminalByPersistKey.delete(persistKey);
      if (event.sender.isDestroyed()) return;
      event.sender.send(TERMINAL_IPC_CHANNELS.exit, { sessionId, code });
    });

    return { sessionId, reused: false };
  });

  ipc.on(TERMINAL_IPC_CHANNELS.write, (_event, sessionId: string, data: string) => {
    ptySessionManager.write(sessionId, data);
  });

  ipc.on(TERMINAL_IPC_CHANNELS.resize, (_event, sessionId: string, cols: number, rows: number) => {
    ptySessionManager.resize(sessionId, cols, rows);
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
