import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";

const execFileAsync = promisify(execFile);

/** Enough to identify a checkpoint in a picker, without shipping the whole parse. */
export interface RefCheckpoint {
  /** Repo-root-relative, which is also its path inside any worktree. */
  path: string;
  feature: string | null;
  slug: string | null;
  status: string;
}

const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Match a repo-relative path against one of a project's `checkpointGlobs`.
 * `*` deliberately does not cross `/`, so a stale copy under
 * `checkpoints/old/` is not offered as if it lived in the configured
 * directory. This works on paths listed from a ref, so unlike
 * `checkpoint-scanner` it matches the full path rather than the filename.
 */
export function matchesCheckpointGlob(path: string, glob: string): boolean {
  const pattern = glob.replace(GLOB_SPECIALS, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`).test(path);
}

async function gitOutput(projectRoot: string, args: string[], exec: typeof execFileAsync): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd: projectRoot });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * List the checkpoints committed on a ref WITHOUT checking it out — the
 * new-session dialog has to show them before any worktree exists, and must
 * never disturb the repo root's working tree. A ref that does not resolve
 * yields an empty list rather than an error: the picker simply has nothing to
 * offer, and creation reports the missing ref with its own message.
 */
export async function listRefCheckpoints(params: {
  projectRoot: string;
  ref: string;
  globs: readonly string[];
  execFileImpl?: typeof execFileAsync;
}): Promise<RefCheckpoint[]> {
  const exec = params.execFileImpl ?? execFileAsync;
  const tree = await gitOutput(params.projectRoot, ["ls-tree", "-r", "--name-only", params.ref], exec);
  if (tree === null) return [];

  const paths = tree
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && params.globs.some((glob) => matchesCheckpointGlob(line, glob)))
    .sort();

  const found: RefCheckpoint[] = [];
  for (const path of paths) {
    const markdown = await gitOutput(params.projectRoot, ["show", `${params.ref}:${path}`], exec);
    if (markdown === null) continue;
    const parsed = parseCheckpointMarkdown({ checkpointPath: path, markdown });
    found.push({ path, feature: parsed.feature, slug: parsed.slug, status: parsed.status });
  }
  return found;
}
