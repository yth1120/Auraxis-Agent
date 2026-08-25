// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../useChatStore';
import { useSessionStore } from '../useSessionStore';
import { useAppStore } from '../useAppStore';

describe('useChatStore — 流式进行中切换/清空会话', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], currentSessionId: null, pendingMode: 'chat' });
    useChatStore.setState({ messages: [], isStreaming: false });
    useAppStore.setState({ sidebarMode: 'chat' });
  });

  it('流式进行中切到其它会话会先中止在途请求', () => {
    useSessionStore.getState().newSession('chat');
    const sid = useSessionStore.getState().currentSessionId!;
    const msgs = [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '', timestamp: 2, isStreaming: true },
    ] as any[];
    useSessionStore.setState({
      sessions: [
        {
          id: sid,
          title: '会话',
          created: 1,
          updated: 1,
          model: 'm',
          messageCount: 2,
          messages: msgs,
          mode: 'chat',
        },
      ],
    });
    useChatStore.setState({ messages: msgs, isStreaming: true });

    // Target session for the switch — added to the list without changing
    // currentSessionId (still the source), like clicking a history row.
    const targetId = 'session-target-1';
    useSessionStore.setState((s) => ({
      sessions: [
        ...s.sessions,
        {
          id: targetId,
          title: '目标',
          created: 1,
          updated: 1,
          model: 'm',
          messageCount: 0,
          messages: [],
          mode: 'chat',
        },
      ],
    }));

    useChatStore.getState().switchSession(targetId);

    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('流式进行中新建对话会先中止在途请求', () => {
    useSessionStore.getState().newSession('chat');
    useChatStore.setState({
      messages: [
        { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '', timestamp: 2, isStreaming: true },
      ] as any[],
      isStreaming: true,
    });

    useChatStore.getState().clearMessages();

    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('流刚结束、自动保存前切回同一会话不会用旧消息覆盖新回复', () => {
    useSessionStore.getState().newSession('chat');
    const sid = useSessionStore.getState().currentSessionId!;
    const oldMsgs = [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '旧回复', timestamp: 2 },
    ] as any[];
    useSessionStore.setState({
      sessions: [
        {
          id: sid,
          title: '会话',
          created: 1,
          updated: 1,
          model: 'm',
          messageCount: 2,
          messages: oldMsgs,
          mode: 'chat',
        },
      ],
    });
    useChatStore.setState({ messages: oldMsgs, isStreaming: false });

    // Stream just completed: chat store has a fresh reply the session
    // store hasn't persisted yet (500ms auto-save pending).
    const freshMsgs = [...oldMsgs, { id: 'a2', role: 'assistant', content: '新回复', timestamp: 3 }];
    useChatStore.setState({ messages: freshMsgs as any[] });

    useChatStore.getState().switchSession(sid);

    expect(useChatStore.getState().messages.map((m) => m.id)).toContain('a2');
    expect(useChatStore.getState().messages).toHaveLength(3);
  });

  it('清空对话后点回同一会话仍能加载历史', () => {
    useSessionStore.getState().newSession('chat');
    const sid = useSessionStore.getState().currentSessionId!;
    const msgs = [
      { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '旧回复', timestamp: 2 },
    ] as any[];
    useSessionStore.setState({
      sessions: [
        {
          id: sid,
          title: '会话',
          created: 1,
          updated: 1,
          model: 'm',
          messageCount: 2,
          messages: msgs,
          mode: 'chat',
        },
      ],
    });
    useChatStore.setState({ messages: [], isStreaming: false });

    useChatStore.getState().switchSession(sid);

    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  it('完成后 500ms 内新建对话，旧会话仍被保存且不污染新会话', async () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [], currentSessionId: null, pendingMode: 'chat' });
      useChatStore.setState({ messages: [], isStreaming: false });
      useAppStore.setState({ sidebarMode: 'chat' });

      // 会话 A 完成
      useSessionStore.getState().newSession('chat');
      const sidA = useSessionStore.getState().currentSessionId!;
      const msgsA = [
        { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '回复', timestamp: 2 },
      ] as any[];
      useChatStore.setState({ messages: msgsA, isStreaming: true });
      useChatStore.setState({ messages: msgsA, isStreaming: false }); // 触发自动保存

      // 立刻新建会话 B（清空消息）
      useSessionStore.getState().newSession('chat');
      const sidB = useSessionStore.getState().currentSessionId!;
      useChatStore.getState().clearMessages();

      await vi.advanceTimersByTimeAsync(600);

      const sessions = useSessionStore.getState().sessions;
      expect(sessions.find((s) => s.id === sidA)?.messages).toHaveLength(2);
      // B 尚未保存，也不能被旧会话 A 污染
      expect(sessions.some((s) => s.id === sidB)).toBe(false);
      // 当前会话仍是 B，不能被旧会话拽回去
      expect(useSessionStore.getState().currentSessionId).toBe(sidB);
    } finally {
      vi.useRealTimers();
    }
  });

  it('完成后 500ms 内删除会话，自动保存不会把它复活', async () => {
    vi.useFakeTimers();
    try {
      useSessionStore.setState({ sessions: [], currentSessionId: null, pendingMode: 'chat' });
      useChatStore.setState({ messages: [], isStreaming: false });
      useAppStore.setState({ sidebarMode: 'chat' });

      useSessionStore.getState().newSession('chat');
      const sid = useSessionStore.getState().currentSessionId!;
      const msgs = [
        { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: '回复', timestamp: 2 },
      ] as any[];
      useChatStore.setState({ messages: msgs, isStreaming: true });
      useChatStore.setState({ messages: msgs, isStreaming: false }); // 触发自动保存

      // 500ms 内删除该会话
      useSessionStore.getState().deleteSession(sid);
      useChatStore.getState().clearMessages();

      await vi.advanceTimersByTimeAsync(600);

      expect(useSessionStore.getState().sessions.some((s) => s.id === sid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
