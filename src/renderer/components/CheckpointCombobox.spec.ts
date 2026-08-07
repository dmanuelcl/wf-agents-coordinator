import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckpointOptionRow } from "./CheckpointCombobox";
import type { RefCheckpointSummary } from "../../shared/ipc/contract";

const CHECKPOINT: RefCheckpointSummary = {
  path: "docs/checkpoints/session-start-point.md",
  feature: "Session start point",
  slug: "session-start-point",
  status: "PLANNED",
};

function render(checkpoint: RefCheckpointSummary, highlighted = false): string {
  return renderToStaticMarkup(
    createElement(CheckpointOptionRow, {
      checkpoint,
      highlighted,
      onSelect: () => {},
      onHover: () => {},
    }),
  );
}

describe("CheckpointOptionRow", () => {
  it("shows the title and the full path, so same-titled checkpoints stay distinguishable", () => {
    const html = render(CHECKPOINT);

    expect(html).toContain("Session start point");
    expect(html).toContain("docs/checkpoints/session-start-point.md");
  });

  it("renders the status as a badge, urgent when the checkpoint is BLOCKED", () => {
    expect(render(CHECKPOINT)).toContain('class="badge"');
    expect(render({ ...CHECKPOINT, status: "BLOCKED" })).toContain('class="badge badge-attention"');
  });

  it("marks the highlighted row for assistive tech and for the eye", () => {
    const html = render(CHECKPOINT, true);

    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("highlight");
  });

  it("leaves an unhighlighted row unselected", () => {
    const html = render(CHECKPOINT);

    expect(html).toContain('aria-selected="false"');
    expect(html).not.toContain("highlight");
  });

  it("names a checkpoint with no title by its path rather than rendering an empty row", () => {
    const html = render({ ...CHECKPOINT, feature: null, slug: null });

    expect(html).toContain("docs/checkpoints/session-start-point.md");
  });
});
