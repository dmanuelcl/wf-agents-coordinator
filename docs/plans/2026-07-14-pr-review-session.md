# PR Review Session — Implementation Plan

> **For agentic workers:** Implement task-by-task, TDD where a unit test is possible. Checkbox (`- [ ]`) steps.

**Goal:** A "PR review" session kind: pick a branch (local/remote) + base → detached worktree → auto-launched reviewer that auto-runs a review kickoff → a Post-to-Slack button that relays the review to the project's configured channel via the agent.

**Architecture:** Pure/testable logic in plain-TS modules (`review-config`, `git-branches` parser, registry); the reviewer kickoff + Slack relay reuse the conductor's `autoSubmitWf` + the terminal `sendText`. React is device-verified.

**Design doc:** `docs/specs/2026-07-14-pr-review-session-design.md`

## Global Constraints

- TS strict; no `any`. Vitest `environment: node` (no DOM) — only plain-TS modules get unit tests.
- Renderer can't import `node:*`.
- Native ABI: after `pnpm test`, run `pnpm build` (or `npx electron-rebuild`) before `pnpm dev`.
- Gates per task: `pnpm typecheck` clean + `pnpm test` green. **Baseline: 190 passing** (capture your own first).
- Commit after each task (on `main`).

---

## Task 1: `review-config.ts` (shared, pure)

**Files:** Create `src/shared/workflow/review-config.ts` + `.spec.ts`.

- [ ] **Test first:**
```ts
// review-config.spec.ts
import { describe, expect, it } from "vitest";
import { buildSlackPostCommand, createDefaultReviewConfig, DEFAULT_REVIEW_KICKOFF, substituteReviewKickoff } from "./review-config";

describe("createDefaultReviewConfig", () => {
  it("defaults to an empty channel and the default kickoff", () => {
    expect(createDefaultReviewConfig()).toEqual({ slackChannel: "", kickoff: DEFAULT_REVIEW_KICKOFF });
  });
});

describe("substituteReviewKickoff", () => {
  it("replaces all {branch} and {base} occurrences", () => {
    const out = substituteReviewKickoff("rev {branch} vs {base}; again {branch}", { branch: "origin/x", base: "develop" });
    expect(out).toBe("rev origin/x vs develop; again origin/x");
  });
  it("falls back to the default kickoff when the template is blank", () => {
    const out = substituteReviewKickoff("   ", { branch: "x", base: "develop" });
    expect(out).toContain("develop");
    expect(out.startsWith("Revisa los cambios")).toBe(true);
  });
});

describe("buildSlackPostCommand", () => {
  it("names the channel in the instruction", () => {
    expect(buildSlackPostCommand("#pr-reviews")).toBe(
      "Publica el resumen completo del review en el canal de Slack #pr-reviews.",
    );
  });
});
```

- [ ] **Implement:**
```ts
// review-config.ts
export interface ReviewConfig {
  slackChannel: string;
  kickoff: string;
}

export const DEFAULT_REVIEW_KICKOFF =
  "Revisa los cambios de la rama {branch} contra {base}. Lee y analiza cada archivo " +
  "modificado, reporta todos los hallazgos con su severidad, y termina con un resumen " +
  "de todo lo que hay que hacer antes de mergear.";

export function createDefaultReviewConfig(): ReviewConfig {
  return { slackChannel: "", kickoff: DEFAULT_REVIEW_KICKOFF };
}

export function substituteReviewKickoff(template: string, vars: { branch: string; base: string }): string {
  const base = template.trim() ? template : DEFAULT_REVIEW_KICKOFF;
  return base.split("{branch}").join(vars.branch).split("{base}").join(vars.base);
}

export function buildSlackPostCommand(channel: string): string {
  return `Publica el resumen completo del review en el canal de Slack ${channel}.`;
}
```
- [ ] Run spec (green), commit: `feat(review): ReviewConfig + kickoff/slack helpers`.

---

## Task 2: `git-branches.ts` — parser + listGitBranches (main)

**Files:** Create `src/main/projects/git-branches.ts` + `.spec.ts` (parser only).

