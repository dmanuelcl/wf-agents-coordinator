import {
  CHECKPOINT_IPC_CHANNELS,
  IPC_CHANNELS,
  SESSION_IPC_CHANNELS,
  TERMINAL_IPC_CHANNELS,
} from "../shared/ipc/contract";
import type {
  AgentCoordinatorApi,
  CheckpointChangedEvent,
  CheckpointRemovedEvent,
  SessionCheckpointDetectedEvent,
  SessionRuntimeChangedEvent,
  TerminalDataEvent,
  TerminalExitEvent,
} from "../shared/ipc/contract";

export interface CoordinatorClientTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  emit(channel: string, ...args: unknown[]): void;
  on(channel: string, callback: (payload: unknown) => void): () => void;
}

export interface AgentCoordinatorApiOptions {
  mode: "local" | "remote";
  endpoint?: string;
  connect?: () => Promise<void>;
  getPathForFile(file: File): string;
  clientSystem?: {
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
  };
}

/** Maps either Electron IPC or a remote WebSocket transport to the one UI API. */
export function createAgentCoordinatorApi(
  transport: CoordinatorClientTransport,
  options: AgentCoordinatorApiOptions,
): AgentCoordinatorApi {
  const invoke = (channel: string, ...args: unknown[]) => transport.invoke(channel, ...args);
  const on = <T>(channel: string, callback: (payload: T) => void) =>
    transport.on(channel, (payload) => callback(payload as T));

  return {
    connection: { mode: options.mode, endpoint: options.endpoint, connect: options.connect ?? (async () => {}) },
    projects: {
      list: () => invoke(IPC_CHANNELS.projectsList) as ReturnType<AgentCoordinatorApi["projects"]["list"]>,
      add: (input) => invoke(IPC_CHANNELS.projectsAdd, input) as ReturnType<AgentCoordinatorApi["projects"]["add"]>,
      update: (id, input) => invoke(IPC_CHANNELS.projectsUpdate, id, input) as ReturnType<AgentCoordinatorApi["projects"]["update"]>,
      remove: (id) => invoke(IPC_CHANNELS.projectsRemove, id) as ReturnType<AgentCoordinatorApi["projects"]["remove"]>,
      pickFolder: () => invoke(IPC_CHANNELS.projectsPickFolder) as ReturnType<AgentCoordinatorApi["projects"]["pickFolder"]>,
      createEmptyRepo: (parentPath, name) => invoke(IPC_CHANNELS.projectsCreateEmptyRepo, parentPath, name) as ReturnType<AgentCoordinatorApi["projects"]["createEmptyRepo"]>,
      cloneRepo: (url, parentPath, name) => invoke(IPC_CHANNELS.projectsCloneRepo, url, parentPath, name) as ReturnType<AgentCoordinatorApi["projects"]["cloneRepo"]>,
      openInFileManager: (rootPath) => invoke(IPC_CHANNELS.projectsOpenInFileManager, rootPath) as ReturnType<AgentCoordinatorApi["projects"]["openInFileManager"]>,
      setVcsToken: (projectId, token) => invoke(IPC_CHANNELS.projectsSetVcsToken, projectId, token) as ReturnType<AgentCoordinatorApi["projects"]["setVcsToken"]>,
      hasVcsCreds: (projectId) => invoke(IPC_CHANNELS.projectsHasVcsCreds, projectId) as ReturnType<AgentCoordinatorApi["projects"]["hasVcsCreds"]>,
    },
    checkpoints: {
      list: (projectId) => invoke(IPC_CHANNELS.checkpointsList, projectId) as ReturnType<AgentCoordinatorApi["checkpoints"]["list"]>,
      onChanged: (callback) => on<CheckpointChangedEvent>(CHECKPOINT_IPC_CHANNELS.changed, callback),
      onRemoved: (callback) => on<CheckpointRemovedEvent>(CHECKPOINT_IPC_CHANNELS.removed, callback),
    },
    launch: {
      build: (projectId, checkpointPath, role) => invoke(IPC_CHANNELS.launchBuild, projectId, checkpointPath, role) as ReturnType<AgentCoordinatorApi["launch"]["build"]>,
    },
    git: {
      listBranches: (projectId) => invoke(IPC_CHANNELS.gitListBranches, projectId) as ReturnType<AgentCoordinatorApi["git"]["listBranches"]>,
      resolvePrUrl: (projectId, url) => invoke(IPC_CHANNELS.gitResolvePrUrl, projectId, url) as ReturnType<AgentCoordinatorApi["git"]["resolvePrUrl"]>,
      testVcs: (input) => invoke(IPC_CHANNELS.gitTestVcs, input) as ReturnType<AgentCoordinatorApi["git"]["testVcs"]>,
    },
    sessions: {
      list: (projectId) => invoke(IPC_CHANNELS.sessionsList, projectId) as ReturnType<AgentCoordinatorApi["sessions"]["list"]>,
      create: (projectId, input) => invoke(IPC_CHANNELS.sessionsCreate, projectId, input) as ReturnType<AgentCoordinatorApi["sessions"]["create"]>,
      createReview: (projectId, input) => invoke(IPC_CHANNELS.sessionsCreateReview, projectId, input) as ReturnType<AgentCoordinatorApi["sessions"]["createReview"]>,
      createReviewFromPr: (projectId, input) => invoke(IPC_CHANNELS.sessionsCreateReviewFromPr, projectId, input) as ReturnType<AgentCoordinatorApi["sessions"]["createReviewFromPr"]>,
      createFixFromPr: (projectId, input) => invoke(IPC_CHANNELS.sessionsCreateFixFromPr, projectId, input) as ReturnType<AgentCoordinatorApi["sessions"]["createFixFromPr"]>,
      pushFixBranch: (sessionId) => invoke(IPC_CHANNELS.sessionsPushFixBranch, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["pushFixBranch"]>,
      postReview: (sessionId) => invoke(IPC_CHANNELS.sessionsPostReview, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["postReview"]>,
      reviewArtifactExists: (sessionId) => invoke(IPC_CHANNELS.sessionsReviewArtifactExists, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["reviewArtifactExists"]>,
      remove: (sessionId) => invoke(IPC_CHANNELS.sessionsRemove, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["remove"]>,
      readCheckpoint: (sessionId) => invoke(IPC_CHANNELS.sessionsReadCheckpoint, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["readCheckpoint"]>,
      onCheckpointDetected: (callback) => on<SessionCheckpointDetectedEvent>(SESSION_IPC_CHANNELS.checkpointDetected, callback),
      ensureRuntime: (sessionId) => invoke(IPC_CHANNELS.sessionsEnsureRuntime, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["ensureRuntime"]>,
      getRuntime: (sessionId) => invoke(IPC_CHANNELS.sessionsGetRuntime, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["getRuntime"]>,
      openRole: (sessionId, role) => invoke(IPC_CHANNELS.sessionsOpenRole, sessionId, role) as ReturnType<AgentCoordinatorApi["sessions"]["openRole"]>,
      openShell: (sessionId, root) => invoke(IPC_CHANNELS.sessionsOpenShell, sessionId, root) as ReturnType<AgentCoordinatorApi["sessions"]["openShell"]>,
      closeTerminal: (sessionId, key) => invoke(IPC_CHANNELS.sessionsCloseTerminal, sessionId, key) as ReturnType<AgentCoordinatorApi["sessions"]["closeTerminal"]>,
      skipFailedSetup: (sessionId) => invoke(IPC_CHANNELS.sessionsSkipFailedSetup, sessionId) as ReturnType<AgentCoordinatorApi["sessions"]["skipFailedSetup"]>,
      setAutopilot: (sessionId, enabled) => invoke(IPC_CHANNELS.sessionsSetAutopilot, sessionId, enabled) as ReturnType<AgentCoordinatorApi["sessions"]["setAutopilot"]>,
      runCommand: (sessionId, role, lane, command) => invoke(IPC_CHANNELS.sessionsRunCommand, sessionId, role, lane, command) as ReturnType<AgentCoordinatorApi["sessions"]["runCommand"]>,
      restoreView: (sessionId, intent) => invoke(IPC_CHANNELS.sessionsRestoreView, sessionId, intent) as ReturnType<AgentCoordinatorApi["sessions"]["restoreView"]>,
      onRuntimeChanged: (callback) => on<SessionRuntimeChangedEvent>(SESSION_IPC_CHANNELS.runtimeChanged, callback),
    },
    terminal: {
      attach: (persistKey) => invoke(TERMINAL_IPC_CHANNELS.attach, persistKey) as ReturnType<AgentCoordinatorApi["terminal"]["attach"]>,
      write: (sessionId, data) => transport.emit(TERMINAL_IPC_CHANNELS.write, sessionId, data),
      readScrollback: (persistKey) => invoke(TERMINAL_IPC_CHANNELS.readScrollback, persistKey) as ReturnType<AgentCoordinatorApi["terminal"]["readScrollback"]>,
      onData: (callback) => on<TerminalDataEvent>(TERMINAL_IPC_CHANNELS.data, callback),
      onExit: (callback) => on<TerminalExitEvent>(TERMINAL_IPC_CHANNELS.exit, callback),
    },
    sessionState: {
      get: (projectId) => invoke(IPC_CHANNELS.sessionStateGet, projectId) as ReturnType<AgentCoordinatorApi["sessionState"]["get"]>,
      set: (projectId, state) => invoke(IPC_CHANNELS.sessionStateSet, projectId, state) as ReturnType<AgentCoordinatorApi["sessionState"]["set"]>,
    },
    workspace: {
      getLayout: () => invoke(IPC_CHANNELS.workspaceGetLayout) as ReturnType<AgentCoordinatorApi["workspace"]["getLayout"]>,
      setLayout: (layout) => invoke(IPC_CHANNELS.workspaceSetLayout, layout) as ReturnType<AgentCoordinatorApi["workspace"]["setLayout"]>,
    },
    system: {
      openPath: (pathToken, cwd) => invoke(IPC_CHANNELS.systemOpenPath, pathToken, cwd) as ReturnType<AgentCoordinatorApi["system"]["openPath"]>,
      openExternal: (url) =>
        (options.clientSystem ? options.clientSystem.openExternal(url) : invoke(IPC_CHANNELS.systemOpenExternal, url)) as ReturnType<AgentCoordinatorApi["system"]["openExternal"]>,
      copyText: (text) =>
        (options.clientSystem ? options.clientSystem.copyText(text) : invoke(IPC_CHANNELS.systemCopyText, text)) as ReturnType<AgentCoordinatorApi["system"]["copyText"]>,
      resolveFile: (pathToken, cwd) => invoke(IPC_CHANNELS.systemResolveFile, pathToken, cwd) as ReturnType<AgentCoordinatorApi["system"]["resolveFile"]>,
      readFile: (absPath) => invoke(IPC_CHANNELS.systemReadFile, absPath) as ReturnType<AgentCoordinatorApi["system"]["readFile"]>,
      writeFile: (absPath, content) => invoke(IPC_CHANNELS.systemWriteFile, absPath, content) as ReturnType<AgentCoordinatorApi["system"]["writeFile"]>,
      gitDiff: (worktreePath) => invoke(IPC_CHANNELS.systemGitDiff, worktreePath) as ReturnType<AgentCoordinatorApi["system"]["gitDiff"]>,
      listDir: (dirPath) => invoke(IPC_CHANNELS.systemListDir, dirPath) as ReturnType<AgentCoordinatorApi["system"]["listDir"]>,
      getPathForFile: options.getPathForFile,
    },
    worktree: {
      detect: (projectId, slug) => invoke(IPC_CHANNELS.worktreeDetect, projectId, slug) as ReturnType<AgentCoordinatorApi["worktree"]["detect"]>,
      buildPlan: (projectId, slug, branch) => invoke(IPC_CHANNELS.worktreeBuildPlan, projectId, slug, branch) as ReturnType<AgentCoordinatorApi["worktree"]["buildPlan"]>,
      create: (projectId, slug, branch) => invoke(IPC_CHANNELS.worktreeCreate, projectId, slug, branch) as ReturnType<AgentCoordinatorApi["worktree"]["create"]>,
    },
  };
}
