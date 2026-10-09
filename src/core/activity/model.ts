/**
 * model.ts — Activity 模型（纯函数，无 React / 无 zustand）。
 *
 * **派生优先（derived-first）**：Activity **不是**第二份状态，而是既有状态的纯投影。
 * 工具生命周期已经活在 `useChatStore.messages[].toolCalls` 里（由 `appendToolCall` /
 * `updateToolCall` 维护），并且那 10 个会改动 messages 的入口（发消息 / 重试 / 删除 /
 * 重新生成 / 切会话 / 清空 / fork / 回滚 / 水合…）都已经在维护它。再存一份 ActivityItem
 * 就等于把这些入口全部再实现一遍，漏一条就是"Run 还在、步骤没了"。
 *
 * 所以：**这里没有 applyEvent，只有 buildActivityRun**。事件改变的是 `ToolCall`，
 * Activity 跟着变；刷新后 `ToolCall` 由 localStorage 恢复，Activity 用同一个函数重建，
 * 不需要任何"投影重建"的特殊路径。
 *
 * 放在 `src/core/` 而不是 `src/components/`：纯逻辑优先抽成可测函数（本仓库约定），
 * 且 `src/components/**` 不在覆盖率门禁范围内，而这块逻辑值得被门禁盯着。
 */
import type {
  ActivityDiffArtifact,
  ActivityItem,
  ActivityRun,
  ActivityStatus,
  ActivitySummaryFacts,
} from '../../types/activity';
import type { CompactionData, ContextDisclosure, PlanData } from '../../types/chat';
import type { ToolCall } from '../../types/tools';
import type { PermissionRequest } from '../../types/advanced';
import type { BrowserAnnotation } from '../../types/browser';
import { annotationLabel } from './annotation';
import { activityTypeForTool, canProduceDiff, isFileMutationTool } from './presentation';
import { countDiffChanges } from '../../utils/unifiedDiff';

/**
 * 计算 ± 行数的代价上限。
 *
 * `countDiffChanges` 走 LCS，时间是 O(n·m)、内存是一张 (n+1)×(m+1) 的表。单文件展开看
 * diff 时这个代价可以接受（今天 `DiffView` 就是这么做的），但**每个 Write/Edit 都算一遍**
 * 会让一次改了十几个大文件的长跑把渲染进程拖死。超过这个格子数就不算：
 * 宁可不显示 ±，也不显示一个编出来的数字。
 */
export const MAX_DIFF_CELLS = 250_000;

/** 参与 Run 构建的消息（`Message` 的结构子集，避免与 chat 类型强耦合到循环依赖）。 */
export interface RunMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: number;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  tags?: ('warning' | 'error' | 'system' | 'injected')[];
  plan?: PlanData;
  compaction?: CompactionData;
  disclosure?: ContextDisclosure;
  permissionRequest?: PermissionRequest;
}

/**
 * Run 的真实终态。
 *
 * **必须由 UI 显式标记**，因为 `stopStreaming`（用户停止、看门狗静默断连、总超时）
 * 只清 `isStreaming`、不改消息本身 —— 光看消息推导不出"这一轮是被停掉的"。
 * 三种 reason 对应用户能理解的三种事实，不要合并成一句"已取消"。
 */
export interface RunTerminal {
  status: 'completed' | 'failed' | 'cancelled';
  at: number;
  reason?: 'stopped' | 'timeout' | 'disconnected';
}

export interface BuildRunInput {
  /** 本轮的 assistant 消息。 */
  message: RunMessage;
  /** 紧随其后、属于本轮的合成消息（计划批准、上下文注入/压缩、权限请求）。 */
  followers?: RunMessage[];
  terminal?: RunTerminal;
  /** 审批决策（requestId → 结果）；渲染层自己记录，主进程台账不回传。 */
  approvals?: Record<string, 'granted' | 'denied'>;
  /**
   * 本轮**收到**的用户页面标注（来自上一条用户消息）。
   *
   * 放在 Run 里而不是只挂在用户消息上：它是这一轮执行的输入之一，
   * 用户应该能在"这一轮到底基于什么在干活"里看到它。来源是真实数据（用户点的元素 + 写的评论）。
   */
  annotations?: readonly BrowserAnnotation[];
  now: number;
}

