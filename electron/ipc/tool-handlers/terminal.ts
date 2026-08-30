/**
 * terminal.ts — persistent terminal, runtime inspection and skill tools.
 */
import { app } from 'electron';
import path from 'path';
import { errorText } from '../../errors';
import { inspectRuntime } from '../../runtime-inspect';
import { validateSkill } from '../../skill-gate';
import { writeSkill } from '../../skill-store';
import { runPtyTool } from '../pty-tool';
import type { ToolContext, ToolResult } from './path-utils';

export async function runPtyToolHandler(params: { action?: string }, ctx: ToolContext): Promise<ToolResult> {
  const action = typeof params?.action === 'string' ? params.action : '';
  const owner = ctx.agentId ?? 'chat';
  const result = await runPtyTool(action, (params ?? {}) as Record<string, unknown>, owner);
  if (result.error) return { output: null, error: result.error };
  return { output: result.output };
}

function terminalOwner(ctx: ToolContext): string {
  return ctx.agentId || ctx.sessionId || ctx.requestId;
}

export async function runTerminalOpen(
  params: { command?: string; cwd?: string; session_id?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const r = await runPtyTool('create', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

export async function runTerminalList(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
  const r = await runPtyTool('list', {}, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

export async function runTerminalRead(
  params: { session_id?: string; timeout_ms?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const r = await runPtyTool('read', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

export async function runTerminalSend(
  params: { session_id?: string; data?: string; enter?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  const r = await runPtyTool('write', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

export async function runTerminalSignal(
  params: { session_id?: string; signal?: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = String(params?.session_id ?? '');
  const signal = String(params?.signal ?? '').toUpperCase();
  const controlChars: Record<string, string> = {
    SIGINT: '\x03',
    SIGTSTP: '\x1a',
    SIGQUIT: '\x1c',
  };
  if (controlChars[signal]) {
    const r = await runPtyTool('write', { session_id: id, data: controlChars[signal] }, terminalOwner(ctx));
    if (r.error) return { output: null, error: r.error };
    return { output: { signaled: signal, session_id: id } };
  }
  if (signal === 'SIGTERM' || signal === 'SIGKILL') {
    const r = await runPtyTool('close', { session_id: id }, terminalOwner(ctx));
    if (r.error) return { output: null, error: r.error };
    return { output: { signaled: signal, session_id: id, closed: true } };
  }
  return { output: null, error: `不支持的信号: ${signal}（支持 SIGINT/SIGTSTP/SIGQUIT/SIGTERM/SIGKILL）` };
}

export async function runTerminalClose(params: { session_id?: string }, ctx: ToolContext): Promise<ToolResult> {
  const r = await runPtyTool('close', (params ?? {}) as Record<string, unknown>, terminalOwner(ctx));
  if (r.error) return { output: null, error: r.error };
  return { output: r.output };
}

export async function runInspectRuntime(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
  try {
    return { output: await inspectRuntime() };
  } catch (e: unknown) {
    return { output: null, error: `检视运行时失败: ${errorText(e)}` };
  }
}

export async function runWriteSkill(
  params: { name?: string; content?: string },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const name = typeof params?.name === 'string' ? params.name.trim() : '';
  const content = typeof params?.content === 'string' ? params.content.trim() : '';
  if (!name || !content) return { output: null, error: 'name 与 content 必填' };
  const gate = validateSkill(name, content);
  if (!gate.pass) {
    return { output: null, error: `技能未通过入库门禁：${gate.blocking.join('；')}` };
  }
  try {
    const root = path.join(app.getPath('userData'), 'skills');
    const file = await writeSkill(root, name, content);
    return { output: { name, path: file, warnings: gate.warnings } };
  } catch (e: unknown) {
    return { output: null, error: `写入技能失败: ${errorText(e)}` };
  }
}
