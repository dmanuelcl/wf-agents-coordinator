import type { ProjectRecord, ProjectUpdateInput } from "../../main/projects/project-registry";
import type { WorktreeCreatePlan, WorktreeDetection } from "../../main/projects/worktree-manager";
import type { ProjectSessionState } from "../../main/terminals/session-state-store";
import type { WorkspaceLayout } from "../../main/projects/workspace-layout-store";
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

/** A single-shot NON-INTERACTIVE agent run for the auto-pilot conductor. */
export interface SessionRoleExec {
  execCommand: string;
  agentKind: AgentKind;
  environment: Record<string, string>;
  cwd: string;
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
  sessionsBuildRoleExec: "sessions:build-role-exec",
  sessionsRecordRoleAgentSession: "sessions:record-role-agent-session",
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
  write: "terminal:write",
  resize: "terminal:resize",
  kill: "terminal:kill",
  data: "terminal:data",
  exit: "terminal:exit",
  readScrollback: "terminal:read-scrollback",
  clearScrollback: "terminal:clear-scrollback",
} as const;

export const CHECKPOINT_IPC_CHANNELS = {
  changed: "checkpoint:changed",
  removed: "checkpoint:removed",
} as const;

export const SESSION_IPC_CHANNELS = {
  checkpointDetected: "session:checkpoint-detected",
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

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  code: number;
}

export interface TerminalApi {
  // When `launchCommand` is set the PTY runs that command as its process (the
  // agent CLI); otherwise it opens a plain interactive shell (the `+` tab).
  // `persistKey` opts this terminal into bounded scrollback persistence.
  create(input: {
    cwd: string;
    cols: number;
    rows: number;
    launchCommand?: string | null;
    environment?: Record<string, string>;
    persistKey?: string | null;
  }): Promise<string>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  kill(sessionId: string): void;
  // Bounded scrollback restore for shell tabs (visual history only).
  readScrollback(persistKey: string): Promise<string>;
  clearScrollback(persistKey: string): Promise<void>;
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
    claimSetup(sessionId: string): Promise<SessionSetupPlan>;
    releaseSetup(sessionId: string): Promise<void>;
    markSetupDone(sessionId: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
    readCheckpoint(sessionId: string): Promise<ParsedCheckpoint | null>;
    watchCheckpoint(sessionId: string): Promise<void>;
    unwatchCheckpoint(sessionId: string): Promise<void>;
    onCheckpointDetected(cb: (e: SessionCheckpointDetectedEvent) => void): () => void;
    buildRoleLaunch(sessionId: string, role: SessionAgentRole, mode: AgentLaunchMode): Promise<SessionRoleLaunch>;
    buildRoleExec(sessionId: string, role: SessionAgentRole, wfPrompt: string): Promise<SessionRoleExec>;
    recordRoleAgentSession(sessionId: string, role: SessionAgentRole, agentSessionId: string): Promise<void>;
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
