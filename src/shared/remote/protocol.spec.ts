import { describe, expect, it } from "vitest";
import { REMOTE_PROTOCOL_VERSION, parseRemoteFrameJson } from "./protocol";

describe("remote protocol", () => {
  it("accepts valid authenticated invoke frames", () => {
    expect(
      parseRemoteFrameJson(
        JSON.stringify({ type: "invoke", id: "42", channel: "projects:list", args: [] }),
      ),
    ).toEqual({ type: "invoke", id: "42", channel: "projects:list", args: [] });
  });

  it("rejects malformed frames and mismatched protocol versions", () => {
    expect(parseRemoteFrameJson("not-json")).toBeNull();
    expect(
      parseRemoteFrameJson(JSON.stringify({ type: "hello", protocol: REMOTE_PROTOCOL_VERSION + 1, token: "x" })),
    ).toBeNull();
    expect(parseRemoteFrameJson(JSON.stringify({ type: "emit", channel: "terminal:write" }))).toBeNull();
  });
});
