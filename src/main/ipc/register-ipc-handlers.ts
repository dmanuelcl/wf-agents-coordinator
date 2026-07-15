import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type {
  AgentLaunchMode,
  ProjectCreateInput,
  ReviewSessionCreateInput,
  SessionCreateInput,
  SessionRoleLaunch,
} from "../../shared/ipc/contract";
import { substituteReviewKickoff } from "../../shared/workflow/review-config";
import { buildPrReviewKickoff } from "../../shared/workflow/pr-review-kickoff";
import { buildPrFixKickoff } from "../../shared/workflow/pr-fix-kickoff";
import type { PrLink, WorkSession } from "../../shared/workflow/work-session";
import type { VcsConfig } from "../../shared/workflow/vcs-config";
import { listGitBranches } from "../projects/git-branches";
import { REVIEW_ARTIFACT } from "../projects/session-registry";
import { getProvider } from "../vcs/get-provider";
import { parsePrUrl, REVIEW_COMMENT_MARKER } from "../vcs/vcs-provider";
import type { PrRef } from "../vcs/vcs-provider";
import type { VcsSecretStore } from "../vcs/vcs-secret-store";

function prRefOf(pr: PrLink): PrRef {
  return { host: pr.host, workspace: pr.workspace, repo: pr.repo, prId: pr.prId, url: pr.url };
}

