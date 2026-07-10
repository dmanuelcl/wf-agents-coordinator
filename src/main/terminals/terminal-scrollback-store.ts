import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Hard caps so an active/noisy terminal can never balloon memory or disk. Only
// the TAIL is kept — a terminal that prints gigabytes still costs ≤ MAX_BYTES.
const MAX_BYTES = 256 * 1024;
const FLUSH_DELAY_MS = 3000;

export interface TerminalScrollbackStore {
  record(key: string, chunk: string): void;
  read(key: string): Promise<string>;
  clear(key: string): Promise<void>;
  flush(): Promise<void>;
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Alternate-screen toggles used by full-screen TUIs (claude, vim, …). Whatever
// is drawn there is transient redraw noise, not the user's shell history — and
// it's huge. Skip recording it so the buffer keeps the real work and stays
// small (also avoids restoring stale mouse-tracking modes).
const ALT_SCREEN_TOGGLE = /\x1b\[\?(?:1049|1047|47)([hl])/g;

function stripAltScreen(chunk: string, inAlt: boolean): { text: string; inAlt: boolean } {
  let text = "";
  let cursor = 0;
  let alt = inAlt;
  ALT_SCREEN_TOGGLE.lastIndex = 0;
  for (let match = ALT_SCREEN_TOGGLE.exec(chunk); match !== null; match = ALT_SCREEN_TOGGLE.exec(chunk)) {
    if (!alt) text += chunk.slice(cursor, match.index);
    alt = match[1] === "h";
    cursor = ALT_SCREEN_TOGGLE.lastIndex;
  }
  if (!alt) text += chunk.slice(cursor);
  return { text, inAlt: alt };
}

// Keep only the last MAX_BYTES, trimmed to the next line boundary so a replayed
// buffer never starts mid-escape-sequence (which would render as garbage).
function capTail(text: string): string {
  if (text.length <= MAX_BYTES) return text;
  const tail = text.slice(text.length - MAX_BYTES);
  const newline = tail.indexOf("\n");
  return newline === -1 ? tail : tail.slice(newline + 1);
}

/**
 * Bounded, throttled persistence of terminal scrollback so a shell tab can show
 * the user's previous work after a restart. In-memory buffers are capped to the
 * tail; writes to disk are debounced (never per-byte). The live process is NOT
 * kept alive — this is visual restore only.
 */
export function createTerminalScrollbackStore(params: { dir: string }): TerminalScrollbackStore {
  const { dir } = params;
  const buffers = new Map<string, string>();
  const altState = new Map<string, boolean>();
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (dirty.size === 0) return;
    const keys = Array.from(dirty);
    dirty.clear();
    await mkdir(dir, { recursive: true });
    await Promise.all(
      keys.map(async (key) => {
        const buf = buffers.get(key);
        if (buf === undefined) return;
        try {
          await writeFile(join(dir, `${sanitize(key)}.log`), buf, "utf8");
        } catch {
          dirty.add(key); // retry on the next flush
        }
      }),
    );
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }

  return {
    record(key, chunk) {
      const { text, inAlt } = stripAltScreen(chunk, altState.get(key) ?? false);
      altState.set(key, inAlt);
      if (text.length === 0) return; // wholly inside an alt-screen TUI — skip
      const next = capTail((buffers.get(key) ?? "") + text);
      buffers.set(key, next);
      dirty.add(key);
      scheduleFlush();
    },

    async read(key) {
      const inMemory = buffers.get(key);
      if (inMemory !== undefined) return inMemory;
      try {
        const text = await readFile(join(dir, `${sanitize(key)}.log`), "utf8");
        buffers.set(key, text);
        return text;
      } catch {
        return "";
      }
    },

    async clear(key) {
      buffers.delete(key);
      altState.delete(key);
      dirty.delete(key);
      try {
        await rm(join(dir, `${sanitize(key)}.log`));
      } catch {
        // already gone
      }
    },

    flush,
  };
}
