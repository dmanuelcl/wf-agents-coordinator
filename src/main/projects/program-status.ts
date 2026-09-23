import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HIJOS_DECLARED, childrenAddedByUser, hasProgramSection, programRows } from "../../shared/workflow/program-spec";
import { PROGRAM_MERGE_BASE, blockedProgramVerdict, decideProgramVerdict, doneChildRows } from "../../shared/workflow/program-verdict";
import type { ChildMerge, ProgramVerdict } from "../../shared/workflow/program-verdict";
import { childMerge, createGitRunner } from "./program-merge";
import type { GitRunner } from "./program-merge";

/**
 * Where a program is read from: a session's worktree (the files on disk and
 * HEAD, which is what `pnpm wf:next` reads) or a ref with no checkout (the
 * new-session dialog, before any worktree exists).
 */
export type ProgramSource = { kind: "worktree"; worktreePath: string } | { kind: "ref"; ref: string };

/**
 * THE INDEX IS BORN FROZEN, BY GIT — `programBirthErrors` of Biznex
 * scripts/wf-done.ts (802fb00cb). The `Hijos: <n>` of the OLDEST commit of the
 * spec that has one (following renames) is the ceiling: `Hijos:` never grows,
 * and the table holds at most that many rows plus the user's own-line
 * exceptions. A spec never committed is being born: nothing to compare.
 */
export async function programBirthErrors(params: { git: GitRunner; ref: string; specPath: string; programText: string }): Promise<string[]> {
  const { git, ref, specPath, programText } = params;
  const history = await git(["log", "--follow", "--format=%x00%H", "--name-only", ref, "--", specPath]);
  if (!history) return [];
  const commits = history
    .split("\u0000")
    .filter((chunk) => chunk.trim())
    .map((chunk) => chunk.trim().split("\n").filter(Boolean))
    .reverse();
  let sha = "";
  let born: string | undefined;
  for (const [hash, path] of commits) {
    const value = hash && path ? (await git(["show", `${hash}:${path}`]))?.match(HIJOS_DECLARED)?.[1] : undefined;
    if (value && hash) {
      sha = hash;
      born = value;
      break;
    }
  }
  if (!born) return [];
  const errors: string[] = [];
  const now = programText.match(HIJOS_DECLARED)?.[1];
  const added = childrenAddedByUser(programText);
  const rows = programRows(programText).length;
  const how =
    "el índice nace congelado: un follow-up promovido es un feature aparte, nunca un hijo; una excepción del usuario va como `Hijo añadido por el usuario: «…»` verbatim en el spec-programa, sin tocar `Hijos:`";
  if (now && Number.parseInt(now, 10) > Number.parseInt(born, 10)) {
    errors.push(`${specPath}: nació con \`Hijos: ${born}\` (commit ${sha.slice(0, 10)}) y ahora dice \`Hijos: ${now}\` — ${how}`);
  }
  if (rows > Number.parseInt(born, 10) + added) {
    errors.push(
      `${specPath}: \`# Hijos\` tiene ${rows} filas y nació con \`Hijos: ${born}\` (commit ${sha.slice(0, 10)})${added > 0 ? ` + ${added} añadidos por el usuario` : ""} — ${how}`,
    );
  }
  return errors;
}

export async function readProgramVerdict(params: {
  projectRoot: string;
  specPath: string;
  source: ProgramSource;
  fetchNote: string | null;
  base?: string;
  now?: () => number;
}): Promise<ProgramVerdict> {
  const { projectRoot, specPath, source, fetchNote } = params;
  const base = params.base ?? PROGRAM_MERGE_BASE;
  const checkedAtEpochMs = (params.now ?? Date.now)();
  const git = createGitRunner(source.kind === "worktree" ? source.worktreePath : projectRoot);
  const ref = source.kind === "worktree" ? "HEAD" : source.ref;
  const read = async (path: string): Promise<string | null> => {
    if (source.kind === "ref") return git(["show", `${source.ref}:${path}`]);
    try {
      return await readFile(join(source.worktreePath, path), "utf8");
    } catch {
      return null;
    }
  };

  try {
    const programText = await read(specPath);
    const checkpoints = new Map<string, string>();
    const merges = new Map<number, ChildMerge>();
    let birthErrors: string[] = [];
    if (programText !== null) {
      if (hasProgramSection(programText)) birthErrors = await programBirthErrors({ git, ref, specPath, programText });
      for (const row of programRows(programText)) {
        if (!row.checkpoint || checkpoints.has(row.checkpoint)) continue;
        const text = await read(row.checkpoint);
        if (text !== null) checkpoints.set(row.checkpoint, text);
      }
      for (const row of doneChildRows(programText, checkpoints)) {
        merges.set(row.index, await childMerge({ git, index: row.index, checkpointPath: row.checkpoint, ref, base, fetchNote }));
      }
    }
    return decideProgramVerdict({ specPath, programText, checkpoints, merges, birthErrors, base, fetchNote, checkedAtEpochMs });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return blockedProgramVerdict({ specPath, reason: `no se pudo leer el programa: ${detail}`, base, fetchNote, checkedAtEpochMs });
  }
}
