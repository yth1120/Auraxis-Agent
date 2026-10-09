/**
 * agentCards.ts — 工具输出 → 专用卡片的**唯一**提取层（纯函数，不碰 JSX）。
 *
 * 此前这份提取逻辑在本仓库存在**三份**（`agent/AgentConversationRender.tsx` 的
 * `readCardProps`/`searchCardProps`/`webCardProps`、`inspector/TimelineRows.tsx` 的
 * `ReadDetail`/`GrepDetail`/`WebDetail`…、以及 Activity 视图自己那份），
 * 三份必然漂移 —— 同一个工具在三处会显示成不同的东西。
 *
 * 分层的边界是刻意的：
 *   · 本模块只回答「这份输出**是什么意思**」（纯数据 → props 模型），
 *     住在 `src/core/` 里，因而**在覆盖率门禁内**、可被单测直接钉住；
 *   · 具体怎么画由 `components/agent/ToolOutputCard.tsx` 决定，
 *     三个调用方共用同一个渲染件，各自保留自己的兜底样式（密度不同是合理的）。
 *
 * 返回 `null` 表示"没有专用卡片适用" —— 调用方据此走自己的通用面板，
 * 而不是拿一张空卡片糊弄过去。
 */
import type { ActivityItem } from '../../types/activity';
import { normalizeTodos } from './todos';

