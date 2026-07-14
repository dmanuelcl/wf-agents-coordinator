import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import type { BranchList } from "../../shared/ipc/contract";
import { BranchCombobox } from "./BranchCombobox";

interface NewSessionDialogProps {
  projectId: string;
  onClose: () => void;
  onCreated: (session: WorkSession) => void;
}

const KIND_OPTIONS: { value: WorkSessionKind; label: string }[] = [
  { value: "feature", label: "New feature" },
  { value: "fix", label: "Bug fix" },
  { value: "review", label: "PR review" },
];

export function NewSessionDialog(props: NewSessionDialogProps): JSX.Element {
  const { projectId, onClose, onCreated } = props;

  const [kind, setKind] = useState<WorkSessionKind>("feature");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [copyEnv, setCopyEnv] = useState(false);
  const [reviewBranch, setReviewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load local + remote branches the first time Review is picked (fetches remotes).
  useEffect(() => {
    if (kind !== "review" || branches || loadingBranches) return;
    setLoadingBranches(true);
    window.agentCoordinator.git
      .listBranches(projectId)
      .then((list) => setBranches(list))
      .catch((caught) => setError(String(caught)))
      .finally(() => setLoadingBranches(false));
  }, [kind, branches, loadingBranches, projectId]);

  function chooseBranch(branch: string): void {
    setReviewBranch(branch);
    if (!nameTouched) setName(branch ? `Review ${branch}` : "");
  }

  function editName(value: string): void {
    setName(value);
    setNameTouched(true);
  }

  const canSubmit =
    kind === "review"
      ? name.trim().length > 0 && reviewBranch.length > 0 && baseBranch.trim().length > 0
      : name.trim().length > 0;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session =
        kind === "review"
          ? await window.agentCoordinator.sessions.createReview(projectId, {
              name: name.trim(),
              reviewBranch,
              baseBranch: baseBranch.trim(),
            })
          : await window.agentCoordinator.sessions.create(projectId, {
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

          {kind === "review" ? (
            <>
              <div className="new-session-field">
                <label htmlFor="review-branch" className="field-label">
                  Branch to review <span className="req">*</span>
                </label>
                <BranchCombobox
                  inputId="review-branch"
                  branches={branches}
                  loading={loadingBranches}
                  value={reviewBranch}
                  onChange={chooseBranch}
                />
              </div>

              <div className="new-session-field">
                <label htmlFor="review-base" className="field-label">
                  Base branch <span className="req">*</span>
                </label>
                <input
                  id="review-base"
                  type="text"
                  placeholder="main / develop"
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.target.value)}
                />
              </div>

              <div className="new-session-field">
                <label htmlFor="session-name" className="field-label">
                  Session name <span className="req">*</span>
                </label>
                <input
                  id="session-name"
                  type="text"
                  placeholder="Auto-filled from the branch"
                  value={name}
                  onChange={(event) => editName(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
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
                  onChange={(event) => editName(event.target.value)}
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
            </>
          )}

          {error && <p className="error-banner">{error}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="modal-confirm" disabled={submitting || !canSubmit}>
              {kind === "review" ? "Start review" : "Create session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
