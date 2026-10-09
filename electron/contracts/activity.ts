/**
 * activity.ts — Agent Activity 契约（Run / Item）。
 *
 * 一次 Assistant Run = 聊天区里的一条 assistant 消息；Run 内部是有序的 Activity 列表。
 * 本文件是**跨进程契约**：主进程用它做持久化与投影，渲染层直接 import（与
 * `session-types.ts` 同一约定 —— 刻意不含任何 `electron` 依赖，也不 import `src/`）。
 *
 * 三条设计约束，违背任何一条都会让这套东西退化：
 *
 * 1. **只存事实，不存展示字符串**。`title` / `summary` 这类要按语言渲染的文案**不进契约**
 *    （存中文标题会让界面切不成英文）。要展示的内容分两种：结构化事实
 *    （`summaryFacts`，由引擎的 `buildToolSummary` 产出，语言无关）与原始入参
 *    （`input`，由展示层按工具名格式化）。渲染层负责把两者变成当前语言的一行字。
 *
 * 2. **状态是被事件驱动的显式值**，不允许前端用 setTimeout 伪造中间态。
 *    每个 `status` 都必须能指出产生它的那个引擎事件（见 `ActivityTransitionSources`）。
 *
 * 3. **大对象按引用**。超过阈值的内容走 `outputRef`（既有 spill 落盘机制），
 *    不把整段输出塞进 store —— 否则一次长跑就会把渲染进程拖垮。
 */

/** Activity 的统一状态。所有 UI 只认这一套。 */
export type ActivityStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting' | 'skipped';

/**
 * Activity 的语义类型 —— **与工具名解耦**。
 * 工具名是内部协议（`filesystem.read_file` 之类），这里是用户能理解的动作类别。
 * 新增工具时改展示层，不改这里。
 */
export type ActivityType =
  // 计划与意图
  | 'plan'
  | 'reasoning_summary'
  // 读取
  | 'read_file'
  | 'search'
  | 'list_files'
  | 'inspect'
  // 写入
  | 'create_file'
  | 'edit_file'
  | 'delete_file'
  // 执行
  | 'terminal'
  | 'test'
  | 'build'
  | 'git'
  // 协作与治理
  | 'sub_agent'
  | 'permission'
  | 'artifact'
  // 内置预览浏览器（真实 runtime，见 electron/browser-target.ts）
  | 'browser'
  /** 用户在页面上选元素写的评论（用户输入，随下一条消息进入上下文）。 */
  | 'browser_annotation'
  // 过程信号
  | 'error'
  | 'warning'
  | 'verification'
  /**
   * 上下文注入 / 压缩（AGENTS.md 注入、记忆注入、超阈值压缩）。
   *
   * 这是 spec 的类型清单里没有、但本 runtime **真实会产生**的一类事件：
   * 从前它们各自是一条独立的合成消息，飘在 Run 之外；类型清单是"至少支持"，
   * 与其把它们硬塞进 warning 或 artifact，不如给一个诚实的类别。
   */
  | 'context';

/**
 * 产生每个状态的**引擎事件**（文档而非代码）。改状态机时对照这张表改，
 * 不要在 UI 里凭空造状态。
 *
 *   pending   ← 已创建但尚未收到 tool_start（例如同批里排在后面的工具）
 *   running   ← tool_start
 *   completed ← tool_end
 *   failed    ← tool_error
 *   cancelled ← tool_aborted（用户中止 / 权限被拒）
 *   waiting   ← permission:request（等用户决策；决策后回 running 或转 cancelled）
 *   skipped   ← Run 终态推导（计划步骤未执行）
 */
export const ACTIVITY_TRANSITION_SOURCES = {
  pending: 'created',
  running: 'tool_start',
  completed: 'tool_end',
  failed: 'tool_error',
  cancelled: 'tool_aborted',
  waiting: 'permission:request',
  skipped: 'run-terminal-fold',
} as const satisfies Record<ActivityStatus, string>;

/** 终态：不会再变（除非用户对失败项发起真实 retry）。 */
export const ACTIVITY_TERMINAL_STATUSES: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

/**
 * 折叠优先级：把一个分组 / 整个 Run 的子项状态折成一个状态时用。
 * 数值越大越"需要被看见" —— 等待用户 > 正在跑 > 失败 > 取消 > 完成。
 * 顺序是刻意的：一个还在等权限的 Run 不该因为别的步骤跑完了就显示成"完成"。
 */
const STATUS_FOLD_PRIORITY: Record<ActivityStatus, number> = {
  waiting: 6,
  running: 5,
  failed: 4,
  cancelled: 3,
  pending: 2,
  skipped: 1,
  completed: 0,
};

export function activityStatusPriority(status: ActivityStatus): number {
  return STATUS_FOLD_PRIORITY[status] ?? 0;
}

/** 把一组子项状态折成一个状态；空集合返回 null（调用方决定空态语义）。 */
export function foldActivityStatus(statuses: readonly ActivityStatus[]): ActivityStatus | null {
  if (statuses.length === 0) return null;
  let worst: ActivityStatus = statuses[0];
  for (const s of statuses) {
    if (activityStatusPriority(s) > activityStatusPriority(worst)) worst = s;
  }
  return worst;
}

