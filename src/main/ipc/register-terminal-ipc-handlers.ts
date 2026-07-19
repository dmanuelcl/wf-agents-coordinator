import { ipcMain } from "electron";
import { IPC_CHANNELS, TERMINAL_IPC_CHANNELS } from "../../shared/ipc/contract";
import { resolveShell, resolveShellForCommand } from "../terminals/shell-resolver";
import type { PtySessionManager } from "../terminals/pty-session-manager";
import type { ProjectSessionState, SessionStateStore } from "../terminals/session-state-store";
import type { TerminalScrollbackStore } from "../terminals/terminal-scrollback-store";

export function registerTerminalIpcHandlers(params: {
  ptySessionManager: PtySessionManager;
  sessionStateStore: SessionStateStore;
  scrollbackStore: TerminalScrollbackStore;
}): void {
  const { ptySessionManager, sessionStateStore, scrollbackStore } = params;

  ipcMain.handle(
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

    const persistKey = input.persistKey ?? null;
    ptySessionManager.onData(sessionId, (data) => {
      // Bounded scrollback capture (opt-in per terminal) before forwarding.
      if (persistKey) scrollbackStore.record(persistKey, data);
      // A PTY can emit during shutdown, after the window's webContents is gone
      // ("Object has been destroyed"). Guard every send.
      if (event.sender.isDestroyed()) return;
      event.sender.send(TERMINAL_IPC_CHANNELS.data, { sessionId, data });
    });
    ptySessionManager.onExit(sessionId, (code) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(TERMINAL_IPC_CHANNELS.exit, { sessionId, code });
    });

    return sessionId;
  });

  ipcMain.on(TERMINAL_IPC_CHANNELS.write, (_event, sessionId: string, data: string) => {
    ptySessionManager.write(sessionId, data);
  });

  ipcMain.on(TERMINAL_IPC_CHANNELS.resize, (_event, sessionId: string, cols: number, rows: number) => {
    ptySessionManager.resize(sessionId, cols, rows);
  });

  ipcMain.on(TERMINAL_IPC_CHANNELS.kill, (_event, sessionId: string) => {
    ptySessionManager.kill(sessionId);
  });

  ipcMain.handle(TERMINAL_IPC_CHANNELS.readScrollback, async (_event, persistKey: string) => {
    return scrollbackStore.read(persistKey);
  });

  ipcMain.handle(TERMINAL_IPC_CHANNELS.clearScrollback, async (_event, persistKey: string) => {
    await scrollbackStore.clear(persistKey);
  });

  ipcMain.handle(IPC_CHANNELS.sessionStateGet, async (_event, projectId: string) => {
    return sessionStateStore.get(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.sessionStateSet, async (_event, projectId: string, state: ProjectSessionState) => {
    await sessionStateStore.set(projectId, state);
  });
}
