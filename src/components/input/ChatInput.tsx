import { useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { errorText } from '../../../electron/errors';
import {
  Brain,
  Desktop as DesktopIcon,
  FileText as FileTextIcon,
  FolderOpen as FolderOpenIcon,
  GitBranch as GitBranchIcon,
  GlobeHemisphereWest,
  Wrench,
  Image as ImageIcon,
  Paperclip,
  Plus,
  ListChecks,
  Microphone,
  Play,
  ArrowUp,
  X as CloseIcon,
} from '@/components/common/icons';
import { Tooltip, message } from 'antd';
import { useSmartDropdown, type DropdownPosition } from '../../hooks/useSmartDropdown';
import clsx from 'clsx';
import { useChatStore } from '../../stores/useChatStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSessionStore } from '../../stores/useSessionStore';
import { useInspectorStore, selectPendingPlan } from '../../stores/useInspectorStore';
import { useAutoResize } from '../../hooks/useAutoResize';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useProjectStore } from '../../stores/useProjectStore';
import MentionDropdown from './MentionDropdown';
import SkillMentionDropdown from './SkillMentionDropdown';
import CommandDropdown from './CommandDropdown';
import InputDock from './InputDock';
import PlanApprovalPanel from './PlanApprovalPanel';
import ContextMeter from './ContextMeter';
import { ModeTrigger, ModePanelContent } from './ModeToggler';
import PermissionSelector from './PermissionSelector';
import WorkTierSelector from './WorkTierSelector';
import { resolveSessionRefs } from '../../utils/sessionRefs';
import { resolveFollowTarget } from '../../utils/followTarget';
import { t, useT, agentSkillNameKey, type I18nKey } from '../../i18n';
import { mapThinkingLevelToEffort } from '../../types/chat';
import { PERMISSION_PRESETS, type PermissionPreset } from '../../types/advanced';
import type { WorkAutonomyTier } from '../../types/advanced';
import GhostToast from '../layout/GhostToast';
import { SLASH_COMMANDS, executeCommand, createAgent, type SlashCommand } from '../../constants/commands';
import { listSlashCommands, findPluginCommand, resolveSkillRefs } from '../../utils/slashCommands';
import { scrubSandboxPaths } from '../../utils/scrub';
import { useAgentStore } from '../../stores/useAgentStore';
import { AGENT_SKILLS, type AgentSkill } from '../../core/skills';
import { useAuthStore } from '../../stores/useAuthStore';
import logoPng from '../../assets/auraxis-logo.png';

function greeting(now = Date.now()): string {
  const h = new Date(now).getHours();
  if (h < 6) return t('chat.greeting.night');
  if (h < 12) return t('chat.greeting.morning');
  if (h < 18) return t('chat.greeting.afternoon');
  return t('chat.greeting.evening');
}

interface PendingImage {
  name: string;
  dataUrl: string;
  start: number;
  end: number;
}

