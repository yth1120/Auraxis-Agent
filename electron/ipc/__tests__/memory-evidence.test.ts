import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import { captureEvidenceFromEvents, captureEvidenceFromSession, captureFeedbackEvidence } from '../memory-evidence';
import { getBeliefsByScope, listEvidence, listSignals, setBackendModeForTest } from '../memory-db';

beforeAll(() => {
  setBackendModeForTest('json');
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-evidence-'));
});

describe('captureEvidenceFromSession — 证据先于信念（Eywa M1）', () => {
  it('把用户/助手消息捕获为不可变证据', () => {
    const result = captureEvidenceFromSession({
      projectPath: 'C:/proj',
      sessionId: 's1',
      messages: [
        { role: 'user', content: '我们改用 React Router v6', ts: 100 },
        { role: 'assistant', content: '好的，我来改造路由', ts: 200 },
      ],
    });

    expect(result.added).toBe(2);
    expect(result.evidence.map((e) => e.role)).toEqual(['user', 'assistant']);
    expect(result.evidence[0]).toMatchObject({
      scope: 'C:/proj',
      session_id: 's1',
      content: '我们改用 React Router v6',
      ts: 100,
    });
    expect(result.evidence[0].content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('工具结果捕获为 tool 角色并带元数据', () => {
    const result = captureEvidenceFromSession({
      projectPath: 'C:/proj',
      sessionId: 's1',
      toolResults: [{ toolName: 'Read', summary: '读取 package.json 成功', success: true, ts: 300 }],
    });

    expect(result.added).toBe(1);
    expect(result.evidence[0].role).toBe('tool');
    expect(result.evidence[0].content).toBe('Read: 读取 package.json 成功');
    expect(JSON.parse(result.evidence[0].metadata)).toEqual({
      source: 'tool',
      toolName: 'Read',
      success: true,
    });
  });

  it('重复内容自动跳过（去重）', () => {
    const first = captureEvidenceFromSession({
      projectPath: 'C:/proj',
      sessionId: 's1',
      messages: [{ role: 'user', content: '重复消息', ts: 400 }],
    });
    const second = captureEvidenceFromSession({
      projectPath: 'C:/proj',
      sessionId: 's2',
      messages: [{ role: 'user', content: '重复消息', ts: 500 }],
    });

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('忽略空内容与未知角色，空输入不落库', () => {
    const result = captureEvidenceFromSession({
      projectPath: 'C:/proj',
      sessionId: 's1',
      messages: [
        { role: 'bot', content: '不应入库' },
        { role: 'user', content: '   ' },
      ],
      toolResults: [{ toolName: '', summary: '', success: false }],
    });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(listEvidence('C:/proj').some((e) => e.content === '不应入库')).toBe(false);
  });
});

describe('captureEvidenceFromEvents — 会话实时钩子（Eywa M1 增强）', () => {
  it('捕获用户消息与工具终态，跳过流式块与生命周期事件', () => {
    const result = captureEvidenceFromEvents('C:/proj', 's1', [
      { type: 'user', ts: 1, data: { text: '改用 React Router v6.2.1' } },
      { type: 'assistant_chunk', ts: 2, data: { text: '好的，我来' } },
      { type: 'tool', ts: 3, data: { action: 'start', toolName: 'Read', toolCallId: 'c1' } },
      { type: 'tool', ts: 4, data: { action: 'end', toolName: 'Read', toolCallId: 'c1', summary: '读取成功' } },
      { type: 'tool', ts: 5, data: { action: 'error', toolName: 'Bash', toolCallId: 'c2', error: '命令失败' } },
      { type: 'system', ts: 6, data: { event: 'turn_end' } },
    ]);

    expect(result.added).toBe(3);
    expect(result.evidence.map((e) => e.role)).toEqual(['user', 'tool', 'tool']);
    expect(result.evidence[1].content).toBe('Read: 读取成功');
    expect(result.evidence[2].content).toBe('Bash: 错误: 命令失败');
    expect(JSON.parse(result.evidence[0].metadata)).toMatchObject({ realtime: true });
  });

  it('工具终态无 summary 时用 output 兜底', () => {
    const result = captureEvidenceFromEvents('C:/proj', 's1', [
      { type: 'tool', ts: 1, data: { action: 'end', toolName: 'Glob', toolCallId: 'c1', output: ['a.ts'] } },
    ]);
    expect(result.added).toBe(1);
    expect(result.evidence[0].content).toContain('["a.ts"]');
  });

  it('无 scope / 空事件时不落库', () => {
    expect(captureEvidenceFromEvents(undefined, 's1', [{ type: 'user', ts: 1, data: { text: 'x' } }]).added).toBe(0);
    expect(captureEvidenceFromEvents('C:/proj', 's1', []).added).toBe(0);
    expect(captureEvidenceFromEvents('C:/proj', '', [{ type: 'user', ts: 1, data: { text: 'x' } }]).added).toBe(0);
  });
});

describe('captureFeedbackEvidence — INO 纠错闭环', () => {
  it('down 评分固化为 user 证据 + correction 信号 + feedback 信念', () => {
    const result = captureFeedbackEvidence({
      projectPath: 'C:/ino',
      messageId: 'm1',
      sessionId: 's1',
      rating: 'down',
      note: '不对，应该是 React Router v6.2.1',
      ts: 100,
    });
    expect(result.added).toBe(1);
    const ev = result.evidence[0];
    expect(ev.role).toBe('user');
    expect(JSON.parse(ev.metadata)).toMatchObject({ source: 'feedback', feedbackId: 's1:m1', rating: 'down' });
    expect(listSignals(ev.id).map((s) => s.signal_type)).toContain('correction');
    expect(getBeliefsByScope('C:/ino', { activeOnly: true }).map((b) => b.kind)).toContain('feedback');
  });

  it('up 评分且无备注不产生证据', () => {
    expect(
      captureFeedbackEvidence({ projectPath: 'C:/ino', messageId: 'm2', sessionId: 's1', rating: 'up' }).added,
    ).toBe(0);
  });

  it('重复反馈内容去重', () => {
    const first = captureFeedbackEvidence({
      projectPath: 'C:/ino',
      messageId: 'm3',
      sessionId: 's1',
      rating: 'down',
      note: '重复反馈',
    });
    const second = captureFeedbackEvidence({
      projectPath: 'C:/ino',
      messageId: 'm4',
      sessionId: 's1',
      rating: 'down',
      note: '重复反馈',
    });
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('缺少项目路径时忽略', () => {
    expect(captureFeedbackEvidence({ messageId: 'm5', sessionId: 's1', rating: 'down' }).added).toBe(0);
  });
});
