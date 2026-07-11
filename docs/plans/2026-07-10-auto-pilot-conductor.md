# Auto-pilot Conductor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic (no-LLM) conductor that auto-advances a session's `wf` workflow tab-by-tab — reads the `▶ NEXT` block, opens the right role tab, runs its command — with guardrails, a per-project re-loop cap + settle delay, and a per-session topbar switch.

**Architecture:** All correctness lives in two plain-TS, unit-tested modules — `conductor.ts` (the pure `decide` function) and `conductor-controller.ts` (debounce + state + dispatch, tested with fake timers). React (`useConductor`, the topbar switch, `ProjectModal` inputs) is thin, untested glue that is device-verified. Config threads through the existing project registry exactly like `runtimeConfig`.

**Tech Stack:** TypeScript (strict), Electron 33, React 18, Vitest (`environment: node`), better-sqlite3.

**Design doc:** `docs/specs/2026-07-10-auto-pilot-conductor-design.md`

## Global Constraints

- **TS strict, no `any`/forced `as`/non-null `!`.** Match the surrounding style.
- **Tests are Vitest, `environment: "node"` — NO DOM, NO testing-library.** Only plain-TS modules get unit tests; React components/hooks are verified on-device. Do not add a DOM test environment.
- **The renderer cannot import `node:*`.** Do path work with plain strings (the codebase already does this, e.g. `repoRootOf`).
- **Native ABI dance:** `pnpm test` runs a `pretest` that rebuilds `better-sqlite3` for the **Node** ABI (breaks Electron). After running tests, run `npx electron-rebuild` before `pnpm dev`/`pnpm build`. Verify types with `pnpm typecheck` (does not touch native ABI).
- **Config defaults:** `reloopLimit: 3` (range 1–10), `settleDelayMs: 4000`.
- **Commit after each task** (this repo commits on `main`).
- **Gates per task:** `pnpm typecheck` clean, and `pnpm test` green (run the new spec explicitly first, then the full suite). Baseline before starting: **169 passing** (capture your own number first).

---

## Task 1: `AutoPilotConfig` type + defaults + clamp

**Files:**
- Create: `src/shared/workflow/auto-pilot-config.ts`
- Test: `src/shared/workflow/auto-pilot-config.spec.ts`

**Interfaces:**
- Produces: `interface AutoPilotConfig { reloopLimit: number; settleDelayMs: number }`, `createDefaultAutoPilotConfig(): AutoPilotConfig`, `clampAutoPilotConfig(input: Partial<AutoPilotConfig>): AutoPilotConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/workflow/auto-pilot-config.spec.ts
import { describe, expect, it } from "vitest";
import { clampAutoPilotConfig, createDefaultAutoPilotConfig } from "./auto-pilot-config";

describe("createDefaultAutoPilotConfig", () => {
  it("defaults to 3 re-loops and a 4s settle delay", () => {
    expect(createDefaultAutoPilotConfig()).toEqual({ reloopLimit: 3, settleDelayMs: 4000 });
  });

  it("returns a fresh object each call (no shared reference)", () => {
    const a = createDefaultAutoPilotConfig();
    a.reloopLimit = 9;
    expect(createDefaultAutoPilotConfig().reloopLimit).toBe(3);
  });
});

describe("clampAutoPilotConfig", () => {
  it("fills missing fields from the default", () => {
    expect(clampAutoPilotConfig({})).toEqual({ reloopLimit: 3, settleDelayMs: 4000 });
  });

  it("clamps reloopLimit into 1..10 and floors it to an integer", () => {
    expect(clampAutoPilotConfig({ reloopLimit: 0 }).reloopLimit).toBe(1);
    expect(clampAutoPilotConfig({ reloopLimit: 99 }).reloopLimit).toBe(10);
    expect(clampAutoPilotConfig({ reloopLimit: 3.9 }).reloopLimit).toBe(3);
  });

  it("floors settleDelayMs to a minimum of 500ms", () => {
    expect(clampAutoPilotConfig({ settleDelayMs: 10 }).settleDelayMs).toBe(500);
    expect(clampAutoPilotConfig({ settleDelayMs: 8000 }).settleDelayMs).toBe(8000);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm vitest run src/shared/workflow/auto-pilot-config.spec.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/shared/workflow/auto-pilot-config.ts

/** Per-project auto-pilot conductor settings. */
export interface AutoPilotConfig {
  /** Max reviewer→implementer fix-loops auto-run per task before pausing. 1..10. */
  reloopLimit: number;
  /** Quiescence-debounce window (ms) before acting on a checkpoint change. */
  settleDelayMs: number;
}

const DEFAULT_RELOOP_LIMIT = 3;
const DEFAULT_SETTLE_DELAY_MS = 4000;
const MIN_RELOOP_LIMIT = 1;
const MAX_RELOOP_LIMIT = 10;
const MIN_SETTLE_DELAY_MS = 500;

export function createDefaultAutoPilotConfig(): AutoPilotConfig {
  return { reloopLimit: DEFAULT_RELOOP_LIMIT, settleDelayMs: DEFAULT_SETTLE_DELAY_MS };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Normalize a partial/untrusted config (persisted or from the modal) into a valid one. */
export function clampAutoPilotConfig(input: Partial<AutoPilotConfig>): AutoPilotConfig {
  const reloopLimit =
    input.reloopLimit === undefined
      ? DEFAULT_RELOOP_LIMIT
      : clampInt(input.reloopLimit, MIN_RELOOP_LIMIT, MAX_RELOOP_LIMIT, DEFAULT_RELOOP_LIMIT);
  const settleDelayMs =
    input.settleDelayMs === undefined
      ? DEFAULT_SETTLE_DELAY_MS
      : Math.max(MIN_SETTLE_DELAY_MS, Math.floor(Number.isFinite(input.settleDelayMs) ? input.settleDelayMs : DEFAULT_SETTLE_DELAY_MS));
  return { reloopLimit, settleDelayMs };
}
```

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** — `git add src/shared/workflow/auto-pilot-config.* && git commit -m "feat(conductor): AutoPilotConfig type + defaults/clamp"`

