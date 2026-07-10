import { useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ProjectContextMenu } from "./ProjectContextMenu";
import { RemoveProjectConfirmDialog } from "./RemoveProjectConfirmDialog";
import type { ProjectRecord, WorkSession } from "../../shared/ipc/contract";
import { REPO_SESSION_PREFIX } from "../../shared/workflow/work-session";

interface ProjectRailProps {
  projects: ProjectRecord[];
  selectedProjectId: string | null;
  sessionsByProject: Record<string, WorkSession[]>;
  selectedSessionId: string | null;
  onSelectProject: (projectId: string) => void;
  onRequestCreateProject: () => void;
  onRequestEditProject: (project: ProjectRecord) => void;
  onProjectsChanged: () => void;
  onExpandProject: (projectId: string) => void;
  onSelectSession: (session: WorkSession) => void;
  onSelectRepo: (projectId: string) => void;
  onRequestCreateSession: (projectId: string) => void;
  onRequestRemoveSession: (session: WorkSession) => void;
}

function SidebarToggleIcon(): JSX.Element {
  return (
    <svg width="15" height="13" viewBox="0 0 15 13" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="14" height="12" rx="2" stroke="currentColor" />
      <line x1="5" y1="1" x2="5" y2="12" stroke="currentColor" />
    </svg>
  );
}

function PlusIcon(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ChevronRightIcon(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function TerminalDotIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}

function HomeIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}

function TrashIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function ProjectIcon(props: { project: ProjectRecord }): JSX.Element {
  const { project } = props;
  return project.iconDataUrl ? (
    <img className="project-list-icon" src={project.iconDataUrl} alt="" />
  ) : (
    <span className="project-list-icon project-list-icon-placeholder">{project.name.charAt(0).toUpperCase()}</span>
  );
}