function diffArtifactFor(toolName: string | undefined, output: unknown): ActivityDiffArtifact | undefined {
  if (!canProduceDiff(toolName)) return undefined;
  if (!output || typeof output !== 'object') return undefined;
  const o = output as { oldContent?: unknown; newContent?: unknown; file_path?: unknown };
  const oldContent = typeof o.oldContent === 'string' ? o.oldContent : undefined;
  const newContent = typeof o.newContent === 'string' ? o.newContent : undefined;
  if (oldContent === undefined && newContent === undefined) return undefined;
  const path = typeof o.file_path === 'string' ? o.file_path : '';
  const oldText = oldContent ?? '';
  const newText = newContent ?? '';
  const oldLines = oldText === '' ? 0 : oldText.split('\n').length;
  const newLines = newText === '' ? 0 : newText.split('\n').length;
  if (oldLines * newLines > MAX_DIFF_CELLS) {
    return { path, added: 0, removed: 0, truncated: true };
  }
  const { added, removed } = countDiffChanges(oldText, newText);
  return { path, added, removed, oldContent: oldText, newContent: newText };
}

/** `ToolCall.status`（工具词表）→ `ActivityStatus`（Activity 词表）。**唯一**一处映射。 */
function statusOfToolCall(tc: ToolCall, runLive: boolean): ActivityStatus {
  switch (tc.status) {
    case 'running':
      // 运行已经结束却还挂着 running：产生它的进程没了（应用退出 / 刷新）。
      // 这是可观测的事实，不是猜测 —— 如实标成中断，别让它永远转圈。
      return runLive ? 'running' : 'cancelled';
    case 'pending':
      return runLive ? 'pending' : 'cancelled';
    case 'done':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting':
      return 'waiting';
    default:
      return 'completed';
  }
}

function toolCallToItem(tc: ToolCall, runId: string, runLive: boolean): ActivityItem {
  const status = statusOfToolCall(tc, runLive);
  const facts = (tc.summary as ActivitySummaryFacts | undefined) ?? undefined;
  const diff = diffArtifactFor(tc.toolName, tc.output);
  const durationMs = tc.durationMs ?? (tc.endTime !== undefined ? tc.endTime - tc.startTime : undefined);
  return {
    id: tc.id,
    runId,
    parentId: null,
    type: activityTypeForTool(tc.toolName, tc.input),
    status,
    sourceEvent: 'tool',
    toolName: tc.toolName,
    toolCallId: tc.id,
    ...(tc.requestId ? { requestId: tc.requestId } : {}),
    ...(tc.stepGroupId ? { stepGroupId: tc.stepGroupId } : {}),
    startedAt: tc.startTime,
    ...(tc.endTime !== undefined ? { completedAt: tc.endTime } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tc.input ? { input: tc.input } : {}),
    ...(tc.output !== undefined ? { output: tc.output } : {}),
    ...(tc.error ? { error: tc.error } : {}),
    ...(facts ? { summaryFacts: facts } : {}),
    ...(diff ? { diff } : {}),
    // 实时输出存在 `message.toolCalls[].streamOutput` 上（`flushAll` 写的就是它），
    // 直接带上 —— 于是"终端实时刷新"是构造上成立的，不依赖另一条推送路径。
    ...(tc.streamOutput ? { liveOutput: tc.streamOutput } : {}),
  };
}

function planItem(plan: PlanData, runId: string, at: number): ActivityItem {
  return {
    id: `plan-${plan.planId}`,
    runId,
    parentId: null,
    type: 'plan',
    status: plan.status === 'rejected' ? 'cancelled' : 'completed',
    sourceEvent: 'plan',
    startedAt: at,
    completedAt: at,
    // 这两个数**放进 summaryFacts**：facts 就是给"渲染用的事实"准备的（契约里明确
    // 语言无关、由展示层翻译），而 `input` 是工具的原始入参。否则这一行在界面上是空的。
    summaryFacts: {
      steps: plan.steps.length,
      approved: plan.approvedStepIds?.length ?? 0,
    },
    input: {
      steps: plan.steps.length,
      approved: plan.approvedStepIds?.length ?? 0,
    },
  };
}

