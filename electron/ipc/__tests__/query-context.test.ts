import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/auraxis-test' },
}));

vi.mock('../../chat-log', () => ({
  readChatLog: vi.fn(async () => []),
  appendChatEvents: vi.fn(async () => {}),
}));

import { readChatLog, appendChatEvents } from '../../chat-log';
import {
  MEMORY_PREAMBLE_PREFIX,
  buildAgentsMdMessage,
  buildModeHint,
  clearLlmContext,
  loadLlmContext,
  pickLatestLlmContext,
  saveLlmContext,
  tryReplayStoredContext,
} from '../query-context';
import { LLM_CONTEXT_CLEAR_EVENT, LLM_CONTEXT_SNAPSHOT_EVENT } from '../../contracts/session-types';

function systemEvent(seq: number, event: string, extra: Record<string, unknown> = {}) {
  return { seq, type: 'system', data: { event, ...extra } };
}

function storedBase() {
  return [
    { role: 'system', content: 'STATIC' },
    { role: 'user', content: 'preamble' },
    { role: 'user', content: 'work guide' },
    { role: 'user', content: '## 项目记忆（带证据溯源，来自之前的会话）\n旧记忆' },
    { role: 'user', content: 'AGENTS.md 内容' },
    { role: 'user', content: '旧问题' },
    { role: 'user', content: buildModeHint('ask') },
    { role: 'assistant', content: '第一轮回答', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'assistant', content: '最终回答' },
  ];
}

describe('pickLatestLlmContext', () => {
  it('空事件列表返回 null', () => {
    expect(pickLatestLlmContext([])).toBeNull();
  });

  it('取最新快照，忽略非 system 事件', () => {
    const events = [
      { seq: 1, type: 'user', data: { text: 'hi' } },
      systemEvent(2, LLM_CONTEXT_SNAPSHOT_EVENT, { messages: [{ role: 'user', content: 'a' }] }),
      { seq: 3, type: 'tool', data: { toolName: 'Read' } },
      systemEvent(4, LLM_CONTEXT_SNAPSHOT_EVENT, { messages: [{ role: 'user', content: 'b' }] }),
    ];
    expect(pickLatestLlmContext(events)?.messages).toEqual([{ role: 'user', content: 'b' }]);
  });

  it('清除事件晚于快照时返回 null', () => {
    const events = [
      systemEvent(2, LLM_CONTEXT_SNAPSHOT_EVENT, { messages: [{ role: 'user', content: 'a' }] }),
      systemEvent(3, LLM_CONTEXT_CLEAR_EVENT),
    ];
    expect(pickLatestLlmContext(events)).toBeNull();
  });

  it('快照晚于清除事件时重新信任', () => {
    const events = [
      systemEvent(2, LLM_CONTEXT_SNAPSHOT_EVENT, { messages: [{ role: 'user', content: 'a' }] }),
      systemEvent(3, LLM_CONTEXT_CLEAR_EVENT),
      systemEvent(4, LLM_CONTEXT_SNAPSHOT_EVENT, { messages: [{ role: 'user', content: 'c' }] }),
    ];
    expect(pickLatestLlmContext(events)?.messages).toEqual([{ role: 'user', content: 'c' }]);
  });
});

