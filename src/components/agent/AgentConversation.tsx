import { useCallback, useEffect, useState } from 'react';
import { Modal, message, notification } from 'antd';
import { Copy as CopyIcon } from '@/components/common/icons';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { t, useT } from '../../i18n';
import { PERMISSION_PRESETS } from '../../types/advanced';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { createAgent } from '../../constants/commands';
import InlinePermissionCard from '../permissions/InlinePermissionCard';
import MarkdownRenderer from '../chat/MarkdownRenderer';
import { ensureAgentViewShortcuts } from '../../utils/agentViewShortcuts';
import StateDot from '../common/StateDot';
import { formatTime } from '../../utils/time';
import DeepDiveStatus from '../common/DeepDiveStatus';
import { NO_PERMS, basename, cleanText, runDurationLabel, turnStats } from './AgentConversationUtils';
import { AgentLogEntryView as LogEntry, AgentTurnTimeline, projectUserText } from './AgentConversationParts';
import { useAgentConversationLog } from './useAgentConversationLog';
import clsx from 'clsx';

export default function AgentConversation({
  headerInset = 0,
  bottomInset = 0,
}: {
  headerInset?: number;
  bottomInset?: number;
}) {
  const tConv = useT();
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const agentLogFocusRequest = useAppStore((s) => s.agentLogFocusRequest);
  const agentErrorsOnly = useAppStore((s) => s.agentErrorsOnly);
  const agentTextOnly = useAppStore((s) => s.agentTextOnly);
  const agentRunningOnly = useAppStore((s) => s.agentRunningOnly);
  const agentRunningFollow = useAppStore((s) => s.agentRunningFollow);
  const agentRawLogRequest = useAppStore((s) => s.agentRawLogRequest);
  const agentErrorNavRequest = useAppStore((s) => s.agentErrorNavRequest);
  const [rawLogOpen, setRawLogOpen] = useState(false);
  const setCurrentAgent = useAgentStore((s) => s.setCurrentAgent);
  const agent = useStoreWithEqualityFn(useAgentStore, (s) => s.agents.find((a) => a.id === currentAgentId), shallow);
  const pendingPerms = useStoreWithEqualityFn(
    useAgentStore,
    (s) => (currentAgentId ? s.agentPermissions[currentAgentId] : undefined) || NO_PERMS,
    shallow,
  );
  const subagents = useStoreWithEqualityFn(
    useAgentStore,
    (s) => (currentAgentId ? s.agents.filter((a) => a.parentAgentId === currentAgentId) : []),
    shallow,
  );
  const isSubagent = !!agent?.parentAgentId;

  const { lastEntry, turnGroups, logViewerRef, logEndRef, onLogScroll, highlightedToolId } = useAgentConversationLog({
    agent,
    agentErrorsOnly,
    agentTextOnly,
    agentRunningOnly,
    agentRunningFollow,
    agentErrorNavRequest,
    agentLogFocusRequest,
    pendingPermsLength: pendingPerms.length,
  });

  useEffect(() => {
    ensureAgentViewShortcuts();
  }, []);

  useEffect(() => {
    if (agentRawLogRequest) setRawLogOpen(true);
  }, [agentRawLogRequest]);

  const implementPlan = useCallback(async () => {
    if (!agent?.planFile) return;
    const preset = useSettingsStore.getState().permissionPreset;
    const spec = PERMISSION_PRESETS[preset];
    const id = await createAgent({
      name: t('conv.implementPlan'),
      type: 'general-purpose',
      instruction: `请先阅读计划文件 ${agent.planFile}，严格按其中列出的步骤逐项实施。每完成一步用 TodoWrite 更新进度；遇到阻塞或风险操作时先说明再做。不要跳过任何步骤。`,
      displayText: t('conv.implementPlanDisplay', { name: basename(agent.planFile) }),
      mode: spec.mode,
      autoApprove: spec.autoApprove,
    });
    if (id) setCurrentAgent(id);
  }, [agent?.planFile, setCurrentAgent]);

  const copyFlowText = (text: string) => {
    const value = text.trim();
    if (!value) return;
    void navigator.clipboard?.writeText(value).then(
      () => message.success(tConv('conv.copyDone')),
      () => message.error(tConv('conv.copyFailed')),
    );
  };

  if (!agent) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-text-muted">
        {tConv('conv.notFound')}
      </div>
    );
  }

  const isTerminal = agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
  const hasTextOutput = turnGroups.some((t) => t.entries.some((e) => e.type === 'text'));

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      <div className="flex-1 min-h-0 flex flex-row min-w-0">
        <div className="flex-1 min-w-0 max-w-[var(--content-max-width,880px)] mx-auto w-full flex flex-col overflow-hidden">
          <div
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-8 pt-4"
            style={{ paddingBottom: 16 + bottomInset }}
            ref={logViewerRef}
            onScroll={onLogScroll}
          >
            {/* Scroll room under the floating transparent header — the agent
                stream slides beneath it exactly like chat mode. */}
            <div style={{ height: headerInset }} aria-hidden="true" />
            <div className="w-full min-w-0 max-w-[var(--content-max-width)] mx-auto">
              {/* 会话流: one flat 16px flow — right-aligned user
              bubble → assistant markdown → inline tool rows → a quiet per-turn
              tail. No round cards, no round headers. */}
              <div className="flex flex-col gap-4">
                {!isSubagent && agent.description && (
                  <div className="group flex flex-col items-end gap-1.5" data-time-hover-root>
                    <div className="max-w-[525px] whitespace-pre-wrap break-words rounded-2xl bg-[var(--color-bg-secondary)] px-4 py-2.5 text-base leading-6 text-text-primary">
                      {projectUserText(agent.description)}
                    </div>
                    <div className="ax-flow-actions" data-align="end">
                      <button
                        type="button"
                        className="ax-flow-action"
                        aria-label={tConv('msg.copy')}
                        title={tConv('msg.copy')}
                        onClick={() => copyFlowText(agent.description)}
                      >
                        <CopyIcon size={16} />
                      </button>
                    </div>
                  </div>
                )}
                {turnGroups.map((turn) => {
                  const runningFilterActive = agentRunningOnly && agent.status === 'running';
                  // Lifecycle markers render nothing — they must not exist as flow
                  // items either, or each empty wrapper would consume a 16px gap
                  // and stretch the vertical rhythm 更宽松的.
                  const flowEntries = turn.entries.filter((e) => {
                    switch (e.type) {
                      case 'iteration_start':
                      case 'iteration_end':
                      case 'turn_start':
                      case 'turn_end':
                        return false;
                      case 'text':
                      case 'user_message':
                        return cleanText(e.text) !== '';
                      case 'thinking':
                        return (e.text ?? '').trim() !== '';
                      case 'context':
                        return e.disclosure != null;
                      case 'plan':
                        return e.todos != null && e.todos.length > 0;
                      default:
                        return true;
                    }
                  });
                  const visibleTurnEntries = agentErrorsOnly
                    ? flowEntries.filter((e) => e.type === 'tool_error' || e.type === 'warning' || e.type === 'error')
                    : agentTextOnly
                      ? flowEntries.filter((e) => e.type === 'text' || e.type === 'thinking')
                      : runningFilterActive
                        ? flowEntries.filter((e) => e.type === 'tool_start')
                        : flowEntries;
                  if ((agentErrorsOnly || agentTextOnly || runningFilterActive) && visibleTurnEntries.length === 0)
                    return null;
                  const stats = turnStats(turn.metricsEnd ?? turn.end);
                  const turnText = turn.entries
                    .filter((e) => e.type === 'text' && (e.text ?? '').trim())
                    .map((e) => e.text as string)
                    .join('\n');
                  const durationMs =
                    turn.startTs != null && turn.end?.timestamp != null
                      ? Math.max(0, turn.end.timestamp - turn.startTs)
                      : undefined;
                  const tailTime = turn.end?.timestamp ?? turn.entries[turn.entries.length - 1]?.timestamp;
                  // the tail (copy + clock + run stats) belongs to a
                  // settled turn only — the live turn carries no actions chrome.
                  const hasTail =
                    turn.end != null && (turnText !== '' || stats !== '' || tailTime != null || durationMs != null);
                  return (
                    <div key={turn.iteration} data-agent-turn={turn.iteration} className="group flex flex-col gap-4">
                      {visibleTurnEntries.map((entry, i) => (
                        <div
                          key={i}
                          data-agent-log-entry={entry.toolCallId}
                          data-agent-entry-type={entry.type}
                          className={clsx(
                            'transition-colors duration-200',
                            highlightedToolId === entry.toolCallId && 'bg-primary-soft ring-2 ring-primary/30',
                          )}
                        >
                          <LogEntry
                            entry={entry}
                            isStreaming={agent.status === 'running' && entry === lastEntry}
                            subagents={subagents}
                          />
                        </div>
                      ))}
                      {hasTail && (
                        <div className="ax-flow-actions" data-time-hover-root>
                          {turnText && (
                            <button
                              type="button"
                              className="ax-flow-action"
                              aria-label={tConv('msg.copy')}
                              title={tConv('msg.copy')}
                              onClick={() => copyFlowText(turnText)}
                            >
                              <CopyIcon size={16} />
                            </button>
                          )}
                          <span className="ax-flow-time tabular-nums" data-side="end">
                            {tailTime != null && (
                              <>
                                {formatTime(tailTime)}
                                {durationMs != null || stats !== '' ? (
                                  <span className="ax-flow-dot" aria-hidden>
                                    ·
                                  </span>
                                ) : null}
                              </>
                            )}
                            {durationMs != null && (
                              <>
                                {runDurationLabel(durationMs)}
                                {stats !== '' ? (
                                  <span className="ax-flow-dot" aria-hidden>
                                    ·
                                  </span>
                                ) : null}
                              </>
                            )}
                            {stats}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {agent.status === 'running' && <DeepDiveStatus startTime={agent.startTime} />}
              </div>
              {/* 会话尾部: one dim, centered stats strip plus the few
              actions that have no home in the right panel. 复制结果 lives on
              each turn tail; 回退/变更 live in the right-panel 概览/变更. */}
              {isTerminal && !hasTextOutput && (agent.result || agent.error) && (
                <div className="mt-4 text-base leading-7 text-[var(--color-text-primary)]">
                  <MarkdownRenderer content={cleanText(agent.result || agent.error)} />
                </div>
              )}
              {isTerminal && agent.planFile && (
                <div className="ax-session-tail">
                  <div className="ax-session-actions">
                    <button type="button" className="ax-session-action" onClick={implementPlan}>
                      {tConv('conv.implementPlan')}
                    </button>
                  </div>
                </div>
              )}
              {agent.error && (
                <div className="flex items-start gap-2 mt-4 py-0.5 text-xs leading-5 text-[var(--color-danger)]">
                  <StateDot state="error" className="mt-1 shrink-0" />
                  <span className="min-w-0">{agent.error}</span>
                </div>
              )}
              {/* Approval cards live inside the stream — they scroll with the log
              instead of carving a fixed slab out of the viewport. */}
              {pendingPerms.map((req) => (
                <InlinePermissionCard
                  key={req.requestId}
                  request={req}
                  onResolved={() => {
                    useAgentStore.getState().removeAgentPermission(agent.id, req.requestId);
                    notification.destroy(req.requestId);
                  }}
                />
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>
        <AgentTurnTimeline turns={turnGroups} scrollerRef={logViewerRef} />
      </div>
      <Modal
        title={tConv('conv.rawLog')}
        open={rawLogOpen}
        onCancel={() => setRawLogOpen(false)}
        footer={[
          <button
            key="copy"
            type="button"
            className="h-7 px-3 rounded-full text-xs font-medium text-primary bg-primary-soft border-none cursor-pointer hover:bg-[var(--color-primary-strong)]"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(agent.log, null, 2)).then(
                () => message.success(tConv('conv.copyDone')),
                () => {},
              );
            }}
          >
            {tConv('conv.copy')}
          </button>,
          <button
            key="close"
            type="button"
            className="h-7 px-3 rounded-full text-xs font-medium text-text-secondary bg-[var(--color-bg-secondary)] border border-border-default cursor-pointer hover:bg-[var(--color-hover)]"
            onClick={() => setRawLogOpen(false)}
          >
            {tConv('conv.close')}
          </button>,
        ]}
        width={720}
        transitionName=""
        maskTransitionName=""
      >
        <pre className="m-0 max-h-[520px] overflow-auto rounded-xl bg-code-bg border border-border-dim p-3 font-mono text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all">
          {JSON.stringify(agent.log, null, 2)}
        </pre>
      </Modal>
    </div>
  );
}
