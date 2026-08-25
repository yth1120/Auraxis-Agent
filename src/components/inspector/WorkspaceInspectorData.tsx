import { FileText, Globe, MagnifyingGlass, Terminal } from '@/components/common/icons';
import type { AgentInfo } from '../../types/agent';
import type { I18nKey } from '../../i18n';
import type { ContextGroup } from './ContextManifest';
import { useChatStore } from '../../stores/useChatStore';
import { agentToolInvocations, latestChatToolInvocations, type ToolInvocation } from './WorkspaceInspectorUtils';

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;
type ChatMessages = ReturnType<typeof useChatStore.getState>['messages'];

export function collectDeliverables(agent: AgentInfo | undefined): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of agent?.log ?? []) {
    if (entry.type === 'tool_start' || entry.type === 'tool_end') {
      if (entry.toolName === 'Write' || entry.toolName === 'Edit' || entry.toolName === 'NotebookEdit') {
        const path = entry.input?.file_path;
        if (typeof path === 'string' && path.trim() && !seen.has(path)) {
          seen.add(path);
          output.push(path);
        }
      }
    }
  }
  return output;
}

export function collectFilePaths({
  isCode,
  agent,
  messages,
}: {
  isCode: boolean;
  agent: AgentInfo | undefined;
  messages: ChatMessages;
}): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const calls = isCode ? agentToolInvocations(agent) : latestChatToolInvocations(messages);
  for (const call of calls) {
    const path = (call.input as Record<string, unknown>).file_path;
    if (typeof path === 'string' && path.trim() && !seen.has(path)) {
      seen.add(path);
      output.push(path);
    }
  }
  return output;
}

export function collectContextGroups({
  isCode,
  agent,
  messages,
  t,
}: {
  isCode: boolean;
  agent: AgentInfo | undefined;
  messages: ChatMessages;
  t: Translate;
}): ContextGroup[] {
  const calls: ToolInvocation[] = isCode ? agentToolInvocations(agent) : latestChatToolInvocations(messages);
  const files = new Set<string>();
  const searches: string[] = [];
  const commands: string[] = [];
  const web: string[] = [];
  for (const call of calls) {
    const input = call.input as Record<string, unknown>;
    switch (call.toolName) {
      case 'Read':
      case 'Write':
      case 'Edit': {
        const path = input.file_path as string | undefined;
        if (path) files.add(path);
        break;
      }
      case 'Grep':
      case 'Glob': {
        const pattern = input.pattern as string | undefined;
        if (pattern) searches.push(pattern);
        break;
      }
      case 'Bash': {
        const command = (input.command as string | undefined)?.replace(/\s+/g, ' ').trim();
        if (command) commands.push(command.length > 60 ? command.slice(0, 60) + '…' : command);
        break;
      }
      case 'WebFetch': {
        const url = input.url as string | undefined;
        if (url) web.push(url);
        break;
      }
      case 'WebSearch': {
        const query = input.query as string | undefined;
        if (query) web.push(query);
        break;
      }
      default:
        break;
    }
  }
  return [
    { key: 'files', icon: <FileText />, label: t('ctx.group.files'), items: [...files] },
    { key: 'search', icon: <MagnifyingGlass />, label: t('ctx.group.search'), items: searches },
    { key: 'cmd', icon: <Terminal />, label: t('ctx.group.cmd'), items: commands },
    { key: 'web', icon: <Globe />, label: t('ctx.group.web'), items: web },
  ];
}
