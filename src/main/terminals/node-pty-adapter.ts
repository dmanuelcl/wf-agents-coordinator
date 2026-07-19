import * as pty from "node-pty";
import type { PtySpawn, SpawnPty } from "./pty-session-manager";

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export const spawnRealPty: SpawnPty = ({ cwd, shell, cols, rows, environment }) => {
  const proc = pty.spawn(shell.file, shell.args, {
    name: "xterm-color",
    cwd,
    cols,
    rows,
    env: sanitizeEnv({ ...process.env, ...environment }),
  });

  const spawned: PtySpawn = {
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit((e) => cb({ exitCode: e.exitCode })),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
  };

  return spawned;
};
