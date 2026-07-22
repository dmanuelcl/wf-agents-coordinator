import { describe, expect, it } from "vitest";
import { sanitizeCommentBody } from "./sanitize-comment";

describe("sanitizeCommentBody", () => {
  it("removes NUL (the byte Bitbucket rejects) and other C0 control chars", () => {
    expect(sanitizeCommentBody("a\x00b\x01c\x1fd")).toBe("abcd");
  });

  it("keeps tab, newline, and carriage return", () => {
    expect(sanitizeCommentBody("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
  });

  it("strips ANSI color/cursor escape sequences", () => {
    expect(sanitizeCommentBody("\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[22m")).toBe("red and bold");
  });

  it("leaves normal markdown untouched", () => {
    const md = "# Findings\n\n- `foo.ts:10` — bug\n\n```ts\nconst x = 1;\n```\n";
    expect(sanitizeCommentBody(md)).toBe(md);
  });
});
