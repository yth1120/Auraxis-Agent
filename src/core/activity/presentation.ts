/**
 * presentation.ts — Activity 展示层（**唯一一份**）。
 *
 * 此前同一件事在本仓库有四张表：`chat/ToolCallCard.tsx` 的 `INPUT_FORMATTERS`、
 * `inspector/TimelineUtils.ts` 的 `toolSummary`、`chat/ToolCallTimeline.tsx` 的
 * `getGroupTitle`、`agent/AgentConversationUtils.ts` 的 `summarizeInput`。
 * 四张表必然漂移 —— 同一个工具在不同视图里显示成不同措辞。
 *
 * 本模块分两半，边界是刻意的：
 *   · `activityTypeForTool` / `detailKindForTool` / `isFileMutationTool`：纯分类，**不碰 i18n**，
 *     供适配器与 store 使用（它们不该依赖语言）。
 *   · `presentActivity`：把 Activity → 当前语言的一行标题与摘要，供组件使用。
 *
 * **摘要优先用引擎给的 `summaryFacts`**：`buildToolSummary` 早就在产出
 * 「读了 120 行 / 8KB」「exit 0，stdout 1.2KB」这类真实度量，只是此前没人渲染。
 * 只有引擎没给（例如 MCP / 插件工具）时才退回按入参格式化。
 */
import { t, type I18nKey } from '../../i18n';
import type { AggregateClass, ActivitySegment } from './aggregate';
import { aggregateCounts } from './aggregate';
import { planCardModel } from './agentCards';
import type { ActivityItem, ActivitySummaryFacts, ActivityType } from '../../types/activity';
import type { BuiltInToolName, ToolName } from '../../types/tools';
import { basename, middleEllipsis } from '../../utils/paths';

/** Detail 区用哪个渲染件。 */
export type ActivityDetailKind =
  'terminal' | 'diff' | 'read' | 'search' | 'web' | 'code' | 'sub_agent' | 'permission' | 'plan' | 'nested' | 'json';

/**
 * 原始工具名 → Activity 语义类型。
 *
 * **类型是 `Record<BuiltInToolName, ActivityType>`，不是 `Record<string, …>`** ——
 * 这是刻意的：新增一个内置工具却忘了归类，会直接**编译失败**，而不是在界面上
 * 退化成一个裸工具名（四张旧表就是这样漂移的）。
 */
const TYPE_BY_TOOL: Record<BuiltInToolName, ActivityType> = {
  // 读取 / 检索
  Read: 'read_file',
  ReadImage: 'read_file',
  ReadDocument: 'read_file',
  ReadSpill: 'read_file',
  WebFetch: 'read_file',
  Grep: 'search',
  WebSearch: 'search',
  SessionEventSearch: 'search',
  Glob: 'list_files',
  // 写入
  Write: 'create_file',
  Edit: 'edit_file',
  NotebookEdit: 'edit_file',
  StrReplaceEditor: 'edit_file',
  Delete: 'delete_file',
  // 执行
  Bash: 'terminal',
  Pwsh: 'terminal',
  Pty: 'terminal',
  RunCode: 'terminal',
  TerminalOpen: 'terminal',
  TerminalList: 'terminal',
  TerminalRead: 'terminal',
  TerminalSend: 'terminal',
  TerminalSignal: 'terminal',
  TerminalClose: 'terminal',
  GitCommit: 'git',
  // 计划 / 协作 / 治理
  TodoWrite: 'plan',
  Replan: 'plan',
  Agent: 'sub_agent',
  ListAgents: 'sub_agent',
  SendMessage: 'sub_agent',
  InterruptAgent: 'sub_agent',
  Report: 'sub_agent',
  AskUser: 'permission',
  ReviewArtifact: 'verification',
  WriteDocument: 'artifact',
  BrowserOpen: 'browser',
  BrowserRead: 'browser',
  BrowserScreenshot: 'browser',
  // 以下是本仓库真实存在、但语义上落不进上面任何一类的工具（运行时/调度/插件/
  // 集成/会话自省）。一律归到 `inspect`，并由展示层**直接用工具自己的名字当标题** ——
  // 与其把它们硬塞进"检查"这种错误类别，不如如实显示工具名。
  LSP: 'inspect',
  InspectRuntime: 'inspect',
  SessionQuery: 'inspect',
  SessionTrace: 'inspect',
  SessionEventRead: 'inspect',
  TaskList: 'inspect',
  TaskOutput: 'inspect',
  IngestDocument: 'inspect',
  ScheduleCreate: 'inspect',
  ScheduleDelete: 'inspect',
  ScheduleList: 'inspect',
  JobList: 'inspect',
  JobOutput: 'inspect',
  JobKill: 'inspect',
  TaskStop: 'inspect',
  EnterPlanMode: 'inspect',
  ExitPlanMode: 'inspect',
  EnterWorktree: 'inspect',
  ListSkills: 'inspect',
  ReadSkill: 'inspect',
  WriteSkill: 'inspect',
  RunWorkflow: 'inspect',
  MountPlugin: 'inspect',
  UnmountPlugin: 'inspect',
  Ralph: 'inspect',
  CronCreate: 'inspect',
  CronDelete: 'inspect',
  CronList: 'inspect',
  GetGoal: 'inspect',
  CreateGoal: 'inspect',
  UpdateGoal: 'inspect',
  SlackListChannels: 'inspect',
  SlackPostMessage: 'inspect',
  DriveList: 'inspect',
  DriveRead: 'inspect',
  NotionSearch: 'inspect',
  NotionCreatePage: 'inspect',
};

