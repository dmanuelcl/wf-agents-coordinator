import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { parseCheckpointMarkdown } from "../../shared/workflow/checkpoint-parser";
import type { ParsedCheckpoint } from "../../shared/workflow/workflow-types";
import type { ProjectRecord } from "./project-registry";

const execFileAsync = promisify(execFile);

async function listGitWorktrees(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectRoot,
    });
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        paths.push(line.slice("worktree ".length).trim());
      }
    }
    return paths;
  } catch {
    return [];
  }
}

async function listSubdirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dirPath, entry.name));
  } catch {
    return [];
  }
}

export async function resolveScanRoots(projectRoot: string): Promise<string[]> {
  const gitWorktrees = await listGitWorktrees(projectRoot);
  if (gitWorktrees.length > 0) {
    return gitWorktrees;
  }

  const worktreeDirs = await listSubdirectories(join(projectRoot, ".worktrees"));
  return [projectRoot, ...worktreeDirs];
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function findCheckpointFiles(root: string, glob: string): Promise<string[]> {
  const segments = glob.split("/");
  const fileNamePattern = segments.pop();
  if (!fileNamePattern) return [];
  const dirPath = join(root, ...segments);

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }

  const regex = patternToRegex(fileNamePattern);
  return entries.filter((name) => regex.test(name)).map((name) => join(dirPath, name));
}

export async function scanProjectCheckpoints(params: { project: ProjectRecord }): Promise<ParsedCheckpoint[]> {
  const { project } = params;
  const roots = await resolveScanRoots(project.rootPath);
  const bySlug = new Map<string, ParsedCheckpoint>();

  for (const root of roots) {
    for (const glob of project.checkpointGlobs) {
      const files = await findCheckpointFiles(root, glob);
      for (const filePath of files) {
        const markdown = await readFile(filePath, "utf8");
        const checkpointPath = relative(project.rootPath, filePath);
        const parsed = parseCheckpointMarkdown({ checkpointPath, markdown });
        const key = parsed.slug ?? filePath;
        if (!bySlug.has(key)) {
          bySlug.set(key, parsed);
        }
      }
    }
  }

  return Array.from(bySlug.values());
}
