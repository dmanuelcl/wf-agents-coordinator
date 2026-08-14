import type { JSX } from "react";
import { describeAttention } from "../../shared/workflow/autopilot-attention";
import type { AutopilotAlert } from "./useAutopilotAlerts";

interface AutopilotAlertBarProps {
  alerts: AutopilotAlert[];
  enabled: boolean;
  sessionName(sessionId: string): string;
  onSelectSession(sessionId: string): void;
  onAcknowledge(sessionId: string): void;
  onAcknowledgeAll(): void;
  onToggleEnabled(enabled: boolean): void;
}

/**
 * The visible half of the alert: the sound repeats until acknowledged, so there
 * has to be somewhere to acknowledge it that is reachable no matter which
 * session is on screen.
 */
export function AutopilotAlertBar(props: AutopilotAlertBarProps): JSX.Element | null {
  const { alerts, enabled, sessionName, onSelectSession, onAcknowledge, onAcknowledgeAll, onToggleEnabled } = props;
  if (alerts.length === 0) return null;

  return (
    <div className="autopilot-alert-bar" role="alert">
      <div className="autopilot-alert-list">
        {alerts.map((alert) => (
          <div key={alert.sessionId} className={`autopilot-alert autopilot-alert-${alert.attention.kind}`}>
            <button
              type="button"
              className="autopilot-alert-open"
              onClick={() => {
                onSelectSession(alert.sessionId);
                onAcknowledge(alert.sessionId);
              }}
            >
              <span className="autopilot-alert-session">{sessionName(alert.sessionId)}</span>
              <span className="autopilot-alert-reason">{describeAttention(alert.attention)}</span>
            </button>
            <button
              type="button"
              className="autopilot-alert-ack"
              onClick={() => onAcknowledge(alert.sessionId)}
              title="Silenciar este aviso"
            >
              Silenciar
            </button>
          </div>
        ))}
      </div>
      <div className="autopilot-alert-actions">
        {alerts.length > 1 && (
          <button type="button" className="autopilot-alert-ack" onClick={onAcknowledgeAll}>
            Silenciar todo
          </button>
        )}
        <label className="autopilot-alert-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => onToggleEnabled(event.target.checked)} />
          Sonido
        </label>
      </div>
    </div>
  );
}