/** 已显式归类的工具名（运行时守卫用它对照真实工具清单，防止再次静默漂移）。 */
export const MAPPED_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TYPE_BY_TOOL));

/**
 * 这些工具虽有语义类型，但标题应当直接用工具自己的名字（否则"检查 CronCreate"这种
 * 说法没有信息量）。判据是"工具名本身就是用户认识的动作"。
 */
const TITLE_FROM_TOOL_NAME: ReadonlySet<BuiltInToolName> = new Set(
  (Object.keys(TYPE_BY_TOOL) as BuiltInToolName[]).filter((n) => TYPE_BY_TOOL[n] === 'inspect'),
);

/**
 * 工具显示名（从前是 `ToolCallCard.tsx` 里的 `TOOL_LABEL` 表 —— 第五张重复的表）。
 * 只对"用户不认识原始名"的工具做映射；其余原样显示。
 */
const TOOL_LABEL: Partial<Record<BuiltInToolName, string>> = {
  AskUser: 'Ask',
  EnterPlanMode: 'Plan',
  ExitPlanMode: 'ExitPlan',
  EnterWorktree: 'Worktree',
  Pty: 'PTY',
  SlackListChannels: 'Slack',
  SlackPostMessage: 'Slack',
  DriveList: 'Drive',
  DriveRead: 'Drive',
  NotionSearch: 'Notion',
  NotionCreatePage: 'Notion',
};

export function toolLabel(toolName: ToolName | undefined): string {
  if (!toolName) return '';
  return TOOL_LABEL[toolName as BuiltInToolName] ?? toolName;
}

/** 只有这些工具会改文件（Run 统计"改了 N 个文件"与 Work 交付都依赖它）。 */
const FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
  'StrReplaceEditor',
  'Delete',
]);

/** 会产出 diff 工件的工具（Delete 没有 old/new 内容，不算）。 */
const DIFF_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', 'StrReplaceEditor']);

/**
 * 命令 → 测试 / 构建 的语义细分。
 *
 * 这是**从真实命令字符串派生**的分类，不是猜测：`npm test`、`vitest`、`tsc`、`vite build`
 * 都实打实出现在 argv 里。分不出来就是普通 terminal —— 宁可少分类，不要瞎分类。
 */
const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b/;
const BUILD_RE =
  /\b(tsc|vite|webpack|rollup|esbuild|turbo|make|gradle|mvn)\b.*\b(build|compile)\b|\b(tsc|vite\s+build)\b/;

export function isFileMutationTool(toolName: string | undefined): boolean {
  return !!toolName && FILE_MUTATION_TOOLS.has(toolName);
}

export function canProduceDiff(toolName: string | undefined): boolean {
  return !!toolName && DIFF_TOOLS.has(toolName);
}

