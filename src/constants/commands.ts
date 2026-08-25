import { Modal, message } from 'antd';
import { createElement } from 'react';
import { useAgentStore } from '../stores/useAgentStore';
import { useChatStore } from '../stores/useChatStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useProjectStore } from '../stores/useProjectStore';
import { useAppStore } from '../stores/useAppStore';
import { useSessionStore } from '../stores/useSessionStore';
import type { AgentPriority } from '../types/agent';
import { PERMISSION_PRESETS } from '../types/advanced';
import type { ApprovalPolicy, DeepSeekToolChoice, WorkAutonomyTier } from '../types/advanced';
import { fetchModels } from '../types/chat';
import { AGENT_SKILLS, startAgentSkill } from '../core/skills';
import { t, slashCommandDescKey } from '../i18n';

/** Goal mode iteration ceiling used by `/goal` (single source, no magic number). */
const DEFAULT_GOAL_MAX_ROUNDS = 256;

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: '清空当前对话', usage: '/clear' },
  { name: 'model', description: '切换 AI 模型', usage: '/model <name>' },
  {
    name: 'agent',
    description: '创建指定类型的 Agent 任务（Explore / Plan / 通用）',
    usage: '/agent <Explore|Plan|general-purpose>',
  },
  { name: 'goal', description: '进入目标模式，设置持续执行的目标', usage: '/goal <目标描述>' },
  { name: 'plan', description: '计划模式：先生成计划，批准后执行', usage: '/plan <任务描述>' },
  { name: 'tool', description: '指定下一个 Agent 任务的工具调用策略', usage: '/tool <auto|none|required|工具名>' },
  { name: 'review', description: '启动代码审查：只读审查 Agent + 变更面板', usage: '/review <范围>' },
  {
    name: 'skill',
    description: '启动快捷技能（代码审查 / Bug 修复 / 重构 / 测试 / 架构 / 功能）',
    usage: '/skill <技能名>',
  },
  { name: 'workflow', description: '运行脚本化多 Agent 工作流', usage: '/workflow <名称>' },
  { name: 'memories', description: '控制当前对话是否使用 / 写入记忆', usage: '/memories <on|off>' },
  { name: 'feedback', description: '记录一条本地反馈（帮助改进 Auraxis）', usage: '/feedback <内容>' },
  { name: 'theme', description: '切换界面主题', usage: '/theme <system|light|dark>' },
  { name: 'help', description: '显示帮助信息', usage: '/help' },
];

export function createAgent(params: {
  name: string;
  type: 'Explore' | 'Plan' | 'general-purpose';
  instruction?: string;
  /** UI-facing task description (user's literal words). Falls back to instruction. */
  displayText?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
  tools?: string[];
  isDeepThink?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  toolChoice?: DeepSeekToolChoice;
  priority?: AgentPriority;
  autoApprove?: boolean;
  mode?: ApprovalPolicy;
  workTier?: WorkAutonomyTier;
  workspaceRoots?: string[];
  writableRoots?: string[];
  sandboxMode?: 'read' | 'workspace-write' | 'full';
  goal?: { text: string; maxRounds: number } | null;
}): Promise<string | null> {
  const chatState = useChatStore.getState();
  const settingsState = useSettingsStore.getState();
  const model = params.model || chatState.selectedModel;
  const apiKey = settingsState.deepseekApiKey;
  const projectPath = chatState.currentProjectPath || settingsState.projectPath || '';
  // 所有 Agent 创建路径统一携带项目多根，斜杠命令也不会漏。
  const activeProject = projectPath
    ? useProjectStore.getState().projects.find((p) => p.path === projectPath)
    : undefined;

  const agentStore = useAgentStore.getState();
  // startAgent throws on backend rejection (e.g. invalid project dir) —
  // surface it as a toast and resolve null so callers stay simple.
  return agentStore
    .startAgent(
      {
        name: params.name,
        description: params.instruction || '',
        displayDescription: params.displayText,
        type: params.type,
        model,
        apiKey: apiKey || '',
        projectRoot: projectPath,
        priority: params.priority ?? 'normal',
        maxIterations: params.maxIterations ?? 200,
        customTools: params.tools as any,
        // All agent creation paths honor the selected permission preset;
        // the legacy chatState.autoApprove flag no longer drives tasks.
        autoApprove: params.autoApprove ?? PERMISSION_PRESETS[settingsState.permissionPreset].autoApprove,
        isDeepThink: params.isDeepThink ?? true,
        reasoningEffort: params.reasoningEffort ?? 'high',
        toolChoice: params.toolChoice,
        mode: params.mode,
        workTier: params.workTier,
        workspaceRoots:
          params.workspaceRoots ??
          (activeProject?.roots && activeProject.roots.length > 0 ? activeProject.roots : undefined),
        writableRoots:
          params.writableRoots ??
          (activeProject?.writableRoots && activeProject.writableRoots.length > 0
            ? activeProject.writableRoots
            : undefined),
        // Explicit per-task sandbox wins; otherwise the preset's boundary is
        // carried on the task itself (immune to backend settings write races).
        sandboxMode: params.sandboxMode ?? PERMISSION_PRESETS[settingsState.permissionPreset].sandboxMode,
        goal: params.goal,
      },
      projectPath,
    )
    .catch((err: Error) => {
      message.error(err.message || t('cmd.msg.taskStartFailed'));
      return null;
    });
}