function contextItem(
  kind: 'injected' | 'compressed',
  data: ContextDisclosure | CompactionData,
  id: string,
  runId: string,
  at: number,
): ActivityItem {
  const isCompaction = kind === 'compressed';
  const d = data as CompactionData;
  return {
    id,
    runId,
    parentId: null,
    type: 'context',
    status: 'completed',
    sourceEvent: isCompaction ? 'context_compressed' : 'context_injected',
    startedAt: at,
    completedAt: at,
    summaryFacts: isCompaction
      ? { tokensBefore: d.tokensBefore, tokensAfter: d.tokensAfter, messagesRemoved: d.messagesRemoved }
      : { producer: (data as ContextDisclosure).producer, source: (data as ContextDisclosure).source },
  };
}

/**
 * 权限请求项。
 *
 * `id` 就是那条权限消息的 id —— 审批卡片的原始对象按它索引（见 `AgentRun` 的
 * `permissions`）。刻意**不**复用 `item.requestId`：契约里那个字段指的是查询请求 id
 * （中止/重试靠它回主进程），与权限 requestId 同名不同域，混用会让后来的读者踩坑。
 */
function permissionItem(
  req: PermissionRequest,
  id: string,
  runId: string,
  at: number,
  approvals: Record<string, 'granted' | 'denied'> | undefined,
  runLive: boolean,
): ActivityItem {
  const decision = approvals?.[req.requestId];
  /**
   * 未决策的请求**只可能属于正在跑的这一轮**。
   *
   * 两条真实路径逼出这个判据：① 权限消息会被持久化（`sessionStorage` 不过滤它），
   * 重开会话时它又回来了，而决策只存在内存里 → 若一律记 `waiting`，界面就会给一条
   * 早已结束的请求挂出可点的审批卡，卡片的 120s 倒计时还会当场把它写成「已拒绝」；
   * ② 主进程自动拒绝不会回传 IPC，行折叠时卡片根本没挂载，也没人记决策。
   *
   * 所以：这一轮没在跑 → 这条请求不可能还在等 → 记 `skipped`（「没做成」），
   * 由界面如实说「已失效」，而不是伪造一个决策。
   */
  const status: ActivityStatus =
    decision === 'granted' ? 'completed' : decision === 'denied' ? 'cancelled' : runLive ? 'waiting' : 'skipped';
  return {
    id,
    runId,
    parentId: null,
    type: 'permission',
    status,
    sourceEvent: 'permission',
    toolName: req.toolName,
    startedAt: req.timestamp || at,
    ...(decision ? { completedAt: at } : {}),
    input: req.input,
  };
}

/**
 * 一轮执行改动了哪些文件（去重、保持出现顺序）。
 *
 * **唯一实现**：Run 统计与消息尾部的产物清单都调它。从前 `MessageList` 自己又写了一遍
 * "Write/Edit/NotebookEdit" 的白名单 —— 那是同一份能力集合的第三处副本（另两处是
 * `tool-capability.ts` 与展示层的 `isFileMutationTool`），AGENTS.md 明确禁止。
 */