/** 工具名 → Activity 类型。未登记的工具（MCP / 插件）落到 `inspect`。 */
export function activityTypeForTool(toolName: string | undefined, input?: Record<string, unknown>): ActivityType {
  if (!toolName) return 'inspect';
  // 外部来源工具（MCP / 插件）没有统一语义，一律按 inspect 处理 —— 与
  // tool-capability.isExternalSourceTool 的口径一致：不假装知道它做了什么。
  if (toolName.startsWith('mcp__') || toolName.includes('.')) return 'inspect';
  const base = TYPE_BY_TOOL[toolName as BuiltInToolName];
  if (base === 'terminal') {
    const command = typeof input?.command === 'string' ? input.command : '';
    if (TEST_RE.test(command)) return 'test';
    if (BUILD_RE.test(command)) return 'build';
    return 'terminal';
  }
  return base ?? 'inspect';
}

/**
 * 语义类型 → 详情渲染件（**表而不是 switch**）。
 *
 * 表是 `Record<ActivityType, …>`：新增一种 Activity 类型却忘了归类，会**编译失败**。
 * 从前那句 `default: return 'json'` 会把新类型悄悄降级成一坨原始 JSON —— 界面不报错，
 * 只是变难看了，这种"安静的退化"最难发现。
 *
 * 工具级覆盖（WebFetch / RunCode 等）在下面单独处理：它们的**语义类型**是 read_file /
 * terminal，但该用网页卡与代码执行卡。
 */
const DETAIL_BY_TYPE: Record<ActivityType, (toolName: string | undefined) => ActivityDetailKind> = {
  plan: () => 'plan',
  reasoning_summary: () => 'json',
  read_file: () => 'read',
  search: (t) => (t === 'WebSearch' ? 'web' : 'search'),
  list_files: () => 'search',
  inspect: () => 'json',
  create_file: (t) => (canProduceDiff(t) ? 'diff' : 'json'),
  edit_file: (t) => (canProduceDiff(t) ? 'diff' : 'json'),
  delete_file: () => 'json',
  terminal: () => 'terminal',
  test: () => 'terminal',
  build: () => 'terminal',
  git: () => 'json',
  sub_agent: () => 'sub_agent',
  permission: () => 'permission',
  artifact: () => 'web',
  browser: (t) => (t === 'BrowserScreenshot' ? 'json' : 'web'),
  browser_annotation: () => 'json',
  error: () => 'json',
  warning: () => 'json',
  verification: () => 'json',
  context: () => 'json',
};

export function detailKindForTool(toolName: string | undefined, type: ActivityType): ActivityDetailKind {
  // 工具优先于类型：WebFetch 与 RunCode 的语义类型分别归到 read_file / terminal，
  // 但它们该用各自专属的展示件（网页卡片 / 代码执行卡片）。
  if (toolName === 'WebFetch' || toolName === 'BrowserOpen' || toolName === 'BrowserRead') return 'web';
  if (toolName === 'RunCode' || toolName === 'RunWorkflow') return 'code';
  return DETAIL_BY_TYPE[type]?.(toolName) ?? 'json';
}

// ─── 展示（需要 i18n） ────────────────────────────────

/** 引擎 summaryFacts → 一行人类可读摘要；没有可用事实时返回 null。 */
export function summaryFromFacts(facts: ActivitySummaryFacts | undefined, type: ActivityType): string | null {
  if (!facts) return null;
  if (type === 'test' || type === 'build' || type === 'terminal') {
    if (typeof facts.exitCode === 'number') {
      const out = typeof facts.stdoutLen === 'number' ? facts.stdoutLen : 0;
      const err = typeof facts.stderrLen === 'number' ? facts.stderrLen : 0;
      return t('activity.summary.exit', { code: facts.exitCode, out: fmtBytes(out), err: fmtBytes(err) });
    }
  }
  if (type === 'read_file' && typeof facts.lines === 'number') {
    return t('activity.summary.lines', {
      n: facts.lines,
      size: fmtBytes(typeof facts.size === 'number' ? facts.size : 0),
    });
  }
  if ((type === 'search' || type === 'list_files') && typeof facts.matchCount === 'number') {
    return t('activity.summary.matches', { n: facts.matchCount });
  }
  if (type === 'create_file' && typeof facts.bytesWritten === 'number') {
    return t('activity.summary.bytesWritten', { size: fmtBytes(facts.bytesWritten) });
  }
  if (type === 'git' && typeof facts.hash === 'string' && facts.hash) {
    return t('activity.summary.commit', { hash: facts.hash.slice(0, 7) });
  }
  // 计划项（`Message.plan`）本身没有 toolName，走不了入参兜底 —— 数字必须在这里翻译。
  if (type === 'plan' && typeof facts.steps === 'number') {
    return t('activity.plan.approved', {
      steps: facts.steps,
      approved: typeof facts.approved === 'number' ? facts.approved : 0,
    });
  }
  return null;
}

