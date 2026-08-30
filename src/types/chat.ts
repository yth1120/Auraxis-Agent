import type { ToolCall } from './tools';
import {
  BUILT_IN_MODELS as SHARED_MODELS,
  modelSupportsImageInput as sharedModelSupportsImageInput,
  type ModelDefinition,
  type ModelProvider,
} from '../../electron/types';
import type { ApiMessageContent } from '../../electron/types';
import type { PermissionRequest, DeepSeekToolChoice, WorkAutonomyTier } from './advanced';

export type AIModel = ModelDefinition;
export type { ModelProvider };

/** DeepSeek API reasoning_effort 三档（官方 low/high/max）。 */
export type ApiReasoningEffort = 'low' | 'high' | 'max';

/** UI 三档 → API 三档：轻度→low、中度→high、深度→max。 */
export function mapThinkingLevelToEffort(level: 'low' | 'medium' | 'high'): ApiReasoningEffort {
  return level === 'low' ? 'low' : level === 'high' ? 'max' : 'high';
}

export const BUILT_IN_MODELS: AIModel[] = SHARED_MODELS.map((m) => ({
  id: m.id,
  name: m.name,
  provider: m.provider,
  maxTokens: m.maxTokens,
  contextWindow: m.contextWindow,
  supportsImages: m.supportsImages,
  experimental: m.experimental,
  apiBase: m.apiBase,
}));

// ─── Content blocks for multi-modal messages ──────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { data: string; media_type: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Extract concatenated text from a ContentBlock array (for display/comparison). */
export function getContentText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

/** 渲染层复用主进程的视觉能力判断。 */
export function modelSupportsImageInput(model: string): boolean {
  return sharedModelSupportsImageInput(model);
}

const RAW_IMAGE_BLOCK_RE = /【图片: ([^\n】]*)】\s*\n?(data:image\/[^\s]+)/g;

/**
 * 将聊天消息转换为 API 内容。视觉模型会把输入区中的图片占位块解析成
 * OpenAI 兼容的 image_url 内容块；非视觉模型仍使用纯文本，避免 API 400。
 */
export function toApiMessageContent(content: string | ContentBlock[], supportsImages: boolean): ApiMessageContent {
  if (!supportsImages) return typeof content === 'string' ? content : getContentText(content);
  if (typeof content !== 'string') {
    return content.map((part) =>
      part.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } }
        : part,
    );
  }
  const parts: Record<string, unknown>[] = [];
  let cursor = 0;
  let matched = false;
  for (const match of content.matchAll(RAW_IMAGE_BLOCK_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: 'text', text: content.slice(cursor, index) });
    parts.push({ type: 'image_url', image_url: { url: match[2] ?? '' } });
    cursor = index + match[0].length;
    matched = true;
  }
  if (!matched) return content;
  if (cursor < content.length) parts.push({ type: 'text', text: content.slice(cursor) });
  return parts;
}

// ─── Plan approval ─────────────────────────────────────

export interface PlanStep {
  id: string;
  toolName: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type PlanStatus = 'pending' | 'approved' | 'rejected';

export interface PlanData {
  planId: string;
  steps: PlanStep[];
  status: PlanStatus;
  approvedStepIds?: string[];
  /** 计划持久化到的 Markdown 文件路径。 */
  filePath?: string;
  /** Owning scheduler task — absent for legacy query-path plans. */
  agentId?: string;
}

// ─── Session & Message ────────────────────────────────

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  timestamp: number;
  codeBlocks?: CodeBlock[];
  thinkingBlocks?: { content: string }[];
  /** Whether this request had thinking enabled（Chat 开关；Agent 恒为 true）。
   *  关闭时即使模型泄漏 <thinking> 标签也不展示思考块。 */
  thinkingEnabled?: boolean;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  tags?: ('warning' | 'error' | 'system' | 'injected')[];
  /** Plan data received via plan:generated IPC event (plan approval mode). */
  plan?: PlanData;
  /** Context-compaction checkpoint — rendered as an inline foldable row. */
  compaction?: CompactionData;
  /** Injected-context disclosure — rendered as a source-labeled foldable row. */
  disclosure?: ContextDisclosure;
  /** Inline permission request — rendered as InlinePermissionCard in the chat stream. */
  permissionRequest?: PermissionRequest;
}

export interface CodeBlock {
  id: string;
  language: string;
  code: string;
  applied: boolean;
}

