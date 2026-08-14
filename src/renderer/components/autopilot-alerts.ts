import { attentionKey } from "../../shared/workflow/autopilot-attention";
import type { AutoPilotAttention } from "../../shared/workflow/autopilot-attention";

export interface AlertsState {
  /** Sessions calling for help that the viewer has not acknowledged yet. */
  pending: Record<string, AutoPilotAttention>;
  /** The acknowledged call per session, so republishing it stays quiet. */
  acknowledged: Record<string, string>;
}

export type AlertsEvent =
  | { type: "attention"; sessionId: string; attention: AutoPilotAttention | null }
  | { type: "ack"; sessionId: string };

export const EMPTY_ALERTS: AlertsState = { pending: {}, acknowledged: {} };

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Which sessions are still calling for the viewer's attention.
 *
 * The alert sound repeats until it is acknowledged, so what counts as "the same
 * call for help" has to be exact: the runner republishes a session's runtime on
 * every terminal and phase change, and none of that may restart the sound. A
 * session that goes quiet after being paused is a *different* call, though, and
 * has to be able to ring again.
 */
export function reduceAlerts(state: AlertsState, event: AlertsEvent): AlertsState {
  if (event.type === "ack") {
    const attention = state.pending[event.sessionId];
    if (!attention) return state;
    return {
      pending: without(state.pending, event.sessionId),
      acknowledged: { ...state.acknowledged, [event.sessionId]: attentionKey(event.sessionId, attention) },
    };
  }

  const { sessionId, attention } = event;
  if (!attention) {
    // Drop the acknowledgement too: keeping it would silence the next call.
    if (!(sessionId in state.pending) && !(sessionId in state.acknowledged)) return state;
    return { pending: without(state.pending, sessionId), acknowledged: without(state.acknowledged, sessionId) };
  }

  const key = attentionKey(sessionId, attention);
  if (state.acknowledged[sessionId] === key) return state;
  if (state.pending[sessionId] && attentionKey(sessionId, state.pending[sessionId]) === key) return state;
  return { pending: { ...state.pending, [sessionId]: attention }, acknowledged: state.acknowledged };
}
