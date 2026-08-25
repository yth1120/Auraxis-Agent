/**
 * connectors.ts — Slack / Google Drive / Notion connector backends.
 *
 * Tokens are persisted through the encrypted settings store (safeStorage),
 * never returned to the renderer. The model-facing tools and the Settings UI
 * share these functions so one implementation stays authoritative.
 */
import axios from 'axios';
import { errorRecord, errorText } from './errors';
import { readSettings, writeSettings } from './ipc/settings-store';

export type ConnectorKind = 'slack' | 'drive' | 'notion';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const CONNECTOR_KINDS: ConnectorKind[] = ['slack', 'drive', 'notion'];

const CONNECTOR_FIELD: Record<ConnectorKind, string> = {
  slack: 'slackToken',
  drive: 'driveToken',
  notion: 'notionToken',
};

const NOTION_VERSION = '2022-06-28';

function tokenOf(kind: ConnectorKind, settings: Record<string, unknown>): string {
  const v = settings[CONNECTOR_FIELD[kind]];
  return typeof v === 'string' ? v.trim() : '';
}

export async function getConnectorToken(kind: ConnectorKind): Promise<string> {
  return tokenOf(kind, await readSettings());
}

export async function setConnectorToken(kind: ConnectorKind, token: string): Promise<void> {
  const settings = await readSettings();
  settings[CONNECTOR_FIELD[kind]] = typeof token === 'string' ? token.trim() : '';
  await writeSettings(settings);
}

export interface ConnectorStatus {
  kind: ConnectorKind;
  configured: boolean;
  tokenHint?: string;
}

export async function getConnectorStatuses(): Promise<ConnectorStatus[]> {
  const settings = await readSettings();
  return CONNECTOR_KINDS.map((kind) => {
    const token = tokenOf(kind, settings);
    return {
      kind,
      configured: token.length > 0,
      tokenHint: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : undefined,
    };
  });
}

async function requireToken(kind: ConnectorKind): Promise<string> {
  const token = await getConnectorToken(kind);
  if (!token) {
    const names: Record<ConnectorKind, string> = {
      slack: 'Slack',
      drive: 'Google Drive',
      notion: 'Notion',
    };
    throw new Error(`${names[kind]} 未配置 Token，请到「设置 → 连接器」添加后再试`);
  }
  return token;
}

export async function testConnector(kind: ConnectorKind): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await requireToken(kind);
    if (kind === 'slack') {
      const r = await axios.get('https://slack.com/api/conversations.list', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 1 },
        timeout: 15_000,
      });
      if (r.data?.ok === false) throw new Error(r.data.error || 'Slack API 返回错误');
      return { ok: true, message: `Slack 连接成功（会话总数 ${r.data?.channels?.length ?? 0} 条示例）` };
    }
    if (kind === 'drive') {
      const r = await axios.get('https://www.googleapis.com/drive/v3/files', {
        headers: { Authorization: `Bearer ${token}` },
        params: { pageSize: 1 },
        timeout: 15_000,
      });
      return { ok: true, message: `Google Drive 连接成功（可访问 ${r.data?.files?.length ?? 0} 个文件示例）` };
    }
    const r = await axios.post(
      'https://api.notion.com/v1/search',
      { page_size: 1 },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
        },
        timeout: 15_000,
      },
    );
    return { ok: true, message: `Notion 连接成功（可访问 ${r.data?.results?.length ?? 0} 个页面示例）` };
  } catch (error: unknown) {
    const record = errorRecord(error);
    const response = record.response as { data?: { error?: string } } | undefined;
    return { ok: false, message: response?.data?.error || errorText(error) };
  }
}

// ─── Slack ───────────────────────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  memberCount?: number;
}

export async function slackListChannels(limit = 100): Promise<SlackChannel[]> {
  const token = await requireToken('slack');
  const r = await axios.get('https://slack.com/api/conversations.list', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      limit: Math.max(1, Math.min(200, Number(limit) || 100)),
      exclude_archived: true,
      types: 'public_channel,private_channel',
    },
    timeout: 20_000,
  });
  if (r.data?.ok === false) throw new Error(r.data.error || 'Slack API 返回错误');
  const channels: unknown[] = Array.isArray(r.data?.channels) ? r.data.channels : [];
  return channels.filter(isRecord).map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    isPrivate: c.is_private === true,
    memberCount: typeof c.num_members === 'number' ? c.num_members : undefined,
  }));
}

export async function slackPostMessage(
  channel: string,
  text: string,
): Promise<{ channel: string; ts: string; message: string }> {
  if (!channel || !text?.trim()) throw new Error('SlackPostMessage 需要 channel 和 text');
  const token = await requireToken('slack');
  const r = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel, text: String(text) },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20_000 },
  );
  if (r.data?.ok === false) throw new Error(r.data.error || 'Slack API 返回错误');
  return {
    channel: String(r.data?.channel || channel),
    ts: String(r.data?.ts || ''),
    message: String(r.data?.message?.text || text),
  };
}

// ─── Google Drive ────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
}

