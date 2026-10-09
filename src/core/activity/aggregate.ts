/**
 * aggregate.ts — 把连续的同类操作收成一行（纯函数）。
 *
 * 动机：一次"修一下登录"的执行里，模型会连着读 8 个文件、跑 3 次 Grep、敲 4 条命令。
 * 逐个平铺的话聊天区会被工具行淹没 —— 用户要理解的是**agent 干了什么**，
 * 不是运行时内部派发了多少次调用。
 *
 * 两条硬规矩，都是为了不骗人：
 *
 *   1. **永不合并**"还在跑"、"失败/被取消"、以及带 ± 与文件身份的那些操作
 *      （改动、子代理、权限、计划、报错…）。用户必须能在顶层直接看到"正在做什么"
 *      和"哪里出了问题"，而不是把它们藏进一个折叠行里。
 *   2. 聚合出来的计数**只从真实字段求和**（`summaryFacts`），推不出来的部分就不显示，
 *      绝不用"大约/预计"凑一个数。
 *
 * 与批次（`stepGroupId`）的关系：批次是"同一轮 LLM 并行派发"的实现细节，只在展开体里
 * 才可能有意义；顶层一律以这里产出的段为准。段内 `items` 是**同一批对象引用**，
 * 所以展开后就是真实的那几行 —— 用户永远能下钻到具体的一条。
 */
import type { ActivityItem, ActivityStatus } from '../../types/activity';
import { foldActivityStatus } from '../../types/activity';

/**
 * 可聚合的类别。
 *
 * 刻意不直接用 `ActivityType`：那个粒度太粗 —— `read_file` 混了本地 Read 与联网 WebFetch，
 * `search` 混了 Grep（命中）与 Glob（路径），`terminal` 混了跑测试与跑构建。
 * 单位不同的东西合并到一起，计数就没有意义了。
 */
export type AggregateClass =
  | 'read_file'
  | 'search_matches'
  | 'search_paths'
  | 'terminal'
  | 'test'
  | 'build'
  | 'inspect';

/** 少于这个数量就不值得聚合（两行比一行 + 一个折叠头更好读）。 */
export const MIN_AGGREGATE = 3;

const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'ReadDocument', 'ReadSpill']);
/** 这些状态下**永不**聚合：正在跑的要看得到，失败的/被取消的更要看得到。 */
const UNMERGEABLE_STATUSES: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>([
  'pending',
  'running',
  'waiting',
  'failed',
  'cancelled',
  'skipped',
]);

/**
 * 这条 Activity 能不能进聚合，能的话属于哪一类。
 * 返回 `null` = 必须单独成行（顶层可见）。
 */
export function aggregateClassOf(item: ActivityItem): AggregateClass | null {
  if (UNMERGEABLE_STATUSES.has(item.status)) return null;
  switch (item.type) {
    case 'read_file':
      return item.toolName && READ_TOOLS.has(item.toolName) ? 'read_file' : null;
    case 'search':
      return item.toolName === 'Grep' ? 'search_matches' : null;
    case 'list_files':
      return item.toolName === 'Glob' ? 'search_paths' : null;
    case 'terminal':
      return 'terminal';
    case 'test':
      return 'test';
    case 'build':
      return 'build';
    // inspect 类工具（运行时自省 / 调度 / 插件）只在**同一个工具**连续出现时才合并：
    // 把 CronList 和 InspectRuntime 加成"N 次检查"没有任何信息量。
    case 'inspect':
      return item.toolName ? 'inspect' : null;
    default:
      return null;
  }
}

export interface ActivitySegment {
  /** React key。聚合段用首个子项 id 构成，流式过程中保持稳定（不会反复重挂载）。 */
  key: string;
  kind: 'single' | 'aggregate';
  /** `kind === 'aggregate'` 时的类别。 */
  klass?: AggregateClass;
  /** inspect 类聚合段的工具名（标题直接用工具自己的名字）。 */
  toolName?: string;
  /** 真实子项（含 `single` 段的唯一那一条）。 */
  items: ActivityItem[];
  /** 段状态 = 子项状态的折叠（与列表其它地方同一套优先级）。 */
  status: ActivityStatus;
}

