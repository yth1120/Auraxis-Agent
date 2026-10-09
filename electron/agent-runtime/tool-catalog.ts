/**
 * tool-catalog.ts — 动态工具装载（按任务阶段预选，纯函数）。
 *
 * 动机（有数据支撑）：全部内置 schema 每轮全量注入 ≈ 1.2 万输入 token，
 * 连"改一行常量"都要付这个固定成本。这里按「任务面 + 任务文本信号」预选分组，
 * 把集成类（Slack/Drive/Notion/Cron/插件）与协作类按需加载。
 *
 * 安全边界（两条，方向相反，都不能破）：
 *   · 只做"少给"，不做"多给"——**分组缺失时工具不会被悄悄放行**（ToolSearch 的组名白名单）；
 *   · 但也**不许据名字悄悄丢弃**——MCP / 插件的名字落不进分组正则，必须由
 *     `retainByDefault` 保留（见那里的说明与回归用例）。
 * 内置工具必须全部能归类（见 tool-catalog.test.ts），所以保留集对它们没有影响。
 */

export type ToolGroup = 'read' | 'edit' | 'exec' | 'verify' | 'plan' | 'collaborate' | 'integrate' | 'meta' | 'misc';

/** 按名字归类（先匹配先归属，保证确定性）。 */
const GROUP_MATCHERS: { group: Exclude<ToolGroup, 'misc'>; test: (name: string) => boolean }[] = [
  // meta：会话检索 / 技能目录 / 运行期巡检 / 后台任务列表 —— 只在相关任务里加载。
  {
    group: 'meta',
    test: (n) =>
      /^(SessionQuery|SessionEvent|SessionTrace|ReadSpill|ListSkills|ReadSkill|InspectRuntime|JobList|JobOutput|TaskList|TaskOutput|GetGoal|CreateGoal|UpdateGoal|Ralph)/.test(
        n,
      ),
  },
  // Ingest 与读同组：它是「从磁盘取素材」，加载时机与 Read* 一致（读类分组只在
  // ToolSearch 显式放开时才出现，归到这里不会让它被默认加载）。
  { group: 'read', test: (n) => /^(Read|Grep|Glob|LSP|Ingest)/.test(n) },
  { group: 'verify', test: (n) => n === 'ReviewArtifact' },
  { group: 'plan', test: (n) => /^(TodoWrite|Enter|Exit|Replan|AskUser|GetGoal|CreateGoal|UpdateGoal|Ralph)/.test(n) },
  { group: 'edit', test: (n) => /^(Write|Edit|StrReplaceEditor|NotebookEdit|Delete|GitCommit)/.test(n) },
  { group: 'exec', test: (n) => /^(Bash|Pwsh|Pty|Terminal|RunCode|RunWorkflow|JobKill|TaskStop)/.test(n) },
  { group: 'collaborate', test: (n) => /^(Agent|SendMessage|ListAgents|InterruptAgent|Report)/.test(n) },
  {
    group: 'integrate',
    // Browser* 与 Web* 同类：都要联网、都要审批门禁，加载时机也一致
    // （见 tool-capability 的 DANGEROUS_TOOLS）。漏归类它们会被动态装载静默丢掉。
    test: (n) =>
      /\./.test(n) ||
      /^(WebFetch|WebSearch|Browser|Slack|Drive|Notion|Cron|Schedule|MountPlugin|UnmountPlugin)/.test(n),
  },
];

export function groupOfTool(name: string): ToolGroup {
  for (const m of GROUP_MATCHERS) if (m.test(name)) return m.group;
  return 'misc';
}

export interface ToolSelectionOptions {
  task?: string;
  /** 'chat' | 'work' | 'code'（缺省按 code 处理）。 */
  surface?: string;
  /**
   * 额外的保留判据（宿主可传注册表判定，例如"是不是外部来源工具"）。
   * 缺省判据已覆盖 MCP 与任何未归类名字，见 `retainByDefault`。
   */
  retain?: (name: string) => boolean;
}

/**
 * 预选**不得**据名字丢掉"来路不明"的工具。
 *
 * MCP 工具名是 `mcp__<server>__<tool>`，插件名由各自的提供方决定 —— 它们都落不进
 * 上面那几张分组正则，于是被算作 `misc`。而 `misc` 从不出现在被选中的分组里，结果是
 * **它们在预选下被静默丢弃**（实测：`mcp__exa__search` → `misc`）。预选之前这些路径
 * 拿的是全量 `getAllTools()`，所以这是回归：收益在"少给集成类"，不该顺手把外部工具也砍掉。
 *
 * 内置工具不算"来路不明"：`tool-catalog.test.ts` 强制它们全部归类，漏一个就红。
 */
function retainByDefault(name: string): boolean {
  return name.startsWith('mcp__') || groupOfTool(name) === 'misc';
}

/**
 * 学习核心集（数据驱动）：由 22 次真实运行轨迹统计出的"实际被调用过的工具并集"。
 * 实测（同批 11 用例）：注入全部 → 9 个工具，输入 token 137k → 62k（−54%），通过率不变
 * （逐次数据见 `evals/reports/{baseline,learned-9-tools}.json`；不写死工具数量，
 * 那个数字会随新增工具漂移）。
 */
