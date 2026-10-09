import { errorText } from '../../../electron/errors';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, message } from 'antd';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { TreeStructure as ApartmentOutlined } from '@/components/common/icons';
import { useInspectorStore, mapTodosToTasks } from '../../stores/useInspectorStore';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useAgentStore } from '../../stores/useAgentStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { collectQualityRuns, findLatestFailure, deriveNextSteps } from '../../utils/agentQuality';
import ContextManifest from './ContextManifest';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { useT, type I18nKey } from '../../i18n';
import SnapshotCard from './SnapshotCard';
import { collectFilePaths, collectContextGroups } from './WorkspaceInspectorData';
import {
  AgentInspectorHeader,
  NextStepsCard,
  QualityGateCard,
  RollbackCard,
  SystemMessagesList,
} from './WorkspaceInspectorSections';
import { AGENT_STATUS_META, latestAgentTodos } from './WorkspaceInspectorUtils';
import { latestChatTodos } from '../../core/activity/todos';

/** 仅 Code/Work 模式且已选中任务时返回该任务，否则 undefined（兼作类型收窄）。 */
function pickCodeAgent<T>(isCode: boolean, agent: T | undefined): T | undefined {
  return isCode ? agent : undefined;
}

/** 内容判定：任务 / 工具分组 / 系统消息任一非空即认为面板有内容。 */
function inspectorContentState<T>(
  isCode: boolean,
  tasks: unknown[],
  groups: Array<{ items: unknown[] }>,
  systemMessages: T[],
): { sysMessages: T[]; hasContent: boolean } {
  const sysMessages: T[] = isCode ? [] : systemMessages;
  const hasContent = tasks.length > 0 || groups.some((g) => g.items.length > 0) || sysMessages.length > 0;
  return { sysMessages, hasContent };
}

/** Agent 状态徽章与文案（无选中任务时为 null）。 */
function inspectorStatus(
  agent: { status: string } | undefined,
  tPanel: (key: I18nKey) => string,
): { statusMeta: { labelKey: I18nKey; cls: string } | null; statusLabel: string | null } {
  if (!agent) return { statusMeta: null, statusLabel: null };
  const meta = AGENT_STATUS_META[agent.status] ?? {
    labelKey: 'status.stopped' as I18nKey,
    cls: 'bg-[var(--color-text-faint)]',
  };
  return { statusMeta: meta, statusLabel: tPanel(meta.labelKey) };
}

/** 运行时长（秒）与累计 token。 */
function inspectorMetrics(
  agent: { startTime?: number; totalInputTokens?: number; totalOutputTokens?: number } | undefined,
  now: number,
): { elapsed: number; totalTokens: number } {
  const elapsed = agent?.startTime ? Math.max(0, Math.floor((now - agent.startTime) / 1000)) : 0;
  const totalTokens = (agent?.totalInputTokens ?? 0) + (agent?.totalOutputTokens ?? 0);
  return { elapsed, totalTokens };
}

/** 任务是否已进入终态（完成 / 失败 / 停止）。 */
function isAgentSettled(agent: { status: string } | undefined): boolean {
  if (!agent) return false;
  return agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
}

/** 无内容时的空态：说明这段面板是干什么的 + 快照卡。 */
function InspectorEmptyState({
  sidebarMode,
  projectRoot,
  now,
  tPanel,
}: {
  sidebarMode: string;
  projectRoot: string | null | undefined;
  now: number;
  tPanel: ReturnType<typeof useT>;
}) {
  const emptyText = sidebarMode === 'work' ? tPanel('inspector.emptyWork') : tPanel('inspector.emptyCode');
  return (
    <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
      <div className="bg-[var(--color-bg-secondary)] rounded-xl p-6 flex flex-col items-center text-center gap-2">
        <ApartmentOutlined className="text-2xl text-[var(--color-text-faint)]" />
        <p className="text-sm font-semibold text-[var(--color-text-secondary)] m-0">{tPanel('inspector.emptyTitle')}</p>
        <p className="text-2xs text-[var(--color-text-muted)] m-0 leading-relaxed">{emptyText}</p>
      </div>
      <SnapshotCard projectRoot={projectRoot ?? null} now={now} />
    </div>
  );
}

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
  const systemMessages = useInspectorStore((s) => s.systemMessages);
  const inspectorActiveTools = useInspectorStore((s) => s.activeToolCount);
  const messages = useChatStore((s) => s.messages);

  // Selected-agent data (code mode).
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agent = useStoreWithEqualityFn(useAgentStore, (s) => s.agents.find((a) => a.id === currentAgentId), shallow);

  const codeAgent = pickCodeAgent(isCode, agent);
  const { statusMeta, statusLabel } = inspectorStatus(agent, tPanel);


  const { elapsed, totalTokens } = inspectorMetrics(agent, now);

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
  const settled = isAgentSettled(agent);
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


  // 任务清单两种模式都以**真实的 TodoWrite** 为源：Code 模式读 agent 轨迹，
  // 对话模式读聊天消息里的工具调用。从前对话模式读的是一个从未被写入的状态，永远是空的。
  const tasks = useMemo(() => {
    if (isCode) {
      const todos = latestAgentTodos(agent);
      return todos ? mapTodosToTasks(todos) : [];
    }
    const todos = latestChatTodos(messages as never);
    return todos ? mapTodosToTasks(todos) : [];
  }, [isCode, agent, messages]);

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
  const { sysMessages, hasContent } = inspectorContentState(isCode, tasks, groups, systemMessages);

  if (!hasContent) {
    return (
      <InspectorEmptyState
        sidebarMode={sidebarMode}
        projectRoot={projectRoot ?? undefined}
        now={now}
        tPanel={tPanel}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-6 pt-3">
      {codeAgent && (
        <AgentInspectorHeader
          agent={codeAgent}
          statusMeta={statusMeta}
          statusLabel={statusLabel}
          elapsed={elapsed}
          totalTokens={totalTokens}
          onPauseResume={pauseResume}
          onStop={stopAgent}
        />
      )}

      {activeToolCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 mb-3 rounded-lg text-xs text-primary bg-primary-soft">
          <ExecutingIndicator size={14} />
          <span>
            {isCode ? tPanel('inspector.taskRunning') : tPanel('inspector.toolsRunning', { n: activeToolCount })}
          </span>
        </div>
      )}

      {codeAgent && qualityRuns.length > 0 && (
        <QualityGateCard
          agent={codeAgent}
          runs={qualityRuns}
          failure={latestFailure}
          lintFixing={lintFixing}
          onAutoFixLint={() => void autoFixLint()}
        />
      )}

      {codeAgent && nextSteps.length > 0 && <NextStepsCard agent={codeAgent} steps={nextSteps} />}

      {tasks.length > 0 && groups.some((g) => g.items.length > 0) && (
        <div className="border-t border-[var(--color-border-dim)] my-3" />
      )}

      <ContextManifest groups={groups} fileTokens={fileTokens} maxFileTokens={maxFileTokens} />

      {settled && <RollbackCard onRollback={rollbackAgent} />}

      <SnapshotCard projectRoot={projectRoot} now={now} />

      {sysMessages.length > 0 && <SystemMessagesList messages={sysMessages} />}

    </div>
  );
}
