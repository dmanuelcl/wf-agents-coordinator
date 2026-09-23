import { describe, expect, it } from "vitest";
import { sessionProgramSpec, watchProgramSpec } from "./session-program";
import type { WorkflowNext } from "./workflow-types";

const next = (command: string): WorkflowNext => ({
  role: "architect",
  command,
  cwd: null,
  tier: null,
  task: null,
  sessionLane: "architect",
  rawMarkdown: "",
});
const feature = { kind: "feature" as const, program: undefined, initialPrompt: undefined };

describe("sessionProgramSpec", () => {
  it("prefers the persisted program, then the checkpoint's Programa pointer, then its NEXT, then the initial prompt", () => {
    expect(sessionProgramSpec({ ...feature, program: "a.md" }, { program: "b.md", next: null })).toBe("a.md");
    expect(sessionProgramSpec(feature, { program: "`b.md`", next: null })).toBe("b.md");
    expect(sessionProgramSpec(feature, { program: null, next: next("wf next c.md") })).toBe("c.md");
    expect(sessionProgramSpec({ ...feature, initialPrompt: "wf next d.md" }, null)).toBe("d.md");
    expect(sessionProgramSpec(feature, { program: null, next: next("wf verify x-checkpoint.md") })).toBeNull();
  });

  it("PR sessions never belong to a program", () => {
    expect(sessionProgramSpec({ kind: "pr-fix", program: "a.md", initialPrompt: undefined }, null)).toBeNull();
  });
});

describe("watchProgramSpec", () => {
  it("filters the binding only for a session waiting on a program child", () => {
    expect(watchProgramSpec({ ...feature, program: "a.md" })).toBe("a.md");
    expect(watchProgramSpec({ ...feature, initialPrompt: "wf next d.md" })).toBe("d.md");
    expect(watchProgramSpec(feature)).toBeNull();
  });
});