function segmentOf(items: ActivityItem[], kind: ActivitySegment['kind'], klass?: AggregateClass): ActivitySegment {
  const first = items[0];
  const base: ActivitySegment = {
    key: kind === 'aggregate' ? `agg:${klass ?? first.toolName}:${first.id}` : first.id,
    kind,
    items,
    // 空数组只会出现在"聚合段"上 —— 那种情况不会发生（段至少 min≥1 条），折叠函数
    // 的 null 分支用默认值兜住，免得为了一个不可能的情形在调用点写断言。
    status: foldActivityStatus(items.map((i) => i.status)) ?? 'completed',
  };
  if (klass) base.klass = klass;
  if (klass === 'inspect' && first.toolName) base.toolName = first.toolName;
  return base;
}

/** 同一类才能并进同一个段；inspect 还要求工具名相同。 */
function breaksRun(klass: AggregateClass, item: ActivityItem, runClass: AggregateClass | null, runTool?: string): boolean {
  if (runClass === null || klass !== runClass) return true;
  return klass === 'inspect' && item.toolName !== runTool;
}

/**
 * 有序 Activity → 有序段。
 *
 * 单遍扫描：能聚合的连续同类项攒在一起，够了 `min` 条就成段，不够就还原成单行
 * （顺序不变，也不会把不足数的碎片跨过中间的单行"接起来"）。
 */
export function aggregateActivities(items: readonly ActivityItem[], min = MIN_AGGREGATE): ActivitySegment[] {
  const segments: ActivitySegment[] = [];
  let run: ActivityItem[] = [];
  let runClass: AggregateClass | null = null;
  let runTool: string | undefined;

  const flush = () => {
    if (run.length > 0) {
      if (run.length >= min && runClass) segments.push(segmentOf(run, 'aggregate', runClass));
      else for (const item of run) segments.push(segmentOf([item], 'single'));
    }
    run = [];
    runClass = null;
    runTool = undefined;
  };

  for (const item of items) {
    const klass = aggregateClassOf(item);
    if (!klass) {
      flush();
      segments.push(segmentOf([item], 'single'));
      continue;
    }
    if (run.length > 0 && breaksRun(klass, item, runClass, runTool)) flush();
    if (run.length === 0) {
      runClass = klass;
      runTool = item.toolName;
    }
    run.push(item);
  }
  flush();
  return segments;
}

/**
 * 段的计数。
 *
 * `matches` 只在**每一个**子项都给了真实命中数时才求和 —— 有一项没有就不显示总数，
 * 而不是拿"已知的那几项"冒充全部。
 */
export function aggregateCounts(seg: ActivitySegment): { count: number; matches?: number } {
  const count = seg.items.length;
  if (seg.klass !== 'search_matches' && seg.klass !== 'search_paths') return { count };
  const values = seg.items.map((i) => i.summaryFacts?.matchCount);
  if (values.some((v) => typeof v !== 'number')) return { count };
  return { count, matches: (values as number[]).reduce((a, b) => a + b, 0) };
}

/** 长历史折叠的门槛：段数超过它、且 Run 已结束，才把最早的折起来。 */
export const FOLD_THRESHOLD = 24;
/** 折叠后保留最近多少段。 */
export const FOLD_KEEP_RECENT = 12;

export interface FoldedHistory {
  /** 被折叠起来的较早的段（展开即真实段）。 */
  older: ActivitySegment[];
  /** 始终显示的最近若干段。 */
  recent: ActivitySegment[];
}

/**
 * 长任务的历史折叠。
 *
 * 只在**已结束**且段数超过 `FOLD_THRESHOLD` 时返回结果 —— 运行中折叠会让用户看不到
 * 进展，那是最不该藏信息的时候。判定放在调用方（它知道 Run 的状态），这里只管切分。
 */
export function foldLongHistory(
  segments: readonly ActivitySegment[],
  keepRecent = FOLD_KEEP_RECENT,
): FoldedHistory | null {
  if (segments.length <= FOLD_THRESHOLD || keepRecent >= segments.length) return null;
  const cut = segments.length - keepRecent;
  return { older: segments.slice(0, cut), recent: segments.slice(cut) };
}
