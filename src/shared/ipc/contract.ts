import type { ProjectRecord, ProjectUpdateInput } from "../../main/projects/project-registry";
import type { WorktreeCreatePlan, WorktreeDetection } from "../../main/projects/worktree-manager";
import type { ProjectSessionState } from "../../main/terminals/session-state-store";
import type { WorkspaceLayout } from "../../main/projects/workspace-layout-store";
import type { RunnerSessionRuntimeRecord, RunnerTerminalRecord } from "../../main/projects/session-runtime-store";
import type { AgentKind, ProjectRuntimeConfig } from "../workflow/agent-runtime-config";
import type { AutoPilotConfig } from "../workflow/auto-pilot-config";
import type { ReviewConfig } from "../workflow/review-config";
import type { VcsConfig } from "../workflow/vcs-config";
import type { ResolvedPr } from "../../main/vcs/vcs-provider";
export type { ResolvedPr };
import type { LaunchRole, RoleLaunchPlan } from "../workflow/role-launch-plan";
import type { SessionAgentRole } from "../workflow/session-role-launch";
import type { WorkSession, WorkSessionKind } from "../workflow/work-session";
import type { ParsedCheckpoint } from "../workflow/workflow-types";

export type { ProjectRecord, ProjectUpdateInput } from "../../main/projects/project-registry";
export type { WorktreeCreatePlan, WorktreeDetection } from "../../main/projects/worktree-manager";
export type { ProjectSessionState } from "../../main/terminals/session-state-store";
export type { RunnerSessionRuntimeRecord, RunnerTerminalRecord } from "../../main/projects/session-runtime-store";
export type {
  WorkspaceLayout,
  PersistedSessionLayout,
  PersistedShellTab,
} from "../../main/projects/workspace-layout-store";
export type { WorkSession, WorkSessionKind } from "../workflow/work-session";
export type { SessionAgentRole } from "../workflow/session-role-launch";

export type AgentLaunchMode = "fresh" | "resume";

// Everything the renderer needs to launch one role's agent terminal: the CLI
// command to run as the PTY process, the `wf` message to pre-type (no newline —
// the user submits it), the worktree to run in, the minted/looked-up
// conversation id, and any launch warnings.
export interface SessionRoleLaunch {
  agentCommand: string;
  agentKind: AgentKind;
  environment: Record<string, string>;
  wfCommand: string | null;
  cwd: string;
  sessionUuid: string | null;
  warnings: string[];
}

/**
 * An auto-pilot step launch: an INTERACTIVE (watchable) agent seeded with a wf
 * command. `command` usually embeds the wf as an argument; when the CLI can't
 * take it as an arg, `typePrompt` is the wf to type into the agent after launch.
 */
export interface SessionRoleAutopilot {
  command: string;
  agentKind: AgentKind;
  environment: Record<string, string>;
  cwd: string;
  sessionLane: string;
  sessionUuid: string | null;
  typePrompt: string | null;
  warnings: string[];
}

export interface SessionSetupPlan {
  // ready: no command is needed/already done; run: this caller owns the setup;
  // wait: another caller owns it and this caller must retry without launching.
  state: "ready" | "run" | "wait";
  command: string | null;
  cwd: string;
}

export interface ProjectCreateInput {
  rootPath: string;
  name?: string;
  iconDataUrl?: string | null;
  runtimeConfig?: ProjectRuntimeConfig;
  autoPilot?: AutoPilotConfig;
  review?: ReviewConfig;
  vcs?: VcsConfig;
  setupCommand?: string;
}

export interface SessionCreateInput {
  name: string;
  kind: WorkSessionKind;
  // Copy the project's gitignored .env files into the new worktree so it can run.
  copyEnv?: boolean;
  // Clone ignored dist/generated output from the clean repo root and consider
  // the setup satisfied. Obvious revision mismatches fail instead of being copied.
  reuseBuildArtifacts?: boolean;
}

export interface ReviewSessionCreateInput {
  name: string;
  // The branch under review (local like "feature/x" or remote like "origin/feature/x").
  reviewBranch: string;
  // The branch to review against (e.g. "main" / "develop").
  baseBranch: string;
}