/** 以文件路径为摘要的工具（读 / 写 / 删一族）—— 收敛成集合，避免每个工具占一个分支。 */
const PATH_SUMMARY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'ReadImage',
  'ReadDocument',
  'Write',
  'WriteDocument',
  'Edit',
  'NotebookEdit',
  'StrReplaceEditor',
  'Delete',
]);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 以文件为对象的操作（读 / 写 / 删一族）的摘要 = 文件名。
 *
 * 为什么它优先于引擎给的事实：在"读取 ×8"这样的列表里，用户扫的是**哪一个文件**；
 * 引擎度量（行数 / 字节）是次要信息，由 `factsChip` 作为后缀芯片保留，不丢。
 */
export function pathSummaryOf(item: { toolName?: string; input?: Record<string, unknown> }): string | null {
  if (!item.toolName || !PATH_SUMMARY_TOOLS.has(item.toolName)) return null;
  const filePath = str(item.input?.file_path) || str(item.input?.path);
  // **中间省略的完整路径**，不是 basename：一个项目里 `index.ts` 能有几十个，
  // 只给文件名会让"修改 · index.ts"连成一片认不出谁是谁（截图里实测到的）。
  // 中间省略保证文件名完整、目录前缀可辨、宽度有界。
  return filePath ? middleEllipsis(filePath, 44) : null;
}

/** 摘要让位给路径后，把引擎度量挪到后缀芯片上（行数 / 写入字节）。 */
export function factsChip(item: ActivityItem): string | null {
  const facts = item.summaryFacts;
  if (!facts) return null;
  if (item.type === 'read_file' && typeof facts.lines === 'number') {
    return t('activity.facts.lines', { n: facts.lines });
  }
  if (item.type === 'create_file' && typeof facts.bytesWritten === 'number') {
    return fmtBytes(facts.bytesWritten);
  }
  return null;
}

/** 未登记工具：给最短的一个字符串参数，不要甩一段 JSON 给用户。 */
function firstStringArg(input: Record<string, unknown>): string {
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return first ? singleLine(String(first)) : '';
}

/** 入参兜底摘要（引擎没给事实时用，例如 MCP 工具）。 */
export function summaryFromInput(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  if (!toolName) return firstStringArg(i);
  if (PATH_SUMMARY_TOOLS.has(toolName)) {
    const filePath = str(i.file_path);
    return basename(filePath) || filePath;
  }
  switch (toolName) {
    case 'Bash':
    case 'Pwsh':
      return singleLine(str(i.command));
    case 'Grep':
    case 'Glob':
      return str(i.pattern);
    case 'WebFetch':
    case 'BrowserOpen':
      return str(i.url);
    case 'WebSearch':
      return str(i.query);
    case 'Agent':
      return singleLine(str(i.description) || str(i.prompt));
    case 'AskUser':
      return singleLine(str(i.question));
    // TodoWrite 的入参是数组，兜底取不到字符串 —— 用**真实进度**当摘要（不再是"更新待办"）。
    case 'TodoWrite':
    case 'Replan': {
      const plan = planCardModel({ toolName, input: i });
      return plan ? t('activity.plan.summary', { done: plan.done, total: plan.total }) : t('conv.updateTodos');
    }
    default:
      return firstStringArg(i);
  }
}

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export interface PresentedActivity {
  /** 一行标题：动作本身（"读取" / "运行测试"）。 */
  title: string;
  /** 一行摘要：作用对象或结果（文件路径 / 命令 / 命中数）。 */
  summary: string;
  detailKind: ActivityDetailKind;
}

