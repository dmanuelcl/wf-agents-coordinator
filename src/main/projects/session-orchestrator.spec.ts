import { describe, expect, it, vi } from "vitest";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import { createSessionOrchestrator } from "./session-orchestrator";
import type { ProjectRecord, ProjectRegistry } from "./project-registry";
import type { SessionRegistry } from "./session-registry";
import type { SessionRuntimeStore, RunnerSessionRuntimeRecord } from "./session-runtime-store";
import type { RunnerTerminalController } from "../ipc/register-terminal-ipc-handlers";
import type { WorkSession } from "../../shared/workflow/work-session";
import { INITIAL_CONDUCTOR_STATE } from "../../shared/workflow/conductor";

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

  it("restores durable repository-root shells without looking up a WorkSession", async () => {
    const store = memoryStore();
    const creates: Parameters<RunnerTerminalController["create"]>[0][] = [];
    const live = new Map<string, string>();
    const getSession = vi.fn(async () => null);
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
    const makeOrchestrator = () => createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: store,
      terminals,
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });

    const repoId = "repo::project";
    const firstRunner = makeOrchestrator();
    const shell = await firstRunner.openShell({ sessionId: repoId, root: false });
    expect(creates).toHaveLength(1);

    // A service restart destroys the PTY, but not the durable root-shell tab.
    live.clear();
    await makeOrchestrator().resume();

    expect(getSession).not.toHaveBeenCalled();
    expect(creates).toHaveLength(2);
    expect(creates[1]).toMatchObject({ persistKey: shell.key, cwd: "/repo" });
  });

  it("drops a runtime record whose session was deleted instead of failing startup", async () => {
    const store = memoryStore();
    await store.put({
      sessionId: "deleted-session",
      phase: "ready",
      terminals: [],
      error: null,
      autoPilot: { enabled: false, state: INITIAL_CONDUCTOR_STATE, message: null },
    });
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => null, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: store,
      terminals: {
        create: vi.fn(), replace: vi.fn(), attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });

    await expect(orchestrator.resume()).resolves.toBeUndefined();
    expect(await store.get("deleted-session")).toBeNull();
  });

  it("starts an opted-in PR fix in Architect before unlocking Implementer", async () => {
    const current = session({
      kind: "pr-fix",
      setupDone: true,
      prFixDiagnoseFirst: true,
      pr: { host: "bitbucket", workspace: "workspace", repo: "repo", prId: "42", url: "https://example.test/pr/42", lastReviewedSha: null },
    });
    const creates: Parameters<RunnerTerminalController["create"]>[0][] = [];
    const launchedRoles: string[] = [];
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async (input) => {
          creates.push(input);
          return { sessionId: "architect-pty", reused: false };
        },
        replace: vi.fn(), attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async (_sessionId, role) => {
      launchedRoles.push(role);
      return {
        agentCommand: "codex",
        agentKind: "codex",
        environment: {},
        wfCommand: "diagnose this PR",
        cwd: current.worktreePath,
        sessionUuid: null,
        warnings: [],
      };
    });

    await orchestrator.ensure(current.id);

    expect(launchedRoles).toEqual(["architect"]);
    expect(creates[0]).toMatchObject({
      persistKey: `${current.id}::role::architect`,
      initialInput: { text: "diagnose this PR", submit: true },
    });
    await expect(orchestrator.openRole(current.id, "implementer")).rejects.toThrow(/not unlocked/i);
  });

  it("opens a session that already carries a checkpoint in Implementer, not Architect", async () => {
    // A session adopted from an existing branch is born with its checkpoint, so
    // the architect stage is already done — the handoff is `wf implement`.
    const current = session({
      kind: "feature",
      setupDone: true,
      branch: "feature/auth",
      checkpointPath: "docs/workflow/checkpoints/auth-checkpoint.md",
    });
    const creates: Parameters<RunnerTerminalController["create"]>[0][] = [];
    const launchedRoles: string[] = [];
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async (input) => {
          creates.push(input);
          return { sessionId: "implementer-pty", reused: false };
        },
        replace: vi.fn(), attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async (_sessionId, role) => {
      launchedRoles.push(role);
      return {
        agentCommand: "codex",
        agentKind: "codex",
        environment: {},
        wfCommand: `wf implement ${current.checkpointPath}`,
        cwd: current.worktreePath,
        sessionUuid: null,
        warnings: [],
      };
    });

    await orchestrator.ensure(current.id);

    expect(launchedRoles).toEqual(["implementer"]);
    expect(creates[0]).toMatchObject({
      persistKey: `${current.id}::role::implementer`,
      // Feature/fix sessions pre-type without submitting — the user presses Enter.
      initialInput: { text: "wf implement docs/workflow/checkpoints/auth-checkpoint.md", submit: false },
    });
  });

  it("still opens a checkpointless feature session in Architect", async () => {
    const current = session({ kind: "feature", setupDone: true, branch: "feature/auth", checkpointPath: null });
    const launchedRoles: string[] = [];
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project()], addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async () => ({ sessionId: "architect-pty", reused: false }),
        replace: vi.fn(), attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async (_sessionId, role) => {
      launchedRoles.push(role);
      return {
        agentCommand: "codex", agentKind: "codex", environment: {},
        wfCommand: null, cwd: current.worktreePath, sessionUuid: null, warnings: [],
      };
    });

    await orchestrator.ensure(current.id);

    expect(launchedRoles).toEqual(["architect"]);
  });

  // The recovery banner tells the user to fix the worktree "in this terminal",
  // so that terminal has to still be alive once the setup command has died.
  it("leaves a live shell in the worktree when setup fails", async () => {
    const current = session({ kind: "feature", branch: "feature/auth", checkpointPath: null });
    const store = memoryStore();
    const replace = vi.fn(async (_input: Parameters<RunnerTerminalController["replace"]>[0]) => ({
      sessionId: "repair-shell-pty",
      reused: false,
    }));
    const kill = vi.fn();
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [project("pnpm worktree:setup")],
        addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current,
        listSessions: vi.fn(),
        markSetupDone: vi.fn(async () => { current.setupDone = true; }),
      } as unknown as SessionRegistry,
      runtimeStore: store,
      terminals: {
        create: async () => ({ sessionId: "setup-pty", reused: false }),
        replace, attach: vi.fn(async () => null), kill, write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => null),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async () => ({
      agentCommand: "codex", agentKind: "codex", environment: {},
      wfCommand: null, cwd: current.worktreePath, sessionUuid: null, warnings: [],
    }));

    await orchestrator.ensure(current.id);
    await orchestrator.onSetupExit({ sessionId: current.id, code: 1 });

    const failed = await orchestrator.runtime(current.id);
    expect(failed?.phase).toBe("failed");
    // A plain shell in the worktree: no launch command, and crucially no
    // setupSessionId, which would report a second setup failure when it exits.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toMatchObject({ cwd: current.worktreePath, persistKey: `${current.id}::setup` });
    expect(replace.mock.calls[0]?.[0].launchCommand).toBeUndefined();
    expect(replace.mock.calls[0]?.[0].setupSessionId).toBeUndefined();
    // Views key the setup pane on this, so it reattaches to the shell.
    expect(failed?.terminals.find((terminal) => terminal.kind === "setup")?.generation).toBe(1);

    // Continuing past the repair takes the pane away, so the shell goes with it
    // instead of being stranded for the life of the runner.
    await orchestrator.skipFailedSetup(current.id);
    expect(kill).toHaveBeenCalledWith("repair-shell-pty");
    expect((await orchestrator.runtime(current.id))?.terminals.some((terminal) => terminal.kind === "setup"))
      .toBe(false);
  });

  it("waits for the next hand-off before launching the role the checkpoint moved to", async () => {
    const checkpointPath = "docs/workflow/checkpoints/auth-checkpoint.md";
    const checkpointFor = (role: string, lane: string) => parseCheckpointMarkdown({
      checkpointPath,
      markdown: [
        "---", "feature: Auth", "slug: auth", "kind: feature", "status: IN_PROGRESS", "active: none", "---",
        "",
        "# ▶ NEXT",
        `- **Rol:** ${role}`,
        `- **Corre:** \`wf ${role === "implementer" ? "implement" : "review"} ${checkpointPath}\``,
        `- **Session lane:** \`${lane}\``,
      ].join("\n"),
    });
    const toImplementer = checkpointFor("implementer", "plan-1/implementer");
    const toReviewer = checkpointFor("reviewer", "plan-1/reviewer");

    const current = session({ kind: "feature", setupDone: true, branch: "feature/auth", checkpointPath });
    const replace = vi.fn(async (_input: Parameters<RunnerTerminalController["replace"]>[0]) => ({
      sessionId: "agent-pty-2",
      reused: false,
    }));
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [{ ...project(), autoPilot: { reloopLimit: 3, settleDelayMs: 30 } }],
        addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async () => ({ sessionId: "agent-pty", reused: false }),
        replace, attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => toImplementer),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async () => ({
      agentCommand: "codex", agentKind: "codex", environment: {},
      wfCommand: null, cwd: current.worktreePath, sessionUuid: null, warnings: [],
    }));
    orchestrator.setAutopilotLaunchBuilder(async () => ({
      command: "codex", agentKind: "codex", cwd: current.worktreePath, environment: {}, typePrompt: "wf step",
    }));

    try {
      await orchestrator.ensure(current.id);
      // The architect's `wf done`: turn over, handing to the implementer.
      orchestrator.onHandoff(current.id, {
        turn: 1, checkpointPath, role: "implementer", sessionLane: "plan-1/implementer",
      });
      await orchestrator.setAutopilot(current.id, true);

      await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(replace.mock.calls[0]?.[0]).toMatchObject({ persistKey: `${current.id}::role::implementer` });

      // The implementer moves NEXT to the reviewer mid-turn. Without a hand-off
      // that is not permission to start the reviewer on top of it.
      orchestrator.onCheckpoint(current.id, toReviewer);
      await vi.waitFor(async () => {
        expect((await orchestrator.runtime(current.id))?.autoPilot.message)
          .toBe("waiting · the current agent has not handed off yet");
      }, { timeout: 5_000 });
      expect(replace).toHaveBeenCalledTimes(1);

      // Now the implementer's turn actually ends.
      orchestrator.onHandoff(current.id, {
        turn: 2, checkpointPath, role: "reviewer", sessionLane: "plan-1/reviewer",
      });

      await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(2), { timeout: 5_000 });
      expect(replace.mock.calls[1]?.[0]).toMatchObject({ persistKey: `${current.id}::role::reviewer` });
      expect((await orchestrator.runtime(current.id))?.autoPilot.message).toBe(`→ wf review ${checkpointPath}`);
    } finally {
      await orchestrator.remove(current.id);
    }
  }, 20_000);

  // A workflow that does not emit hand-offs keeps the behavior it had before the
  // gate existed, and says so, rather than never advancing again.
  it("advances a session that has never produced a hand-off, naming the weaker signal", async () => {
    const checkpointPath = "docs/workflow/checkpoints/auth-checkpoint.md";
    const checkpoint = parseCheckpointMarkdown({
      checkpointPath,
      markdown: [
        "---", "feature: Auth", "slug: auth", "kind: feature", "status: IN_PROGRESS", "active: none", "---",
        "",
        "# ▶ NEXT",
        "- **Rol:** implementer",
        `- **Corre:** \`wf implement ${checkpointPath}\``,
        "- **Session lane:** `plan-1/implementer`",
      ].join("\n"),
    });
    const current = session({ kind: "feature", setupDone: true, branch: "feature/auth", checkpointPath });
    const replace = vi.fn(async (_input: Parameters<RunnerTerminalController["replace"]>[0]) => ({
      sessionId: "agent-pty-2",
      reused: false,
    }));
    const orchestrator = createSessionOrchestrator({
      projectRegistry: {
        listProjects: async () => [{ ...project(), autoPilot: { reloopLimit: 3, settleDelayMs: 30 } }],
        addProject: vi.fn(), updateProject: vi.fn(), removeProject: vi.fn(),
      } as unknown as ProjectRegistry,
      sessionRegistry: {
        getSession: async () => current, listSessions: vi.fn(), markSetupDone: vi.fn(),
      } as unknown as SessionRegistry,
      runtimeStore: memoryStore(),
      terminals: {
        create: async () => ({ sessionId: "agent-pty", reused: false }),
        replace, attach: vi.fn(async () => null), kill: vi.fn(), write: vi.fn(),
      },
      sessionAgentUuidStore: { get: vi.fn(), set: vi.fn() } as never,
      readCheckpoint: vi.fn(async () => checkpoint),
      broadcast: vi.fn(),
    });
    orchestrator.setRoleLaunchBuilder(async () => ({
      agentCommand: "codex", agentKind: "codex", environment: {},
      wfCommand: null, cwd: current.worktreePath, sessionUuid: null, warnings: [],
    }));
    orchestrator.setAutopilotLaunchBuilder(async () => ({
      command: "codex", agentKind: "codex", cwd: current.worktreePath, environment: {}, typePrompt: "wf step",
    }));

    try {
      await orchestrator.ensure(current.id);
      await orchestrator.setAutopilot(current.id, true);

      await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect((await orchestrator.runtime(current.id))?.autoPilot.message)
        .toBe(`→ wf implement ${checkpointPath} · no hand-off signal`);
    } finally {
      await orchestrator.remove(current.id);
    }
  }, 20_000);
});