/** 提取层的最小输入：`AgentLogEntry` 与 `ActivityItem` 都结构兼容。 */
export interface ToolLike {
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

/** 运行期状态（呼叫方各自知道从哪个字段来）。 */
export interface ToolState {
  /** 正在运行（流式输出优先展示）。 */
  running?: boolean;
  failed?: boolean;
  /** 运行期流式文本（Bash 的实时输出），优先于 output.stdout。 */
  liveOutput?: string;
  /** 失败原因：权限拒绝 / 超时 / 工具报错。 */
  error?: string;
}

export interface ReadCardModel {
  label?: string;
  content: string;
  startLine?: number;
  totalLines?: number;
}

export interface SearchMatchGroup {
  path: string;
  matches: { lineNumber: number; line: string }[];
}

export interface SearchCardModel {
  kind: 'matches' | 'paths';
  files?: SearchMatchGroup[];
  paths?: string[];
  total?: number;
  truncated?: boolean;
}

export interface WebSourceModel {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}

export interface WebCardModel {
  kind: 'search' | 'fetch';
  /** 搜索答案或抓取到的正文 —— 两者都是"模型真正读到的那段文字"。 */
  answer?: string;
  sources?: WebSourceModel[];
  url?: string;
  statusCode?: number;
  truncated?: boolean;
}

export interface CodeCardModel {
  code: string;
  language?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

export interface DiffCardModel {
  oldContent: string;
  newContent: string;
  fileName?: string;
}

export interface TerminalCardModel {
  command: string;
  cwd?: string;
  output: string;
  exitCode?: number;
  running: boolean;
  failed: boolean;
}

/**
 * 常驻终端（PTY）会话的一次操作。
 *
 * 每个 `Terminal*` 工具的返回形状都不一样（见 `ipc/pty-tool.ts`），此前一律掉进通用
 * JSON 面板 —— `TerminalRead` 的返回值是**带 ANSI 转义的终端文本**，被
 * `JSON.stringify` 成 `{"output":"\u001b[32m…"}`，等于看不了。
 */
export interface PtySessionModel {
  id: string;
  command: string;
}

export interface PtyCardModel {
  action: 'create' | 'list' | 'read' | 'write' | 'signal' | 'close' | 'clear';
  sessionId?: string;
  command?: string;
  /** read：终端文本（可能含 ANSI 转义，由 TerminalBlock 解析）。 */
  output?: string;
  sessions?: PtySessionModel[];
  signal?: string;
  /** close：会话是否确实被关掉（SIGTERM/SIGKILL 与 close 都是真关）。 */
  closed?: boolean;
  /** clear：关掉了几个。 */
  closedCount?: number;
  /** write：发送了多少个字符（取自入参，真实值）。 */
  sentChars?: number;
}

export interface PlanStepModel {
  label: string;
  status: 'pending' | 'running' | 'done';
}

/**
 * 计划（`TodoWrite` / `Replan`）的清单。
 *
 * 从前聊天区把它渲染成 `{"todos":[…]}` 的原始 JSON —— 用户看不到计划内容，也看不到
 * 进度。这里给出的是**渲染需要的形状**，计数一律是真实条目数。
 */
export interface PlanCardModel {
  steps: PlanStepModel[];
  done: number;
  total: number;
  /** 超过 `maxSteps` 被截掉的条数（真实值，用于"还有 N 步"）。 */
  hiddenSteps: number;
}

export type AgentCard =
  | { card: 'terminal'; props: TerminalCardModel }
  | { card: 'pty'; props: PtyCardModel }
  | { card: 'read'; props: ReadCardModel }
  | { card: 'search'; props: SearchCardModel }
  | { card: 'web'; props: WebCardModel }
  | { card: 'code'; props: CodeCardModel }
  | { card: 'diff'; props: DiffCardModel }
  | { card: 'plan'; props: PlanCardModel };

// ─── 工具归类（与 presentation.ts 的语义类型同源，但这里是"用哪张卡"） ───

const TERMINAL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Pwsh']);
/** 常驻终端族的工具 → 那一次操作（`Pty` 不在此表：它的动作在入参里）。 */
const PTY_ACTION_BY_TOOL: Readonly<Record<string, PtyCardModel['action']>> = {
  TerminalOpen: 'create',
  TerminalList: 'list',
  TerminalRead: 'read',
  TerminalSend: 'write',
  TerminalSignal: 'signal',
  TerminalClose: 'close',
};
const PTY_ACTIONS: ReadonlySet<string> = new Set(['create', 'list', 'read', 'write', 'signal', 'close', 'clear']);
const READ_CARD_TOOLS: ReadonlySet<string> = new Set(['Read', 'ReadDocument', 'ReadSpill']);
const SEARCH_CARD_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);
const CODE_CARD_TOOLS: ReadonlySet<string> = new Set(['RunCode', 'RunWorkflow']);
/** 会带 oldContent/newContent 的工具（与 presentation.canProduceDiff 同一集合）。 */
const DIFF_CARD_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', 'StrReplaceEditor']);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Read 系：`{file_path, content, start_line, total_lines}`。 */
export function readCardModel(tool: ToolLike): ReadCardModel | null {
  const o = asRecord(tool.output);
  const content = str(o.content);
  // 内容为空就不给读卡（ReadImage 之类的结果在通用面板里反而显示得更对）。
  if (!content) return null;
  const filePath = str(o.file_path);
  const model: ReadCardModel = { content, startLine: num(o.start_line) ?? 1 };
  if (filePath) model.label = filePath;
  const totalLines = num(o.total_lines);
  if (totalLines !== undefined) model.totalLines = totalLines;
  return model;
}

/** Grep / Glob：命中按文件分组；Glob 只有路径列表。 */
export function searchCardModel(tool: ToolLike): SearchCardModel {
  const o = asRecord(tool.output);
  if (tool.toolName === 'Glob') {
    const paths = Array.isArray(o.paths)
      ? (o.paths as string[])
      : Array.isArray(tool.output)
        ? (tool.output as string[])
        : [];
    const total = num(o.match_count) ?? paths.length;
    return { kind: 'paths', paths, total, truncated: o.truncated === true };
  }
  const results = (Array.isArray(o.results) ? o.results : []) as {
    file?: string;
    line?: number;
    content?: string;
  }[];
  const byFile = new Map<string, SearchMatchGroup>();
  for (const result of results) {
    const path = str(result.file);
    if (!path) continue;
    let group = byFile.get(path);
    if (!group) {
      group = { path, matches: [] };
      byFile.set(path, group);
    }
    group.matches.push({ lineNumber: num(result.line) ?? 0, line: str(result.content) });
  }
  // 引擎在结果被截断时会回一个总数，比数组长度更可信。
  const total = num(o.match_count) ?? num(o.total_matches) ?? results.length;
  return { kind: 'matches', files: [...byFile.values()], total, truncated: o.truncated === true };
}

/**
 * WebSearch（`{query, results:[{title,snippet,url}]}`）与
 * WebFetch（`{url, content_type, content}`）。
 *
 * 抓取到的正文填进 `answer`：此前整个仓库**没有任何界面**显示过 WebFetch 的正文，
 * 卡片只有一个链接和一个多半不存在的状态码 —— 模型读到了内容，用户看不到。
 */
export function webCardModel(tool: ToolLike): WebCardModel {
  const o = asRecord(tool.output);
  const input = tool.input ?? {};
  const answer = str(o.answer);
  const content = str(o.content);
  if (tool.toolName === 'WebSearch') {
    const results = (Array.isArray(o.results) ? o.results : []) as {
      url?: string;
      title?: string;
      snippet?: string;
      publishedAt?: string;
    }[];
    const model: WebCardModel = {
      kind: 'search',
      sources: results.map((r) => {
        const source: WebSourceModel = { url: str(r.url) };
        if (r.title) source.title = r.title;
        if (r.snippet) source.snippet = r.snippet;
        if (r.publishedAt) source.publishedAt = r.publishedAt;
        return source;
      }),
      truncated: o.truncated === true,
    };
    if (answer) model.answer = answer;
    return model;
  }
  // 浏览器读页（BrowserRead）走的是同一种卡片。
  if (tool.toolName === 'BrowserRead') {
    const model: WebCardModel = { kind: 'fetch', url: str(o.url) || str(input.url) };
    if (content) model.answer = content;
    return model;
  }
  const model: WebCardModel = {
    kind: 'fetch',
    url: str(o.url) || str(input.url),
  };
  const body = answer || content;
  if (body) model.answer = body;
  const statusCode = num(o.status_code) ?? num(o.statusCode);
  if (statusCode !== undefined) model.statusCode = statusCode;
  return model;
}

export function codeCardModel(tool: ToolLike): CodeCardModel {
  const o = asRecord(tool.output);
  const input = tool.input ?? {};
  const model: CodeCardModel = { code: str(input.code) };
  if (typeof input.language === 'string') model.language = input.language;
  if (typeof o.stdout === 'string') model.stdout = o.stdout;
  if (typeof o.stderr === 'string') model.stderr = o.stderr;
  if (typeof o.exitCode === 'number' || o.exitCode === null) model.exitCode = o.exitCode as number | null;
  if (typeof o.timedOut === 'boolean') model.timedOut = o.timedOut;
  return model;
}

/** Write / Edit 的整文件前后内容。两者都在时才有 diff 可看。 */
export function diffCardModel(tool: ToolLike): DiffCardModel | null {
  const o = asRecord(tool.output);
  if (typeof o.oldContent !== 'string' || typeof o.newContent !== 'string') return null;
  const fileName = str(o.file_path) || str(tool.input?.file_path);
  return fileName
    ? { oldContent: o.oldContent, newContent: o.newContent, fileName }
    : { oldContent: o.oldContent, newContent: o.newContent };
}

/**
 * Bash / 终端：实时流 → 失败原因 → stdout+stderr。
 *
 * 退出码只呈现**真实值**：失败但引擎没给退出码时留空，由 TerminalBlock 用
 * "失败"胶囊表达 —— 不要编一个 `exitCode: 1` 出来。
 */
export function terminalCardModel(tool: ToolLike, state: ToolState = {}): TerminalCardModel {
  const o = asRecord(tool.output);
  const input = tool.input ?? {};
  const stdout = str(o.stdout);
  const stderr = str(o.stderr);
  const fallback = [stdout, stderr].filter(Boolean).join('\n');
  const output = state.liveOutput || state.error || fallback;
  const model: TerminalCardModel = {
    command: str(input.command),
    output,
    running: state.running === true,
    failed: state.failed === true,
  };
  const cwd = str(input.workdir) || str(input.cwd);
  if (cwd) model.cwd = cwd;
  const exitCode = num(o.exitCode);
  if (exitCode !== undefined) model.exitCode = exitCode;
  return model;
}

/** 计划工具：清单在 `input.todos`（模型**打算**做什么），回执在 `output.todos`。 */
const PLAN_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'Replan']);

