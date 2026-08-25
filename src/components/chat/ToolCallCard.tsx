import { useState, memo, useCallback } from 'react';
import { Tooltip, Button } from 'antd';
import {
  Stop as StopOutlined,
  ArrowClockwise as ReloadOutlined,
  CaretDown as CaretDownOutlined,
} from '@/components/common/icons';
import { shallow } from 'zustand/shallow';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import type { ToolCall, ToolName } from '../../types/tools';
import clsx from 'clsx';
import { cleanOutput } from '../../utils/output-cleaner';
import { t, useT, type I18nKey } from '../../i18n';
import { useChatStore } from '../../stores/useChatStore';
import DiffView from '../permissions/DiffView';
import { ToolIcon } from '../agent/toolIcons';
import TerminalBlock from '../common/TerminalBlock';
import StateDot from '../common/StateDot';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

interface ToolCallCardWrapperProps {
  toolCallId: string;
}

const TOOL_LABEL: Record<ToolName, string | { key: I18nKey }> = {
  Bash: 'Bash',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Delete: 'Delete',
  Grep: 'Grep',
  Glob: 'Glob',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
  TodoWrite: 'TodoWrite',
  Agent: 'Agent',
  GitCommit: 'GitCommit',
  Replan: 'Replan',
  CronCreate: 'CronCreate',
  CronDelete: 'CronDelete',
  CronList: 'CronList',
  TaskOutput: 'TaskOutput',
  TaskStop: 'TaskStop',
  EnterPlanMode: 'Plan',
  ExitPlanMode: 'ExitPlan',
  NotebookEdit: 'NotebookEdit',
  EnterWorktree: 'Worktree',
  LSP: 'LSP',
  ReviewArtifact: 'ReviewArtifact',
  ListSkills: 'ListSkills',
  ReadSkill: 'ReadSkill',
  SessionQuery: 'SessionQuery',
  ReadSpill: 'ReadSpill',
  RunWorkflow: 'RunWorkflow',
  RunCode: 'RunCode',
  AskUser: { key: 'tool.askUser' },
  ReadDocument: 'ReadDocument',
  WriteDocument: 'WriteDocument',
  SlackListChannels: 'Slack',
  SlackPostMessage: 'Slack',
  DriveList: 'Drive',
  DriveRead: 'Drive',
  NotionSearch: 'Notion',
  NotionCreatePage: 'Notion',
  Pty: 'PTY',
  InspectRuntime: 'InspectRuntime',
  WriteSkill: 'WriteSkill',
  ListAgents: 'ListAgents',
  SendMessage: 'SendMessage',
  InterruptAgent: 'InterruptAgent',
  Report: 'Report',
  GetGoal: 'GetGoal',
  CreateGoal: 'CreateGoal',
  UpdateGoal: 'UpdateGoal',
  MountPlugin: 'MountPlugin',
  UnmountPlugin: 'UnmountPlugin',
  Ralph: 'Ralph',
  Pwsh: 'Pwsh',
  SessionEventSearch: 'SessionEventSearch',
  SessionEventRead: 'SessionEventRead',
  SessionTrace: 'SessionTrace',
  TaskList: 'TaskList',
};

