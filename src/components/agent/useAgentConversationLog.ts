import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo, AgentLogEntry } from '../../types/agent';
import { sessionEventsToLogEntries } from '../../utils/agentLogReplay';
import { useAgentStore } from '../../stores/useAgentStore';
import { useAppStore } from '../../stores/useAppStore';
import type { TurnGroup } from './AgentConversationUtils';

export function useAgentConversationLog({
  agent,
  agentErrorsOnly,
  agentTextOnly,
  agentRunningOnly,
  agentRunningFollow,
  agentErrorNavRequest,
  agentLogFocusRequest,
  pendingPermsLength,
}: {
  agent: AgentInfo | undefined;
  agentErrorsOnly: boolean;
  agentTextOnly: boolean;
  agentRunningOnly: boolean;
  agentRunningFollow: boolean;
  agentErrorNavRequest: { dir: 1 | -1 } | null;
  agentLogFocusRequest: { agentId: string; toolCallId: string } | null;
  pendingPermsLength: number;
}) {
  const [highlightedToolId, setHighlightedToolId] = useState<string | null>(null);
  const autoScrolledErrorsRef = useRef(false);
  const autoScrolledTextRef = useRef(false);
  const restoredLogsRef = useRef<Set<string>>(new Set());
  const logEndRef = useRef<HTMLDivElement>(null);
  const logViewerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!agent) return;
    const isTerminal = agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
    if (!isTerminal || agent.log.length > 0) return;
    if (restoredLogsRef.current.has(agent.id)) return;
    const api = window.electronAPI?.sessionLog;
    if (!api?.read) return;
    restoredLogsRef.current.add(agent.id);
    void api
      .read(agent.id)
      .then((result) => {
        if (!result?.ok || !Array.isArray(result.data) || result.data.length === 0) return;
        const entries = sessionEventsToLogEntries(
          result.data as { type: string; ts: number; data: Record<string, unknown> }[],
        );
        if (entries.length > 0) useAgentStore.getState().appendAgentLog(agent.id, entries);
      })
      .catch(() => {
        /* log unavailable — header/result still render */
      });
  }, [agent]);

  const log = useMemo(() => [...(agent?.log ?? [])], [agent?.log]);
  const logLen = log.length;
  const lastEntry = log[logLen - 1];

  const turnGroups = useMemo<TurnGroup[]>(() => {
    const ended = new Set<string>();
    for (const entry of log) {
      if ((entry.type === 'tool_end' || entry.type === 'tool_error') && entry.toolCallId) ended.add(entry.toolCallId);
    }
    const hasTurnMarkers = log.some((entry) => entry.type === 'turn_start');
    const list: TurnGroup[] = [];
    let current: TurnGroup | null = null;
    let lastIteration = 1;
    for (const entry of log) {
      if (hasTurnMarkers && entry.type === 'turn_start') {
        current = { iteration: entry.iteration ?? list.length + 1, entries: [], startTs: entry.timestamp };
        list.push(current);
        continue;
      }
      if (hasTurnMarkers && entry.type === 'turn_end') {
        if (current) current.end = entry;
        continue;
      }
      if (!hasTurnMarkers && entry.type === 'iteration_start') {
        lastIteration = entry.iteration ?? list.length + 1;
        current = { iteration: lastIteration, entries: [], startTs: entry.timestamp };
        list.push(current);
        continue;
      }
      if (!hasTurnMarkers && entry.type === 'iteration_end') {
        if (current) current.end = entry;
        continue;
      }
      if (!current) {
        current = { iteration: lastIteration, entries: [], startTs: entry.timestamp };
        list.push(current);
      }
      if (entry.type === 'iteration_end') current.metricsEnd = entry;
      if (entry.type === 'tool_start' && entry.toolCallId && ended.has(entry.toolCallId)) continue;
      current.entries.push(entry);
    }
    for (const turn of list) {
      const merged: AgentLogEntry[] = [];
      for (const entry of turn.entries) {
        const prev = merged[merged.length - 1];
        if ((entry.type === 'text' || entry.type === 'thinking') && prev && prev.type === entry.type) {
          prev.text = (prev.text ?? '') + (entry.text ?? '');
          continue;
        }
        if (entry.type === 'text' && !(entry.text ?? '').trim()) continue;
        merged.push(entry);
      }
      turn.entries = merged;
    }
    return list;
  }, [log]);

  useEffect(() => {
    if (!agentErrorNavRequest || !agent) return;
    const agentId = agent.id;
    const errors = turnGroups.flatMap((turn) =>
      turn.entries.filter((entry) => entry.type === 'tool_error' || entry.type === 'warning' || entry.type === 'error'),
    );
    if (errors.length === 0) {
      useAppStore.getState().clearAgentErrorNav();
      return;
    }
    const ids = errors.map((entry) => entry.toolCallId || `${entry.type}-${entry.timestamp}`);
    let currentIndex = ids.indexOf(highlightedToolId ?? '');
    if (currentIndex < 0) currentIndex = -1;
    const nextIndex = (currentIndex + agentErrorNavRequest.dir + errors.length) % errors.length;
    const target = errors[nextIndex];
    setHighlightedToolId(target.toolCallId || null);
    const toolCallId = target.toolCallId;
    if (toolCallId) {
      requestAnimationFrame(() => {
        scrollLogTo(`[data-agent-log-entry="${toolCallId}"]`);
        useAppStore.getState().requestTrajectoryFocus(agentId, toolCallId);
      });
    }
    useAppStore.getState().clearAgentErrorNav();
  }, [agentErrorNavRequest, turnGroups, agent, highlightedToolId]);

  const scrollLogToBottom = () => {
    const viewer = logViewerRef.current;
    if (viewer) viewer.scrollTop = viewer.scrollHeight;
  };
  const scrollLogTo = (selector: string) => {
    const viewer = logViewerRef.current;
    const element = viewer?.querySelector(selector);
    if (!viewer || !element) return;
    const top = element.getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop;
    viewer.scrollTop = Math.max(0, top - viewer.clientHeight / 2 + element.clientHeight / 2);
  };

  useEffect(() => {
    if (!agentErrorsOnly) {
      autoScrolledErrorsRef.current = false;
      return;
    }
    if (autoScrolledErrorsRef.current) return;
    for (const turn of turnGroups) {
      const failed = turn.entries.find(
        (entry) => entry.type === 'tool_error' || entry.type === 'warning' || entry.type === 'error',
      );
      if (failed) {
        autoScrolledErrorsRef.current = true;
        requestAnimationFrame(() => {
          if (failed.toolCallId) scrollLogTo(`[data-agent-log-entry="${failed.toolCallId}"]`);
        });
        break;
      }
    }
  }, [agentErrorsOnly, turnGroups]);

  useEffect(() => {
    if (!agentTextOnly) {
      autoScrolledTextRef.current = false;
      return;
    }
    if (autoScrolledTextRef.current) return;
    const first = turnGroups
      .flatMap((turn) => turn.entries)
      .find((entry) => entry.type === 'text' || entry.type === 'thinking');
    if (first) {
      autoScrolledTextRef.current = true;
      requestAnimationFrame(() => scrollLogTo(`[data-agent-entry-type="${first.type}"]`));
    }
  }, [agentTextOnly, turnGroups]);

  useEffect(() => {
    if (!agentRunningOnly || !agentRunningFollow) return;
    let last: AgentLogEntry | null = null;
    for (const turn of turnGroups) {
      for (const entry of turn.entries) if (entry.type === 'tool_start') last = entry;
    }
    if (!last) return;
    if (last.toolCallId) {
      requestAnimationFrame(() => scrollLogTo(`[data-agent-log-entry="${last!.toolCallId}"]`));
    }
  }, [agentRunningOnly, agentRunningFollow, turnGroups]);

  useEffect(() => {
    if (!agentLogFocusRequest || agentLogFocusRequest.agentId !== agent?.id) return;
    setHighlightedToolId(agentLogFocusRequest.toolCallId);
    const clearTimer = setTimeout(() => {
      setHighlightedToolId(null);
      useAppStore.getState().clearAgentLogFocus();
    }, 1600);
    requestAnimationFrame(() => {
      scrollLogTo(`[data-agent-log-entry="${agentLogFocusRequest.toolCallId}"]`);
    });
    return () => clearTimeout(clearTimer);
  }, [agentLogFocusRequest, agent?.id]);

  const onLogScroll = useCallback(() => {
    const viewer = logViewerRef.current;
    if (!viewer) return;
    pinnedRef.current = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 80;
  }, []);

  const isTerminalStatus = agent?.status === 'completed' || agent?.status === 'error' || agent?.status === 'stopped';
  useEffect(() => {
    if (isTerminalStatus && agentRunningOnly) useAppStore.getState().setAgentRunningOnly(false);
  }, [isTerminalStatus, agentRunningOnly]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    scrollLogToBottom();
  }, [logLen, pendingPermsLength]);

  const agentId = agent?.id;
  useEffect(() => {
    pinnedRef.current = true;
    scrollLogToBottom();
  }, [agentId]);

  return {
    log,
    logLen,
    lastEntry,
    turnGroups,
    logViewerRef,
    logEndRef,
    onLogScroll,
    highlightedToolId,
    setHighlightedToolId,
    isTerminalStatus,
  };
}
