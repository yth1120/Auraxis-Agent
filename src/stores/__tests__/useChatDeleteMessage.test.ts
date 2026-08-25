import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../useChatStore';
import { useSessionStore } from '../useSessionStore';
import { useUndoStore } from '../useUndoStore';

function makeMessages() {
  return [
    { id: 'u1', role: 'user', content: '第一条', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: '第二条', timestamp: 2 },
    { id: 'u2', role: 'user', content: '第三条', timestamp: 3 },
  ] as any[];
}

describe('useChatStore — 删除消息与会话一致性', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], currentSessionId: null, pendingMode: 'chat' });
    useChatStore.setState({ messages: [], isStreaming: false });
    useUndoStore.setState({ undos: [] });
  });

  it('删除消息同步会话存储，切回同一会话不会复活', () => {
    const msgs = makeMessages();
    useSessionStore.getState().newSession('chat');
    const sid = useSessionStore.getState().currentSessionId!;
    useSessionStore.setState({
      sessions: [
        {
          id: sid,
          title: '会话',
          created: 1,
          updated: 1,
          model: 'm',
          messageCount: msgs.length,
          messages: msgs,
          mode: 'chat',
        },
      ],
    });
    useChatStore.setState({ messages: msgs });

    useChatStore.getState().deleteMessage('a1');

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['u1']);
    expect(
      useSessionStore
        .getState()
        .sessions.find((s) => s.id === sid)!
        .messages.map((m) => m.id),
    ).toEqual(['u1']);
  });

  it('撤销删除时同步恢复会话存储', async () => {
    const msgs = makeMessages();
    useSessionStore.getState().newSession('chat');
    const sid = useSessionStore.getState().currentSessionId!;
    useSessionStore.setState({
      sessions: [
        {
          id: sid,
          title: '会话',
          created: 1,
          updated: 1,
          model: 'm',
          messageCount: msgs.length,
          messages: msgs,
          mode: 'chat',
        },
      ],
    });
    useChatStore.setState({ messages: msgs });

    useChatStore.getState().deleteMessage('a1');
    await useUndoStore.getState().undoLast();

    expect(useChatStore.getState().messages).toHaveLength(3);
    expect(useSessionStore.getState().sessions.find((s) => s.id === sid)!.messages).toHaveLength(3);
  });
});
