import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: vi.fn() },
}));

import { countTokens, getTokenizerStats, registerTokenizerIpc } from '../tokenizer';
import { ipcMain } from 'electron';

describe('DeepSeek 官方离线 tokenizer', () => {
  beforeEach(() => {
    process.env.AURAXIS_TOKENIZER_PATH = path.resolve(process.cwd(), 'electron', 'tokenizer', 'tokenizer.json');
  });

  it('加载官方 vocab 与 merges', () => {
    const stats = getTokenizerStats();
    expect(stats.vocabSize).toBe(128000);
    expect(stats.mergeCount).toBe(127741);
    expect(stats.splitPatterns).toBeGreaterThanOrEqual(3);
    expect(stats.addedTokens).toBeGreaterThanOrEqual(13);
  });

  it('空文本为 0，中英文都能计数', () => {
    expect(countTokens('')).toBe(0);
    const en = countTokens('Hello, how are you today?');
    const zh = countTokens('你好，今天天气怎么样？');
    expect(en).toBeGreaterThan(0);
    expect(zh).toBeGreaterThan(0);
  });

  it('较长文本 token 数不下降（单调性抽查）', () => {
    const short = countTokens('const a = 1;');
    const long = countTokens('const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;');
    expect(long).toBeGreaterThanOrEqual(short);
  });

  it('added_tokens（工具调用/思考/FIM 标记）按单 token 计数', () => {
    const base = countTokens('answer');
    const withThink = countTokens('<think>reason</think>answer');
    const withTool = countTokens(
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>call<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    );
    expect(withThink - base).toBeGreaterThanOrEqual(2);
    expect(withTool).toBeGreaterThanOrEqual(4);
  });

  it('注册 tokenizer:count IPC', () => {
    registerTokenizerIpc();
    expect(ipcMain.handle).toHaveBeenCalledWith('tokenizer:count', expect.any(Function));
  });
});
