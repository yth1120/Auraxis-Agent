import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

vi.mock('../permission-profile', () => ({
  evaluateToolProfileGate: vi.fn(async () => ({ allowed: true, reason: '' })),
}));
vi.mock('../../sandbox-policy', () => ({
  enforceSandbox: vi.fn(() => ({ allowed: true, reason: '' })),
  commandMutates: vi.fn(() => ({ mutates: false })),
}));
vi.mock('../../rules', () => ({
  loadRules: vi.fn(async () => []),
  matchRule: vi.fn(() => null),
}));
vi.mock('../../hooks', () => ({
  runHooksFor: vi.fn(async () => null),
}));
vi.mock('../permission-handlers', () => ({
  shouldAutoApprove: vi.fn(() => true),
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../window-ref', () => ({
  getMainWindowRef: vi.fn(() => null),
}));
vi.mock('../../skill-store', () => ({
  ensureSkillsDirectory: vi.fn(async () => {}),
  listSkills: vi.fn(async () => []),
  readSkill: vi.fn(async () => null),
  writeSkill: vi.fn(async () => '/skills/x.md'),
  seedBuiltinSkills: vi.fn(async () => 0),
}));
vi.mock('../../document-tools', () => ({
  readDocument: vi.fn(async (filePath: string) => ({
    format: 'docx',
    fileName: path.basename(filePath),
    bytes: 42,
    text: 'mock doc content',
  })),
  writeDocument: vi.fn(async (filePath: string) => ({
    format: path.extname(filePath).slice(1),
    bytes: 99,
  })),
}));
vi.mock('../../connectors', () => ({
  slackListChannels: vi.fn(async () => [{ id: 'C1', name: 'general', isPrivate: false }]),
  slackPostMessage: vi.fn(async (channel: string, text: string) => ({ channel, ts: '1.2', message: text })),
  driveList: vi.fn(async () => [{ id: 'F1', name: 'a.txt' }]),
  driveRead: vi.fn(async (fileId: string) => ({ id: fileId, name: 'a.txt', bytes: 3, text: 'abc' })),
  notionSearch: vi.fn(async () => [{ id: 'P1', title: '周报' }]),
  notionCreatePage: vi.fn(async (_parent: string, _title: string) => ({ id: 'NP1', url: 'https://notion.so/NP1' })),
}));

import { executeToolCall } from '../tool-handlers';
import { readDocument, writeDocument } from '../../document-tools';
import {
  slackListChannels,
  slackPostMessage,
  driveList,
  driveRead,
  notionSearch,
  notionCreatePage,
} from '../../connectors';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    projectRoot: os.tmpdir(),
    requestId: 'doc-1',
    mode: 'auto' as const,
    sandboxMode: 'full' as const,
    autoApprove: true,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReadDocument / WriteDocument', () => {
  it('ReadDocument resolves path and returns document text', async () => {
    const r = await executeToolCall('ReadDocument', { file_path: 'docs/a.docx' }, ctx());
    expect(r.error).toBeUndefined();
    expect((r.output as any).text).toBe('mock doc content');
    expect(readDocument).toHaveBeenCalledWith(path.join(os.tmpdir(), 'docs', 'a.docx'));
  });

  it('ReadDocument rejects empty path', async () => {
    const r = await executeToolCall('ReadDocument', {}, ctx());
    expect(r.error).toContain('file_path');
  });

  it('ReadDocument rejects paths outside project under confined sandbox', async () => {
    const outside = path.join(os.tmpdir(), '..', '..', 'outside.docx');
    const r = await executeToolCall('ReadDocument', { file_path: outside }, ctx({ sandboxMode: 'workspace-write' }));
    expect(r.error).toMatch(/路径越界|不在项目/);
  });

  it('WriteDocument resolves and writes spec', async () => {
    const r = await executeToolCall(
      'WriteDocument',
      { file_path: 'out/report.docx', spec: { title: 'T', blocks: [] } },
      ctx(),
    );
    expect(r.error).toBeUndefined();
    expect((r.output as any).bytes).toBe(99);
    expect(writeDocument).toHaveBeenCalledWith(
      path.join(os.tmpdir(), 'out', 'report.docx'),
      expect.objectContaining({ title: 'T' }),
    );
  });

  it('WriteDocument requires spec', async () => {
    const r = await executeToolCall('WriteDocument', { file_path: 'a.docx' }, ctx());
    expect(r.error).toContain('spec');
  });

  it('Work surface hard-denies writing code files via WriteDocument', async () => {
    const r = await executeToolCall(
      'WriteDocument',
      { file_path: 'src/app.ts', spec: { title: 'x' } },
      ctx({ surface: 'work' }),
    );
    expect(r.error).toContain('Work 模式仅允许修改文档');
    expect(writeDocument).not.toHaveBeenCalled();
  });

  it('Work surface allows writing document files via WriteDocument', async () => {
    const r = await executeToolCall(
      'WriteDocument',
      { file_path: 'docs/note.docx', spec: { title: 'x' } },
      ctx({ surface: 'work' }),
    );
    expect(r.error).toBeUndefined();
  });
});

describe('Cloud connector tools', () => {
  it('SlackListChannels returns channels', async () => {
    const r = await executeToolCall('SlackListChannels', { limit: 20 }, ctx());
    expect((r.output as any).count).toBe(1);
    expect(slackListChannels).toHaveBeenCalledWith(20);
  });

  it('SlackPostMessage validates and posts', async () => {
    expect((await executeToolCall('SlackPostMessage', { channel: 'C1' }, ctx())).error).toContain('channel 和 text');
    const r = await executeToolCall('SlackPostMessage', { channel: 'C1', text: 'hello' }, ctx());
    expect((r.output as any).ts).toBe('1.2');
    expect(slackPostMessage).toHaveBeenCalledWith('C1', 'hello');
  });

  it('DriveList and DriveRead', async () => {
    const list = await executeToolCall('DriveList', { query: "name contains 'x'", page_size: 5 }, ctx());
    expect((list.output as any).files[0].id).toBe('F1');
    expect(driveList).toHaveBeenCalledWith("name contains 'x'", 5);
    expect((await executeToolCall('DriveRead', {}, ctx())).error).toContain('file_id');
    const read = await executeToolCall('DriveRead', { file_id: 'F1' }, ctx());
    expect((read.output as any).text).toBe('abc');
    expect(driveRead).toHaveBeenCalledWith('F1');
  });

  it('NotionSearch and NotionCreatePage', async () => {
    const s = await executeToolCall('NotionSearch', { query: '周报' }, ctx());
    expect((s.output as any).results[0].id).toBe('P1');
    expect(notionSearch).toHaveBeenCalledWith('周报', 10);
    expect((await executeToolCall('NotionCreatePage', { title: 'x' }, ctx())).error).toContain('parent_page_id');
    const c = await executeToolCall('NotionCreatePage', { parent_page_id: 'P1', title: '新页' }, ctx());
    expect((c.output as any).id).toBe('NP1');
    expect(notionCreatePage).toHaveBeenCalledWith('P1', '新页', undefined);
  });
});