export interface BranchList {
  local: string[];
  remote: string[];
}

export const IPC_CHANNELS = {
  projectsList: "projects:list",
  projectsAdd: "projects:add",
  projectsUpdate: "projects:update",
  projectsRemove: "projects:remove",
  projectsPickFolder: "projects:pick-folder",
  projectsCreateEmptyRepo: "projects:create-empty-repo",
  projectsCloneRepo: "projects:clone-repo",
  projectsOpenInFileManager: "projects:open-in-file-manager",
  systemOpenPath: "system:open-path",
  systemOpenExternal: "system:open-external",
  systemCopyText: "system:copy-text",
  systemResolveFile: "system:resolve-file",
  systemReadFile: "system:read-file",
  systemWriteFile: "system:write-file",
  systemGitDiff: "system:git-diff",
  systemListDir: "system:list-dir",
  checkpointsList: "checkpoints:list",
  launchBuild: "launch:build",
  sessionsList: "sessions:list",
  sessionsCreate: "sessions:create",
  sessionsCreateReview: "sessions:create-review",
  sessionsCreateReviewFromPr: "sessions:create-review-from-pr",
  sessionsCreateFixFromPr: "sessions:create-fix-from-pr",
  sessionsPushFixBranch: "sessions:push-fix-branch",
  sessionsPostReview: "sessions:post-review",
  sessionsClaimSetup: "sessions:claim-setup",
  sessionsReleaseSetup: "sessions:release-setup",
  sessionsMarkSetupDone: "sessions:mark-setup-done",
  sessionsReviewArtifactExists: "sessions:review-artifact-exists",
  sessionsRemove: "sessions:remove",
  gitListBranches: "git:list-branches",
  gitResolvePrUrl: "git:resolve-pr-url",
  gitTestVcs: "git:test-vcs",
  projectsSetVcsToken: "projects:set-vcs-token",
  projectsHasVcsCreds: "projects:has-vcs-creds",
  sessionsReadCheckpoint: "sessions:read-checkpoint",
  sessionsWatchCheckpoint: "sessions:watch-checkpoint",
  sessionsUnwatchCheckpoint: "sessions:unwatch-checkpoint",
  sessionsBuildRoleLaunch: "sessions:build-role-launch",
  sessionsBuildRoleAutopilot: "sessions:build-role-autopilot",
  sessionsRecordRoleAgentSession: "sessions:record-role-agent-session",
  sessionsEnsureRuntime: "sessions:ensure-runtime",
  sessionsGetRuntime: "sessions:get-runtime",
  sessionsOpenRole: "sessions:open-role",
  sessionsOpenShell: "sessions:open-shell",
  sessionsCloseTerminal: "sessions:close-terminal",
  sessionsSkipFailedSetup: "sessions:skip-failed-setup",
  sessionsSetAutopilot: "sessions:set-autopilot",
  sessionsRunCommand: "sessions:run-command",
  sessionsRestoreView: "sessions:restore-view",
  sessionStateGet: "session-state:get",
  sessionStateSet: "session-state:set",
  workspaceGetLayout: "workspace:get-layout",
  workspaceSetLayout: "workspace:set-layout",
  worktreeDetect: "worktree:detect",
  worktreeBuildPlan: "worktree:build-plan",
  worktreeCreate: "worktree:create",
} as const;

export const TERMINAL_IPC_CHANNELS = {
  create: "terminal:create",
  attach: "terminal:attach",
  setDisplayGeometry: "terminal:set-display-geometry",
  write: "terminal:write",
  resize: "terminal:resize",
  kill: "terminal:kill",
  data: "terminal:data",
  exit: "terminal:exit",
  initialInputDelivered: "terminal:initial-input-delivered",
  readScrollback: "terminal:read-scrollback",
  clearScrollback: "terminal:clear-scrollback",
} as const;

export const CHECKPOINT_IPC_CHANNELS = {
  changed: "checkpoint:changed",
  removed: "checkpoint:removed",
} as const;

export const SESSION_IPC_CHANNELS = {
  checkpointDetected: "session:checkpoint-detected",
  runtimeChanged: "session:runtime-changed",
} as const;

