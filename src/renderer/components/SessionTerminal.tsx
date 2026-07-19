import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ILink } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import "@xterm/xterm/css/xterm.css";
import type {
  AgentLaunchMode,
  SessionAgentRole,
  SessionRoleLaunch,
  TerminalDataEvent,
  TerminalExitEvent,
  WorkSession,
} from "../../shared/ipc/contract";
import { findKimiSessionId } from "../../shared/workflow/kimi-session-id";
import { createTerminalFollowUpGate } from "./terminal-follow-up-gate";
import { hasBlockingStartupConfirmation } from "./terminal-startup-readiness";

// File-path-ish tokens in terminal output: optional dir prefix, a filename with
// an extension, and an optional :line[:col] suffix. A token that isn't a real
// file just no-ops on click, so occasional false positives are harmless.
const FILE_PATH_RE = /(?:[~.]{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][\w]{0,7}(?::\d+(?::\d+)?)?/g;

// How long the agent's output must stay QUIET before we send the follow-up —
// long enough that a fresh TUI (claude etc.) has rendered its input box and will
// accept a paste. A hard deadline handles CLIs that repaint continuously, but
// never bypasses a confirmation that the user must answer.
const SETTLE_MS = 1_200;
const MAX_FOLLOW_UP_WAIT_MS = 10_000;

function visibleTerminalText(term: Terminal): string {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.viewportY);
  const end = Math.min(buffer.length, start + term.rows);
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

export interface SessionTerminalProps {
  session: WorkSession;
  role: SessionAgentRole | "shell" | "setup";
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
  // Setup terminal only: called after there is no setup to run, or after the
  // single setup owner exits 0 and setupDone has been persisted.
  onSetupReady?: () => void;
  // Setup terminal only: called after a non-zero exit (or persistence failure)
  // has released the setup claim and this pane is becoming a repair shell.
  onSetupFailed?: (reason: string) => void;
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
 * asks the main process how to launch the configured CLI plus the `wf <verb>
 * <checkpoint>` message, spawns the agent as the PTY process, and then
 * PRE-TYPES the wf command WITHOUT a trailing newline so the user presses
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
  const { session, role, mode, persistKey, onOpenPath, hint, cwdOverride, autoSubmitWf, onSetupReady, onSetupFailed } = props;
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
  const onSetupReadyRef = useRef(onSetupReady);
  const onSetupFailedRef = useRef(onSetupFailed);
  useEffect(() => {
    onOpenPathRef.current = onOpenPath;
    onSetupReadyRef.current = onSetupReady;
    onSetupFailedRef.current = onSetupFailed;
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
    let ownsSetupClaim = false;
    let shellCwd = cwdOverride ?? session.worktreePath;
    const isSetupTab = role === "setup";
    const isAgentTab = role !== "shell" && !isSetupTab;
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

    function sendFollowUp(wfPreType: string): void {
      if (disposed || !ptyId || followUpSent) return;
      followUpSent = true;
      // Bracketed paste (like sendText) so the command lands in the agent's
      // input box as one unit — robust for multi-word/long text (e.g. a review
      // kickoff). Conductor/review launches submit it (append CR); a manual
      // open only pre-types it (the user presses Enter).
      const paste = `\x1b[200~${wfPreType}\x1b[201~`;
      window.agentCoordinator.terminal.write(ptyId, autoSubmitWf ? `${paste}\r` : paste);
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
      let agentCommand: string | null = null;
      let agentKind: SessionRoleLaunch["agentKind"] | null = null;
      let wfPreType: string | null = null;
      let setupCommand: string | null = null;

      if (isSetupTab) {
        let waitingMessageShown = false;
        while (!disposed) {
          const plan = await window.agentCoordinator.sessions.claimSetup(session.id);
          if (disposed) {
            if (plan.state === "run") void window.agentCoordinator.sessions.releaseSetup(session.id);
            return;
          }
          shellCwd = plan.cwd;
          if (plan.state === "ready") {
            onSetupReadyRef.current?.();
            return;
          }
          if (plan.state === "run" && plan.command) {
            ownsSetupClaim = true;
            setupCommand = plan.command;
            break;
          }
          if (!waitingMessageShown) {
            waitingMessageShown = true;
            term.write("\x1b[2m—— waiting for this session's setup ——\x1b[0m\r\n");
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (disposed) return;
      } else if (role !== "shell") {
        const launch = await window.agentCoordinator.sessions.buildRoleLaunch(session.id, role, mode);
        if (disposed) return;
        agentCommand = launch.agentCommand;
        agentKind = launch.agentKind;
        shellCwd = launch.cwd;
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

      const followUpGate = wfPreType !== null
        ? createTerminalFollowUpGate({
            settleMs: SETTLE_MS,
            maxWaitMs: MAX_FOLLOW_UP_WAIT_MS,
            canDeliver: () => !hasBlockingStartupConfirmation(visibleTerminalText(term)),
            deliver: () => sendFollowUp(wfPreType),
          })
        : null;

      // The dedicated setup terminal is the only component allowed into the
      // setup phase. Role/shell terminals are not mounted until it persists
      // setupDone, so they always start directly in their normal phase.
      let phase: "setup" | "finishing-setup" | "agent" = setupCommand ? "setup" : "agent";

      // Subscribe BEFORE creating the PTY. A fast agent can render its startup
      // screen before the create IPC promise resolves; subscribing afterwards
      // loses the output that schedules the kickoff.
      const pendingData: TerminalDataEvent[] = [];
      const pendingExits: TerminalExitEvent[] = [];
      let recordedKimiSessionId: string | null = null;

      const captureKimiSessionId = (): void => {
        if (disposed || agentKind !== "kimi" || role === "shell" || role === "setup") return;
        const kimiSessionId = findKimiSessionId(visibleTerminalText(term));
        if (!kimiSessionId || kimiSessionId === recordedKimiSessionId) return;
        recordedKimiSessionId = kimiSessionId;
        void window.agentCoordinator.sessions
          .recordRoleAgentSession(session.id, role, kimiSessionId)
          .catch((error: unknown) => {
            if (!disposed) setWarnings((current) => [...current, `Could not persist Kimi session: ${String(error)}`]);
          });
      };

      const handleData = (event: TerminalDataEvent): void => {
        if (!ptyId) {
          pendingData.push(event);
          return;
        }
        if (event.sessionId !== ptyId) return;
        term.write(event.data, captureKimiSessionId);
        if (phase === "agent") followUpGate?.onOutput();
      };

      async function releaseSetupClaim(): Promise<void> {
        if (!ownsSetupClaim) return;
        ownsSetupClaim = false;
        await window.agentCoordinator.sessions.releaseSetup(session.id).catch(() => {});
      }

      async function failSetup(message: string): Promise<void> {
        await releaseSetupClaim();
        if (disposed) return;
        phase = "agent";
        fellBackToShell = true;
        followUpSent = true;
        followUpGate?.cancel();
        term.write(`\r\n\x1b[2m—— ${message} · dropped to shell ——\x1b[0m\r\n\r\n`);
        onSetupFailedRef.current?.(message);
        await fallBackToShell();
      }

      async function completeSetup(): Promise<void> {
        term.write("\r\n\x1b[2m—— setup done · finalizing session ——\x1b[0m\r\n");
        try {
          // This must finish before SessionView mounts any other terminal;
          // otherwise their launch plans can still observe setupDone=false.
          await window.agentCoordinator.sessions.markSetupDone(session.id);
          ownsSetupClaim = false; // the main handler releases it atomically
        } catch (error) {
          await failSetup(`setup succeeded but could not be persisted: ${String(error)}`);
          return;
        }
        if (disposed) return;
        ptyId = null;
        ptyIdRef.current = null;
        term.write("\x1b[2m—— session ready ——\x1b[0m\r\n");
        onSetupReadyRef.current?.();
      }

      const handleExit = (event: TerminalExitEvent): void => {
        if (!ptyId) {
          pendingExits.push(event);
          return;
        }
        if (event.sessionId !== ptyId) return;
        if (phase === "setup") {
          phase = "finishing-setup";
          if (event.code === 0) {
            void completeSetup();
          } else {
            // Setup failed: keep every role/shell terminal gated. This lone pane
            // becomes a shell for inspection; reopening the session can retry.
            void failSetup(`setup failed (exit ${event.code})`);
          }
          return;
        }
        if (phase === "finishing-setup") return;
        if (isAgentTab && !fellBackToShell) {
          // Agent quit → become a usable shell instead of a dead pane.
          fellBackToShell = true;
          followUpSent = true; // never pre-type the wf command into the shell
          followUpGate?.cancel();
          term.write("\r\n\x1b[2m—— agent exited · dropped to shell ——\x1b[0m\r\n\r\n");
          void fallBackToShell();
        } else {
          setExitCode(event.code);
        }
      };

      const unsubscribeData = window.agentCoordinator.terminal.onData(handleData);
      const unsubscribeExit = window.agentCoordinator.terminal.onExit(handleExit);
      disposables.push(unsubscribeData, unsubscribeExit, () => followUpGate?.cancel());

      if (setupCommand) {
        term.write(`\x1b[2m—— setup: ${setupCommand} ——\x1b[0m\r\n`);
      }
      const id = await window.agentCoordinator.terminal.create({
        cwd: shellCwd,
        cols: term.cols,
        rows: term.rows,
        launchCommand: setupCommand ?? agentCommand,
        persistKey: persistKey ?? null,
      });
      if (disposed) {
        window.agentCoordinator.terminal.kill(id);
        return;
      }
      ptyId = id;
      ptyIdRef.current = id;

      // Arm the follow-up gate only when we start directly in the agent phase.
      if (phase === "agent") followUpGate?.start();
      for (const event of pendingData.splice(0)) handleData(event);
      for (const event of pendingExits.splice(0)) handleExit(event);

      const onDataDisposable = term.onData((data) => {
        if (phase === "agent") followUpGate?.onUserInput();
        if (ptyId) window.agentCoordinator.terminal.write(ptyId, data);
      });
      disposables.push(() => onDataDisposable.dispose());
    }

    void start().catch((error: unknown) => {
      if (ownsSetupClaim) {
        ownsSetupClaim = false;
        void window.agentCoordinator.sessions.releaseSetup(session.id);
      }
      if (!disposed) setWarnings((current) => [...current, String(error)]);
    });

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
      resizeObserver.disconnect();
      disposables.forEach((dispose) => dispose());
      if (ptyId) window.agentCoordinator.terminal.kill(ptyId);
      ptyIdRef.current = null;
      term.dispose();
      // Send kill before releasing ownership so another window cannot claim
      // setup while this terminal's command is still alive.
      if (ownsSetupClaim) {
        ownsSetupClaim = false;
        void window.agentCoordinator.sessions.releaseSetup(session.id);
      }
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
