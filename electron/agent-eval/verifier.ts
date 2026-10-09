/**
 * verifier.ts — 任务级验证器（Task Verifier）。
 *
 * 回答的是「目标是否达成」，不是「工具是否成功」：综合目标断言结果、轨迹证据
 * （编辑后有没有真的跑过验证、有没有失败的工具调用）给出结论与置信度。
 */
import type { AgentTraceRun } from '../contracts/agent-trace';
import type { EvalCheckResult } from './graders';

export type VerificationStatus = 'verified' | 'partial' | 'unverified' | 'regressed';

export interface VerificationEvidence {
  kind: 'check' | 'edit' | 'verification_command' | 'missing_verification' | 'tool_failure';
  detail: string;
}

export interface TaskVerification {
  status: VerificationStatus;
  confidence: number;
  evidence: VerificationEvidence[];
}

const MUTATING = new Set(['Write', 'Edit', 'NotebookEdit', 'StrReplaceEditor', 'Delete']);
const VERIFYING = new Set(['Bash', 'Pwsh', 'ReviewArtifact']);

export function verifyTask(checks: EvalCheckResult[], trace: AgentTraceRun | null): TaskVerification {
  const evidence: VerificationEvidence[] = [];
  const failed = checks.filter((c) => !c.passed);
  const passedCount = checks.length - failed.length;
  const score = checks.length === 0 ? 0 : passedCount / checks.length;
  for (const f of failed) evidence.push({ kind: 'check', detail: `${f.id}: ${f.detail}` });

  let editAt = 0;
  let verifiedAfterEdit = false;
  let toolFailures = 0;
  let lastEditIndex = -1;
  const calls = trace?.toolCalls ?? [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    if (MUTATING.has(call.name) && call.status === 'done') {
      editAt = Math.max(editAt, call.endedAt ?? call.startedAt);
      lastEditIndex = i;
    }
    if (call.status === 'error') toolFailures += 1;
  }
  // 顺序判定：最后一次修改之后出现过成功的验证命令才算数。
  for (let i = lastEditIndex + 1; i < calls.length; i += 1) {
    if (VERIFYING.has(calls[i].name) && calls[i].status === 'done') verifiedAfterEdit = true;
  }
  if (editAt > 0) evidence.push({ kind: 'edit', detail: `最后一次修改在 ${new Date(editAt).toISOString()}` });
  if (verifiedAfterEdit) {
    evidence.push({ kind: 'verification_command', detail: '修改之后执行过验证命令（Bash / ReviewArtifact）' });
  } else if (editAt > 0) {
    // 改了东西却没有验证证据：目标断言通过也不能给满分置信度。
    evidence.push({ kind: 'missing_verification', detail: '修改之后没有执行验证命令，完成度缺少运行证据' });
  } else if (!trace) {
    // 没有轨迹时无从判断「谁改的、改完有没有验证」——只能给低置信度。
    evidence.push({ kind: 'missing_verification', detail: '缺少运行轨迹，无法确认修改与验证过程' });
  }
  if (toolFailures > 0) evidence.push({ kind: 'tool_failure', detail: `${toolFailures} 次工具调用失败` });

  // regressed：目标没达成 + 还顺手动/破坏了不该动的东西（由 no_unexpected_changes 失败暴露）。
  const regressed = failed.some((c) => c.id.includes('scope') || c.id.includes('unexpected'));
  let confidence = score;
  if (verifiedAfterEdit) confidence += 0.15;
  else if (editAt > 0) confidence = Math.min(confidence, 0.75);
  else if (!trace) confidence = Math.min(confidence, 0.6);
  if (toolFailures > 0) confidence -= Math.min(0.2, 0.05 * toolFailures);
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  const status: VerificationStatus =
    checks.length === 0
      ? 'unverified'
      : failed.length === 0
        ? 'verified'
        : regressed
          ? 'regressed'
          : passedCount === 0
            ? 'unverified'
            : 'partial';
  return { status, confidence, evidence };
}
