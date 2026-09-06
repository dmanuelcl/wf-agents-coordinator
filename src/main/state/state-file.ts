import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// The desktop app and the remote runner share one state dir, so every file in
// it has two writers. A plain write truncates and then streams, so a short
// document landing part-way through a long one leaves the long one's tail
// behind — the file then reads as a complete JSON document followed by garbage,
// and every session disappears behind "Unexpected non-whitespace character
// after JSON". Renaming a complete sibling into place is atomic, so a reader
// only ever sees one whole document or the other.

function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export async function writeStateFile(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFilePath = tempPathFor(filePath);
  try {
    await writeFile(tempFilePath, contents, "utf8");
    await rename(tempFilePath, filePath);
  } catch (error) {
    await rm(tempFilePath, { force: true }).catch(() => {});
    throw error;
  }
}

export function writeStateFileSync(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempFilePath = tempPathFor(filePath);
  try {
    writeFileSync(tempFilePath, contents, "utf8");
    renameSync(tempFilePath, filePath);
  } catch (error) {
    try {
      rmSync(tempFilePath, { force: true });
    } catch {
      // The temp file is already gone, or the directory is unwritable; either
      // way the caller only cares about the original failure.
    }
    throw error;
  }
}

/**
 * Parses a state file, recovering the leading document of one torn by a writer
 * that predates {@link writeStateFile}. V8 reports the exact offset where the
 * valid document ended, so this drops the stray tail and nothing else — any
 * other damage still throws.
 */
export function parseStateFile<T>(raw: string, filePath: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const position = /Unexpected non-whitespace character after JSON at position (\d+)/.exec(
      (error as Error).message,
    )?.[1];
    if (position === undefined) throw error;
    const recovered = JSON.parse(raw.slice(0, Number(position))) as T;
    console.warn(`Dropped ${raw.length - Number(position)} trailing byte(s) left by a torn write in ${filePath}.`);
    return recovered;
  }
}
