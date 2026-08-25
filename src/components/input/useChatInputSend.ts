import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '../../stores/useChatStore';
import { useAgentStore } from '../../stores/useAgentStore';
import type { AgentPriority } from '../../types/agent';
import type { AgentSkill } from '../../core/skills';
import type { PermissionPreset } from '../../types/advanced';
import type { I18nKey } from '../../i18n';
import { executeLeadingCommand, launchAgentTask } from './ChatInputActions';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function useChatInputSend({
  inputValue,
  isAgentSurface,
  currentAgentRunning,
  currentAgentId,
  currentAgentStatus,
  isStreaming,
  setToastMsg,
  setShowToast,
  allSkills,
  permissionPreset,
  selectedModel,
  reasoningEffort,
  taskPriority,
  t,
}: {
  inputValue: string;
  isAgentSurface: boolean;
  currentAgentRunning: boolean;
  currentAgentId: string | null;
  currentAgentStatus: string | null;
  isStreaming: boolean;
  setToastMsg: (value: string) => void;
  setShowToast: (value: boolean) => void;
  allSkills: AgentSkill[];
  permissionPreset: PermissionPreset;
  selectedModel: string;
  reasoningEffort: string;
  taskPriority: AgentPriority;
  t: Translate;
}) {
  const startCodeTask = useCallback(
    (instruction: string, opts?: { clearInput?: boolean }) =>
      launchAgentTask({
        instruction,
        clearInput: opts?.clearInput,
        allSkills,
        permissionPreset,
        selectedModel,
        reasoningEffort,
        taskPriority,
        t,
      }),
    [allSkills, permissionPreset, selectedModel, reasoningEffort, taskPriority, t],
  );

  const tryExecuteLeadingCommand = useCallback(
    (raw: string) => executeLeadingCommand(raw, useChatStore.getState().setInputValue, t),
    [t],
  );

  const handleSend = useCallback(() => {
    if (isAgentSurface && currentAgentRunning && currentAgentId) {
      const text = inputValue.trim();
      if (text) {
        useChatStore.getState().enqueueAgentMessage(text);
        useChatStore.getState().setInputValue('');
        setToastMsg(t('composer.toast.queued'));
        setShowToast(true);
        return;
      }
      useAgentStore.getState().stopAgent(currentAgentId);
      return;
    }
    if (tryExecuteLeadingCommand(inputValue)) return;
    if (isStreaming) {
      const hasText = inputValue.trim().length > 0;
      useChatStore.getState().stopStreaming();
      if (hasText && !isAgentSurface) window.setTimeout(() => useChatStore.getState().sendMessage(), 0);
      return;
    }
    if (!inputValue.trim()) return;
    if (isAgentSurface) {
      void startCodeTask(inputValue);
      return;
    }
    useChatStore.getState().sendMessage();
  }, [
    inputValue,
    isStreaming,
    isAgentSurface,
    currentAgentId,
    currentAgentRunning,
    startCodeTask,
    tryExecuteLeadingCommand,
    setToastMsg,
    setShowToast,
    t,
  ]);

  const explicitInterruptRef = useRef(false);
  const sendQueueNow = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (isAgentSurface && currentAgentRunning && currentAgentId) {
        explicitInterruptRef.current = true;
        await useAgentStore.getState().stopAgent(currentAgentId);
        setToastMsg(t('composer.toast.interrupted'));
        setShowToast(true);
      }
      void startCodeTask(trimmed, { clearInput: false });
    },
    [currentAgentId, currentAgentRunning, isAgentSurface, startCodeTask, t, setToastMsg, setShowToast],
  );

  const prevAgentStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevAgentStatusRef.current;
    prevAgentStatusRef.current = currentAgentStatus;
    if (!isAgentSurface || !currentAgentId) return;
    const wasBusy = prev === 'running' || prev === 'queued' || prev === 'paused';
    const settled =
      currentAgentStatus === 'completed' || currentAgentStatus === 'error' || currentAgentStatus === 'stopped';
    if (!wasBusy) {
      explicitInterruptRef.current = false;
      return;
    }
    if (explicitInterruptRef.current) {
      explicitInterruptRef.current = false;
      return;
    }
    if (!settled) return;
    const next = useChatStore.getState().agentQueue[0];
    if (!next) return;
    useChatStore.getState().dequeueAgentMessage(next.id);
    void startCodeTask(next.text, { clearInput: false });
  }, [currentAgentStatus, currentAgentId, isAgentSurface, startCodeTask]);

  return { startCodeTask, handleSend, sendQueueNow };
}
