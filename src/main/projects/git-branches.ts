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

/**
 * Parse `git for-each-ref --format=%(refname:short)` output for local heads and
 * remotes into a deduped, trimmed branch list. Drops `HEAD` and `<remote>/HEAD`.
 */
export function parseGitBranches(localRaw: string, remoteRaw: string): BranchList {
  return { local: cleanLines(localRaw), remote: cleanLines(remoteRaw) };
}

/**
 * List a project's local + remote branches. Best-effort fetches first so
 * freshly-pushed remote PR branches appear; if that fails (offline / no remote)
 * the existing refs are still listed.
 */
export async function listGitBranches(params: {
  projectRoot: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<BranchList> {
  const exec = params.execFileImpl ?? execFileAsync;
  try {
    await exec("git", ["fetch", "--all", "--prune"], { cwd: params.projectRoot });
  } catch {
    // offline / no remote — list whatever refs exist locally
  }
  const [local, remote] = await Promise.all([
    exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: params.projectRoot }),
    exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], { cwd: params.projectRoot }),
  ]);
  return parseGitBranches(local.stdout, remote.stdout);
}
