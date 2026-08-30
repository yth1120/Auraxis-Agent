/**
 * integrations.ts — document tools and cloud connector tools.
 */
import { errorText } from '../../errors';
import type { DocumentWriteSpec } from '../../document-tools';
import {
  isSensitiveToolPath,
  markFileObserved,
  resolveToolPath,
  workspaceRootsOf,
  writableRootsOf,
  type ToolContext,
  type ToolResult,
} from './path-utils';

export async function runReadDocument(params: { file_path?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const filePath = typeof params?.file_path === 'string' && params.file_path.trim() ? params.file_path.trim() : '';
  if (!filePath) return { output: null, error: 'file_path 不能为空' };
  let resolved: string;
  try {
    resolved = resolveToolPath(filePath, ctx.projectRoot, ctx.sandboxMode, workspaceRootsOf(ctx));
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型读取敏感文件: ${resolved}` };
  }
  try {
    const { readDocument } = await import('../../document-tools');
    const data = await readDocument(resolved);
    return { output: data };
  } catch (e: unknown) {
    return { output: null, error: `读取文档失败：${errorText(e)}` };
  }
}

export async function runWriteDocument(
  params: { file_path?: unknown; spec?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const filePath = typeof params?.file_path === 'string' && params.file_path.trim() ? params.file_path.trim() : '';
  const spec = params?.spec && typeof params.spec === 'object' ? (params.spec as Record<string, unknown>) : null;
  if (!filePath) return { output: null, error: 'file_path 不能为空' };
  if (!spec) return { output: null, error: 'spec 不能为空' };
  let resolved: string;
  try {
    resolved = resolveToolPath(filePath, ctx.projectRoot, ctx.sandboxMode, writableRootsOf(ctx));
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
  if (isSensitiveToolPath(resolved)) {
    return { output: null, error: `禁止模型修改敏感文件: ${resolved}` };
  }
  try {
    const { writeDocument } = await import('../../document-tools');
    const { format, bytes } = await writeDocument(resolved, spec as DocumentWriteSpec);
    markFileObserved(ctx, resolved);
    return { output: { file_path: resolved, format, bytes } };
  } catch (e: unknown) {
    return { output: null, error: `写入文档失败：${errorText(e)}` };
  }
}

export async function runSlackListChannels(params: { limit?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  try {
    const { slackListChannels } = await import('../../connectors');
    const channels = await slackListChannels(Number(params?.limit) || 100);
    return { output: { count: channels.length, channels } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

export async function runSlackPostMessage(
  params: { channel?: unknown; text?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const channel = typeof params?.channel === 'string' ? params.channel.trim() : '';
  const text = typeof params?.text === 'string' ? params.text : '';
  if (!channel || !text) return { output: null, error: 'SlackPostMessage 需要 channel 和 text' };
  try {
    const { slackPostMessage } = await import('../../connectors');
    const sent = await slackPostMessage(channel, text);
    return { output: { ok: true, ...sent } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

export async function runDriveList(
  params: { query?: unknown; page_size?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const { driveList } = await import('../../connectors');
    const files = await driveList(
      typeof params?.query === 'string' ? params.query : undefined,
      Number(params?.page_size) || 50,
    );
    return { output: { count: files.length, files } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

export async function runDriveRead(params: { file_id?: unknown }, _ctx: ToolContext): Promise<ToolResult> {
  const fileId = typeof params?.file_id === 'string' && params.file_id.trim() ? params.file_id.trim() : '';
  if (!fileId) return { output: null, error: 'file_id 不能为空' };
  try {
    const { driveRead } = await import('../../connectors');
    const data = await driveRead(fileId);
    return { output: data };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

export async function runNotionSearch(
  params: { query?: unknown; page_size?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const { notionSearch } = await import('../../connectors');
    const results = await notionSearch(
      typeof params?.query === 'string' ? params.query : undefined,
      Number(params?.page_size) || 10,
    );
    return { output: { count: results.length, results } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}

export async function runNotionCreatePage(
  params: { parent_page_id?: unknown; title?: unknown; markdown?: unknown },
  _ctx: ToolContext,
): Promise<ToolResult> {
  const parent = typeof params?.parent_page_id === 'string' ? params.parent_page_id.trim() : '';
  const title = typeof params?.title === 'string' ? params.title.trim() : '';
  const markdown = typeof params?.markdown === 'string' ? params.markdown : undefined;
  if (!parent || !title) return { output: null, error: 'NotionCreatePage 需要 parent_page_id 和 title' };
  try {
    const { notionCreatePage } = await import('../../connectors');
    const page = await notionCreatePage(parent, title, markdown);
    return { output: { ok: true, ...page } };
  } catch (e: unknown) {
    return { output: null, error: errorText(e) };
  }
}
