import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}));

import { detectSignals, detectAndStoreSignals, llmSignalsEnabled, hasSignal } from '../signal-rules';
import { listSignals, setBackendModeForTest } from '../memory-db';

beforeAll(() => {
  setBackendModeForTest('json');
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'auraxis-signal-'));
});

beforeEach(() => {
  delete process.env.AURAXIS_MEMORY_LLM_SIGNALS;
});

describe('detectSignals — 规则检测', () => {
  it('识别日期 / 版本号 / URL', () => {
    const signals = detectSignals(
      '项目在 2026-08-16 升级到 v6.2.1，文档见 https://reactrouter.com',
      'ev1',
      'assistant',
    );
    expect(signals.map((s) => s.signal_type)).toEqual(expect.arrayContaining(['date', 'version', 'url']));
    expect(signals.find((s) => s.signal_type === 'version')?.value).toBe('6.2.1');
    expect(signals.every((s) => s.detector === 'rule')).toBe(true);
  });

  it('识别中文日期与实体', () => {
    const signals = detectSignals('2026年8月16日确定项目名：「Auraxis」', 'ev2', 'user');
    expect(signals.map((s) => s.signal_type)).toEqual(expect.arrayContaining(['date', 'entity', 'decision']));
    expect(signals.find((s) => s.signal_type === 'entity')?.value).toBe('Auraxis');
  });

  it('识别纠错 / 批准 / 拒绝句式', () => {
    expect(hasType(detectSignals('不对，应该是 React Router v6', 'ev3', 'user'), 'correction')).toBe(true);
    expect(hasType(detectSignals('我批准这个方案', 'ev4', 'user'), 'approval')).toBe(true);
    expect(hasType(detectSignals('我拒绝删除该文件', 'ev5', 'user'), 'rejection')).toBe(true);
  });

  it('确定性：同输入两次结果完全一致', () => {
    const text = '我们改用 React Router v6（https://reactrouter.com）';
    expect(detectSignals(text, 'ev6', 'user')).toEqual(detectSignals(text, 'ev6', 'user'));
  });

  it('同 evidence 同类型同值去重', () => {
    const signals = detectSignals('版本 v6.2.1 与 6.2.1 相同', 'ev7', 'user');
    expect(signals.filter((s) => s.signal_type === 'version')).toHaveLength(1);
  });

  it('空内容与未知输入不产生信号', () => {
    expect(detectSignals('', 'ev8', 'system')).toEqual([]);
  });
});

describe('detectAndStoreSignals / env 开关', () => {
  it('规则信号落库且重复执行幂等', async () => {
    const first = await detectAndStoreSignals('ev-store', '项目使用 React Router v6.2.1', 'user');
    const second = await detectAndStoreSignals('ev-store', '项目使用 React Router v6.2.1', 'user');
    expect(first.length).toBeGreaterThan(0);
    expect(listSignals('ev-store')).toHaveLength(first.length);
    expect(second).toHaveLength(first.length);
    expect(hasSignal('ev-store', 'version')).toBe(true);
  });

  it('AURAXIS_MEMORY_LLM_SIGNALS=1 时 llmSignalsEnabled 为真', () => {
    expect(llmSignalsEnabled()).toBe(false);
    process.env.AURAXIS_MEMORY_LLM_SIGNALS = '1';
    expect(llmSignalsEnabled()).toBe(true);
  });
});

function hasType(signals: { signal_type: string }[], type: string): boolean {
  return signals.some((s) => s.signal_type === type);
}
