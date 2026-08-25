import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'auraxis' },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  Notification: class {},
  safeStorage: {
    encryptString: vi.fn((s: string) => s),
    decryptString: vi.fn((s: string) => s),
    isEncryptionAvailable: () => true,
  },
}));

import { compactHistory } from '../context-manager';

function step(prefix: string, name: string, input: Record<string, unknown>, result: string): any[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `${prefix}-${name}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
    },
    { role: 'tool', tool_call_id: `${prefix}-${name}`, content: result },
  ];
}

function orphanIds(messages: any[]): Set<string> {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) open.add(tc.id);
    }
    if (m.role === 'tool' && m.tool_call_id) open.delete(m.tool_call_id);
  }
  return open;
}

describe('compactHistory — step 模式（AGORA 联动）', () => {
  it('整步压缩：保留最近步骤、注入摘要、无孤立工具调用', async () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'preamble' },
      ...step('s1', 'Grep', { pattern: 'x' }, 'nothing'),
      ...step('s2', 'Read', { file_path: 'b.ts' }, 'content'),
      ...step('s3', 'Bash', { command: 'npm test' }, 'pass'),
      ...step('s4', 'Edit', { file_path: 'b.ts' }, 'ok'),
    ];
    const result = await compactHistory({
      messages,
      plan: null,
      compressMode: 'step',
      stepKeepRecent: 2,
    });
    expect(result.wasTruncated).toBe(true);
    expect(result.summaryInjected).toBe(true);
    expect(result.messages[0]).toEqual({ role: 'system', content: 'sys' });
    const summary = result.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[System Notification]'),
    );
    expect(summary).toBeTruthy();
    expect(result.messages.some((m) => JSON.stringify(m).includes('s3-Bash'))).toBe(true);
    expect(result.messages.some((m) => JSON.stringify(m).includes('s4-Edit'))).toBe(true);
    expect(result.messages.some((m) => JSON.stringify(m).includes('s1-Grep'))).toBe(false);
    expect(orphanIds(result.messages).size).toBe(0);
    expect(result.roundsRemoved).toBe(2);
    expect(result.messagesRemoved).toBe(messages.length - result.messages.length + 1);
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
  });

  it('清除旧摘要，避免跨轮压缩叠加', async () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '[System Notification] 上一次压缩的摘要' },
      ...step('s1', 'Grep', { pattern: 'x' }, 'a'),
      ...step('s2', 'Read', { file_path: 'b.ts' }, 'b'),
      ...step('s3', 'Bash', { command: 'npm test' }, 'c'),
    ];
    const result = await compactHistory({
      messages,
      plan: null,
      compressMode: 'step',
      stepKeepRecent: 1,
    });
    const notifications = result.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[System Notification]'),
    );
    expect(notifications).toHaveLength(1);
  });

  it('步骤数不超地板时不压缩', async () => {
    const messages = [
      { role: 'system', content: 'sys' },
      ...step('s1', 'Grep', { pattern: 'x' }, 'a'),
      ...step('s2', 'Read', { file_path: 'b.ts' }, 'b'),
    ];
    const result = await compactHistory({
      messages,
      plan: null,
      compressMode: 'step',
      stepKeepRecent: 6,
    });
    expect(result.wasTruncated).toBe(false);
    expect(result.messagesRemoved).toBe(0);
  });

  it('计划相关的关键步骤被救回', async () => {
    const plan = {
      tasks: [{ id: '1', description: 'fix src/app.ts module', status: 'pending', dependencies: [], toolMatches: [] }],
    } as any;
    const messages = [
      { role: 'system', content: 'sys' },
      ...step('s1', 'Grep', { pattern: 'x' }, 'nothing'),
      ...step('s2', 'Read', { file_path: 'src/app.ts' }, '{"file_path":"src/app.ts","content":"x","total_lines":20}'),
      ...step('s3', 'Bash', { command: 'npm test' }, 'pass'),
    ];
    const result = await compactHistory({
      messages,
      plan,
      compressMode: 'step',
      stepKeepRecent: 1,
    });
    expect(result.messages.some((m) => JSON.stringify(m).includes('s2-Read'))).toBe(true);
    expect(result.messages.some((m) => JSON.stringify(m).includes('s1-Grep'))).toBe(false);
    expect(orphanIds(result.messages).size).toBe(0);
  });
});