export interface CheckpointChangedEvent {
  projectId: string;
  checkpoint: ParsedCheckpoint;
}

export interface CheckpointRemovedEvent {
  projectId: string;
  checkpointPath: string;
}

// Fired once, when a session's first checkpoint file appears in its worktree —
// the signal that flips the session from Architect-only to fully enabled.
export interface SessionCheckpointDetectedEvent {
  sessionId: string;
  checkpointPath: string;
}

/** Runner-owned lifecycle update. The browser uses it only to redraw. */
export interface SessionRuntimeChangedEvent {
  sessionId: string;
  setupDone: boolean;
  runtime: RunnerSessionRuntimeRecord;
}

/**
 * A persisted browser layout is only a declaration of tabs the user had open.
 * The runner validates it and decides which terminal intents to restore.
 */
export interface SessionViewRestoreIntent {
  roles: SessionAgentRole[];
  shells: Array<{ id: string; title?: string; root?: boolean }>;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  code: number;
}

/** Emitted by the runner after it safely submits a deferred initial prompt. */
export interface TerminalInitialInputEvent {
  sessionId: string;
}

/** A runner-owned rendering of a live PTY, used to hydrate a new viewer. */
export interface TerminalScreenSnapshot {
  cols: number;
  rows: number;
  alternateScreen: boolean;
  lines: string[];
  cursorX: number;
  cursorY: number;
}

export interface TerminalCreateResult {
  sessionId: string;
  // True when a remote client reattached to a still-running terminal rather
  // than spawning another agent process after a reconnect.
  reused: boolean;
  // A full-screen TUI (Claude, vim, etc.) owns the alternate screen. Its raw
  // output cannot be replayed as normal scrollback; use the runner snapshot.
  alternateScreen?: true;
  // Present for a live persistent terminal. This is an observation of the
  // runner's screen, not a request that can change the PTY.
  snapshot?: TerminalScreenSnapshot;
}

export interface TerminalApi {
  // Reattach to a persistent terminal without spawning anything. Returns null
  // when the runner no longer has a live PTY for this key.
  attach(persistKey: string): Promise<TerminalCreateResult | null>;
  // The active view may update only the terminal's display grid. This sends
  // SIGWINCH to the existing process; it never launches, restarts or prompts
  // an agent.
  setDisplayGeometry(sessionId: string, cols: number, rows: number): Promise<TerminalScreenSnapshot | null>;
  // Keyboard input and display geometry are the only PTY mutations exposed to
  // a view; neither can launch or restart a process.
  write(sessionId: string, data: string): void;
  // Bounded scrollback restore for shell tabs (visual history only).
  readScrollback(persistKey: string): Promise<string>;
  onData(cb: (e: TerminalDataEvent) => void): () => void;
  onExit(cb: (e: TerminalExitEvent) => void): () => void;
}

export interface SystemFileInfo {
  absPath: string;
  exists: boolean;
  isMarkdown: boolean;
}

