import type { CodeBlock, Message } from '../types/chat';
import { getContentText } from '../types/chat';
import type { ToolCall } from '../types/tools';

export type MsgState = { messages: Message[] };

export function extractCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  let idx = 0;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      id: `cb-${Date.now()}-${idx++}`,
      language: match[1] || 'text',
      code: match[2].replace(/\n$/, ''),
      applied: false,
    });
  }
  return blocks;
}

export function setAssistantContent(assistantId: string, content: string) {
  return (s: MsgState) => ({
    messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content } : m)),
  });
}

export function setAssistantDone(assistantId: string) {
  return (s: MsgState) => ({
    messages: s.messages.map((m) =>
      m.id === assistantId ? { ...m, isStreaming: false, codeBlocks: extractCodeBlocks(getContentText(m.content)) } : m,
    ),
  });
}

export function setAssistantError(assistantId: string, fallback: string) {
  return (s: MsgState) => ({
    messages: s.messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            isStreaming: false,
            content: getContentText(m.content) || fallback,
            codeBlocks: extractCodeBlocks(getContentText(m.content) || fallback),
          }
        : m,
    ),
  });
}

export function appendToolCall(assistantId: string, tc: ToolCall) {
  return (s: MsgState & { toolCallMap: Record<string, ToolCall> }) => ({
    messages: s.messages.map((m) => (m.id === assistantId ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m)),
    toolCallMap: { ...s.toolCallMap, [tc.id]: tc },
  });
}

export function updateToolCall(assistantId: string, toolCallId: string, updates: Partial<ToolCall>) {
  return (s: MsgState & { toolCallMap: Record<string, ToolCall> }) => {
    let updatedTc: ToolCall | undefined;
    const messages = s.messages.map((m) => {
      if (m.id !== assistantId) return m;
      return {
        ...m,
        toolCalls: m.toolCalls?.map((tc) => {
          if (tc.id === toolCallId) {
            updatedTc = { ...tc, ...updates } as ToolCall;
            return updatedTc;
          }
          return tc;
        }),
      };
    });
    return {
      messages,
      ...(updatedTc ? { toolCallMap: { ...s.toolCallMap, [toolCallId]: updatedTc } } : {}),
    };
  };
}

export function appendThinkingChunk(
  blocks: { content: string }[] | undefined,
  chunk: string,
  isNewBlock: boolean,
): { content: string }[] {
  if (!blocks || blocks.length === 0 || isNewBlock) {
    return [...(blocks || []), { content: chunk }];
  }
  const last = blocks[blocks.length - 1];
  return [...blocks.slice(0, -1), { ...last, content: last.content + chunk }];
}