/**
 * 引擎工具输出摘要（`buildToolSummary` 的产物）。
 *
 * 这是**语言无关的事实**：「读了 120 行 / 8KB」「exit 0，stdout 1.2KB」「命中 8 处」——
 * 由渲染层翻成当前语言的一行字。之所以定义在这里而不是各 UI 自己从入参猜：
 * 引擎**早就**算好了这些，只是此前没有任何消费者渲染。
 *
 * 刻意保留索引签名：MCP / 插件工具会带自己的事实字段，契约不应该把它们挡在外面。
 */
export interface ActivitySummaryFacts {
  /** 读取 / 写入的目标文件。 */
  filePath?: string;
  /** 读取的行数（`Read`）。 */
  lines?: number;
  /** 读取的字符数（`Read`）。 */
  size?: number;
  /** 写入的字符数（`Write`）。 */
  bytesWritten?: number;
  /** 搜索命中数（`Grep` / `Glob`）。 */
  matchCount?: number;
  /** 搜索范围（`Grep` 的 `filesSearched`）。 */
  filesSearched?: string;
  /** 命令退出码（`Bash`）。 */
  exitCode?: number;
  stdoutLen?: number;
  stderrLen?: number;
  /** `Edit` 是否发生了替换。 */
  replaced?: boolean;
  /** `Delete` 是否删除成功。 */
  deleted?: boolean;
  /** `GitCommit` 的提交信息与哈希。 */
  message?: string;
  hash?: string;
  /** `ReviewArtifact` 的检查类型与结论。 */
  checkType?: string;
  passed?: boolean;
  [key: string]: unknown;
}

/** 文件改动的真实工件（Write / Edit 的工具输出里本来就有 old/new 全文）。 */
export interface ActivityDiffArtifact {
  path: string;
  /** 由 `countDiffChanges` 从 old/new 真实算出，不是估算。 */
  added: number;
  removed: number;
  /** 原文；过大时省略并置 `truncated`。 */
  oldContent?: string;
  newContent?: string;
  truncated?: boolean;
}

/** 大输出的引用（超过阈值时由 spill 机制落盘，按需读取）。 */
export interface ActivityOutputRef {
  spillPath: string;
  bytes: number;
  preview: string;
}

export interface ActivityItem {
  /**
   * 稳定 id：`tool_start`/`tool_end`/`tool_error`/`tool_aborted` 复用同一个 toolCallId，
   * 因此同一步骤在流式过程中**原地更新**，不会生成三个 item。
   */
  id: string;
  /** 所属 Run（= assistant message id）。 */
  runId: string;
  /** 父 Activity（子代理的步骤挂在自己的 `sub_agent` 项下）；顶层为 null。 */
  parentId: string | null;
  type: ActivityType;
  status: ActivityStatus;
  /** 引擎给的原始事件名（`tool_start` / `plan_created` / …），排查用，不用于展示。 */
  sourceEvent?: string;
  /** 原始工具名（`Bash` / `mcp__x__y`），仅用于展示层映射与图标。 */
  toolName?: string;
  toolCallId?: string;
  /** 归属的查询请求 id —— 「中止 / 重试」这两个动作要靠它回主进程。 */
  requestId?: string;
  /** 同一轮 LLM 请求里并行派发的工具共享它 → 分组依据。 */
  stepGroupId?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  input?: Record<string, unknown>;
  output?: unknown;
  /** 失败原因（`tool_error.error` / Run 级 error）。 */
  error?: string;
  /** 结构化摘要事实（见 `ActivitySummaryFacts`）。 */
  summaryFacts?: ActivitySummaryFacts;
  /** 文件改动工件。 */
  diff?: ActivityDiffArtifact;
  /**
   * 运行中的实时输出（终端逐行刷新）。
   *
   * 直接来自 `ToolCall.streamOutput` —— 也就是 `chatSendMessage.flushAll` 一直在写的那一份。
   * 不在别处再攒一份：那样就会出现"任务视图在刷新、聊天卡片不动"这种同源两态。
   */
  liveOutput?: string;
  /** 大输出引用（替代把整段 output 放进 store）。 */
  outputRef?: ActivityOutputRef;
  /** 会话事件 seq —— fork / 回滚边界。 */
  seq?: number;
}

export interface ActivityStats {
  /** 步骤总数（不含嵌套子项）。 */
  actions: number;
  /** 被修改的**去重后**文件数。 */
  filesChanged: number;
  /** 失败的步骤数。 */
  errors: number;
  /** 子代理数。 */
  subAgents: number;
  /** 终端类步骤数。 */
  terminals: number;
  /** Run 总耗时（ms）；未结束时为「至今」。 */
  durationMs: number;
}

export interface ActivityRun {
  /** = assistant message id。 */
  id: string;
  sessionId?: string;
  status: ActivityStatus;
  startedAt: number;
  completedAt?: number;
  items: ActivityItem[];
  stats: ActivityStats;
}

/** 空统计（新建 Run 时用）。集中一处，避免各处写默认值漂移。 */
export function emptyActivityStats(): ActivityStats {
  return { actions: 0, filesChanged: 0, errors: 0, subAgents: 0, terminals: 0, durationMs: 0 };
}

/** 会改动文件的 Activity 类型 —— 统计「改了 N 个文件」时用。 */
export const FILE_MUTATING_ACTIVITIES: ReadonlySet<ActivityType> = new Set<ActivityType>([
  'create_file',
  'edit_file',
  'delete_file',
]);

/** 终端类 Activity（含 test / build，它们是 terminal 的语义细分）。 */
export const TERMINAL_ACTIVITIES: ReadonlySet<ActivityType> = new Set<ActivityType>(['terminal', 'test', 'build']);
