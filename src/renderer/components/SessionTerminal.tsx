import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ILink } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import type { AgentLaunchMode, SessionAgentRole, WorkSession } from "../../shared/ipc/contract";

// File-path-ish tokens in terminal output: optional dir prefix, a filename with
// an extension, and an optional :line[:col] suffix. A token that isn't a real
// file just no-ops on click, so occasional false positives are harmless.
const FILE_PATH_RE = /(?:[~.]{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][\w]{0,7}(?::\d+(?::\d+)?)?/g;

// How long to wait after the agent's first output before sending follow-up
// input, so its input box has rendered. Heuristic — the real timing can only be
// confirmed on-device against each agent CLI.
const SETTLE_MS = 600;

export interface SessionTerminalProps {
  session: WorkSession;
  role: SessionAgentRole | "shell";
  mode: AgentLaunchMode;
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
  // When true, a fresh agent launch AUTO-SUBMITS its wf command (conductor-driven)
  // instead of only pre-typing it for the user to press Enter.
  autoSubmitWf?: boolean;
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
 * One agent (or plain shell) terminal for a session tab. For an agent role it
 * asks the main process how to launch — `claude --session-id <uuid> …` plus the
 * `wf <verb> <checkpoint>` message — spawns the agent as the PTY process, and
 * then PRE-TYPES the wf command WITHOUT a trailing newline so the user presses
 * Enter. The `shell` role is just a plain terminal in the worktree, no agent.
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
  const { session, role, mode, persistKey, onOpenPath, hint, cwdOverride, autoSubmitWf } = props;
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

    const term = new Terminal({
      convertEol: true,
      scrollback: XTERM_SCROLLBACK,
      fontSize: 12,
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
    term.open(container);
    fitAddon.fit();

    let ptyId: string | null = null;
    let disposed = false;
    let followUpSent = false;
    let fellBackToShell = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let shellCwd = cwdOverride ?? session.worktreePath;
    const isAgentTab = role !== "shell";
    const disposables: Array<() => void> = [];

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

    function sendFollowUp(setupMessages: string[], wfPreType: string | null): void {
      if (disposed || !ptyId || followUpSent) return;
      followUpSent = true;
      // Setup messages (e.g. `/effort high`) ARE submitted; the wf command is
      // only pre-typed — the user presses Enter to run it.
      for (const message of setupMessages) {
        window.agentCoordinator.terminal.write(ptyId, `${message}\r`);
      }
      if (wfPreType !== null) {
        // Conductor-driven launches submit the wf command; a manual open only
        // pre-types it (the user presses Enter).
        window.agentCoordinator.terminal.write(ptyId, autoSubmitWf ? `${wfPreType}\r` : wfPreType);
      }
    }

    // An agent runs AS the PTY process, so quitting it closes the PTY. Instead of
    // leaving a dead terminal, drop to a usable shell in the same worktree. The
    // existing onData/onExit/write handlers all target the current `ptyId`, so
    // reassigning it is enough to rewire them to the new shell.
    async function fallBackToShell(): Promise<void> {
      const id = await window.agentCoordinator.terminal.create({
        cwd: shellCwd,
        cols: term.cols,
        rows: term.rows,
      });
      if (disposed) {
        window.agentCoordinator.terminal.kill(id);
        return;
      }
      ptyId = id;
      ptyIdRef.current = id;
    }

    async function start(): Promise<void> {
      let launchCommand: string | null = null;
      let setupMessages: string[] = [];
      let wfPreType: string | null = null;

      if (role !== "shell") {
        const launch = await window.agentCoordinator.sessions.buildRoleLaunch(session.id, role, mode);
        if (disposed) return;
        launchCommand = launch.agentCommand;
        shellCwd = launch.cwd;
        setupMessages = launch.setupMessages;
        wfPreType = launch.wfCommand;
        if (launch.warnings.length > 0) setWarnings(launch.warnings);
      }

      // Restore prior scrollback (visual history only — the process is fresh)
      // before the live shell starts producing output.
      if (persistKey) {
        const saved = await window.agentCoordinator.terminal.readScrollback(persistKey);
        if (disposed) return;
        if (saved) {
          term.write(saved);
          // Undo any TUI modes the recording left on, BEFORE the live shell runs,
          // so no mouse reports leak into it.
          term.write(TUI_MODE_RESET);
          term.write("\r\n\x1b[2m—— restored ——\x1b[0m\r\n");
        }
      }

      const id = await window.agentCoordinator.terminal.create({
        cwd: shellCwd,
        cols: term.cols,
        rows: term.rows,
        launchCommand,
        persistKey: persistKey ?? null,
      });
      if (disposed) {
        window.agentCoordinator.terminal.kill(id);
        return;
      }
      ptyId = id;
      ptyIdRef.current = id;

      const onDataDisposable = term.onData((data) => {
        if (ptyId) window.agentCoordinator.terminal.write(ptyId, data);
      });
      disposables.push(() => onDataDisposable.dispose());

      const hasFollowUp = setupMessages.length > 0 || wfPreType !== null;

      const unsubscribeData = window.agentCoordinator.terminal.onData((e) => {
        if (e.sessionId !== ptyId) return;
        term.write(e.data);

        // On the first agent output, wait a beat for its input box, then send.
        if (hasFollowUp && !followUpSent && settleTimer === null) {
          settleTimer = setTimeout(() => {
            settleTimer = null;
            sendFollowUp(setupMessages, wfPreType);
          }, SETTLE_MS);
        }
      });
      disposables.push(unsubscribeData);

      const unsubscribeExit = window.agentCoordinator.terminal.onExit((e) => {
        if (e.sessionId !== ptyId) return;
        if (isAgentTab && !fellBackToShell) {
          // Agent quit → become a usable shell instead of a dead pane.
          fellBackToShell = true;
          followUpSent = true; // never pre-type the wf command into the shell
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          term.write("\r\n\x1b[2m—— agent exited · dropped to shell ——\x1b[0m\r\n\r\n");
          void fallBackToShell();
        } else {
          setExitCode(e.code);
        }
      });
      disposables.push(unsubscribeExit);
    }

    void start();

    const resizeObserver = new ResizeObserver(() => {
      // A hidden (inactive) tab reports a zero-size rect; fitting against that
      // collapses the terminal to 0 cols/rows. Skip until it's visible again.
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fitAddon.fit();
      if (ptyId) window.agentCoordinator.terminal.resize(ptyId, term.cols, term.rows);
    });
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      if (settleTimer) clearTimeout(settleTimer);
      resizeObserver.disconnect();
      disposables.forEach((dispose) => dispose());
      if (ptyId) window.agentCoordinator.terminal.kill(ptyId);
      ptyIdRef.current = null;
      term.dispose();
    };
  }, [session.id, session.worktreePath, role, mode, cwdOverride]);

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
