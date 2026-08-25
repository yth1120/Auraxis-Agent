import { errorText } from '../../../electron/errors';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input, Modal, Dropdown, message } from 'antd';
import clsx from 'clsx';
import { shallow } from 'zustand/shallow';
import {
  TreeStructure as ApartmentOutlined,
  Check,
  X,
  FileText,
  MagnifyingGlass,
  Terminal,
  Globe,
  MoreHorizontal,
} from '@/components/common/icons';
import { useInspectorStore, mapTodosToTasks } from '../../stores/useInspectorStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { backfillComposer } from '../../utils/backfillComposer';
import { collectQualityRuns, findLatestFailure, deriveNextSteps } from '../../utils/agentQuality';
import TaskChecklist from './TaskChecklist';
import ContextManifest, { type ContextGroup } from './ContextManifest';
import ExecutingIndicator from '../common/ExecutingIndicator';
import type { NamedSnapshot } from '../../types/electron-api';
import { useT, type I18nKey } from '../../i18n';
import DeliverablesRow from '../common/DeliverablesRow';
import {
  agentToolInvocations,
  basename,
  fmtRelative,
  latestAgentTodos,
  latestChatToolInvocations,
  type ToolInvocation,
} from './WorkspaceInspectorUtils';

export default function WorkspaceInspector() {
  const tPanel = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const isCode = sidebarMode !== 'chat';

  // Foreground chat inspector data (chat mode).
  const inspectorTasks = useInspectorStore((s) => s.tasks);
  const systemMessages = useInspectorStore((s) => s.systemMessages);
  const inspectorActiveTools = useInspectorStore((s) => s.activeToolCount);
  const messages = useChatStore((s) => s.messages);

  // Selected-agent data (code mode).
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agent = useAgentStore((s) => s.agents.find((a) => a.id === currentAgentId), shallow);
  const agents = useAgentStore((s) => s.agents);

  const STATUS_META: Record<string, { labelKey: I18nKey; cls: string }> = {
    running: { labelKey: 'status.running', cls: 'bg-primary' },
    queued: { labelKey: 'status.queued', cls: 'bg-[var(--color-text-faint)]' },
    paused: { labelKey: 'status.paused', cls: 'bg-warning' },
    completed: { labelKey: 'status.completed', cls: 'bg-success' },
    error: { labelKey: 'status.error', cls: 'bg-danger' },
    stopped: { labelKey: 'status.stopped', cls: 'bg-[var(--color-text-faint)]' },
  };
  const statusMeta = agent
    ? (STATUS_META[agent.status] ?? { labelKey: 'status.stopped' as I18nKey, cls: 'bg-[var(--color-text-faint)]' })
    : null;
  const statusLabel = statusMeta ? tPanel(statusMeta.labelKey) : null;

  const deliverables = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of agent?.log ?? []) {
      if (e.type === 'tool_start' || e.type === 'tool_end') {
        if (e.toolName === 'Write' || e.toolName === 'Edit' || e.toolName === 'NotebookEdit') {
          const p = e.input?.file_path;
          if (typeof p === 'string' && p.trim() && !seen.has(p)) {
            seen.add(p);
            out.push(p);
          }
        }
      }
    }
    return out;
  }, [agent]);

  const elapsed = agent?.startTime ? Math.max(0, Math.floor((now - agent.startTime) / 1000)) : 0;
  const fmtElapsed = (s: number) =>
    s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  const totalTokens = (agent?.totalInputTokens ?? 0) + (agent?.totalOutputTokens ?? 0);
  const fmtTokens = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `${n}`);

  const qualityRuns = useMemo(() => (agent ? collectQualityRuns(agent.log ?? []) : []), [agent]);
  const latestFailure = useMemo(() => (agent ? findLatestFailure(agent.log ?? [], agent.error) : null), [agent]);
  const [fileTokens, setFileTokens] = useState<Record<string, number | null>>({});
  const filePaths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tc of isCode ? agentToolInvocations(agent) : latestChatToolInvocations(messages)) {
      const fp = (tc.input as Record<string, unknown>).file_path;
      if (typeof fp === 'string' && fp.trim() && !seen.has(fp)) {
        seen.add(fp);
        out.push(fp);
      }
    }
    return out;
  }, [isCode, agent, messages]);
  useEffect(() => {
    const api = window.electronAPI?.file;
    const projectRoot = agent?.projectRoot || useSettingsStore.getState().projectPath;
    if (!api?.estimateTokens || !projectRoot || filePaths.length === 0) {
      setFileTokens({});
      return;
    }
    let cancelled = false;
    api
      .estimateTokens(filePaths.slice(0, 15), projectRoot)
      .then((r) => {
        if (cancelled || !r.ok || !r.data) return;
        const map: Record<string, number | null> = {};
        for (const f of r.data) map[f.path] = f.tokens;
        setFileTokens(map);
      })
      .catch(() => {
        if (!cancelled) setFileTokens({});
      });
    return () => {
      cancelled = true;
    };
  }, [filePaths, agent?.projectRoot]);
  const maxFileTokens = useMemo(() => {
    let max = 1;
    for (const v of Object.values(fileTokens)) {
      if (typeof v === 'number' && v > max) max = v;
    }
    return max;
  }, [fileTokens]);
  const [diffCount, setDiffCount] = useState(0);
  const [diffRefresh, setDiffRefresh] = useState(0);
  const settled = agent && (agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped');
  useEffect(() => {
    if (!agent || !settled) {
      setDiffCount(0);
      return;
    }
    const projectRoot = useSettingsStore.getState().projectPath;
    if (!projectRoot) {
      setDiffCount(0);
      return;
    }
    let cancelled = false;
    window.electronAPI?.undo
      ?.getSessionDiffs(agent.id, projectRoot)
      .then((r) => {
        if (!cancelled) setDiffCount(r.ok && r.data ? r.data.length : 0);
      })
      .catch(() => {
        if (!cancelled) setDiffCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, settled, diffRefresh]);

  const [lintFixing, setLintFixing] = useState(false);
  const autoFixLint = useCallback(async () => {
    if (!agent) return;
    const root = agent.projectRoot || useSettingsStore.getState().projectPath;
    if (!root) {
      message.warning(tPanel('lint.workspaceMissing'));
      return;
    }
    setLintFixing(true);
    try {
      const r = await window.electronAPI?.lint?.fix(root);
      if (!r?.ok) throw new Error(r?.error || tPanel('lint.failed'));
      if (r.data?.exitCode === 0) {
        message.success(tPanel('lint.done'));
      } else {
        const line = (r.data?.output || '').split('\n').find((l) => l.trim()) || '';
        message.warning(
          tPanel('lint.remaining', { n: r.data?.exitCode ?? '?', detail: line ? line.slice(0, 120) : '' }),
        );
      }
      useAppStore.getState().incrementFileTreeVersion();
      setDiffRefresh((v) => v + 1);
    } catch (e: unknown) {
      message.error(errorText(e) || tPanel('lint.failed'));
    } finally {
      setLintFixing(false);
    }
  }, [agent, tPanel]);

  const pauseResume = useCallback(async () => {
    if (!agent) return;
    if (agent.status === 'running') await useAgentStore.getState().pauseAgent(agent.id);
    else if (agent.status === 'paused') await useAgentStore.getState().resumeAgent(agent.id);
  }, [agent]);

  const stopAgent = useCallback(() => {
    if (agent) void useAgentStore.getState().stopAgent(agent.id);
  }, [agent]);

  const rollbackAgent = useCallback(async () => {
    if (!agent) return;
    const root = agent.projectRoot || useSettingsStore.getState().projectPath;
    if (!root) {
      message.warning(tPanel('inspector.workspaceReleased'));
      return;
    }
    Modal.confirm({
      title: tPanel('inspector.rollbackTaskTitle'),
      content: tPanel('inspector.rollbackTaskBody'),
      okText: tPanel('rollback.ok'),
      okButtonProps: { danger: true },
      cancelText: tPanel('rollback.cancel'),
      onOk: async () => {
        try {
          const r = await window.electronAPI?.undo?.revertSessions([agent.id], root);
          if (!r?.ok) throw new Error(r?.error || tPanel('rollback.failed'));
          message.success(tPanel('rollback.success', { n: r.data?.reverted ?? 0 }));
          useAppStore.getState().incrementFileTreeVersion();
        } catch (e: unknown) {
          message.error(errorText(e) || tPanel('rollback.failed'));
        }
      },
    });
  }, [agent, tPanel]);

  // ── Named snapshots (project-scoped, chat + code modes) ──
  const projectRoot = useSettingsStore((s) => s.projectPath);
  const [snapshots, setSnapshots] = useState<NamedSnapshot[]>([]);
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotBusy, setSnapshotBusy] = useState(false);

  const loadSnapshots = useCallback(async () => {
    if (!projectRoot) {
      setSnapshots([]);
      return;
    }
    const r = await window.electronAPI?.snapshot?.list(projectRoot);
    if (r?.ok && r.data) setSnapshots(r.data);
  }, [projectRoot]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const createSnapshot = useCallback(async () => {
    if (!projectRoot) return;
    const name = snapshotName.trim();
    if (!name) {
      message.warning(tPanel('snapshot.nameRequired'));
      return;
    }
    setSnapshotBusy(true);
    try {
      const r = await window.electronAPI?.snapshot?.create(projectRoot, name);
      if (!r?.ok) throw new Error(r?.error || tPanel('snapshot.createFailed'));
      message.success(tPanel('snapshot.created', { name: r.data?.name ?? '', n: r.data?.files.length ?? 0 }));
      setSnapshotModalOpen(false);
      setSnapshotName('');
      void loadSnapshots();
    } catch (e: unknown) {
      message.error(errorText(e) || tPanel('snapshot.createFailed'));
    } finally {
      setSnapshotBusy(false);
    }
  }, [projectRoot, snapshotName, loadSnapshots, tPanel]);

  const restoreSnapshot = useCallback(
    (snap: NamedSnapshot) => {
      if (!projectRoot) return;
      Modal.confirm({
        title: tPanel('snapshot.restoreTitle', { name: snap.name }),
        content: tPanel('snapshot.restoreBody', { n: snap.files.length }),
        okText: tPanel('snapshot.restore'),
        okButtonProps: { danger: true },
        cancelText: tPanel('snapshot.cancel'),
        onOk: async () => {
          try {
            const r = await window.electronAPI?.snapshot?.restore(snap.id, projectRoot);
            if (!r?.ok) throw new Error(r?.error || tPanel('snapshot.restoreFailed'));
            message.success(tPanel('snapshot.restoreOk', { n: r.data?.restored ?? 0 }));
            useAppStore.getState().incrementFileTreeVersion();
          } catch (e: unknown) {
            message.error(errorText(e) || tPanel('snapshot.restoreFailed'));
          }
        },
      });
    },
    [projectRoot, tPanel],
  );

  const deleteSnapshot = useCallback(
    (snap: NamedSnapshot) => {
      if (!projectRoot) return;
      Modal.confirm({
        title: tPanel('snapshot.deleteTitle', { name: snap.name }),
        content: tPanel('snapshot.deleteBody'),
        okText: tPanel('snapshot.delete'),
        okButtonProps: { danger: true },
        cancelText: tPanel('snapshot.cancel'),
        onOk: async () => {
          try {
            const r = await window.electronAPI?.snapshot?.delete(snap.id, projectRoot);
            if (!r?.ok) throw new Error(r?.error || tPanel('snapshot.deleteFailed'));
            message.success(tPanel('snapshot.deleted'));
            void loadSnapshots();
          } catch (e: unknown) {
            message.error(errorText(e) || tPanel('snapshot.deleteFailed'));
          }
        },
      });
    },
    [projectRoot, loadSnapshots, tPanel],
  );

  const [preview, setPreview] = useState<{ path: string; mime: string; base64: string } | null>(null);
  const openPreview = useCallback(
    async (filePath: string) => {
      const api = window.electronAPI?.file;
      const projectRoot = useSettingsStore.getState().projectPath;
      if (!api?.readPreview) return;
      try {
        const r = await api.readPreview(filePath, projectRoot || undefined);
        if (!r.ok || !r.data) {
          if (r.error) message.error(r.error);
          return;
        }
        setPreview(r.data);
      } catch {
        message.error(tPanel('preview.failed'));
      }
    },
    [tPanel],
  );

  // Tasks: derive from the selected agent's todos in code mode, else the foreground chat.
  const tasks = useMemo(() => {
    if (!isCode) return inspectorTasks;
    const todos = latestAgentTodos(agent);
    return todos ? mapTodosToTasks(todos) : [];
  }, [isCode, agent, inspectorTasks]);

  const nextSteps = useMemo(
    () =>
      agent
        ? deriveNextSteps({
            latestFailure,
            pendingTodos: tasks.filter((t) => t.status !== 'done').length,
            diffCount,
            hasQualityRuns: qualityRuns.length > 0,
          })
        : [],
    [agent, latestFailure, tasks, diffCount, qualityRuns],
  );

  const activeToolCount = isCode ? (agent?.status === 'running' ? 1 : 0) : inspectorActiveTools;

  const groups = useMemo<ContextGroup[]>(() => {
    const toolCalls: ToolInvocation[] = isCode ? agentToolInvocations(agent) : latestChatToolInvocations(messages);
    const files = new Set<string>();
    const searches: string[] = [];
    const commands: string[] = [];
    const web: string[] = [];

    for (const tc of toolCalls) {
      const input = tc.input as Record<string, unknown>;
      switch (tc.toolName) {
        case 'Read':
        case 'Write':
        case 'Edit': {
          const fp = input.file_path as string | undefined;
          if (fp) files.add(fp);
          break;
        }
        case 'Grep':
        case 'Glob': {
          const p = input.pattern as string | undefined;
          if (p) searches.push(p);
          break;
        }
        case 'Bash': {
          const c = (input.command as string | undefined)?.replace(/\s+/g, ' ').trim();
          if (c) commands.push(c.length > 60 ? c.slice(0, 60) + '…' : c);
          break;
        }
        case 'WebFetch': {
          const u = input.url as string | undefined;
          if (u) web.push(u);
          break;
        }
        case 'WebSearch': {
          const q = input.query as string | undefined;
          if (q) web.push(q);
          break;
        }
        default:
          break;
      }
    }

    return [
      { key: 'files', icon: <FileText />, label: tPanel('ctx.group.files'), items: [...files] },
      { key: 'search', icon: <MagnifyingGlass />, label: tPanel('ctx.group.search'), items: searches },
      { key: 'cmd', icon: <Terminal />, label: tPanel('ctx.group.cmd'), items: commands },
      { key: 'web', icon: <Globe />, label: tPanel('ctx.group.web'), items: web },
    ];
  }, [isCode, agent, messages, tPanel]);

  // System prompts only apply to the foreground chat inspector.
  const sysMessages = isCode ? [] : systemMessages;
  const hasContent = tasks.length > 0 || groups.some((g) => g.items.length > 0) || sysMessages.length > 0;

  const selectAgent = (id: string) => {
    useAgentStore.getState().setCurrentAgent(id);
  };

  const redoTask = (task: { title: string }) => {
    if (!agent) return;
    backfillComposer(
      `请重做计划步骤「${task.title}」：\n请重新执行该步骤，完成后更新计划状态，并运行 ReviewArtifact 验证。`,
      agent.id,
    );
  };

  const renderAllTasksCard = () => (
    <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
      <header className="flex items-center justify-between mb-1.5">
        <span className="text-2xs font-semibold text-text-muted tracking-wide">{tPanel('inspector.allTasks')}</span>
        <span className="text-2xs text-text-muted">
          {tPanel('inspector.runningCount', { n: agents.filter((a) => a.status === 'running').length })}
          {agents.filter((a) => a.status === 'queued').length > 0 &&
            ` · ${tPanel('inspector.queuedCount', { n: agents.filter((a) => a.status === 'queued').length })}`}
        </span>
      </header>
      <ul className="list-none m-0 p-0 flex flex-col gap-[2px]">
        {agents.map((a) => {
          const meta = STATUS_META[a.status] ?? {
            labelKey: 'status.stopped' as I18nKey,
            cls: 'bg-[var(--color-text-faint)]',
          };
          const active = a.id === currentAgentId;
          const busy = a.status === 'running' || a.status === 'paused' || a.status === 'queued';
          return (
            <li
              key={a.id}
              className={clsx(
                'flex items-center gap-2 px-2 py-[6px] rounded-md cursor-pointer hover:bg-[var(--color-hover)]',
                active && 'bg-primary-soft',
              )}
              onClick={() => selectAgent(a.id)}
            >
              <span className={clsx('shrink-0 w-1.5 h-1.5 rounded-full', meta.cls)} />
              <span
                className={clsx(
                  'flex-1 min-w-0 truncate text-xs',
                  active ? 'font-medium text-text-primary' : 'text-text-secondary',
                )}
              >
                {a.description || a.name}
              </span>
              <span className="shrink-0 text-2xs text-text-muted tabular-nums">
                {a.status === 'running'
                  ? fmtElapsed(Math.max(0, Math.floor((now - (a.startTime || now)) / 1000)))
                  : tPanel(meta.labelKey)}
              </span>
              {busy && (
                <span className="shrink-0 flex items-center gap-0.5">
                  {a.status === 'running' && (
                    <button
                      type="button"
                      className="text-2xs text-text-muted px-1 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void useAgentStore.getState().pauseAgent(a.id);
                      }}
                    >
                      {tPanel('inspector.pause')}
                    </button>
                  )}
                  {a.status === 'paused' && (
                    <button
                      type="button"
                      className="text-2xs text-text-muted px-1 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        void useAgentStore.getState().resumeAgent(a.id);
                      }}
                    >
                      {tPanel('inspector.resume')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-2xs text-text-muted px-1 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                    onClick={(e) => {
                      e.stopPropagation();
                      void useAgentStore.getState().stopAgent(a.id);
                    }}
                  >
                    {tPanel('inspector.stop')}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );

  const renderSnapshotCard = () =>
    projectRoot ? (
      <section className="px-3.5 py-2.5 mt-3 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
        <header className="flex items-center justify-between mb-1.5">
          <span className="text-2xs font-semibold text-text-muted tracking-wide">{tPanel('snapshot.cardTitle')}</span>
          <button
            type="button"
            className="h-6 px-2.5 rounded-full text-2xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-primary-strong)]"
            onClick={() => setSnapshotModalOpen(true)}
          >
            {tPanel('snapshot.new')}
          </button>
        </header>
        {snapshots.length === 0 ? (
          <p className="text-2xs text-text-muted leading-[1.5]">{tPanel('snapshot.emptyHint')}</p>
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col gap-1">
            {snapshots.slice(0, 8).map((s) => (
              <li key={s.id} className="flex items-center gap-2 rounded-md bg-[var(--color-bg-inset)] px-2 py-[5px]">
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-xs font-medium text-text-primary">{s.name}</span>
                  <span className="block text-2xs text-text-muted tabular-nums">
                    {fmtRelative(s.createdAt, now)} · {tPanel('snapshot.fileCount', { n: s.files.length })}
                  </span>
                </span>
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{
                    items: [
                      { key: 'restore', label: tPanel('snapshot.restore'), onClick: () => restoreSnapshot(s) },
                      {
                        key: 'delete',
                        label: tPanel('snapshot.delete'),
                        danger: true,
                        onClick: () => deleteSnapshot(s),
                      },
                    ],
                  }}
                >
                  <button
                    type="button"
                    className="shrink-0 flex items-center justify-center w-6 h-6 rounded-md text-text-muted cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                    aria-label={tPanel('snapshot.actions')}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </Dropdown>
              </li>
            ))}
          </ul>
        )}
      </section>
    ) : null;

  if (!hasContent) {
    if (isCode && agents.length > 0) {
      return (
        <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
          {renderAllTasksCard()}
          {renderSnapshotCard()}
        </div>
      );
    }
    return (
      <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
        <div className="bg-[var(--color-bg-secondary)] rounded-xl p-6 flex flex-col items-center text-center gap-2">
          <ApartmentOutlined className="text-2xl text-[var(--color-text-faint)]" />
          <p className="text-sm font-semibold text-[var(--color-text-secondary)] m-0">
            {tPanel('inspector.emptyTitle')}
          </p>
          <p className="text-2xs text-[var(--color-text-muted)] m-0 leading-relaxed">
            {isCode
              ? sidebarMode === 'work'
                ? tPanel('inspector.emptyWork')
                : tPanel('inspector.emptyCode')
              : tPanel('inspector.emptyChat')}
          </p>
        </div>
        {renderSnapshotCard()}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
      {isCode && agent && (
        <div className="sticky top-0 z-10 -mx-3 px-3 pt-2 pb-2.5 mb-3 bg-[var(--color-bg-primary)] border-b border-[var(--color-border-dim)]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 text-2xs px-2 py-[2px] rounded-full bg-[var(--color-bg-inset)] text-text-secondary shrink-0">
              <span className={clsx('w-1.5 h-1.5 rounded-full', statusMeta?.cls)} />
              {statusLabel}
            </span>
            <span className="flex-1 min-w-0 truncate text-xs font-medium text-text-primary">
              {agent.description || agent.name}
            </span>
            <span className="shrink-0 text-2xs text-text-muted tabular-nums">{fmtElapsed(elapsed)}</span>
            {(agent.status === 'running' || agent.status === 'paused') && (
              <span className="shrink-0 flex items-center gap-0.5">
                <button
                  type="button"
                  className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                  onClick={pauseResume}
                >
                  {agent.status === 'running' ? tPanel('inspector.pause') : tPanel('inspector.resume')}
                </button>
                <button
                  type="button"
                  className="text-2xs text-text-muted px-1.5 py-[2px] rounded-md cursor-pointer hover:bg-[var(--color-hover)] hover:text-text-secondary"
                  onClick={stopAgent}
                >
                  {tPanel('inspector.stop')}
                </button>
              </span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center h-5 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted">
              {tPanel('inspector.rounds', { n: agent.iteration ?? 0 })}
            </span>
            <span className="inline-flex items-center h-5 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted">
              {tPanel('inspector.tools', { n: agent.toolCallCount ?? 0 })}
            </span>
            <span className="inline-flex items-center h-5 px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted tabular-nums">
              {fmtTokens(totalTokens)} tokens
            </span>
            {agent.goal && (
              <span
                className="inline-flex items-center h-5 max-w-[220px] px-2 rounded-full bg-[var(--color-bg-inset)] text-2xs text-text-muted truncate"
                title={tPanel('inspector.goalTip', { text: agent.goal.text, n: agent.goal.maxRounds })}
              >
                {tPanel('inspector.goal', { text: agent.goal.text })}
              </span>
            )}
          </div>
        </div>
      )}

      {isCode && agents.length > 1 && agent && renderAllTasksCard()}

      {activeToolCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 mb-3 rounded-lg text-xs text-primary bg-primary-soft">
          <ExecutingIndicator size={14} />
          <span>
            {isCode ? tPanel('inspector.taskRunning') : tPanel('inspector.toolsRunning', { n: activeToolCount })}
          </span>
        </div>
      )}

      {isCode && agent && (
        <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
          <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">
            {tPanel('inspector.taskSummary')}
          </header>
          <div className="text-xs text-text-secondary leading-[1.5] line-clamp-3">
            {agent.description || agent.name}
          </div>
          {(agent.result || agent.error) && (
            <div className="mt-1.5 text-xs text-text-secondary leading-[1.5] line-clamp-3">
              {agent.result || agent.error}
            </div>
          )}
        </section>
      )}

      {isCode && agent && qualityRuns.length > 0 && (
        <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
          <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">
            {tPanel('inspector.qualityGate')}
          </header>
          {qualityRuns.every((r) => r.passed) ? (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Check size={14} className="text-[var(--color-success)] shrink-0" />
              {tPanel('inspector.qualityAllPassed', { n: qualityRuns.length })}
            </div>
          ) : (
            <ul className="list-none m-0 p-0 flex flex-col gap-1">
              {qualityRuns.map((r, idx) => (
                <li key={`${r.checkType}-${idx}`} className="rounded-md bg-[var(--color-bg-inset)] px-2 py-[5px]">
                  <div className="flex items-center gap-2 min-w-0">
                    {r.passed ? (
                      <Check size={14} className="text-[var(--color-success)] shrink-0" />
                    ) : (
                      <X size={14} className="text-danger shrink-0" />
                    )}
                    <span className="text-xs font-medium text-text-primary shrink-0">
                      {tPanel('inspector.checkLabel', { type: r.checkType })}
                    </span>
                    {r.command && (
                      <code className="flex-1 min-w-0 truncate text-2xs text-text-muted font-mono">{r.command}</code>
                    )}
                    <span className={`shrink-0 text-2xs ${r.passed ? 'text-[var(--color-success)]' : 'text-danger'}`}>
                      {r.passed ? tPanel('inspector.checkPassed') : tPanel('inspector.checkFailed')}
                    </span>
                  </div>
                  {!r.passed && (r.error || r.output) && (
                    <pre className="mt-1 mb-0 text-2xs text-text-muted font-mono leading-[1.5] whitespace-pre-wrap line-clamp-3 overflow-hidden">
                      {(r.error || r.output || '').slice(0, 800)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
          {latestFailure && (
            <button
              type="button"
              className="mt-2.5 h-7 px-3 rounded-full text-xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-primary-strong)]"
              onClick={() =>
                backfillComposer(
                  `请修复当前任务的问题：\n\n【${latestFailure.title}】\n${latestFailure.detail.slice(0, 1200)}\n\n请先读取相关文件定位原因，修复后重新运行验证。`,
                  agent.id,
                )
              }
              title={tPanel('inspector.fixButtonTip')}
            >
              {tPanel('inspector.fixButton')}
            </button>
          )}
          {latestFailure && /^lint\b/i.test(latestFailure.title) && (
            <button
              type="button"
              className="ml-2 mt-2.5 h-7 px-3 rounded-full text-xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 enabled:hover:bg-[var(--color-primary-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void autoFixLint()}
              disabled={lintFixing}
              title={tPanel('inspector.autoFixLintTip')}
            >
              {lintFixing ? tPanel('inspector.fixingLint') : tPanel('inspector.autoFixLint')}
            </button>
          )}
        </section>
      )}

      {isCode && agent && nextSteps.length > 0 && (
        <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
          <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">
            {tPanel('inspector.nextSteps')}
          </header>
          <div className="flex flex-col gap-1.5">
            {nextSteps.map((step) => (
              <button
                key={step.label}
                type="button"
                className="flex items-center gap-2 px-3 py-[7px] rounded-lg bg-[var(--color-bg-inset)] text-left text-xs text-text-secondary border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)] hover:text-text-primary"
                onClick={() => {
                  if (step.kind === 'view' && step.view === 'diff') {
                    useAppStore.getState().setRightPanelView('review');
                    if (!useAppStore.getState().showRightPanel) useAppStore.getState().toggleRightPanel();
                  } else if (step.prompt) {
                    backfillComposer(step.prompt, agent.id);
                  }
                }}
              >
                <span className="shrink-0 w-[5px] h-[5px] rounded-full bg-[var(--color-primary)] opacity-70" />
                <span className="flex-1 min-w-0">{step.label}</span>
                <span className="shrink-0 text-2xs text-text-faint">
                  {step.kind === 'view' ? tPanel('inspector.view') : tPanel('inspector.continue')}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <TaskChecklist tasks={tasks} onRedo={isCode && agent ? redoTask : undefined} />

      {tasks.length > 0 && groups.some((g) => g.items.length > 0) && (
        <div className="border-t border-[var(--color-border-dim)] my-3" />
      )}

      <ContextManifest groups={groups} fileTokens={fileTokens} maxFileTokens={maxFileTokens} />

      {isCode && agent && deliverables.length > 0 && (
        <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
          <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">
            {tPanel('inspector.deliverables')}
          </header>
          <DeliverablesRow files={deliverables} onPreview={openPreview} />
        </section>
      )}

      {isCode && agent && (agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped') && (
        <section className="px-3.5 py-2.5 mb-2.5 rounded-xl bg-[var(--color-bg-secondary)]">
          <header className="text-2xs font-semibold text-text-muted tracking-wide mb-1.5">
            {tPanel('inspector.rollback')}
          </header>
          <p className="text-2xs text-text-muted leading-[1.5] mb-2">{tPanel('inspector.rollbackBody')}</p>
          <button
            type="button"
            className="h-7 px-3 rounded-full text-xs font-medium text-[var(--color-primary)] bg-primary-soft border-none cursor-pointer transition-colors duration-150 hover:bg-[var(--color-primary-strong)]"
            onClick={rollbackAgent}
          >
            {tPanel('rollback.label')}
          </button>
        </section>
      )}

      {renderSnapshotCard()}

      {sysMessages.length > 0 && (
        <section className="px-0.5 pt-[10px] border-t border-[var(--color-border-dim)] mt-1">
          <header className="text-2xs font-semibold text-muted tracking-wide mb-[6px]">
            {tPanel('inspector.systemPrompt')}
          </header>
          <ul className="list-none m-0 p-0 flex flex-col gap-1">
            {sysMessages.slice(-8).map((m) => (
              <li
                key={m.id}
                className={clsx(
                  'text-xs leading-[1.5] px-2 py-[5px] rounded-md border border-transparent bg-dim text-secondary break-words',
                  m.level === 'info' && 'bg-primary-soft border-primary',
                  m.level === 'warning' && 'bg-warning-soft border-warning',
                  m.level === 'error' && 'bg-danger-soft border-danger text-text-secondary',
                )}
              >
                {m.content}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Modal
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={null}
        width={720}
        transitionName=""
        maskTransitionName=""
        title={preview ? basename(preview.path) : ''}
      >
        {preview?.mime.startsWith('image/') ? (
          <img
            src={`data:${preview.mime};base64,${preview.base64}`}
            alt={basename(preview.path)}
            className="block max-w-full max-h-[70vh] mx-auto"
          />
        ) : preview?.mime === 'application/pdf' ? (
          <iframe
            src={`data:application/pdf;base64,${preview.base64}`}
            title={basename(preview.path)}
            className="w-full h-[70vh] border-0"
          />
        ) : null}
      </Modal>

      <Modal
        open={snapshotModalOpen}
        title={tPanel('snapshot.modalTitle')}
        okText={tPanel('snapshot.create')}
        cancelText={tPanel('snapshot.cancel')}
        confirmLoading={snapshotBusy}
        width={420}
        transitionName=""
        maskTransitionName=""
        onOk={() => void createSnapshot()}
        onCancel={() => {
          setSnapshotModalOpen(false);
          setSnapshotName('');
        }}
      >
        <p className="text-xs text-text-muted leading-[1.6] mb-3">{tPanel('snapshot.modalBody')}</p>
        <Input
          autoFocus
          value={snapshotName}
          onChange={(e) => setSnapshotName(e.target.value)}
          onPressEnter={() => void createSnapshot()}
          placeholder={tPanel('snapshot.placeholder')}
          maxLength={60}
        />
      </Modal>
    </div>
  );
}
