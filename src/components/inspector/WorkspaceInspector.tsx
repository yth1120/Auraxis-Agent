import { errorText } from '../../../electron/errors';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, message } from 'antd';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
  TreeStructure as ApartmentOutlined,
} from '@/components/common/icons';
import { useInspectorStore, mapTodosToTasks } from '../../stores/useInspectorStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { backfillComposer } from '../../utils/backfillComposer';
import { collectQualityRuns, findLatestFailure, deriveNextSteps } from '../../utils/agentQuality';
import TaskChecklist from './TaskChecklist';
import ContextManifest from './ContextManifest';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { useT, type I18nKey } from '../../i18n';
import AgentTasksCard from './AgentTasksCard';
import SnapshotCard from './SnapshotCard';
import { collectFilePaths, collectContextGroups, collectDeliverables } from './WorkspaceInspectorData';
import {
  AgentInspectorHeader,
  AgentSummaryCard,
  DeliverablesCard,
  NextStepsCard,
  QualityGateCard,
  RollbackCard,
  SystemMessagesList,
} from './WorkspaceInspectorSections';
import {
  AGENT_STATUS_META,
  basename,
  latestAgentTodos,
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
  const agent = useStoreWithEqualityFn(useAgentStore, (s) => s.agents.find((a) => a.id === currentAgentId), shallow);
  const agents = useAgentStore((s) => s.agents);

  const statusMeta = agent
    ? (AGENT_STATUS_META[agent.status] ?? { labelKey: 'status.stopped' as I18nKey, cls: 'bg-[var(--color-text-faint)]' })
    : null;
  const statusLabel = statusMeta ? tPanel(statusMeta.labelKey) : null;

  const deliverables = useMemo(() => collectDeliverables(agent), [agent]);

  const elapsed = agent?.startTime ? Math.max(0, Math.floor((now - agent.startTime) / 1000)) : 0;
  const totalTokens = (agent?.totalInputTokens ?? 0) + (agent?.totalOutputTokens ?? 0);

  const qualityRuns = useMemo(() => (agent ? collectQualityRuns(agent.log ?? []) : []), [agent]);
  const latestFailure = useMemo(() => (agent ? findLatestFailure(agent.log ?? [], agent.error) : null), [agent]);
  const [fileTokens, setFileTokens] = useState<Record<string, number | null>>({});
  const filePaths = useMemo(() => collectFilePaths({ isCode, agent, messages }), [isCode, agent, messages]);
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

  const groups = useMemo(
    () => collectContextGroups({ isCode, agent, messages, t: tPanel }),
    [isCode, agent, messages, tPanel],
  );

  // System prompts only apply to the foreground chat inspector.
  const sysMessages = isCode ? [] : systemMessages;
  const hasContent = tasks.length > 0 || groups.some((g) => g.items.length > 0) || sysMessages.length > 0;

  const redoTask = (task: { title: string }) => {
    if (!agent) return;
    backfillComposer(
      `请重做计划步骤「${task.title}」：\n请重新执行该步骤，完成后更新计划状态，并运行 ReviewArtifact 验证。`,
      agent.id,
    );
  };

  if (!hasContent) {
    if (isCode && agents.length > 0) {
      return (
        <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
          <AgentTasksCard now={now} />
          <SnapshotCard projectRoot={projectRoot} now={now} />
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
        <SnapshotCard projectRoot={projectRoot} now={now} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
      {isCode && agent && (
        <AgentInspectorHeader
          agent={agent}
          statusMeta={statusMeta}
          statusLabel={statusLabel}
          elapsed={elapsed}
          totalTokens={totalTokens}
          onPauseResume={pauseResume}
          onStop={stopAgent}
        />
      )}

      {isCode && agents.length > 1 && agent && <AgentTasksCard now={now} />}

      {activeToolCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 mb-3 rounded-lg text-xs text-primary bg-primary-soft">
          <ExecutingIndicator size={14} />
          <span>
            {isCode ? tPanel('inspector.taskRunning') : tPanel('inspector.toolsRunning', { n: activeToolCount })}
          </span>
        </div>
      )}

      {isCode && agent && <AgentSummaryCard agent={agent} />}

      {isCode && agent && qualityRuns.length > 0 && (
        <QualityGateCard
          agent={agent}
          runs={qualityRuns}
          failure={latestFailure}
          lintFixing={lintFixing}
          onAutoFixLint={() => void autoFixLint()}
        />
      )}

      {isCode && agent && nextSteps.length > 0 && <NextStepsCard agent={agent} steps={nextSteps} />}

      <TaskChecklist tasks={tasks} onRedo={isCode && agent ? redoTask : undefined} />

      {tasks.length > 0 && groups.some((g) => g.items.length > 0) && (
        <div className="border-t border-[var(--color-border-dim)] my-3" />
      )}

      <ContextManifest groups={groups} fileTokens={fileTokens} maxFileTokens={maxFileTokens} />

      {isCode && agent && deliverables.length > 0 && <DeliverablesCard files={deliverables} onPreview={openPreview} />}

      {isCode && agent && (agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped') && (
        <RollbackCard onRollback={rollbackAgent} />
      )}

      <SnapshotCard projectRoot={projectRoot} now={now} />

      {sysMessages.length > 0 && <SystemMessagesList messages={sysMessages} />}

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

    </div>
  );
}
