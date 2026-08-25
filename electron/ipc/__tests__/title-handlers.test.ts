import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

import { normalizeSessionTitle, buildTitlePrompt, generateSessionTitle } from '../title-handlers';
import { registerLlmAdapter } from '../llm-adapter';

describe('session-title', () => {
  it('normalizes raw model output into a clean one-line title', () => {
    expect(normalizeSessionTitle('"修复登录功能"')).toBe('修复登录功能');
    expect(normalizeSessionTitle('**重构认证模块**')).toBe('重构认证模块');
    expect(normalizeSessionTitle('## 标题：优化构建速度')).toBe('标题：优化构建速度');
    expect(normalizeSessionTitle('<thinking>内部</thinking>总结仓库')).toBe('总结仓库');
    expect(normalizeSessionTitle('   ')).toBeNull();
    expect(normalizeSessionTitle('x'.repeat(100))?.length).toBeLessThanOrEqual(61);
  });

  it('frames user messages as JSON so quotes cannot break the prompt', () => {
    const { system, user } = buildTitlePrompt([{ content: '他说 "你好" 并写了 `code`' }, { content: '修复 bug' }]);
    expect(system).toContain('Return only the title on one line');
    expect(user).toContain('JSON array');
    expect(user).toContain('他说 \\"你好\\"');
    expect(() => JSON.parse(user.slice(user.indexOf('[')))).not.toThrow();
  });

  it('returns a clean title from the LLM adapter', async () => {
    const adapter = vi.fn(async () => ({
      contentTimeline: [],
      toolCalls: [],
      rawText: '"优化登录流程"',
      thinkingText: '',
      isFinal: false,
      completionStopReason: 'end_turn',
    }));
    registerLlmAdapter('title-test', adapter);
    const title = await generateSessionTitle([{ content: '帮我优化登录流程' }], {
      model: 'deepseek-v4-flash',
      apiKey: 'k',
      apiBase: 'http://x',
      adapter: 'title-test',
    });
    expect(title).toBe('优化登录流程');
  });

  it('returns null when the LLM call fails (rule-based fallback)', async () => {
    registerLlmAdapter(
      'title-fail',
      vi.fn(async () => {
        throw new Error('api down');
      }),
    );
    const title = await generateSessionTitle([{ content: '任务' }], {
      model: 'deepseek-v4-flash',
      apiKey: 'k',
      apiBase: 'http://x',
      adapter: 'title-fail',
    });
    expect(title).toBeNull();
  });

  it('returns null without an API key', async () => {
    const title = await generateSessionTitle([{ content: '任务' }], { apiKey: '' });
    expect(title).toBeNull();
  });
});
