import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import { parseProgramSpec, resolveProgram, type ProgramChild } from "../../shared/workflow/program-spec";

const execFileAsync = promisify(execFile);

/** A program committed on a ref, with each child's state read from its checkpoint. */
export interface RefProgram {
  /** Repo-relative path of the program spec. */
  path: string;
  title: string;
  children: ProgramChild[];
  next: ProgramChild | null;
  complete: boolean;
}

const SPEC_DIR = "docs/workflow/specs/";

async function gitOutput(projectRoot: string, args: string[], exec: typeof execFileAsync): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd: projectRoot });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * List the programs committed on a ref WITHOUT checking it out — the new-session
 * dialog offers "start the next child" before any worktree exists. A spec is a
 * program when it carries a `# Hijos` table; every other spec is skipped
 * without reading it twice. An unresolvable ref yields an empty list.
 */
export async function listRefPrograms(params: {
  projectRoot: string;
  ref: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<RefProgram[]> {
  const exec = params.execFileImpl ?? execFileAsync;
  const tree = await gitOutput(params.projectRoot, ["ls-tree", "-r", "--name-only", params.ref], exec);
  if (tree === null) return [];
  const paths = tree
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SPEC_DIR) && line.endsWith(".md") && !line.slice(SPEC_DIR.length).includes("/"))
    .sort();

  const found: RefProgram[] = [];
  for (const path of paths) {
    const markdown = await gitOutput(params.projectRoot, ["show", `${params.ref}:${path}`], exec);
    if (markdown === null) continue;
    const spec = parseProgramSpec(markdown);
    if (!spec) continue;
    const statuses = new Map<string, string | null>();
    for (const child of spec.children) {
      if (!child.checkpoint) continue;
      const checkpoint = await gitOutput(params.projectRoot, ["show", `${params.ref}:${child.checkpoint}`], exec);
      statuses.set(
        child.checkpoint,
        checkpoint === null ? null : parseCheckpointMarkdown({ checkpointPath: child.checkpoint, markdown: checkpoint }).status,
      );
    }
    const resolved = resolveProgram(spec, (checkpointPath) => statuses.get(checkpointPath) ?? null);
    found.push({ path, title: resolved.title, children: resolved.children, next: resolved.next, complete: resolved.complete });
  }
  return found;
}