---

## Task 2: `decideConductor` — the pure decision function (the heart)

**Files:**
- Create: `src/shared/workflow/conductor.ts`
- Test: `src/shared/workflow/conductor.spec.ts`

**Interfaces:**
- Consumes: `ParsedCheckpoint` (`./workflow-types`), `SessionAgentRole` (`./session-role-launch`), `AutoPilotConfig` (`./auto-pilot-config`).
- Produces:
  - `type ConductorAction = { kind: "send"; role: SessionAgentRole; command: string; reason: string } | { kind: "pause"; role: SessionAgentRole | null; command: string | null; reason: string } | { kind: "noop"; reason: string }`
  - `interface ConductorState { lastActedKey: string | null; reloopCount: Record<string, number>; reviewedTasks: string[] }`
  - `const INITIAL_CONDUCTOR_STATE: ConductorState`
  - `function decideConductor(params: { prev: ConductorState; checkpoint: ParsedCheckpoint; config: AutoPilotConfig }): { action: ConductorAction; next: ConductorState }`

- [ ] **Step 1: Write the failing tests** (the full decision table from the spec)

```ts
// src/shared/workflow/conductor.spec.ts
import { describe, expect, it } from "vitest";
import { decideConductor, INITIAL_CONDUCTOR_STATE } from "./conductor";
import type { ConductorState } from "./conductor";
import type { AutoPilotConfig } from "./auto-pilot-config";
import type { ParsedCheckpoint, WorkflowNext, WorkflowStatus, WorkflowRole } from "./workflow-types";

const CONFIG: AutoPilotConfig = { reloopLimit: 3, settleDelayMs: 4000 };

function checkpoint(params: {
  role?: WorkflowRole | "unknown";
  command?: string | null;
  tier?: string | null;
  task?: string | null;
  status?: WorkflowStatus;
  hasNext?: boolean;
}): ParsedCheckpoint {
  const next: WorkflowNext | null =
    params.hasNext === false
      ? null
      : {
          role: params.role ?? "implementer",
          command: params.command === undefined ? "wf implement docs/x-checkpoint.md" : params.command,
          cwd: ".worktrees/x",
          tier: params.tier ?? null,
          task: params.task ?? null,
          rawMarkdown: "",
        };
  return {
    checkpointPath: "docs/x-checkpoint.md",
    frontmatter: {},
    feature: null,
    slug: "x",
    kind: "feature",
    branch: null,
    worktree: null,
    status: params.status ?? "IN_PROGRESS",
    activeRole: "none",
    next,
    ledgerRows: [],
    latestLogMarkdown: null,
    warnings: [],
  };
}

describe("decideConductor — guardrails", () => {
  it("pauses on status DONE", () => {
    const { action } = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ status: "DONE" }), config: CONFIG });
    expect(action.kind).toBe("pause");
  });

  it("pauses on status BLOCKED", () => {
    const { action } = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ status: "BLOCKED" }), config: CONFIG });
    expect(action.kind).toBe("pause");
  });

  it("pauses when NEXT is absent", () => {
    const { action } = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ hasNext: false }), config: CONFIG });
    expect(action.kind).toBe("pause");
  });

  it("pauses when role is unknown or command missing", () => {
    expect(decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ role: "unknown" }), config: CONFIG }).action.kind).toBe("pause");
    expect(decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ command: null }), config: CONFIG }).action.kind).toBe("pause");
  });
});

describe("decideConductor — forward progress", () => {
  it("sends the implementer command on a fresh NEXT and records lastActedKey", () => {
    const { action, next } = decideConductor({
      prev: INITIAL_CONDUCTOR_STATE,
      checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }),
      config: CONFIG,
    });
    expect(action).toMatchObject({ kind: "send", role: "implementer", command: "wf implement docs/x-checkpoint.md" });
    expect(next.lastActedKey).not.toBeNull();
  });

  it("is idempotent: the same NEXT twice in a row is a noop", () => {
    const cp = checkpoint({ role: "implementer", task: "P1" });
    const first = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: cp, config: CONFIG });
    const second = decideConductor({ prev: first.next, checkpoint: cp, config: CONFIG });
    expect(second.action.kind).toBe("noop");
  });

  it("runs both tiers: implement P1 then implement P2 (different task) both send", () => {
    const p1 = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ role: "implementer", task: "P1" }), config: CONFIG });
    const p2 = decideConductor({ prev: p1.next, checkpoint: checkpoint({ role: "implementer", task: "P2" }), config: CONFIG });
    expect(p1.action.kind).toBe("send");
    expect(p2.action.kind).toBe("send");
  });

  it("re-runs review after a fix: review X → implement X → review X, the final review sends (not swallowed)", () => {
    const rev1 = decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }), config: CONFIG });
    const impl = decideConductor({ prev: rev1.next, checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }), config: CONFIG });
    const rev2 = decideConductor({ prev: impl.next, checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }), config: CONFIG });
    expect(rev1.action.kind).toBe("send");
    expect(impl.action.kind).toBe("send"); // first bounce, under cap
    expect(rev2.action.kind).toBe("send");
  });
});

describe("decideConductor — re-loop cap", () => {
  // Helper: run reviewer(P1) once so the task is marked reviewed, then bounce to implementer N times.
  function afterFirstReview(): ConductorState {
    return decideConductor({ prev: INITIAL_CONDUCTOR_STATE, checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }), config: CONFIG }).next;
  }

  it("counts a reviewer→implementer bounce against the cap and pauses at the limit", () => {
    let state = afterFirstReview();
    // Alternate implement/review to force distinct lastActedKey each step; only implementer-after-review counts.
    for (let i = 0; i < 3; i++) {
      const impl = decideConductor({ prev: state, checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }), config: CONFIG });
      expect(impl.action.kind).toBe("send");
      state = impl.next;
      const rev = decideConductor({ prev: state, checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }), config: CONFIG });
      state = rev.next;
    }
    // 4th bounce exceeds reloopLimit 3 → pause
    const fourth = decideConductor({ prev: state, checkpoint: checkpoint({ role: "implementer", command: "wf implement docs/x-checkpoint.md", task: "P1" }), config: CONFIG });
    expect(fourth.action.kind).toBe("pause");
  });

  it("keeps re-loop counts independent per task", () => {
    // Exhaust P1, then a P2 bounce still sends.
    let state = afterFirstReview();
    for (let i = 0; i < 3; i++) {
      state = decideConductor({ prev: state, checkpoint: checkpoint({ role: "implementer", task: "P1" }), config: CONFIG }).next;
      state = decideConductor({ prev: state, checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P1" }), config: CONFIG }).next;
    }
    // set up P2 as reviewed then bounce
    state = decideConductor({ prev: state, checkpoint: checkpoint({ role: "reviewer", command: "wf review docs/x-checkpoint.md", task: "P2" }), config: CONFIG }).next;
    const p2Impl = decideConductor({ prev: state, checkpoint: checkpoint({ role: "implementer", task: "P2" }), config: CONFIG });
    expect(p2Impl.action.kind).toBe("send");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm vitest run src/shared/workflow/conductor.spec.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// src/shared/workflow/conductor.ts
import type { AutoPilotConfig } from "./auto-pilot-config";
import type { SessionAgentRole } from "./session-role-launch";
import type { ParsedCheckpoint } from "./workflow-types";

export type ConductorAction =
  | { kind: "send"; role: SessionAgentRole; command: string; reason: string }
  | { kind: "pause"; role: SessionAgentRole | null; command: string | null; reason: string }
  | { kind: "noop"; reason: string };

export interface ConductorState {
  /** The NEXT-content key we last ACTED on (send). Idempotency guard. */
  lastActedKey: string | null;
  /** Per-task count of backward fix-loops auto-run so far. */
  reloopCount: Record<string, number>;
  /** Task keys for which a reviewer step was already acted on (to detect a bounce-back). */
  reviewedTasks: string[];
}

export const INITIAL_CONDUCTOR_STATE: ConductorState = {
  lastActedKey: null,
  reloopCount: {},
  reviewedTasks: [],
};

const AGENT_ROLES = new Set<string>(["architect", "implementer", "reviewer"]);

function isAgentRole(role: string): role is SessionAgentRole {
  return AGENT_ROLES.has(role);
}

function taskKeyOf(tier: string | null, task: string | null, command: string): string {
  const key = `${tier ?? ""}|${task ?? ""}`;
  return key === "|" ? command : key;
}

export function decideConductor(params: {
  prev: ConductorState;
  checkpoint: ParsedCheckpoint;
  config: AutoPilotConfig;
}): { action: ConductorAction; next: ConductorState } {
  const { prev, checkpoint, config } = params;
  const noChange = { action: null as ConductorAction | null, next: prev };

  // 1–2. Terminal / blocked states never auto-run.
  if (checkpoint.status === "DONE") return { action: { kind: "pause", role: null, command: null, reason: "workflow DONE" }, next: prev };
  if (checkpoint.status === "BLOCKED") return { action: { kind: "pause", role: null, command: null, reason: "BLOCKED" }, next: prev };

  // 3. Unactionable NEXT.
  const next = checkpoint.next;
  if (!next || next.role === "unknown" || !isAgentRole(next.role) || !next.command) {
    return { action: { kind: "pause", role: null, command: null, reason: "NEXT not actionable" }, next: prev };
  }

  const role = next.role;
  const command = next.command;
  const tKey = taskKeyOf(next.tier, next.task, command);
  const nextKey = `${role}|${command}|${next.tier ?? ""}|${next.task ?? ""}`;

  // 4. Idempotency: same step we just acted on → noop.
  if (nextKey === prev.lastActedKey) {
    return { action: { kind: "noop", reason: "already handled" }, next: prev };
  }

  // 5. New transition. Detect a same-task bounce back to the implementer.
  const isReloop = role === "implementer" && prev.reviewedTasks.includes(tKey);
  if (isReloop && (prev.reloopCount[tKey] ?? 0) >= config.reloopLimit) {
    return {
      action: { kind: "pause", role, command, reason: `re-loop limit (${config.reloopLimit}) reached for task` },
      next: prev,
    };
  }

  const reloopCount = isReloop ? { ...prev.reloopCount, [tKey]: (prev.reloopCount[tKey] ?? 0) + 1 } : prev.reloopCount;
  const reviewedTasks = role === "reviewer" && !prev.reviewedTasks.includes(tKey) ? [...prev.reviewedTasks, tKey] : prev.reviewedTasks;

  void noChange;
  return {
    action: { kind: "send", role, command, reason: isReloop ? "re-loop fix" : "advance" },
    next: { lastActedKey: nextKey, reloopCount, reviewedTasks },
  };
}
```