/** 模型给的 status 是自由字符串，只认这三种，其余按 pending 处理。 */
function planStatusOf(raw: string): PlanStepModel['status'] {
  if (raw === 'completed') return 'done';
  if (raw === 'in_progress') return 'running';
  return 'pending';
}

export function planCardModel(tool: ToolLike, maxSteps = 12): PlanCardModel | null {
  if (!tool.toolName || !PLAN_TOOLS.has(tool.toolName)) return null;
  const o = asRecord(tool.output);
  // 入参优先：那是清单的**意图**，回执只是"收到了"（与 todos.ts 同一口径）。
  const raw = normalizeTodos(tool.input?.todos) ?? normalizeTodos(o.todos);
  if (!raw) return null;
  const steps: PlanStepModel[] = raw.map((t) => ({ label: t.content, status: planStatusOf(t.status) }));
  const counts = { done: steps.filter((s) => s.status === 'done').length, total: steps.length };
  const cut = steps.length > maxSteps ? steps.length - maxSteps : 0;
  return {
    steps: cut > 0 ? steps.slice(0, maxSteps) : steps,
    hiddenSteps: cut,
    ...counts,
  };
}

/** 折叠行上的一行摘要：`4/4 已完成`（真实计数；没有清单则返回 null）。 */
export function planSummary(tool: ToolLike): string | null {
  const model = planCardModel(tool);
  return model ? `${model.done}/${model.total}` : null;
}

