import { describe, expect, it } from "vitest";
import { terminalFitMode } from "./terminal-fit-mode";

const ATTACHED_LIVE = { attached: true, runnerScreenAdopted: true, ptyExited: false };

describe("terminalFitMode", () => {
  it("lets the runner size a live PTY whose screen model the view adopted", () => {
    expect(terminalFitMode(ATTACHED_LIVE)).toBe("runner");
  });

  // The runner drops a PTY's screen model when the process exits, so it answers
  // every later resize with null. Left in runner mode the grid would stay frozen
  // at the runner's, and the pane would clip its own last lines.
  it("returns fitting to the view once the PTY has exited", () => {
    expect(terminalFitMode({ ...ATTACHED_LIVE, ptyExited: true })).toBe("local");
  });

  it("fits locally when nothing is attached yet", () => {
    expect(terminalFitMode({ ...ATTACHED_LIVE, attached: false })).toBe("local");
  });

  it("fits locally when the attach carried no runner screen", () => {
    expect(terminalFitMode({ ...ATTACHED_LIVE, runnerScreenAdopted: false })).toBe("local");
  });

  it("fits locally for a terminal that exited before anything attached", () => {
    expect(terminalFitMode({ attached: false, runnerScreenAdopted: false, ptyExited: true })).toBe("local");
  });
});