- [ ] **Test first** (pure parser):
```ts
// git-branches.spec.ts
import { describe, expect, it } from "vitest";
import { parseGitBranches } from "./git-branches";

describe("parseGitBranches", () => {
  it("splits local + remote, drops HEAD and origin/HEAD, trims, dedupes", () => {
    const local = "main\ndevelop\nfeature/x\n";
    const remote = "origin/HEAD\norigin/main\norigin/feature/x\norigin/feature/y\n";
    expect(parseGitBranches(local, remote)).toEqual({
      local: ["main", "develop", "feature/x"],
      remote: ["origin/main", "origin/feature/x", "origin/feature/y"],
    });
  });
  it("handles empty input", () => {
    expect(parseGitBranches("", "")).toEqual({ local: [], remote: [] });
  });
});
```

- [ ] **Implement:**
```ts
// git-branches.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BranchList {
  local: string[];
  remote: string[];
}

function cleanLines(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name === "HEAD" || name.endsWith("/HEAD")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function parseGitBranches(localRaw: string, remoteRaw: string): BranchList {
  return { local: cleanLines(localRaw), remote: cleanLines(remoteRaw) };
}

export async function listGitBranches(params: {
  projectRoot: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<BranchList> {
  const exec = params.execFileImpl ?? execFileAsync;
  // Best-effort refresh so freshly-pushed remote PR branches appear; ignore if offline.
  try {
    await exec("git", ["fetch", "--all", "--prune"], { cwd: params.projectRoot });
  } catch {
    // offline / no remote — list whatever refs exist
  }
  const [local, remote] = await Promise.all([
    exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: params.projectRoot }),
    exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], { cwd: params.projectRoot }),
  ]);
  return parseGitBranches(local.stdout, remote.stdout);
}
```
- [ ] Run spec (green), typecheck, commit: `feat(review): git branch listing (local + remote)`.

---

## Task 3: review session kind + baseBranch + detached worktree + createReviewSession

**Files:** Modify `work-session.ts`, `worktree-manager.ts`, `session-registry.ts`. Extend the registry spec.

- [ ] **work-session.ts:** `export type WorkSessionKind = "feature" | "fix" | "review";` and add to `WorkSession`: `baseBranch: string | null;`

- [ ] **worktree-manager.ts:** add `detach?: boolean` to `createWorktree` params; in the args:
```ts
const args = params.detach
  ? ["worktree", "add", "--detach", plan.path, params.branch]
  : params.createBranch
    ? ["worktree", "add", "-b", params.branch, plan.path]
    : ["worktree", "add", plan.path, params.branch];
```

- [ ] **session-registry.ts:** In `SessionRegistry`, add:
```ts
createReviewSession(params: {
  projectId: string;
  projectRoot: string;
  name: string;
  reviewBranch: string;
  baseBranch: string;
}): Promise<WorkSession>;
```
Implement (mirror `createSession`, but detached from the existing ref, base stored, no env, `checkpointPath: null`):
```ts
async createReviewSession({ projectId, projectRoot, name, reviewBranch, baseBranch }) {
  const slug = slugifySessionName(name);
  if (!slug) throw new Error("Session name must contain at least one alphanumeric character.");
  const worktreePath = buildWorktreeCreatePlan({ projectRoot, slug, branch: reviewBranch }).path;
  try {
    await execFileAsync("git", ["fetch", "--all", "--prune"], { cwd: projectRoot });
  } catch {
    /* offline — the ref may still exist locally */
  }
  await createWorktree({ projectRoot, slug, branch: reviewBranch, detach: true });
  const session: WorkSession = {
    id: randomUUID(),
    projectId,
    name,
    kind: "review",
    slug,
    branch: reviewBranch,
    baseBranch,
    worktreePath,
    checkpointPath: null,
    createdAtEpochMs: Date.now(),
  };
  await appendSession(session); // use the file's existing persist helper
  return session;
}
```
(Read the file for the exact persist call + `execFileAsync` import — add `import { execFile } from "node:child_process"` + `promisify` if not present. Also add `baseBranch: null` to the EXISTING `createSession` record literal so the type is satisfied.)

- [ ] **Registry spec:** add a case that `createReviewSession` returns `kind: "review"`, `branch: reviewBranch`, `baseBranch` set, `checkpointPath: null`. Use the spec's existing temp-dir + a real `git init` + a branch (mirror `worktree-manager.spec.ts` which does real git). If the existing session-registry spec mocks git, follow its pattern; otherwise gate this behind a real-git helper like worktree-manager.spec does.

- [ ] Run specs + typecheck (the `baseBranch` addition will surface any WorkSession fixture missing it — fix them, same as the autoPilot fixtures). Commit: `feat(review): review session kind + detached worktree + createReviewSession`.