/** Compaction checkpoint facts （压缩检查点）. */
export interface CompactionData {
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved?: number;
  tokensSaved?: number;
}

/** Injected-context disclosure （上下文注入披露, UI-only metadata). */
export interface ContextDisclosure {
  source: 'instructions' | 'memory' | 'workspace';
  producer: string;
  detail?: string;
  /** Optional preview of the injected text (never required). */
  content?: string;
}

/** A message queued while the Agent is busy （排队消息）. */
export interface AgentQueueItem {
  id: string;
  text: string;
  createdAt: number;
}

export interface ChatStore {
  messages: Message[];
  isStreaming: boolean;
  inputValue: string;
  /** 按会话保存的输入草稿（会话切换不串味）。 */
  drafts: Record<string, string>;
  isDeepThink: boolean;
  /** Thinking depth: low/medium → API reasoning_effort="high", high → "max" */
  reasoningEffort: 'low' | 'medium' | 'high';
  /** Per-mode thinking snapshot — each surface restores its own switch + depth
   *  when switched back to (Chat 自己记住开关，Work/Code 各自记住深度). */
  modeThinkingPrefs: Partial<
    Record<
      'chat' | 'work' | 'code',
      {
        isDeepThink: boolean;
        reasoningEffort: 'low' | 'medium' | 'high';
      }
    >
  >;
  isWebSearch: boolean;
  /** Legacy per-send auto-approve flag — the permission preset owns this axis now. */
  autoApprove: boolean;
  /** /plan arms the next Agent task to run in plan mode (plan → approve → execute). */
  pendingPlanMode: boolean;
  /** /tool 武装的下一个 Agent 任务的 tool_choice（auto/none/required/指定工具）。 */
  pendingToolChoice: DeepSeekToolChoice | null;
  /** Code-mode task launcher: scheduler priority for new tasks. Persisted. */
  taskPriority: 'high' | 'normal' | 'low';
  /** Agent-mode messages queued while the current task is running (FIFO drain). */
  agentQueue: AgentQueueItem[];
  /** Goal-mode shell — `/goal` progress row until the engine lands. */
  goal: GoalState | null;
  /** Per-chat memory switch — persisted, gates memory use/contribution. */
  memoriesEnabled: boolean;
  selectedModel: string;
  currentProjectPath: string | null;
  currentIteration: number | null;
  maxIterations: number | null;
  /** O(1) lookup index keyed by toolCallId — maintained alongside messages.toolCalls. */
  toolCallMap: Record<string, ToolCall>;
  exactInputTokens: number;
  exactOutputTokens: number;
  reasoningOutputTokens: number;
  /** DeepSeek 上下文硬盘缓存命中/未命中 tokens（API 实测值，会话级累计）。 */
  cacheHitTokens: number;
  cacheMissTokens: number;
  lastCompression: {
    tokensBefore: number;
    tokensAfter: number;
    timestamp: number;
    messagesRemoved?: number;
    tokensSaved?: number;
  } | null;
  lastUserMessage: string | null;
  /** Bumped when another view asks the composer to focus (diff 继续改, 错误修复). */
  composerFocusTick: number;
  /** Set by 新建任务 / 新建对话: the next code-mode send must NOT fall back
   *  to the most recently settled task — it should start fresh. */
  pendingNewTask: boolean;

