import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { frontmatterStatus } from "../../shared/workflow/program-spec";
import type { ChildMerge } from "../../shared/workflow/program-verdict";

const execFileAsync = promisify(execFile);

/** Runs git in one directory: trimmed stdout, or null when git fails (a non-zero exit included). */
export type GitRunner = (args: string[]) => Promise<string | null>;

export function createGitRunner(cwd: string, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): GitRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {}),
      });
      return stdout.trim();
    } catch {
      return null;
    }
  };
}

/**
 * A background fetch must never wait on a prompt (Biznex `refreshMergeBase`,
 * 802fb00cb): no terminal credential prompt, and ssh in batch mode — unless the
 * user already configured their own ssh command, which this must not override.
 */
async function nonInteractiveEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!env.GIT_SSH_COMMAND && !(await createGitRunner(cwd)(["config", "--get", "core.sshCommand"]))) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=10";
  }
  return env;
}

const HOW = "abre el PR del hijo contra develop y espera a que esté merjeado: el siguiente hijo no se abre sobre un hijo sin merjear";

/**
 * `childMergeError` of Biznex scripts/wf-done.ts (a29f1cac4), reading `ref`
 * (HEAD for a worktree, a branch for the dialog) instead of always HEAD. The
 * close commit is the last one on `ref` that put `status: DONE` in the child's
 * checkpoint; merged means that commit is an ancestor of `base`. A squash merge
 * leaves no ancestor, so then it is enough that `base` already has the
 * checkpoint DONE. Anything unverifiable blocks.
 */
export async function childMerge(params: {
  git: GitRunner;
  index: number;
  checkpointPath: string;
  ref: string;
  base: string;
  fetchNote: string | null;
}): Promise<ChildMerge> {
  const { git, index, checkpointPath, ref, base, fetchNote } = params;
  const note = fetchNote ? ` (${fetchNote})` : "";
  if ((await git(["rev-parse", "--is-inside-work-tree"])) !== "true") {
    return { state: "unknown", closeSha: null, reason: `hijo ${index}: no se pudo verificar su merge en ${base} — no es un repositorio git` };
  }
  if ((await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`])) === null) {
    return { state: "unknown", closeSha: null, reason: `hijo ${index}: no se pudo verificar su merge — \`${base}\` no existe${note}` };
  }
  const closeSha = (await git(["log", "-1", "--format=%H", "-G", "^status:[[:space:]]*DONE", ref, "--", checkpointPath])) || null;
  const closedAtSha = closeSha ? frontmatterStatus((await git(["show", `${closeSha}:${checkpointPath}`])) ?? "") === "DONE" : false;
  if (closeSha && closedAtSha && (await git(["merge-base", "--is-ancestor", closeSha, base])) !== null) {
    return { state: "merged", closeSha, reason: null };
  }
  if (frontmatterStatus((await git(["show", `${base}:${checkpointPath}`])) ?? "") === "DONE") {
    return { state: "merged", closeSha, reason: null };
  }
  if (!closeSha || !closedAtSha) {
    return {
      state: "uncommitted",
      closeSha: null,
      reason: `hijo ${index}: el cierre (\`status: DONE\` en ${checkpointPath}) no está commiteado — commitéalo, ${HOW}${note}`,
    };
  }
  return { state: "unmerged", closeSha, reason: `hijo ${index}: su commit de cierre ${closeSha.slice(0, 10)} no está en ${base} — ${HOW}${note}` };
}

export interface MergeBaseRefresher {
  /**
   * Refresh `<remote>/<branch>` at most once per interval per repo (always when
   * `force`). Returns the note to show when the fetch failed, else null. A stale
   * local copy can only block more, never let a child through.
   */
  refresh(projectRoot: string, base: string, force: boolean): Promise<string | null>;
}

export function createMergeBaseRefresher(
  params: { intervalMs?: number; now?: () => number; runGit?: (cwd: string, args: string[]) => Promise<string | null> } = {},
): MergeBaseRefresher {
  const intervalMs = params.intervalMs ?? 120_000;
  const now = params.now ?? Date.now;
  const runGit =
    params.runGit ?? (async (cwd: string, args: string[]) => createGitRunner(cwd, { timeoutMs: 20_000, env: await nonInteractiveEnv(cwd) })(args));
  const last = new Map<string, { at: number; note: string | null }>();
  const inFlight = new Map<string, Promise<string | null>>();
  return {
    refresh(projectRoot, base, force) {
      const slash = base.indexOf("/");
      if (slash <= 0) return Promise.resolve(null);
      const key = `${projectRoot}\u0000${base}`;
      const previous = last.get(key);
      if (!force && previous && now() - previous.at < intervalMs) return Promise.resolve(previous.note);
      const running = inFlight.get(key);
      if (running) return running;
      const task = runGit(projectRoot, ["fetch", "--quiet", base.slice(0, slash), base.slice(slash + 1)]).then((output) => {
        const note = output === null ? `no se pudo actualizar ${base} con \`git fetch\`: se leyó la copia local` : null;
        last.set(key, { at: now(), note });
        inFlight.delete(key);
        return note;
      });
      inFlight.set(key, task);
      return task;
    },
  };
}
