import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ILink } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import type {
  SessionAgentRole,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalScreenSnapshot,
  WorkSession,
} from "../../shared/ipc/contract";

// File-path-ish tokens in terminal output: optional dir prefix, a filename with
// an extension, and an optional :line[:col] suffix. A token that isn't a real
// file just no-ops on click, so occasional false positives are harmless.
const FILE_PATH_RE = /(?:[~.]{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][\w]{0,7}(?::\d+(?::\d+)?)?/g;

function restoreRunnerScreen(term: Terminal, snapshot: TerminalScreenSnapshot): void {
  term.resize(snapshot.cols, snapshot.rows);
  const mode = snapshot.alternateScreen ? "\x1b[?1049h" : "\x1b[?1049l";
  const rows = snapshot.lines
    .map((line, index) => `\x1b[${index + 1};1H${line}`)
    .join("");
  term.write(`${mode}\x1b[2J\x1b[H${rows}\x1b[${snapshot.cursorY + 1};${snapshot.cursorX + 1}H`);
}

export interface SessionTerminalProps {
  session: WorkSession;
  role: SessionAgentRole | "shell" | "setup";
  // When set, the terminal restores + persists bounded scrollback (shell tabs).
  persistKey?: string;
  // Called when a file path in the output is clicked (host decides how to open).
  onOpenPath?: (token: string) => void;
  // A one-line "how to start" hint for this tab's initial state. Backtick-wrapped
  // segments render as inline code. Dismissible.
  hint?: string;
  // Shell tabs only: run in this directory instead of the session worktree
  // (e.g. the main repo root).
  cwdOverride?: string;
}

// Bounded so the renderer's memory stays in check even for a busy session.
const XTERM_SCROLLBACK = 3000;

// A restored recording may have been left mid-TUI (claude etc.), leaving the
// xterm in alternate-screen / mouse-tracking / bracketed-paste mode. Replaying
// it re-applies those modes, so mouse moves then spew `^[[<…M` reports into the
// fresh shell. Reset the modes after replay so the shell starts clean. (No RIS /
// screen-clear — that would erase the restored history.)
const TUI_MODE_RESET =
  "\x1b[?1049l" + // exit alternate screen (restores the main buffer)
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l" + // all mouse tracking off
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?25h" + // show cursor
  "\x1b[0m"; // reset text attributes

/**
 * Display/input surface for one runner-owned terminal. It attaches to a PTY,
 * renders its stream and forwards keyboard input; it never creates, replaces,
 * resizes, or decides how an agent starts.
 */
export interface SessionTerminalHandle {
  // Insert text into the terminal's input as a bracketed paste (multi-line safe).
  // `execute` appends a carriage return so a shell runs it immediately; agents
  // get the paste WITHOUT it so the user refines a prompt and presses Enter.
  // No-ops until the PTY exists.
  sendText: (text: string, execute: boolean) => void;
}

export const SessionTerminal = forwardRef<SessionTerminalHandle, SessionTerminalProps>(
  function SessionTerminal(props, ref): JSX.Element {
  const {
    session,
    role,
    persistKey,
    onOpenPath,
    hint,
    cwdOverride,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hintDismissed, setHintDismissed] = useState(false);
  // Mirrors the effect-local `ptyId` so the imperative handle can reach the live
  // PTY (which is reassigned on fall-back-to-shell).
  const ptyIdRef = useRef<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Drag a file/image from Finder onto the terminal → insert its absolute path
  // (bracketed paste, no Enter) so the agent can read it. Quotes paths with
  // spaces; several files become space-separated paths.
  function handleDrop(event: ReactDragEvent): void {
    event.preventDefault();
    setDragOver(false);
    if (window.agentCoordinator.connection.mode === "remote") {
      setWarnings((current) => [...current, "Put local files on the runner before attaching them to a remote terminal."]);
      return;
    }
    const id = ptyIdRef.current;
    if (!id) return;
    const paths = Array.from(event.dataTransfer?.files ?? [])
      .map((file) => window.agentCoordinator.system.getPathForFile(file))
      .filter(Boolean)
      .map((path) => (/\s/.test(path) ? `"${path}"` : path));
    if (paths.length === 0) return;
    window.agentCoordinator.terminal.write(id, `\x1b[200~${paths.join(" ")} \x1b[201~`);
  }

  function handleDragOver(event: ReactDragEvent): void {
    if (window.agentCoordinator.connection.mode === "remote") return;
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      setDragOver(true);
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      sendText: (text: string, execute: boolean) => {
        const id = ptyIdRef.current;
        if (!id) return;
        const trimmed = text.replace(/\s+$/, "");
        if (!trimmed) return;
        const payload = `\x1b[200~${trimmed}\x1b[201~` + (execute ? "\r" : "");
        window.agentCoordinator.terminal.write(id, payload);
      },
    }),
    [],
  );

  // The xterm link provider is registered once, so its activate closure would
  // capture a stale onOpenPath (and stale open-tabs). Route through a ref that
  // always points at the latest handler.
  const onOpenPathRef = useRef(onOpenPath);
  useEffect(() => {
    onOpenPathRef.current = onOpenPath;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminalContainer = container;

    const term = new Terminal({
      convertEol: true,
      scrollback: XTERM_SCROLLBACK,
      fontSize: 12,
      // A little leading prevents glyph ascenders/descenders from being
      // raster-clipped when a fixed runner grid is scaled for a large display.
      lineHeight: 1.1,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      theme: {
        background: "#151110",
        foreground: "#eae8e6",
        cursor: "#eae8e6",
        cursorAccent: "#151110",
        selectionBackground: "rgba(234, 232, 230, 0.22)",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);

    let ptyId: string | null = null;
    let disposed = false;
    let shellCwd = cwdOverride ?? session.worktreePath;
    const disposables: Array<() => void> = [];
    let runnerOwnedGeometry = false;
    let resizeAnimationFrame: number | null = null;

    function fitRunnerDisplay(): void {
      // Keep the terminal's logical grid equal to the runner PTY, but scale
      // the local glyphs to the available pane. This is presentation only:
      // it cannot make a second browser (or an F5) resize a full-screen TUI.
      const proposed = fitAddon.proposeDimensions();
      if (!proposed || term.cols === 0 || term.rows === 0) return;
      const currentFontSize = term.options.fontSize ?? 12;
      const scale = Math.min(proposed.cols / term.cols, proposed.rows / term.rows);
      // Leave a small visual margin rather than making a 16" client stretch
      // the runner's fixed grid edge-to-edge with oversized glyphs.
      const nextFontSize = Math.max(8, Math.min(22, currentFontSize * scale * 0.9));
      if (Math.abs(nextFontSize - currentFontSize) >= 0.1) {
        term.options.fontSize = nextFontSize;
      }
    }

    function fitAndResizeLiveTerminal(): void {
      // Do not let a hidden keep-alive tab report its zero-size box to the
      // remote PTY. It would make a full-screen TUI permanently adopt a tiny
      // geometry until the next real resize.
      if (terminalContainer.clientWidth === 0 || terminalContainer.clientHeight === 0) return;
      // A remote PTY has one runner-owned geometry. Fitting a fresh browser
      // view must never resize that PTY (or a full-screen agent inside it).
      if (runnerOwnedGeometry) {
        fitRunnerDisplay();
        return;
      }
      fitAddon.fit();
    }

    function scheduleFitAndResize(): void {
      if (resizeAnimationFrame !== null) return;
      resizeAnimationFrame = requestAnimationFrame(() => {
        resizeAnimationFrame = null;
        fitAndResizeLiveTerminal();
      });
    }

    // Clickable file paths: clicking a path the agent printed opens it in the OS
    // default app (resolved against the terminal's cwd in the main process).
    const linkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: ILink[] = [];
        FILE_PATH_RE.lastIndex = 0;
        for (let match = FILE_PATH_RE.exec(text); match !== null; match = FILE_PATH_RE.exec(text)) {
          const token = match[0];
          const startX = match.index + 1;
          links.push({
            text: token,
            range: {
              start: { x: startX, y: bufferLineNumber },
              end: { x: startX + token.length - 1, y: bufferLineNumber },
            },
            activate: () => {
              const openHandler = onOpenPathRef.current;
              if (openHandler) {
                openHandler(token);
              } else {
                void window.agentCoordinator.system.openPath(token, shellCwd);
              }
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });
    disposables.push(() => linkProvider.dispose());

    async function start(): Promise<void> {
      const pendingData: TerminalDataEvent[] = [];
      const pendingExits: TerminalExitEvent[] = [];

      const handleData = (event: TerminalDataEvent): void => {
        if (!ptyId) {
          pendingData.push(event);
          return;
        }
        if (event.sessionId !== ptyId) return;
        term.write(event.data);
      }

      const handleExit = (event: TerminalExitEvent): void => {
        if (!ptyId) {
          pendingExits.push(event);
          return;
        }
        if (event.sessionId !== ptyId) return;
        setExitCode(event.code);
      };

      const unsubscribeData = window.agentCoordinator.terminal.onData(handleData);
      const unsubscribeExit = window.agentCoordinator.terminal.onExit(handleExit);
      disposables.push(unsubscribeData, unsubscribeExit);

      // Register input before any reconnect early-return. An attached terminal
      // is live, so the reloaded view must be able to type into it immediately.
      const onDataDisposable = term.onData((data) => {
        if (ptyId) window.agentCoordinator.terminal.write(ptyId, data);
      });
      disposables.push(() => onDataDisposable.dispose());

      if (persistKey) {
        // Reloading must first look for the existing PTY. Apart from avoiding
        // a duplicate process, this also prevents the role-launch resolver
        // from allocating/replacing a provider session just to reattach.
        const attached = persistKey
          ? await window.agentCoordinator.terminal.attach(persistKey)
          : null;
        if (disposed) return;
        if (attached) {
          ptyId = attached.sessionId;
          ptyIdRef.current = attached.sessionId;
          const proposed = fitAddon.proposeDimensions();
          let runnerSnapshot: TerminalScreenSnapshot | null = null;
          if (proposed) {
            // A runner from before this protocol can still be viewed; it just
            // keeps its existing grid instead of failing the whole attach.
            runnerSnapshot = await window.agentCoordinator.terminal
              .claimInitialGeometry(attached.sessionId, proposed.cols, proposed.rows)
              .catch(() => null);
          }
          if (disposed) return;
          if (runnerSnapshot ?? attached.snapshot) {
            // The runner owns a headless terminal model of this PTY. Hydrate
            // the new view from it. The server may accept the *first* view's
            // initial drawing bounds, but no later reload/view can resize it.
            runnerOwnedGeometry = true;
            restoreRunnerScreen(term, runnerSnapshot ?? attached.snapshot!);
            scheduleFitAndResize();
          } else if (!attached.alternateScreen) {
            const saved = await window.agentCoordinator.terminal.readScrollback(persistKey);
            if (disposed) return;
            if (saved) term.write(saved);
          }
          for (const event of pendingData.splice(0)) handleData(event);
          for (const event of pendingExits.splice(0)) handleExit(event);
          return;
        }

        // The runner has no live PTY for this key. This is a genuine fresh
        // launch (for example after the runner itself restarted), so restore
        // only visual history and clear any stale TUI modes before launching.
        const saved = await window.agentCoordinator.terminal.readScrollback(persistKey);
        if (disposed) return;
        if (saved) {
          term.write(saved);
          term.write(TUI_MODE_RESET);
          term.write("\r\n\x1b[2m—— restored ——\x1b[0m\r\n");
        }
      }

      // The runner is the only component allowed to create/restart a PTY or
      // choose an agent command. A view that cannot attach has nothing to
      // launch; it merely reports the runner state to the user.
      setWarnings((current) =>
        current.includes("This terminal is not currently running on the runner.")
          ? current
          : [...current, "This terminal is not currently running on the runner."],
      );

    }

    // Obtain an accurate initial geometry for a visible tab before any new
    // shell/agent is created. Hidden tabs retain xterm's safe default until
    // their ResizeObserver sees a real box.
    fitAndResizeLiveTerminal();

    void start().catch((error: unknown) => {
      if (!disposed) {
        const reason = String(error);
        setWarnings((current) => [...current, reason]);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAndResizeLiveTerminal();
    });
    resizeObserver.observe(terminalContainer);
    scheduleFitAndResize();

    return () => {
      disposed = true;
      if (resizeAnimationFrame !== null) cancelAnimationFrame(resizeAnimationFrame);
      resizeObserver.disconnect();
      disposables.forEach((dispose) => dispose());
      ptyIdRef.current = null;
      term.dispose();
    };
  }, [session.id, session.worktreePath, role, cwdOverride]);

  return (
    <div
      className={`terminal-pane${dragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {warnings.length > 0 && (
        <div className="terminal-pane-warnings">
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      )}
      {hint && !hintDismissed && (
        <div className="terminal-hint">
          <svg
            className="terminal-hint-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
          </svg>
          <span className="terminal-hint-text">
            {hint.split("`").map((segment, index) =>
              index % 2 === 1 ? <code key={index}>{segment}</code> : <span key={index}>{segment}</span>,
            )}
          </span>
          <button
            type="button"
            className="terminal-hint-close"
            aria-label="Dismiss hint"
            onClick={() => setHintDismissed(true)}
          >
            ×
          </button>
        </div>
      )}
      <div ref={containerRef} className="terminal-pane-surface" />
      {dragOver && <div className="terminal-pane-drop">Drop to attach the file path</div>}
      {exitCode !== null && <div className="terminal-pane-exited">Process exited (code {exitCode})</div>}
    </div>
  );
});
