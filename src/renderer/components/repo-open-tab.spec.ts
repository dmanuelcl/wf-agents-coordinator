import { describe, expect, it } from "vitest";
import { repoTabIsOpen } from "./repo-open-tab";

function open(overrides: Partial<Parameters<typeof repoTabIsOpen>[0]> = {}): boolean {
  return repoTabIsOpen({
    activeTab: "shell-1",
    diffOpen: false,
    shellTabIds: ["shell-1"],
    agentTabKeys: ["repo::p::agent::a"],
    fileTabIds: ["file-1"],
    ...overrides,
  });
}

describe("repoTabIsOpen", () => {
  it("counts a shell", () => {
    expect(open()).toBe(true);
  });

  // The one that bit: an agent tab is live and selected, but the workspace still
  // reported nothing open, so the empty state rendered alongside the pane.
  it("counts a repo workspace's agent", () => {
    expect(open({ activeTab: "repo::p::agent::a" })).toBe(true);
  });

  it("counts an open file", () => {
    expect(open({ activeTab: "file-1" })).toBe(true);
  });

  it("counts the diff only while it is open", () => {
    expect(open({ activeTab: "diff", diffOpen: true })).toBe(true);
    expect(open({ activeTab: "diff", diffOpen: false })).toBe(false);
  });

  it("reports nothing open for an unknown or empty active tab", () => {
    expect(open({ activeTab: "" })).toBe(false);
    expect(open({ activeTab: "log" })).toBe(false);
  });

  it("reports nothing open for a tab that was just closed", () => {
    expect(open({ activeTab: "shell-1", shellTabIds: [] })).toBe(false);
  });
});