/** Parse `【图片: name】\n<dataUrl>` blocks currently sitting in the composer. */
function parsePendingImages(text: string): PendingImage[] {
  const out: PendingImage[] = [];
  const re = /【图片: ([^\n】]*)】\s*\n?(data:image\/[^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ name: m[1] || t('chat.image'), dataUrl: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

interface ChatInputProps {
  position?: 'center' | 'center-flow' | 'bottom';
  /** 居中 Hero 模式的副标题文案 key（默认聊天通用提示）。 */
  heroSubtitleKey?: I18nKey;
}

/** Preset → background-agent config (type + permission mode + auto-approve).
 *  The canonical mapping lives in electron/contracts/permission.ts — keep the
 *  two in sync; plan mode is armed separately via /plan / Work mode. */
function resolveAgentConfig(preset: PermissionPreset): {
  type: 'general-purpose';
  mode: 'ask' | 'auto';
  autoApprove: boolean;
} {
  const spec = PERMISSION_PRESETS[preset];
  return { type: 'general-purpose', mode: spec.mode, autoApprove: spec.autoApprove };
}

/** Plan overlay: approval becomes the authorization step, but the preset's
 *  autoApprove axis is preserved (full → bypass hygiene after approval). */
function resolvePlanAgentConfig(preset: PermissionPreset): {
  type: 'general-purpose';
  mode: 'plan';
  autoApprove: boolean;
} {
  return {
    type: 'general-purpose',
    mode: 'plan',
    autoApprove: PERMISSION_PRESETS[preset].autoApprove,
  };
}

/** Work 档位 → 后端审批策略。smart 走 ask + 分级门禁；full 走 auto +
 * 高危仍问；plan 走 plan（计划审批后计划内自动）。 */
function resolveWorkAgentConfig(tier: WorkAutonomyTier): {
  type: 'general-purpose';
  mode: 'ask' | 'plan' | 'auto';
  autoApprove: boolean;
} {
  if (tier === 'plan') return { type: 'general-purpose', mode: 'plan', autoApprove: false };
  if (tier === 'full') return { type: 'general-purpose', mode: 'auto', autoApprove: false };
  return { type: 'general-purpose', mode: 'ask', autoApprove: false };
}
function parseTreePaths(treeText: string): string[] {
  const lines = treeText.split('\n').filter(Boolean);
  const paths: string[] = [];
  const dirStack: { name: string; depth: number }[] = [];

  for (const line of lines) {
    const stripped = line.replace(/^[│\s]+/, '');
    const depth = (line.match(/^(?:│ {3}| {4})*/)?.[0]?.length ?? 0) / 4;
    const name = stripped.replace(/^[├└]── /, '');

    if (!name) continue;

    while (dirStack.length > 0 && dirStack[dirStack.length - 1].depth >= depth) {
      dirStack.pop();
    }

    if (name.endsWith('/')) {
      dirStack.push({ name: name.slice(0, -1), depth });
    } else {
      const dirPath = dirStack.map((d) => d.name).join('/');
      const fullPath = dirPath ? `${dirPath}/${name}` : name;
      paths.push(fullPath);
    }
  }

  return paths;
}

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

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(-1);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionSessions, setMentionSessions] = useState<{ id: string; title: string }[]>([]);
  const [mentionSelected, setMentionSelected] = useState(0);
  const [allFilePaths, setAllFilePaths] = useState<string[]>([]);
  const allSessions = useSessionStore((s) => s.sessions);
  const mentionFetchRef = useRef(0);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const containerRef = useRef<HTMLDivElement>(null);

  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandIndex, setCommandIndex] = useState(-1);
  const [commandItems, setCommandItems] = useState<SlashCommand[]>([]);
  const [commandSelected, setCommandSelected] = useState(0);

  // `$`-mention — 技能调用入口（目前仅前端）。
  const [dollarOpen, setDollarOpen] = useState(false);
  const [dollarIndex, setDollarIndex] = useState(-1);
  const [dollarQuery, setDollarQuery] = useState('');
  const [dollarSelected, setDollarSelected] = useState(0);

  const [backendSkills, setBackendSkills] = useState<AgentSkill[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.skills
      ?.list()
      .then((r) => {
        if (cancelled || !r?.ok || !r.data) return;
        setBackendSkills(
          r.data.skills.map((s) => ({
            key: s.name,
            name: s.name,
            description: s.description,
            type: 'general-purpose' as const,
            icon: 'feature' as const,
            instruction: s.whenToUse ? `${s.description}\n\n何时使用：${s.whenToUse}` : s.description,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const allSkills = useMemo(() => {
    const seen = new Set(AGENT_SKILLS.map((s) => s.name).concat(AGENT_SKILLS.map((s) => s.key)));
    return [...AGENT_SKILLS, ...backendSkills.filter((s) => !seen.has(s.name) && !seen.has(s.key))];
  }, [backendSkills]);

  const dollarSkills = useMemo(() => {
    const q = dollarQuery.trim().toLowerCase();
    return allSkills.filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.key.includes(q) ||
        t(agentSkillNameKey(s.key)).toLowerCase().includes(q),
    );
  }, [dollarQuery, allSkills, t]);

  const hasInput = inputValue.trim().length > 0;
  const micSupported = useMemo(
    () =>
      typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
    [],
  );

  useEffect(() => {
    resize();
  }, [inputValue, resize, isCenter]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!projectPath || !api?.context) {
      setAllFilePaths([]);
      return;
    }
    const fetchId = ++mentionFetchRef.current;
    void (async () => {
      const [tree, plans] = await Promise.all([
        api.context.getFileStructure(projectPath),
        api.plan?.list(projectPath) ?? Promise.resolve({ ok: false as const }),
      ]);
      if (fetchId !== mentionFetchRef.current) return;
      const paths = tree.ok && tree.data ? parseTreePaths(tree.data) : [];
      if (plans?.ok && plans.data) {
        for (const p of plans.data) {
          const rel = p.relative || p.name;
          if (rel) paths.push(rel);
        }
      }
      setAllFilePaths(paths);
    })();
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    if (!projectPath) {
      setGitBranch('');
      return;
    }
    window.electronAPI?.system
      ?.getGitBranches?.(projectPath)
      .then((r) => {
        if (cancelled) return;
        setGitBranch(r?.ok && r.data?.current ? r.data.current : '');
      })
      .catch(() => {
        if (!cancelled) setGitBranch('');
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    clearTimeout(mentionDebounceRef.current);
    mentionDebounceRef.current = setTimeout(() => {
      const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
      const textBefore = inputValue.slice(0, cursorPos);
      const lastAtIndex = textBefore.lastIndexOf('@');
      const lastSlashIdx = textBefore.lastIndexOf('/');
      const lastDollarIdx = textBefore.lastIndexOf('$');

      // Slash autocomplete works in both modes; Agent-only commands are
      // rejected at execution time instead of disappearing from discovery.
      if (lastSlashIdx > lastAtIndex && lastSlashIdx > lastDollarIdx) {
        const query = textBefore.slice(lastSlashIdx + 1);
        if (!query.includes(' ') && !query.includes('\n') && !query.includes('/')) {
          setCommandIndex(lastSlashIdx);
          setCommandQuery(query);
          const allCommands = listSlashCommands();
          const filtered = allCommands.filter((c) => c.name.startsWith(query.toLowerCase())).slice(0, 6);
          setCommandItems(filtered);
          setCommandSelected(0);
          setCommandOpen(filtered.length > 0);
        } else {
          setCommandOpen(false);
        }
        setMentionOpen(false);
        setDollarOpen(false);
      } else if (lastDollarIdx > lastAtIndex && isAgentSurface) {
        // `$`-mention: skill invocation entry (skills engine lands later).
        const query = textBefore.slice(lastDollarIdx + 1);
        if (!query.includes(' ') && !query.includes('\n') && !query.includes('$')) {
          setDollarIndex(lastDollarIdx);
          setDollarQuery(query);
          setDollarSelected(0);
          setDollarOpen(true);
        } else {
          setDollarOpen(false);
        }
        setMentionOpen(false);
        setCommandOpen(false);
      } else if (lastAtIndex >= 0) {
        const query = textBefore.slice(lastAtIndex + 1);
        if (!query.includes(' ') && !query.includes('\n') && !query.includes('@')) {
          setMentionIndex(lastAtIndex);
          setMentionQuery(query);
          const filtered = allFilePaths.filter((p) => p.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
          const sessionMatches = allSessions
            .filter((s) => (s.title || '').toLowerCase().includes(query.toLowerCase()))
            .slice(0, 4)
            .map((s) => ({ id: s.id, title: s.title }));
          setMentionItems(filtered);
          setMentionSessions(sessionMatches);
          setMentionSelected(0);
          setMentionOpen(filtered.length > 0 || sessionMatches.length > 0);
        } else {
          setMentionOpen(false);
        }
        setCommandOpen(false);
        setDollarOpen(false);
      } else {
        setMentionOpen(false);
        setCommandOpen(false);
        setDollarOpen(false);
      }
    }, 60);
    return () => clearTimeout(mentionDebounceRef.current);
  }, [inputValue, allFilePaths, allSessions, isAgentSurface, textareaRef]);

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
    async (instruction: string, opts?: { clearInput?: boolean }) => {
      const trimmed = instruction.trim();
      if (!trimmed) return;
      const withSkills = resolveSkillRefs(trimmed, allSkills);
      const resolved = resolveSessionRefs(withSkills, useSessionStore.getState().sessions);
      const instructionText = resolved.text;
      // Resolve the follow-up target FRESH at send time — never trust a captured
      // closure: the task may have settled (or been replaced) between renders.
      const chatState = useChatStore.getState();
      const agentState = useAgentStore.getState();
      const selectedAgent = agentState.currentAgentId
        ? (agentState.agents.find((a) => a.id === agentState.currentAgentId) ?? null)
        : null;
      const follow = resolveFollowTarget({
        selected: selectedAgent,
        agents: agentState.agents,
        pendingNewTask: chatState.pendingNewTask,
      });
      // A "start fresh" intent is consumed by this send (or skipped when an
      // explicit continuation target outranked it).
      if (chatState.pendingNewTask) chatState.setPendingNewTask(false);
      const isFollow = !!follow;
      const name = isFollow
        ? '↳ ' + (trimmed.length > 20 ? trimmed.slice(0, 20) + '…' : trimmed)
        : trimmed.length > 24
          ? trimmed.slice(0, 24) + '…'
          : trimmed;
      // Follow-up: seed the new agent with the prior task's goal + result so it
      // continues the thread. (Completed tasks free their worktree, so a fresh
      // agent with carried context is the sound way to continue.)
      // Sandbox paths in the prior result would lure the model into ls-ing the
      // agent-workspaces graveyard ("看看之前的项目") — scrub them out.
      const priorResult = scrubSandboxPaths(follow?.result || '（无结果记录）').slice(0, 2000);
      const finalInstruction = isFollow
        ? `请继续当前任务，在前序工作的基础上推进。\n\n【任务背景】\n${follow!.description || follow!.name}\n\n【当前进展】\n${priorResult}\n\n【现在请继续】\n${instructionText}\n\n请继续在同一个工作目录内工作，不要访问历史任务的沙箱目录。`
        : instructionText;
      // Same-task continuation: reuse the settled agent (id / workspace /
      // transcript) instead of spawning a NEW task.
      if (follow) {
        const cont = await useAgentStore.getState().continueAgent(follow.id, finalInstruction, instructionText);
        if (cont.ok) {
          if (opts?.clearInput !== false) useChatStore.getState().setInputValue('');
          useAgentStore.getState().setCurrentAgent(follow.id);
          return follow.id;
        }
        message.error(cont.error || t('composer.continueFailed'));
        return null;
      }
      const activeProjectPath =
        useChatStore.getState().currentProjectPath || useSettingsStore.getState().projectPath || '';
      if (!activeProjectPath) {
        message.error(t('composer.needProject'));
        return null;
      }
      // /plan arms the next send in plan mode; resolve fresh at send time.
      const planNext = useChatStore.getState().pendingPlanMode;
      if (planNext) useChatStore.getState().setPendingPlanMode(false);
      // /tool arms the next task's tool_choice; consume once.
      const toolChoice = useChatStore.getState().pendingToolChoice;
      if (toolChoice) useChatStore.getState().setPendingToolChoice(null);
      // Work 模式使用自己的执行档位；Code 模式仍走全局权限预设。
      const isWorkMode = useAppStore.getState().sidebarMode === 'work';
      const workTier = useAppStore.getState().workAutonomyTier;
      // /plan 显式武装时，Work 也强制计划审批（不随档位变化）。
      const effectiveWorkTier: WorkAutonomyTier = isWorkMode && planNext ? 'plan' : workTier;
      const cfg = isWorkMode
        ? resolveWorkAgentConfig(effectiveWorkTier)
        : planNext
          ? resolvePlanAgentConfig(permissionPreset)
          : resolveAgentConfig(permissionPreset);
      const activeGoal = useChatStore.getState().goal;
      // 项目多根：把当前项目的工作区根与可写根透传给 Agent 工具边界。
      const activeProject = activeProjectPath
        ? useProjectStore.getState().projects.find((p) => p.path === activeProjectPath)
        : undefined;
      const id = await createAgent({
        name,
        type: cfg.type,
        instruction: finalInstruction,
        // UI shows the user's literal words — the follow-up wrapper above is
        // backend prompt material and must never render in the task header.
        displayText: trimmed,
        model: selectedModel,
        // Work/Code 默认思考开启（Chat 由面板思考开关控制）。
        isDeepThink: true,
        // Map UI 3-level → API 3-level: low → low, medium → high, high → max
        reasoningEffort: mapThinkingLevelToEffort(reasoningEffort),
        toolChoice: toolChoice ?? undefined,
        priority: taskPriority,
        autoApprove: cfg.autoApprove,
        mode: cfg.mode,
        workTier: isWorkMode ? effectiveWorkTier : undefined,
        workspaceRoots: activeProject?.roots && activeProject.roots.length > 0 ? activeProject.roots : undefined,
        writableRoots:
          activeProject?.writableRoots && activeProject.writableRoots.length > 0
            ? activeProject.writableRoots
            : undefined,
        goal: activeGoal ? { text: activeGoal.text, maxRounds: 256 } : null,
      });
      if (id) {
        if (opts?.clearInput !== false) useChatStore.getState().setInputValue('');
        useAgentStore.getState().setCurrentAgent(id);
        // Goal-sourced turn: advance the durable round counter （目标状态）.
        const sessionId = useSessionStore.getState().currentSessionId;
        if (activeGoal && sessionId && window.electronAPI?.goal) {
          void window.electronAPI.goal.round(sessionId);
        }
      } else {
        message.error(t('composer.createFailed'));
      }
    },
    [selectedModel, permissionPreset, taskPriority, reasoningEffort, allSkills, t],
  );

  /** Executes a leading slash command when the user presses Enter directly. */
  const tryExecuteLeadingCommand = useCallback(
    (raw: string): boolean => {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('/')) return false;
      const spaceIdx = trimmed.indexOf(' ');
      const name = (spaceIdx >= 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
      const args = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
      const agentOnly = ['agent', 'goal', 'plan', 'memories', 'skill', 'review', 'workflow'];
      if (useAppStore.getState().sidebarMode === 'chat' && agentOnly.includes(name)) {
        message.info(t('composer.agentOnly'));
        return true;
      }
      const execCtx = {
        clearMessages: () => useChatStore.getState().clearMessages(),
        setSelectedModel: (model: string) => useChatStore.getState().setSelectedModel(model),
        setInputValue,
        toggleTheme: () => useAppStore.getState().toggleTheme(),
        theme: useAppStore.getState().theme,
      };
      const known = listSlashCommands().find((c) => c.name === name);
      if (known) {
        const executed = executeCommand(known.name, args, execCtx);
        if (executed) recordCommand(name, args);
        // Incomplete commands already set a `/name ` prompt in the composer;
        // consume the Enter either way so the text never reaches the model.
        return true;
      }
      const pluginCmd = findPluginCommand(name);
      if (pluginCmd) {
        try {
          const executed = pluginCmd.execute(args, execCtx);
          if (executed) recordCommand(name, args);
          return true;
        } catch (e: unknown) {
          message.error(t('composer.commandFailed', { name, error: errorText(e) }));
          return true;
        }
      }
      // Unknown or invalid command must never fall through to the model.
      message.error(t('composer.unknownCommand', { name }));
      setInputValue('');
      return true;
    },
    [setInputValue, t],
  );

  const recordCommand = (name: string, args: string) => {
    const sessionId = useSessionStore.getState().currentSessionId;
    const ts = Date.now();
    if (!sessionId) return;
    void window.electronAPI?.chatLog?.append(sessionId, [
      {
        type: 'command',
        ts,
        data: { name, args },
      },
    ]);
  };

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
    [inputValue, mentionIndex, setInputValue, textareaRef],
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
    [inputValue, mentionIndex, setInputValue, textareaRef],
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
    [inputValue, dollarIndex, setInputValue, textareaRef],
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
    [inputValue, commandIndex, commandQuery, setInputValue, textareaRef, t],
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
  }, [smartMoreClose, smartMorePanelRef]);

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
  }, [smartMoreClose, smartMorePanelRef]);

  // ── Image draft rail: live thumbnails for picked images in the composer ──
  const pendingImages = useMemo(() => parsePendingImages(inputValue), [inputValue]);
  const removePendingImage = useCallback(
    (index: number) => {
      const target = pendingImages[index];
      if (!target) return;
      const next = (inputValue.slice(0, target.start) + inputValue.slice(target.end)).replace(/^\n+/, '');
      setInputValue(next);
    },
    [pendingImages, inputValue, setInputValue],
  );

  /** 将文件/图片统一转为输入区文本块（选择、拖拽、粘贴共用）。 */
  const appendFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const parts: string[] = [];
      for (const file of files) {
        const isImage = file.type.startsWith('image/');
        if (isImage) {
          if (file.size > 5 * 1024 * 1024) {
            parts.push(t('composer.imageTooLarge', { name: file.name }));
            continue;
          }
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(file);
            });
            parts.push(`【图片: ${file.name}】\n${dataUrl}`);
          } catch {
            parts.push(t('composer.imageReadFailed', { name: file.name }));
          }
        } else {
          if (file.size > 100 * 1024) {
            parts.push(t('composer.attachmentTooLarge', { name: file.name }));
            continue;
          }
          try {
            const text = await file.text();
            const ext = file.name.includes('.') ? file.name.split('.').pop() : '';
            parts.push(`【附件: ${file.name}】\n\`\`\`${ext || ''}\n${text}\n\`\`\``);
          } catch {
            parts.push(t('composer.attachmentReadFailed', { name: file.name }));
          }
        }
      }
      if (parts.length > 0) {
        const { inputValue: iv, setInputValue: sv } = useChatStore.getState();
        sv(iv + (iv.trim() ? '\n\n' : '') + parts.join('\n\n'));
      }
    },
    [t],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      void appendFiles(Array.from(e.dataTransfer.files ?? []));
    },
    [appendFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const pickFiles = useCallback(
    (accept: string) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = accept;
      input.onchange = () => {
        void appendFiles(Array.from(input.files || []));
      };
      input.click();
    },
    [appendFiles],
  );

  const handleMicClick = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      message.info(t('composer.micUnavailable'));
      return;
    }
    try {
      const rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      rec.onerror = () => {
        message.error(t('composer.micPermission'));
      };
      rec.onresult = (e: any) => {
        const t = e.results[0][0].transcript?.trim();
        if (t) {
          const { inputValue: iv, setInputValue: sv } = useChatStore.getState();
          sv(iv + (iv.trim() ? ' ' : '') + t);
        }
      };
      rec.start();
      message.success(t('composer.listening'));
    } catch {
      message.error(t('composer.micFailed'));
    }
  }, [t]);

  /** Pick a project directory and keep every consumer in sync (settings +
   *  chat store). Shared by the hero chip and the composer toolbar pill. */
  const pickProjectDirectory = useCallback(async () => {
    const result = await window.electronAPI?.project.selectDirectory();
    if (result?.ok && result.data) {
      useSettingsStore.getState().setProjectPath(result.data);
      useChatStore.getState().setCurrentProjectPath(result.data);
      message.success(t('composer.projectDirSet', { path: result.data }));
    }
  }, [t]);

  /** 项目目录 · 本地 · Git 分支状态行：Work 在输入框下方，Code 在输入框上方。 */
  const renderWorkspaceStatus = (placement: 'above' | 'below') => (
    <div className={clsx('flex items-center gap-1.5', placement === 'above' ? 'mb-2' : 'mt-2')}>
      <button
        type="button"
        className="flex items-center gap-1.5 h-8 px-2.5 min-w-0 border-none bg-transparent text-xs text-text-secondary rounded-full cursor-pointer transition-[background,color] duration-fast hover:bg-[var(--color-hover)] hover:text-text-primary"
        aria-label={t('composer.selectProjectDir')}
        title={projectPath ?? t('composer.selectProjectDir')}
        onClick={pickProjectDirectory}
      >
        <FolderOpenIcon size={14} className="shrink-0 text-text-muted" />
        <span className="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap">
          {projectPath ? projectPath.split(/[\\/]/).pop() : t('composer.selectProjectDir')}
        </span>
      </button>
      <span className="w-px h-4 bg-[var(--color-border-dim)] shrink-0" aria-hidden="true" />
      <span className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs text-text-secondary rounded-full">
        <DesktopIcon size={14} className="shrink-0 text-text-muted" />
        {t('composer.local')}
      </span>
      {sidebarMode === 'work' && (
        <span
          className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs text-text-secondary rounded-full"
          title={t('work.docsOnlyTip')}
        >
          <FileTextIcon size={14} className="shrink-0 text-text-muted" />
          {t('work.docsOnly')}
        </span>
      )}
      {gitBranch && (
        <span
          className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs text-text-secondary rounded-full"
          title={t('composer.branchTip', { branch: gitBranch })}
        >
          <GitBranchIcon size={14} className="shrink-0 text-text-muted" />
          <span className="max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap">{gitBranch}</span>
        </span>
      )}
    </div>
  );

  const inputCard = (
    <div className="relative w-full max-w-[var(--content-max-width)] z-10">
      <div className="flex flex-col items-start w-full max-w-[var(--content-max-width)] mx-auto">
        <InputDock onSendNow={sendQueueNow} />
        {/* Workspace status：Code 恒在输入框上方；Work 居中时在下方、贴底时在上方。 */}
        {isAgentSurface && (sidebarMode !== 'work' || !heroSizing) && renderWorkspaceStatus('above')}
        {pendingPlan ? (
          <PlanApprovalPanel plan={pendingPlan} />
        ) : (
          <div
            className="ax-composer relative flex flex-col w-full max-w-[var(--content-max-width)] mx-auto"
            data-focused={isFocused || undefined}
          >
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
                {pendingImages.map((img, i) => (
                  <span
                    key={`${img.name}-${i}`}
                    className="flex items-center gap-1.5 h-12 pl-1 pr-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] rounded-lg"
                  >
                    <img src={img.dataUrl} alt={img.name} className="h-10 w-10 object-cover rounded-md" />
                    <span className="max-w-[120px] truncate text-2xs text-text-secondary">{img.name}</span>
                    <button
                      type="button"
                      className="flex items-center justify-center w-5 h-5 rounded-full text-text-muted cursor-pointer border-none bg-transparent hover:bg-[var(--color-hover)] hover:text-text-primary"
                      onClick={() => removePendingImage(i)}
                      aria-label={`${t('composer.removeImage')} ${img.name}`}
                      title={t('composer.removeImage')}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* Row 1: transparent textarea — full width, multi-line */}
            <div
              className={clsx(
                'w-full relative flex border-none bg-transparent outline-none shadow-none pl-4 pr-3 pt-1',
                heroSizing ? 'min-h-[52px]' : 'min-h-[40px]',
              )}
            >
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDownWithMention}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (files.length > 0) {
                    e.preventDefault();
                    void appendFiles(files);
                  }
                }}
                onFocus={() => setIsFocused(true)}
                onBlur={handleBlur}
                className={clsx(
                  'ax-composer-textarea',
                  heroSizing
                    ? 'text-lg leading-[30px] max-h-[240px] px-1'
                    : 'text-lg leading-[30px] max-h-[160px] px-1',
                )}
                placeholder={
                  sidebarMode === 'chat'
                    ? t('composer.placeholder.chat')
                    : pendingPlanMode
                      ? t('composer.placeholder.plan')
                      : t('composer.placeholder.agent')
                }
                rows={1}
              />
              {commandOpen && (
                <CommandDropdown
                  items={commandItems}
                  selected={commandSelected}
                  onSelect={handleCommandSelect}
                  onHover={setCommandSelected}
                  position={resolvedPosition}
                />
              )}
              {mentionOpen && (
                <MentionDropdown
                  items={mentionItems}
                  sessions={mentionSessions}
                  selected={mentionSelected}
                  onSelect={handleMentionSelect}
                  onSelectSession={handleMentionSessionSelect}
                  onHover={setMentionSelected}
                  position={resolvedPosition}
                />
              )}
              {dollarOpen && dollarSkills.length > 0 && (
                <SkillMentionDropdown
                  skills={dollarSkills}
                  query={dollarQuery}
                  selected={dollarSelected}
                  position={resolvedPosition}
                  onSelect={handleDollarSelect}
                  onHover={setDollarSelected}
                />
              )}
            </div>

            {/* Row 2: toolbar — attach/tools on the left, model · mic · send on the right */}
            <div className="ax-composer-toolbar">
              {/* Left: attach button + dropdown */}
              <div className="relative shrink-0">
                <button
                  ref={moreTriggerRef}
                  className={clsx('ax-icon-button', smartMore.open && '!bg-primary-soft !text-primary')}
                  onClick={toggleMoreMenu}
                  aria-label={t('composer.attach')}
                >
                  <Plus size={16} />
                </button>

                {smartMore.open &&
                  smartMore.position &&
                  createPortal(
                    <div
                      ref={smartMore.panelRef}
                      className="z-[1050] w-[168px] p-1 bg-[var(--color-bg-elevated)] rounded-xl border border-[var(--color-border-dim)] shadow-[var(--shadow-md)] flex flex-col opacity-0 translate-y-1 animate-[smartPanelIn_0.18s_ease_forwards]"
                      style={{
                        position: 'fixed',
                        left: `${smartMore.position.left}px`,
                        ...(smartMore.position.direction === 'up'
                          ? { bottom: `${smartMore.position.bottom}px` }
                          : { top: `${smartMore.position.top}px` }),
                      }}
                    >
                      <button
                        className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
                        onClick={() => {
                          pickFiles('*/*');
                          smartMore.close();
                        }}
                        type="button"
                      >
                        <span className="flex items-center justify-center w-4 h-4 shrink-0 text-text-muted">
                          <Paperclip size={16} />
                        </span>
                        <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">
                          {t('composer.uploadFile')}
                        </span>
                      </button>
                      <button
                        className="flex items-center gap-2 w-full min-h-8 px-2 py-1.5 border-none rounded-lg bg-transparent text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--color-hover)]"
                        onClick={() => {
                          pickFiles('image/*');
                          smartMore.close();
                        }}
                        type="button"
                      >
                        <span className="flex items-center justify-center w-4 h-4 shrink-0 text-text-muted">
                          <ImageIcon size={16} />
                        </span>
                        <span className="flex-1 min-w-0 text-sm leading-[20px] text-text-primary">
                          {t('composer.uploadImage')}
                        </span>
                      </button>
                    </div>,
                    document.body,
                  )}
              </div>

              {/* Agent-surface task settings — unified permission pill; plan mode
            is armed via /plan or Work mode's plan-first personality. */}
              {isAgentSurface && (
                <>
                  {pendingPlanMode && !(sidebarMode === 'work' && workAutonomyTier === 'plan') && (
                    <span
                      className="inline-flex items-center gap-1 self-center h-8 pl-2.5 pr-1 text-xs leading-5 font-medium text-primary bg-primary-soft rounded-full"
                      title={t('runmode.planTip')}
                    >
                      <ListChecks size={14} className="shrink-0" />
                      {t('runmode.plan')}
                      <button
                        type="button"
                        className="shrink-0 border-none bg-transparent cursor-pointer text-text-muted w-5 h-5 rounded-full flex items-center justify-center text-2xs leading-none hover:bg-[var(--color-hover)] hover:text-text-secondary"
                        onClick={() => useChatStore.getState().setPendingPlanMode(false)}
                        aria-label={t('runmode.cancelPlan')}
                      >
                        ✕
                      </button>
                    </span>
                  )}
                  {pendingToolChoice && (
                    <span
                      className="inline-flex items-center gap-1 self-center h-8 pl-2.5 pr-1 text-xs leading-5 font-medium text-primary bg-primary-soft rounded-full"
                      title={t('runmode.toolChoiceTip')}
                    >
                      <Wrench size={14} className="shrink-0" />
                      {typeof pendingToolChoice === 'string'
                        ? `tool: ${pendingToolChoice}`
                        : `tool: ${pendingToolChoice.function.name}`}
                      <button
                        type="button"
                        className="border-none bg-transparent cursor-pointer text-text-muted w-5 h-5 rounded-full flex items-center justify-center text-2xs leading-none hover:bg-[var(--color-hover)] hover:text-text-secondary"
                        onClick={() => setPendingToolChoice(null)}
                        aria-label={t('runmode.cancelToolChoice')}
                      >
                        ✕
                      </button>
                    </span>
                  )}
                  {sidebarMode === 'work' ? (
                    <WorkTierSelector popDirection={heroSizing ? 'down' : 'up'} />
                  ) : (
                    <PermissionSelector
                      preset={permissionPreset}
                      onChangePreset={setPermissionPreset}
                      popDirection={heroSizing ? 'down' : 'up'}
                    />
                  )}
                </>
              )}

              {/* Spacer — pushes the model · mic · send cluster to the right */}
              <div className="flex-1" />

              {/* Right: model selector + mic + send — ml-auto keeps it right-aligned
            even when the toolbar wraps onto a second line. */}
              <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                <ContextMeter />
                <ModeTrigger ref={modeTriggerRef} onClick={toggleModePanel} open={modePanelOpen} />

                {/* DeepSeek 风格：思考开关（Chat only），紧挨联网搜索 */}
                {sidebarMode === 'chat' && (
                  <Tooltip title={isDeepThink ? t('think.switchOn') : t('think.switchOff')} placement="top">
                    <button
                      className={clsx('ax-icon-button', isDeepThink && '!bg-primary-soft !text-primary')}
                      onClick={toggleDeepThink}
                      aria-label={t('think.switch')}
                      aria-pressed={isDeepThink}
                    >
                      <Brain size={16} weight={isDeepThink ? 'fill' : 'regular'} />
                    </button>
                  </Tooltip>
                )}

                {/* Web search toggle is chat-only: Agent mode already has the
              WebSearch/WebFetch tools, so the model searches on its own. */}
                {sidebarMode === 'chat' && (
                  <Tooltip title={isWebSearch ? t('composer.webSearchOn') : t('composer.webSearch')} placement="top">
                    <button
                      className={clsx('ax-icon-button', isWebSearch && '!bg-primary-soft !text-primary')}
                      onClick={toggleWebSearch}
                      aria-label={t('composer.webSearch')}
                      aria-pressed={isWebSearch}
                    >
                      <GlobeHemisphereWest size={16} weight={isWebSearch ? 'fill' : 'regular'} />
                    </button>
                  </Tooltip>
                )}

                {sidebarMode === 'chat' && micSupported && (
                  <Tooltip title={t('composer.mic')}>
                    <button className="ax-icon-button" onClick={handleMicClick} aria-label={t('composer.mic')}>
                      <Microphone size={16} />
                    </button>
                  </Tooltip>
                )}

                <button
                  type="button"
                  className={clsx('ax-send-button', (isStreaming || currentAgentRunning) && 'send-btn-stop')}
                  onClick={handleSend}
                  disabled={!hasInput && !isStreaming && !currentAgentRunning}
                  title={
                    currentAgentRunning
                      ? hasInput
                        ? t('composer.queueSend')
                        : t('composer.stopTask')
                      : isStreaming
                        ? hasInput
                          ? t('composer.sendAfterStop')
                          : t('composer.stopGenerate')
                        : isAgentSurface
                          ? t('composer.startTask')
                          : t('composer.send')
                  }
                  aria-label={
                    currentAgentRunning
                      ? hasInput
                        ? t('composer.queueSend')
                        : t('composer.stopTask')
                      : isStreaming
                        ? hasInput
                          ? t('composer.sendAfterStop')
                          : t('composer.stopGenerate')
                        : isAgentSurface
                          ? t('composer.startTask')
                          : t('composer.send')
                  }
                >
                  {isStreaming || currentAgentRunning ? (
                    hasInput ? (
                      <ArrowUp size={16} weight="bold" />
                    ) : (
                      <span className="inline-flex items-center justify-center w-5 h-5">
                        <span className="inline-block w-[10px] h-[10px] bg-current rounded-md" />
                      </span>
                    )
                  ) : isAgentSurface ? (
                    // Launch a parallel agent task — a "play/run" glyph
                    <Play size={16} weight="fill" />
                  ) : (
                    <ArrowUp size={16} weight="bold" />
                  )}
                </button>
              </div>
            </div>
            {/* /toolbar row */}

            {modePanelOpen &&
              modePanelPos &&
              createPortal(
                <div
                  ref={modePanelRef}
                  className={clsx(
                    'z-[1050] p-1 gap-1 w-[232px] bg-[var(--color-bg-elevated)] rounded-xl flex flex-col',
                    'shadow-[var(--shadow-md)]',
                    modePanelPos.direction === 'up'
                      ? 'animate-[smartPanelInUp_0.18s_ease_forwards]'
                      : 'animate-[smartPanelInDown_0.18s_ease_forwards]',
                  )}
                  style={{
                    position: 'fixed',
                    left: `${modePanelPos.left}px`,
                    width: '232px',
                    ...(modePanelPos.direction === 'up'
                      ? { bottom: `${modePanelPos.bottom}px` }
                      : { top: `${modePanelPos.top}px` }),
                  }}
                >
                  <ModePanelContent onSelect={closeModePanel} />
                </div>,
                document.body,
              )}
          </div>
        )}
        {sidebarMode === 'work' && heroSizing && renderWorkspaceStatus('below')}
      </div>
      {/* /inputGroup */}
    </div>
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
