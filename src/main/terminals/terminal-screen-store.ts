import { Terminal } from "@xterm/xterm";

export interface TerminalScreenSnapshot {
  cols: number;
  rows: number;
  alternateScreen: boolean;
  lines: string[];
  cursorX: number;
  cursorY: number;
}

export interface TerminalScreenStore {
  create(sessionId: string, dimensions: { cols: number; rows: number }): void;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, dimensions: { cols: number; rows: number }): void;
  snapshot(sessionId: string): Promise<TerminalScreenSnapshot | null>;
  remove(sessionId: string): void;
}

interface ScreenEntry {
  terminal: Terminal;
  pendingWrite: Promise<void>;
}

/**
 * Runner-owned terminal model used only to give a newly connected viewer an
 * accurate screen. It never sends data to the PTY; it consumes the same output
 * stream as every viewer, so browser refreshes cannot affect a running agent.
 */
export function createTerminalScreenStore(): TerminalScreenStore {
  const entries = new Map<string, ScreenEntry>();

  function entryFor(sessionId: string): ScreenEntry | null {
    return entries.get(sessionId) ?? null;
  }

  return {
    create(sessionId, { cols, rows }) {
      entries.get(sessionId)?.terminal.dispose();
      entries.set(sessionId, {
        terminal: new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: false }),
        pendingWrite: Promise.resolve(),
      });
    },

    write(sessionId, data) {
      const entry = entryFor(sessionId);
      if (!entry) return;
      entry.pendingWrite = entry.pendingWrite.then(
        () => new Promise<void>((resolve) => entry.terminal.write(data, resolve)),
      );
    },

    resize(sessionId, { cols, rows }) {
      const entry = entryFor(sessionId);
      if (!entry || cols <= 0 || rows <= 0) return;
      entry.terminal.resize(cols, rows);
    },

    async snapshot(sessionId) {
      const entry = entryFor(sessionId);
      if (!entry) return null;
      await entry.pendingWrite;
      const buffer = entry.terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < entry.terminal.rows; row += 1) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? "");
      }
      return {
        cols: entry.terminal.cols,
        rows: entry.terminal.rows,
        alternateScreen: buffer === entry.terminal.buffer.alternate,
        lines,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
      };
    },

    remove(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entries.delete(sessionId);
      entry.terminal.dispose();
    },
  };
}
