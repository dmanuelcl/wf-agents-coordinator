import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
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
  TerminalDataEvent,
  TerminalExitEvent,
} from "../shared/ipc/contract";

const api: AgentCoordinatorApi = {
  projects: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.projectsList),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectsAdd, input),
    update: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.projectsUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.projectsRemove, id),
    pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.projectsPickFolder),
    createEmptyRepo: (parentPath, name) => ipcRenderer.invoke(IPC_CHANNELS.projectsCreateEmptyRepo, parentPath, name),
    cloneRepo: (url, parentPath, name) => ipcRenderer.invoke(IPC_CHANNELS.projectsCloneRepo, url, parentPath, name),
    openInFileManager: (rootPath) => ipcRenderer.invoke(IPC_CHANNELS.projectsOpenInFileManager, rootPath),
  },
  checkpoints: {
    list: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.checkpointsList, projectId),
    onChanged: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: CheckpointChangedEvent): void => cb(payload);
      ipcRenderer.on(CHECKPOINT_IPC_CHANNELS.changed, listener);
      return () => ipcRenderer.removeListener(CHECKPOINT_IPC_CHANNELS.changed, listener);
    },
    onRemoved: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: CheckpointRemovedEvent): void => cb(payload);
      ipcRenderer.on(CHECKPOINT_IPC_CHANNELS.removed, listener);
      return () => ipcRenderer.removeListener(CHECKPOINT_IPC_CHANNELS.removed, listener);
    },
  },
  launch: {
    build: (projectId, checkpointPath, role) =>
      ipcRenderer.invoke(IPC_CHANNELS.launchBuild, projectId, checkpointPath, role),
  },
  sessions: {
    list: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.sessionsList, projectId),
    create: (projectId, input) => ipcRenderer.invoke(IPC_CHANNELS.sessionsCreate, projectId, input),
    remove: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionsRemove, sessionId),
    readCheckpoint: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionsReadCheckpoint, sessionId),
    watchCheckpoint: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionsWatchCheckpoint, sessionId),
    unwatchCheckpoint: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.sessionsUnwatchCheckpoint, sessionId),
    onCheckpointDetected: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: SessionCheckpointDetectedEvent): void => cb(payload);
      ipcRenderer.on(SESSION_IPC_CHANNELS.checkpointDetected, listener);
      return () => ipcRenderer.removeListener(SESSION_IPC_CHANNELS.checkpointDetected, listener);
    },
    buildRoleLaunch: (sessionId, role, mode) =>
      ipcRenderer.invoke(IPC_CHANNELS.sessionsBuildRoleLaunch, sessionId, role, mode),
  },
  terminal: {
    create: (input) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.create, input),
    // input carries optional launchCommand; forwarded verbatim above.
    write: (sessionId, data) => ipcRenderer.send(TERMINAL_IPC_CHANNELS.write, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(TERMINAL_IPC_CHANNELS.resize, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.send(TERMINAL_IPC_CHANNELS.kill, sessionId),
    readScrollback: (persistKey) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.readScrollback, persistKey),
    clearScrollback: (persistKey) => ipcRenderer.invoke(TERMINAL_IPC_CHANNELS.clearScrollback, persistKey),
    onData: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: TerminalDataEvent): void => cb(payload);
      ipcRenderer.on(TERMINAL_IPC_CHANNELS.data, listener);
      return () => ipcRenderer.removeListener(TERMINAL_IPC_CHANNELS.data, listener);
    },
    onExit: (cb) => {
      const listener = (_event: IpcRendererEvent, payload: TerminalExitEvent): void => cb(payload);
      ipcRenderer.on(TERMINAL_IPC_CHANNELS.exit, listener);
      return () => ipcRenderer.removeListener(TERMINAL_IPC_CHANNELS.exit, listener);
    },
  },
  sessionState: {
    get: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.sessionStateGet, projectId),
    set: (projectId, state) => ipcRenderer.invoke(IPC_CHANNELS.sessionStateSet, projectId, state),
  },
  workspace: {
    getLayout: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGetLayout),
    setLayout: (layout) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSetLayout, layout),
  },
  system: {
    openPath: (pathToken, cwd) => ipcRenderer.invoke(IPC_CHANNELS.systemOpenPath, pathToken, cwd),
    copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.systemCopyText, text),
    resolveFile: (pathToken, cwd) => ipcRenderer.invoke(IPC_CHANNELS.systemResolveFile, pathToken, cwd),
    readFile: (absPath) => ipcRenderer.invoke(IPC_CHANNELS.systemReadFile, absPath),
    writeFile: (absPath, content) => ipcRenderer.invoke(IPC_CHANNELS.systemWriteFile, absPath, content),
    gitDiff: (worktreePath) => ipcRenderer.invoke(IPC_CHANNELS.systemGitDiff, worktreePath),
    listDir: (dirPath) => ipcRenderer.invoke(IPC_CHANNELS.systemListDir, dirPath),
    // Renderer-only (webUtils), not an IPC channel — resolves a dropped File to
    // its absolute path so a terminal can attach it.
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
  worktree: {
    detect: (projectId, slug) => ipcRenderer.invoke(IPC_CHANNELS.worktreeDetect, projectId, slug),
    buildPlan: (projectId, slug, branch) => ipcRenderer.invoke(IPC_CHANNELS.worktreeBuildPlan, projectId, slug, branch),
    create: (projectId, slug, branch) => ipcRenderer.invoke(IPC_CHANNELS.worktreeCreate, projectId, slug, branch),
  },
};

contextBridge.exposeInMainWorld("agentCoordinator", api);
