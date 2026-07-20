import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";
import { FileTree } from "./FileTree";
import { GitDiffView } from "./GitDiffView";
import type { SendTarget } from "./Composer";
import { MarkdownFileView } from "./MarkdownFileView";
import { MarkdownContent } from "./MarkdownContent";
import { SessionTerminal } from "./SessionTerminal";
import type { SessionTerminalHandle } from "./SessionTerminal";
import { continueAfterSetupRepair, SetupRecoveryBanner } from "./setup-recovery";
import type { AgentLaunchMode } from "../../shared/ipc/contract";
import { agentRolesForSessionKind, isSessionRoleUnlocked } from "../../shared/workflow/session-role-launch";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import type { WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import type { LedgerRow, ParsedCheckpoint, WorkflowNext, WorkflowStatus } from "../../shared/workflow/workflow-types";
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { ConductorAction } from "../../shared/workflow/conductor";
import { useConductor } from "../hooks/useConductor";
import { buildSlackPostCommand, buildSlackSummaryCommand } from "../../shared/workflow/review-config";
import type { ReviewConfig } from "../../shared/workflow/review-config";
import { getPrFixPushGate } from "../../shared/workflow/pr-fix-push-gate";
import { planFileCandidates, planFileToken } from "./log-plan-link";
import { SessionNotice, toneForReviewMessage } from "./session-notice";

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
  "pr-fix": "PR fix",
};


// The architect tab is framed as "Diagnose" for a fix — same role, same slot.
// Review sessions have no architect tab, but the map must cover every kind.
const ARCHITECT_TAB_LABEL: Record<WorkSessionKind, string> = {
  feature: "Architect",
  fix: "Diagnose",
  review: "Reviewer",
  "pr-fix": "Implementer",
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
    return "This review auto-runs the kickoff against the branch when the agent loads. When it's done, use `Post to PR` (or `Post to Slack`) to publish it.";
  }
  if (kind === "pr-fix") {
    if (role === "implementer") {
      if (hasCheckpoint) {
        return "The PR Fix is now checkpoint-driven. When ▶ NEXT returns to Implementer, run `wf implement <checkpoint>` in this agent and keep the same findings and review scope.";
      }
      return "This reads the PR comments and implements them on the writable branch. After commits and tests it writes the checkpoint that unlocks `Reviewer`. It never pushes.";
    }
    return "Checkpoint ready — this pre-types `wf review <checkpoint>`, which reconciles the PR context, diff, findings, and correction plan in the same workflow. Press Enter to run it before `Push to PR`.";
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

/** Join paths in the sandboxed renderer, where node:path is unavailable. */
function joinRendererPath(base: string, rel: string): string {
  return `${base.replace(/[/\\]+$/, "")}/${rel.replace(/^[/\\]+/, "")}`;
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
          <dt>Tier</dt>
          <dd>{next.tier ?? <span className="session-view-muted">—</span>}</dd>
        </div>
        <div>
          <dt>Task</dt>
          <dd>{next.task ?? <span className="session-view-muted">—</span>}</dd>
        </div>
      </dl>
    </div>
  );
}