---

## Task 4: Thread `review: ReviewConfig` through registry + contract

**Files:** Modify `project-registry.ts`, `sqlite-project-registry.ts`, `contract.ts`. Extend sqlite spec. **Exactly mirrors the `autoPilot` threading (commit 4a2a9c7).**

- [ ] `project-registry.ts`: import `createDefaultReviewConfig` + `ReviewConfig`; add `review: ReviewConfig` to `ProjectRecord`; `review?: ReviewConfig` to `ProjectUpdateInput` + the `addProject` input; defaults in add (`input.review ?? createDefaultReviewConfig()`) + update (`input.review ?? current.review`).
- [ ] `sqlite-project-registry.ts`: `review: string` on `ProjectRow`; `ensureSchema` ADD COLUMN `review` (backfill with `JSON.stringify(createDefaultReviewConfig())`); `rowToRecord` parse; `insertRecord` column+value+param; `updateRecord` SET+param; addProject + legacy-migration literals default.
- [ ] `contract.ts`: import `ReviewConfig`; add `review?: ReviewConfig` to `ProjectCreateInput`.
- [ ] sqlite spec: add a round-trip test (default on add + updated value persists), mirroring the autoPilot one.
- [ ] Fix any `ProjectRecord` fixtures now missing `review` (checkpoint-scanner.spec, checkpoint-watch-manager.spec — same two as autoPilot).
- [ ] typecheck + full test suite green. Commit: `feat(review): persist per-project ReviewConfig`.

---

## Task 5: IPC + preload wiring (createReview, listBranches, review kickoff)

**Files:** Modify `contract.ts`, `register-ipc-handlers.ts`, `preload/index.ts`.

