import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createEmptyRepo(params: {
  parentPath: string;
  name: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<{ rootPath: string }> {
  const rootPath = join(params.parentPath, params.name);

  if (existsSync(rootPath)) {
    const entries = await readdir(rootPath);
    if (entries.length > 0) {
      throw new Error(`Refusing to create repo: target "${rootPath}" already exists and is not empty.`);
    }
  }

  await mkdir(rootPath, { recursive: true });

  const exec = params.execFileImpl ?? execFileAsync;
  await exec("git", ["init"], { cwd: rootPath });

  return { rootPath };
}

export async function cloneRepo(params: {
  url: string;
  parentPath: string;
  name: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<{ rootPath: string }> {
  const rootPath = join(params.parentPath, params.name);

  await mkdir(params.parentPath, { recursive: true });

  const exec = params.execFileImpl ?? execFileAsync;
  await exec("git", ["clone", params.url, rootPath]);

  return { rootPath };
}