describe('tryReplayStoredContext', () => {
  it('重放时保持原前缀并只在尾部追加记忆与新用户消息', () => {
    const stored = storedBase();
    const chatMessages = [{ role: 'user', content: '新问题' }];
    const modeHint = buildModeHint('ask');
    const result = tryReplayStoredContext(stored, chatMessages, '', modeHint, `${MEMORY_PREAMBLE_PREFIX}\n新记忆`);
    expect(result.ok).toBe(true);
    expect(result.messages.slice(0, stored.length)).toEqual(stored);
    expect(result.messages.slice(stored.length)).toEqual([
      { role: 'user', content: `${MEMORY_PREAMBLE_PREFIX}\n新记忆` },
      { role: 'user', content: '新问题' },
    ]);
  });

  it('新记忆与快照最后一条记忆字节一致时跳过追加（去重）', () => {
    const stored = storedBase();
    const memory = `${MEMORY_PREAMBLE_PREFIX}\n相同记忆`;
    stored[3] = { role: 'user', content: memory };
    const result = tryReplayStoredContext(
      stored,
      [{ role: 'user', content: '新问题' }],
      '',
      buildModeHint('ask'),
      memory,
    );
    expect(result.ok).toBe(true);
    expect(result.messages.slice(stored.length)).toEqual([{ role: 'user', content: '新问题' }]);
  });

  it('无新记忆时只追加用户消息', () => {
    const result = tryReplayStoredContext(
      storedBase(),
      [{ role: 'user', content: '新问题' }],
      '',
      buildModeHint('ask'),
    );
    expect(result.ok).toBe(true);
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: '新问题' });
  });

  it('AGENTS.md 变化时原位替换内容', () => {
    const stored = storedBase();
    stored[4] = { role: 'user', content: buildAgentsMdMessage('OLD RULES') };
    const result = tryReplayStoredContext(
      stored,
      [{ role: 'user', content: '新问题' }],
      'NEW RULES',
      buildModeHint('ask'),
    );
    expect(result.ok).toBe(true);
    expect(result.messages[4].content).toBe(buildAgentsMdMessage('NEW RULES'));
  });

  it('AGENTS.md 被删除后拒绝重放旧规则', () => {
    const stored = storedBase();
    stored[4] = { role: 'user', content: buildAgentsMdMessage('OLD RULES') };
    const result = tryReplayStoredContext(stored, [{ role: 'user', content: '新问题' }], '', buildModeHint('ask'));
    expect(result.ok).toBe(false);
  });

  it('模式变化时原位替换模式提示', () => {
    const stored = storedBase();
    const result = tryReplayStoredContext(stored, [{ role: 'user', content: '新问题' }], '', buildModeHint('auto'));
    expect(result.ok).toBe(true);
    expect(result.messages[6].content).toBe(buildModeHint('auto'));
  });

  it('快照末尾不是 assistant 时拒绝重放', () => {
    const stored = storedBase();
    stored[stored.length - 1] = { role: 'user', content: '半截' };
    const result = tryReplayStoredContext(stored, [{ role: 'user', content: '新问题' }], '', buildModeHint('ask'));
    expect(result.ok).toBe(false);
  });

  it('缺少模式提示或新用户消息时拒绝重放', () => {
    const noMode = storedBase().filter((m) => !String(m.content).startsWith('当前为'));
    expect(tryReplayStoredContext(noMode, [{ role: 'user', content: '新问题' }], '', buildModeHint('ask')).ok).toBe(
      false,
    );
    expect(tryReplayStoredContext(storedBase(), [], '', buildModeHint('ask')).ok).toBe(false);
  });
});

describe('load/save/clearLlmContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('save 把规范消息写入 chat-log system 事件并剥离内部标记', async () => {
    await saveLlmContext('s1', [{ role: 'assistant', content: 'x', _ddInjected: true }]);
    expect(appendChatEvents).toHaveBeenCalledWith('s1', [
      expect.objectContaining({
        type: 'system',
        data: expect.objectContaining({
          event: LLM_CONTEXT_SNAPSHOT_EVENT,
          messages: [{ role: 'assistant', content: 'x' }],
        }),
      }),
    ]);
  });

  it('load 从最新快照返回消息，空 sessionId 直接返回 null', async () => {
    vi.mocked(readChatLog).mockResolvedValue([
      systemEvent(2, LLM_CONTEXT_SNAPSHOT_EVENT, { messages: [{ role: 'user', content: 'a' }] }),
    ] as any);
    expect(await loadLlmContext('s1')).toEqual([{ role: 'user', content: 'a' }]);
    expect(await loadLlmContext('')).toBeNull();
  });

  it('clear 追加清除墓碑', async () => {
    await clearLlmContext('s1');
    expect(appendChatEvents).toHaveBeenCalledWith('s1', [
      expect.objectContaining({ type: 'system', data: expect.objectContaining({ event: LLM_CONTEXT_CLEAR_EVENT }) }),
    ]);
    await clearLlmContext('');
    expect(appendChatEvents).toHaveBeenCalledTimes(1);
  });
});
