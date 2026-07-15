import { useCallback, useEffect, useRef, useState } from "react";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { ProjectModal } from "./components/ProjectModal";
import { ProjectRail } from "./components/ProjectRail";
import { SessionView } from "./components/SessionView";
import type { SessionLayout, ShellTab } from "./components/SessionView";
import type { PersistedSessionLayout, ProjectRecord, WorkSession, WorkspaceLayout } from "../shared/ipc/contract";
import { isSessionAgentRole } from "../shared/workflow/session-role-launch";
import type { SessionAgentRole } from "../shared/workflow/session-role-launch";
import { REPO_SESSION_PREFIX, isRepoSessionId } from "../shared/workflow/work-session";

// A synthetic "session" for a project's repo-root workspace (no worktree, no
// agents). It flows through the same open/select/persist machinery as real
// sessions, keyed by `repo::<projectId>`.
function repoSessionFor(project: ProjectRecord): WorkSession {
  return {
    id: `${REPO_SESSION_PREFIX}${project.id}`,
    projectId: project.id,
    name: project.name,
    kind: "feature",
    slug: "repo",
    branch: "",
    baseBranch: null,
    pr: null,
    worktreePath: project.rootPath,
    checkpointPath: null,
    createdAtEpochMs: 0,
  };
}

// Validate a persisted session layout — a stale workspace file must not crash a
// restore or resurrect a role/tab we no longer understand.
function sanitizeSessionLayout(persisted: PersistedSessionLayout): SessionLayout {
  const openedRoleTabs = (persisted.openedRoleTabs ?? []).filter(isSessionAgentRole);
  const shellTabs: ShellTab[] = Array.isArray(persisted.shellTabs)
    ? persisted.shellTabs
        .filter((tab): tab is ShellTab => !!tab && typeof tab.id === "string" && typeof tab.title === "string")
        .map((tab) => ({ id: tab.id, title: tab.title, root: tab.root === true }))
    : [];
  const activeTab =
    typeof persisted.activeTab === "string" && persisted.activeTab.length > 0 ? persisted.activeTab : "architect";
  const roleTabs: SessionAgentRole[] =
    openedRoleTabs.length > 0 || shellTabs.length > 0 ? openedRoleTabs : ["architect"];
  return { openedRoleTabs: roleTabs, shellTabs, activeTab };
}

function sameLayout(a: SessionLayout, b: SessionLayout): boolean {
  return (
    a.activeTab === b.activeTab &&
    a.openedRoleTabs.length === b.openedRoleTabs.length &&
    a.openedRoleTabs.every((role, index) => role === b.openedRoleTabs[index]) &&
    a.shellTabs.length === b.shellTabs.length &&
    a.shellTabs.every(
      (tab, index) =>
        tab.id === b.shellTabs[index]?.id &&
        tab.title === b.shellTabs[index]?.title &&
        (tab.root ?? false) === (b.shellTabs[index]?.root ?? false),
    )
  );
}