- [ ] `contract.ts`:
  - `export interface ReviewSessionCreateInput { name: string; reviewBranch: string; baseBranch: string }`
  - `BranchList` type (or import from git-branches — but contract shouldn't import from main; re-declare `{ local: string[]; remote: string[] }`).
  - Add channels: `sessionsCreateReview: "sessions:create-review"`, `gitListBranches: "git:list-branches"`.
  - `AgentCoordinatorApi.sessions.createReview(projectId, input): Promise<WorkSession>`.
  - New `git: { listBranches(projectId): Promise<{ local: string[]; remote: string[] }> }`.
- [ ] `register-ipc-handlers.ts`:
  - Handler `sessionsCreateReview` → `sessionRegistry.createReviewSession({ projectId, projectRoot: project.rootPath, ...input })`.
  - Handler `gitListBranches` → `listGitBranches({ projectRoot: project.rootPath })` (import from `../projects/git-branches`).
  - In the `buildRoleLaunch` handler (~line 230-270), when `session.kind === "review" && role === "reviewer"`, set `wfCommand = substituteReviewKickoff(project.review.kickoff, { branch: session.branch, base: session.baseBranch ?? "" })` instead of `wfCommandForSessionRole(...)`. (Need `project` in scope there — it already resolves the project for runtimeConfig; reuse it. Import `substituteReviewKickoff`.)
- [ ] `preload/index.ts`: expose `sessions.createReview` + `git.listBranches`.
- [ ] typecheck + tests green. Commit: `feat(review): createReview + listBranches IPC + reviewer kickoff`.

---

## Task 6: ProjectModal — PR Review config section (device)

**Files:** Modify `ProjectModal.tsx`, `styles.css`.

- [ ] Import `createDefaultReviewConfig` + `ReviewConfig`; state `const [review, setReview] = useState<ReviewConfig>(project?.review ?? createDefaultReviewConfig());`
- [ ] Pass `review` in both `projects.add` and `projects.update` payloads.
- [ ] Add a "PR Review" `<section>` after the Auto-pilot section: **Slack channel** text input (`review.slackChannel`, placeholder `#pr-reviews`) + **Review kickoff** `<textarea>` (`review.kickoff`, placeholder = the default). Reuse `.section-hint` / `.autopilot-config` styles; add `.review-config textarea { width: 100%; min-height: 72px; }` if needed.
- [ ] typecheck. Commit: `feat(review): PR review config in ProjectModal`.

---

## Task 7: NewSessionDialog — Review kind + branch pickers (device)

**Files:** Modify `NewSessionDialog.tsx`, `styles.css`.

- [ ] Add `{ value: "review", label: "PR review" }` to `KIND_OPTIONS`.
- [ ] When `kind === "review"`, render the review form instead of name+copyEnv:
  - On switching to review (or dialog open with review), call `window.agentCoordinator.git.listBranches(projectId)` → store `{ local, remote }`; show a loading state.
  - **Branch to review**: a `<select>` with two `<optgroup>`s (Local / Remote). On change, if name is untouched, auto-fill `name` from the branch.
  - **Base branch**: text input, placeholder `main`, default value `""` (user types; could prefill "develop" — leave blank with placeholder).
  - Keep a `name` field (auto-filled, editable).
- [ ] Submit branches on kind:
  - review → `window.agentCoordinator.sessions.createReview(projectId, { name: name.trim(), reviewBranch, baseBranch: baseBranch.trim() })`
  - feature/fix → existing `sessions.create`.
- [ ] `canSubmit` for review = `name.trim() && reviewBranch && baseBranch.trim()`.
- [ ] typecheck. Commit: `feat(review): review kind + branch pickers in NewSessionDialog`.

---

## Task 8: SessionView review mode + Post-to-Slack + App wiring (device)

**Files:** Modify `SessionView.tsx`, `App.tsx`, `styles.css`.

- [ ] **App.tsx:** pass `reviewConfig={projects.find((p) => p.id === session.projectId)?.review}` to SessionView (like `autoPilotConfig`).
- [ ] **SessionView props:** add `reviewConfig?: ReviewConfig`. Compute `const reviewMode = session.kind === "review";`
- [ ] **Tab gating:** treat `reviewMode` like `repoMode` for hiding architect/implementer + checkpoint/Log, BUT still show the Reviewer tab. Concretely:
  - The agent-tabs list: in review mode, force `openedRoleTabs` to just `["reviewer"]` (seed it, StrictMode-safe, like `seedRepoShell`): initialise `openedRoleTabs` to `new Map([["reviewer", "fresh"]])` when `reviewMode`.
  - Hide the architect/implementer tab buttons in review mode (render only the Reviewer button, or reuse the existing role-buttons map filtered to `reviewer`).
  - Log/checkpoint tab: gate off like `repoMode` (`!repoMode && !reviewMode`).
  - Default `activeTab` → `"reviewer"` in review mode.
- [ ] **Reviewer auto-submit:** render the reviewer `SessionTerminal` with `autoSubmitWf={reviewMode || conductorAutoRoles.has(role)}` — in review mode the kickoff (delivered as `wfCommand` by Task 5) auto-submits on launch.
- [ ] **Diff base:** pass the base to the diff so it shows `branch` vs `base`. Check `GitDiffView`/`getWorktreeDiff` — if it currently diffs the worktree against its own base automatically, a review worktree is detached so it may need the explicit base. If `getWorktreeDiff` takes only a path, leave as-is for v1 and note the diff may show working-tree changes only; a follow-up can pass `baseBranch`. (Don't block the task on this — the agent does the real diff.)
- [ ] **Topbar (review mode):** a gold **REVIEW** chip (reuse `session-topbar-kind-repo` styling) + a **Post to Slack** button:
```tsx
{reviewMode && (
  <button
    type="button"
    className="session-topbar-diff"
    disabled={!reviewConfig?.slackChannel}
    title={reviewConfig?.slackChannel ? `Post the review to ${reviewConfig.slackChannel}` : "Set a Slack channel in project config first"}
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
```
  Import `buildSlackPostCommand` + `ReviewConfig`.
- [ ] typecheck + full test suite green + `pnpm build`. Commit: `feat(review): SessionView review mode + Post-to-Slack`.

- [ ] **Device verification (the gate for T6–T8):**
  1. Project config: set a Slack channel + (optionally) a custom kickoff; Save; reopen — persisted.
  2. New session → **PR review**: the branch picker lists **remote** branches (`origin/…`) and local; pick one; set base; create.
  3. Session opens in review mode: only the Reviewer tab, and it **auto-runs the kickoff** (agent starts reviewing; for Biznex it invokes `biznex-pr-review`).
  4. **Post to Slack**: click → the reviewer terminal gets the "post to #channel" instruction and the agent posts it. Disabled when no channel configured.
  5. Close the review session → its detached worktree is removed.

## Deferred
- `gh` PR-by-number import (branch + base only in v1).
- Diff view explicitly rooted at `base...branch` (v1 may show only worktree changes; the agent does the authoritative diff).
- Review artifact file + native Slack posting (chosen against in brainstorming).
