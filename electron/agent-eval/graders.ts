/**
 * graders.ts — 任务级判分（纯函数）。
 *
 * 判的是「任务目标有没有达成」而不是「工具有没有调用成功」：
 * 文件内容断言、无关文件是否被改、基线对比。跑完 Agent 后用工作区快照判分，
 * 结果写入回归报告（scripts/agent-eval.cjs）。
 */

export type EvalCheck =
  | { id: string; kind: 'file_contains'; path: string; needle: string }
  | { id: string; kind: 'file_equals'; path: string; value: string }
  | { id: string; kind: 'file_changed'; path: string }
  | { id: string; kind: 'file_unchanged'; path: string }
  | { id: string; kind: 'no_unexpected_changes'; allow: string[] };

export interface EvalSnapshot {
  /** 跑完 Agent 后的工作区（相对路径 → 文本内容）。 */
  files: Record<string, string>;
  /** 初始工作区，用于 changed / unchanged 判定。 */
  baseline?: Record<string, string>;
}

export interface EvalCheckResult {
  id: string;
  passed: boolean;
  detail: string;
}

function changed(snapshot: EvalSnapshot, path: string): boolean {
  if (!snapshot.baseline) return snapshot.files[path] !== undefined;
  return snapshot.files[path] !== snapshot.baseline[path];
}

export function runChecks(checks: EvalCheck[], snapshot: EvalSnapshot): EvalCheckResult[] {
  return checks.map((check) => {
    switch (check.kind) {
      case 'file_contains': {
        const content = snapshot.files[check.path];
        const passed = typeof content === 'string' && content.includes(check.needle);
        return { id: check.id, passed, detail: passed ? 'ok' : `${check.path} 不含 ${JSON.stringify(check.needle)}` };
      }
      case 'file_equals': {
        const passed = snapshot.files[check.path] === check.value;
        return { id: check.id, passed, detail: passed ? 'ok' : `${check.path} 内容与期望不一致` };
      }
      case 'file_changed': {
        const passed = changed(snapshot, check.path);
        return { id: check.id, passed, detail: passed ? 'ok' : `${check.path} 未被修改` };
      }
      case 'file_unchanged': {
        const passed = !changed(snapshot, check.path);
        return { id: check.id, passed, detail: passed ? 'ok' : `${check.path} 被意外修改` };
      }
      case 'no_unexpected_changes': {
        const allow = new Set(check.allow);
        const baseline = snapshot.baseline ?? {};
        const names = new Set([...Object.keys(baseline), ...Object.keys(snapshot.files)]);
        const unexpected = [...names].filter((p) => !allow.has(p) && changed(snapshot, p));
        const passed = unexpected.length === 0;
        return { id: check.id, passed, detail: passed ? 'ok' : `无关文件被改动：${unexpected.join(', ')}` };
      }
      default:
        return { id: (check as EvalCheck).id, passed: false, detail: '未知的检查类型' };
    }
  });
}

/** 通过率（0~1）——回归报告的主分数。 */
export function scoreOf(results: EvalCheckResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.passed).length / results.length;
}

/** 任务是否算通过：所有检查必须通过（不做部分给分）。 */
export function taskPassed(results: EvalCheckResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}
