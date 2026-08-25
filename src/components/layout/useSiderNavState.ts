import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import type { Session } from '../../stores/useSessionStore';
import type { Project } from '../../stores/useProjectStore';
import type { AgentInfo } from '../../types/agent';
import type { I18nKey } from '../../i18n';
import { useProjectStore } from '../../stores/useProjectStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { SiderDragState } from './SiderCodePanel';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function useSiderNavState({
  t,
  sessions,
  agents,
  settingsProjectPath,
  currentProjectId,
}: {
  t: Translate;
  sessions: Session[];
  agents: AgentInfo[];
  settingsProjectPath: string | null;
  currentProjectId: string | null;
}) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [showAllSessions, setShowAllSessions] = useState<Set<string>>(new Set());
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const dragStateRef = useRef<SiderDragState>(null);
  const [rootsModalProject, setRootsModalProject] = useState<Project | null>(null);
  const [rootsModalRoots, setRootsModalRoots] = useState<string[]>([]);
  const [rootsModalWritable, setRootsModalWritable] = useState<string[]>([]);

  useEffect(() => {
    const store = useProjectStore.getState();
    for (const session of sessions) if (session.projectRoot) store.ensureProject(session.projectRoot);
    for (const agent of agents) if (agent.projectRoot) store.ensureProject(agent.projectRoot);
    const active = settingsProjectPath ? store.ensureProject(settingsProjectPath) : null;
    if (active && store.currentProjectId !== active.id) store.selectProject(active.id);
  }, [sessions, agents, settingsProjectPath]);

  useEffect(() => {
    if (!currentProjectId) return;
    setExpandedProjects((prev) => {
      if (prev.has(currentProjectId)) return prev;
      const next = new Set(prev);
      next.add(currentProjectId);
      return next;
    });
  }, [currentProjectId]);

  const openRootsModal = (project: Project) => {
    const roots = project.roots.length > 0 ? [...project.roots] : [project.path];
    setRootsModalProject(project);
    setRootsModalRoots(roots);
    setRootsModalWritable(project.writableRoots.length > 0 ? [...project.writableRoots] : roots);
  };

  const addRootFromPicker = async () => {
    const result = await window.electronAPI?.project.selectDirectory();
    const dir = result?.ok ? result.data : null;
    if (dir && !rootsModalRoots.includes(dir)) {
      setRootsModalRoots((prev) => [...prev, dir]);
      setRootsModalWritable((prev) => [...prev, dir]);
    }
  };

  const saveRootsModal = () => {
    const project = rootsModalProject;
    if (!project) return;
    const store = useProjectStore.getState();
    for (const root of rootsModalRoots) if (!project.roots.includes(root)) store.addProjectRoot(project.id, root);
    for (const root of project.roots) if (!rootsModalRoots.includes(root)) store.removeProjectRoot(project.id, root);
    for (const root of rootsModalRoots) store.setRootWritable(project.id, root, rootsModalWritable.includes(root));
    setRootsModalProject(null);
    message.success(t('sidebar.projectRootsSaved'));
  };

  const toggleProjectExpanded = useCallback((id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleShowAllSessions = useCallback((id: string) => {
    setShowAllSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startSessionInProject = useCallback((path: string) => {
    useSettingsStore.getState().setProjectPath(path);
    useChatStore.getState().setCurrentProjectPath(path);
    useAppStore.getState().setSidebarMode('chat');
    useAppStore.getState().setActiveToolView('none');
    useSessionStore.getState().newSession();
    useChatStore.getState().clearMessages();
  }, []);

  const toggleProject = useCallback((key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleNewSession = useCallback(() => {
    useAppStore.getState().setSidebarMode('chat');
    useAppStore.getState().setActiveToolView('none');
    useSessionStore.getState().newSession();
    useChatStore.getState().clearMessages();
  }, []);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (renamingThreadId) return;
      useAppStore.getState().setSidebarMode('chat');
      useAppStore.getState().setActiveToolView('none');
      useChatStore.getState().switchSession(threadId);
    },
    [renamingThreadId],
  );

  const handleForkThread = useCallback(
    (event: React.MouseEvent, threadId: string) => {
      event.stopPropagation();
      useAppStore.getState().setSidebarMode('chat');
      useAppStore.getState().setActiveToolView('none');
      const newId = useSessionStore.getState().forkSession(threadId);
      if (!newId) {
        message.error(t('sidebar.forkFailed'));
        return;
      }
      useChatStore.getState().switchSession(newId);
      message.success(t('sidebar.forked'));
    },
    [t],
  );

  const handleArchiveThread = useCallback(
    (event: React.MouseEvent, threadId: string) => {
      event.stopPropagation();
      const wasCurrent = threadId === currentSessionId;
      useSessionStore.getState().toggleArchive(threadId);
      if (wasCurrent) {
        const state = useSessionStore.getState();
        const archived = state.sessions.some((session) => session.id === threadId && session.archived);
        if (archived) {
          useChatStore.getState().clearMessages();
          useSessionStore.getState().newSession();
        }
      }
    },
    [currentSessionId],
  );

  const handleDeleteThread = useCallback(
    (event: React.MouseEvent, threadId: string) => {
      event.stopPropagation();
      useSessionStore.getState().deleteSession(threadId);
      if (threadId === currentSessionId) {
        useChatStore.getState().clearMessages();
        useSessionStore.getState().newSession();
      }
    },
    [currentSessionId],
  );

  const handleStartRename = useCallback((event: React.MouseEvent, threadId: string, currentTitle: string) => {
    event.stopPropagation();
    setRenamingThreadId(threadId);
    setRenameValue(currentTitle);
  }, []);

  const handleFinishRename = useCallback(() => {
    if (renamingThreadId && renameValue.trim()) {
      useSessionStore.getState().renameSession(renamingThreadId, renameValue.trim());
    }
    setRenamingThreadId(null);
    setRenameValue('');
  }, [renamingThreadId, renameValue]);

  const handleMoveSession = useCallback((id: string, path: string) => {
    useSessionStore.getState().moveSessionToProject(id, path);
  }, []);

  const handleSessionDragStart = (event: React.DragEvent, session: Session) => {
    event.stopPropagation();
    dragStateRef.current = { kind: 'session', id: session.id, root: session.projectRoot || '' };
  };
  const handleSessionDragOver = (event: React.DragEvent, session: Session) => {
    if (dragStateRef.current?.kind !== 'session') return;
    event.preventDefault();
    setDragOverKey(session.id);
  };
  const handleSessionDrop = (event: React.DragEvent, session: Session) => {
    event.preventDefault();
    const dragged = dragStateRef.current;
    if (dragged?.kind === 'session' && dragged.id !== session.id) {
      const targetRoot = session.projectRoot || '';
      if (dragged.root !== targetRoot) useSessionStore.getState().moveSessionToProject(dragged.id, targetRoot);
      useProjectStore.getState().reorderSession(targetRoot, dragged.id, session.id);
    }
    dragStateRef.current = null;
    setDragOverKey(null);
  };
  const handleSessionDragEnd = () => {
    dragStateRef.current = null;
    setDragOverKey(null);
  };

  return {
    currentSessionId,
    renamingThreadId,
    setRenamingThreadId,
    renameValue,
    setRenameValue,
    renamingProjectId,
    renameProjectValue,
    setRenamingProjectId,
    setRenameProjectValue,
    expandedProjects,
    collapsedProjects,
    showAllSessions,
    dragOverKey,
    setDragOverKey,
    dragStateRef,
    rootsModalProject,
    rootsModalRoots,
    rootsModalWritable,
    setRootsModalProject,
    setRootsModalRoots,
    setRootsModalWritable,
    openRootsModal,
    addRootFromPicker,
    saveRootsModal,
    toggleProjectExpanded,
    toggleShowAllSessions,
    startSessionInProject,
    toggleProject,
    handleNewSession,
    handleSelectThread,
    handleForkThread,
    handleArchiveThread,
    handleDeleteThread,
    handleStartRename,
    handleFinishRename,
    handleMoveSession,
    handleSessionDragStart,
    handleSessionDragOver,
    handleSessionDrop,
    handleSessionDragEnd,
  };
}
