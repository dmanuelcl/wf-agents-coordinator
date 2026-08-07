import { describe, expect, it } from "vitest";
import { filterComboboxEntries } from "./use-combobox";
import type { ComboboxEntry } from "./use-combobox";

function entry(id: string, label: string, searchText: string): ComboboxEntry {
  return { id, label, searchText };
}

const CHECKPOINTS: ComboboxEntry[] = [
  entry(
    "docs/checkpoints/session-start-point.md",
    "Session start point",
    "session start point session-start-point docs/checkpoints/session-start-point.md planned",
  ),
  entry(
    "docs/checkpoints/session-log-tabs.md",
    "Session log tabs",
    "session log tabs session-log-tabs docs/checkpoints/session-log-tabs.md review",
  ),
  entry(
    "specs/pr-fix-push-gate.md",
    "PR fix push gate",
    "pr fix push gate pr-fix-push-gate specs/pr-fix-push-gate.md done",
  ),
];

describe("filterComboboxEntries", () => {
  it("returns every entry for an empty or whitespace-only query", () => {
    expect(filterComboboxEntries(CHECKPOINTS, "")).toEqual(CHECKPOINTS);
    expect(filterComboboxEntries(CHECKPOINTS, "   ")).toEqual(CHECKPOINTS);
  });

  it("matches a single term as a substring, ignoring case", () => {
    const found = filterComboboxEntries(CHECKPOINTS, "SESSION");

    expect(found.map((match) => match.label)).toEqual(["Session start point", "Session log tabs"]);
  });

  it("requires every whitespace-separated term to match", () => {
    const found = filterComboboxEntries(CHECKPOINTS, "session planned");

    expect(found.map((match) => match.label)).toEqual(["Session start point"]);
  });

  it("matches terms across different fields of the same entry", () => {
    const found = filterComboboxEntries(CHECKPOINTS, "specs/ gate");

    expect(found.map((match) => match.id)).toEqual(["specs/pr-fix-push-gate.md"]);
  });

  it("returns nothing when one term of several fails to match", () => {
    expect(filterComboboxEntries(CHECKPOINTS, "session nonexistent")).toEqual([]);
  });

  it("keeps a pinned entry regardless of the query, so 'None' never filters itself away", () => {
    const none: ComboboxEntry = { id: "", label: "None", searchText: "none", pinned: true };
    const found = filterComboboxEntries([none, ...CHECKPOINTS], "session nonexistent");

    expect(found).toEqual([none]);
  });
});