/** 这次调用是什么动作：`Pty` 看入参 `action`，其余工具名本身就是动作。 */
export function ptyActionOf(tool: ToolLike): PtyCardModel['action'] | null {
  if (tool.toolName === 'Pty') {
    const action = str(tool.input?.action);
    return PTY_ACTIONS.has(action) ? (action as PtyCardModel['action']) : null;
  }
  return PTY_ACTION_BY_TOOL[tool.toolName ?? ''] ?? null;
}

/**
 * 常驻终端：按动作取真实字段。
 *
 * 各动作的返回形状（`ipc/pty-tool.ts`）：create → `{session_id, command}`；
 * list → `{sessions:[{id, command, createdAt}]}`；read → `{output}`；write/close →
 * `{ok:true}`；signal → `{signaled, session_id, closed?}`；clear → `{closed: 数量}`。
 */
export function ptyCardModel(tool: ToolLike): PtyCardModel | null {
  const action = ptyActionOf(tool);
  if (!action) return null;
  const o = asRecord(tool.output);
  const input = tool.input ?? {};
  const model: PtyCardModel = { action };

  const sessionId = str(o.session_id) || str(input.session_id);
  if (sessionId) model.sessionId = sessionId;

  switch (action) {
    case 'create': {
      const command = str(o.command) || str(input.command);
      if (command) model.command = command;
      break;
    }
    case 'list': {
      const raw = Array.isArray(o.sessions) ? o.sessions : [];
      model.sessions = raw
        .map((s) => asRecord(s))
        .filter((s) => str(s.id))
        .map((s) => ({ id: str(s.id), command: str(s.command) }));
      break;
    }
    case 'read':
      if (typeof o.output === 'string') model.output = o.output;
      break;
    case 'write':
      // 发出去多少个字符取自入参（返回只有 {ok:true}）——这是真实值，不是估算。
      if (typeof input.data === 'string') model.sentChars = input.data.length;
      break;
    case 'signal': {
      const signal = str(o.signaled) || str(input.signal).toUpperCase();
      if (signal) model.signal = signal;
      if (o.closed === true) model.closed = true;
      break;
    }
    case 'close':
      model.closed = true;
      break;
    case 'clear':
      if (typeof o.closed === 'number') model.closedCount = o.closed;
      break;
  }
  return model;
}