export interface SystemDirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface AgentCoordinatorApi {
  connection: {
    mode: "local" | "remote";
    endpoint?: string;
    // Resolves only after a remote runner has authenticated the client. Local
    // mode resolves immediately; renderers use this to avoid showing an
    // authenticated-looking workspace for a rejected remote connection.
    connect(): Promise<void>;
  };
  projects: {
    list(): Promise<ProjectRecord[]>;
    add(input: ProjectCreateInput): Promise<ProjectRecord>;
    update(id: string, input: ProjectUpdateInput): Promise<ProjectRecord>;
    remove(id: string): Promise<void>;
    pickFolder(): Promise<string | null>;
    createEmptyRepo(parentPath: string, name: string): Promise<string>;
    cloneRepo(url: string, parentPath: string, name: string): Promise<string>;
    openInFileManager(rootPath: string): Promise<void>;
    setVcsToken(projectId: string, token: string): Promise<void>;
    hasVcsCreds(projectId: string): Promise<boolean>;
  };
  checkpoints: {
    list(projectId: string): Promise<ParsedCheckpoint[]>;
    onChanged(cb: (e: CheckpointChangedEvent) => void): () => void;
    onRemoved(cb: (e: CheckpointRemovedEvent) => void): () => void;
  };
  launch: {
    build(projectId: string, checkpointPath: string, role: LaunchRole): Promise<RoleLaunchPlan>;
  };
  git: {
    listBranches(projectId: string): Promise<BranchList>;
    resolvePrUrl(projectId: string, url: string): Promise<ResolvedPr>;
    // Verify VCS creds/host/repo. token is the just-typed value (or null to use
    // the stored one for projectId). Resolves with the repo's full name, rejects
    // with the host error on failure.
    testVcs(input: { config: VcsConfig; token: string | null; projectId: string | null }): Promise<{ detail: string }>;
  };
  sessions: {
    list(projectId: string): Promise<WorkSession[]>;
    create(projectId: string, input: SessionCreateInput): Promise<WorkSession>;
    createReview(projectId: string, input: ReviewSessionCreateInput): Promise<WorkSession>;
    createReviewFromPr(projectId: string, input: { url: string }): Promise<WorkSession>;
    createFixFromPr(projectId: string, input: { url: string }): Promise<WorkSession>;
    pushFixBranch(sessionId: string): Promise<{ output: string }>;
    postReview(sessionId: string): Promise<{ commentUrl: string }>;
    reviewArtifactExists(sessionId: string): Promise<boolean>;
    remove(sessionId: string): Promise<void>;
    readCheckpoint(sessionId: string): Promise<ParsedCheckpoint | null>;
    onCheckpointDetected(cb: (e: SessionCheckpointDetectedEvent) => void): () => void;
    ensureRuntime(sessionId: string): Promise<RunnerSessionRuntimeRecord>;
    getRuntime(sessionId: string): Promise<RunnerSessionRuntimeRecord | null>;
    openRole(sessionId: string, role: SessionAgentRole): Promise<RunnerTerminalRecord>;
    openShell(sessionId: string, root: boolean): Promise<RunnerTerminalRecord>;
    closeTerminal(sessionId: string, key: string): Promise<void>;
    skipFailedSetup(sessionId: string): Promise<void>;
    setAutopilot(sessionId: string, enabled: boolean): Promise<RunnerSessionRuntimeRecord>;
    runCommand(sessionId: string, role: SessionAgentRole, lane: string, command: string): Promise<void>;
    restoreView(sessionId: string, intent: SessionViewRestoreIntent): Promise<RunnerSessionRuntimeRecord>;
    onRuntimeChanged(cb: (e: SessionRuntimeChangedEvent) => void): () => void;
  };
  terminal: TerminalApi;
  sessionState: {
    get(projectId: string): Promise<ProjectSessionState | null>;
    set(projectId: string, state: ProjectSessionState): Promise<void>;
  };
  workspace: {
    getLayout(): Promise<WorkspaceLayout | null>;
    setLayout(layout: WorkspaceLayout): Promise<void>;
  };
  system: {
    // Open a file path clicked in a terminal. `pathToken` may be relative,
    // absolute, `~`-prefixed, or carry a `:line:col` suffix; resolved against
    // `cwd` in the main process and opened in the OS default app.
    openPath(pathToken: string, cwd: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
    // Resolve a clicked terminal token to decide how to open it (in-app md tab
    // vs OS app).
    resolveFile(pathToken: string, cwd: string): Promise<SystemFileInfo>;
    readFile(absPath: string): Promise<string>;
    writeFile(absPath: string, content: string): Promise<void>;
    // The session's git diff (branch point → now), for the worktree.
    gitDiff(worktreePath: string): Promise<string>;
    // One directory's entries (dirs first, then files), for the file tree.
    listDir(dirPath: string): Promise<SystemDirEntry[]>;
    // The absolute path of a dragged/dropped File (Electron `webUtils`). Sync,
    // renderer-only (not an IPC channel) — used to attach a file/image path to a
    // terminal so the agent can read it.
    getPathForFile(file: File): string;
  };
  worktree: {
    detect(projectId: string, slug: string): Promise<WorktreeDetection>;
    buildPlan(projectId: string, slug: string, branch: string): Promise<WorktreeCreatePlan>;
    create(projectId: string, slug: string, branch: string): Promise<void>;
  };
}
