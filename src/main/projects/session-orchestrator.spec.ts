import { describe, expect, it, vi } from "vitest";
import { createSessionOrchestrator } from "./session-orchestrator";
import type { ProjectRecord, ProjectRegistry } from "./project-registry";
import type { SessionRegistry } from "./session-registry";
import type { SessionRuntimeStore, RunnerSessionRuntimeRecord } from "./session-runtime-store";
import type { RunnerTerminalController } from "../ipc/register-terminal-ipc-handlers";
import type { WorkSession } from "../../shared/workflow/work-session";

function project(setupCommand = ""): ProjectRecord {
  return {
    id: "project",
    name: "Project",
    rootPath: "/repo",
    checkpointGlobs: [],
    iconDataUrl: null,
    runtimeConfig: {
      architect: { kind: "codex", model: "", effort: null, dangerous: false },
      implementer: { kind: "codex", model: "", effort: null, dangerous: false },
      reviewer: { kind: "codex", model: "", effort: null, dangerous: false },
    },
    autoPilot: { reloopLimit: 3, settleDelayMs: 500 },
    review: { kickoff: "review {branch} vs {base}", slackChannel: "" },
    vcs: { host: "none", workspace: "", repo: "", email: "" },
    setupCommand,
    createdAtEpochMs: 0,
    updatedAtEpochMs: 0,
  };
}

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "session",
    projectId: "project",
    name: "Review",
    kind: "review",
    slug: "review",
    branch: "origin/feature",
    baseBranch: "origin/main",
    pr: null,
    worktreePath: "/repo/.worktrees/review",
    checkpointPath: null,
    setupDone: false,
    createdAtEpochMs: 0,
    ...overrides,
  };
}

function memoryStore(): SessionRuntimeStore {
  const records = new Map<string, RunnerSessionRuntimeRecord>();
  return {
    get: async (id) => records.get(id) ?? null,
    list: async () => Array.from(records.values()),
    put: async (record) => { records.set(record.sessionId, structuredClone(record)); },
    remove: async (id) => { records.delete(id); },
  };
}

describe("createSessionOrchestrator", () => {
  it("runs setup and launches the PR reviewer entirely from the runner transition", async () => {
    const current = session();
    const markSetupDone = vi.fn(async () => { current.setupDone = true; });
    const registry: SessionRegistry = {
      getSession: async () => current,
      listSessions: async () => [current],
      markSetupDone,
      // Not used by this unit; the real registry owns these operations.
      createSession: vi.fn(), createReviewSession: vi.fn(), createFixSession: vi.fn(), updateSessionCheckpoint: vi.fn(), setReviewedSha: vi.fn(), removeSession: vi.fn(),
    } as unknown as SessionRegistry;
    const creates: Parameters<RunnerTerminalController["create"]>[0][] = [];
    let nextId = 0;
    const terminals: RunnerTerminalController = {
      create: async (input) => { creates.push(input); return { sessionId: String(++nextId), reused: false }; },
      replace: vi.fn(),
      attach: async () => null,
      kill: vi.fn(),
      write: vi.fn(),
    };
    const projects: ProjectRegistry = {
      listProjects: async () => [project("pnpm worktree:setup")],
      addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
    } as unknown as ProjectRegistry;
    const orchestrator = createSessionOrchestrator({
      projectRegistry: projects,
      sessionRegistry: registry,
      runtimeStore: memoryStore(),
      terminals,
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async () => ({
      agentCommand: "codex",
      agentKind: "codex",
      environment: {},
      wfCommand: "review this PR",
      cwd: current.worktreePath,
      sessionUuid: null,
      warnings: [],
    }));

    await orchestrator.ensure(current.id);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ launchCommand: "pnpm worktree:setup", setupSessionId: current.id });

    await orchestrator.onSetupExit({ sessionId: current.id, code: 0 });
    expect(markSetupDone).toHaveBeenCalledWith({ sessionId: current.id });
    expect(creates[1]).toMatchObject({
      launchCommand: "codex",
      persistKey: `${current.id}::role::reviewer`,
      initialInput: { text: "review this PR", submit: true },
    });

    // A terminal is not resumable merely because it was spawned. It becomes
    // resumable only after the runner has delivered the auto-submitted prompt.
    expect((await orchestrator.runtime(current.id))?.terminals.find((terminal) => terminal.kind === "agent")?.mode)
      .toBe("fresh");
    orchestrator.onTerminalInitialInputDelivered({ terminalId: "2", submit: true });
    await vi.waitFor(async () => {
      expect((await orchestrator.runtime(current.id))?.terminals.find((terminal) => terminal.kind === "agent")?.mode)
        .toBe("resume");
    });
  });

  it("opens a shell as a runner-owned terminal record", async () => {
    const current = session({ setupDone: true });
    const creates: Parameters<RunnerTerminalController["create"]>[0][] = [];
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current, listSessions: async () => [current], markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async (input) => { creates.push(input); return { sessionId: "pty", reused: false }; },
        replace: vi.fn(), attach: async () => null, kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async () => ({
      agentCommand: "codex", agentKind: "codex", environment: {}, wfCommand: null, cwd: current.worktreePath, sessionUuid: null, warnings: [],
    }));

    const shell = await orchestrator.openShell({ sessionId: current.id, root: true });
    expect(shell.key).toContain(`${current.id}::shell::`);
    expect(creates.at(-1)).toMatchObject({ cwd: "/repo", persistKey: shell.key });
  });

  it("restores every durable runner terminal after a runner restart", async () => {
    const current = session({ setupDone: true });
    const store = memoryStore();
    const live = new Map<string, string>();
    const creates: Parameters<RunnerTerminalController["create"]>[0][] = [];
    let nextId = 0;
    const terminals: RunnerTerminalController = {
      create: async (input) => {
        const sessionId = String(++nextId);
        creates.push(input);
        if (input.persistKey) live.set(input.persistKey, sessionId);
        return { sessionId, reused: false };
      },
      replace: vi.fn(),
      attach: async (key) => {
        const sessionId = live.get(key);
        return sessionId ? { sessionId, reused: true } : null;
      },
      kill: vi.fn(),
      write: vi.fn(),
    };
    const makeOrchestrator = () => {
      const orchestrator = createSessionOrchestrator({
        projectRegistry: {
          listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
        } as unknown as ProjectRegistry,
        sessionRegistry: {
          getSession: async () => current, listSessions: async () => [current], markSetupDone: vi.fn(),
        } as unknown as SessionRegistry,
        runtimeStore: store,
        terminals,
        sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
        readCheckpoint: vi.fn(async () => null),
        broadcast: vi.fn(),
      });
      orchestrator.setRoleLaunchBuilder(async () => ({
        agentCommand: "codex", agentKind: "codex", environment: {}, wfCommand: "review this PR", cwd: current.worktreePath, sessionUuid: null, warnings: [],
      }));
      return orchestrator;
    };

    const firstRunner = makeOrchestrator();
    await firstRunner.ensure(current.id);
    await firstRunner.openShell({ sessionId: current.id, root: true });
    expect(creates).toHaveLength(2);

    // A service restart loses processes, never intent. The replacement runner
    // reconstructs both the primary agent and the user-opened shell from disk.
    live.clear();
    const restartedRunner = makeOrchestrator();
    await restartedRunner.resume();

    expect(creates).toHaveLength(4);
    expect(creates.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ persistKey: `${current.id}::role::reviewer`, launchCommand: "codex" }),
      expect.objectContaining({ persistKey: expect.stringContaining(`${current.id}::shell::`), cwd: "/repo" }),
    ]));
  });
});