*(Remove the unused `noChange`/`void noChange` scaffold if the linter flags it — it is only there to keep the diff readable; the real returns are explicit.)*

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(conductor): pure decideConductor decision function + tests"`

---

## Task 3: `createConductorController` — debounce + state + dispatch

**Files:**
- Create: `src/renderer/conductor-controller.ts`
- Test: `src/renderer/conductor-controller.spec.ts`

**Interfaces:**
- Consumes: `decideConductor`, `INITIAL_CONDUCTOR_STATE`, `ConductorAction`, `ConductorState` (`../shared/workflow/conductor`); `AutoPilotConfig` (`../shared/workflow/auto-pilot-config`); `ParsedCheckpoint` (`../shared/workflow/workflow-types`).
- Produces:
  - `interface ConductorController { notifyCheckpoint(cp: ParsedCheckpoint): void; setEnabled(enabled: boolean): void; dispose(): void }`
  - `function createConductorController(deps: { getConfig: () => AutoPilotConfig; onAction: (a: ConductorAction) => void }): ConductorController`

Behavior: holds `ConductorState` + `enabled` + the latest checkpoint + a single debounce timer. `notifyCheckpoint` stores the checkpoint and (if enabled) restarts a `settleDelayMs` timer; when it fires, calls `decideConductor` and dispatches non-noop actions. `setEnabled(true)` with a stored checkpoint schedules a catch-up fire; `setEnabled(false)` cancels the timer. `dispose` cancels the timer.