export async function driveList(query?: string, pageSize = 50): Promise<DriveFile[]> {
  const token = await requireToken('drive');
  const r = await axios.get('https://www.googleapis.com/drive/v3/files', {
    headers: { Authorization: `Bearer ${token}` },
    params: {
      pageSize: Math.max(1, Math.min(100, Number(pageSize) || 50)),
      q: query?.trim() || undefined,
      fields: 'files(id,name,mimeType,modifiedTime)',
      orderBy: 'modifiedTime desc',
    },
    timeout: 20_000,
  });
  const files: unknown[] = Array.isArray(r.data?.files) ? r.data.files : [];
  return files.filter(isRecord).map((f) => ({
    id: String(f.id ?? ''),
    name: String(f.name ?? ''),
    mimeType: typeof f.mimeType === 'string' ? f.mimeType : undefined,
    modifiedTime: typeof f.modifiedTime === 'string' ? f.modifiedTime : undefined,
  }));
}

export interface DriveReadResult {
  id: string;
  name: string;
  mimeType?: string;
  bytes: number;
  text?: string;
  base64?: string;
}

const TEXT_MIME = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/json',
  'application/xml',
  'application/yaml',
  'application/vnd.google-apps.script+json',
]);

export async function driveRead(fileId: string): Promise<DriveReadResult> {
  if (!fileId?.trim()) throw new Error('driveRead 需要 file_id');
  const token = await requireToken('drive');
  const meta = await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { fields: 'id,name,mimeType' },
    timeout: 20_000,
  });
  const content = await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { alt: 'media' },
    responseType: 'arraybuffer',
    timeout: 60_000,
  });
  const buffer = Buffer.from(content.data as ArrayBuffer);
  const mimeType = typeof meta.data?.mimeType === 'string' ? meta.data.mimeType : undefined;
  const name = String(meta.data?.name || fileId);
  const textLike = mimeType && (TEXT_MIME.has(mimeType) || mimeType.startsWith('text/'));
  return {
    id: fileId,
    name,
    mimeType,
    bytes: buffer.byteLength,
    ...(textLike ? { text: buffer.toString('utf8') } : { base64: buffer.toString('base64') }),
  };
}

// ─── Notion ──────────────────────────────────────────────

export interface NotionPageSummary {
  id: string;
  title: string;
  url?: string;
  objectType?: string;
}

function notionTitleOf(result: unknown): string {
  try {
    if (!isRecord(result)) return '';
    const properties = isRecord(result.properties) ? result.properties : {};
    const titleProp = isRecord(properties.title) ? properties.title : {};
    const arr = Array.isArray(titleProp.title)
      ? titleProp.title
      : Array.isArray(titleProp.rich_text)
        ? titleProp.rich_text
        : [];
    return arr.map((item) => (isRecord(item) && typeof item.plain_text === 'string' ? item.plain_text : '')).join('');
  } catch {
    return '';
  }
}

export async function notionSearch(query?: string, pageSize = 10): Promise<NotionPageSummary[]> {
  const token = await requireToken('notion');
  const r = await axios.post(
    'https://api.notion.com/v1/search',
    { query: query?.trim() || undefined, page_size: Math.max(1, Math.min(50, Number(pageSize) || 10)) },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    },
  );
  const results: unknown[] = Array.isArray(r.data?.results) ? r.data.results : [];
  return results.filter(isRecord).map((x) => ({
    id: String(x.id ?? ''),
    title: notionTitleOf(x) || String(x.object ?? ''),
    url: typeof x.url === 'string' ? x.url : undefined,
    objectType: typeof x.object === 'string' ? x.object : undefined,
  }));
}

/** Minimal Markdown → Notion block converter (headings, bullets, numbers, code). */
function markdownToBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: paragraph.join(' ').slice(0, 2000) } }] },
    });
    paragraph = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push({
        object: 'block',
        type: `heading_${level}`,
        [`heading_${level}`]: { rich_text: [{ type: 'text', text: { content: heading[2].slice(0, 2000) } }] },
      });
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: bullet[1].slice(0, 2000) } }] },
      });
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ type: 'text', text: { content: numbered[1].slice(0, 2000) } }] },
      });
      continue;
    }
    const code = line.match(/^```\s*([\w-]*)$/);
    if (code) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'code',
        code: { language: code[1] || 'plain text', rich_text: [{ type: 'text', text: { content: '' } }] },
      });
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.slice(0, 100);
}

export async function notionCreatePage(
  parentPageId: string,
  title: string,
  markdown?: string,
): Promise<{ id: string; url?: string }> {
  if (!parentPageId?.trim()) throw new Error('NotionCreatePage 需要 parent_page_id（父页面 ID）');
  if (!title?.trim()) throw new Error('NotionCreatePage 需要 title');
  const token = await requireToken('notion');
  const body: Record<string, unknown> = {
    parent: { page_id: parentPageId.trim() },
    properties: {
      title: { title: [{ type: 'text', text: { content: String(title).slice(0, 2000) } }] },
    },
  };
  if (markdown?.trim()) {
    body.children = markdownToBlocks(markdown);
  }
  const r = await axios.post('https://api.notion.com/v1/pages', body, {
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    timeout: 20_000,
  });
  return {
    id: String(r.data?.id || ''),
    url: typeof r.data?.url === 'string' ? r.data.url : undefined,
  };
}
