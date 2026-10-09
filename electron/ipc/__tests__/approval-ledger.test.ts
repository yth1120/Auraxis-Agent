/**
 * approval-ledger.test.ts — 审批台账契约。
 *
 * 台账存在的理由是轨迹契约写明「审批来自权限通道、由调用方注入投影」
 * （见 contracts/agent-trace.ts 的 TraceApproval 注释）。这里钉住三件事：
 * 读取是非排空的、按 scope 隔离、且有界。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { approvalsFor, recordApproval, resetApprovalLedger } from '../approval-ledger';

beforeEach(() => {
  resetApprovalLedger();
});

describe('approval-ledger', () => {
  it('按 scope 记录并读回，id 唯一、时间戳可注入', () => {
    recordApproval('agent-a', 'Bash', 'requested', 1000);
    recordApproval('agent-a', 'Bash', 'granted', 1500);
    recordApproval('agent-b', 'Write', 'denied', 2000);

    const a = approvalsFor('agent-a');
    expect(a).toEqual([
      { id: 'approval-1', toolName: 'Bash', at: 1000, status: 'requested' },
      { id: 'approval-2', toolName: 'Bash', at: 1500, status: 'granted' },
    ]);
    // scope 之间互不串味。
    expect(approvalsFor('agent-b')).toEqual([{ id: 'approval-3', toolName: 'Write', at: 2000, status: 'denied' }]);
    expect(a[0].id).not.toBe(a[1].id);
  });

  // 排空会让同一次运行的第二次投影拿到空数组，表现为「轨迹里审批时有时无」。
  it('读取是非排空的：反复读取结果一致', () => {
    recordApproval('agent-a', 'Bash', 'granted');
    const first = approvalsFor('agent-a');
    const second = approvalsFor('agent-a');
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('返回深副本：改数组或改元素都不影响台账', () => {
    recordApproval('agent-a', 'Bash', 'granted', 1000);
    const snapshot = approvalsFor('agent-a');
    snapshot.push({ id: 'x', at: 0, status: 'unknown' });
    snapshot[0].status = 'denied';

    expect(approvalsFor('agent-a')).toEqual([{ id: 'approval-1', toolName: 'Bash', at: 1000, status: 'granted' }]);
  });

  it('空 scope 归一为 default，且未记录过的 scope 返回空数组', () => {
    recordApproval('', 'Bash', 'granted');
    expect(approvalsFor('')).toHaveLength(1);
    expect(approvalsFor('default')).toHaveLength(1);
    expect(approvalsFor('never-used')).toEqual([]);
  });

  it('每个 scope 有上限，超出后丢弃最旧的（长会话不会无界增长）', () => {
    for (let i = 0; i < 205; i++) recordApproval('agent-a', `Tool${i}`, 'granted', i);
    const list = approvalsFor('agent-a');
    expect(list).toHaveLength(200);
    // 保留的是最后 200 条。
    expect(list[0].toolName).toBe('Tool5');
    expect(list.at(-1)!.toolName).toBe('Tool204');
  });

  it('未提供 toolName 时不写该字段（契约里 toolName 可选）', () => {
    recordApproval('agent-a', '', 'denied');
    const [entry] = approvalsFor('agent-a');
    expect(entry).not.toHaveProperty('toolName');
    expect(entry.status).toBe('denied');
  });
});