function LedgerTable(props: { rows: LedgerRow[]; onOpenPlan: (planCell: string) => void }): JSX.Element {
  const { rows, onOpenPlan } = props;
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
        {rows.map((row, index) => {
          const planPath = planFileToken(row.plan);
          return (
            <tr key={`${row.index}-${index}`}>
              <td>{row.index}</td>
              <td>
                {planPath ? (
                  <button
                    type="button"
                    className="session-log-plan-link"
                    title={`Open ${planPath}`}
                    onClick={() => onOpenPlan(row.plan)}
                  >
                    <span>{row.plan}</span>
                    <span className="session-log-plan-link-icon" aria-hidden="true">↗</span>
                  </button>
                ) : (
                  row.plan
                )}
              </td>
              <td>{row.implement}</td>
              <td>{row.archReview}</td>
              <td>{row.prReview}</td>
              <td>{row.state}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function findingCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function statusBadgeClass(status: WorkflowStatus): string {
  if (status === "BLOCKED") return "badge badge-attention";
  if (status === "DONE") return "badge badge-done";
  return "badge";
}

// At-a-glance state for deciding what to do next: status, who's active, open vs
// closed findings, and the feature/tier/branch context — all already parsed but
// previously not surfaced in the Log tab.
function CheckpointStatusHeader(props: { checkpoint: ParsedCheckpoint }): JSX.Element {
  const { status, activeRole, findingCounts, feature, slug, kind, branch, next } = props.checkpoint;
  const context = [feature ?? slug, kind !== "unknown" ? kind : null, next?.tier ? `tier ${next.tier}` : null, branch]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <section className="session-log-status" aria-label="Estado del checkpoint">
      <div className="session-log-status-row">
        <span className={statusBadgeClass(status)}>{status}</span>
        <span className="session-log-status-role">
          Activo: <strong>{activeRole}</strong>
        </span>
        <span className="session-finding-counts session-log-status-findings" aria-label="Hallazgos">
          <span className="session-finding-count session-finding-count-open">
            {findingCountLabel(findingCounts.open, "abierto", "abiertos")}
          </span>
          <span className="session-finding-count session-finding-count-closed">
            {findingCountLabel(findingCounts.closed, "cerrado", "cerrados")}
          </span>
          <span className="session-view-muted">· {findingCounts.total} total</span>
        </span>
      </div>
      {context && <div className="session-log-status-context session-view-muted">{context}</div>}
    </section>
  );
}

function CorrectionPlanPanel(props: { checkpoint: ParsedCheckpoint }): JSX.Element | null {
  const { correctionPlan, findingCounts } = props.checkpoint;
  if (!correctionPlan && findingCounts.total === 0) return null;

  return (
    <section className="session-correction-plan" aria-label="Plan de corrección">
      <div className="session-correction-plan-header">
        <div>
          <h2 className="session-correction-plan-title">
            {correctionPlan?.title ?? "Plan de corrección"}
          </h2>
          <p className="session-correction-plan-note">Último plan accionable registrado por el reviewer.</p>
        </div>
        <div className="session-finding-counts" aria-label="Estado de hallazgos">
          <span className="session-finding-count session-finding-count-open">
            {findingCountLabel(findingCounts.open, "abierto", "abiertos")}
          </span>
          <span className="session-finding-count session-finding-count-closed">
            {findingCountLabel(findingCounts.closed, "cerrado", "cerrados")}
          </span>
        </div>
      </div>

      {correctionPlan?.markdown ? (
        <MarkdownContent markdown={correctionPlan.markdown} className="session-correction-plan-body" />
      ) : (
        <p className="session-correction-plan-empty">
          {findingCounts.open > 0
            ? "El checkpoint registra hallazgos abiertos, pero no incluye un plan ejecutable."
            : "No hay pasos de corrección que ejecutar."}
        </p>
      )}
    </section>
  );
}

function LogPanel(props: {
  checkpoint: ParsedCheckpoint | null;
  hasCheckpoint: boolean;
  onOpenPlan: (planCell: string) => void;
}): JSX.Element {
  const { checkpoint, hasCheckpoint, onOpenPlan } = props;

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
      <CheckpointStatusHeader checkpoint={checkpoint} />

      {checkpoint.warnings.length > 0 && (
        <div className="session-log-warnings" role="alert">
          {checkpoint.warnings.map((warning) => (
            <p key={warning}>⚠ {warning}</p>
          ))}
        </div>
      )}

      {checkpoint.next ? (
        <NextBlock next={checkpoint.next} />
      ) : (
        <p className="session-view-muted">No ▶ NEXT block in the checkpoint.</p>
      )}

      <CorrectionPlanPanel checkpoint={checkpoint} />

      <div className="session-log-section">
        <p className="session-log-section-title">Plans ledger</p>
        <LedgerTable rows={checkpoint.ledgerRows} onOpenPlan={onOpenPlan} />
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

// A PR session starts only its primary agent. Additional roles (the PR-fix
// reviewer) launch on demand and restored roles resume their conversations.
function initialPrTabs(
  layout: SessionLayout | undefined,
  roles: readonly SessionAgentRole[],
  primaryRole: SessionAgentRole,
): Map<SessionAgentRole, AgentLaunchMode> {
  const restoredRoles = (layout?.openedRoleTabs ?? []).filter((role) => roles.includes(role));
  if (restoredRoles.length > 0) {
    return new Map(restoredRoles.map((role) => [role, "resume" as AgentLaunchMode]));
  }
  return new Map<SessionAgentRole, AgentLaunchMode>([[primaryRole, "fresh"]]);
}

export function SessionView(props: SessionViewProps): JSX.Element {
  const { session, initialLayout, onLayoutChange, repoMode = false, autoPilotConfig, reviewConfig } = props;
  const kind = session.kind;
  const reviewMode = kind === "review";
  const fixMode = kind === "pr-fix";
  // PR review has one reviewer; PR fix starts with Implementer and exposes a
  // second, on-demand Reviewer stage.
  const prSession = reviewMode || fixMode;
  const prPrimaryRole: SessionAgentRole = fixMode ? "implementer" : "reviewer";
  const sessionAgentRoles = agentRolesForSessionKind(kind);
  const hasCheckpoint = session.checkpointPath !== null;

  // A fresh repo workspace opens with exactly one shell, seeded here (not via an
  // effect) so React 18 StrictMode's double-invoke can't create two.
  const seedRepoShell = useMemo<ShellTab | null>(
    () => (repoMode && !initialLayout?.shellTabs?.length ? { id: crypto.randomUUID(), title: "Shell 1", root: false } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [activeTab, setActiveTab] = useState<string>(() => {
    const restoredActive = initialLayout?.activeTab;
    if (fixMode && !hasCheckpoint && restoredActive === "reviewer") return "implementer";
    return restoredActive ?? seedRepoShell?.id ?? (prSession ? prPrimaryRole : "architect");
  });
  // Agent tabs opened at least once, each with its launch mode; their terminals
  // stay mounted (agents keep running) while another tab is shown. This
  // component is keyed by session.id in the parent, so these initialisers run
  // once per session and the restored layout is not clobbered on re-render.
  const [openedRoleTabs, setOpenedRoleTabs] = useState<Map<SessionAgentRole, AgentLaunchMode>>(() =>
    repoMode
      ? new Map()
      : prSession
        ? initialPrTabs(
            initialLayout,
            fixMode && !hasCheckpoint ? ["implementer"] : sessionAgentRoles,
            prPrimaryRole,
          )
        : initialRoleTabs(initialLayout),
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
  const prFixPushGate = getPrFixPushGate(fixMode ? checkpoint : null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Auto-pilot conductor: per-session on/off, the roles it opened (which auto-submit
  // their wf command), and the last action line shown in the feedback strip.
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  // Auto-pilot exec runs per role: the non-interactive command to run and a
  // generation counter. Bumping the generation remounts the tab (takes control)
  // so each conductor step runs as a fresh process. Empty until the conductor
  // drives a role; manual tabs stay interactive.
  const [roleExecRuns, setRoleExecRuns] = useState<
    Partial<Record<SessionAgentRole, { command: string; environment: Record<string, string>; cwd: string; gen: number }>>
  >({});
  // Roles whose fresh interactive launch should auto-submit its wf command — used
  // only for the architect (which auto-pilot drives interactively to keep context)
  // when its tab isn't open yet.
  const [conductorAutoRoles, setConductorAutoRoles] = useState<Set<SessionAgentRole>>(() => new Set());
  const [conductorLog, setConductorLog] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [reviewPostMsg, setReviewPostMsg] = useState<string | null>(null);
  // No role or shell PTY is mounted until the one dedicated setup PTY confirms
  // there is no command, or completes it and persists setupDone.
  const [setupReady, setSetupReady] = useState(() => repoMode || session.setupDone);
  const [setupFailure, setSetupFailure] = useState<string | null>(null);
  const [setupCompleting, setSetupCompleting] = useState(false);
  const [setupCompletionError, setSetupCompletionError] = useState<string | null>(null);
  // Live terminal handles keyed by tab id (role name or shell tab id), so a
  // file's composer can deliver text into the chosen one.
  const terminalHandles = useRef<Map<string, SessionTerminalHandle>>(new Map());

  function handleSetupReady(): void {
    setSetupFailure(null);
    setSetupCompletionError(null);
    setSetupCompleting(false);
    setSetupReady(true);
  }

  function handleSetupFailed(reason: string): void {
    setSetupFailure(reason);
    setSetupCompletionError(null);
    setSetupCompleting(false);
  }

  function handleContinueAfterSetupRepair(): void {
    if (!setupFailure || setupCompleting) return;
    setSetupCompleting(true);
    setSetupCompletionError(null);
    void continueAfterSetupRepair({
      sessionId: session.id,
      markSetupDone: window.agentCoordinator.sessions.markSetupDone,
      onReady: handleSetupReady,
    }).catch((error: unknown) => {
      setSetupCompleting(false);
      setSetupCompletionError(String(error));
    });
  }

  // Report layout changes up so the workspace can be persisted for restore.
  useEffect(() => {
    onLayoutChange?.(session.id, {
      openedRoleTabs: Array.from(openedRoleTabs.keys()),
      shellTabs,
      activeTab,
    });
  }, [session.id, openedRoleTabs, shellTabs, activeTab, onLayoutChange]);

  // Keep the parsed checkpoint live even when Log is closed. PR Fix uses this
  // state to gate push as the reviewer updates findings and marks the flow DONE.
  useEffect(() => {
    if (repoMode || !hasCheckpoint || !session.checkpointPath) return;
    let cancelled = false;
    let receivedLiveUpdate = false;
    const repoRoot = repoRootOf(session.worktreePath);
    const sessionAbs = joinRendererPath(session.worktreePath, session.checkpointPath);
    void window.agentCoordinator.sessions
      .readCheckpoint(session.id)
      .then((result) => {
        if (!cancelled && !receivedLiveUpdate) setCheckpoint(result);
      })
      .catch(() => {
        if (!cancelled && !receivedLiveUpdate) setCheckpoint(null);
      });
    const unsubscribeChanged = window.agentCoordinator.checkpoints.onChanged((event) => {
      if (event.projectId !== session.projectId) return;
      const changedAbs = joinRendererPath(repoRoot, event.checkpoint.checkpointPath);
      if (changedAbs === sessionAbs) {
        receivedLiveUpdate = true;
        setCheckpoint(event.checkpoint);
      }
    });
    const unsubscribeRemoved = window.agentCoordinator.checkpoints.onRemoved((event) => {
      if (event.projectId !== session.projectId) return;
      const removedAbs = joinRendererPath(repoRoot, event.checkpointPath);
      if (removedAbs === sessionAbs) {
        receivedLiveUpdate = true;
        setCheckpoint(null);
      }
    });
    return () => {
      cancelled = true;
      unsubscribeChanged();
      unsubscribeRemoved();
    };
  }, [session.id, session.projectId, session.worktreePath, session.checkpointPath, hasCheckpoint, repoMode]);

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
    return !isSessionRoleUnlocked(kind, role, hasCheckpoint);
  }

  const disabledHint = fixMode
    ? "Waiting for Implementer to finish, test, commit, and write the review checkpoint."
    : "Finish in Architect first — the checkpoint isn't created yet.";

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

  async function handleOpenPlanFile(planCell: string): Promise<void> {
    for (const candidate of planFileCandidates(planCell)) {
      const info = await window.agentCoordinator.system.resolveFile(candidate, session.worktreePath);
      if (!info.exists) continue;
      handleOpenFile(info.absPath);
      return;
    }
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
      // Optional secondary record: relay a short Slack summary via the agent.
      if (reviewConfig?.slackChannel) {
        terminalHandles.current
          .get("reviewer")
          ?.sendText(buildSlackSummaryCommand(reviewConfig.slackChannel, commentUrl), true);
      }
    } catch (caught) {
      setReviewPostMsg(`Post failed — ${String(caught)}`);
    } finally {
      setPosting(false);
    }
  }

  // Push the committed fixes to the PR branch (git push). Outward action — button only.
  async function handlePushFix(): Promise<void> {
    if (posting || !prFixPushGate.allowed) return;
    setPosting(true);
    setReviewPostMsg("Pushing to the PR branch…");
    try {
      const { output } = await window.agentCoordinator.sessions.pushFixBranch(session.id);
      setReviewPostMsg(`Pushed ✓ ${output}`);
    } catch (caught) {
      setReviewPostMsg(`Push failed — ${String(caught)}`);
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

  // Launch a fresh NON-INTERACTIVE run of `wfPrompt` in the role's tab. Bumping
  // the tab's generation remounts it, which TAKES CONTROL: whatever ran there
  // (a manual agent, or the previous step's run) is torn down and a clean process
  // runs this step. The command is built from the project's CURRENT per-stage
  // config, so switching a stage's agent/model applies on the next step.
  // Turning auto-pilot OFF hands control back to the user: drop every role's exec
  // run so its tab remounts as a normal INTERACTIVE agent instead of staying on
  // the finished one-shot run. (A run still in progress is replaced too — turning
  // it off is an explicit "I'll take it from here".)
  function toggleAutoPilot(): void {
    const turningOff = autoPilotEnabled;
    setAutoPilotEnabled(!autoPilotEnabled);
    if (turningOff) {
      setRoleExecRuns({});
      setConductorAutoRoles(new Set());
    }
  }

  function launchRoleExec(role: SessionAgentRole, wfPrompt: string): void {
    void window.agentCoordinator.sessions
      .buildRoleExec(session.id, role, wfPrompt)
      .then((exec) => {
        // Set the run and open/focus the tab together so it mounts once already in
        // exec mode — never a throwaway interactive agent for a frame.
        setRoleExecRuns((current) => ({
          ...current,
          [role]: {
            command: exec.execCommand,
            environment: exec.environment,
            cwd: exec.cwd,
            gen: (current[role]?.gen ?? 0) + 1,
          },
        }));
        setOpenedRoleTabs((current) => (current.has(role) ? current : new Map(current).set(role, "fresh")));
        setActiveTab(role);
        if (exec.warnings.length > 0) setConductorLog(`⚠ ${roleLabel(role, kind)}: ${exec.warnings[0]}`);
      })
      .catch((error: unknown) => {
        setConductorLog(`✖ ${roleLabel(role, kind)}: no se pudo lanzar (${String(error)})`);
      });
  }

  // Turn a conductor decision into an action on the tabs. A `send` runs the step
  // as a fresh non-interactive process in the role tab (see launchRoleExec) — no
  // typing into a live agent, so no paste/Enter races and clean context per step.
  // Advancement stays checkpoint-driven: the run writes its checkpoint when done.
  //
  // Returns whether the action was DISPATCHED. A `send` returns false only when
  // the role can't run yet (locked until a checkpoint exists) so the conductor
  // retries instead of marking the step done.
  function performConductorAction(action: ConductorAction): boolean {
    if (action.kind === "noop") return true;
    if (action.kind === "send") {
      const role = action.role;
      // The architect (a.k.a. Diagnose) holds the brainstorming/plan context, which
      // a fresh exec run would wipe. So drive it INTERACTIVELY — type + submit the
      // wf into its live agent (best-effort). If its tab isn't open yet, open it
      // and let the launch follow-up auto-submit the wf.
      if (role === "architect") {
        const handle = terminalHandles.current.get(role);
        if (openedRoleTabs.has(role) && handle) {
          handle.deliverWhenIdle(action.command);
          setActiveTab(role);
        } else {
          setConductorAutoRoles((current) => new Set(current).add(role));
          selectRole(role);
        }
        setConductorLog(`▶ ${action.command} · ${roleLabel(role, kind)}`);
        return true;
      }
      if (isRoleDisabled(role)) {
        setConductorLog(`⏸ ${roleLabel(role, kind)} bloqueado — esperando el checkpoint`);
        return false;
      }
      setConductorLog(`▶ ${action.command} · ${roleLabel(role, kind)}`);
      launchRoleExec(role, action.command);
      return true;
    }
    // pause: surface the reason (and the command if any) — the human takes over.
    if (action.role) selectRole(action.role);
    setConductorLog(`⏸ ${action.reason}${action.command ? ` · ${action.command}` : ""}`);
    return true;
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
          ) : prSession ? (
            <>
              <span
                className={`session-topbar-kind ${fixMode ? "session-topbar-kind-fix" : "session-topbar-kind-review"}`}
                title={session.baseBranch ? `${session.branch} vs ${session.baseBranch}` : session.branch}
              >
                {fixMode ? "PR FIX" : "PR REVIEW"}
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
          {fixMode && (
            <button
              type="button"
              className="session-topbar-diff"
              disabled={posting || !prFixPushGate.allowed}
              title={prFixPushGate.reason ?? "Push reviewed fixes to the PR branch (git push)"}
              onClick={() => void handlePushFix()}
            >
              {posting ? "Pushing…" : "Push to PR"}
            </button>
          )}
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
          {!repoMode && !prSession && (
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
              onClick={toggleAutoPilot}
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
                  {fixMode
                    ? prFixPushGate.allowed
                      ? "review passed"
                      : checkpoint?.findingCounts.open
                        ? `${checkpoint.findingCounts.open} ${checkpoint.findingCounts.open === 1 ? "finding" : "findings"} open`
                        : "review in progress"
                    : "checkpoint ready"}
                </span>
              ) : (
                <span className="session-topbar-chip session-topbar-chip-pending">
                  {fixMode ? "implementing" : "brainstorming"}
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {!repoMode && !prSession && autoPilotEnabled && conductorLog && (
        <SessionNotice tone={conductorLog.startsWith("paused") ? "warning" : "info"}>
          {conductorLog}
        </SessionNotice>
      )}

      {prSession && reviewPostMsg && (
        <SessionNotice tone={toneForReviewMessage(reviewPostMsg)}>{reviewPostMsg}</SessionNotice>
      )}

      <div className="session-split">
      <div className="session-main">
      <div className="session-view-tabs" role="tablist" aria-label="Session tabs">
        {!repoMode &&
          sessionAgentRoles.map((role) => {
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
        {!repoMode && !setupReady && (
          <div className="session-terminal-host session-setup-host">
            {setupFailure && (
              <SetupRecoveryBanner
                reason={setupFailure}
                completing={setupCompleting}
                error={setupCompletionError}
                onContinue={handleContinueAfterSetupRepair}
              />
            )}
            <SessionTerminal
              session={session}
              role="setup"
              mode="fresh"
              onSetupReady={handleSetupReady}
              onSetupFailed={handleSetupFailed}
            />
          </div>
        )}
        {setupReady && !repoMode && activeTab === "log" && (
          <div className="session-log-scroll">
            <LogPanel
              checkpoint={checkpoint}
              hasCheckpoint={hasCheckpoint}
              onOpenPlan={(planCell) => void handleOpenPlanFile(planCell)}
            />
          </div>
        )}
        {setupReady && repoMode && !repoActiveTabExists && (
          <div className="pane-empty">
            <p className="pane-empty-title">No tab open</p>
            <p className="pane-empty-hint">
              Use <span className="pane-empty-plus">+</span> to open a shell — or the Files / Diff buttons above.
            </p>
          </div>
        )}
        {setupReady && diffOpen && (
          <div className="session-terminal-host" hidden={activeTab !== "diff"}>
            <GitDiffView worktreePath={session.worktreePath} sendTargets={sendTargets} onSend={handleComposerSend} />
          </div>
        )}
        {setupReady &&
          !repoMode &&
          Array.from(openedRoleTabs.entries()).map(([role, mode]) => {
            const execRun = roleExecRuns[role] ?? null;
            return (
            // The generation in the key remounts the tab for each conductor step,
            // running a fresh process (and taking control of whatever ran before).
            <div
              key={`${role}:${execRun?.gen ?? 0}`}
              className="session-terminal-host"
              hidden={activeTab !== role}
            >
              <SessionTerminal
                ref={(handle) => registerTerminalHandle(role, handle)}
                session={session}
                role={role}
                mode={mode}
                onOpenPath={handleOpenPath}
                hint={roleHint(role, kind, hasCheckpoint)}
                autoSubmitWf={reviewMode || (fixMode && role === "implementer") || conductorAutoRoles.has(role)}
                execRun={execRun ? { command: execRun.command, environment: execRun.environment, cwd: execRun.cwd } : null}
              />
            </div>
            );
          })}
        {setupReady && shellTabs.map((tab) => (
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
        {setupReady && fileTabs.map((tab) => (
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
