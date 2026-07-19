interface ContinueAfterSetupRepairParams {
  sessionId: string;
  markSetupDone: (sessionId: string) => Promise<void>;
  onReady: () => void;
}

export async function continueAfterSetupRepair(params: ContinueAfterSetupRepairParams): Promise<void> {
  const { sessionId, markSetupDone, onReady } = params;
  await markSetupDone(sessionId);
  onReady();
}

interface SetupRecoveryBannerProps {
  reason: string;
  completing: boolean;
  error: string | null;
  onContinue: () => void;
}

export function SetupRecoveryBanner(props: SetupRecoveryBannerProps): JSX.Element {
  const { reason, completing, error, onContinue } = props;

  return (
    <div className="setup-recovery" role="alert">
      <span className="setup-recovery-icon" aria-hidden="true">!</span>
      <div className="setup-recovery-copy">
        <p className="setup-recovery-title">Setup requiere intervención</p>
        <p className="setup-recovery-message">
          {reason}. Corrígelo en esta terminal y, cuando el worktree esté listo, continúa para desbloquear los agentes.
        </p>
        {error && <p className="setup-recovery-error">No se pudo continuar: {error}</p>}
      </div>
      <button type="button" className="setup-recovery-button" disabled={completing} onClick={onContinue}>
        {completing ? "Desbloqueando…" : "Continuar con los agentes"}
      </button>
    </div>
  );
}