- [ ] **Step 1: Write the failing tests** (fake timers)

```ts
// src/renderer/conductor-controller.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConductorController } from "./conductor-controller";
import type { ConductorAction } from "../shared/workflow/conductor";
import type { AutoPilotConfig } from "../shared/workflow/auto-pilot-config";
import type { ParsedCheckpoint, WorkflowRole } from "../shared/workflow/workflow-types";

const CONFIG: AutoPilotConfig = { reloopLimit: 3, settleDelayMs: 4000 };

function cp(role: WorkflowRole, task: string): ParsedCheckpoint {
  return {
    checkpointPath: "docs/x-checkpoint.md", frontmatter: {}, feature: null, slug: "x", kind: "feature",
    branch: null, worktree: null, status: "IN_PROGRESS", activeRole: "none",
    next: { role, command: `wf ${role === "implementer" ? "implement" : role === "reviewer" ? "review" : "verify"} docs/x-checkpoint.md`, cwd: ".worktrees/x", tier: null, task, rawMarkdown: "" },
    ledgerRows: [], latestLogMarkdown: null, warnings: [],
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createConductorController", () => {
  it("does nothing while disabled", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({ getConfig: () => CONFIG, onAction: (a) => actions.push(a) });
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(10000);
    expect(actions).toEqual([]);
  });

  it("acts after the settle delay once enabled", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({ getConfig: () => CONFIG, onAction: (a) => actions.push(a) });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(3999);
    expect(actions).toEqual([]); // not yet
    vi.advanceTimersByTime(1);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "send", role: "implementer" });
  });

  it("debounces rapid changes into a single action (quiescence)", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({ getConfig: () => CONFIG, onAction: (a) => actions.push(a) });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    vi.advanceTimersByTime(2000);
    c.notifyCheckpoint(cp("implementer", "P1")); // resets the timer
    vi.advanceTimersByTime(2000);
    expect(actions).toEqual([]); // window restarted, not elapsed
    vi.advanceTimersByTime(2000);
    expect(actions).toHaveLength(1);
  });

  it("catches up on enable when a checkpoint is already stored", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({ getConfig: () => CONFIG, onAction: (a) => actions.push(a) });
    c.notifyCheckpoint(cp("implementer", "P1")); // while disabled
    c.setEnabled(true);
    vi.advanceTimersByTime(4000);
    expect(actions).toHaveLength(1);
  });

  it("does not fire after dispose", () => {
    const actions: ConductorAction[] = [];
    const c = createConductorController({ getConfig: () => CONFIG, onAction: (a) => actions.push(a) });
    c.setEnabled(true);
    c.notifyCheckpoint(cp("implementer", "P1"));
    c.dispose();
    vi.advanceTimersByTime(10000);
    expect(actions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement**

```ts
// src/renderer/conductor-controller.ts
import type { AutoPilotConfig } from "../shared/workflow/auto-pilot-config";
import { decideConductor, INITIAL_CONDUCTOR_STATE } from "../shared/workflow/conductor";
import type { ConductorAction, ConductorState } from "../shared/workflow/conductor";
import type { ParsedCheckpoint } from "../shared/workflow/workflow-types";