export const LEARNED_CORE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Write',
  'Edit',
  'StrReplaceEditor',
  'Bash',
  'ReviewArtifact',
  'AskUser',
] as const;

/** chat（只读面）的子集：读类 + 提问。 */
const CHAT_CORE_TOOLS = ['Read', 'Grep', 'Glob', 'AskUser'] as const;

const INTEGRATION_SIGNALS = ['slack', 'notion', 'drive', '网页', '搜索', 'web', '抓取', 'http', '接口文档'];
const EXEC_SIGNALS = [
  '测试',
  'test',
  '构建',
  'build',
  '运行',
  'run',
  'lint',
  'typecheck',
  '命令',
  'command',
  '安装',
  'install',
];
const COLLAB_SIGNALS = ['子代理', '子任务', '并行', 'subagent', 'parallel', '多个 agent', '调研'];
const META_SIGNALS = ['会话', '历史', '记忆', 'skill', '技能', '目标', 'goal', '任务列表', '后台任务', '巡检'];

/** 按任务面与文本信号选组：chat 只读，work/code 才需要写与执行。 */
export function selectToolGroups(opts: ToolSelectionOptions): Set<ToolGroup> {
  const text = (opts.task ?? '').toLowerCase();
  const surface = opts.surface ?? 'code';
  // 默认只给「学习核心集」，其余分组按信号增补 —— 这是 token 收益的来源。
  const groups = new Set<ToolGroup>();
  if (INTEGRATION_SIGNALS.some((s) => text.includes(s))) groups.add('integrate');
  if (COLLAB_SIGNALS.some((s) => text.includes(s))) groups.add('collaborate');
  if (META_SIGNALS.some((s) => text.includes(s))) groups.add('meta');
  if (surface !== 'chat' && EXEC_SIGNALS.some((s) => text.includes(s))) groups.add('exec');
  return groups;
}

/**
 * 选集合：学习核心集（按面裁剪）+ 信号命中的扩展分组 + **永不丢弃的保留集**。
 *
 * 保留集是这次修回归加上的：MCP / 插件工具的名字落不进分组正则，缺了它就等于
 * "装了的工具看不见"（见 `retainByDefault` 的说明）。
 */
export function selectToolsForTask<T extends { name: string }>(all: T[], opts: ToolSelectionOptions = {}): T[] {
  const core: readonly string[] = (opts.surface ?? 'code') === 'chat' ? CHAT_CORE_TOOLS : LEARNED_CORE_TOOLS;
  const groups = selectToolGroups(opts);
  const retain = opts.retain ?? retainByDefault;
  return all.filter((tool) => core.includes(tool.name) || groups.has(groupOfTool(tool.name)) || retain(tool.name));
}

/** 发现入口：agent 用它按需放开分组（合成工具，不进 registry）。 */
export const TOOL_SEARCH_DEF: ToolDef = {
  name: 'ToolSearch',
  description:
    '当前只加载了核心工具集。需要其它能力时先调用本工具放开对应分组，然后再调用具体工具。可用的组：integrate（联网检索 / Slack / Notion / Drive / 定时任务 / 插件）、collaborate（子代理 / 消息 / 汇报）、meta（会话检索 / 技能 / 目标 / 后台任务）、exec（终端 / 代码执行 / 后台任务控制）、edit（写文件 / 提交）、read、verify、plan。',
  input_schema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        items: { type: 'string' },
        description: '要放开的工具分组名',
      },
      query: { type: 'string', description: '可选：用自然语言描述需要的能力（如“抓取网页”）' },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
};

const QUERY_TO_GROUPS: { group: ToolGroup; test: (q: string) => boolean }[] = [
  { group: 'integrate', test: (q) => /web|网页|抓取|联网|slack|notion|drive|定时|cron|插件|http/.test(q) },
  { group: 'collaborate', test: (q) => /子代理|子任务|并行|agent|汇报|消息/.test(q) },
  { group: 'meta', test: (q) => /会话|历史|记忆|技能|skill|目标|goal|任务列表/.test(q) },
  { group: 'exec', test: (q) => /终端|命令|执行|后台|跑|terminal|shell/.test(q) },
  { group: 'edit', test: (q) => /写|改|编辑|提交|git|write|edit/.test(q) },
];

/** 解析一次 ToolSearch 请求 → 需要新加入的工具（纯函数）。 */
export function resolveToolSearch<T extends { name: string }>(
  all: T[],
  args: { groups?: string[]; query?: string },
  current: { name: string }[],
): T[] {
  const valid: ToolGroup[] = ['read', 'edit', 'exec', 'verify', 'plan', 'collaborate', 'integrate', 'meta'];
  const wanted = new Set<ToolGroup>();
  for (const g of args.groups ?? []) if ((valid as string[]).includes(g)) wanted.add(g as ToolGroup);
  const query = (args.query ?? '').toLowerCase();
  if (query) for (const m of QUERY_TO_GROUPS) if (m.test(query)) wanted.add(m.group);
  if (wanted.size === 0) return [];
  const have = new Set(current.map((t) => t.name));
  return all.filter((tool) => wanted.has(groupOfTool(tool.name)) && !have.has(tool.name));
}
import type { ToolDef } from '../tool-defs/types';
