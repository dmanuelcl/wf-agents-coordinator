import { frontmatterField, hasProgramSection, localBranchName, programRows } from "../../shared/workflow/program-spec";
import { PROGRAM_MERGE_BASE } from "../../shared/workflow/program-verdict";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import { createGitRunner } from "./program-merge";
import type { GitRunner } from "./program-merge";
import { readProgramVerdict } from "./program-status";

const SPEC_DIR = "docs/workflow/specs/";

/**
 * The programs committed on a ref, each with the verdict `wf:next` would give —
 * WITHOUT checking the ref out, because the new-session dialog offers «Iniciar
 * hijo N» before any worktree exists. A spec is a program when it has a
 * `# Hijos` section; a broken table is listed as BLOCKED rather than hidden.
 * Only the ref's OWN programs are listed (`programBelongsTo`): every branch
 * also carries the programs merged into develop. An unresolvable ref yields an
 * empty list.
 */
/**
 * Is this program the ref's own, or did it only arrive through develop? Its
 * children say where they were made (frontmatter `branch:`). A program with no
 * child checkpoint yet belongs to the ref only while its spec is not in
 * develop, i.e. it was born on this branch and has not been merged.
 */
async function programBelongsTo(git: GitRunner, ref: string, markdown: string, specPath: string): Promise<boolean> {
  const branch = localBranchName(ref);
  let children = 0;
  for (const row of programRows(markdown)) {
    if (!row.checkpoint) continue;
    const text = await git(["show", `${ref}:${row.checkpoint}`]);
    if (text === null) continue;
    children += 1;
    const childBranch = frontmatterField(text, "branch");
    if (childBranch !== null && localBranchName(childBranch) === branch) return true;
  }
  if (children > 0) return false;
  return (await git(["cat-file", "-e", `${PROGRAM_MERGE_BASE}:${specPath}`])) === null;
}

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
    if (!(await programBelongsTo(git, params.ref, markdown, path))) continue;
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
