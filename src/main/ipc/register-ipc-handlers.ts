import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { AgentLaunchMode, ProjectCreateInput, SessionCreateInput, SessionRoleLaunch } from "../../shared/ipc/contract";
import { CHECKPOINT_IPC_CHANNELS, IPC_CHANNELS } from "../../shared/ipc/contract";
import { buildAgentLaunchCommand, buildAgentSetupMessages } from "../../shared/workflow/agent-runtime-config";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import { buildRoleLaunchPlan } from "../../shared/workflow/role-launch-plan";
import type { LaunchRole } from "../../shared/workflow/role-launch-plan";
import { stageForSessionRole, wfCommandForSessionRole } from "../../shared/workflow/session-role-launch";
import type { SessionAgentRole } from "../../shared/workflow/session-role-launch";
import type { CheckpointWatchManager } from "../projects/checkpoint-watch-manager";
import { scanProjectCheckpoints } from "../projects/checkpoint-scanner";
import type { ProjectRecord, ProjectRegistry, ProjectUpdateInput } from "../projects/project-registry";
import { cloneRepo, createEmptyRepo } from "../projects/project-source";
import type { SessionCheckpointWatchManager } from "../projects/session-checkpoint-watch-manager";
import type { SessionRegistry } from "../projects/session-registry";
import type { WorkspaceLayout, WorkspaceLayoutStore } from "../projects/workspace-layout-store";
import { claudeConversationExists } from "../terminals/claude-session-store";
import type { SessionAgentUuidStore } from "../terminals/session-agent-uuid-store";
import { getWorktreeDiff } from "../projects/worktree-diff";
import { buildWorktreeCreatePlan, createWorktree, detectWorktree, removeWorktree } from "../projects/worktree-manager";

async function findProject(registry: ProjectRegistry, projectId: string): Promise<ProjectRecord> {
  const projects = await registry.listProjects();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return project;
}

// Resolve a clicked terminal token — relative, `~`-prefixed, absolute, possibly
// with a trailing :line[:col] — to an absolute filesystem path.
function resolveTokenPath(pathToken: string, cwd: string): string {
  const target = pathToken.replace(/:\d+(?::\d+)?$/, "");
  if (target.startsWith("~")) return join(homedir(), target.slice(1));
  if (!isAbsolute(target)) return join(cwd, target);
  return target;
}

