import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  ArrowsClockwise,
  ChatCircle,
  Code,
  FilePlus,
  FileText,
  Folder,
  GitFork,
  Globe,
  ListChecks,
  MagnifyingGlass,
  Paperclip,
  PencilSimple,
  Plugs,
  Question,
  ShieldCheck,
  Stop,
  Target,
  TerminalWindow,
  Trash,
  Waypoints,
  Wrench,
} from '@/components/common/icons';

/**
 * Agent tool icon map — thin-stroke Lucide icons (via the project icon layer),
 * one glyph per tool family so execution rows read at a glance without color.
 */
const TOOL_ICON_MAP: Record<string, (size: number) => ReactNode> = {
  Read: (size) => <FileText size={size} />,
  Write: (size) => <FilePlus size={size} />,
  ReadDocument: (size) => <FileText size={size} />,
  WriteDocument: (size) => <FilePlus size={size} />,
  SlackListChannels: (size) => <ChatCircle size={size} />,
  SlackPostMessage: (size) => <ChatCircle size={size} />,
  DriveList: (size) => <Folder size={size} />,
  DriveRead: (size) => <Folder size={size} />,
  NotionSearch: (size) => <FileText size={size} />,
  NotionCreatePage: (size) => <FileText size={size} />,
  Edit: (size) => <PencilSimple size={size} />,
  NotebookEdit: (size) => <PencilSimple size={size} />,
  Bash: (size) => <TerminalWindow size={size} />,
  Pty: (size) => <TerminalWindow size={size} />,
  Grep: (size) => <MagnifyingGlass size={size} />,
  Glob: (size) => <MagnifyingGlass size={size} />,
  LSP: (size) => <MagnifyingGlass size={size} />,
  WebFetch: (size) => <Globe size={size} />,
  WebSearch: (size) => <Globe size={size} />,
  Agent: (size) => <Waypoints size={size} />,
  TodoWrite: (size) => <ListChecks size={size} />,
  ReviewArtifact: (size) => <ShieldCheck size={size} />,
  RunCode: (size) => <Code size={size} />,
  RunWorkflow: (size) => <ArrowsClockwise size={size} />,
  AskUser: (size) => <Question size={size} />,
  ListAgents: (size) => <GitFork size={size} />,
  SendMessage: (size) => <ChatCircle size={size} />,
  InterruptAgent: (size) => <Stop size={size} />,
  Report: (size) => <Paperclip size={size} />,
  GetGoal: (size) => <Target size={size} />,
  CreateGoal: (size) => <Target size={size} />,
  UpdateGoal: (size) => <Target size={size} />,
  MountPlugin: (size) => <Plugs size={size} />,
  UnmountPlugin: (size) => <Trash size={size} />,
  Ralph: (size) => <ArrowsClockwise size={size} />,
  Pwsh: (size) => <TerminalWindow size={size} />,
  SessionEventSearch: (size) => <MagnifyingGlass size={size} />,
  SessionEventRead: (size) => <FileText size={size} />,
  SessionTrace: (size) => <GitFork size={size} />,
  TaskList: (size) => <ListChecks size={size} />,
};

export function ToolIcon({ toolName, size = 14, className }: { toolName?: string; size?: number; className?: string }) {
  const render = toolName ? TOOL_ICON_MAP[toolName] : undefined;
  if (render) {
    return <span className={clsx('shrink-0', className)}>{render(size)}</span>;
  }
  return <Wrench size={size} className={clsx('shrink-0', className)} />;
}
