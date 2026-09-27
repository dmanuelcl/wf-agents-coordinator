import { useState } from "react";
import type { FormEvent } from "react";
import type { ResolvedPr } from "../../shared/ipc/contract";
import type { WorkSession } from "../../shared/workflow/work-session";

interface SessionPrFixDialogProps {
  session: WorkSession;
  onClose: () => void;
  onStarted: (session: WorkSession) => void;
}

/**
 * «PR fix» inside a feature/fix session: the PR comes from this session's own
 * branch, so the fix runs here instead of in a second worktree. The link is
 * remembered on the session, so later rounds are one click.
 */
export function SessionPrFixDialog(props: SessionPrFixDialogProps): JSX.Element {
  const { session, onClose, onStarted } = props;
  const [prUrl, setPrUrl] = useState(session.pr?.url ?? "");
  const [preview, setPreview] = useState<ResolvedPr | null>(null);
  const [resolving, setResolving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const otherBranch = preview !== null && preview.source !== session.branch;

  async function resolvePreview(): Promise<void> {
    if (!prUrl.trim()) return;
    setResolving(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await window.agentCoordinator.git.resolvePrUrl(session.projectId, prUrl.trim()));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setResolving(false);
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!prUrl.trim() || starting || otherBranch) return;
    setStarting(true);
    setError(null);
    try {
      onStarted(await window.agentCoordinator.sessions.startPrFix(session.id, prUrl.trim()));
    } catch (caught) {
      setError(String(caught));
      setStarting(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal new-session-modal">
        <h2>PR fix</h2>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="new-session-body">
            <p className="field-hint">
              Downloads the PR comments and hands them to this session&apos;s Reviewer, which reopens the checkpoint with a
              correction plan. The Implementer fixes it here, on <code>{session.branch}</code>, and you push with{" "}
              <em>Push to PR</em> once the loop closes in DONE.
            </p>
            <div className="new-session-field">
              <label htmlFor="session-pr-url" className="field-label">
                PR link <span className="req">*</span>
              </label>
              <div className="pr-url-row">
                <input
                  id="session-pr-url"
                  type="text"
                  placeholder="https://bitbucket.org/workspace/repo/pull-requests/482"
                  value={prUrl}
                  autoFocus
                  onChange={(event) => {
                    setPrUrl(event.target.value);
                    setPreview(null);
                  }}
                />
                <button type="button" onClick={() => void resolvePreview()} disabled={!prUrl.trim() || resolving}>
                  {resolving ? "Resolving…" : "Check"}
                </button>
              </div>
              {preview && (
                <p className="field-preview">
                  <code>{preview.source}</code> → <code>{preview.target}</code> · {preview.title}
                </p>
              )}
              {otherBranch && (
                <p className="field-hint">
                  This PR comes from another branch. Use New session → PR fix for it.
                </p>
              )}
            </div>
          </div>

          {error && <p className="error-banner">{error}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onClose} disabled={starting}>
              Cancel
            </button>
            <button type="submit" className="modal-confirm" disabled={starting || !prUrl.trim() || otherBranch}>
              {starting ? "Starting…" : "Start PR fix"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