export function executeCommand(
  name: string,
  args: string,
  ctx: {
    clearMessages: () => void;
    setSelectedModel: (model: string) => void;
    setInputValue: (value: string) => void;
    toggleTheme: () => void;
    theme: string;
  },
): boolean {
  const trimmedArgs = args.trim();

  switch (name) {
    case 'clear':
      ctx.clearMessages();
      return true;

    case 'model': {
      if (!trimmedArgs) {
        ctx.setInputValue('/model ');
        return false;
      }
      void fetchModels().then((models) => {
        const match = models.find((m) => m.id === trimmedArgs || m.name === trimmedArgs);
        if (!match) {
          message.error(t('cmd.msg.modelNotFound', { name: trimmedArgs }));
          ctx.setInputValue('');
          return;
        }
        ctx.setSelectedModel(match.id);
        ctx.setInputValue('');
      });
      return true;
    }

    case 'agent': {
      if (!trimmedArgs) {
        ctx.setInputValue('/agent ');
        return false;
      }
      const agentType = trimmedArgs as 'Explore' | 'Plan' | 'general-purpose';
      if (!['Explore', 'Plan', 'general-purpose'].includes(agentType)) {
        ctx.setInputValue(`/agent `);
        return false;
      }
      useAppStore.getState().setSidebarMode('code');
      void createAgent({ name: `${agentType} Agent`, type: agentType }).then((id) => {
        if (id) useAgentStore.getState().setCurrentAgent(id);
      });
      ctx.setInputValue('');
      return true;
    }

    case 'goal': {
      if (!trimmedArgs) {
        ctx.setInputValue('/goal ');
        return false;
      }
      const goal = {
        text: trimmedArgs,
        status: 'running' as const,
        startedAt: Date.now(),
      };
      useChatStore.getState().setGoal(goal);
      const sessionId = useSessionStore.getState().currentSessionId;
      if (sessionId && window.electronAPI?.goal) {
        void window.electronAPI.goal.create(sessionId, trimmedArgs, DEFAULT_GOAL_MAX_ROUNDS);
      }
      ctx.setInputValue('');
      message.success(t('cmd.msg.goalStarted'));
      return true;
    }

    case 'skill': {
      const skill = AGENT_SKILLS.find(
        (s) =>
          s.name === trimmedArgs ||
          s.key === trimmedArgs ||
          s.name.toLowerCase() === trimmedArgs.toLowerCase() ||
          s.key.toLowerCase() === trimmedArgs.toLowerCase(),
      );
      if (!skill) {
        // Fall through to the real SKILL.md registry before asking for more input.
        void (async () => {
          const list = await window.electronAPI?.skills?.list();
          const match = (list?.data?.skills ?? []).find(
            (s) => s.name === trimmedArgs || s.name.toLowerCase() === trimmedArgs.toLowerCase(),
          );
          if (!match) {
            message.error(t('cmd.msg.skillNotFound', { name: trimmedArgs }));
            return;
          }
          const read = await window.electronAPI?.skills?.read(match.name);
          const body = read?.ok && read.data?.body ? read.data.body : '';
          const id = await createAgent({
            name: match.name,
            type: 'general-purpose',
            instruction: body || match.description || match.name,
            displayText: `${match.name}：${match.description || ''}`,
          });
          if (id) useAgentStore.getState().setCurrentAgent(id);
        })();
        ctx.setInputValue('');
        return true;
      }
      useAppStore.getState().setSidebarMode('code');
      startAgentSkill(skill);
      ctx.setInputValue('');
      return true;
    }

    case 'plan': {
      const chat = useChatStore.getState();
      // Plan-first is the Work mode personality — /plan enters it directly.
      useAppStore.getState().setSidebarMode('work');
      if (trimmedArgs) {
        chat.setPendingPlanMode(false);
        void createAgent({
          name: trimmedArgs.length > 24 ? trimmedArgs.slice(0, 24) + '…' : trimmedArgs,
          type: 'general-purpose',
          instruction: trimmedArgs,
          displayText: trimmedArgs,
          mode: 'plan',
          autoApprove: PERMISSION_PRESETS[useSettingsStore.getState().permissionPreset].autoApprove,
        }).then((id) => {
          if (id) {
            useAgentStore.getState().setCurrentAgent(id);
            message.success(t('cmd.msg.planStarted'));
          }
        });
      } else {
        chat.setPendingPlanMode(true);
        message.success(t('cmd.msg.planArmed'));
      }
      ctx.setInputValue('');
      return true;
    }

    case 'tool': {
      const chat = useChatStore.getState();
      const arg = trimmedArgs.trim();
      if (!arg) {
        message.info(t('cmd.msg.toolChoiceUsage'));
        return true;
      }
      if (arg === 'auto' || arg === 'none' || arg === 'required') {
        chat.setPendingToolChoice(arg);
      } else {
        chat.setPendingToolChoice({ type: 'function', function: { name: arg } });
      }
      message.success(t('cmd.msg.toolChoiceSet', { tool: arg }));
      ctx.setInputValue('');
      return true;
    }

    case 'review': {
      const scope = trimmedArgs || t('cmd.msg.reviewScope');
      void createAgent({
        name: t('cmd.msg.reviewName'),
        type: 'Explore',
        instruction: `请对当前项目的「${scope}」进行代码审查：检查逻辑错误、安全漏洞、性能问题与边界条件。对每个问题给出文件路径、行号和修复建议，最后按严重程度排序输出。只读分析，不要修改任何文件。`,
        displayText: t('cmd.msg.reviewDisplay', { scope }),
        mode: 'ask',
        autoApprove: false,
        sandboxMode: 'read',
      }).then((id) => {
        if (id) {
          useAgentStore.getState().setCurrentAgent(id);
          useAppStore.getState().setSidebarMode('code');
          useAppStore.getState().setRightPanelView('review');
          if (!useAppStore.getState().showRightPanel) useAppStore.getState().toggleRightPanel();
          ctx.setInputValue('');
          message.success(t('cmd.msg.reviewStarted'));
        }
      });
      return true;
    }

    case 'workflow': {
      if (!trimmedArgs) {
        ctx.setInputValue('/workflow ');
        return false;
      }
      const projectRoot = useSettingsStore.getState().projectPath;
      if (!projectRoot) {
        ctx.setInputValue('');
        message.warning(t('cmd.msg.needProject'));
        return true;
      }
      void (async () => {
        const list = await window.electronAPI?.workflow?.list(projectRoot);
        const def = (list?.data || []).find((d) => d.id === trimmedArgs || d.name === trimmedArgs);
        if (!def) {
          message.error(t('cmd.msg.workflowNotFound', { name: trimmedArgs }));
          return;
        }
        const r = await window.electronAPI?.workflow?.run({ workflowId: def.id, projectRoot });
        if (r?.ok) message.success(t('cmd.msg.workflowStarted', { id: r.data?.runId ?? '' }));
        else message.error(r?.error || t('cmd.msg.startFailed'));
      })();
      ctx.setInputValue('');
      return true;
    }

    case 'memories': {
      if (!trimmedArgs || !['on', 'off'].includes(trimmedArgs)) {
        ctx.setInputValue('/memories ');
        return false;
      }
      useChatStore.getState().setMemoriesEnabled(trimmedArgs === 'on');
      ctx.setInputValue('');
      message.success(trimmedArgs === 'on' ? t('cmd.msg.memoriesOn') : t('cmd.msg.memoriesOff'));
      return true;
    }

    case 'feedback': {
      if (!trimmedArgs) {
        ctx.setInputValue('/feedback ');
        return false;
      }
      void window.electronAPI?.feedback?.submit(trimmedArgs).then((r) => {
        if (r?.ok) message.success(t('cmd.msg.feedbackRecorded'));
        else message.error(r?.error || t('cmd.msg.feedbackFailed'));
      });
      ctx.setInputValue('');
      return true;
    }

    case 'theme': {
      if (!trimmedArgs || !['system', 'dark', 'light'].includes(trimmedArgs)) {
        ctx.setInputValue('/theme ');
        return false;
      }
      const appState = useAppStore.getState();
      appState.setTheme(trimmedArgs as 'system' | 'dark' | 'light');
      ctx.setInputValue('');
      return true;
    }

    case 'help':
      ctx.setInputValue('');
      Modal.info({
        title: t('cmd.msg.availableCommands'),
        width: 520,
        content: createElement(
          'div',
          { className: 'flex flex-col gap-1' },
          SLASH_COMMANDS.map((c) =>
            createElement(
              'div',
              { key: c.name, className: 'text-xs text-text-secondary' },
              createElement('span', { className: 'font-mono text-primary' }, c.usage),
              ' — ',
              t(slashCommandDescKey(c.name)),
            ),
          ),
        ),
      });
      return true;

    default:
      return false;
  }
}