const TITLE_BY_TYPE: Record<ActivityType, I18nKey> = {
  plan: 'activity.title.plan',
  reasoning_summary: 'activity.title.reasoning',
  read_file: 'activity.title.read',
  search: 'activity.title.search',
  list_files: 'activity.title.list',
  inspect: 'activity.title.inspect',
  create_file: 'activity.title.create',
  edit_file: 'activity.title.edit',
  delete_file: 'activity.title.delete',
  terminal: 'activity.title.run',
  test: 'activity.title.test',
  build: 'activity.title.build',
  git: 'activity.title.git',
  sub_agent: 'activity.title.subAgent',
  permission: 'activity.title.permission',
  artifact: 'activity.title.artifact',
  browser: 'activity.title.browser',
  browser_annotation: 'activity.title.annotation',
  error: 'activity.title.error',
  warning: 'activity.title.warning',
  verification: 'activity.title.verify',
  context: 'activity.title.context',
};

/** 聚合段的标题（inspect 不在表里：它直接用工具自己的名字，见 presentAggregate）。 */
const AGGREGATE_TITLE: Record<Exclude<AggregateClass, 'inspect'>, I18nKey> = {
  read_file: 'activity.aggregate.read',
  search_matches: 'activity.aggregate.search',
  search_paths: 'activity.aggregate.list',
  terminal: 'activity.aggregate.terminal',
  test: 'activity.aggregate.test',
  build: 'activity.aggregate.build',
};

/**
 * 聚合段 → 一行标题 + 计数。
 *
 * 计数一律来自 `aggregateCounts`（真实字段求和）；推不出来的部分**不显示** ——
 * 例如有子项没给命中数时，就只说"检索 3 次"，不说"命中 14 处"。
 */
export function presentAggregate(seg: ActivitySegment): { title: string; summary: string } {
  const klass = seg.klass ?? 'inspect';
  const { count, matches } = aggregateCounts(seg);
  const title = klass === 'inspect' ? toolLabel(seg.toolName) : t(AGGREGATE_TITLE[klass]);
  let summary: string;
  switch (klass) {
    case 'read_file':
      summary = t('activity.aggregate.files', { n: count });
      break;
    case 'search_matches':
      summary =
        matches === undefined
          ? t('activity.aggregate.times', { n: count })
          : t('activity.aggregate.matches', { n: count, m: matches });
      break;
    case 'search_paths':
      summary =
        matches === undefined
          ? t('activity.aggregate.times', { n: count })
          : t('activity.aggregate.paths', { n: count, m: matches });
      break;
    case 'terminal':
      summary = t('activity.aggregate.commands', { n: count });
      break;
    default:
      summary = t('activity.aggregate.times', { n: count });
      break;
  }
  return { title, summary };
}

/** Activity → 当前语言的一行标题 + 摘要 + Detail 类型。组件只需要这一个入口。 */
export function presentActivity(item: ActivityItem): PresentedActivity {
  // 归到 inspect 的那批工具直接用工具名当标题：宁可显示 "CronCreate"，
  // 也不要写出"检查 CronCreate"这种没有信息量的错标签。
  const useToolName =
    item.type === 'inspect' && !!item.toolName && TITLE_FROM_TOOL_NAME.has(item.toolName as BuiltInToolName);
  const title = useToolName ? toolLabel(item.toolName) : t(TITLE_BY_TYPE[item.type]);
  const fromFacts = summaryFromFacts(item.summaryFacts, item.type);
  /**
   * `warning` / `context` 没有有意义的"对象"可摘要（正文在别的字段里）。
   *
   * `plan` 与 `sub_agent` 都曾经在这张名单上，现在都移出去了：留在名单上只会让折叠行
   * 剩一个光秃秃的"计划"/"子代理" —— 而 `summaryFromInput` 明明能给出真实的
   * `2/4 已完成` 与子代理的任务描述（截图里发现的）。
   */
  const fallback =
    item.type === 'warning' || item.type === 'context' ? '' : summaryFromInput(item.toolName, item.input);
  const summary = pathSummaryOf(item) ?? fromFacts ?? fallback;
  return { title, summary, detailKind: detailKindForTool(item.toolName, item.type) };
}
