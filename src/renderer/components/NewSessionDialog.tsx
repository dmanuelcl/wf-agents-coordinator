import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { SESSION_NAME_MAX_LENGTH, truncateSessionName } from "../../shared/workflow/work-session";
import type { WorkSession, WorkSessionKind } from "../../shared/workflow/work-session";
import type { BranchList, RefCheckpointSummary, ResolvedPr } from "../../shared/ipc/contract";
import { BranchCombobox } from "./BranchCombobox";
import {
  buildStartFromInput,
  canSubmitStartFrom,
  startFromBranchHint,
  suggestSessionName,
} from "./session-start-from";
import type { StartFromMode } from "./session-start-from";

type ReviewSource = "manual" | "link";

const START_FROM_OPTIONS: { value: StartFromMode; label: string }[] = [
  { value: "new", label: "New branch" },
  { value: "continue", label: "Continue" },
  { value: "fork", label: "Fork" },
];

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
  const [reuseBuildArtifacts, setReuseBuildArtifacts] = useState(false);
  const [reviewBranch, setReviewBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [reviewSource, setReviewSource] = useState<ReviewSource>("manual");
  const [startFrom, setStartFrom] = useState<StartFromMode>("new");
  const [startRef, setStartRef] = useState("");
  const [startCheckpoint, setStartCheckpoint] = useState("");
  const [refCheckpoints, setRefCheckpoints] = useState<RefCheckpointSummary[] | null>(null);
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);
  const [prUrl, setPrUrl] = useState("");
  const [prFixDiagnoseFirst, setPrFixDiagnoseFirst] = useState(false);
  const [preview, setPreview] = useState<ResolvedPr | null>(null);
  const [resolving, setResolving] = useState(false);
  const [hasVcsCreds, setHasVcsCreds] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether the PR-link source is available (a VCS host + token is configured).
  useEffect(() => {
    void window.agentCoordinator.projects.hasVcsCreds(projectId).then(setHasVcsCreds);
  }, [projectId]);

  const isPrKind = kind === "review" || kind === "pr-fix";
  // pr-fix is link-only; review uses the manual/link toggle.
  const linkMode = kind === "pr-fix" || (kind === "review" && reviewSource === "link");
  const needsBranchList = (kind === "review" && reviewSource === "manual") || (!isPrKind && startFrom !== "new");

  // Load local + remote branches the first time a branch has to be picked
  // (fetches remotes), for either a manual review or a start point.
  useEffect(() => {
    if (!needsBranchList || branches || loadingBranches) return;
    setLoadingBranches(true);
    window.agentCoordinator.git
      .listBranches(projectId)
      .then((list) => setBranches(list))
      .catch((caught) => setError(String(caught)))
      .finally(() => setLoadingBranches(false));
  }, [needsBranchList, branches, loadingBranches, projectId]);

  // Read the chosen ref's checkpoints without checking it out, so the picker
  // can offer them before any worktree exists.
  useEffect(() => {
    if (startFrom === "new" || !startRef) {
      setRefCheckpoints(null);
      return;
    }
    let cancelled = false;
    setLoadingCheckpoints(true);
    setRefCheckpoints(null);
    window.agentCoordinator.git
      .listRefCheckpoints(projectId, startRef)
      .then((found) => {
        if (!cancelled) setRefCheckpoints(found);
      })
      .catch(() => {
        if (!cancelled) setRefCheckpoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCheckpoints(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, startFrom, startRef]);

  function chooseBranch(branch: string): void {
    setReviewBranch(branch);
    if (!nameTouched) setName(branch ? truncateSessionName(`Review ${branch}`) : "");
  }

  function chooseStartRef(branch: string): void {
    setStartRef(branch);
    setStartCheckpoint("");
    if (!nameTouched) setName(suggestSessionName(startFrom, branch));
  }

  function chooseStartFrom(mode: StartFromMode): void {
    setStartFrom(mode);
    setStartCheckpoint("");
    if (!nameTouched) setName(suggestSessionName(mode, startRef));
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

  const canSubmit = isPrKind
    ? linkMode
      ? prUrl.trim().length > 0
      : name.trim().length > 0 && reviewBranch.length > 0 && baseBranch.trim().length > 0
    : canSubmitStartFrom({ mode: startFrom, ref: startRef, name });

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let session: WorkSession;
      if (kind === "pr-fix") {
        session = await window.agentCoordinator.sessions.createFixFromPr(projectId, {
          url: prUrl.trim(),
          diagnoseFirst: prFixDiagnoseFirst,
        });
      } else if (kind === "review" && linkMode) {
        session = await window.agentCoordinator.sessions.createReviewFromPr(projectId, { url: prUrl.trim() });
      } else if (kind === "review") {
        session = await window.agentCoordinator.sessions.createReview(projectId, {
          name: name.trim(),
          reviewBranch,
          baseBranch: baseBranch.trim(),
        });
      } else {
        session = await window.agentCoordinator.sessions.create(projectId, {
          name: name.trim(),
          kind,
          copyEnv,
          reuseBuildArtifacts,
          startFrom: buildStartFromInput({ mode: startFrom, ref: startRef, checkpointPath: startCheckpoint }),
        });
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
          {/* Only the fields scroll. The error and the actions stay put, so a
              laptop screen never hides the button you are looking for. */}
          <div className="new-session-body">
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

                {kind === "pr-fix" && (
                  <div className="new-session-field">
                    <label className="new-session-check">
                      <input
                        type="checkbox"
                        checked={prFixDiagnoseFirst}
                        onChange={(event) => setPrFixDiagnoseFirst(event.target.checked)}
                      />
                      <span>Diagnose and plan before implementing</span>
                    </label>
                    <p className="field-hint">
                      Architect reads the PR discussion and writes a correction plan first; then Implementer executes it and Reviewer validates it.
                    </p>
                  </div>
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
                        maxLength={SESSION_NAME_MAX_LENGTH}
                        onChange={(event) => editName(event.target.value)}
                      />
                      <p className="field-hint">
                        {name.length}/{SESSION_NAME_MAX_LENGTH} characters
                      </p>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <div className="new-session-field">
                  <span className="field-label">Start from</span>
                  <div className="segmented" role="radiogroup" aria-label="Start point">
                    {START_FROM_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={startFrom === option.value}
                        className={`segmented-option${startFrom === option.value ? " selected" : ""}`}
                        onClick={() => chooseStartFrom(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <p className="field-hint">
                    {startFrom === "new"
                      ? "A new branch off whatever the repo root has checked out."
                      : startFrom === "continue"
                        ? "Pick up work already on a branch — a teammate's session, or your own from another machine."
                        : "Start a new branch from a base an architect published the specs and plan on."}
                  </p>
                </div>

                {startFrom !== "new" && (
                  <>
                    <div className="new-session-field">
                      <label htmlFor="start-ref" className="field-label">
                        {startFrom === "continue" ? "Branch to continue" : "Base branch"} <span className="req">*</span>
                      </label>
                      <BranchCombobox
                        inputId="start-ref"
                        branches={branches}
                        loading={loadingBranches}
                        value={startRef}
                        onChange={chooseStartRef}
                      />
                      {startRef && <p className="field-hint">{startFromBranchHint(startFrom, startRef)}</p>}
                    </div>

                    <div className="new-session-field">
                      <label htmlFor="start-checkpoint" className="field-label">
                        Checkpoint
                      </label>
                      <select
                        id="start-checkpoint"
                        value={startCheckpoint}
                        disabled={!startRef || loadingCheckpoints}
                        onChange={(event) => setStartCheckpoint(event.target.value)}
                      >
                        <option value="">
                          {loadingCheckpoints ? "Reading the branch…" : "None — start at Architect"}
                        </option>
                        {(refCheckpoints ?? []).map((checkpoint) => (
                          <option key={checkpoint.path} value={checkpoint.path}>
                            {checkpoint.feature ?? checkpoint.slug ?? checkpoint.path} · {checkpoint.status}
                          </option>
                        ))}
                      </select>
                      <p className="field-hint">
                        {!startRef
                          ? "Pick a branch first."
                          : refCheckpoints && refCheckpoints.length === 0
                            ? "No checkpoint committed on this branch — the session starts at Architect."
                            : "Adopting one unlocks Implementer and Reviewer right away, with wf implement pre-typed."}
                      </p>
                    </div>
                  </>
                )}

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
                    maxLength={SESSION_NAME_MAX_LENGTH}
                    onChange={(event) => editName(event.target.value)}
                  />
                  <p className="field-hint">
                    {name.length}/{SESSION_NAME_MAX_LENGTH} characters
                  </p>
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

                <div className="new-session-field">
                  <label className="new-session-check">
                    <input
                      type="checkbox"
                      checked={reuseBuildArtifacts}
                      onChange={(event) => setReuseBuildArtifacts(event.target.checked)}
                    />
                    <span>
                      Reuse <code>dist</code>/<code>generated</code> and skip worktree setup
                    </span>
                  </label>
                  <p className="field-hint">
                    Fast path for parallel sessions. Only ignored output from a clean repo root at the same commit is
                    copied; use it when that output is current. Copy-on-write is used when available.
                  </p>
                </div>
              </>
            )}
          </div>

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
