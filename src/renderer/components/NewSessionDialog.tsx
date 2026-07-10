import { useState } from "react";
import type { FormEvent } from "react";
import type { WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";

interface NewSessionDialogProps {
  projectId: string;
  onClose: () => void;
  onCreated: (session: WorkSession) => void;
}

const KIND_OPTIONS: { value: WorkSessionKind; label: string }[] = [
  { value: "feature", label: "New feature" },
  { value: "fix", label: "Bug fix" },
];

export function NewSessionDialog(props: NewSessionDialogProps): JSX.Element {
  const { projectId, onClose, onCreated } = props;

  const [kind, setKind] = useState<WorkSessionKind>("feature");
  const [name, setName] = useState("");
  const [copyEnv, setCopyEnv] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await window.agentCoordinator.sessions.create(projectId, {
        name: name.trim(),
        kind,
        copyEnv,
      });
      onCreated(session);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal new-session-modal">
        <h2>New session</h2>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="new-session-field">
            <span className="field-label">Kind</span>
            <div className="segmented" role="radiogroup" aria-label="Session kind">
              {KIND_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={kind === option.value}
                  className={`segmented-option${kind === option.value ? " selected" : ""}`}
                  onClick={() => setKind(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="new-session-field">
            <label htmlFor="session-name" className="field-label">
              Session name <span className="req">*</span>
            </label>
            <input
              id="session-name"
              type="text"
              placeholder="What are you working on?"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="new-session-field">
            <label className="new-session-check">
              <input type="checkbox" checked={copyEnv} onChange={(event) => setCopyEnv(event.target.checked)} />
              <span>
                Copy <code>.env</code> files into the worktree
              </span>
            </label>
            <p className="field-hint">
              So it can run tasks that need env vars. Your <code>.env</code> is gitignored, so it stays out of git.
            </p>
          </div>

          {error && <p className="error-banner">{error}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="modal-confirm" disabled={submitting || !canSubmit}>
              Create session
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
