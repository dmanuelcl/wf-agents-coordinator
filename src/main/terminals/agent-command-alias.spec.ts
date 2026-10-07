import { describe, expect, it } from "vitest";
import {
  listClaudeCommands,
  parseAliasBody,
  parseAliasListing,
  resolveCustomCommand,
  splitShellWords,
} from "./agent-command-alias";

describe("splitShellWords", () => {
  it("splits on whitespace and honours quotes and escapes", () => {
    expect(splitShellWords(`a 'b c' "d e" f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(splitShellWords(`X='it'\\''s' claude`)).toEqual(["X=it's", "claude"]);
  });

  it("rejects anything that is not one simple command", () => {
    for (const body of ["a | b", "a; b", "a && b", "echo $(id)", "echo `id`", `echo "$(id)"`, "a 'open"]) {
      expect(splitShellWords(body)).toBeNull();
    }
  });
});

describe("parseAliasBody", () => {
  it("reads the env assignments and the program of a config-dir alias", () => {
    expect(parseAliasBody("CLAUDE_CONFIG_DIR=~/.claude-biz command claude", "/Users/ada")).toEqual({
      executable: "claude",
      args: [],
      environment: { CLAUDE_CONFIG_DIR: "/Users/ada/.claude-biz" },
    });
  });

  it("accepts env/exec prefixes, $HOME and leading arguments", () => {
    expect(parseAliasBody("env A=1 exec B=$HOME/x /opt/bin/claude --verbose", "/Users/ada")).toEqual({
      executable: "/opt/bin/claude",
      args: ["--verbose"],
      environment: { A: "1", B: "/Users/ada/x" },
    });
  });

  it("is null without a program or for compound bodies", () => {
    expect(parseAliasBody("A=1", "/h")).toBeNull();
    expect(parseAliasBody("cd x && claude", "/h")).toBeNull();
  });
});

describe("parseAliasListing", () => {
  it("parses zsh and bash listings and skips start-up noise", () => {
    const aliases = parseAliasListing(
      [
        "load-nvmrc:7: command not found: nvm",
        "claude-biz='CLAUDE_CONFIG_DIR=~/.claude-biz command claude'",
        "ll='ls -la'",
        "g=git",
        "alias cdm='CLAUDE_CONFIG_DIR=~/.claude-dm claude'",
      ].join("\n"),
    );
    expect(Object.fromEntries(aliases)).toEqual({
      "claude-biz": "CLAUDE_CONFIG_DIR=~/.claude-biz command claude",
      ll: "ls -la",
      g: "git",
      cdm: "CLAUDE_CONFIG_DIR=~/.claude-dm claude",
    });
  });
});

describe("listClaudeCommands", () => {
  it("offers only the aliases that run claude under another name", async () => {
    const aliases = new Map([
      ["claude-dm", "CLAUDE_CONFIG_DIR=~/.claude-dm command claude"],
      ["claude", "claude --verbose"],
      ["claude-biz", "CLAUDE_CONFIG_DIR=~/.claude-biz command claude"],
      ["ll", "ls -la"],
      ["broken", "claude | tee log"],
    ]);
    expect(await listClaudeCommands(async () => aliases)).toEqual(["claude-biz", "claude-dm"]);
  });

  it("offers nothing when the shell could not be read", async () => {
    expect(await listClaudeCommands(async () => null)).toEqual([]);
  });
});

describe("resolveCustomCommand", () => {
  it("expands an alias; an unknown name or an unreadable shell resolves to nothing", async () => {
    const aliases = new Map([["claude-biz", "CLAUDE_CONFIG_DIR=/cfg command claude"]]);
    expect(await resolveCustomCommand("claude-biz", async () => aliases)).toEqual({
      executable: "claude",
      args: [],
      environment: { CLAUDE_CONFIG_DIR: "/cfg" },
    });
    expect(await resolveCustomCommand("claude-dm", async () => aliases)).toBeNull();
    expect(await resolveCustomCommand("claude-biz", async () => null)).toBeNull();
  });
});
