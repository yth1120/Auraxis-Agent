/**
 * approval-ledger.ts — 审批决策台账（权限通道 → 轨迹）。
 *
 * 轨迹契约里的 `TraceApproval` 写明「来自权限通道，**由调用方注入投影**，不在 Agent 日志里」
 * （见 `electron/contracts/agent-trace.ts` 的 TraceApproval 注释）。本模块就是那份
 * 「权限通道侧可取用的记录」——在契约要求的位置补上生产者，而不是另建一套持久化。
 *
 * 与 `approval-fatigue.ts` 的分工（两者在决策点并列调用，互不依赖）：
 *   · fatigue 是**策略计算层**：滚动窗口算疲劳分，只留最近若干条、无 id、本就不打算持久化；
 *   · 本模块是**记录层**：保留 id 与时间戳，供轨迹投影读取。
 *
 * 有界：每个 scope 最多 `MAX_PER_SCOPE` 条（与 fatigue 同量级），长会话不会无界增长。
 * 内存态：轨迹在 Agent 终止时于**同一进程内**投影，因此无需落盘。跨重启的审批审计是
 * 另一件事（涉及保留策略与存放位置的产品决策），不在本模块范围内。
 */
import type { TraceApproval } from '../contracts/agent-trace';

/** 与 `approval-fatigue.ts` 的 MAX_EVENTS_PER_SCOPE 同量级。 */
const MAX_PER_SCOPE = 200;

const ledgers = new Map<string, TraceApproval[]>();
let seq = 0;

/** 记录一次审批决策。scope 用 agentId —— 与疲劳统计同一把键，便于对照。 */
export function recordApproval(
  scope: string,
  toolName: string,
  status: TraceApproval['status'],
  at: number = Date.now(),
): void {
  const key = scope || 'default';
  let list = ledgers.get(key);
  if (!list) {
    list = [];
    ledgers.set(key, list);
  }
  seq += 1;
  list.push({ id: `approval-${seq}`, ...(toolName ? { toolName } : {}), at, status });
  if (list.length > MAX_PER_SCOPE) list.splice(0, list.length - MAX_PER_SCOPE);
}

/**
 * 读某个 scope 的审批记录。
 *
 * **非排空**：同一次运行可能被投影多次（例如重试），排空会让第二次拿到空数组，
 * 表现为「轨迹里审批时有时无」。有界上限已经足够控制内存。
 */
export function approvalsFor(scope: string): TraceApproval[] {
  // 连元素一起复制：只复制数组会让调用方改到台账里的对象（审计数据不应被消费者改写）。
  return (ledgers.get(scope || 'default') ?? []).map((a) => ({ ...a }));
}

/** Test seam — 清空台账。 */
export function resetApprovalLedger(): void {
  ledgers.clear();
  seq = 0;
}