export function ProjectRail(props: ProjectRailProps): JSX.Element {
  const {
    projects,
    selectedProjectId,
    sessionsByProject,
    selectedSessionId,
    onSelectProject,
    onRequestCreateProject,
    onRequestEditProject,
    onProjectsChanged,
    onExpandProject,
    onSelectSession,
    onSelectRepo,
    onRequestCreateSession,
    onRequestRemoveSession,
  } = props;

  const [collapsed, setCollapsed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ project: ProjectRecord; x: number; y: number } | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [removeConfirmProject, setRemoveConfirmProject] = useState<ProjectRecord | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());

  function handleContextMenu(event: ReactMouseEvent, project: ProjectRecord): void {
    event.preventDefault();
    setContextMenu({ project, x: event.clientX, y: event.clientY });
  }

  function startRename(project: ProjectRecord): void {
    setRenamingProjectId(project.id);
    setRenameDraft(project.name);
    setContextMenu(null);
  }

  async function submitRename(project: ProjectRecord): Promise<void> {
    const trimmed = renameDraft.trim();
    setRenamingProjectId(null);
    if (!trimmed || trimmed === project.name) return;
    await window.agentCoordinator.projects.update(project.id, { name: trimmed });
    onProjectsChanged();
  }

  function handleRenameKeyDown(event: KeyboardEvent<HTMLInputElement>, project: ProjectRecord): void {
    if (event.key === "Enter") void submitRename(project);
    if (event.key === "Escape") setRenamingProjectId(null);
  }

  async function handleOpenInFileManager(project: ProjectRecord): Promise<void> {
    setContextMenu(null);
    await window.agentCoordinator.projects.openInFileManager(project.rootPath);
  }

  async function handleConfirmRemove(): Promise<void> {
    if (!removeConfirmProject) return;
    await window.agentCoordinator.projects.remove(removeConfirmProject.id);
    setRemoveConfirmProject(null);
    onProjectsChanged();
  }

  function toggleExpanded(projectId: string): void {
    const willExpand = !expandedProjectIds.has(projectId);
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    if (willExpand) onExpandProject(projectId);
  }

  function handleAddSession(projectId: string): void {
    if (!expandedProjectIds.has(projectId)) {
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        next.add(projectId);
        return next;
      });
      onExpandProject(projectId);
    }
    onRequestCreateSession(projectId);
  }

  function renderSessions(projectId: string): JSX.Element | null {
    const sessions = sessionsByProject[projectId];
    if (sessions === undefined) return null;
    if (sessions.length === 0) {
      return (
        <div className="project-row-sessions-placeholder">
          <span className="project-row-sessions-icon">
            <TerminalDotIcon />
          </span>{" "}
          No sessions yet
        </div>
      );
    }
    return (
      <ul className="project-row-sessions">
        {sessions.map((session) => (
          <li key={session.id} className="session-row-item">
            <button
              type="button"
              className={`session-row${session.id === selectedSessionId ? " selected" : ""}`}
              onClick={() => onSelectSession(session)}
            >
              <span className="session-row-icon">
                <TerminalDotIcon />
              </span>
              <span className="session-row-name">{session.name}</span>
            </button>
            <button
              type="button"
              className="session-row-delete"
              aria-label={`Remove ${session.name}`}
              title="Remove session (deletes its worktree)"
              onClick={() => onRequestRemoveSession(session)}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <aside className={`project-rail${collapsed ? " project-rail-collapsed" : ""}`}>
      <div className="project-rail-header">
        <button
          type="button"
          className="project-rail-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((current) => !current)}
        >
          <SidebarToggleIcon />
        </button>
        {!collapsed && <h2>Projects</h2>}
        {!collapsed && (
          <button type="button" className="project-rail-add" aria-label="Add project" onClick={onRequestCreateProject}>
            <PlusIcon />
          </button>
        )}
      </div>

      {projects.length === 0 && !collapsed ? (
        <p className="empty-state">No projects yet.</p>
      ) : collapsed ? (
        <ul className="project-list project-list-collapsed">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={`project-list-select-collapsed${project.id === selectedProjectId ? " selected" : ""}`}
                title={project.name}
                onClick={() => onSelectProject(project.id)}
                onContextMenu={(event) => handleContextMenu(event, project)}
              >
                <ProjectIcon project={project} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="project-list">
          {projects.map((project) => {
            const expanded = expandedProjectIds.has(project.id);
            return (
              <li key={project.id}>
                <div className="project-row" onContextMenu={(event) => handleContextMenu(event, project)}>
                  <button
                    type="button"
                    className={`project-list-select${project.id === selectedProjectId ? " selected" : ""}`}
                    onClick={() => {
                      onSelectProject(project.id);
                      toggleExpanded(project.id);
                    }}
                  >
                    <ProjectIcon project={project} />
                    {renamingProjectId === project.id ? (
                      <input
                        type="text"
                        className="project-rename-input"
                        value={renameDraft}
                        autoFocus
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => void submitRename(project)}
                        onKeyDown={(event) => handleRenameKeyDown(event, project)}
                      />
                    ) : (
                      <span className="project-list-name">{project.name}</span>
                    )}
                  </button>
                  <div className="project-row-actions">
                    <button
                      type="button"
                      className="project-row-add-session"
                      title="New session"
                      aria-label="New session"
                      onClick={() => handleAddSession(project.id)}
                    >
                      <PlusIcon />
                    </button>
                    <button
                      type="button"
                      className={`project-row-chevron${expanded ? " expanded" : ""}`}
                      aria-label={expanded ? "Collapse" : "Expand"}
                      onClick={() => toggleExpanded(project.id)}
                    >
                      <ChevronRightIcon />
                    </button>
                  </div>
                </div>
                {expanded && (
                  <>
                    <div className="project-repo-entry">
                      <button
                        type="button"
                        className={`session-row repo-row${selectedSessionId === `${REPO_SESSION_PREFIX}${project.id}` ? " selected" : ""}`}
                        onClick={() => onSelectRepo(project.id)}
                        title="Repo root — browse files, open shells & diff (no worktree)"
                      >
                        <span className="session-row-icon repo-row-icon">
                          <HomeIcon />
                        </span>
                        <span className="session-row-name">Repo root</span>
                      </button>
                    </div>
                    {renderSessions(project.id)}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {contextMenu && (
        <ProjectContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => startRename(contextMenu.project)}
          onOpenInFileManager={() => void handleOpenInFileManager(contextMenu.project)}
          onOpenSettings={() => {
            onRequestEditProject(contextMenu.project);
            setContextMenu(null);
          }}
          onRequestRemove={() => {
            setRemoveConfirmProject(contextMenu.project);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {removeConfirmProject && (
        <RemoveProjectConfirmDialog
          projectName={removeConfirmProject.name}
          onConfirm={() => void handleConfirmRemove()}
          onCancel={() => setRemoveConfirmProject(null)}
        />
      )}
    </aside>
  );
}
