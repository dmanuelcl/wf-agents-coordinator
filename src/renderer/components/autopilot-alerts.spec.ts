import { describe, expect, it } from "vitest";
import type { AutoPilotAttention } from "../../shared/workflow/autopilot-attention";
import { EMPTY_ALERTS, reduceAlerts } from "./autopilot-alerts";

const PAUSED: AutoPilotAttention = { kind: "paused", reason: "BLOCKED", sinceEpochMs: 1_000 };
const STALLED: AutoPilotAttention = { kind: "stalled", reason: "no output for 2m", sinceEpochMs: 2_000 };

function withAttention(sessionId: string, attention: AutoPilotAttention | null, state = EMPTY_ALERTS) {
  return reduceAlerts(state, { type: "attention", sessionId, attention });
}

describe("reduceAlerts", () => {
  it("raises an alert for a session that starts calling for help", () => {
    expect(withAttention("s1", PAUSED).pending).toEqual({ s1: PAUSED });
  });

  // The runner republishes a session's runtime for many unrelated reasons; only
  // a genuinely new call for help may restart the sound.
  it("keeps the same alert when the identical attention is republished", () => {
    const first = withAttention("s1", PAUSED);
    const again = withAttention("s1", { ...PAUSED }, first);

    expect(again.pending).toEqual({ s1: PAUSED });
  });

  it("stops alerting once acknowledged", () => {
    const raised = withAttention("s1", PAUSED);
    const acked = reduceAlerts(raised, { type: "ack", sessionId: "s1" });

    expect(acked.pending).toEqual({});
  });

  it("stays quiet when the acknowledged attention is republished", () => {
    const acked = reduceAlerts(withAttention("s1", PAUSED), { type: "ack", sessionId: "s1" });

    expect(withAttention("s1", { ...PAUSED }, acked).pending).toEqual({});
  });

  // Acknowledging "it is paused" is not acknowledging "it then went quiet".
  it("alerts again when the same session calls for help for a different reason", () => {
    const acked = reduceAlerts(withAttention("s1", PAUSED), { type: "ack", sessionId: "s1" });

    expect(withAttention("s1", STALLED, acked).pending).toEqual({ s1: STALLED });
  });

  it("clears an alert the session resolved on its own", () => {
    const raised = withAttention("s1", PAUSED);

    expect(withAttention("s1", null, raised).pending).toEqual({});
  });

  // Otherwise an acknowledgement would suppress the next, unrelated alert.
  it("forgets the acknowledgement once the session stops calling for help", () => {
    const acked = reduceAlerts(withAttention("s1", PAUSED), { type: "ack", sessionId: "s1" });
    const resolved = withAttention("s1", null, acked);

    expect(withAttention("s1", PAUSED, resolved).pending).toEqual({ s1: PAUSED });
  });

  it("tracks sessions independently", () => {
    const both = withAttention("s2", STALLED, withAttention("s1", PAUSED));
    const acked = reduceAlerts(both, { type: "ack", sessionId: "s1" });

    expect(acked.pending).toEqual({ s2: STALLED });
  });

  it("ignores an acknowledgement for a session that is not alerting", () => {
    expect(reduceAlerts(EMPTY_ALERTS, { type: "ack", sessionId: "s1" })).toEqual(EMPTY_ALERTS);
  });
});
