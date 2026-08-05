// `@xterm/xterm` is published as CommonJS.  Electron can consume its named
// export directly, but the standalone Node runner cannot when Vite leaves the
// dependency external.  Use the CommonJS default interop path so both hosts
// load the same terminal model.
import xterm from "@xterm/xterm";
import type { Terminal as XtermTerminal } from "@xterm/xterm";

const { Terminal } = xterm;

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
  terminal: XtermTerminal;
  /** Whether chunks have been queued since the last drain, so an idle terminal
   *  can snapshot without waiting on xterm's write queue at all. */
  pendingChunks: boolean;
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
        pendingChunks: false,
      });
    },

    /**
     * Hand the chunk straight to xterm's own write queue, which already batches
     * and preserves order. Awaiting a promise per chunk instead — as this did —
     * forced one event-loop turn per PTY chunk, and a streaming agent emits
     * tens of thousands of them: 20k chunks cost 23s that way versus 13ms this
     * way, and that stall is on the runner's event loop, so it delayed every
     * client's terminal stream too.
     */
    write(sessionId, data) {
      const entry = entryFor(sessionId);
      if (!entry) return;
      entry.pendingChunks = true;
      entry.terminal.write(data);
    },

    resize(sessionId, { cols, rows }) {
      const entry = entryFor(sessionId);
      if (!entry || cols <= 0 || rows <= 0) return;
      entry.terminal.resize(cols, rows);
    },

    async snapshot(sessionId) {
      const entry = entryFor(sessionId);
      if (!entry) return null;
      // An empty write's callback fires once everything queued before it has
      // been parsed, so a snapshot still sees every prior chunk — one promise
      // per snapshot (rare) instead of one per chunk (constant). An idle
      // terminal has nothing to drain and must not wait on the queue at all:
      // the very first snapshot of a silent PTY happens before any output.
      if (entry.pendingChunks) {
        // Cleared BEFORE awaiting so a chunk arriving mid-drain re-arms it.
        entry.pendingChunks = false;
        await new Promise<void>((resolve) => entry.terminal.write("", resolve));
      }
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
