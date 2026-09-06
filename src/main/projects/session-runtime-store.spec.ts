import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIAL_CONDUCTOR_STATE } from "../../shared/workflow/conductor";
import { createSessionRuntimeStore } from "./session-runtime-store";
import type { RunnerSessionRuntimeRecord } from "./session-runtime-store";

let dir: string;
let storeFilePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-coordinator-runtime-"));
  storeFilePath = join(dir, "session-runtime.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(sessionId: string, terminalCount: number): RunnerSessionRuntimeRecord {
  return {
    sessionId,
    phase: "ready",
    terminals: Array.from({ length: terminalCount }, (_, index) => ({
      key: `${sessionId}::terminal-${index}`,
      kind: "agent" as const,
      title: `Terminal ${index}`,
    })),
    error: null,
    autoPilot: { enabled: false, state: INITIAL_CONDUCTOR_STATE, message: null, attention: null },
  };
}

describe("session runtime store", () => {
  it("round-trips a record", async () => {
    const store = createSessionRuntimeStore({ storeFilePath });
    await store.put(record("s1", 2));
    expect((await store.get("s1"))?.terminals).toHaveLength(2);
  });

  // The desktop app and the remote runner share one state dir, so two processes
  // write this file. A plain writeFile truncates and then streams: a short
  // document landing mid-way through a long one leaves the long one's tail
  // behind, and every session then fails to load with "Unexpected non-whitespace
  // character after JSON".
  it("stays parseable when a short write races a long one", async () => {
    const long = createSessionRuntimeStore({ storeFilePath });
    const short = createSessionRuntimeStore({ storeFilePath });
    await long.put(record("big", 20_000));

    await Promise.all([long.put(record("big", 20_000)), short.put(record("small", 1))]);

    expect(() => JSON.parse(readFileSync(storeFilePath, "utf8"))).not.toThrow();
  });

  it("recovers a file that already carries a torn tail", async () => {
    const store = createSessionRuntimeStore({ storeFilePath });
    await store.put(record("s1", 1));
    const torn = `${readFileSync(storeFilePath, "utf8")}  "leftover": null\n  }\n}`;
    await writeFile(storeFilePath, torn, "utf8");

    expect((await store.list()).map((entry) => entry.sessionId)).toEqual(["s1"]);
  });
});
