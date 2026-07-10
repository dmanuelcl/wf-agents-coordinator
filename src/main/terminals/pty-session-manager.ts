import type { ShellSpec } from "./shell-resolver";

export interface PtySpawn {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (params: { cwd: string; shell: ShellSpec; cols: number; rows: number }) => PtySpawn;

export interface PtySessionManager {
  create(params: { cwd: string; shell: ShellSpec; cols: number; rows: number }): string;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  /** Kill every live PTY. Called on app quit so no agent process is orphaned. */
  killAll(): void;
  onData(sessionId: string, cb: (data: string) => void): void;
  onExit(sessionId: string, cb: (code: number) => void): void;
}

export function createPtySessionManager(params: { spawnPty: SpawnPty }): PtySessionManager {
  const { spawnPty } = params;
  const sessions = new Map<string, PtySpawn>();
  const exitCallbacks = new Map<string, Set<(code: number) => void>>();
  let nextId = 1;

  function requireSession(sessionId: string, action: string): PtySpawn | null {
    const session = sessions.get(sessionId);
    if (!session) {
      console.warn(`pty-session-manager: cannot ${action}, unknown session "${sessionId}"`);
      return null;
    }
    return session;
  }

  function create(createParams: { cwd: string; shell: ShellSpec; cols: number; rows: number }): string {
    const sessionId = String(nextId++);
    const session = spawnPty(createParams);
    sessions.set(sessionId, session);

    session.onExit((e) => {
      sessions.delete(sessionId);
      const callbacks = exitCallbacks.get(sessionId);
      exitCallbacks.delete(sessionId);
      if (callbacks) {
        for (const cb of callbacks) {
          cb(e.exitCode);
        }
      }
    });

    return sessionId;
  }

  function write(sessionId: string, data: string): void {
    requireSession(sessionId, "write")?.write(data);
  }

  function resize(sessionId: string, cols: number, rows: number): void {
    requireSession(sessionId, "resize")?.resize(cols, rows);
  }

  function kill(sessionId: string): void {
    const session = requireSession(sessionId, "kill");
    if (!session) return;
    session.kill();
    sessions.delete(sessionId);
  }

  function killAll(): void {
    for (const session of sessions.values()) {
      session.kill();
    }
    sessions.clear();
  }

  function onData(sessionId: string, cb: (data: string) => void): void {
    requireSession(sessionId, "onData")?.onData(cb);
  }

  function onExit(sessionId: string, cb: (code: number) => void): void {
    let callbacks = exitCallbacks.get(sessionId);
    if (!callbacks) {
      callbacks = new Set();
      exitCallbacks.set(sessionId, callbacks);
    }
    callbacks.add(cb);
  }

  return { create, write, resize, kill, killAll, onData, onExit };
}
