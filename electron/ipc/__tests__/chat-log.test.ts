import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The electron package binary is not installed in CI/offline environments;
// chat-log only needs app.getPath for its log directory.
vi.mock('electron', () => ({
  app: { getPath: () => process.env.AURAXIS_CHAT_LOG_DIR || '' },
}));
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  appendChatEvents,
  appendChatMeta,
  deleteChatSession,
  forkChatSession,
  listChatSessions,
  projectChatSession,
  readChatLog,
} from '../../chat-log';

let root: string;
const SID = 'session-chat-1';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auraxis-chat-log-'));
  process.env.AURAXIS_CHAT_LOG_DIR = root;
});

afterEach(async () => {
  delete process.env.AURAXIS_CHAT_LOG_DIR;
  await fs.rm(root, { recursive: true, force: true });
});

describe('chat-log', () => {
  it('appends events with monotonically increasing seq across calls', async () => {
    await appendChatEvents(SID, [
      { type: 'user', ts: 1, data: { text: '你好' } },
      { type: 'assistant_chunk', ts: 2, data: { text: '嗨' } },
    ]);
    await appendChatEvents(SID, [{ type: 'assistant_chunk', ts: 3, data: { text: '！' } }]);
    const events = await readChatLog(SID);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('skips corrupt lines', async () => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, 'session-chat-1.jsonl'),
      '{"seq":1,"type":"user","ts":1,"data":{"text":"a"}}\nbad-line\n{"seq":2,"type":"user","ts":2,"data":{"text":"b"}}\n',
      'utf8',
    );
    const events = await readChatLog(SID);
    expect(events).toHaveLength(2);
  });

  it('returns [] for a missing session', async () => {
    expect(await readChatLog('missing')).toEqual([]);
  });

  it('projects messages, chunks and tool calls from the event stream', async () => {
    await appendChatEvents(SID, [
      { type: 'user', ts: 1000, data: { text: '读一下 a.ts' } },
      { type: 'assistant_chunk', ts: 1001, data: { text: '好的，' } },
      {
        type: 'tool',
        ts: 1002,
        data: { action: 'start', toolName: 'Read', toolCallId: 'tc-1', requestId: 'r-1', input: { path: 'a.ts' } },
      },
      {
        type: 'tool',
        ts: 1003,
        data: { action: 'end', toolName: 'Read', toolCallId: 'tc-1', requestId: 'r-1', output: 'export const a = 1;' },
      },
      { type: 'assistant_chunk', ts: 1004, data: { text: '文件内容如上' } },
    ]);
    await appendChatMeta(SID, {
      title: '测试会话',
      model: 'deepseek-v4-pro',
      projectRoot: 'C:/proj',
      mode: 'chat',
    });

    const proj = await projectChatSession(SID);
    expect(proj).not.toBeNull();
    expect(proj!.title).toBe('测试会话');
    expect(proj!.model).toBe('deepseek-v4-pro');
    expect(proj!.projectRoot).toBe('C:/proj');
    expect(proj!.messageCount).toBe(2);
    expect(proj!.messages).toHaveLength(2);
    expect(proj!.messages[0]).toMatchObject({ id: 'user-1', role: 'user', content: '读一下 a.ts' });
    expect(proj!.messages[1].content).toBe('好的，文件内容如上');
    expect(proj!.messages[1].toolCalls).toHaveLength(1);
    expect(proj!.messages[1].toolCalls![0]).toMatchObject({
      id: 'tc-1',
      toolName: 'Read',
      status: 'done',
      input: { path: 'a.ts' },
      output: 'export const a = 1;',
    });
  });

  it('lists sessions with derived metadata, newest first', async () => {
    await appendChatEvents(SID, [
      { type: 'user', ts: 1000, data: { text: '第一条消息' } },
      { type: 'assistant_chunk', ts: 1001, data: { text: '回复' } },
    ]);
    await appendChatEvents('session-chat-2', [{ type: 'user', ts: 2000, data: { text: '第二条会话' } }]);
    await appendChatMeta('session-chat-2', { title: '手动标题', messageCount: 7 });

    const list = await listChatSessions();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('session-chat-2');
    expect(list[0].title).toBe('手动标题');
    expect(list[0].messageCount).toBe(7);
    expect(list[1].id).toBe(SID);
    expect(list[1].title).toBe('第一条消息');
    expect(list[1].messageCount).toBe(2);
    expect(list[1].eventCount).toBe(2);
  });

  it('returns null when projecting a missing session', async () => {
    expect(await projectChatSession('missing')).toBeNull();
  });

  it('forks a session up to a message boundary', async () => {
    await appendChatEvents(SID, [
      { type: 'user', ts: 1000, data: { text: '第一轮' } },
      { type: 'assistant_chunk', ts: 1001, data: { text: '回答一' } },
      { type: 'user', ts: 1002, data: { text: '第二轮' } },
      { type: 'assistant_chunk', ts: 1003, data: { text: '回答二' } },
    ]);
    await appendChatMeta(SID, { title: '原始会话' });

    const newId = await forkChatSession(SID, 'assistant-2');
    expect(newId).not.toBeNull();
    const forked = await projectChatSession(newId!);
    expect(forked).not.toBeNull();
    expect(forked!.messages).toHaveLength(2);
    expect(forked!.messages.map((m) => m.id)).toEqual(['user-1', 'assistant-2']);
    expect(forked!.branchedFrom).toMatchObject({ sessionId: SID, messageId: 'assistant-2', title: '原始会话' });
    // Source session is untouched.
    expect((await projectChatSession(SID))!.messages).toHaveLength(4);
  });

  it('forks a whole session when no message boundary is given', async () => {
    await appendChatEvents(SID, [
      { type: 'user', ts: 1000, data: { text: 'a' } },
      { type: 'assistant_chunk', ts: 1001, data: { text: 'b' } },
    ]);
    const newId = await forkChatSession(SID);
    expect((await projectChatSession(newId!))!.messages).toHaveLength(2);
  });

  it('returns null when forking a missing session', async () => {
    expect(await forkChatSession('missing')).toBeNull();
  });

  it('deletes a session log', async () => {
    await appendChatEvents(SID, [{ type: 'user', ts: 1, data: { text: 'a' } }]);
    expect(await deleteChatSession(SID)).toBe(true);
    expect(await projectChatSession(SID)).toBeNull();
    expect(await deleteChatSession(SID)).toBe(false);
  });
});
