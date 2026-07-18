import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REUSABLE_DIRECTORY_NAMES = new Set(["dist", "generated"]);
const SCAN_SKIP_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  ".turbo",
  ".cache",
  ".next",
  "coverage",
]);

export interface WorktreeArtifactReuseResult {
  directories: string[];
  filesCopied: number;
}

type ExecFileLike = typeof execFileAsync;

function assertWorktreeInsideProject(projectRoot: string, worktreePath: string): void {
  const worktreesRoot = resolve(projectRoot, ".worktrees");
  const target = resolve(worktreePath);
  const rel = relative(worktreesRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to reuse artifacts outside "${worktreesRoot}": "${target}".`);
  }
}

async function gitOutput(exec: ExecFileLike, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return String(stdout).trim();
}

async function assertCompatibleSource(params: {
  projectRoot: string;
  worktreePath: string;
  exec: ExecFileLike;
}): Promise<void> {
  const [sourceHead, targetHead, trackedStatus] = await Promise.all([
    gitOutput(params.exec, params.projectRoot, ["rev-parse", "HEAD"]),
    gitOutput(params.exec, params.worktreePath, ["rev-parse", "HEAD"]),
    gitOutput(params.exec, params.projectRoot, ["status", "--porcelain=v1", "--untracked-files=no"]),
  ]);

  if (sourceHead !== targetHead) {
    throw new Error(
      "Cannot reuse dist/generated: the repo root and the new worktree are on different commits. Run the normal worktree setup instead.",
    );
  }
  if (trackedStatus) {
    throw new Error(
      "Cannot safely reuse dist/generated while the repo root has uncommitted tracked changes. Commit/stash them, or run the normal worktree setup.",
    );
  }
}

async function findCandidateDirectories(
  projectRoot: string,
  dir = projectRoot,
  depth = 0,
): Promise<string[]> {
  if (depth > 12) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || SCAN_SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (REUSABLE_DIRECTORY_NAMES.has(entry.name)) {
      candidates.push(relative(projectRoot, full));
      // A generated directory inside dist is already covered by its parent.
      continue;
    }
    candidates.push(...(await findCandidateDirectories(projectRoot, full, depth + 1)));
  }

  return candidates;
}

async function isIgnoredAndUntracked(exec: ExecFileLike, projectRoot: string, candidate: string): Promise<boolean> {
  try {
    await exec("git", ["check-ignore", "-q", "--", candidate], { cwd: projectRoot });
  } catch {
    return false;
  }

  const tracked = await gitOutput(exec, projectRoot, ["ls-files", "--", candidate]);
  return tracked.length === 0;
}

async function cloneTree(source: string, target: string): Promise<number> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) {
    const linkTarget = await readlink(source);
    await symlink(linkTarget, target);
    return 1;
  }
  if (sourceInfo.isFile()) {
    // COPYFILE_FICLONE uses a copy-on-write clone on APFS/Btrfs when available
    // and transparently falls back to a regular copy on other filesystems.
    await copyFile(source, target, constants.COPYFILE_FICLONE);
    return 1;
  }
  if (!sourceInfo.isDirectory()) return 0;

  await mkdir(target, { recursive: true });
  const entries = await readdir(source);
  let filesCopied = 0;
  for (const entry of entries) {
    filesCopied += await cloneTree(join(source, entry), join(target, entry));
  }
  return filesCopied;
}

/**
 * Reuse ignored build/codegen output from the repo root in a fresh worktree.
 * This is intentionally conservative because a successful result lets the
 * caller skip its normal setup command: source and target must be the same
 * clean tracked revision, and tracked dist/generated directories are never
 * copied. The user still owns the assertion that the root output is current.
 */
export async function reuseWorktreeArtifacts(params: {
  projectRoot: string;
  worktreePath: string;
  execFileImpl?: ExecFileLike;
}): Promise<WorktreeArtifactReuseResult> {
  assertWorktreeInsideProject(params.projectRoot, params.worktreePath);
  const exec = params.execFileImpl ?? execFileAsync;
  await assertCompatibleSource({ projectRoot: params.projectRoot, worktreePath: params.worktreePath, exec });

  const candidates = await findCandidateDirectories(params.projectRoot);
  const reusable: string[] = [];
  for (const candidate of candidates) {
    if (await isIgnoredAndUntracked(exec, params.projectRoot, candidate)) reusable.push(candidate);
  }
  if (reusable.length === 0) {
    throw new Error(
      "Cannot reuse setup: no ignored dist/generated directories were found in the repo root. Run the normal worktree setup instead.",
    );
  }

  let filesCopied = 0;
  for (const candidate of reusable) {
    filesCopied += await cloneTree(join(params.projectRoot, candidate), join(params.worktreePath, candidate));
  }
  if (filesCopied === 0) {
    throw new Error(
      "Cannot reuse setup: the ignored dist/generated directories in the repo root are empty. Run the normal worktree setup instead.",
    );
  }

  return { directories: reusable, filesCopied };
}
