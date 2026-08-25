import { errorText } from '../../electron/errors';
import { message } from 'antd';
import { useChatStore } from '../stores/useChatStore';
import { useSessionStore } from '../stores/useSessionStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { getContentText, type Message } from '../types/chat';
import { t } from '../i18n';

/** Compact the current chat context via the backend LLM summarizer. */
export async function compactChatContext(): Promise<void> {
  const chat = useChatStore.getState();
  const projectRoot = chat.currentProjectPath || useSettingsStore.getState().projectPath || '';
  if (!projectRoot) {
    message.warning(t('conv.selectProject'));
    return;
  }
  const payload = chat.messages.map((m) => ({ role: m.role, content: getContentText(m.content) }));
  if (payload.length === 0) {
    message.info(t('conv.noCompressible'));
    return;
  }
  try {
    const r = await window.electronAPI?.context?.compact(projectRoot, payload);
    if (!r?.ok) throw new Error(r?.error || t('conv.compressFailed'));
    const d = r.data!;
    const mapped = d.messages.map((m: { role: string; content: string }, i: number) => ({
      id: `m-${Date.now()}-${i}`,
      role: (m.role === 'assistant' || m.role === 'user' ? m.role : 'system') as 'user' | 'assistant' | 'system',
      content: m.content,
      timestamp: Date.now() - (d.messages.length - i) * 1000,
    }));
    const compaction = {
      tokensBefore: d.tokensBefore,
      tokensAfter: d.tokensAfter,
      messagesRemoved: d.messagesRemoved,
      tokensSaved: d.tokensSaved,
    };
    useChatStore.setState({
      messages: [
        ...mapped,
        {
          id: `compact-${Date.now()}`,
          role: 'system' as const,
          content: t('compact.title'),
          timestamp: Date.now(),
          tags: ['system'] as Message['tags'],
          compaction,
        },
      ],
      lastCompression: { ...compaction, timestamp: Date.now() },
    });
    message.success(
      t('conv.compressSuccess', { n: d.messagesRemoved ?? 0, tokens: (d.tokensSaved ?? 0).toLocaleString() }),
    );
  } catch (e: unknown) {
    message.error(errorText(e) || t('conv.compressFailed'));
  }
}

/** Fork the current conversation into a new branch. */
export function forkCurrentChatSession(): void {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId) {
    message.info(t('conv.noSessionFork'));
    return;
  }
  const newId = useSessionStore.getState().forkSession(sessionId);
  if (newId) message.success(t('conv.forkCreated'));
}
