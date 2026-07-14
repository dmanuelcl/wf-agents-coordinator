import { describe, expect, it } from "vitest";
import {
  buildSlackPostCommand,
  buildSlackSummaryCommand,
  createDefaultReviewConfig,
  DEFAULT_REVIEW_KICKOFF,
  substituteReviewKickoff,
} from "./review-config";

describe("createDefaultReviewConfig", () => {
  it("defaults to an empty channel and the default kickoff", () => {
    expect(createDefaultReviewConfig()).toEqual({ slackChannel: "", kickoff: DEFAULT_REVIEW_KICKOFF });
  });

  it("returns a fresh object each call", () => {
    const a = createDefaultReviewConfig();
    a.slackChannel = "#x";
    expect(createDefaultReviewConfig().slackChannel).toBe("");
  });
});

describe("substituteReviewKickoff", () => {
  it("replaces all {branch} and {base} occurrences", () => {
    const out = substituteReviewKickoff("rev {branch} vs {base}; again {branch}", {
      branch: "origin/x",
      base: "develop",
    });
    expect(out).toBe("rev origin/x vs develop; again origin/x");
  });

  it("falls back to the default kickoff when the template is blank", () => {
    const out = substituteReviewKickoff("   ", { branch: "x", base: "develop" });
    expect(out.startsWith("Revisa los cambios")).toBe(true);
    expect(out).toContain("develop");
  });
});

describe("buildSlackPostCommand", () => {
  it("names the channel in the instruction", () => {
    expect(buildSlackPostCommand("#pr-reviews")).toBe(
      "Publica el resumen completo del review en el canal de Slack #pr-reviews.",
    );
  });
});

describe("buildSlackSummaryCommand", () => {
  it("includes the channel and the comment url", () => {
    const out = buildSlackSummaryCommand("#pr-reviews", "https://bitbucket.org/a/b/pull-requests/1#comment-9");
    expect(out).toContain("#pr-reviews");
    expect(out).toContain("https://bitbucket.org/a/b/pull-requests/1#comment-9");
  });
});
