import { useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { errorText } from '../../../electron/errors';
import { message } from 'antd';
import { useSmartDropdown, type DropdownPosition } from '../../hooks/useSmartDropdown';
import clsx from 'clsx';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useInspectorStore, selectPendingPlan } from '../../stores/useInspectorStore';
import { useAutoResize } from '../../hooks/useAutoResize';
import { useSettingsStore } from '../../stores/useSettingsStore';
import ChatInputComposer from './ChatInputComposer';
import { useChatInputMentions } from './useChatInputMentions';
import { executeLeadingCommand, launchAgentTask, recordCommand } from './ChatInputActions';
import { useChatInputFiles } from './useChatInputFiles';
import { useT } from '../../i18n';
import {
  greeting,
  type ChatInputProps,
} from './ChatInputUtils';
import GhostToast from '../layout/GhostToast';
import { SLASH_COMMANDS, executeCommand, type SlashCommand } from '../../constants/commands';
import { findPluginCommand } from '../../utils/slashCommands';
import { useAgentStore } from '../../stores/useAgentStore';
import { AGENT_SKILLS, type AgentSkill } from '../../core/skills';
import { useAuthStore } from '../../stores/useAuthStore';
import logoPng from '../../assets/auraxis-logo.png';
import { speechRecognitionConstructor } from './SpeechRecognition';
export default function ChatInput({ position, heroSubtitleKey }: ChatInputProps) {
  const t = useT();
  const accountName = useAuthStore((s) => s.name);
  // Re-render every minute so the greeting follows the real clock across
  // morning / afternoon / evening boundaries while the app stays open.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const messagesLen = useChatStore((s) => s.messages.length);
  const resolvedPosition = position ?? (messagesLen === 0 ? 'center' : 'bottom');
  const isCenter = resolvedPosition === 'center';
  const isFlowCenter = resolvedPosition === 'center-flow';
  const heroSizing = isCenter || isFlowCenter;
  const inputValue = useChatStore((s) => s.inputValue);
  const setInputValue = useChatStore((s) => s.setInputValue);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
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
  const modeTriggerRef = useRef<HTMLButtonElement>(null);
  const smartMore = useSmartDropdown(moreTriggerRef, {
    panelHeight: 180,
    gap: 10,
    direction: heroSizing ? 'down' : 'up',
  });

  // ── Mode panel (direct state, no useSmartDropdown middleman) ──
  const [modePanelOpen, setModePanelOpen] = useState(false);
  const [modePanelPos, setModePanelPos] = useState<DropdownPosition | null>(null);
  const modePanelRef = useRef<HTMLDivElement>(null);
  // Refs for stable callbacks — avoids useCallback dance with changing deps
  const modePanelOpenRef = useRef(false);
  const isStreamingRef = useRef(isStreaming);
  const messagesLenRef = useRef(messagesLen);
  const smartMoreCloseRef = useRef(smartMore.close);
  smartMoreCloseRef.current = smartMore.close;

  // Keep refs in sync (no re-render side effect) — batched + layout for zero-delay
  useLayoutEffect(() => {
    modePanelOpenRef.current = modePanelOpen;
    isStreamingRef.current = isStreaming;
    messagesLenRef.current = messagesLen;
  });

  /* ── Panel mutual exclusion ── */
  const closeModePanel = useCallback(() => setModePanelOpen(false), []);

  // Wrap more-menu toggle with mutual exclusion
  const toggleMoreMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!smartMore.open) setModePanelOpen(false);
      smartMore.toggle(e);
    },
    [smartMore],
  );

  // STABLE callback — refs bypass stale-closure, functional update avoids !isOpen
  const toggleModePanel = useCallback((e: React.MouseEvent) => {
    // 防御1: 斩断事件冒泡，防止触发全局 ClickOutside
    e.stopPropagation();
    e.preventDefault();

    if (!modePanelOpenRef.current) smartMoreCloseRef.current();

    // 防御2: 函数式更新，永不依赖过期的闭包值
    setModePanelOpen((prev) => {
      const next = !prev;
      return next;
    });
  }, []); // ← 空依赖！永不重建，永不触发 ModeTrigger 重渲染

  // Recalc mode panel position when it opens
  const recalcModePanelPos = useCallback(() => {
    const trigger = modeTriggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 10;
    // Agent/Work input is pinned to the bottom — always pop up.
    // Chat mode start page has the input centered — pop down.
    // 统一规则：输入框居中时向下弹，贴底时向上弹。
    const dropUp = !heroSizing;
    setModePanelPos({
      left: rect.left,
      direction: dropUp ? 'up' : 'down',
      ...(dropUp ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
    });
  }, [heroSizing]);

  useEffect(() => {
    if (modePanelOpen) {
      recalcModePanelPos();
      window.addEventListener('resize', recalcModePanelPos);
      window.addEventListener('scroll', recalcModePanelPos, true);
    }
    return () => {
      window.removeEventListener('resize', recalcModePanelPos);
      window.removeEventListener('scroll', recalcModePanelPos, true);
    };
  }, [modePanelOpen, recalcModePanelPos]);

  // 状态栏等外部入口请求打开模型选择面板。
  useEffect(() => {
    if (modelPanelRequest > 0) {
      setModePanelOpen(true);
      recalcModePanelPos();
      // 消费请求：否则历史请求会在组件重挂载时自动重放打开面板。
      useChatStore.getState().consumeModelPanelRequest();
    }
  }, [modelPanelRequest, recalcModePanelPos]);

  // 切换模式时关闭模型面板，避免面板跨模式“自动弹出”。
  useEffect(() => {
    setModePanelOpen(false);
  }, [sidebarMode]);

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

  // Code mode: each send launches a new parallel Agent task (via the
  // background agent engine), instead of a plain chat turn.
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

  /** Executes a leading slash command when the user presses Enter directly. */
  const tryExecuteLeadingCommand = useCallback(
    (raw: string) => executeLeadingCommand(raw, setInputValue, t),
    [setInputValue, t],
  );

  const handleSend = useCallback(() => {
    // In code mode the send button becomes a STOP control while the current
    // task is busy — this must win over slash commands / typing state.
    if (isAgentSurface && currentAgentRunning && currentAgentId) {
      const text = inputValue.trim();
      if (text) {
        // 有输入时：排队续写，任务结束后自动跟进
        useChatStore.getState().enqueueAgentMessage(text);
        useChatStore.getState().setInputValue('');
        setToastMsg(t('composer.toast.queued'));
        setShowToast(true);
        return;
      }
      useAgentStore.getState().stopAgent(currentAgentId);
      return;
    }
    // Leading slash commands run in both modes before anything else.
    if (tryExecuteLeadingCommand(inputValue)) return;
    if (isStreaming) {
      const hasText = inputValue.trim().length > 0;
      stopStreaming();
      // Chat 模式：允许生成期间起草，按发送 = 停止当前生成并立即发出新消息。
      if (hasText && !isAgentSurface) window.setTimeout(() => sendMessage(), 0);
      return;
    }
    if (!inputValue.trim()) return;
    if (isAgentSurface) {
      startCodeTask(inputValue);
      return;
    }
    sendMessage();
  }, [
    inputValue,
    isStreaming,
    sendMessage,
    stopStreaming,
    isAgentSurface,
    currentAgentId,
    currentAgentRunning,
    startCodeTask,
    tryExecuteLeadingCommand,
    t,
  ]);

  /** Guards the auto-drain effect against explicit "interrupt & send now" flows. */
  const explicitInterruptRef = useRef(false);

  /** Queue action: interrupt the current task and send a queued/typed message now. */
  const sendQueueNow = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (isAgentSurface && currentAgentRunning && currentAgentId) {
        // The settle transition from this explicit stop would otherwise trip
        // the auto-drain effect and fire the NEXT queued message as well.
        explicitInterruptRef.current = true;
        await useAgentStore.getState().stopAgent(currentAgentId);
        setToastMsg(t('composer.toast.interrupted'));
        setShowToast(true);
      }
      void startCodeTask(trimmed, { clearInput: false });
    },
    [currentAgentId, currentAgentRunning, isAgentSurface, startCodeTask, t],
  );

  // Auto-continue: a message queued while the task was busy dispatches as a
  // follow-up once the current task settles. One at a time — the next queued
  // message waits for the next terminal transition, so 续写 runs sequentially.
  const prevAgentStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevAgentStatusRef.current;
    prevAgentStatusRef.current = currentAgentStatus;
    if (!isAgentSurface || !currentAgentId) return;
    const wasBusy = prev === 'running' || prev === 'queued' || prev === 'paused';
    const settled =
      currentAgentStatus === 'completed' || currentAgentStatus === 'error' || currentAgentStatus === 'stopped';
    if (!wasBusy) {
      // A stale guard (explicit stop that never produced a busy→settled
      // transition) must not suppress a later real drain.
      explicitInterruptRef.current = false;
      return;
    }
    if (explicitInterruptRef.current) {
      // The explicit "send now" flow already launched the next run.
      explicitInterruptRef.current = false;
      return;
    }
    if (!settled) return;
    const next = useChatStore.getState().agentQueue[0];
    if (!next) return;
    useChatStore.getState().dequeueAgentMessage(next.id);
    void startCodeTask(next.text, { clearInput: false });
  }, [currentAgentStatus, currentAgentId, isAgentSurface, startCodeTask]);

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

  /* ── Click outside → close custom panels ── */
  const { close: smartMoreClose, panelRef: smartMorePanelRef } = smartMore;
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // 触发按钮已在 container 内 → 放行
      if (containerRef.current?.contains(target)) return;
      // Portal 面板自身 DOM → 放行（防止菜单项点击被误杀）
      if (modePanelRef.current?.contains(target)) return;
      if (smartMorePanelRef.current?.contains(target)) return;
      setModePanelOpen(false);
      smartMoreClose();
      setDollarOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [smartMoreClose, smartMorePanelRef, setDollarOpen]);

  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const activeEl = document.activeElement;
      if (containerRef.current?.contains(activeEl)) return;
      // 焦点在 Portal 面板内（面板在 body 上，不在 container 内）→ 放行
      if (modePanelRef.current?.contains(activeEl)) return;
      if (smartMorePanelRef.current?.contains(activeEl)) return;
      setIsFocused(false);
      smartMoreClose();
      setMentionOpen(false);
      setCommandOpen(false);
      setDollarOpen(false);
    });
  }, [smartMoreClose, smartMorePanelRef, setCommandOpen, setDollarOpen, setMentionOpen]);

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

  const inputCard = (
    <ChatInputComposer
      heroSizing={heroSizing}
      isAgentSurface={isAgentSurface}
      sidebarMode={sidebarMode}
      position={resolvedPosition}
      isFocused={isFocused}
      sendQueueNow={sendQueueNow}
      removePendingImage={removePendingImage}
      toggleModePanel={toggleModePanel}
      pickProjectDirectory={pickProjectDirectory}
      projectPath={projectPath}
      gitBranch={gitBranch}
      pendingPlan={pendingPlan}
      pendingImages={pendingImages}
      textareaRef={textareaRef}
      inputValue={inputValue}
      handleInputChange={handleInputChange}
      handleKeyDownWithMention={handleKeyDownWithMention}
      appendFiles={appendFiles}
      setIsFocused={setIsFocused}
      handleBlur={handleBlur}
      commandOpen={commandOpen}
      commandItems={commandItems}
      commandSelected={commandSelected}
      handleCommandSelect={handleCommandSelect}
      setCommandSelected={setCommandSelected}
      mentionOpen={mentionOpen}
      mentionItems={mentionItems}
      mentionSessions={mentionSessions}
      mentionSelected={mentionSelected}
      handleMentionSelect={handleMentionSelect}
      handleMentionSessionSelect={handleMentionSessionSelect}
      setMentionSelected={setMentionSelected}
      dollarOpen={dollarOpen}
      dollarSkills={dollarSkills}
      dollarQuery={dollarQuery}
      dollarSelected={dollarSelected}
      handleDollarSelect={handleDollarSelect}
      setDollarSelected={setDollarSelected}
      moreTriggerRef={moreTriggerRef}
      smartMoreOpen={smartMore.open}
      smartMorePosition={smartMore.position}
      smartMorePanelRef={smartMore.panelRef}
      smartMoreClose={smartMore.close}
      toggleMoreMenu={toggleMoreMenu}
      pickFiles={pickFiles}
      pendingPlanMode={pendingPlanMode}
      workAutonomyTier={workAutonomyTier}
      pendingToolChoice={pendingToolChoice}
      setPendingToolChoice={setPendingToolChoice}
      permissionPreset={permissionPreset}
      setPermissionPreset={setPermissionPreset}
      isDeepThink={isDeepThink}
      toggleDeepThink={toggleDeepThink}
      isWebSearch={isWebSearch}
      toggleWebSearch={toggleWebSearch}
      micSupported={micSupported}
      handleMicClick={handleMicClick}
      hasInput={hasInput}
      isStreaming={isStreaming}
      currentAgentRunning={currentAgentRunning}
      handleSend={handleSend}
      modeTriggerRef={modeTriggerRef}
      modePanelOpen={modePanelOpen}
      modePanelPos={modePanelPos}
      modePanelRef={modePanelRef}
      closeModePanel={closeModePanel}
    />
  );

  return (
    <div
      ref={containerRef}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      className={clsx(
        'chat-input svg-center w-full flex flex-col items-center',
        isCenter
          ? 'absolute inset-0 flex items-center justify-center p-5 z-15 pointer-events-none'
          : isFlowCenter
            ? 'w-full max-w-[var(--content-max-width)] mx-auto relative z-10 px-2 py-1'
            : 'px-6 pb-5 shrink-0 relative z-20',
      )}
    >
      <GhostToast message={toastMsg} visible={showToast} onHide={() => setShowToast(false)} />

      {isCenter ? (
        <div className="ax-hero w-full pointer-events-auto">
          <div className="ax-hero-glow" />
          <div className="ax-hero-headline flex flex-col items-start w-full">
            <span className="flex items-center gap-2">
              <img src={logoPng} alt="Auraxis" className="w-9 h-9 object-contain" />
              {greeting()}
              {t('chat.greetingComma')}
              {accountName && <span>{accountName}</span>}
            </span>
            <span className="mt-1 text-md font-semibold leading-6 text-[var(--color-text-muted)]">
              {t(heroSubtitleKey ?? 'chat.heroPrompt')}
            </span>
          </div>
          {inputCard}
        </div>
      ) : (
        inputCard
      )}
    </div>
  );
}