export interface ConductorController {
  notifyCheckpoint(checkpoint: ParsedCheckpoint): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

export function createConductorController(deps: {
  getConfig: () => AutoPilotConfig;
  onAction: (action: ConductorAction) => void;
}): ConductorController {
  let state: ConductorState = INITIAL_CONDUCTOR_STATE;
  let enabled = false;
  let latest: ParsedCheckpoint | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function fire(): void {
    timer = null;
    if (!enabled || !latest) return;
    const { action, next } = decideConductor({ prev: state, checkpoint: latest, config: deps.getConfig() });
    state = next;
    if (action.kind !== "noop") deps.onAction(action);
  }

  function schedule(): void {
    clearTimer();
    timer = setTimeout(fire, deps.getConfig().settleDelayMs);
  }

  return {
    notifyCheckpoint(checkpoint) {
      latest = checkpoint;
      if (enabled) schedule();
    },
    setEnabled(value) {
      if (enabled === value) return;
      enabled = value;
      if (enabled && latest) schedule();
      if (!enabled) clearTimer();
    },
    dispose() {
      clearTimer();
    },
  };
}
```

- [ ] **Step 4: Run it, verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(conductor): debounce+dispatch controller + fake-timer tests"`

---

## Task 4: Thread `autoPilot` through the project registry + contract

**Files:**
- Modify: `src/main/projects/project-registry.ts`
- Modify: `src/main/projects/sqlite-project-registry.ts`
- Modify: `src/shared/ipc/contract.ts`
- Test: `src/main/projects/sqlite-project-registry.spec.ts` (add a case)

**Interfaces:**
- Produces: `ProjectRecord.autoPilot: AutoPilotConfig`, `ProjectUpdateInput.autoPilot?`, `ProjectCreateInput.autoPilot?`.

- [ ] **Step 1: Add the field to the record + inputs** (`project-registry.ts`)

Add the import and field:
```ts
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
```
- In `ProjectRecord`, after `runtimeConfig`: `autoPilot: AutoPilotConfig;`
- In `ProjectUpdateInput`, after `runtimeConfig?`: `autoPilot?: AutoPilotConfig;`
- In the `addProject` input type, after `runtimeConfig?`: `autoPilot?: AutoPilotConfig;`
- In `addProject`'s record literal, after `runtimeConfig: …`: `autoPilot: input.autoPilot ?? createDefaultAutoPilotConfig(),`
- In `updateProject`'s updated literal, after `runtimeConfig: …`: `autoPilot: input.autoPilot ?? current.autoPilot,`

- [ ] **Step 2: Write the failing persistence test** (`sqlite-project-registry.spec.ts`)

Add:
```ts
it("defaults autoPilot on add and round-trips an updated value", async () => {
  const registry = createSqliteProjectRegistry({ sqliteFilePath: tmpDbPath() }); // use the spec's existing temp-db helper
  const created = await registry.addProject({ rootPath: "/tmp/repo-ap" });
  expect(created.autoPilot).toEqual({ reloopLimit: 3, settleDelayMs: 4000 });

  const updated = await registry.updateProject(created.id, { autoPilot: { reloopLimit: 5, settleDelayMs: 6000 } });
  expect(updated.autoPilot).toEqual({ reloopLimit: 5, settleDelayMs: 6000 });

  const [reloaded] = await registry.listProjects();
  expect(reloaded.autoPilot).toEqual({ reloopLimit: 5, settleDelayMs: 6000 });
});
```
*(Match the file's existing setup for the temp DB path/cleanup — reuse whatever helper the other tests use; do not invent `tmpDbPath` if the file names it differently.)*

- [ ] **Step 3: Run it, verify it fails** (column/field missing).

- [ ] **Step 4: Implement the sqlite plumbing** (`sqlite-project-registry.ts`)

- Imports:
```ts
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
```
- `interface ProjectRow`: add `auto_pilot: string;`
- `ensureSchema`, after the `runtime_config` migration block, add the same ADD COLUMN pattern:
```ts
if (!columnNames.has("auto_pilot")) {
  const defaultAutoPilotJson = escapeSqlString(JSON.stringify(createDefaultAutoPilotConfig()));
  db.exec(`ALTER TABLE projects ADD COLUMN auto_pilot TEXT NOT NULL DEFAULT '${defaultAutoPilotJson}'`);
}
```
- `rowToRecord`: add `autoPilot: JSON.parse(row.auto_pilot) as AutoPilotConfig,`
- `insertRecord`: add `auto_pilot` to the column list + `@autoPilot` to VALUES + `autoPilot: JSON.stringify(record.autoPilot),` to the params.
- `updateRecord`: add `autoPilot: input.autoPilot ?? current.autoPilot,` to the updated literal; add `auto_pilot = @autoPilot` to the SET clause + `autoPilot: JSON.stringify(updated.autoPilot),` to params.
- `addProject`'s record literal: add `autoPilot: input.autoPilot ?? createDefaultAutoPilotConfig(),`
- `migrateFromLegacyJson`'s record literal: add `autoPilot: legacy.autoPilot ?? createDefaultAutoPilotConfig(),`

- [ ] **Step 5: Add to the contract create input** (`contract.ts`)
- Import `AutoPilotConfig`: `import type { AutoPilotConfig } from "../workflow/auto-pilot-config";`
- In `ProjectCreateInput`, after `runtimeConfig?`: `autoPilot?: AutoPilotConfig;`
- (`ProjectRecord`/`ProjectUpdateInput` are re-exported from `project-registry`, so they already carry the field — no change needed there.)

- [ ] **Step 6: Run the sqlite spec, verify green.** Then `pnpm typecheck`.
- [ ] **Step 7: Commit** — `git commit -m "feat(conductor): persist per-project autoPilot config"`

---

## Task 5: ProjectModal auto-pilot section (renderer — device-verified)

**Files:**
- Modify: `src/renderer/components/ProjectModal.tsx`

No unit test (no DOM env). Verify on-device: open Add/Edit Project → set the two fields → Save → reopen Edit and confirm the values persisted.

- [ ] **Step 1: Imports + state**
- Add: `import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";` and `import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";`
- Add state after `runtimeConfig`:
```ts
const [autoPilot, setAutoPilot] = useState<AutoPilotConfig>(project?.autoPilot ?? createDefaultAutoPilotConfig());
```

- [ ] **Step 2: Pass it in both submit branches**
- In the `create` branch `projects.add({ … })` and the `edit` branch `projects.update(project!.id, { … })`, add `autoPilot,` alongside `runtimeConfig`.

- [ ] **Step 3: Add the UI section** after the `Per-stage agent config` `</section>`:
```tsx
<section>
  <h3>Auto-pilot</h3>
  <p className="section-hint">
    When enabled per session, the conductor auto-runs each <code>▶ NEXT</code> command. It
    auto-runs a reviewer→implementer fix-loop up to the re-loop limit, then pauses. The settle
    delay is how long the checkpoint must be quiet before it acts (so it never fires mid-write).
  </p>
  <div className="autopilot-config">
    <label>
      Re-loop limit
      <input
        type="number" min={1} max={10} value={autoPilot.reloopLimit}
        onChange={(event) => setAutoPilot((c) => ({ ...c, reloopLimit: Number(event.target.value) }))}
      />
    </label>
    <label>
      Settle delay (seconds)
      <input
        type="number" min={0.5} step={0.5} value={autoPilot.settleDelayMs / 1000}
        onChange={(event) => setAutoPilot((c) => ({ ...c, settleDelayMs: Math.round(Number(event.target.value) * 1000) }))}
      />
    </label>
  </div>
</section>
```

- [ ] **Step 4: `pnpm typecheck` clean. Commit** — `git commit -m "feat(conductor): auto-pilot config in ProjectModal"`

---

## Task 6: `autoSubmitWf` on SessionTerminal

**Files:**
- Modify: `src/renderer/components/SessionTerminal.tsx`

When set, a freshly-opened agent tab **submits** the pre-typed `wf` command (appends `\r`) instead of leaving it for the user. This is how the conductor runs a forward step without sending a duplicate command — it reuses the tab's proven "wait for first output + settle, then send follow-up" timing.

No unit test (no DOM env). Verified on-device in Task 7's flow.

- [ ] **Step 1: Add the prop** to `SessionTerminalProps`:
```ts
// When true, a fresh agent launch AUTO-SUBMITS its wf command (conductor-driven)
// instead of only pre-typing it for the user to press Enter.
autoSubmitWf?: boolean;
```
- Destructure it: `const { session, role, mode, persistKey, onOpenPath, hint, cwdOverride, autoSubmitWf } = props;`

- [ ] **Step 2: Use it in `sendFollowUp`.** Change the pre-type line so it submits when `autoSubmitWf` is set:
```ts
if (wfPreType !== null) {
  window.agentCoordinator.terminal.write(ptyId, autoSubmitWf ? `${wfPreType}\r` : wfPreType);
}
```
- Add `autoSubmitWf` to the effect dependency array (alongside `session.id, session.worktreePath, role, mode, cwdOverride`). *(Reads current at launch; harmless if it changes later since the follow-up fires once.)*

- [ ] **Step 3: `pnpm typecheck` clean. Commit** — `git commit -m "feat(conductor): autoSubmitWf flag on SessionTerminal"`

---

## Task 7: SessionView integration — switch + useConductor + delivery + feedback + CSS

**Files:**
- Create: `src/renderer/hooks/useConductor.ts`
- Modify: `src/renderer/components/SessionView.tsx`
- Modify: `src/renderer/App.tsx` (pass `autoPilotConfig` to SessionView)
- Modify: the session-view stylesheet (the CSS file SessionView uses — find it via the existing `session-topbar` / `terminal-hint` classes)

No unit test (no DOM env). **Device verification is the gate for this task — see the checklist at the end.**

- [ ] **Step 1: The hook** (`src/renderer/hooks/useConductor.ts`)

```ts
import { useEffect, useRef } from "react";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import { createConductorController } from "../conductor-controller";
import type { ConductorController } from "../conductor-controller";
import type { ConductorAction } from "../../shared/workflow/conductor";
import type { WorkSession } from "../../shared/ipc/contract";

/** Join a base dir and a relative path with "/" (renderer can't use node:path). */
function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/**
 * Drives one session's auto-pilot: subscribes to checkpoint changes, matches them
 * to THIS session by absolute path, debounces via the controller, and dispatches
 * the decided action through `onAction`. `repoRoot` is the project root (used to
 * resolve the broadcast's project-root-relative path).
 */
export function useConductor(params: {
  session: WorkSession;
  repoRoot: string;
  enabled: boolean;
  getConfig: () => AutoPilotConfig;
  onAction: (action: ConductorAction) => void;
}): void {
  const { session, repoRoot, enabled } = params;
  const controllerRef = useRef<ConductorController | null>(null);
  const onActionRef = useRef(params.onAction);
  const getConfigRef = useRef(params.getConfig);
  useEffect(() => {
    onActionRef.current = params.onAction;
    getConfigRef.current = params.getConfig;
  });

  const checkpointPath = session.checkpointPath;
  useEffect(() => {
    // Dormant until a checkpoint exists.
    if (!checkpointPath) return;
    const sessionAbs = joinPath(session.worktreePath, checkpointPath);

    const controller = createConductorController({
      getConfig: () => getConfigRef.current(),
      onAction: (action) => onActionRef.current(action),
    });
    controllerRef.current = controller;

    const unsubscribe = window.agentCoordinator.checkpoints.onChanged((event) => {
      const changedAbs = joinPath(repoRoot, event.checkpoint.checkpointPath);
      if (changedAbs !== sessionAbs) return;
      controller.notifyCheckpoint(event.checkpoint);
    });

    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [session.id, session.worktreePath, checkpointPath, repoRoot]);

  useEffect(() => {
    controllerRef.current?.setEnabled(enabled);
  }, [enabled]);
}
```

- [ ] **Step 2: Wire into SessionView** — new state, the hook call, the delivery function.

Add near the other `useState`s:
```ts
const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
const [conductorAutoRoles, setConductorAutoRoles] = useState<Set<SessionAgentRole>>(() => new Set());
const [conductorLog, setConductorLog] = useState<string | null>(null);
```

Add the delivery function (near `handleComposerSend`):
```ts
function performConductorAction(action: ConductorAction): void {
  if (action.kind === "noop") return;
  if (action.kind === "send") {
    const role = action.role;
    if (openedRoleTabs.has(role)) {
      // Agent already live in its tab → send the command straight in.
      terminalHandles.current.get(role)?.sendText(action.command, true);
      setActiveTab(role);
    } else {
      // Fresh open → let the tab's own launch follow-up submit the wf command.
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
```

Call the hook (after `repoRoot`/`hasSeparateRoot` are computed; `repoRoot` already exists in SessionView):
```ts
useConductor({
  session,
  repoRoot,
  enabled: !repoMode && autoPilotEnabled && hasCheckpoint,
  getConfig: () => autoPilotConfig,
  onAction: performConductorAction,
});
```
Add the imports at the top:
```ts
import { useConductor } from "../hooks/useConductor";
import type { ConductorAction } from "../../shared/workflow/conductor";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
```
Add `autoPilotConfig: AutoPilotConfig` to `SessionViewProps` and destructure it.

- [ ] **Step 3: Thread `autoSubmitWf` into the role terminals.** Where SessionView renders the role `SessionTerminal` (the agent tab), pass:
```tsx
autoSubmitWf={conductorAutoRoles.has(role)}
```
*(Find the role-tab `<SessionTerminal … />` render — it already passes `session`, `role`, `mode`, `hint`, `ref`/`registerTerminalHandle`.)*

- [ ] **Step 4: The topbar switch + feedback line** in `session-topbar-meta` (only when `!repoMode`):
```tsx
{!repoMode && (
  <button
    type="button"
    className={`session-topbar-autopilot${autoPilotEnabled ? " on" : ""}`}
    disabled={!hasCheckpoint}
    title={hasCheckpoint ? "Auto-pilot: run each ▶ NEXT command automatically" : "Auto-pilot activates once a checkpoint exists"}
    aria-pressed={autoPilotEnabled}
    onClick={() => setAutoPilotEnabled((v) => !v)}
  >
    <span className="session-topbar-autopilot-dot" />
    Auto-pilot
  </button>
)}
```
And a feedback strip under the topbar (only when on and there's a message):
```tsx
{!repoMode && autoPilotEnabled && conductorLog && (
  <div className="session-conductor-strip">{conductorLog}</div>
)}
```

- [ ] **Step 5: App passes the config** (`App.tsx`). Where `<SessionView … />` is rendered, look up the project for the active session and pass:
```tsx
autoPilotConfig={projectForSession?.autoPilot ?? createDefaultAutoPilotConfig()}
```
Add the import `import { createDefaultAutoPilotConfig } from "../shared/workflow/auto-pilot-config";` (adjust relative depth). For a repo session the value is unused (hook is gated off by `repoMode`), so the default is fine.

- [ ] **Step 6: CSS** — add to the session-view stylesheet, matching the existing `session-topbar-chip` / `terminal-hint` palette:
```css
.session-topbar-autopilot {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 6px; font-size: 12px;
  border: 1px solid var(--border, #3a322e); background: transparent; color: inherit; cursor: pointer;
}
.session-topbar-autopilot:disabled { opacity: 0.4; cursor: default; }
.session-topbar-autopilot-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6560; }
.session-topbar-autopilot.on { border-color: #2f7d4f; background: rgba(47, 125, 79, 0.15); }
.session-topbar-autopilot.on .session-topbar-autopilot-dot { background: #38b36b; box-shadow: 0 0 6px #38b36b; }
.session-conductor-strip {
  padding: 4px 12px; font-size: 12px; font-family: ui-monospace, Menlo, monospace;
  color: #9fd7b3; background: rgba(47, 125, 79, 0.10); border-bottom: 1px solid rgba(47, 125, 79, 0.25);
}
```
*(Use the file's real CSS variables if they differ; the hex fallbacks match the app's dark palette.)*

- [ ] **Step 7: Gates.** `pnpm typecheck` clean; `pnpm test` full suite green (unchanged count + the new specs). Then `npx electron-rebuild` and `pnpm dev`.

- [ ] **Step 8: Device verification (the real gate for this task)** — with a real session that has a checkpoint:
  1. Flip **Auto-pilot** on. Confirm the dot goes green and it's disabled/dim before a checkpoint exists.
  2. Let the architect write/advance the checkpoint so `▶ NEXT` points at the implementer. Confirm — after ~4s of quiet — the Implementer tab opens and its `wf implement …` runs **once** (no duplicated command).
  3. Confirm the feedback strip shows the action.
  4. Force a reviewer→implementer bounce; confirm it auto-runs up to the limit, then the strip shows a pause.
  5. Flip off mid-run; confirm it stops.
  6. Set `status: DONE` (or BLOCKED); confirm it pauses, doesn't run.

- [ ] **Step 9: Commit** — `git commit -m "feat(conductor): auto-pilot switch + useConductor wiring in SessionView"`

---

## Self-Review (run after writing all tasks)

- **Spec coverage:** decision fn (T2), guardrails+cap (T2), settle delay (T3), config+persistence (T1/T4), ProjectModal (T5), duplicate-command avoidance (T6), switch+wiring+feedback (T7). ✔ every spec section maps to a task.
- **Type consistency:** `AutoPilotConfig` (T1) used by T2/T3/T4/T5/T7; `ConductorAction`/`ConductorState` (T2) used by T3/T7; `decideConductor` signature identical across T2 def and T3 use. `autoSubmitWf` prop (T6) consumed in T7 Step 3. ✔
- **Placeholder scan:** the two "match the file's existing helper" notes (T4 temp-db, T7 CSS vars) are deliberate — they point at real existing code the implementer must read, not invented APIs. No TODO/TBD in shipped code.
- **Risk 1 resolution:** forward step → `autoSubmitWf` (single source, reuses tab timing); already-open → `sendText`. No path where both the pre-type and a conductor `sendText` deliver the same command.

## Deferred (not in v1 — noted, not silently dropped)

- **Fresh session per tier:** a re-loop sends into the live agent in the open tab. If the workflow needs a fresh `claude` per tier, that's a follow-up (would relaunch the role tab).
- **Persisting the per-session switch** across app restarts (currently component state, resets on remount).
- **PTY-idle detection** before sending on a re-loop (the settle delay is the v1 guard).
