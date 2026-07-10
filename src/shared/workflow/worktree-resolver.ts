import * as nodePath from "node:path";

export type WorktreeCwdSource = "next" | "frontmatter" | "project-root";

export interface ResolveWorkflowCwdParams {
  projectRoot: string;
  nextCwd: string | null;
  frontmatterWorktree: string | null;
  pathModule?: typeof nodePath;
}

export interface ResolveWorkflowCwdResult {
  cwd: string;
  source: WorktreeCwdSource;
  outsideProjectRoot: boolean;
  warnings: string[];
}

export function resolveWorkflowCwd(params: ResolveWorkflowCwdParams): ResolveWorkflowCwdResult {
  const path = params.pathModule ?? nodePath;
  const warnings: string[] = [];

  let source: WorktreeCwdSource;
  let chosen: string;

  if (params.nextCwd) {
    source = "next";
    chosen = params.nextCwd;
    if (params.frontmatterWorktree && params.frontmatterWorktree !== params.nextCwd) {
      warnings.push(
        `NEXT cwd ("${params.nextCwd}") conflicts with frontmatter worktree ("${params.frontmatterWorktree}"); using NEXT cwd.`,
      );
    }
  } else if (params.frontmatterWorktree) {
    source = "frontmatter";
    chosen = params.frontmatterWorktree;
  } else {
    source = "project-root";
    chosen = ".";
  }

  const resolved =
    chosen === "."
      ? params.projectRoot
      : path.isAbsolute(chosen)
        ? chosen
        : path.resolve(params.projectRoot, chosen);

  const relative = path.relative(params.projectRoot, resolved);
  const outsideProjectRoot = relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative));

  if (outsideProjectRoot) {
    warnings.push(`Resolved cwd "${resolved}" is outside the project root "${params.projectRoot}".`);
  }

  return { cwd: resolved, source, outsideProjectRoot, warnings };
}