  sendMessage: () => Promise<void>;
  /** 对话前缀续写（Beta）：让模型从给定代码块继续输出，结果作为新的助手消息流式渲染。 */
  continueCode: (language: string, code: string, instruction?: string) => void;
  retryLastMessage: () => void;
  /** 从任意助手消息重新生成：截断到该消息之前并重发前一条用户消息。 */
  regenerateFromMessage: (messageId: string) => void;
  retryTool: (requestId: string, toolCallId: string, toolName: string) => void;
  editMessage: (messageId: string, newContent: string) => void;
  deleteMessage: (messageId: string) => void;
  setInputValue: (value: string) => void;
  requestComposerFocus: () => void;
  /** 非持久化：状态栏等外部入口请求打开模型选择面板。 */
  modelPanelRequest: number;
  requestModelPanel: () => void;
  /** 消费一次模型面板请求，避免历史请求在组件重挂载时重放。 */
  consumeModelPanelRequest: () => void;
  setPendingNewTask: (v: boolean) => void;
  toggleDeepThink: () => void;
  setReasoningEffort: (effort: 'low' | 'medium' | 'high') => void;
  toggleWebSearch: () => void;
  /** @deprecated — superseded by the composer permission preset. */
  toggleAutoApprove: () => void;
  setPendingPlanMode: (enabled: boolean) => void;
  setPendingToolChoice: (choice: DeepSeekToolChoice | null) => void;
  setTaskPriority: (priority: 'high' | 'normal' | 'low') => void;
  enqueueAgentMessage: (text: string) => void;
  dequeueAgentMessage: (id: string) => void;
  editAgentQueueItem: (id: string, text: string) => void;
  clearAgentQueue: () => void;
  setGoal: (goal: GoalState | null) => void;
  updateGoal: (patch: Partial<GoalState>) => void;
  clearGoal: () => void;
  setMemoriesEnabled: (enabled: boolean) => void;
  setSelectedModel: (model: string) => void;
  clearMessages: () => void;
  switchSession: (id: string) => void;
  setCurrentProjectPath: (path: string | null) => void;
  stopStreaming: () => void;
}

export type LeftPanelTab = 'agents' | 'sessions' | 'files' | 'git';
export type ThemeMode = 'system' | 'light' | 'dark';

/** Full-screen tool entry views (front-end shells; real engines land later). */
export type ToolView = 'none' | 'notifications' | 'scheduled' | 'plugins' | 'terminal';

/** Goal-mode state — `/goal` shell until the real long-running engine lands. */
export interface GoalState {
  text: string;
  status: 'running' | 'paused';
  startedAt: number;
}

// ─── Workbench Multi-Tab Support ──────────────────────────

export type WorkbenchTabType = 'chat' | 'file-tree' | 'diff' | 'browser';

export interface WorkbenchTab {
  id: string;
  type: WorkbenchTabType;
  label: string;
  agentId?: string;
  metadata?: {
    filePath?: string;
    diffRequestId?: string;
    browserUrl?: string;
  };
  isDirty?: boolean;
}

export interface AppStore {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  showSettings: boolean;
  showRightPanel: boolean;
  sidebarWidth: number;
  leftPanelWidth: number;
  rightPanelWidth: number;
  /** Persisted Allotment pane sizes. Length 2 when right panel hidden, 3 when shown. null = use defaults. */
  paneSizes: number[] | null;
  activeLeftPanel: LeftPanelTab;
  fileTreeVersion: number;
  /** 主布局是否已挂载：玻璃只在实体面板就绪后才生效，避免启动期整窗透明。 */
  glassLayoutMounted: boolean;

  // Workbench multi-tab
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  rightPanelView: 'file-tree' | 'inspector' | 'timeline' | 'review' | 'preview' | 'none';
  /** Sidebar content mode — 'chat' = conversation surface, 'work'/'code' = agent tasks. */
  sidebarMode: 'chat' | 'work' | 'code';
  /** Work 模式执行自主度档位（切换模式后保留，仅 Work 使用）。 */
  workAutonomyTier: WorkAutonomyTier;
  /** Tool entry view shown instead of the chat/task surface ('' = normal). */
  activeToolView: ToolView;
  /** Settings pane to open next time the Settings modal is shown. */
  settingsInitialKey: string;
  /** 全局搜索弹窗（由侧边栏搜索按钮唤起）。 */
  globalSearchOpen: boolean;
  /** Bottom terminal drawer height (px). */
  terminalHeight: number;
  /** Cross-panel focus request: timeline → agent log row. */
  agentLogFocusRequest: { agentId: string; toolCallId: string; ts: number } | null;
  /** Cross-panel focus request: agent log row → timeline row. */
  trajectoryFocusRequest: { agentId: string; toolCallId: string; ts: number } | null;
  /** Last agent shell tab shown in the terminal drawer (persisted). */
  lastAgentShellId: string | null;
  /** Cross-panel "errors only" filter for agent execution views. */
  agentErrorsOnly: boolean;
  /** Cross-panel "text only" filter for agent execution views. */
  agentTextOnly: boolean;
  /** Cross-panel "running only" filter for agent execution views. */
  agentRunningOnly: boolean;
  /** Auto-follow newest running tool while running-only is active. */
  agentRunningFollow: boolean;
  /** Rounds currently expanded in the agent execution view (shared). */
  openAgentTurns: number[];
  /** Total round count, kept in sync by AgentConversation. */
  agentTurnCount: number;
  /** Timestamp bump requesting the raw-log modal. */
  agentRawLogRequest: number;
  /** Error navigation request: { ts, dir } where dir is +1 / -1. */
  agentErrorNavRequest: { ts: number; dir: 1 | -1 } | null;
  /** Cross-panel request to open a file in the 文件 right-panel tab. */
  openFileRequest: { path: string; requestId: number } | null;
  /** Multi-file tabs inside the 文件 panel (session-only, not persisted). */
  fileTabs: { path: string; name: string }[];
  /** Active file tab path; null = the fixed 文件树 tab. */
  activeFilePath: string | null;

