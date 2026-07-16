import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { createDefaultProjectRuntimeConfig, DANGEROUS_SUPPORTED } from "../../shared/workflow/agent-runtime-config";
import type { AgentKind, ProjectRuntimeConfig, WorkflowStage } from "../../shared/workflow/agent-runtime-config";
import { createDefaultAutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import type { AutoPilotConfig } from "../../shared/workflow/auto-pilot-config";
import { createDefaultReviewConfig, DEFAULT_REVIEW_KICKOFF } from "../../shared/workflow/review-config";
import type { ReviewConfig } from "../../shared/workflow/review-config";
import { createDefaultVcsConfig } from "../../shared/workflow/vcs-config";
import type { VcsConfig, VcsHost } from "../../shared/workflow/vcs-config";
import type { ProjectRecord } from "../../shared/ipc/contract";

const VCS_HOSTS: (VcsHost | "none")[] = ["none", "bitbucket", "github"];

const AGENT_KINDS: AgentKind[] = ["claude", "codex", "copilot", "opencode", "gemini", "antigravity"];
const WORKFLOW_STAGES: WorkflowStage[] = ["architect", "implementer", "reviewer"];

const STAGE_LABELS: Record<WorkflowStage, string> = {
  architect: "Architect",
  implementer: "Implementer",
  reviewer: "Reviewer",
};

const MODEL_PLACEHOLDERS: Record<AgentKind, string> = {
  claude: "opus",
  codex: "gpt-5.5",
  opencode: "anthropic/claude-opus-4-8",
  copilot: "(not applied)",
  gemini: "gemini-2.5-pro",
  antigravity: "(unverified)",
};

const EFFORT_PLACEHOLDERS: Record<AgentKind, string> = {
  claude: "high (sent as /effort after launch)",
  codex: "high",
  opencode: "not supported",
  copilot: "not supported",
  gemini: "not supported",
  antigravity: "not supported",
};

type RepoSourceMode = "existing" | "new" | "clone";

interface ProjectModalProps {
  mode: "create" | "edit";
  project?: ProjectRecord;
  onClose: () => void;
  onSaved: (project: ProjectRecord) => void;
}

function resizeImageToDataUrl(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load image"));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function PlusIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ProjectModal(props: ProjectModalProps): JSX.Element {
  const { mode, project, onClose, onSaved } = props;

  const [name, setName] = useState(project?.name ?? "");
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(project?.iconDataUrl ?? null);
  const [sourceMode, setSourceMode] = useState<RepoSourceMode>("existing");
  const [existingFolderPath, setExistingFolderPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [repoName, setRepoName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfig>(
    project?.runtimeConfig ?? createDefaultProjectRuntimeConfig(),
  );
  const [autoPilot, setAutoPilot] = useState<AutoPilotConfig>(project?.autoPilot ?? createDefaultAutoPilotConfig());
  const [review, setReview] = useState<ReviewConfig>(project?.review ?? createDefaultReviewConfig());
  const [vcs, setVcs] = useState<VcsConfig>(project?.vcs ?? createDefaultVcsConfig());
  const [setupCommand, setSetupCommand] = useState(project?.setupCommand ?? "");
  const [vcsToken, setVcsToken] = useState("");
  const [vcsTokenTouched, setVcsTokenTouched] = useState(false);
  const [hasVcsCreds, setHasVcsCreds] = useState(false);
  const [vcsTesting, setVcsTesting] = useState(false);
  const [vcsTestResult, setVcsTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Whether a token is already stored (edit mode) — so the token field can show
  // "configured" without ever reading the token back into the renderer.
  useEffect(() => {
    if (mode !== "edit" || !project) return;
    void window.agentCoordinator.projects.hasVcsCreds(project.id).then(setHasVcsCreds);
  }, [mode, project]);

  function updateStage(stage: WorkflowStage, patch: Partial<ProjectRuntimeConfig[WorkflowStage]>): void {
    setRuntimeConfig((current) => ({
      ...current,
      [stage]: { ...current[stage], ...patch },
    }));
  }

  function handleIconClick(): void {
    fileInputRef.current?.click();
  }

  async function handleIconFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file, 128);
      setIconDataUrl(dataUrl);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function handleTestVcs(): Promise<void> {
    setVcsTesting(true);
    setVcsTestResult(null);
    try {
      const { detail } = await window.agentCoordinator.git.testVcs({
        config: vcs,
        token: vcsToken.trim() || null,
        projectId: project?.id ?? null,
      });
      setVcsTestResult({ ok: true, message: `Connected ✓ ${detail}` });
    } catch (caught) {
      setVcsTestResult({ ok: false, message: `Failed — ${String(caught)}` });
    } finally {
      setVcsTesting(false);
    }
  }

  async function handlePickExistingFolder(): Promise<void> {
    const picked = await window.agentCoordinator.projects.pickFolder();
    if (picked) setExistingFolderPath(picked);
  }

  async function handlePickParentFolder(): Promise<void> {
    const picked = await window.agentCoordinator.projects.pickFolder();
    if (picked) setParentPath(picked);
  }

  async function resolveRootPath(): Promise<string> {
    if (sourceMode === "existing") {
      if (!existingFolderPath) throw new Error("Choose an existing folder.");
      return existingFolderPath;
    }
    if (sourceMode === "new") {
      if (!parentPath) throw new Error("Choose a parent folder.");
      if (!repoName.trim()) throw new Error("Enter a name for the new repo folder.");
      return window.agentCoordinator.projects.createEmptyRepo(parentPath, repoName.trim());
    }
    if (!cloneUrl.trim()) throw new Error("Enter a URL to clone.");
    if (!parentPath) throw new Error("Choose a parent folder.");
    if (!repoName.trim()) throw new Error("Enter a name for the cloned folder.");
    return window.agentCoordinator.projects.cloneRepo(cloneUrl.trim(), parentPath, repoName.trim());
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      if (mode === "create") {
        const rootPath = await resolveRootPath();
        const created = await window.agentCoordinator.projects.add({
          rootPath,
          name: trimmedName || undefined,
          iconDataUrl,
          runtimeConfig,
          autoPilot,
          review,
          vcs,
          setupCommand,
        });
        if (vcsToken.trim()) await window.agentCoordinator.projects.setVcsToken(created.id, vcsToken.trim());
        onSaved(created);
      } else {
        const updated = await window.agentCoordinator.projects.update(project!.id, {
          name: trimmedName || undefined,
          iconDataUrl,
          runtimeConfig,
          autoPilot,
          review,
          vcs,
          setupCommand,
        });
        if (vcsTokenTouched) await window.agentCoordinator.projects.setVcsToken(project!.id, vcsToken.trim());
        onSaved(updated);
      }
      onClose();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    mode === "edit"
      ? true
      : sourceMode === "existing"
        ? existingFolderPath !== null
        : sourceMode === "new"
          ? parentPath !== null && repoName.trim().length > 0
          : cloneUrl.trim().length > 0 && parentPath !== null && repoName.trim().length > 0;

  return (
    <div className="modal-overlay">
      <div className="modal project-modal">
        <h2>{mode === "create" ? "New project" : "Edit project"}</h2>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <section>
            <h3>Basics</h3>
            <div className="project-modal-basics">
              <button type="button" className="icon-picker" onClick={handleIconClick}>
                {iconDataUrl ? <img src={iconDataUrl} alt="Project icon" /> : <PlusIcon />}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="icon-picker-input"
                onChange={(event) => void handleIconFileChange(event)}
              />
              <div className="project-modal-name">
                <label htmlFor="project-name">Name</label>
                <input
                  id="project-name"
                  type="text"
                  placeholder="Defaults to folder name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>

            {mode === "edit" ? (
              <p className="project-modal-readonly-path">
                Path: <code>{project?.rootPath}</code>
              </p>
            ) : (
              <div className="repo-source">
                <div className="repo-source-radios">
                  <label>
                    <input
                      type="radio"
                      name="repo-source"
                      checked={sourceMode === "existing"}
                      onChange={() => setSourceMode("existing")}
                    />
                    Existing folder
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="repo-source"
                      checked={sourceMode === "new"}
                      onChange={() => setSourceMode("new")}
                    />
                    New empty repo
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="repo-source"
                      checked={sourceMode === "clone"}
                      onChange={() => setSourceMode("clone")}
                    />
                    Clone from URL
                  </label>
                </div>

                {sourceMode === "existing" && (
                  <div className="repo-source-fields">
                    <label className="field-label">
                      Repository folder <span className="req">*</span>
                    </label>
                    <div className="path-picker">
                      <button type="button" onClick={() => void handlePickExistingFolder()}>
                        Choose folder…
                      </button>
                      {existingFolderPath ? (
                        <code className="path-chip">{existingFolderPath}</code>
                      ) : (
                        <span className="field-hint">Required — no folder chosen yet</span>
                      )}
                    </div>
                  </div>
                )}

                {sourceMode === "new" && (
                  <div className="repo-source-fields">
                    <label className="field-label">
                      Parent folder <span className="req">*</span>
                    </label>
                    <div className="path-picker">
                      <button type="button" onClick={() => void handlePickParentFolder()}>
                        Choose folder…
                      </button>
                      {parentPath ? (
                        <code className="path-chip">{parentPath}</code>
                      ) : (
                        <span className="field-hint">Required — no folder chosen yet</span>
                      )}
                    </div>
                    <label className="field-label">
                      New folder name <span className="req">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="my-new-repo"
                      value={repoName}
                      onChange={(event) => setRepoName(event.target.value)}
                    />
                    {parentPath && repoName.trim() && (
                      <p className="field-preview">
                        Creates <code>{`${parentPath}/${repoName.trim()}`}</code>
                      </p>
                    )}
                  </div>
                )}

                {sourceMode === "clone" && (
                  <div className="repo-source-fields">
                    <label className="field-label">
                      Repository URL <span className="req">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="https://github.com/owner/repo.git"
                      value={cloneUrl}
                      onChange={(event) => setCloneUrl(event.target.value)}
                    />
                    <label className="field-label">
                      Parent folder <span className="req">*</span>
                    </label>
                    <div className="path-picker">
                      <button type="button" onClick={() => void handlePickParentFolder()}>
                        Choose folder…
                      </button>
                      {parentPath ? (
                        <code className="path-chip">{parentPath}</code>
                      ) : (
                        <span className="field-hint">Required — no folder chosen yet</span>
                      )}
                    </div>
                    <label className="field-label">
                      New folder name <span className="req">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="my-clone"
                      value={repoName}
                      onChange={(event) => setRepoName(event.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </section>

          <section>
            <h3>Per-stage agent config</h3>
            <table className="stage-config-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Agent</th>
                  <th>Model</th>
                  <th>Effort</th>
                  <th>Dangerous</th>
                </tr>
              </thead>
              <tbody>
                {WORKFLOW_STAGES.map((stage) => {
                  const config = runtimeConfig[stage];
                  const dangerousSupported = DANGEROUS_SUPPORTED[config.kind];
                  return (
                    <tr key={stage}>
                      <td>{STAGE_LABELS[stage]}</td>
                      <td>
                        <select
                          value={config.kind}
                          onChange={(event) => updateStage(stage, { kind: event.target.value as AgentKind })}
                        >
                          {AGENT_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          placeholder={MODEL_PLACEHOLDERS[config.kind]}
                          value={config.model}
                          onChange={(event) => updateStage(stage, { model: event.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          placeholder={EFFORT_PLACEHOLDERS[config.kind]}
                          value={config.effort ?? ""}
                          onChange={(event) => updateStage(stage, { effort: event.target.value || null })}
                        />
                      </td>
                      <td className="stage-config-dangerous">
                        <input
                          type="checkbox"
                          checked={config.dangerous}
                          disabled={!dangerousSupported}
                          onChange={(event) => updateStage(stage, { dangerous: event.target.checked })}
                        />
                        {!dangerousSupported && <span className="warning">No confirmed bypass flag — ignored.</span>}
                        {dangerousSupported && config.dangerous && (
                          <span className="warning">Skips permission prompts for this stage.</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section>
            <h3>Worktree setup</h3>
            <p className="section-hint">
              A shell command run once in a fresh worktree <strong>before</strong> the agent starts (e.g.{" "}
              <code>pnpm install</code>). The agent waits for it to finish; if it fails, the tab drops to a shell so you
              can fix it. Empty = skip.
            </p>
            <input
              type="text"
              className="setup-command-input"
              placeholder="pnpm install"
              value={setupCommand}
              onChange={(event) => setSetupCommand(event.target.value)}
            />
          </section>

          <section>
            <h3>Auto-pilot</h3>
            <p className="section-hint">
              When enabled per session, the conductor auto-runs each <code>▶ NEXT</code> command. It auto-runs a
              reviewer→implementer fix-loop up to the re-loop limit, then pauses. The settle delay is how long the
              checkpoint must be quiet before it acts (so it never fires mid-write).
            </p>
            <div className="autopilot-config">
              <label>
                Re-loop limit
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={autoPilot.reloopLimit}
                  onChange={(event) => setAutoPilot((c) => ({ ...c, reloopLimit: Number(event.target.value) }))}
                />
              </label>
              <label>
                Settle delay (seconds)
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={autoPilot.settleDelayMs / 1000}
                  onChange={(event) =>
                    setAutoPilot((c) => ({ ...c, settleDelayMs: Math.round(Number(event.target.value) * 1000) }))
                  }
                />
              </label>
            </div>
          </section>

          <section>
            <h3>PR Review</h3>
            <p className="section-hint">
              A <strong>PR review</strong> session auto-runs the reviewer against a branch. Set a Slack channel to
              enable the <code>Post to Slack</code> button (the agent posts the review there). The kickoff is what the
              reviewer is told to do — <code>{"{branch}"}</code> and <code>{"{base}"}</code> are substituted.
            </p>
            <div className="review-config">
              <label>
                Slack channel
                <input
                  type="text"
                  placeholder="#pr-reviews (leave empty to disable)"
                  value={review.slackChannel}
                  onChange={(event) => setReview((c) => ({ ...c, slackChannel: event.target.value }))}
                />
              </label>
              <label>
                Review kickoff
                <textarea
                  rows={4}
                  placeholder={DEFAULT_REVIEW_KICKOFF}
                  value={review.kickoff}
                  onChange={(event) => setReview((c) => ({ ...c, kickoff: event.target.value }))}
                />
              </label>
            </div>
          </section>

          <section>
            <h3>VCS host</h3>
            <p className="section-hint">
              Lets you create a review from a <strong>PR link</strong> and post the review as a PR comment. The API
              token is stored encrypted (OS keychain) — never in plaintext. Bitbucket: for an <strong>Access Token</strong>{" "}
              (starts with <code>ATCTT…</code>) leave email empty; for an <strong>Atlassian API token</strong> set your
              account email.
            </p>
            <div className="review-config">
              <label>
                Host
                <select value={vcs.host} onChange={(event) => setVcs((c) => ({ ...c, host: event.target.value as VcsHost | "none" }))}>
                  {VCS_HOSTS.map((host) => (
                    <option key={host} value={host}>
                      {host}
                    </option>
                  ))}
                </select>
              </label>
              {vcs.host !== "none" && (
                <>
                  <label>
                    Workspace / owner
                    <input
                      type="text"
                      placeholder="acme"
                      value={vcs.workspace}
                      onChange={(event) => setVcs((c) => ({ ...c, workspace: event.target.value }))}
                    />
                  </label>
                  <label>
                    Repo
                    <input
                      type="text"
                      placeholder="web"
                      value={vcs.repo}
                      onChange={(event) => setVcs((c) => ({ ...c, repo: event.target.value }))}
                    />
                  </label>
                  <label>
                    Email <span className="field-hint-inline">(Bitbucket API token only)</span>
                    <input
                      type="text"
                      placeholder="you@company.com (leave empty for a Bearer access token)"
                      value={vcs.email}
                      onChange={(event) => setVcs((c) => ({ ...c, email: event.target.value }))}
                    />
                  </label>
                  <label>
                    API token
                    <input
                      type="password"
                      placeholder={hasVcsCreds ? "configured ✓ — type to replace" : "paste the API token"}
                      value={vcsToken}
                      onChange={(event) => {
                        setVcsToken(event.target.value);
                        setVcsTokenTouched(true);
                        setVcsTestResult(null);
                      }}
                    />
                  </label>
                  <div className="vcs-test-row">
                    <button
                      type="button"
                      onClick={() => void handleTestVcs()}
                      disabled={vcsTesting || (!vcsToken.trim() && !hasVcsCreds)}
                    >
                      {vcsTesting ? "Testing…" : "Test connection"}
                    </button>
                    {vcsTestResult && (
                      <span className={`vcs-test-result ${vcsTestResult.ok ? "ok" : "err"}`}>
                        {vcsTestResult.message}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>

          {error && <p className="error-banner">{error}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="modal-confirm" disabled={submitting || !canSubmit}>
              {mode === "create" ? "Create project" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