export function registerIpcHandlers(params: {
  projectRegistry: ProjectRegistry;
  checkpointWatchManager: CheckpointWatchManager;
  sessionRegistry: SessionRegistry;
  sessionCheckpointWatchManager: SessionCheckpointWatchManager;
  sessionAgentUuidStore: SessionAgentUuidStore;
  workspaceLayoutStore: WorkspaceLayoutStore;
}): void {
  const {
    projectRegistry,
    checkpointWatchManager,
    sessionRegistry,
    sessionCheckpointWatchManager,
    sessionAgentUuidStore,
    workspaceLayoutStore,
  } = params;

  ipcMain.handle(IPC_CHANNELS.projectsList, async () => {
    return projectRegistry.listProjects();
  });

  ipcMain.handle(IPC_CHANNELS.projectsAdd, async (_event, input: ProjectCreateInput) => {
    const project = await projectRegistry.addProject(input);
    await checkpointWatchManager.watchProject(project);
    return project;
  });

  ipcMain.handle(IPC_CHANNELS.projectsUpdate, async (_event, id: string, input: ProjectUpdateInput) => {
    return projectRegistry.updateProject(id, input);
  });

  ipcMain.handle(IPC_CHANNELS.projectsRemove, async (_event, id: string) => {
    await checkpointWatchManager.unwatchProject(id);
    await projectRegistry.removeProject(id);
  });

  ipcMain.handle(IPC_CHANNELS.projectsPickFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.projectsCreateEmptyRepo, async (_event, parentPath: string, name: string) => {
    const { rootPath } = await createEmptyRepo({ parentPath, name });
    return rootPath;
  });

  ipcMain.handle(IPC_CHANNELS.projectsCloneRepo, async (_event, url: string, parentPath: string, name: string) => {
    const { rootPath } = await cloneRepo({ url, parentPath, name });
    return rootPath;
  });

  ipcMain.handle(IPC_CHANNELS.projectsOpenInFileManager, async (_event, rootPath: string) => {
    shell.showItemInFolder(rootPath);
  });

  ipcMain.handle(IPC_CHANNELS.systemOpenPath, async (_event, pathToken: string, cwd: string) => {
    // openPath returns "" on success or an error string (e.g. no such file),
    // which we ignore — a false-positive path match should be a silent no-op.
    await shell.openPath(resolveTokenPath(pathToken, cwd));
  });

  ipcMain.handle(IPC_CHANNELS.systemCopyText, async (_event, text: string) => {
    clipboard.writeText(text);
  });

  ipcMain.handle(IPC_CHANNELS.systemResolveFile, async (_event, pathToken: string, cwd: string) => {
    const absPath = resolveTokenPath(pathToken, cwd);
    let exists = false;
    try {
      exists = (await stat(absPath)).isFile();
    } catch {
      exists = false;
    }
    return { absPath, exists, isMarkdown: /\.mdx?$/i.test(absPath) };
  });

  ipcMain.handle(IPC_CHANNELS.systemReadFile, async (_event, absPath: string) => {
    return readFile(absPath, "utf8");
  });

  ipcMain.handle(IPC_CHANNELS.systemWriteFile, async (_event, absPath: string, content: string) => {
    await writeFile(absPath, content, "utf8");
  });

  ipcMain.handle(IPC_CHANNELS.systemGitDiff, async (_event, worktreePath: string) => {
    return getWorktreeDiff(worktreePath);
  });

  ipcMain.handle(IPC_CHANNELS.systemListDir, async (_event, dirPath: string) => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.name !== ".git")
      .map((entry) => ({ name: entry.name, path: join(dirPath, entry.name), isDirectory: entry.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMain.handle(IPC_CHANNELS.checkpointsList, async (_event, projectId: string) => {
    const project = await findProject(projectRegistry, projectId);
    return scanProjectCheckpoints({ project });
  });

  ipcMain.handle(
    IPC_CHANNELS.launchBuild,
    async (_event, projectId: string, checkpointPath: string, role: LaunchRole) => {
      const project = await findProject(projectRegistry, projectId);
      const checkpoints = await scanProjectCheckpoints({ project });
      const checkpoint = checkpoints.find((candidate) => candidate.checkpointPath === checkpointPath);
      if (!checkpoint) {
        throw new Error(`Checkpoint not found: ${checkpointPath}`);
      }
      return buildRoleLaunchPlan({
        projectRoot: project.rootPath,
        checkpointRelativePath: checkpointPath,
        checkpoint,
        requestedRole: role,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.sessionsList, async (_event, projectId: string) => {
    return sessionRegistry.listSessions({ projectId });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsCreate, async (_event, projectId: string, input: SessionCreateInput) => {
    const project = await findProject(projectRegistry, projectId);
    return sessionRegistry.createSession({
      projectId,
      projectRoot: project.rootPath,
      name: input.name,
      kind: input.kind,
      copyEnv: input.copyEnv,
    });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsRemove, async (_event, sessionId: string) => {
    await sessionCheckpointWatchManager.unwatchSession(sessionId);
    // User-confirmed delete (the renderer gates this): remove the git worktree,
    // then drop the record. The branch is kept so no committed work is lost.
    const session = await sessionRegistry.getSession({ sessionId });
    if (session) {
      const project = await findProject(projectRegistry, session.projectId);
      await removeWorktree({ projectRoot: project.rootPath, worktreePath: session.worktreePath });
    }
    await sessionRegistry.removeSession({ sessionId });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsReadCheckpoint, async (_event, sessionId: string) => {
    const session = await sessionRegistry.getSession({ sessionId });
    if (!session || !session.checkpointPath) {
      return null;
    }
    const absolutePath = join(session.worktreePath, session.checkpointPath);
    let markdown: string;
    try {
      markdown = await readFile(absolutePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseCheckpointMarkdown({ checkpointPath: session.checkpointPath, markdown });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsWatchCheckpoint, async (_event, sessionId: string) => {
    const session = await sessionRegistry.getSession({ sessionId });
    // Nothing to watch for once a checkpoint already exists (the gate has flipped).
    if (!session || session.checkpointPath) {
      return;
    }
    await sessionCheckpointWatchManager.watchSession({ sessionId, worktreePath: session.worktreePath });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsUnwatchCheckpoint, async (_event, sessionId: string) => {
    await sessionCheckpointWatchManager.unwatchSession(sessionId);
  });

  ipcMain.handle(
    IPC_CHANNELS.sessionsBuildRoleLaunch,
    async (_event, sessionId: string, role: SessionAgentRole, mode: AgentLaunchMode): Promise<SessionRoleLaunch> => {
      const session = await sessionRegistry.getSession({ sessionId });
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const project = await findProject(projectRegistry, session.projectId);
      const agentConfig = project.runtimeConfig[stageForSessionRole(role)];

      // `--resume` needs a previously minted id; if we're asked to resume one we
      // never stored (first launch, or the store was cleared), fall back to a
      // clean fresh launch so claude doesn't try to resume a non-existent chat.
      let effectiveMode: AgentLaunchMode = mode;
      let uuid = mode === "resume" ? await sessionAgentUuidStore.get({ sessionId, role }) : null;

      // Even with a stored id, `claude --resume` fails ("No conversation found")
      // when the tab was opened but its pre-typed command was never sent, so
      // nothing was written to disk. Only resume when the conversation file
      // exists; otherwise launch fresh and REUSE the id, so a later real use
      // persists it and the next restart resumes cleanly.
      if (uuid && mode === "resume" && agentConfig.kind === "claude" && !(await claudeConversationExists(uuid))) {
        effectiveMode = "fresh";
      }

      if (!uuid) {
        effectiveMode = "fresh";
        uuid = randomUUID();
        await sessionAgentUuidStore.set({ sessionId, role, uuid });
      }

      const launch = buildAgentLaunchCommand(agentConfig, { id: uuid, mode: effectiveMode });
      return {
        agentCommand: launch.command,
        wfCommand: wfCommandForSessionRole(role, session.checkpointPath),
        cwd: session.worktreePath,
        sessionUuid: uuid,
        setupMessages: buildAgentSetupMessages(agentConfig),
        warnings: launch.warnings,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.workspaceGetLayout, async () => {
    return workspaceLayoutStore.get();
  });

  ipcMain.handle(IPC_CHANNELS.workspaceSetLayout, async (_event, layout: WorkspaceLayout) => {
    await workspaceLayoutStore.set(layout);
  });

  ipcMain.handle(IPC_CHANNELS.worktreeDetect, async (_event, projectId: string, slug: string) => {
    const project = await findProject(projectRegistry, projectId);
    return detectWorktree({ projectRoot: project.rootPath, slug });
  });

  ipcMain.handle(IPC_CHANNELS.worktreeBuildPlan, async (_event, projectId: string, slug: string, branch: string) => {
    const project = await findProject(projectRegistry, projectId);
    return buildWorktreeCreatePlan({ projectRoot: project.rootPath, slug, branch });
  });

  ipcMain.handle(IPC_CHANNELS.worktreeCreate, async (_event, projectId: string, slug: string, branch: string) => {
    const project = await findProject(projectRegistry, projectId);
    await createWorktree({ projectRoot: project.rootPath, slug, branch });
  });
}