export function collectChangedFiles(items: readonly ActivityItem[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isFileMutationTool(item.toolName)) continue;
    const path = item.diff?.path ?? (typeof item.input?.file_path === 'string' ? item.input.file_path : '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/** 单条消息改动的文件（消息尾部的产物清单用，不必先构建整棵 Run）。 */
export function changedFilesOfMessage(message: RunMessage): string[] {
  return collectChangedFiles((message.toolCalls ?? []).map((tc) => toolCallToItem(tc, message.id, false)));
}

function statsFor(items: readonly ActivityItem[], startedAt: number, endedAt: number): ActivityRun['stats'] {
  let errors = 0;
  let subAgents = 0;
  let terminals = 0;
  for (const item of items) {
    if (item.type === 'error' || item.status === 'failed') errors += 1;
    if (item.type === 'sub_agent') subAgents += 1;
    if (item.type === 'terminal' || item.type === 'test' || item.type === 'build') terminals += 1;
  }
  return {
    actions: items.length,
    filesChanged: collectChangedFiles(items).length,
    errors,
    subAgents,
    terminals,
    durationMs: Math.max(0, endedAt - startedAt),
  };
}

/**
 * 把一轮 assistant 消息（及其合成消息）投影成 ActivityRun。
 *
 * 纯函数：同样的输入永远得到同样的输出，因此刷新后重建的视图与运行中完全一致。
 */
export function buildActivityRun(input: BuildRunInput): ActivityRun {
  const { message, now } = input;
  const followers = input.followers ?? [];
  const runLive = message.isStreaming === true;
  const items: ActivityItem[] = [];

  for (const tc of message.toolCalls ?? []) items.push(toolCallToItem(tc, message.id, runLive));
  if (message.plan) items.push(planItem(message.plan, message.id, message.timestamp));
  if (message.disclosure)
    items.push(contextItem('injected', message.disclosure, `disclosure-${message.id}`, message.id, message.timestamp));
  if (message.compaction)
    items.push(contextItem('compressed', message.compaction, `compact-${message.id}`, message.id, message.timestamp));
  let annotationSeq = 0;
  for (const a of input.annotations ?? []) {
    items.push({
      id: a.id || `annot-${annotationSeq++}`,
      runId: message.id,
      parentId: null,
      type: 'browser_annotation',
      status: 'completed',
      // 它是用户输入，不是模型动作 —— 用 sourceEvent 如实标明来源。
      sourceEvent: 'user_annotation',
      startedAt: a.ts,
      completedAt: a.ts,
      summaryFacts: { message: a.comment, producer: annotationLabel(a), hash: a.selector },
      input: { url: a.url, selector: a.selector },
    });
  }
  for (const f of followers) {
    if (f.disclosure) {
      items.push(contextItem('injected', f.disclosure, f.id, message.id, f.timestamp));
    } else if (f.compaction) {
      items.push(contextItem('compressed', f.compaction, f.id, message.id, f.timestamp));
    } else if (f.permissionRequest) {
      items.push(permissionItem(f.permissionRequest, f.id, message.id, now, input.approvals, runLive));
    }
  }

  // 稳定排序：同一毫秒内保持"工具先、合成消息后"的插入顺序（事件真实的到达顺序）。
  items.sort((a, b) => a.startedAt - b.startedAt);

  const lastItemEnd = items.reduce((max, it) => Math.max(max, it.completedAt ?? it.startedAt), message.timestamp);
  const status = runStatus(input, items, runLive);
  const endedAt = status === 'running' || status === 'waiting' ? now : (input.terminal?.at ?? lastItemEnd);

  return {
    id: message.id,
    status,
    startedAt: message.timestamp,
    ...(status === 'running' || status === 'waiting' ? {} : { completedAt: endedAt }),
    items,
    stats: statsFor(items, message.timestamp, endedAt),
  };
}

function runStatus(input: BuildRunInput, items: readonly ActivityItem[], runLive: boolean): ActivityStatus {
  // 显式终态优先：用户停止 / 看门狗超时 / 静默断连都只清 isStreaming，光看消息推不出来。
  if (input.terminal) return input.terminal.status;
  if (items.some((it) => it.status === 'waiting')) return 'waiting';
  if (runLive) return 'running';
  // 流已结束且没有显式终态：消息标记了 error 就是失败，否则算正常完成。
  if (input.message.tags?.includes('error')) return 'failed';
  return 'completed';
}

// ─── 选择器 ────────────────────────────────────────────

/** 顶层 items（parentId === null），保持顺序。 */
export function selectRootItems(run: ActivityRun | undefined): ActivityItem[] {
  return run ? run.items.filter((it) => it.parentId === null) : [];
}

