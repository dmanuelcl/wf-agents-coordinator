import { useState } from "react";
import type { ProgramVerdict } from "../../shared/workflow/program-verdict";
import {
  boundChild,
  checkedAgo,
  childStateClass,
  mergeLabel,
  panelActions,
  programBanner,
  verdictBadgeClass,
} from "./program-display";
import type { ProgramAction } from "./program-display";
import { SessionNotice } from "./session-notice";
import type { ProgramActionsState } from "./use-program-actions";

function actionLabel(action: ProgramAction): string {
  if (action.kind === "start") return `Iniciar hijo ${action.index} en esta sesión`;
  if (action.kind === "adopt") return `Seguir el hijo ${action.index} en esta sesión`;
  return "Re-comprobar";
}

/** Starting a child replaces the Architect's conversation, so it asks inline first (never a browser dialog). */
export function ProgramActionButtons(props: { actions: ProgramAction[]; state: ProgramActionsState }): JSX.Element | null {
  const { actions, state } = props;
  const [confirming, setConfirming] = useState<number | null>(null);
  if (actions.length === 0) return null;
  return (
    <span className="program-actions">
      {actions.map((action) => {
        const key = action.kind === "refresh" ? "refresh" : `${action.kind}-${action.index}`;
        if (action.kind === "start" && confirming === action.index) {
          return (
            <span key={key} className="program-confirm">
              Reemplaza la conversación actual del Architect. ¿Seguir?
              <button
                type="button"
                disabled={state.busy}
                onClick={() => {
                  setConfirming(null);
                  void state.run(action);
                }}
              >
                Sí, iniciar hijo {action.index}
              </button>
              <button type="button" disabled={state.busy} onClick={() => setConfirming(null)}>
                Cancelar
              </button>
            </span>
          );
        }
        return (
          <button
            key={key}
            type="button"
            disabled={state.busy}
            onClick={() => (action.kind === "start" ? setConfirming(action.index) : void state.run(action))}
          >
            {state.busy && action.kind === "refresh" ? "Comprobando…" : actionLabel(action)}
          </button>
        );
      })}
    </span>
  );
}

/** The banner at the top of the session, on every tab. */
export function ProgramNotice(props: { verdict: ProgramVerdict; sessionCheckpointPath: string | null; state: ProgramActionsState }): JSX.Element | null {
  const { verdict, sessionCheckpointPath, state } = props;
  const banner = programBanner(verdict, sessionCheckpointPath);
  if (!banner && !state.error) return null;
  return (
    <SessionNotice
      tone={banner?.tone ?? "danger"}
      actions={banner ? <ProgramActionButtons actions={banner.actions} state={state} /> : undefined}
    >
      {banner && <strong>{banner.title}</strong>}
      {banner && banner.lines.length > 0 && (
        <ul className="program-notice-lines">
          {banner.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {state.error && <p className="program-error">{state.error}</p>}
    </SessionNotice>
  );
}

/** The whole program, above the checkpoint in the Log tab. */
export function ProgramPanel(props: {
  verdict: ProgramVerdict;
  sessionCheckpointPath: string | null;
  state: ProgramActionsState;
  now: number;
}): JSX.Element {
  const { verdict, sessionCheckpointPath, state, now } = props;
  const bound = boundChild(verdict, sessionCheckpointPath);
  const doneCount = verdict.children.filter((child) => child.state === "DONE").length;
  return (
    <section className="program-panel" aria-label="Programa">
      <header className="program-panel-header">
        <span className="program-panel-title">{verdict.title}</span>
        <span className={verdictBadgeClass(verdict.verdict)}>{verdict.verdict}</span>
        <span className="session-view-muted">
          {doneCount}/{verdict.children.length} DONE · {verdict.base} comprobado {checkedAgo(verdict.checkedAtEpochMs, now)}
        </span>
      </header>
      {verdict.fetchNote && <p className="program-fetch-note">⚠ {verdict.fetchNote}</p>}
      {verdict.children.length > 0 && (
        <ol className="program-children">
          {verdict.children.map((child) => {
            const merge = mergeLabel(child.merge);
            const here = child === bound;
            return (
              <li key={child.index} className={`program-child${here ? " program-child-bound" : ""}`}>
                <span className="program-child-index">{child.index}</span>
                <span className="program-child-name">{child.name}</span>
                <span className={childStateClass(child.state)}>{child.state}</span>
                {merge && <span className={merge.className}>{merge.text}</span>}
                {child.dependsOn.length > 0 && <span className="session-view-muted">depende de {child.dependsOn.join(", ")}</span>}
                {here && <span className="program-child-here">← esta sesión</span>}
              </li>
            );
          })}
        </ol>
      )}
      {verdict.reasons.length > 0 && (
        <div className="program-reasons" role="alert">
          <strong>BLOCKED</strong>
          <ul>
            {verdict.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.hints.length > 0 && (
        <ul className="program-hints">
          {verdict.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
      <div className="program-panel-actions">
        <ProgramActionButtons actions={panelActions(programBanner(verdict, sessionCheckpointPath))} state={state} />
      </div>
      {state.error && <p className="program-error">{state.error}</p>}
    </section>
  );
}
