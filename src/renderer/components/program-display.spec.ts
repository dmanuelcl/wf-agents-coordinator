import { describe, expect, it } from "vitest";
import type { ChildMerge, ProgramChildView, ProgramVerdict } from "../../shared/workflow/program-verdict";
import {
  checkedAgo,
  ipcErrorMessage,
  mergeLabel,
  panelActions,
  programBanner,
  programRailBadge,
  sessionHoldingBranch,
} from "./program-display";

const CP1 = "docs/workflow/checkpoints/x-1-checkpoint.md";
const PARENT = "docs/workflow/checkpoints/padre-checkpoint.md";
const UNMERGED: ChildMerge = { state: "unmerged", closeSha: "abc", reason: "hijo 1: su commit de cierre abc no está en origin/develop" };
const MERGED: ChildMerge = { state: "merged", closeSha: "abc", reason: null };

function child(overrides: Partial<ProgramChildView>): ProgramChildView {
  return { index: 1, name: "Uno", spec: null, checkpoint: null, dependsOn: [], state: "PENDING", linked: null, merge: null, ...overrides };
}
function verdict(overrides: Partial<ProgramVerdict>): ProgramVerdict {
  return {
    specPath: "docs/workflow/specs/x-programa.md",
    title: "Programa X",
    verdict: "READY",
    next: null,
    children: [],
    reasons: [],
    hints: [],
    base: "origin/develop",
    fetchNote: null,
    checkedAtEpochMs: 0,
    ...overrides,
  };
}
const done1 = (merge: ChildMerge): ProgramChildView => child({ checkpoint: CP1, state: "DONE", linked: true, merge });
const two = child({ index: 2, name: "Dos" });

describe("programBanner", () => {
  it("no banner for the session that IS the child in progress", () => {
    const open = child({ checkpoint: CP1, state: "IN_PROGRESS", linked: true });
    expect(programBanner(verdict({ verdict: "BLOCKED", children: [open] }), CP1)).toBeNull();
  });

  it("offers to adopt a child in progress when the session looks at another checkpoint", () => {
    const open = child({ checkpoint: CP1, state: "IN_PROGRESS", linked: true });
    expect(programBanner(verdict({ verdict: "BLOCKED", children: [open] }), PARENT)).toMatchObject({
      tone: "warning",
      actions: [{ kind: "adopt", index: 1 }],
    });
  });

  it("danger when a DONE child is not merged, with the git reason and the fetch note", () => {
    const banner = programBanner(
      verdict({ verdict: "BLOCKED", children: [done1(UNMERGED), two], reasons: [UNMERGED.reason ?? ""], fetchNote: "sin red" }),
      CP1,
    );
    expect(banner).toMatchObject({ tone: "danger", actions: [{ kind: "refresh" }] });
    expect(banner?.lines).toEqual([UNMERGED.reason, "sin red"]);
  });

  it("warning with every reason for any other block", () => {
    expect(programBanner(verdict({ verdict: "BLOCKED", reasons: ["tabla rota"] }), PARENT)).toMatchObject({
      tone: "warning",
      lines: ["tabla rota"],
    });
  });

  it("while the child's INIT runs (no checkpoint yet) it says it is waiting — no second start", () => {
    const banner = programBanner(verdict({ next: two, children: [done1(MERGED), two] }), null);
    expect(banner).toMatchObject({ tone: "info", actions: [] });
    expect(banner?.title).toMatch(/Esperando el checkpoint del hijo 2/);
  });

  it("READY offers to start the next child in this session; COMPLETE says so", () => {
    expect(programBanner(verdict({ next: two, children: [done1(MERGED), two] }), CP1)).toMatchObject({
      tone: "success",
      actions: [{ kind: "start", index: 2 }],
    });
    expect(programBanner(verdict({ verdict: "COMPLETE", children: [done1(MERGED)] }), CP1)?.title).toMatch(/Programa completo/);
  });
});

describe("programRailBadge / panelActions", () => {
  it("⛔ for a merge block, ⚠ for other trouble, ▶ when a child can start, nothing otherwise", () => {
    expect(programRailBadge(verdict({ verdict: "BLOCKED", children: [done1(UNMERGED)] }), CP1)?.symbol).toBe("⛔");
    expect(programRailBadge(verdict({ verdict: "BLOCKED", reasons: ["x"] }), PARENT)?.symbol).toBe("⚠");
    expect(programRailBadge(verdict({ next: two, children: [done1(MERGED), two] }), CP1)?.symbol).toBe("▶");
    expect(programRailBadge(verdict({ verdict: "COMPLETE", children: [done1(MERGED)] }), CP1)).toBeNull();
    expect(programRailBadge(null, CP1)).toBeNull();
  });

  it("the panel always offers Re-comprobar", () => {
    expect(panelActions(null)).toEqual([{ kind: "refresh" }]);
    expect(panelActions({ tone: "success", title: "", lines: [], actions: [{ kind: "start", index: 2 }] })).toEqual([
      { kind: "start", index: 2 },
      { kind: "refresh" },
    ]);
  });
});

describe("small helpers", () => {
  it("labels merges, ages and IPC errors in Spanish", () => {
    expect(mergeLabel(MERGED)?.text).toBe("✓ merjeado");
    expect(mergeLabel(UNMERGED)?.text).toBe("✗ sin merge");
    expect(mergeLabel(null)).toBeNull();
    expect(checkedAgo(0, 30_000)).toBe("hace menos de 1 min");
    expect(checkedAgo(0, 5 * 60_000)).toBe("hace 5 min");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'sessions:start-program-child': Error: No se puede iniciar"))).toBe(
      "No se puede iniciar",
    );
  });

  it("finds the session that holds a branch, local or origin-qualified", () => {
    const sessions = [{ name: "A", branch: "feature/a" }];
    expect(sessionHoldingBranch(sessions, "origin/feature/a")?.name).toBe("A");
    expect(sessionHoldingBranch(sessions, "feature/a")?.name).toBe("A");
    expect(sessionHoldingBranch(sessions, "feature/b")).toBeNull();
  });
});
