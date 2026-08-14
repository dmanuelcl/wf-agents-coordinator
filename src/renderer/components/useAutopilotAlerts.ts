import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeAttention } from "../../shared/workflow/autopilot-attention";
import type { AutoPilotAttention } from "../../shared/workflow/autopilot-attention";
import { createAlertChime } from "./alert-chime";
import type { AlertChime } from "./alert-chime";
import { EMPTY_ALERTS, reduceAlerts } from "./autopilot-alerts";
import type { AlertsState } from "./autopilot-alerts";

/** How often the alert repeats while a session is still waiting on the user. */
const REPEAT_MS = 10_000;
const ENABLED_STORAGE_KEY = "coordinator.autopilotAlerts";

export interface AutopilotAlert {
  sessionId: string;
  attention: AutoPilotAttention;
}

export interface AutopilotAlerts {
  /** Unacknowledged calls for help, oldest first. */
  alerts: AutopilotAlert[];
  enabled: boolean;
  setEnabled(enabled: boolean): void;
  acknowledge(sessionId: string): void;
  acknowledgeAll(): void;
}

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(ENABLED_STORAGE_KEY) !== "off";
  } catch {
    // Private-mode storage can throw on read. Alerting is the better default.
    return true;
  }
}

/**
 * Turns the runner's per-session `attention` into an alert the person at the
 * screen actually notices: a chime that repeats until acknowledged, plus a
 * system notification.
 *
 * Whether to make noise is a property of the viewer, not of the project — the
 * same session watched from two machines should not have one preference — so
 * the switch lives in this browser's storage.
 */
export function useAutopilotAlerts(params: {
  sessionName(sessionId: string): string;
  onSelectSession(sessionId: string): void;
}): AutopilotAlerts {
  const { sessionName, onSelectSession } = params;
  const [state, setState] = useState<AlertsState>(EMPTY_ALERTS);
  const [enabled, setEnabledState] = useState(readEnabled);
  const chimeRef = useRef<AlertChime | null>(null);
  const notifiedRef = useRef(new Set<string>());
  const onSelectRef = useRef(onSelectSession);
  const sessionNameRef = useRef(sessionName);
  useEffect(() => {
    onSelectRef.current = onSelectSession;
    sessionNameRef.current = sessionName;
  });

  useEffect(() => {
    return window.agentCoordinator.sessions.onRuntimeChanged((event) => {
      setState((current) => reduceAlerts(current, {
        type: "attention",
        sessionId: event.sessionId,
        attention: event.runtime.autoPilot.attention ?? null,
      }));
    });
  }, []);

  const alerts = useMemo<AutopilotAlert[]>(
    () => Object.entries(state.pending)
      .map(([sessionId, attention]) => ({ sessionId, attention }))
      .sort((a, b) => a.attention.sinceEpochMs - b.attention.sinceEpochMs),
    [state.pending],
  );

  // One system notification per call for help. Unlike the chime this does not
  // repeat: the OS already keeps it in its own centre until dismissed.
  useEffect(() => {
    if (!enabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const live = new Set(alerts.map((alert) => alert.sessionId));
    for (const sessionId of notifiedRef.current) {
      if (!live.has(sessionId)) notifiedRef.current.delete(sessionId);
    }
    for (const alert of alerts) {
      if (notifiedRef.current.has(alert.sessionId)) continue;
      notifiedRef.current.add(alert.sessionId);
      const notification = new Notification(sessionNameRef.current(alert.sessionId), {
        body: describeAttention(alert.attention),
        tag: alert.sessionId,
      });
      notification.onclick = () => {
        window.focus();
        onSelectRef.current(alert.sessionId);
        notification.close();
      };
    }
  }, [alerts, enabled]);

  // The chime repeats for as long as anything is unacknowledged. `done` only
  // wins the tone when it is the only thing waiting: a real blockage elsewhere
  // should not sound like a celebration.
  useEffect(() => {
    if (!enabled || alerts.length === 0) return;
    if (!chimeRef.current) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      chimeRef.current = createAlertChime(new Ctor());
    }
    const chime = chimeRef.current;
    const tone = alerts.every((alert) => alert.attention.kind === "done") ? "done" : "attention";
    chime.play(tone);
    const timer = setInterval(() => chime.play(tone), REPEAT_MS);
    return () => clearInterval(timer);
  }, [alerts, enabled]);

  useEffect(() => {
    return () => {
      chimeRef.current?.close();
      chimeRef.current = null;
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, next ? "on" : "off");
    } catch {
      // A viewer that cannot persist the choice still honors it this session.
    }
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }, []);

  const acknowledge = useCallback((sessionId: string) => {
    setState((current) => reduceAlerts(current, { type: "ack", sessionId }));
  }, []);

  const acknowledgeAll = useCallback(() => {
    setState((current) => Object.keys(current.pending)
      .reduce((next, sessionId) => reduceAlerts(next, { type: "ack", sessionId }), current));
  }, []);

  return { alerts, enabled, setEnabled, acknowledge, acknowledgeAll };
}
