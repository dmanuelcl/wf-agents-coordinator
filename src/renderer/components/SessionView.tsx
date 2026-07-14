import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";
import { FileTree } from "./FileTree";
import { GitDiffView } from "./GitDiffView";
import type { SendTarget } from "./Composer";
import { MarkdownFileView } from "./MarkdownFileView";
import { SessionTerminal } from "./SessionTerminal";
import type { SessionTerminalHandle } from "./SessionTerminal";
import type { AgentLaunchMode } from "../../shared/ipc/contract";
import { SESSION_AGENT_ROLES } from "../../shared/workflow/session-role-launch";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import type { WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import type { LedgerRow, ParsedCheckpoint, WorkflowNext } from "../../shared/workflow/workflow-types";
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { ConductorAction } from "../../shared/workflow/conductor";
import { useConductor } from "../hooks/useConductor";
import { buildSlackPostCommand } from "../../shared/workflow/review-config";
import type { ReviewConfig } from "../../shared/workflow/review-config";

// A dynamic plain-shell tab. The `+` mints these; each carries a renameable
// title so several shells in one session can be told apart. `root` shells run
// in the main repo root instead of this session's worktree.
export interface ShellTab {
  id: string;
  title: string;
  root?: boolean;
}

// A file opened from a terminal link or the file tree (session-local).
interface FileTab {
  id: string;
  path: string;
  title: string;
  isMarkdown: boolean;
}

// Files opened in the OS default app rather than an in-app editor tab.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|mp3|wav|woff2?|ttf|otf|eot|wasm|node)$/i;

export interface SessionLayout {
  openedRoleTabs: SessionAgentRole[];
  shellTabs: ShellTab[];
  // A role name ("architect"|…), "log", or a shell tab id.
  activeTab: string;
}

interface SessionViewProps {
  session: WorkSession;
  // The project's repo-root workspace: no agent/checkpoint/Log tabs, rooted at
  // the repo root (session.worktreePath already IS the repo root).
  repoMode?: boolean;
  // Restored on startup: which agent + shell tabs to reopen, and which is active.
  initialLayout?: SessionLayout;
  onLayoutChange?: (sessionId: string, layout: SessionLayout) => void;
  // The owning project's auto-pilot conductor settings. Unused in repoMode.
  autoPilotConfig?: AutoPilotConfig;
  // The owning project's PR-review settings (Slack channel + kickoff).
  reviewConfig?: ReviewConfig;
}

const KIND_LABELS: Record<WorkSessionKind, string> = {
  feature: "Feature",
  fix: "Bug fix",
  review: "PR review",
};

// A review session shows only the Reviewer tab (no architect/implementer).
const REVIEW_ROLES: readonly SessionAgentRole[] = ["reviewer"];

// The architect tab is framed as "Diagnose" for a fix — same role, same slot.
// Review sessions have no architect tab, but the map must cover every kind.
const ARCHITECT_TAB_LABEL: Record<WorkSessionKind, string> = {
  feature: "Architect",
  fix: "Diagnose",
  review: "Reviewer",
};

function roleLabel(role: SessionAgentRole, kind: WorkSessionKind): string {
  if (role === "architect") return ARCHITECT_TAB_LABEL[kind];
  return role === "implementer" ? "Implementer" : "Reviewer";
}

// A one-line "how to start" hint for a role tab, based on its state. Backtick
// segments render as inline code. This is guidance only — distinct from the
// checkpoint's ▶ NEXT command (which is pre-typed into the terminal).
function roleHint(role: SessionAgentRole, kind: WorkSessionKind, hasCheckpoint: boolean): string {
  if (kind === "review") {
    return "This review auto-runs the kickoff against the branch when the agent loads. When it's done, use `Post to Slack` to publish it.";
  }
  if (role === "architect") {
    if (hasCheckpoint) {
      return "Checkpoint ready — this tab pre-types the `wf verify` review command below. Press Enter, or open Log to see ▶ NEXT.";
    }
    if (kind === "fix") {
      return "Type `wf fix <bug description>` to diagnose the root cause and write the checkpoint that unlocks Implementer.";
    }
    return "Describe the feature to brainstorm and plan it — finishing the plan writes the checkpoint that unlocks the Implementer + Reviewer tabs.";
  }
  if (role === "implementer") {
    return "This tab pre-types `wf implement <checkpoint>` below once the agent loads — press Enter to run it (or edit first).";
  }
  return "This tab pre-types `wf review <checkpoint>` below once the agent loads — press Enter to run it.";
}

const SHELL_HINT = "Plain terminal in the worktree — run any command. Drop a file here to attach its path.";
const SHELL_HINT_ROOT = "Plain terminal in the REPO ROOT (not this session's worktree) — run any command. Drop a file here to attach its path.";
const SHELL_HINT_REPO = "Plain terminal in the repo root — run any command. Drop a file here to attach its path.";

// A session's worktree lives at `<repoRoot>/.worktrees/<slug>`; strip that
// segment to get the main repo root. Equal to the worktree when there's no
// separate root (nothing to toggle).
const WORKTREE_SEGMENT = /[/\\]\.worktrees[/\\]/;
function repoRootOf(worktreePath: string): string {
  return worktreePath.split(WORKTREE_SEGMENT)[0] || worktreePath;
}

function NextBlock(props: { next: WorkflowNext }): JSX.Element {
  const { next } = props;
  return (
    <div className="session-log-next">
      <p className="session-log-next-title">▶ NEXT</p>
      <dl className="session-log-next-grid">
        <div>
          <dt>Role</dt>
          <dd>{next.role}</dd>
        </div>
        <div>
          <dt>Command</dt>
          <dd>
            {next.command ? (
              <span className="session-log-cmd">
                <code>{next.command}</code>
                <CopyButton value={next.command} label="Copy command" />
              </span>
            ) : (
              <span className="session-view-muted">—</span>
            )}
          </dd>
        </div>
        <div>
          <dt>cwd</dt>
          <dd>{next.cwd ? <code>{next.cwd}</code> : <span className="session-view-muted">—</span>}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{next.task ?? <span className="session-view-muted">—</span>}</dd>
        </div>
      </dl>
    </div>
  );
}

function LedgerTable(props: { rows: LedgerRow[] }): JSX.Element {
  const { rows } = props;
  if (rows.length === 0) {
    return <p className="session-view-muted">No plans in the ledger yet.</p>;
  }
  return (
    <table className="session-log-ledger">
      <thead>
        <tr>
          <th>#</th>
          <th>Plan</th>
          <th>Impl</th>
          <th>Arch</th>
          <th>PR</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.index}-${index}`}>
            <td>{row.index}</td>
            <td>{row.plan}</td>
            <td>{row.implement}</td>
            <td>{row.archReview}</td>
            <td>{row.prReview}</td>
            <td>{row.state}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LogPanel(props: { checkpoint: ParsedCheckpoint | null; hasCheckpoint: boolean }): JSX.Element {
  const { checkpoint, hasCheckpoint } = props;

  if (!hasCheckpoint) {
    return (
      <div className="pane-empty">
        <p className="pane-empty-title">No checkpoint yet</p>
        <p className="pane-empty-hint">The architect creates it — start in the Architect tab.</p>
      </div>
    );
  }
  if (!checkpoint) {
    return (
      <div className="pane-empty">
        <p className="pane-empty-hint">Loading checkpoint…</p>
      </div>
    );
  }

  return (
    <div className="session-panel session-log-panel">
      {checkpoint.next ? (
        <NextBlock next={checkpoint.next} />
      ) : (
        <p className="session-view-muted">No ▶ NEXT block in the checkpoint.</p>
      )}

      <div className="session-log-section">
        <p className="session-log-section-title">Plans ledger</p>
        <LedgerTable rows={checkpoint.ledgerRows} />
      </div>

      <div className="session-log-section">
        <p className="session-log-section-title">Latest log entry</p>
        {checkpoint.latestLogMarkdown ? (
          <pre className="session-log-latest">{checkpoint.latestLogMarkdown}</pre>
        ) : (
          <p className="session-view-muted">No log entries yet.</p>
        )}
      </div>
    </div>
  );
}

function initialRoleTabs(layout: SessionLayout | undefined): Map<SessionAgentRole, AgentLaunchMode> {
  // Restored agent tabs resume their conversation (`--resume`); a brand-new
  // session opens on Architect fresh. If the session was restored with only
  // shell tabs, don't force Architect back open.
  const roles = layout?.openedRoleTabs ?? [];
  if (roles.length > 0 || (layout?.shellTabs.length ?? 0) > 0) {
    return new Map(roles.map((role) => [role, "resume" as AgentLaunchMode]));
  }
  return new Map<SessionAgentRole, AgentLaunchMode>([["architect", "fresh"]]);
}

// A review session opens straight on the Reviewer tab (resuming it if restored).
function initialReviewTabs(layout: SessionLayout | undefined): Map<SessionAgentRole, AgentLaunchMode> {
  const restored = layout?.openedRoleTabs?.includes("reviewer") ?? false;
  return new Map<SessionAgentRole, AgentLaunchMode>([["reviewer", restored ? "resume" : "fresh"]]);
}

export function SessionView(props: SessionViewProps): JSX.Element {
  const { session, initialLayout, onLayoutChange, repoMode = false, autoPilotConfig, reviewConfig } = props;
  const kind = session.kind;
  const reviewMode = kind === "review";
  const hasCheckpoint = session.checkpointPath !== null;

  // A fresh repo workspace opens with exactly one shell, seeded here (not via an
  // effect) so React 18 StrictMode's double-invoke can't create two.
  const seedRepoShell = useMemo<ShellTab | null>(
    () => (repoMode && !initialLayout?.shellTabs?.length ? { id: crypto.randomUUID(), title: "Shell 1", root: false } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [activeTab, setActiveTab] = useState<string>(
    () => initialLayout?.activeTab ?? seedRepoShell?.id ?? (reviewMode ? "reviewer" : "architect"),
  );
  // Agent tabs opened at least once, each with its launch mode; their terminals
  // stay mounted (agents keep running) while another tab is shown. This
  // component is keyed by session.id in the parent, so these initialisers run
  // once per session and the restored layout is not clobbered on re-render.
  const [openedRoleTabs, setOpenedRoleTabs] = useState<Map<SessionAgentRole, AgentLaunchMode>>(() =>
    repoMode ? new Map() : reviewMode ? initialReviewTabs(initialLayout) : initialRoleTabs(initialLayout),
  );
  const [shellTabs, setShellTabs] = useState<ShellTab[]>(() =>
    initialLayout?.shellTabs?.length ? initialLayout.shellTabs : seedRepoShell ? [seedRepoShell] : [],
  );
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [dirtyFileTabs, setDirtyFileTabs] = useState<Record<string, boolean>>({});
  const [pendingCloseFile, setPendingCloseFile] = useState<FileTab | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  // Bumped by the Files panel's Refresh button to re-scan the tree on demand.
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  // Which root the file tree browses: this session's worktree, or the main repo.
  const [filesScope, setFilesScope] = useState<"worktree" | "repo">("worktree");
  const [checkpoint, setCheckpoint] = useState<ParsedCheckpoint | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Auto-pilot conductor: per-session on/off, the roles it opened (which auto-submit
  // their wf command), and the last action line shown in the feedback strip.
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  const [conductorAutoRoles, setConductorAutoRoles] = useState<Set<SessionAgentRole>>(() => new Set());
  const [conductorLog, setConductorLog] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [reviewPostMsg, setReviewPostMsg] = useState<string | null>(null);
  // Live terminal handles keyed by tab id (role name or shell tab id), so a
  // file's composer can deliver text into the chosen one.
  const terminalHandles = useRef<Map<string, SessionTerminalHandle>>(new Map());

  // Report layout changes up so the workspace can be persisted for restore.
  useEffect(() => {
    onLayoutChange?.(session.id, {
      openedRoleTabs: Array.from(openedRoleTabs.keys()),
      shellTabs,
      activeTab,
    });
  }, [session.id, openedRoleTabs, shellTabs, activeTab, onLayoutChange]);

  // Load (and refresh on each Log open) the parsed checkpoint. Re-runs when the
  // gate flips (checkpointPath: null -> path) so the Log renders as soon as it exists.
  useEffect(() => {
    if (repoMode || activeTab !== "log" || !hasCheckpoint) return;
    let cancelled = false;
    void window.agentCoordinator.sessions.readCheckpoint(session.id).then((result) => {
      if (!cancelled) setCheckpoint(result);
    });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.checkpointPath, activeTab, hasCheckpoint, repoMode]);

  // Seeding opens the first shell; this only repairs a restored-but-stale active
  // tab (repo mode has no agent/Log tabs for it to point at).
  useEffect(() => {
    const firstShell = shellTabs[0];
    if (repoMode && firstShell && (activeTab === "architect" || activeTab === "log")) {
      setActiveTab(firstShell.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function isRoleDisabled(role: SessionAgentRole): boolean {
    // A review session's reviewer is always live — it has no checkpoint gate.
    if (reviewMode) return false;
    return (role === "implementer" || role === "reviewer") && !hasCheckpoint;
  }

  const disabledHint = "Finish in Architect first — the checkpoint isn't created yet.";

  function selectRole(role: SessionAgentRole): void {
    if (isRoleDisabled(role)) return;
    setActiveTab(role);
    setOpenedRoleTabs((current) => (current.has(role) ? current : new Map(current).set(role, "fresh")));
  }

  function addShellTab(root: boolean): void {
    const id = crypto.randomUUID();
    setShellTabs((current) => [...current, { id, title: `Shell ${current.length + 1}`, root }]);
    setActiveTab(id);
  }

  function closeShellTab(id: string): void {
    const remaining = [
      ...Array.from(openedRoleTabs.keys()),
      ...shellTabs.filter((tab) => tab.id !== id).map((tab) => tab.id),
      ...fileTabs.map((tab) => tab.id),
      ...(diffOpen ? ["diff"] : []),
    ];
    setShellTabs((current) => current.filter((tab) => tab.id !== id));
    // Repo mode has no Log tab to fall back to — leave no tab active (an empty
    // state prompts to open one).
    setActiveTab((current) => (current === id ? (remaining[0] ?? (repoMode ? "" : "log")) : current));
    if (renamingId === id) setRenamingId(null);
    // Closing a shell tab discards its saved scrollback (no restore needed).
    void window.agentCoordinator.terminal.clearScrollback(`${session.id}::${id}`);
  }

  // Open a file in an in-app editor tab (markdown gets preview+edit, others are
  // edit-only). Binary files open in the OS app instead. Focuses an existing tab.
  function handleOpenFile(absPath: string): void {
    if (BINARY_EXT.test(absPath)) {
      void window.agentCoordinator.system.openPath(absPath, session.worktreePath);
      return;
    }
    const existing = fileTabs.find((tab) => tab.path === absPath);
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    const id = crypto.randomUUID();
    const title = absPath.split("/").pop() ?? "file";
    setFileTabs((current) => [...current, { id, path: absPath, title, isMarkdown: /\.mdx?$/i.test(absPath) }]);
    setActiveTab(id);
  }

  // A file path clicked in a terminal: markdown opens in-app; anything else in
  // the OS default app.
  function handleOpenPath(token: string): void {
    void window.agentCoordinator.system.resolveFile(token, session.worktreePath).then((info) => {
      if (!info.exists) return;
      if (info.isMarkdown) {
        handleOpenFile(info.absPath);
      } else {
        void window.agentCoordinator.system.openPath(info.absPath, session.worktreePath);
      }
    });
  }

  function actuallyCloseFile(id: string): void {
    const remaining = [
      ...Array.from(openedRoleTabs.keys()),
      ...shellTabs.map((tab) => tab.id),
      ...fileTabs.filter((tab) => tab.id !== id).map((tab) => tab.id),
      ...(diffOpen ? ["diff"] : []),
    ];
    setFileTabs((current) => current.filter((tab) => tab.id !== id));
    setDirtyFileTabs((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setActiveTab((current) => (current === id ? (remaining[0] ?? (repoMode ? "" : "log")) : current));
  }

  function closeFileTab(id: string): void {
    // Warn before discarding unsaved edits.
    if (dirtyFileTabs[id]) {
      const tab = fileTabs.find((candidate) => candidate.id === id);
      if (tab) {
        setPendingCloseFile(tab);
        return;
      }
    }
    actuallyCloseFile(id);
  }

  function handleFileDirty(id: string, dirty: boolean): void {
    setDirtyFileTabs((current) => (current[id] === dirty ? current : { ...current, [id]: dirty }));
  }

  function startRename(tab: ShellTab): void {
    setRenamingId(tab.id);
    setRenameDraft(tab.title);
  }

  function commitRename(): void {
    const id = renamingId;
    if (!id) return;
    const title = renameDraft.trim();
    if (title) {
      setShellTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, title } : tab)));
    }
    setRenamingId(null);
  }

  // Non-file terminal tabs (opened agent roles + shells): a composer's targets.
  const sendTargets: SendTarget[] = [
    ...Array.from(openedRoleTabs.keys()).map((role) => ({ key: role, label: roleLabel(role, kind) })),
    ...shellTabs.map((tab) => ({ key: tab.id, label: tab.title })),
  ];

  // Deliver a file's composed text to the chosen terminal, focusing that tab.
  // `execute` appends Enter (shell runs it / agent submits). Returns false when
  // no live terminal exists so the caller keeps the text.
  function handleComposerSend(targetKey: string, text: string, execute: boolean): boolean {
    const handle = terminalHandles.current.get(targetKey);
    if (!handle || !text.trim()) return false;
    handle.sendText(text, execute);
    setActiveTab(targetKey);
    return true;
  }

  // Post the review artifact (.agent-review.md) as a PR comment, then open it.
  async function handlePostToPr(): Promise<void> {
    if (!session.pr || posting) return;
    setPosting(true);
    setReviewPostMsg("Posting the review to the PR…");
    try {
      const { commentUrl } = await window.agentCoordinator.sessions.postReview(session.id);
      setReviewPostMsg(`Posted ✓ ${commentUrl}`);
      void window.agentCoordinator.system.openExternal(commentUrl);
    } catch (caught) {
      setReviewPostMsg(`Post failed — ${String(caught)}`);
    } finally {
      setPosting(false);
    }
  }

  function registerTerminalHandle(key: string, handle: SessionTerminalHandle | null): void {
    if (handle) terminalHandles.current.set(key, handle);
    else terminalHandles.current.delete(key);
  }

  const repoRoot = repoRootOf(session.worktreePath);
  const hasSeparateRoot = repoRoot !== session.worktreePath;
  const filesRootPath = filesScope === "repo" && hasSeparateRoot ? repoRoot : session.worktreePath;

  // Deliver a conductor decision to the tabs. A forward step to a role tab that
  // isn't open yet opens it and lets the tab's own launch follow-up submit the
  // wf command (autoSubmitWf); a step to an already-open tab sends straight into
  // the live agent. Pause pre-types (no Enter) so the human runs it.
  function performConductorAction(action: ConductorAction): void {
    if (action.kind === "noop") return;
    if (action.kind === "send") {
      const role = action.role;
      if (openedRoleTabs.has(role)) {
        terminalHandles.current.get(role)?.sendText(action.command, true);
        setActiveTab(role);
      } else {
        setConductorAutoRoles((current) => new Set(current).add(role));
        selectRole(role);
      }
      setConductorLog(`→ ${action.command} · ${roleLabel(role, kind)}`);
      return;
    }
    // pause
    if (action.role && openedRoleTabs.has(action.role) && action.command) {
      terminalHandles.current.get(action.role)?.sendText(action.command, false);
      setActiveTab(action.role);
    } else if (action.role) {
      selectRole(action.role);
    }
    setConductorLog(`paused · ${action.reason}`);
  }

  useConductor({
    session,
    repoRoot,
    enabled: !repoMode && autoPilotEnabled && hasCheckpoint,
    getConfig: () => autoPilotConfig ?? createDefaultAutoPilotConfig(),
    onAction: performConductorAction,
  });
  // In repo mode there are no agent/Log tabs; if the active tab isn't a shell,
  // file, or the diff, nothing is open (show an empty state instead of a blank).
  const repoActiveTabExists =
    (activeTab === "diff" && diffOpen) ||
    shellTabs.some((tab) => tab.id === activeTab) ||
    fileTabs.some((tab) => tab.id === activeTab);

  return (
    <section className="session-view">
      <header className="session-topbar">
        <div className="session-topbar-title">
          <span className="session-topbar-name">{session.name}</span>
          {repoMode ? (
            <span className="session-topbar-kind session-topbar-kind-repo">REPO ROOT</span>
          ) : reviewMode ? (
            <>
              <span
                className="session-topbar-kind session-topbar-kind-review"
                title={session.baseBranch ? `${session.branch} vs ${session.baseBranch}` : session.branch}
              >
                PR REVIEW
              </span>
              {session.pr && (
                <button
                  type="button"
                  className="session-topbar-pr-chip"
                  title={session.pr.url}
                  onClick={() => session.pr && void window.agentCoordinator.system.openExternal(session.pr.url)}
                >
                  PR #{session.pr.prId}
                </button>
              )}
            </>
          ) : (
            <span className="session-topbar-kind">{KIND_LABELS[kind]}</span>
          )}
        </div>
        <div className="session-topbar-meta">
          {reviewMode && session.pr && (
            <button
              type="button"
              className="session-topbar-diff"
              disabled={posting}
              title="Post the review (from .agent-review.md) as a comment on the PR"
              onClick={() => void handlePostToPr()}
            >
              {posting ? "Posting…" : "Post to PR"}
            </button>
          )}
          {reviewMode && !session.pr && (
            <button
              type="button"
              className="session-topbar-diff"
              disabled={!reviewConfig?.slackChannel}
              title={
                reviewConfig?.slackChannel
                  ? `Post the review to ${reviewConfig.slackChannel}`
                  : "Set a Slack channel in project config first"
              }
              onClick={() => {
                const channel = reviewConfig?.slackChannel;
                if (!channel) return;
                terminalHandles.current.get("reviewer")?.sendText(buildSlackPostCommand(channel), true);
                setActiveTab("reviewer");
              }}
            >
              Post to Slack
            </button>
          )}
          {!repoMode && !reviewMode && (
            <button
              type="button"
              className={`session-topbar-autopilot${autoPilotEnabled ? " on" : ""}`}
              disabled={!hasCheckpoint}
              title={
                hasCheckpoint
                  ? "Auto-pilot: run each ▶ NEXT command automatically"
                  : "Auto-pilot activates once a checkpoint exists"
              }
              aria-pressed={autoPilotEnabled}
              onClick={() => setAutoPilotEnabled((value) => !value)}
            >
              <span className="session-topbar-autopilot-dot" />
              Auto-pilot
            </button>
          )}
          <button
            type="button"
            className={`session-topbar-diff${filesOpen ? " active" : ""}`}
            title="Toggle the project file tree"
            onClick={() => setFilesOpen((value) => !value)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            Files
          </button>
          <button
            type="button"
            className="session-topbar-diff"
            title="Show this session's git diff"
            onClick={() => {
              setDiffOpen(true);
              setActiveTab("diff");
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />
            </svg>
            Diff
          </button>
          {repoMode ? (
            <span className="session-topbar-chip session-topbar-chip-repo" title={session.worktreePath}>
              {session.worktreePath}
            </span>
          ) : (
            <>
              <span className="session-topbar-chip" title={session.worktreePath}>
                {session.branch}
              </span>
              {session.checkpointPath ? (
                <span className="session-topbar-chip session-topbar-chip-ok" title={session.checkpointPath}>
                  checkpoint ready
                </span>
              ) : (
                <span className="session-topbar-chip session-topbar-chip-pending">brainstorming</span>
              )}
            </>
          )}
        </div>
      </header>

      {!repoMode && !reviewMode && autoPilotEnabled && conductorLog && (
        <div className="session-conductor-strip">{conductorLog}</div>
      )}

      {reviewMode && reviewPostMsg && <div className="session-conductor-strip">{reviewPostMsg}</div>}

      <div className="session-split">
      <div className="session-main">
      <div className="session-view-tabs" role="tablist" aria-label="Session tabs">
        {!repoMode &&
          (reviewMode ? REVIEW_ROLES : SESSION_AGENT_ROLES).map((role) => {
            const disabled = isRoleDisabled(role);
            const active = activeTab === role;
            return (
              <div key={role} className={`session-view-tab-wrap${active ? " active" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`session-view-tab${active ? " active" : ""}`}
                  disabled={disabled}
                  title={disabled ? disabledHint : undefined}
                  onClick={() => selectRole(role)}
                >
                  {roleLabel(role, kind)}
                </button>
              </div>
            );
          })}

        {!repoMode && !reviewMode && (
          <div className={`session-view-tab-wrap${activeTab === "log" ? " active" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "log"}
              className={`session-view-tab${activeTab === "log" ? " active" : ""}`}
              onClick={() => setActiveTab("log")}
            >
              Log
            </button>
          </div>
        )}

        {diffOpen && (
          <div className={`session-view-tab-wrap${activeTab === "diff" ? " active" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "diff"}
              className={`session-view-tab${activeTab === "diff" ? " active" : ""}`}
              onClick={() => setActiveTab("diff")}
            >
              Diff
            </button>
            <button
              type="button"
              className="session-view-tab-close"
              aria-label="Close diff"
              onClick={() => {
                setDiffOpen(false);
                setActiveTab((current) => (current === "diff" ? "log" : current));
              }}
            >
              ×
            </button>
          </div>
        )}

        {shellTabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <div key={tab.id} className={`session-view-tab-wrap${active ? " active" : ""}`}>
              {renamingId === tab.id ? (
                <input
                  className="session-view-tab-rename"
                  value={renameDraft}
                  autoFocus
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`session-view-tab${active ? " active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                  onDoubleClick={() => startRename(tab)}
                  title={tab.root ? "Repo-root shell · double-click to rename" : "Double-click to rename"}
                >
                  {tab.root && <span className="tab-root-badge">root</span>}
                  {tab.title}
                </button>
              )}
              <button
                type="button"
                className="session-view-tab-close"
                aria-label={`Close ${tab.title}`}
                title="Close shell"
                onClick={() => closeShellTab(tab.id)}
              >
                ×
              </button>
            </div>
          );
        })}

        {fileTabs.map((tab) => {
          const active = activeTab === tab.id;
          const dirty = dirtyFileTabs[tab.id] === true;
          return (
            <div key={tab.id} className={`session-view-tab-wrap${active ? " active" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={`session-view-tab session-view-tab-file${active ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.path}
              >
                {tab.title}
              </button>
              <button
                type="button"
                className={`session-view-tab-close${dirty ? " dirty" : ""}`}
                aria-label={dirty ? `${tab.title} — unsaved, close` : `Close ${tab.title}`}
                title={dirty ? "Unsaved changes" : "Close"}
                onClick={() => closeFileTab(tab.id)}
              >
                <span className="tab-close-dot" aria-hidden="true" />
                <span className="tab-close-x" aria-hidden="true">
                  ×
                </span>
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className="session-view-tab-add"
          aria-label="New worktree shell"
          title="New shell (worktree)"
          onClick={() => addShellTab(false)}
        >
          +
        </button>
        {hasSeparateRoot && (
          <button
            type="button"
            className="session-view-tab-add session-view-tab-add-root"
            aria-label="New repo-root shell"
            title="New shell in the repo root"
            onClick={() => addShellTab(true)}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 10.5 12 3l9 7.5" />
              <path d="M5 9.5V21h14V9.5" />
            </svg>
          </button>
        )}
      </div>

      <div className="session-view-body">
        {!repoMode && activeTab === "log" && (
          <div className="session-log-scroll">
            <LogPanel checkpoint={checkpoint} hasCheckpoint={hasCheckpoint} />
          </div>
        )}
        {repoMode && !repoActiveTabExists && (
          <div className="pane-empty">
            <p className="pane-empty-title">No tab open</p>
            <p className="pane-empty-hint">
              Use <span className="pane-empty-plus">+</span> to open a shell — or the Files / Diff buttons above.
            </p>
          </div>
        )}
        {diffOpen && (
          <div className="session-terminal-host" hidden={activeTab !== "diff"}>
            <GitDiffView worktreePath={session.worktreePath} sendTargets={sendTargets} onSend={handleComposerSend} />
          </div>
        )}
        {!repoMode &&
          Array.from(openedRoleTabs.entries()).map(([role, mode]) => (
            <div key={role} className="session-terminal-host" hidden={activeTab !== role}>
              <SessionTerminal
                ref={(handle) => registerTerminalHandle(role, handle)}
                session={session}
                role={role}
                mode={mode}
                onOpenPath={handleOpenPath}
                hint={roleHint(role, kind, hasCheckpoint)}
                autoSubmitWf={(reviewMode && role === "reviewer") || conductorAutoRoles.has(role)}
              />
            </div>
          ))}
        {shellTabs.map((tab) => (
          <div key={tab.id} className="session-terminal-host" hidden={activeTab !== tab.id}>
            <SessionTerminal
              ref={(handle) => registerTerminalHandle(tab.id, handle)}
              session={session}
              role="shell"
              mode="fresh"
              persistKey={`${session.id}::${tab.id}`}
              onOpenPath={handleOpenPath}
              cwdOverride={tab.root ? repoRoot : undefined}
              hint={repoMode ? SHELL_HINT_REPO : tab.root ? SHELL_HINT_ROOT : SHELL_HINT}
            />
          </div>
        ))}
        {fileTabs.map((tab) => (
          <div key={tab.id} className="session-terminal-host" hidden={activeTab !== tab.id}>
            <MarkdownFileView
              path={tab.path}
              markdown={tab.isMarkdown}
              onDirtyChange={(dirty) => handleFileDirty(tab.id, dirty)}
              worktreePath={session.worktreePath}
              sendTargets={sendTargets}
              onSend={handleComposerSend}
            />
          </div>
        ))}
      </div>
      </div>

      {filesOpen && (
        <aside className="session-files">
          <div className="session-files-head">
            <span>Files</span>
            <div className="session-files-actions">
              <button
                type="button"
                className="session-files-refresh"
                aria-label="Refresh file tree"
                title="Refresh — pick up new/removed files"
                onClick={() => setFilesRefreshKey((value) => value + 1)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 4v6h-6M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </button>
              <button
                type="button"
                className="session-files-close"
                aria-label="Hide file tree"
                onClick={() => setFilesOpen(false)}
              >
                ×
              </button>
            </div>
          </div>
          {hasSeparateRoot && (
            <div className="session-files-scope" role="tablist" aria-label="File tree root">
              <button
                type="button"
                className={`session-files-scope-btn${filesScope === "worktree" ? " active" : ""}`}
                onClick={() => setFilesScope("worktree")}
                title={session.worktreePath}
              >
                Worktree
              </button>
              <button
                type="button"
                className={`session-files-scope-btn${filesScope === "repo" ? " active" : ""}`}
                onClick={() => setFilesScope("repo")}
                title={repoRoot}
              >
                Repo root
              </button>
            </div>
          )}
          <div className="session-files-tree">
            <FileTree rootPath={filesRootPath} onOpenFile={handleOpenFile} refreshKey={filesRefreshKey} />
          </div>
        </aside>
      )}
      </div>

      {pendingCloseFile && (
        <div className="modal-overlay" onClick={() => setPendingCloseFile(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <p>
              <strong>{pendingCloseFile.title}</strong> has unsaved changes.
            </p>
            <p className="warning">Discard your edits and close the tab?</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingCloseFile(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-confirm-danger"
                onClick={() => {
                  actuallyCloseFile(pendingCloseFile.id);
                  setPendingCloseFile(null);
                }}
              >
                Discard &amp; close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