/**
 * 卡片分派顺序（**唯一一份声明**）。
 *
 * 顺序即优先级：diff 最具体，终端/代码/读取次之，检索与计划最后。
 * 这份清单同时是一道编译期护栏：`AgentCard` 新增一种卡片而没写进来，
 * 下面的断言会失败（`Exclude<…> extends never` 不成立）。
 */
export const CARD_ORDER = ['plan', 'diff', 'terminal', 'pty', 'code', 'read', 'search', 'web'] as const;
type _AllCardsListed = Exclude<AgentCard['card'], (typeof CARD_ORDER)[number]> extends never ? true : never;
const _assertAllCardsListed: _AllCardsListed = true;
void _assertAllCardsListed;

/**
 * 唯一的入口：这份工具输出该用哪张卡。
 *
 * 顺序即优先级 —— diff 最具体，终端/代码/读取次之，检索最后。
 * 返回 `null` 时调用方走自己的通用面板（错误文本 / JSON 预览 / 图片）。
 */
export function agentCardFor(tool: ToolLike, state: ToolState = {}): AgentCard | null {
  const name = tool.toolName;
  if (!name) return null;

  if (PLAN_TOOLS.has(name)) {
    const props = planCardModel(tool);
    if (props) return { card: 'plan', props };
  }
  if (DIFF_CARD_TOOLS.has(name)) {
    const props = diffCardModel(tool);
    if (props) return { card: 'diff', props };
  }
  if (TERMINAL_TOOLS.has(name)) {
    return { card: 'terminal', props: terminalCardModel(tool, state) };
  }
  // 常驻终端族在 Bash 之后判定（两族工具名不重叠，顺序只为可读）。
  if (name === 'Pty' || PTY_ACTION_BY_TOOL[name]) {
    const props = ptyCardModel(tool);
    if (props) return { card: 'pty', props };
  }
  if (CODE_CARD_TOOLS.has(name)) {
    return { card: 'code', props: codeCardModel(tool) };
  }
  if (READ_CARD_TOOLS.has(name)) {
    const props = readCardModel(tool);
    if (props) return { card: 'read', props };
  }
  if (SEARCH_CARD_TOOLS.has(name)) {
    return { card: 'search', props: searchCardModel(tool) };
  }
  if (name === 'WebSearch' || name === 'WebFetch' || name === 'BrowserOpen' || name === 'BrowserRead') {
    return { card: 'web', props: webCardModel(tool) };
  }
  return null;
}

/**
 * 图片类结果的 data URL（ReadImage / BrowserScreenshot）。
 *
 * 这类输出里夹着几十 KB 的 base64：JSON.stringify 出来既看不懂又难看，
 * 必须真的渲染成图片。三个调用方共用这一条判定。
 */
export function imageDataUrl(output: unknown): string | null {
  const image = asRecord(output).image;
  return typeof image === 'string' && image.startsWith('data:image/') ? image : null;
}

/** `ActivityItem` → 提取层输入（三个调用方里唯一需要转换的那个）。 */
export function activityTool(item: ActivityItem): { tool: ToolLike; state: ToolState } {
  const tool: ToolLike = { toolName: item.toolName, input: item.input, output: item.output };
  const state: ToolState = {
    running: item.status === 'running' || item.status === 'pending',
    failed: item.status === 'failed',
  };
  if (item.liveOutput) state.liveOutput = item.liveOutput;
  if (item.error) state.error = item.error;
  return { tool, state };
}