export function App(): JSX.Element {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, WorkSession[]>>({});
  // Sessions opened at least once this run. Their SessionViews stay mounted
  // (agents keep running) even while another session is shown; only the
  // selected one is visible.
  const [openedSessionIds, setOpenedSessionIds] = useState<string[]>([]);
  // Live per-session tab layout, reported up by each SessionView for persistence.
  const [sessionLayouts, setSessionLayouts] = useState<Record<string, SessionLayout>>({});
  // Layout restored on startup, read once by each SessionView's initialiser.
  const restoredLayoutsRef = useRef<Record<string, SessionLayout>>({});
  // Gates the persist effect so it never overwrites the saved layout with the
  // blank initial state before restore has run.
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [newSessionProjectId, setNewSessionProjectId] = useState<string | null>(null);
  const [sessionToRemove, setSessionToRemove] = useState<WorkSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectModal, setProjectModal] = useState<{ mode: "create" } | { mode: "edit"; project: ProjectRecord } | null>(
    null,
  );

  // Real sessions plus one synthetic repo-root workspace per project.
  const allSessions = [...projects.map(repoSessionFor), ...Object.values(sessionsByProject).flat()];
  const selectedSession = selectedSessionId
    ? (allSessions.find((session) => session.id === selectedSessionId) ?? null)
    : null;
  const selectedSessionCheckpoint = selectedSession?.checkpointPath ?? null;
  const selectedSessionKind = selectedSession?.kind ?? null;
  const openedSessions = openedSessionIds
    .map((id) => allSessions.find((session) => session.id === id))
    .filter((session): session is WorkSession => session !== undefined);

  // Startup: load projects + every project's sessions, then restore the saved
  // workspace (which sessions/tabs were open, what was selected). Agent
  // conversations resume via each tab's stored --resume id inside SessionView.
  useEffect(() => {
    let cancelled = false;
    async function restoreWorkspace(): Promise<void> {
      try {
        const projectList = await window.agentCoordinator.projects.list();
        if (cancelled) return;
        setProjects(projectList);

        const entries = await Promise.all(
          projectList.map(
            async (project) => [project.id, await window.agentCoordinator.sessions.list(project.id)] as const,
          ),
        );
        if (cancelled) return;
        const byProject: Record<string, WorkSession[]> = {};
        for (const [projectId, list] of entries) byProject[projectId] = list;
        setSessionsByProject(byProject);

        const layout = await window.agentCoordinator.workspace.getLayout();
        if (cancelled) return;

        const allSessionsFlat = Object.values(byProject).flat();
        const knownIds = new Set([
          ...projectList.map((project) => `${REPO_SESSION_PREFIX}${project.id}`),
          ...allSessionsFlat.map((session) => session.id),
        ]);
        const validOpened = (layout?.openedSessions ?? []).filter((entry) => knownIds.has(entry.sessionId));

        const restored: Record<string, SessionLayout> = {};
        for (const entry of validOpened) {
          restored[entry.sessionId] = sanitizeSessionLayout(entry);
        }
        restoredLayoutsRef.current = restored;
        setSessionLayouts(restored);
        setOpenedSessionIds(validOpened.map((entry) => entry.sessionId));

        const restoredSelection =
          layout?.selectedSessionId && knownIds.has(layout.selectedSessionId) ? layout.selectedSessionId : null;
        setSelectedSessionId(restoredSelection);

        const ownerProjectId = restoredSelection
          ? allSessionsFlat.find((session) => session.id === restoredSelection)?.projectId
          : undefined;
        setSelectedProjectId(ownerProjectId ?? projectList[0]?.id ?? null);
      } catch (caught) {
        if (!cancelled) setError(String(caught));
      } finally {
        if (!cancelled) setRestoreComplete(true);
      }
    }
    void restoreWorkspace();
    return () => {
      cancelled = true;
    };
  }, []);

  // Track opened sessions so their SessionViews (and their agents) survive
  // switching to another session.
  useEffect(() => {
    if (!selectedSessionId) return;
    setOpenedSessionIds((current) => (current.includes(selectedSessionId) ? current : [...current, selectedSessionId]));
  }, [selectedSessionId]);

  // Persist the workspace layout whenever it changes (after restore).
  useEffect(() => {
    if (!restoreComplete) return;
    const openedSessions: PersistedSessionLayout[] = openedSessionIds.map((id) => ({
      sessionId: id,
      openedRoleTabs: sessionLayouts[id]?.openedRoleTabs ?? ["architect"],
      shellTabs: sessionLayouts[id]?.shellTabs ?? [],
      activeTab: sessionLayouts[id]?.activeTab ?? "architect",
    }));
    const layout: WorkspaceLayout = { openedSessions, selectedSessionId };
    void window.agentCoordinator.workspace.setLayout(layout);
  }, [restoreComplete, openedSessionIds, selectedSessionId, sessionLayouts]);

  const handleSessionLayoutChange = useCallback((sessionId: string, layout: SessionLayout): void => {
    setSessionLayouts((current) => {
      const previous = current[sessionId];
      if (previous && sameLayout(previous, layout)) {
        return current;
      }
      return { ...current, [sessionId]: layout };
    });
  }, []);

  // A session's first checkpoint appearing flips it from Architect-only to fully
  // enabled. Patch the cached record so the derived selectedSession re-renders.
  useEffect(() => {
    return window.agentCoordinator.sessions.onCheckpointDetected((e) => {
      setSessionsByProject((current) => {
        let changed = false;
        const next: Record<string, WorkSession[]> = {};
        for (const [projectId, sessions] of Object.entries(current)) {
          next[projectId] = sessions.map((session) => {
            if (session.id === e.sessionId && session.checkpointPath !== e.checkpointPath) {
              changed = true;
              return { ...session, checkpointPath: e.checkpointPath };
            }
            return session;
          });
        }
        return changed ? next : current;
      });
    });
  }, []);

  // While the selected session has no checkpoint, watch its worktree for one to
  // appear; stop the moment it does (or the session is deselected). Review
  // sessions never have a checkpoint of their own — and their reviewed branch may
  // itself CONTAIN checkpoint files — so they are never watched.
  useEffect(() => {
    if (!selectedSessionId || isRepoSessionId(selectedSessionId) || selectedSessionCheckpoint !== null) return;
    if (selectedSessionKind === "review" || selectedSessionKind === "pr-fix") return;
    void window.agentCoordinator.sessions.watchCheckpoint(selectedSessionId);
    return () => {
      void window.agentCoordinator.sessions.unwatchCheckpoint(selectedSessionId);
    };
  }, [selectedSessionId, selectedSessionCheckpoint, selectedSessionKind]);

  async function refreshProjects(): Promise<void> {
    try {
      const list = await window.agentCoordinator.projects.list();
      setProjects(list);
      setSelectedProjectId((current) => {
        if (current && list.some((project) => project.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function loadSessions(projectId: string): Promise<void> {
    try {
      const list = await window.agentCoordinator.sessions.list(projectId);
      setSessionsByProject((current) => ({ ...current, [projectId]: list }));
    } catch (caught) {
      setError(String(caught));
    }
  }

  function handleSelectSession(session: WorkSession): void {
    setSelectedSessionId(session.id);
  }

  // Open a project's synthetic repo-root workspace.
  function handleSelectRepo(projectId: string): void {
    setSelectedProjectId(projectId);
    setSelectedSessionId(`${REPO_SESSION_PREFIX}${projectId}`);
  }

  async function handleSessionCreated(projectId: string, session: WorkSession): Promise<void> {
    await loadSessions(projectId);
    setSelectedSessionId(session.id);
    setNewSessionProjectId(null);
  }

  async function handleProjectSaved(project: ProjectRecord): Promise<void> {
    try {
      await refreshProjects();
      setSelectedProjectId(project.id);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function handleRemoveSession(session: WorkSession): Promise<void> {
    setSessionToRemove(null);
    // Drop from UI state first so its SessionView unmounts and its agent PTYs
    // are killed before the worktree is removed on the main side.
    setOpenedSessionIds((current) => current.filter((id) => id !== session.id));
    setSessionsByProject((current) => {
      const list = current[session.projectId];
      if (!list) return current;
      return { ...current, [session.projectId]: list.filter((candidate) => candidate.id !== session.id) };
    });
    setSelectedSessionId((current) => (current === session.id ? null : current));
    try {
      await window.agentCoordinator.sessions.remove(session.id);
    } catch (caught) {
      setError(String(caught));
    }
  }

  return (
    <div className="app">
      <ProjectRail
        projects={projects}
        selectedProjectId={selectedProjectId}
        sessionsByProject={sessionsByProject}
        selectedSessionId={selectedSessionId}
        onSelectProject={setSelectedProjectId}
        onRequestCreateProject={() => setProjectModal({ mode: "create" })}
        onRequestEditProject={(project) => setProjectModal({ mode: "edit", project })}
        onProjectsChanged={() => void refreshProjects()}
        onExpandProject={(projectId) => void loadSessions(projectId)}
        onSelectSession={handleSelectSession}
        onSelectRepo={handleSelectRepo}
        onRequestCreateSession={(projectId) => setNewSessionProjectId(projectId)}
        onRequestRemoveSession={(session) => setSessionToRemove(session)}
      />
      <main className="main-area">
        {error && <p className="error-banner">{error}</p>}
        {openedSessions.map((session) => (
          <div key={session.id} className="session-view-host" hidden={session.id !== selectedSessionId}>
            <SessionView
              session={session}
              repoMode={isRepoSessionId(session.id)}
              initialLayout={restoredLayoutsRef.current[session.id]}
              onLayoutChange={handleSessionLayoutChange}
              autoPilotConfig={projects.find((project) => project.id === session.projectId)?.autoPilot}
              reviewConfig={projects.find((project) => project.id === session.projectId)?.review}
            />
          </div>
        ))}
        {!selectedSession && (
          <div className="workspace-empty">
            <p className="workspace-empty-title">No session selected</p>
            <p className="workspace-empty-hint">
              Pick a session from the sidebar, or create one with <span className="workspace-empty-plus">+</span> on a
              project.
            </p>
          </div>
        )}
      </main>
      {projectModal && (
        <ProjectModal
          mode={projectModal.mode}
          project={projectModal.mode === "edit" ? projectModal.project : undefined}
          onClose={() => setProjectModal(null)}
          onSaved={(project) => void handleProjectSaved(project)}
        />
      )}
      {newSessionProjectId && (
        <NewSessionDialog
          projectId={newSessionProjectId}
          onClose={() => setNewSessionProjectId(null)}
          onCreated={(session) => void handleSessionCreated(newSessionProjectId, session)}
        />
      )}
      {sessionToRemove && (
        <div className="modal-overlay" onClick={() => setSessionToRemove(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <p>
              Remove session <strong>{sessionToRemove.name}</strong>?
            </p>
            <p className="warning">
              This deletes its worktree (and any uncommitted changes) at{" "}
              <code>{sessionToRemove.worktreePath}</code>. The git branch{" "}
              <code>{sessionToRemove.branch}</code> is kept.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setSessionToRemove(null)}>
                Cancel
              </button>
              <button type="button" className="modal-confirm-danger" onClick={() => void handleRemoveSession(sessionToRemove)}>
                Delete session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
