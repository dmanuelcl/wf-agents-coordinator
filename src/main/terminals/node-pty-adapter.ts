import * as pty from "node-pty";
import type { PtySpawn, SpawnPty } from "./pty-session-manager";

// How long a terminal's process group has to wind down before it is killed.
const KILL_GRACE_MS = 3_000;

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

  let exited = false;
  proc.onExit(() => { exited = true; });

  /**
   * node-pty puts the shell in a session of its own, so the shell's pid is the
   * process-group id every descendant inherits. Signalling the group is what
   * reaches the build workers and dev servers a shell started; signalling only
   * the leader leaves them running, reparented to init, with nothing left that
   * knows they exist.
   *
   * The kernel will not recycle a pid while it is still a live group's id, so
   * the delayed SIGKILL cannot land on an unrelated process.
   */
  function killGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Already gone, or a platform without process groups.
    }
  }

  function reapGroup(): void {
    killGroup("SIGTERM");
    // Whatever ignored SIGTERM — a build orchestrator mid-task, a dev server
    // draining — gets no say a few seconds later.
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
  }

  const spawned: PtySpawn = {
    pid: proc.pid,
    killGroup: reapGroup,
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit((e) => cb({ exitCode: e.exitCode })),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => {
      reapGroup();
      if (!exited) proc.kill();
    },
  };

  return spawned;
};
