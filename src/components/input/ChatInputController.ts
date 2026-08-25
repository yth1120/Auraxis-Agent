import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText } from '../../../electron/errors';
import { message } from 'antd';
import { useSmartDropdown } from '../../hooks/useSmartDropdown';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useInspectorStore, selectPendingPlan } from '../../stores/useInspectorStore';
import { useAutoResize } from '../../hooks/useAutoResize';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useChatInputMentions } from './useChatInputMentions';
import { recordCommand } from './ChatInputActions';
import { useChatInputFiles } from './useChatInputFiles';
import { useChatInputSend } from './useChatInputSend';
import { useChatInputModePanel } from './useChatInputModePanel';
import { useT } from '../../i18n';
import type { ChatInputProps } from './ChatInputUtils';
import { SLASH_COMMANDS, executeCommand, type SlashCommand } from '../../constants/commands';
import { findPluginCommand } from '../../utils/slashCommands';
import { useAgentStore } from '../../stores/useAgentStore';
import { AGENT_SKILLS, type AgentSkill } from '../../core/skills';
import { useAuthStore } from '../../stores/useAuthStore';
import { speechRecognitionConstructor } from './SpeechRecognition';

export function useChatInputController({ position }: ChatInputProps) {
  const t = useT();
  const accountName = useAuthStore((s) => s.name);
  // Re-render every minute so the greeting follows the real clock across
  // morning / afternoon / evening boundaries while the app stays open.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const messagesLen = useChatStore((s) => s.messages.length);
  const resolvedPosition = position ?? (messagesLen === 0 ? 'center' : 'bottom');
  const isCenter = resolvedPosition === 'center';
  const isFlowCenter = resolvedPosition === 'center-flow';
  const heroSizing = isCenter || isFlowCenter;
  const inputValue = useChatStore((s) => s.inputValue);
  const setInputValue = useChatStore((s) => s.setInputValue);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isWebSearch = useChatStore((s) => s.isWebSearch);
  const toggleWebSearch = useChatStore((s) => s.toggleWebSearch);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const isDeepThink = useChatStore((s) => s.isDeepThink);
  const toggleDeepThink = useChatStore((s) => s.toggleDeepThink);
  const reasoningEffort = useChatStore((s) => s.reasoningEffort);
  const projectPath = useSettingsStore((s) => s.projectPath);
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const workAutonomyTier = useAppStore((s) => s.workAutonomyTier);
  const { ref: textareaRef, resize } = useAutoResize(1, heroSizing ? 10 : 8);

  /** Work / Agent share the agent-capable surface; chat is pure conversation. */
  const isAgentSurface = sidebarMode !== 'chat';
  const currentAgentId = useAgentStore((s) => s.currentAgentId);
  const currentAgentStatus = useAgentStore((s) => {
    if (!s.currentAgentId) return null;
    return s.agents.find((x) => x.id === s.currentAgentId)?.status ?? null;
  });
  const currentAgentRunning = useAgentStore((s) => {
    if (!s.currentAgentId) return false;
    const a = s.agents.find((x) => x.id === s.currentAgentId);
    return a?.status === 'running' || a?.status === 'paused' || a?.status === 'queued';
  });
  const [toastMsg, setToastMsg] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  /** Current Git branch of the open project ('' when none / not a repo). */
  const [gitBranch, setGitBranch] = useState('');
  // Code-mode launcher config — store-backed (persisted, survives remounts).
  const pendingPlanMode = useChatStore((s) => s.pendingPlanMode);
  const pendingToolChoice = useChatStore((s) => s.pendingToolChoice);
  const setPendingToolChoice = useChatStore((s) => s.setPendingToolChoice);
  const modelPanelRequest = useChatStore((s) => s.modelPanelRequest);
  const permissionPreset = useSettingsStore((s) => s.permissionPreset);
  const setPermissionPreset = useSettingsStore((s) => s.setPermissionPreset);
  const taskPriority = useChatStore((s) => s.taskPriority);
  const plans = useInspectorStore((s) => s.plans);
  const pendingPlan = useMemo(() => selectPendingPlan(plans, currentAgentId), [plans, currentAgentId]);
  // ── Smart dropdown refs & hooks ──
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const smartMore = useSmartDropdown(moreTriggerRef, {
    panelHeight: 180,
    gap: 10,
    direction: heroSizing ? 'down' : 'up',
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const {
    mentionOpen,
    mentionQuery,
    mentionIndex,
    mentionItems,
    mentionSessions,
    mentionSelected,
    setMentionOpen,
    setMentionIndex,
    setMentionSelected,
    commandOpen,
    commandQuery,
    commandIndex,
    commandItems,
    commandSelected,
    setCommandOpen,
    setCommandIndex,
    setCommandSelected,
    dollarOpen,
    dollarIndex,
    dollarQuery,
    dollarSelected,
    setDollarOpen,
    setDollarIndex,
    setDollarSelected,
    allSkills,
    dollarSkills,
  } = useChatInputMentions({
    projectPath,
    inputValue,
    textareaRef,
    isAgentSurface,
    t,
  });

  const {
    modeTriggerRef,
    modePanelRef,
    modePanelOpen,
    setModePanelOpen,
    modePanelPos,
    closeModePanel,
    toggleModePanel,
    handleBlur,
  } = useChatInputModePanel({
    heroSizing,
    isStreaming,
    messagesLen,
    sidebarMode,
    modelPanelRequest,
    containerRef,
    moreTriggerRef,
    smartMoreClose: smartMore.close,
    smartMorePanelRef: smartMore.panelRef,
    setDollarOpen,
    setMentionOpen,
    setCommandOpen,
    setIsFocused,
  });

  // Wrap more-menu toggle with mutual exclusion
  const toggleMoreMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!smartMore.open) setModePanelOpen(false);
      smartMore.toggle(event);
    },
    [smartMore, setModePanelOpen],
  );

  const hasInput = inputValue.trim().length > 0;
  const micSupported = useMemo(() => typeof window !== 'undefined' && !!speechRecognitionConstructor(), []);

  useEffect(() => {
    resize();
  }, [inputValue, resize, isCenter]);

  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setGitBranch('');
      return;
    }
    window.electronAPI?.system
      ?.getGitBranches?.(projectPath)
      .then((result) => {
        if (cancelled) return;
        setGitBranch(result?.ok && result.data?.current ? result.data.current : '');
      })
      .catch(() => {
        if (!cancelled) setGitBranch('');
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputValue(e.target.value);
    },
    [setInputValue],
  );

  // Right-panel actions (diff 继续改 / 质量门错误修复) ask the composer to focus
  // after backfilling the input — this effect reacts to that request.
  const composerFocusTick = useChatStore((s) => s.composerFocusTick);
  useEffect(() => {
    if (composerFocusTick > 0) textareaRef.current?.focus();
  }, [composerFocusTick, textareaRef]);

  const { handleSend, sendQueueNow } = useChatInputSend({
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
  });

  const handleMentionSelect = useCallback(
    (filePath: string) => {
      if (mentionIndex < 0) return;
      const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
      const textBefore = inputValue.slice(0, mentionIndex);
      const textAfter = inputValue.slice(cursorPos);
      const newValue = textBefore + '@' + filePath + textAfter;
      setInputValue(newValue);
      setMentionOpen(false);
      setMentionIndex(-1);
      setTimeout(() => {
        const pos = mentionIndex + filePath.length + 1;
        textareaRef.current?.setSelectionRange(pos, pos);
        textareaRef.current?.focus();
      }, 0);
    },
    [inputValue, mentionIndex, setInputValue, textareaRef, setMentionOpen, setMentionIndex],
  );

  const handleMentionSessionSelect = useCallback(
    (sessionId: string) => {
      if (mentionIndex < 0) return;
      const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
      const textBefore = inputValue.slice(0, mentionIndex);
      const textAfter = inputValue.slice(cursorPos);
      const token = `@session:${sessionId}`;
      const newValue = textBefore + token + textAfter;
      setInputValue(newValue);
      setMentionOpen(false);
      setMentionIndex(-1);
      setTimeout(() => {
        const pos = mentionIndex + token.length;
        textareaRef.current?.setSelectionRange(pos, pos);
        textareaRef.current?.focus();
      }, 0);
    },
    [inputValue, mentionIndex, setInputValue, textareaRef, setMentionOpen, setMentionIndex],
  );

  const handleDollarSelect = useCallback(
    (skill: AgentSkill) => {
      if (dollarIndex < 0) return;
      const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
      const textBefore = inputValue.slice(0, dollarIndex);
      const textAfter = inputValue.slice(cursorPos);
      const newValue = `${textBefore}$${skill.name} ${textAfter}`;
      setInputValue(newValue);
      setDollarOpen(false);
      setDollarIndex(-1);
      setTimeout(() => {
        const pos = dollarIndex + skill.name.length + 2;
        textareaRef.current?.setSelectionRange(pos, pos);
        textareaRef.current?.focus();
      }, 0);
    },
    [inputValue, dollarIndex, setInputValue, textareaRef, setDollarOpen, setDollarIndex],
  );

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      if (commandIndex < 0) return;
      const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
      const textBefore = inputValue.slice(0, commandIndex);
      const textAfter = inputValue.slice(cursorPos);
      const execCtx = {
        clearMessages: () => useChatStore.getState().clearMessages(),
        setSelectedModel: (model: string) => useChatStore.getState().setSelectedModel(model),
        setInputValue,
        toggleTheme: () => useAppStore.getState().toggleTheme(),
        theme: useAppStore.getState().theme,
      };
      let executed = executeCommand(cmd.name, commandQuery.slice(cmd.name.length).trim(), execCtx);
      if (!executed) {
        const pluginCmd = findPluginCommand(cmd.name);
        if (pluginCmd) {
          try {
            executed = pluginCmd.execute(commandQuery.slice(cmd.name.length).trim(), execCtx);
          } catch (e: unknown) {
            message.error(t('composer.commandFailed', { name: cmd.name, error: errorText(e) }));
            executed = true;
          }
        }
      }
      if (executed) {
        recordCommand(cmd.name, commandQuery.slice(cmd.name.length).trim());
        const newValue = textBefore + textAfter.trimStart();
        setInputValue(newValue);
      } else {
        const newValue = textBefore + '/' + cmd.name + ' ';
        setInputValue(newValue);
        setTimeout(() => {
          const pos = (textBefore + '/' + cmd.name + ' ').length;
          textareaRef.current?.setSelectionRange(pos, pos);
          textareaRef.current?.focus();
        }, 0);
      }
      setCommandOpen(false);
      setCommandIndex(-1);
    },
    [inputValue, commandIndex, commandQuery, setInputValue, textareaRef, t, setCommandOpen, setCommandIndex],
  );

  const handleKeyDownWithMention = useCallback(
    (e: React.KeyboardEvent) => {
      if (commandOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setCommandSelected((prev) => (prev + 1) % commandItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setCommandSelected((prev) => (prev - 1 + commandItems.length) % commandItems.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          handleCommandSelect(commandItems[commandSelected] || SLASH_COMMANDS[0]);
          return;
        }
        if (e.key === 'Escape') {
          setCommandOpen(false);
          return;
        }
      }

      if (mentionOpen) {
        const total = mentionSessions.length + mentionItems.length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionSelected((prev) => (prev + 1) % Math.max(1, total));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionSelected((prev) => (prev - 1 + total) % Math.max(1, total));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (mentionSelected < mentionSessions.length) {
            handleMentionSessionSelect(mentionSessions[mentionSelected].id);
          } else {
            handleMentionSelect(mentionItems[mentionSelected - mentionSessions.length] || mentionQuery);
          }
          return;
        }
        if (e.key === 'Escape') {
          setMentionOpen(false);
          return;
        }
      }

      if (dollarOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setDollarSelected((prev) => (prev + 1) % Math.max(1, dollarSkills.length));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setDollarSelected((prev) => (prev - 1 + dollarSkills.length) % Math.max(1, dollarSkills.length));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          handleDollarSelect(dollarSkills[dollarSelected] || AGENT_SKILLS[0]);
          return;
        }
        if (e.key === 'Escape') {
          setDollarOpen(false);
          return;
        }
      }

      // Enter → send; Shift+Enter → newline
      if (e.key === 'Enter') {
        // IME composition Enter (confirming a candidate, e.g. Chinese pinyin)
        // must NOT send — without this guard one input session fires twice:
        // once on candidate-confirm, once on the real send.
        if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) {
          return;
        }
        if (e.shiftKey) {
          // Let the browser insert a newline naturally
          return;
        }
        e.preventDefault();
        // Busy Agent: Enter → queue; Ctrl/Cmd+Enter → interrupt & send now.
        if (isAgentSurface && currentAgentRunning && currentAgentId) {
          const text = inputValue.trim();
          if (!text) {
            handleSend();
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            sendQueueNow(text);
          } else {
            useChatStore.getState().enqueueAgentMessage(text);
            useChatStore.getState().setInputValue('');
            setToastMsg(t('composer.toast.queued'));
            setShowToast(true);
          }
          return;
        }
        handleSend();
      }
    },
    [
      commandOpen,
      commandItems,
      commandSelected,
      handleCommandSelect,
      mentionOpen,
      mentionSessions,
      mentionItems,
      mentionSelected,
      mentionQuery,
      handleMentionSelect,
      handleMentionSessionSelect,
      handleSend,
      dollarOpen,
      dollarSkills,
      dollarSelected,
      handleDollarSelect,
      isAgentSurface,
      currentAgentRunning,
      currentAgentId,
      inputValue,
      sendQueueNow,
      t,
      setCommandOpen,
      setCommandSelected,
      setDollarOpen,
      setDollarSelected,
      setMentionOpen,
      setMentionSelected,
    ],
  );

  const {
    pendingImages,
    removePendingImage,
    appendFiles,
    handleDrop,
    handleDragOver,
    pickFiles,
    handleMicClick,
    pickProjectDirectory,
  } = useChatInputFiles({ inputValue, t });

  return {
    t,
    accountName,
    resolvedPosition,
    heroSizing,
    isCenter,
    isFlowCenter,
    isAgentSurface,
    projectPath,
    sidebarMode,
    isStreaming,
    currentAgentId,
    currentAgentStatus,
    currentAgentRunning,
    toastMsg,
    showToast,
    setShowToast,
    isFocused,
    setIsFocused,
    gitBranch,
    pendingPlanMode,
    pendingToolChoice,
    setPendingToolChoice,
    permissionPreset,
    setPermissionPreset,
    workAutonomyTier,
    pendingPlan,
    textareaRef,
    isWebSearch,
    toggleWebSearch,
    isDeepThink,
    toggleDeepThink,
    inputValue,
    handleInputChange,
    handleKeyDownWithMention,
    moreTriggerRef,
    smartMore,
    containerRef,
    mentionOpen,
    mentionQuery,
    mentionIndex,
    mentionItems,
    mentionSessions,
    mentionSelected,
    setMentionOpen,
    setMentionIndex,
    setMentionSelected,
    commandOpen,
    commandQuery,
    commandIndex,
    commandItems,
    commandSelected,
    setCommandOpen,
    setCommandIndex,
    setCommandSelected,
    dollarOpen,
    dollarIndex,
    dollarQuery,
    dollarSelected,
    setDollarOpen,
    setDollarIndex,
    setDollarSelected,
    dollarSkills,
    handleMentionSelect,
    handleMentionSessionSelect,
    handleDollarSelect,
    handleCommandSelect,
    modeTriggerRef,
    modePanelRef,
    modePanelOpen,
    setModePanelOpen,
    modePanelPos,
    closeModePanel,
    toggleModePanel,
    toggleMoreMenu,
    handleBlur,
    hasInput,
    micSupported,
    pendingImages,
    removePendingImage,
    appendFiles,
    handleDrop,
    handleDragOver,
    pickFiles,
    handleMicClick,
    pickProjectDirectory,
    handleSend,
    sendQueueNow,
  };
}
