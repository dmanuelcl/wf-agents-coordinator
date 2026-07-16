import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import type { BranchList, ResolvedPr } from "../../shared/ipc/contract";
import { BranchCombobox } from "./BranchCombobox";

type ReviewSource = "manual" | "link";

interface NewSessionDialogProps {
  projectId: string;
  onClose: () => void;
  onCreated: (session: WorkSession) => void;
}

const KIND_OPTIONS: { value: WorkSessionKind; label: string }[] = [
  { value: "feature", label: "New feature" },
  { value: "fix", label: "Bug fix" },
  { value: "review", label: "PR review" },
  { value: "pr-fix", label: "PR fix" },
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
  const [reviewSource, setReviewSource] = useState<ReviewSource>("manual");
  const [prUrl, setPrUrl] = useState("");
  const [preview, setPreview] = useState<ResolvedPr | null>(null);
  const [resolving, setResolving] = useState(false);
  const [hasVcsCreds, setHasVcsCreds] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether the PR-link source is available (a VCS host + token is configured).
  useEffect(() => {
    void window.agentCoordinator.projects.hasVcsCreds(projectId).then(setHasVcsCreds);
  }, [projectId]);

  // Load local + remote branches the first time Review is picked (fetches remotes).
  useEffect(() => {
    if (kind !== "review" || reviewSource !== "manual" || branches || loadingBranches) return;
    setLoadingBranches(true);
    window.agentCoordinator.git
      .listBranches(projectId)
      .then((list) => setBranches(list))
      .catch((caught) => setError(String(caught)))
      .finally(() => setLoadingBranches(false));
  }, [kind, reviewSource, branches, loadingBranches, projectId]);

  function chooseBranch(branch: string): void {
    setReviewBranch(branch);
    if (!nameTouched) setName(branch ? `Review ${branch}` : "");
  }

  function editName(value: string): void {
    setName(value);
    setNameTouched(true);
  }

  async function resolvePreview(): Promise<void> {
    if (!prUrl.trim()) return;
    setResolving(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await window.agentCoordinator.git.resolvePrUrl(projectId, prUrl.trim()));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setResolving(false);
    }
  }

  const isPrKind = kind === "review" || kind === "pr-fix";
  // pr-fix is link-only; review uses the manual/link toggle.
  const linkMode = kind === "pr-fix" || (kind === "review" && reviewSource === "link");
  const canSubmit = isPrKind
    ? linkMode
      ? prUrl.trim().length > 0
      : name.trim().length > 0 && reviewBranch.length > 0 && baseBranch.trim().length > 0
    : name.trim().length > 0;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let session: WorkSession;
      if (kind === "pr-fix") {
        session = await window.agentCoordinator.sessions.createFixFromPr(projectId, { url: prUrl.trim() });
      } else if (kind === "review" && linkMode) {
        session = await window.agentCoordinator.sessions.createReviewFromPr(projectId, { url: prUrl.trim() });
      } else if (kind === "review") {
        session = await window.agentCoordinator.sessions.createReview(projectId, {
          name: name.trim(),
          reviewBranch,
          baseBranch: baseBranch.trim(),
        });
      } else {
        session = await window.agentCoordinator.sessions.create(projectId, { name: name.trim(), kind, copyEnv });
      }
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

          {isPrKind ? (
            <>
              {kind === "review" && (
                <div className="new-session-field">
                  <span className="field-label">Source</span>
                  <div className="segmented" role="radiogroup" aria-label="Review source">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={reviewSource === "manual"}
                      className={`segmented-option${reviewSource === "manual" ? " selected" : ""}`}
                      onClick={() => setReviewSource("manual")}
                    >
                      Manual (branch + base)
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={reviewSource === "link"}
                      disabled={!hasVcsCreds}
                      title={hasVcsCreds ? undefined : "Configure a VCS host + token in project settings first"}
                      className={`segmented-option${reviewSource === "link" ? " selected" : ""}`}
                      onClick={() => setReviewSource("link")}
                    >
                      From PR link
                    </button>
                  </div>
                  {!hasVcsCreds && (
                    <p className="field-hint">From-link needs a VCS host + API token in the project settings.</p>
                  )}
                </div>
              )}

              {kind === "pr-fix" && !hasVcsCreds && (
                <p className="field-hint">PR fix needs a VCS host + API token in the project settings.</p>
              )}

              {linkMode ? (
                <div className="new-session-field">
                  <label htmlFor="review-pr-url" className="field-label">
                    PR link <span className="req">*</span>
                  </label>
                  <div className="pr-url-row">
                    <input
                      id="review-pr-url"
                      type="text"
                      placeholder="https://bitbucket.org/workspace/repo/pull-requests/482"
                      value={prUrl}
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
                </div>
              ) : (
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
              )}
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
              {submitting
                ? isPrKind
                  ? "Setting up worktree…"
                  : "Creating…"
                : kind === "review"
                  ? "Start review"
                  : kind === "pr-fix"
                    ? "Start fix"
                    : "Create session"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
