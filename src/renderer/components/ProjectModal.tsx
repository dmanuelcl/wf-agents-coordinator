import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { createDefaultProjectRuntimeConfig, DANGEROUS_SUPPORTED } from "../../shared/workflow/agent-runtime-config";
import type { AgentKind, ProjectRuntimeConfig, WorkflowStage } from "../../shared/workflow/agent-runtime-config";
import type { ProjectRecord } from "../../shared/ipc/contract";

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
        });
        onSaved(created);
      } else {
        const updated = await window.agentCoordinator.projects.update(project!.id, {
          name: trimmedName || undefined,
          iconDataUrl,
          runtimeConfig,
        });
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