// Build provider creds from a (possibly whitespace) email + token. A blank email
// → no email (Bearer / x-token-auth fallback); set → Basic(email:token). Shared
// by every VCS call so the "Test" and "Check"/resolve paths can't diverge.
function credsFrom(email: string, token: string): { token: string; email?: string } {
  return email.trim() ? { token, email: email.trim() } : { token };
}
import { CHECKPOINT_IPC_CHANNELS, IPC_CHANNELS } from "../../shared/ipc/contract";
import { buildAgentLaunchCommand, buildAgentSetupMessages } from "../../shared/workflow/agent-runtime-config";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import { buildRoleLaunchPlan } from "../../shared/workflow/role-launch-plan";
import type { LaunchRole } from "../../shared/workflow/role-launch-plan";
import {
  shouldInjectRoleCommand,
  stageForSessionRole,
  wfCommandForSessionRole,
} from "../../shared/workflow/session-role-launch";
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
  vcsSecretStore: VcsSecretStore;
}): void {
  const {
    projectRegistry,
    checkpointWatchManager,
    sessionRegistry,
    sessionCheckpointWatchManager,
    sessionAgentUuidStore,
    workspaceLayoutStore,
    vcsSecretStore,
  } = params;

  // Combine the project's non-secret VCS config with its stored token.
  async function vcsCredentialsFor(project: ProjectRecord): Promise<{ token: string; email?: string }> {
    const token = await vcsSecretStore.getToken(project.id);
    if (!token) throw new Error("No VCS token configured for this project.");
    return credsFrom(project.vcs.email, token);
  }

  // The command auto-typed into a reviewer/agent tab: a `wf` command normally, a
  // review kickoff for a review session, or the progressive PR kickoff (with
  // prior reports pulled from the PR) for a PR-link review.
  async function buildReviewOrWfCommand(
    session: WorkSession,
    project: ProjectRecord,
    role: SessionAgentRole,
  ): Promise<string | null> {
    // PR fix: the implementer reads ALL PR comments and implements them.
    if (session.kind === "pr-fix" && role === "implementer" && session.pr) {
      let comments: { body: string; inline?: { path: string; line: number | null } }[] = [];
      try {
        const all = await getProvider(session.pr.host).listReviewComments(
          prRefOf(session.pr),
          await vcsCredentialsFor(project),
        );
        comments = all
          .slice()
          .sort((a, b) => a.createdAtEpochMs - b.createdAtEpochMs)
          .map((c) => ({ body: c.body, inline: c.inline }));
      } catch {
        comments = [];
      }
      return buildPrFixKickoff({
        title: session.name,
        source: session.branch,
        target: session.baseBranch ?? "",
        comments,
      });
    }

    if (session.kind !== "review" || role !== "reviewer") {
      return wfCommandForSessionRole(role, session.checkpointPath);
    }
    if (!session.pr) {
      return substituteReviewKickoff(project.review.kickoff, { branch: session.branch, base: session.baseBranch ?? "" });
    }
    let priorReports: string[] = [];
    try {
      const comments = await getProvider(session.pr.host).listReviewComments(
        prRefOf(session.pr),
        await vcsCredentialsFor(project),
      );
      priorReports = comments.filter((c) => c.authoredByTool).map((c) => c.body);
    } catch {
      // Offline / no prior comments — fall back to a non-progressive kickoff.
      priorReports = [];
    }
    return buildPrReviewKickoff({
      template: project.review.kickoff,
      branch: session.branch,
      base: session.baseBranch ?? "",
      priorReports,
      lastReviewedSha: session.pr.lastReviewedSha,
      artifactFile: REVIEW_ARTIFACT,
    });
  }

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

  ipcMain.handle(IPC_CHANNELS.systemOpenExternal, async (_event, url: string) => {
    // Only open http(s) links in the browser — never arbitrary schemes.
    if (/^https?:\/\//.test(url)) await shell.openExternal(url);
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

  ipcMain.handle(
    IPC_CHANNELS.sessionsCreateReview,
    async (_event, projectId: string, input: ReviewSessionCreateInput) => {
      const project = await findProject(projectRegistry, projectId);
      return sessionRegistry.createReviewSession({
        projectId,
        projectRoot: project.rootPath,
        name: input.name,
        reviewBranch: input.reviewBranch,
        baseBranch: input.baseBranch,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.gitListBranches, async (_event, projectId: string) => {
    const project = await findProject(projectRegistry, projectId);
    return listGitBranches({ projectRoot: project.rootPath });
  });

  ipcMain.handle(IPC_CHANNELS.projectsSetVcsToken, async (_event, projectId: string, token: string) => {
    // A blank token clears it.
    if (token.trim()) await vcsSecretStore.setToken(projectId, token.trim());
    else await vcsSecretStore.deleteToken(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.projectsHasVcsCreds, async (_event, projectId: string) => {
    return vcsSecretStore.hasToken(projectId);
  });

  ipcMain.handle(
    IPC_CHANNELS.gitTestVcs,
    async (_event, input: { config: VcsConfig; token: string | null; projectId: string | null }) => {
      const { config } = input;
      if (config.host === "none") throw new Error("Pick a VCS host first.");
      if (!config.workspace.trim() || !config.repo.trim()) throw new Error("Set the workspace and repo first.");
      let token = input.token?.trim() || null;
      if (!token && input.projectId) token = await vcsSecretStore.getToken(input.projectId);
      if (!token) throw new Error("Enter an API token to test.");
      const creds = credsFrom(config.email, token);
      return getProvider(config.host).verifyAccess(
        { workspace: config.workspace.trim(), repo: config.repo.trim() },
        creds,
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.gitResolvePrUrl, async (_event, projectId: string, url: string) => {
    const project = await findProject(projectRegistry, projectId);
    if (project.vcs.host === "none") throw new Error("This project has no VCS host configured.");
    const ref = parsePrUrl(project.vcs.host, url);
    if (!ref) throw new Error("Could not parse a PR from that URL for the configured host.");
    return getProvider(project.vcs.host).resolvePr(ref, await vcsCredentialsFor(project));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsCreateReviewFromPr, async (_event, projectId: string, input: { url: string }) => {
    const project = await findProject(projectRegistry, projectId);
    if (project.vcs.host === "none") throw new Error("This project has no VCS host configured.");
    const ref = parsePrUrl(project.vcs.host, input.url);
    if (!ref) throw new Error("Could not parse a PR from that URL for the configured host.");
    const resolved = await getProvider(project.vcs.host).resolvePr(ref, await vcsCredentialsFor(project));
    // Review the PR's pushed state: origin/<source> against origin/<target>.
    return sessionRegistry.createReviewSession({
      projectId,
      projectRoot: project.rootPath,
      name: `PR #${resolved.prId}: ${resolved.title}`,
      reviewBranch: `origin/${resolved.source}`,
      baseBranch: `origin/${resolved.target}`,
      pr: {
        host: resolved.host,
        workspace: resolved.workspace,
        repo: resolved.repo,
        prId: resolved.prId,
        url: resolved.url,
        lastReviewedSha: null,
      },
      fetchFirst: true,
    });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsCreateFixFromPr, async (_event, projectId: string, input: { url: string }) => {
    const project = await findProject(projectRegistry, projectId);
    if (project.vcs.host === "none") throw new Error("This project has no VCS host configured.");
    const ref = parsePrUrl(project.vcs.host, input.url);
    if (!ref) throw new Error("Could not parse a PR from that URL for the configured host.");
    const resolved = await getProvider(project.vcs.host).resolvePr(ref, await vcsCredentialsFor(project));
    // Writable checkout of the PR source branch; base kept for diff context.
    return sessionRegistry.createFixSession({
      projectId,
      projectRoot: project.rootPath,
      name: `Fix PR #${resolved.prId}: ${resolved.title}`,
      branch: resolved.source,
      baseBranch: `origin/${resolved.target}`,
      pr: {
        host: resolved.host,
        workspace: resolved.workspace,
        repo: resolved.repo,
        prId: resolved.prId,
        url: resolved.url,
        lastReviewedSha: null,
      },
    });
  });

  ipcMain.handle(IPC_CHANNELS.sessionsPushFixBranch, async (_event, sessionId: string) => {
    const session = await sessionRegistry.getSession({ sessionId });
    if (!session) throw new Error("Session not found.");
    if (session.kind !== "pr-fix") throw new Error("Only a PR fix session can push.");
    // The branch tracks origin/<source>, so a bare push updates the PR.
    const res = await execFileAsync("git", ["push"], { cwd: session.worktreePath });
    return { output: `${res.stdout}${res.stderr}`.trim() || "Pushed." };
  });

  ipcMain.handle(IPC_CHANNELS.sessionsPostReview, async (_event, sessionId: string) => {
    const session = await sessionRegistry.getSession({ sessionId });
    if (!session || !session.pr) throw new Error("This session has no PR to post to.");
    const project = await findProject(projectRegistry, session.projectId);

    const artifactPath = join(session.worktreePath, REVIEW_ARTIFACT);
    let report: string;
    try {
      report = await readFile(artifactPath, "utf8");
    } catch {
      throw new Error(`No review file (${REVIEW_ARTIFACT}) yet — let the review finish writing it, then post.`);
    }
    if (!report.trim()) throw new Error(`The review file (${REVIEW_ARTIFACT}) is empty.`);

    const body = `${report.trim()}\n\n${REVIEW_COMMENT_MARKER}`;
    const posted = await getProvider(session.pr.host).postComment(
      prRefOf(session.pr),
      body,
      await vcsCredentialsFor(project),
    );

    // Record what we reviewed so the next run is incremental.
    const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: session.worktreePath });
    await sessionRegistry.setReviewedSha({ sessionId, sha: head.stdout.trim() });

    return { commentUrl: posted.url };
  });

  ipcMain.handle(IPC_CHANNELS.sessionsReviewArtifactExists, async (_event, sessionId: string) => {
    const session = await sessionRegistry.getSession({ sessionId });
    if (!session) return false;
    try {
      await stat(join(session.worktreePath, REVIEW_ARTIFACT));
      return true;
    } catch {
      return false;
    }
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
      // A fresh PR session auto-runs its kickoff. A restored PR session only
      // resumes the conversation: injecting it again would repeat the work.
      const wfCommand = shouldInjectRoleCommand(session.kind, mode)
        ? await buildReviewOrWfCommand(session, project, role)
        : null;
      return {
        agentCommand: launch.command,
        wfCommand,
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