function formatInput(name: ToolName, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
      return (input.command as string) || '';
    case 'Read':
      return (input.file_path as string) || '';
    case 'Write':
      return (input.file_path as string) || '';
    case 'ReadDocument':
      return (input.file_path as string) || '';
    case 'WriteDocument':
      return (input.file_path as string) || '';
    case 'SlackPostMessage':
      return `${input.channel || ''} → ${input.text || ''}`;
    case 'DriveRead':
      return (input.file_id as string) || '';
    case 'NotionCreatePage':
      return `${input.title || ''} (${input.parent_page_id || ''})`;
    case 'Edit':
      return t('msg.replaceText', { path: String(input.file_path || '') });
    case 'Grep':
      return (input.pattern as string) || '';
    case 'Glob':
      return (input.pattern as string) || '';
    case 'WebFetch':
      return (input.url as string) || '';
    case 'WebSearch':
      return (input.query as string) || '';
    case 'AskUser':
      return (input.question as string) || '';
    case 'Pty':
      return `${input.action || ''}${input.session_id ? ` ${input.session_id}` : ''}`.trim();
    case 'WriteSkill':
      return (input.name as string) || '';
    case 'SendMessage':
      return `${input.agentId || ''}${input.message ? ` · ${input.message}` : ''}`.trim();
    case 'InterruptAgent':
      return (input.agentId as string) || '';
    case 'Report':
      return (input.content as string) || '';
    case 'MountPlugin':
      return (input.name as string) || '';
    case 'UnmountPlugin':
      return (input.id as string) || '';
    case 'Ralph':
      return (input.objective as string) || '';
    case 'Pwsh':
      return (input.command as string) || '';
    case 'SessionEventSearch':
      return (input.query as string) || '';
    case 'SessionEventRead':
      return `${input.sessionId || ''} #${input.seq ?? ''}`;
    case 'SessionTrace':
      return (input.sessionId as string) || '';
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

/** Extract terminal-ready content + exit code from a Bash ToolCall. */
function extractBashTerminal(toolCall: ToolCall): { content: string; exitCode?: number } {
  if (toolCall.streamOutput) {
    return { content: toolCall.streamOutput };
  }
  if (toolCall.output && typeof toolCall.output === 'object') {
    const o = toolCall.output as { stdout?: string; stderr?: string; exitCode?: number };
    const parts: string[] = [];
    if (o.stdout) parts.push(o.stdout);
    if (o.stderr) parts.push(`\n[stderr]\n${o.stderr}`);
    return {
      content: parts.join(''),
      exitCode: o.exitCode,
    };
  }
  return { content: '' };
}

function formatOutput(name: ToolName, output: unknown): string {
  if (output === null || output === undefined) return t('msg.noOutput');

  if (name === 'Bash') {
    const o = output as { stdout?: string; stderr?: string; exitCode?: number };
    const parts: string[] = [];
    if (o.stdout) parts.push(o.stdout.slice(0, 500));
    if (o.stderr) parts.push(`[stderr] ${o.stderr.slice(0, 300)}`);
    if (o.exitCode !== undefined && o.exitCode !== 0) parts.push(t('msg.exitCode', { n: o.exitCode }));
    return parts.join('\n') || t('msg.noOutput');
  }

  if (name === 'Read' || name === 'Grep' || name === 'Glob' || name === 'WebFetch' || name === 'WebSearch') {
    const o = output as Record<string, unknown>;
    if (o.content) return String(o.content).slice(0, 800);
    if (o.results && Array.isArray(o.results)) {
      return o.results
        .slice(0, 10)
        .map((value: unknown) => {
          if (typeof value === 'string') return value;
          const r =
            value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
          return r.file ? `${r.file}:${r.line || ''} ${r.content || r.snippet || ''}` : JSON.stringify(r);
        })
        .join('\n');
    }
    return JSON.stringify(output).slice(0, 800);
  }

  if (name === 'Write' || name === 'Edit') {
    const o = output as { file_path?: string; action?: string; replaced?: string };
    if (o.file_path) {
      return o.action ? `${o.action}: ${o.file_path}` : t('msg.modified', { path: o.file_path });
    }
  }

  return JSON.stringify(output).slice(0, 500);
}

const ToolCallCard = memo(function ToolCallCard({ toolCall }: ToolCallCardProps) {
  useT();
  const [expanded, setExpanded] = useState(false);
  const metaLabelDef = TOOL_LABEL[toolCall.toolName] ?? toolCall.toolName;
  const metaLabel = typeof metaLabelDef === 'object' ? t(metaLabelDef.key) : metaLabelDef;

  const isRunning = toolCall.status === 'running';
  const isError = toolCall.status === 'error';
  const bashCommand = typeof toolCall.input.command === 'string' ? toolCall.input.command : '';
  const bashCwd = typeof toolCall.input.workdir === 'string' ? toolCall.input.workdir : undefined;
  const summary = formatInput(toolCall.toolName, toolCall.input);
  const bashTerm = toolCall.toolName === 'Bash' ? extractBashTerminal(toolCall) : null;

  const handleAbort = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // don't toggle expand
      const api = window.electronAPI?.ai;
      if (api) {
        api.abortTool(toolCall.requestId, toolCall.id);
      }
    },
    [toolCall.requestId, toolCall.id],
  );

  const handleRetry = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      useChatStore.getState().retryTool(toolCall.requestId, toolCall.id, toolCall.toolName);
    },
    [toolCall.requestId, toolCall.id, toolCall.toolName],
  );

  const failureLine = isError && toolCall.error ? toolCall.error.split('\n')[0] : null;
  const summaryText = failureLine ?? summary;
  const statusLabel = isRunning ? t('tl.running') : isError ? t('tl.failed') : null;

  const leading = expanded ? (
    <CaretDownOutlined size={14} className="ax-tool-row-chevron" />
  ) : (
    <>
      <span className="ax-tool-row-icon">
        {isError ? <StateDot state="error" /> : <ToolIcon toolName={toolCall.toolName} size={14} />}
      </span>
      <CaretDownOutlined size={14} className="ax-tool-row-chevron ax-tool-row-chevron-hover" />
    </>
  );

  const diffCard = (() => {
    if (toolCall.status !== 'done') return null;
    if (toolCall.toolName !== 'Write' && toolCall.toolName !== 'Edit') return null;
    const output = toolCall.output as Record<string, unknown> | null | undefined;
    const oldContent = (output?.oldContent ?? toolCall.oldContent) as string | undefined;
    const newContentValue = (output?.newContent ?? toolCall.newContent) as string | undefined;
    if (oldContent === undefined && newContentValue === undefined) return null;
    const fp = (toolCall.input as Record<string, unknown>).file_path as string | undefined;
    return (
      <div className="ax-tool-card-surface">
        <DiffView oldContent={oldContent || ''} newContent={newContentValue || ''} fileName={fp} />
      </div>
    );
  })();

  const hasInput = Object.keys(toolCall.input ?? {}).length > 0;
  const hasOutput = !!(toolCall.output || toolCall.error);
  const showGeneric = toolCall.toolName !== 'Bash' && diffCard === null && (hasInput || hasOutput);

  return (
    <div className="m-0 group/row ax-tool-row" data-state={toolCall.status} data-tool={toolCall.toolName}>
      <div
        className={clsx('ax-tool-row-head', isRunning && 'ax-tool-row-running')}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${metaLabel}: ${summary}`}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        {statusLabel && <span className="sr-only">{statusLabel}</span>}
        <span className="ax-tool-row-leading">{leading}</span>
        <span className="ax-tool-row-title">{metaLabel}</span>
        {summaryText !== '' && (
          <>
            <span className="ax-tool-row-sep" aria-hidden />
            <span className={clsx('ax-tool-row-summary', failureLine && 'ax-tool-row-error')}>{summaryText}</span>
          </>
        )}
        <span className="ax-tool-row-actions">
          {isRunning && (
            <Tooltip title={t('tool.stop')} placement="top">
              <Button
                type="text"
                size="small"
                danger
                icon={<StopOutlined />}
                onClick={handleAbort}
                className="!p-0 !h-5 !w-5 !min-w-5 !text-text-muted hover:!text-danger"
              />
            </Tooltip>
          )}
          {isError && (
            <Tooltip title={t('tool.retry')} placement="top">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleRetry}
                className="!p-0 !h-5 !w-5 !min-w-5 !text-text-muted hover:!text-text-primary"
              />
            </Tooltip>
          )}
        </span>
      </div>

      {expanded && (
        <div className="flex flex-col">
          {toolCall.toolName === 'Bash' && (toolCall.output || toolCall.error || toolCall.streamOutput) ? (
            <TerminalBlock
              className="ax-tool-card-surface"
              command={bashCommand}
              cwd={bashCwd}
              output={toolCall.error ? toolCall.error : (bashTerm?.content ?? '')}
              running={isRunning}
              failed={!!toolCall.error}
              exitCode={toolCall.error ? (bashTerm?.exitCode ?? 1) : bashTerm?.exitCode}
            />
          ) : diffCard !== null ? (
            diffCard
          ) : showGeneric ? (
            <div className="ax-tool-card-surface">
              <div className="rounded-xl border border-border-default bg-code-bg overflow-hidden">
                {hasInput && (
                  <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-3 py-2 max-h-[150px] overflow-y-auto">
                    <span className="sticky top-0 text-2xs font-semibold text-text-faint">IN</span>
                    <pre className="m-0 text-2xs leading-relaxed text-text-secondary whitespace-pre-wrap break-all font-mono">
                      {JSON.stringify(toolCall.input, null, 2).slice(0, 1200)}
                    </pre>
                  </div>
                )}
                {hasInput && hasOutput && <div className="h-px bg-border-dim" />}
                {hasOutput && (
                  <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 px-3 py-2 max-h-[200px] overflow-y-auto">
                    <span className="sticky top-0 text-2xs font-semibold text-text-faint">
                      {toolCall.error ? 'ERR' : 'OUT'}
                    </span>
                    <div className="min-w-0 flex flex-col gap-2">
                      {Boolean((toolCall.output as Record<string, unknown> | null | undefined)?.image) && (
                        <img
                          src={String((toolCall.output as Record<string, unknown>).image ?? '')}
                          alt={t('toolCard.readImageResult')}
                          className="max-w-full max-h-[320px] rounded-md border border-[var(--color-border-dim)] object-contain bg-[var(--color-bg-inset)]"
                        />
                      )}
                      <pre
                        className={clsx(
                          'm-0 text-2xs leading-relaxed whitespace-pre-wrap break-all font-mono',
                          toolCall.error ? 'text-danger' : 'text-text-secondary',
                        )}
                      >
                        {cleanOutput(toolCall.error || formatOutput(toolCall.toolName, toolCall.output)).cleanedText}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});

/**
 * Stable wrapper: selects a single ToolCall from the store by ID.
 * Zustand's reference equality prevents re-renders when the toolCall
 * content hasn't changed, even though the parent's messages array is new.
 */
export default function ToolCallCardWrapper({ toolCallId }: ToolCallCardWrapperProps) {
  const toolCall = useStoreWithEqualityFn(useChatStore, (s) => s.toolCallMap[toolCallId], shallow);
  if (!toolCall) return null;
  return <ToolCallCard toolCall={toolCall} />;
}
