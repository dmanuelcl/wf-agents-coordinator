import { hasProgramSection } from "../../shared/workflow/program-spec";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import { createGitRunner } from "./program-merge";
import { readProgramVerdict } from "./program-status";

const SPEC_DIR = "docs/workflow/specs/";

/**
 * The programs committed on a ref, each with the verdict `wf:next` would give —
 * WITHOUT checking the ref out, because the new-session dialog offers «Iniciar
 * hijo N» before any worktree exists. A spec is a program when it has a
 * `# Hijos` section; a broken table is listed as BLOCKED rather than hidden.
 * An unresolvable ref yields an empty list.
 */
export async function listRefPrograms(params: { projectRoot: string; ref: string; fetchNote?: string | null }): Promise<ProgramVerdict[]> {
  const git = createGitRunner(params.projectRoot);
  const tree = await git(["ls-tree", "-r", "--name-only", params.ref]);
  if (tree === null) return [];
  const paths = tree
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SPEC_DIR) && line.endsWith(".md") && !line.slice(SPEC_DIR.length).includes("/"))
    .sort();

  const found: ProgramVerdict[] = [];
  for (const path of paths) {
    const markdown = await git(["show", `${params.ref}:${path}`]);
    if (markdown === null || !hasProgramSection(markdown)) continue;
    found.push(
      await readProgramVerdict({
        projectRoot: params.projectRoot,
        specPath: path,
        source: { kind: "ref", ref: params.ref },
        fetchNote: params.fetchNote ?? null,
      }),
    );
  }
  return found;
}
