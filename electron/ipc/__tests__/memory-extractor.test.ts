import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../agent-loop', () => ({
  llmClientInvoke: vi.fn(async () => null),
}));

import { extractMemories } from '../memory-extractor';
import { llmClientInvoke } from '../agent-loop';

const baseCtx = {
  projectPath: 'C:/proj',
  sessionId: 's1',
  messages: [
    { role: 'user', content: '帮我接入认证' },
    { role: 'assistant', content: '已使用 JWT' },
    { role: 'tool', content: '执行成功' },
  ],
};

const config = { model: 'deepseek-v4-pro', apiKey: 'sk', apiBase: 'https://api.example' };

function rawOf(text: string) {
  return vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: text } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(llmClientInvoke).mockResolvedValue({ rawText: '[]' } as any);
});

describe('extractMemories — 提示词构建', () => {
  it('把会话、已有记忆与工具结果组织进提示词', async () => {
    await extractMemories(
      {
        ...baseCtx,
        existingMemories: [
          { id: 'e1', title: '旧记忆', content: '旧内容', type: 'decision', tags: '["x"]', importance: 2 },
        ],
        toolResults: [{ toolName: 'Bash', summary: 'npm test', success: true }],
      },
      config,
    );
    const prompt = vi.mocked(llmClientInvoke).mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('C:/proj');
    expect(prompt).toContain('[用户] 帮我接入认证');
    expect(prompt).toContain('[AI] 已使用 JWT');
    expect(prompt).toContain('[系统] 执行成功');
    expect(prompt).toContain('[decision][重要度2] 旧记忆: 旧内容');
    expect(prompt).toContain('[成功] Bash: npm test');
  });

  it('无已有记忆/工具结果时显示占位文案', async () => {
    await extractMemories(baseCtx, config);
    const prompt = vi.mocked(llmClientInvoke).mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('（暂无已有记忆）');
    expect(prompt).toContain('（无工具执行记录）');
  });
});

describe('extractMemories — 解析与归一化', () => {
  it('解析 JSON 数组并夹紧 importance、截断长度', async () => {
    rawOf(
      JSON.stringify([
        {
          type: 'decision',
          title: 'T'.repeat(150),
          content: 'C'.repeat(600),
          tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
          importance: 9,
        },
        { type: 'preference', title: 'x', content: 'y', tags: 'not-array', importance: 0 },
        { type: 'bogus', title: 'z', content: 'w' },
        null,
      ]),
    );

    const out = await extractMemories(baseCtx, config);
    expect(out).toHaveLength(3);
    expect(out[0].title).toHaveLength(100);
    expect(out[0].content).toHaveLength(500);
    expect(out[0].importance).toBe(5);
    expect(out[0].tags).toHaveLength(10);
    expect(out[1].tags).toEqual([]); // 非数组 tags 置空
    expect(out[1].importance).toBe(3); // 0 → 默认 3
    expect(out[2].type).toBe('bogus'); // 解析层不校验 type 枚举
  });

  it('剥掉 markdown 代码围栏', async () => {
    rawOf('```json\n[{"type":"progress","title":"T","content":"C"}]\n```');
    const out = await extractMemories(baseCtx, config);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('T');
  });

  it('非数组 / 非法 JSON 返回空', async () => {
    rawOf('{"a":1}');
    expect(await extractMemories(baseCtx, config)).toEqual([]);
    rawOf('not json');
    expect(await extractMemories(baseCtx, config)).toEqual([]);
  });
});

describe('extractMemories — 去重与异常', () => {
  it('与已有记忆标题相同或高度相似时跳过', async () => {
    rawOf(
      JSON.stringify([
        {
          type: 'decision',
          title: '使用 React Router',
          content: '项目统一使用 React Router v6',
          tags: [],
          importance: 3,
        },
        {
          type: 'decision',
          title: 'React Router 选择',
          content: '项目统一使用 React Router v6 版本',
          tags: [],
          importance: 3,
        },
        { type: 'progress', title: '新进展', content: '今天完成了登录页', tags: [], importance: 3 },
      ]),
    );
    const existing = [
      {
        id: 'e1',
        title: '使用 React Router',
        content: '项目统一使用 React Router v6',
        type: 'decision' as const,
        tags: '[]',
        importance: 3,
      },
    ];
    const out = await extractMemories({ ...baseCtx, existingMemories: existing }, config);
    expect(out.map((m) => m.title)).toEqual(['React Router 选择', '新进展']);
  });

  it('LLM 返回空或抛错时静默返回空数组', async () => {
    vi.mocked(llmClientInvoke).mockResolvedValueOnce(null);
    expect(await extractMemories(baseCtx, config)).toEqual([]);
    vi.mocked(llmClientInvoke).mockRejectedValueOnce(new Error('api down'));
    expect(await extractMemories(baseCtx, config)).toEqual([]);
  });
});