  // Navigation history
  tabHistory: string[];
  tabHistoryIndex: number;

  toggleTheme: () => void;
  setTheme: (mode: ThemeMode) => void;
  toggleSidebar: () => void;
  setSidebarMode: (mode: 'chat' | 'work' | 'code') => void;
  setWorkAutonomyTier: (tier: WorkAutonomyTier) => void;
  toggleRightPanel: () => void;
  setShowSettings: (show: boolean) => void;
  setActiveToolView: (view: ToolView) => void;
  /** Toggle a tool entry view — clicking the active entry returns to chat. */
  openToolView: (view: Exclude<ToolView, 'none'>) => void;
  setSettingsInitialKey: (key: string) => void;
  setGlobalSearchOpen: (open: boolean) => void;
  setTerminalHeight: (h: number) => void;
  requestAgentLogFocus: (agentId: string, toolCallId: string) => void;
  clearAgentLogFocus: () => void;
  requestTrajectoryFocus: (agentId: string, toolCallId: string) => void;
  clearTrajectoryFocus: () => void;
  setLastAgentShellId: (id: string | null) => void;
  setAgentErrorsOnly: (v: boolean) => void;
  setAgentTextOnly: (v: boolean) => void;
  setAgentRunningOnly: (v: boolean) => void;
  setAgentRunningFollow: (v: boolean) => void;
  setOpenAgentTurns: (turns: number[]) => void;
  toggleAllAgentTurns: () => void;
  setAgentTurnCount: (n: number) => void;
  requestAgentRawLog: () => void;
  requestAgentErrorNav: (dir: 1 | -1) => void;
  clearAgentErrorNav: () => void;
  setSidebarWidth: (w: number) => void;
  setLeftPanelWidth: (w: number) => void;
  setRightPanelWidth: (w: number) => void;
  setPaneSizes: (sizes: number[]) => void;
  setActiveLeftPanel: (tab: LeftPanelTab) => void;
  setGlassLayoutMounted: (v: boolean) => void;
  incrementFileTreeVersion: () => void;
  requestOpenFile: (path: string) => void;
  clearOpenFileRequest: () => void;
  openFileTab: (path: string) => void;
  closeFileTab: (path: string) => void;
  setActiveFilePath: (path: string | null) => void;
  clearFileTabs: () => void;

  // Workbench tab methods
  addTab: (tab: Omit<WorkbenchTab, 'id'>) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<WorkbenchTab>) => void;
  closeAllTabs: () => void;
  setRightPanelView: (view: 'file-tree' | 'inspector' | 'timeline' | 'review' | 'preview' | 'none') => void;

  // Navigation
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

// ─── Agentic-workspace task model (TodoWrite-driven checklist) ───
export type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface AgentTask {
  id: string;
  title: string;
  status: TaskStatus;
  detail?: string;
  /** Tool calls that fulfilled this step (links task → ToolCallTimeline). */
  toolCallIds?: string[];
  startedAt?: number;
  endedAt?: number;
}

/** State-aware file-tree activity (badges driven by agent tool calls). */
export type FileActivity = 'reading' | 'editing' | 'modified' | 'created' | 'deleted';

/**
 * Fetch the full model list (built-in + custom from backend).
 * In browser-only mode, returns the built-in list.
 */
export async function fetchModels(): Promise<AIModel[]> {
  if (window.electronAPI?.model) {
    const result = await window.electronAPI.model.getAll();
    if (result.ok && result.data) {
      return result.data.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        maxTokens: m.maxTokens,
        contextWindow: m.contextWindow,
        supportsImages: m.supportsImages,
        experimental: m.experimental,
        apiBase: m.apiBase,
      }));
    }
  }
  return BUILT_IN_MODELS;
}
