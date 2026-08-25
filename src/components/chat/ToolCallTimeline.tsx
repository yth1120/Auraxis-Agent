import { useState, useMemo } from 'react';
import { CaretRight as RightOutlined } from '@/components/common/icons';
import type { ToolCall, ToolName } from '../../types/tools';
import clsx from 'clsx';
import { t, useT } from '../../i18n';
import ToolCallCardWrapper from './ToolCallCard';
import ExecutingIndicator from '../common/ExecutingIndicator';
import { ToolIcon } from '../agent/toolIcons';

interface ToolGroup {
  stepGroupId: string;
  toolCalls: ToolCall[];
  status: 'running' | 'done' | 'error';
  startTime: number;
  endTime?: number;
}

function computeGroupStatus(toolCalls: ToolCall[]): 'running' | 'done' | 'error' {
  const hasRunning = toolCalls.some((tc) => tc.status === 'running' || tc.status === 'pending');
  const hasError = toolCalls.some((tc) => tc.status === 'error');
  if (hasRunning) return 'running';
  if (hasError) return 'error';
  return 'done';
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getGroupTitle(toolCalls: ToolCall[]): string {
  const toolNames = new Set(toolCalls.map((tc) => tc.toolName));

  // File modification tools — highest priority
  if (toolNames.has('Write') || toolNames.has('Edit') || toolNames.has('TodoWrite')) {
    const fileTc = toolCalls.find((tc) => tc.toolName === 'Write' || tc.toolName === 'Edit');
    if (fileTc) {
      const fp = (fileTc.input as Record<string, unknown>).file_path as string | undefined;
      const fileName = fp ? fp.split(/[/\\]/).pop() || fp : t('tl.fileModify');
      return t('tl.modifyFile', { name: fileName });
    }
    if (toolNames.has('TodoWrite')) return t('tl.todoUpdated');
    return t('tl.fileModify');
  }

  // Command execution
  if (toolNames.has('Bash')) {
    const bashTc = toolCalls.find((tc) => tc.toolName === 'Bash');
    const cmd = ((bashTc?.input as Record<string, unknown>).command as string) || '';
    const short = cmd.replace(/\n/g, ' ').trim().slice(0, 15);
    return t('tl.cmd', { cmd: short + (cmd.trim().length > 15 ? '...' : '') });
  }

  // Search / exploration
  const searchSet = new Set<ToolName>(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
  const searchCalls = toolCalls.filter((tc) => searchSet.has(tc.toolName));
  if (searchCalls.length === toolCalls.length && searchCalls.length > 0) {
    return t('tl.searchOps', { n: searchCalls.length });
  }
  if (searchCalls.length > 0) {
    return t('tl.searchAndOps', { n: toolCalls.length });
  }

  return t('tl.toolCalls', { n: toolCalls.length });
}

interface ToolCallTimelineProps {
  toolCalls: ToolCall[];
}

export default function ToolCallTimeline({ toolCalls }: ToolCallTimelineProps) {
  // ── Group by stepGroupId ──
  const groups = useMemo(() => {
    const map = new Map<string, ToolCall[]>();
    const ungrouped: ToolCall[] = [];

    for (const tc of toolCalls) {
      if (tc.stepGroupId) {
        const existing = map.get(tc.stepGroupId);
        if (existing) {
          existing.push(tc);
        } else {
          map.set(tc.stepGroupId, [tc]);
        }
      } else {
        ungrouped.push(tc);
      }
    }

    const grouped: ToolGroup[] = [];
    for (const [stepGroupId, tcs] of map) {
      const startTime = Math.min(...tcs.map((tc) => tc.startTime));
      const endTimes = tcs.filter((tc) => tc.endTime).map((tc) => tc.endTime!);
      grouped.push({
        stepGroupId,
        toolCalls: tcs,
        status: computeGroupStatus(tcs),
        startTime,
        endTime: endTimes.length === tcs.length ? Math.max(...endTimes) : undefined,
      });
    }

    // Sort by startTime
    grouped.sort((a, b) => a.startTime - b.startTime);

    return { grouped, ungrouped };
  }, [toolCalls]);

  if (toolCalls.length === 0) return null;

  return (
    <div className="flex flex-col gap-0 my-2.5">
      {groups.grouped.map((group) => (
        <GroupNode key={group.stepGroupId} group={group} />
      ))}
      {groups.ungrouped.map((tc, idx) => (
        <div key={tc.id} className={clsx('relative', idx > 0 && 'mt-0.5')}>
          <ToolCallCardWrapper toolCallId={tc.id} />
        </div>
      ))}
    </div>
  );
}

function GroupNode({ group }: { group: ToolGroup }) {
  const tGroup = useT();
  const [expanded, setExpanded] = useState(group.status !== 'done');

  const groupDuration = group.endTime
    ? formatElapsed(group.endTime - group.startTime)
    : group.status === 'running'
      ? tGroup('tl.running')
      : null;

  return (
    <div className={clsx('ax-tool-group', group.status === 'done' && 'opacity-85')} data-status={group.status}>
      <div
        className="ax-tool-group-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setExpanded(!expanded)}
        data-status={group.status}
      >
        <span
          className={clsx(
            'flex items-center justify-center text-2xs text-text-muted transition-transform duration-200 ease-in w-4 shrink-0',
            expanded && 'rotate-90',
          )}
        >
          <RightOutlined />
        </span>
        {group.status === 'running' ? (
          <ExecutingIndicator size={12} />
        ) : (
          <ToolIcon
            toolName={group.toolCalls[0]?.toolName}
            className={group.status === 'error' ? 'text-danger' : 'text-success'}
          />
        )}
        <span className="text-xs font-semibold text-primary leading-none">{getGroupTitle(group.toolCalls)}</span>
        <span className="text-2xs text-text-muted ml-auto flex items-center gap-2 shrink-0">
          <span className="[font-variant-numeric:tabular-nums]">{group.toolCalls.length} tools</span>
          {groupDuration && <span className="font-mono [font-variant-numeric:tabular-nums]">{groupDuration}</span>}
        </span>
      </div>
      {expanded && (
        <div className="flex flex-col">
          {group.toolCalls.map((tc) => (
            <div
              key={tc.id}
              className="relative p-0 [&:not(:first-child)]:before:content-[''] [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:left-5 [&:not(:first-child)]:before:w-0.5 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-border-dim"
            >
              <ToolCallCardWrapper toolCallId={tc.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
