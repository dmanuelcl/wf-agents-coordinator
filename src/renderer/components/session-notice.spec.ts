import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionNotice, toneForReviewMessage } from "./session-notice";

describe("toneForReviewMessage", () => {
  it("classifies progress, success and failure messages", () => {
    expect(toneForReviewMessage("Pushing to the PR branch…")).toBe("progress");
    expect(toneForReviewMessage("Pushed ✓ done")).toBe("success");
    expect(toneForReviewMessage("Push failed — denied")).toBe("danger");
  });
});

describe("SessionNotice", () => {
  it("renders a semantic, visible status banner", () => {
    const html = renderToStaticMarkup(createElement(SessionNotice, { tone: "success", children: "Pushed ✓" }));

    expect(html).toContain("session-notice session-notice-success");
    expect(html).toContain('role="status"');
    expect(html).toContain("Pushed ✓");
  });
});
