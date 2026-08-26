import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  driveList,
  driveRead,
  getConnectorStatuses,
  getConnectorToken,
  getLarkCredentials,
  getLarkPublicConfig,
  notionCreatePage,
  notionSearch,
  setConnectorToken,
  setLarkCredentials,
  slackListChannels,
  slackPostMessage,
  testConnector,
} from '../connectors';
import { readSettings, writeSettings } from '../ipc/settings-store';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../ipc/settings-store', () => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
}));

const axiosMock = vi.mocked(axios);
const readSettingsMock = vi.mocked(readSettings);
const writeSettingsMock = vi.mocked(writeSettings);

describe('connectors — 连接器配置与后端', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSettingsMock.mockReset().mockResolvedValue({});
    writeSettingsMock.mockReset().mockResolvedValue(undefined);
    axiosMock.get.mockReset();
    axiosMock.post.mockReset();
    axiosMock.get.mockResolvedValue({ data: {} });
    axiosMock.post.mockResolvedValue({ data: {} });
  });

  it('getConnectorToken / setConnectorToken 读写并裁剪 token', async () => {
    readSettingsMock.mockResolvedValue({ slackToken: '  token  ' });
    expect(await getConnectorToken('slack')).toBe('token');
    await setConnectorToken('drive', '  drive-token  ');
    expect(writeSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ driveToken: 'drive-token' }));
  });

  it('getConnectorStatuses 覆盖缺失与 Lark App ID/Secret 分支', async () => {
    readSettingsMock.mockResolvedValue({
      slackToken: 'slack',
      driveToken: '',
      notionToken: 'notion',
      larkAppId: 'cli-app',
      larkAppSecret: 'secret',
    });
    const statuses = await getConnectorStatuses();
    expect(statuses.find((s) => s.kind === 'slack')).toMatchObject({ configured: true });
    expect(statuses.find((s) => s.kind === 'drive')).toMatchObject({ configured: false });
    expect(statuses.find((s) => s.kind === 'notion')).toMatchObject({ configured: true });
    expect(statuses.find((s) => s.kind === 'lark')).toMatchObject({ configured: true });
  });

  it('testConnector 覆盖 Slack/Drive/Notion 的成功与 API 错误', async () => {
    readSettingsMock.mockResolvedValue({ slackToken: 'slack' });
    axiosMock.get.mockResolvedValueOnce({ data: { ok: true, channels: [{ id: 'c1' }] } });
    expect(await testConnector('slack')).toMatchObject({ ok: true });

    axiosMock.get.mockResolvedValueOnce({ data: { ok: false, error: 'bad token' } });
    expect(await testConnector('slack')).toMatchObject({ ok: false });

    readSettingsMock.mockResolvedValue({ driveToken: 'drive' });
    axiosMock.get.mockResolvedValueOnce({ data: { files: [{ id: 'f1' }] } });
    expect(await testConnector('drive')).toMatchObject({ ok: true });

    readSettingsMock.mockResolvedValue({ notionToken: 'notion' });
    axiosMock.post.mockResolvedValueOnce({ data: { results: [{ id: 'p1', object: 'page', url: 'https://x' }] } });
    expect(await testConnector('notion')).toMatchObject({ ok: true });
  });

  it('testConnector 覆盖缺失 token、网络错误和 Lark 凭据分支', async () => {
    expect((await testConnector('slack')).ok).toBe(false);

    readSettingsMock.mockResolvedValue({ driveToken: 'drive' });
    axiosMock.get.mockRejectedValueOnce({ response: { data: { error: 'network' } } });
    expect((await testConnector('drive')).message).toContain('network');

    readSettingsMock.mockResolvedValue({ larkAppId: '', larkAppSecret: '' });
    expect((await testConnector('lark')).ok).toBe(false);

    readSettingsMock.mockResolvedValue({ larkAppId: 'app', larkAppSecret: 'secret' });
    axiosMock.post.mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 'token' } });
    expect(await testConnector('lark')).toMatchObject({ ok: true });

    axiosMock.post.mockResolvedValueOnce({ data: { code: 1, msg: 'invalid' } });
    expect(await testConnector('lark')).toMatchObject({ ok: false });
  });

  it('slackListChannels 覆盖正常、空 channels、API 失败和 limit 边界', async () => {
    readSettingsMock.mockResolvedValue({ slackToken: 'slack' });
    axiosMock.get.mockResolvedValueOnce({
      data: { ok: true, channels: [{ id: 'c1', name: 'demo', is_private: true, num_members: 3 }] },
    });
    expect(await slackListChannels(0)).toHaveLength(1);

    axiosMock.get.mockResolvedValueOnce({ data: { ok: false, error: 'channel error' } });
    await expect(slackListChannels(999)).rejects.toThrow('channel error');
  });

  it('slackPostMessage 覆盖参数校验与成功返回', async () => {
    await expect(slackPostMessage('', 'text')).rejects.toThrow('需要 channel 和 text');
    await expect(slackPostMessage('c1', '   ')).rejects.toThrow('需要 channel 和 text');
    readSettingsMock.mockResolvedValue({ slackToken: 'slack' });
    axiosMock.post.mockResolvedValueOnce({
      data: { ok: true, channel: 'c1', ts: '123', message: { text: 'hi' } },
    });
    expect(await slackPostMessage('c1', 'hi')).toEqual({
      channel: 'c1',
      ts: '123',
      message: 'hi',
    });
  });

  it('driveList / driveRead 覆盖映射、TEXT_MIME 与 base64 分支', async () => {
    readSettingsMock.mockResolvedValue({ driveToken: 'drive' });
    axiosMock.get.mockResolvedValueOnce({
      data: { files: [{ id: 'f1', name: 'a.txt', mimeType: 'text/plain', modifiedTime: '2026-01-01' }] },
    });
    expect(await driveList('query', 0)).toHaveLength(1);

    axiosMock.get
      .mockResolvedValueOnce({ data: { id: 'f1', name: 'a.txt', mimeType: 'text/plain' } })
      .mockResolvedValueOnce({ data: Buffer.from('hello') });
    expect(await driveRead('f1')).toMatchObject({ text: 'hello', bytes: 5 });

    axiosMock.get
      .mockResolvedValueOnce({ data: { id: 'f1', name: 'a.png', mimeType: 'image/png' } })
      .mockResolvedValueOnce({ data: Buffer.from([1, 2, 3]) });
    expect(await driveRead('f1')).toMatchObject({ base64: 'AQID' });
  });

  it('driveRead 拒绝空 fileId', async () => {
    await expect(driveRead('')).rejects.toThrow('driveRead 需要 file_id');
  });

  it('notionSearch / notionCreatePage 覆盖标题字段、Markdown blocks 和校验', async () => {
    readSettingsMock.mockResolvedValue({ notionToken: 'notion' });
    axiosMock.post.mockResolvedValueOnce({
      data: {
        results: [
          { id: 'p1', object: 'page', url: 'https://n', properties: { title: { title: [{ plain_text: 'Page' }] } } },
          { id: 'p2', object: 'page', properties: { title: { rich_text: [{ plain_text: 'Other' }] } } },
          { id: 'p3', object: 'page' },
        ],
      },
    });
    const pages = await notionSearch('query', 0);
    expect(pages[0].title).toBe('Page');
    expect(pages[1].title).toBe('Other');
    expect(pages[2].title).toBe('page');

    axiosMock.post.mockResolvedValueOnce({ data: { id: 'new', url: 'https://n/new' } });
    expect(await notionCreatePage('parent', 'Title', '# H1\n- bullet\n1. item\n```ts\ncode\n```\ntext')).toEqual({
      id: 'new',
      url: 'https://n/new',
    });
    axiosMock.post.mockResolvedValueOnce({ data: { id: 'new-2', url: 'https://n/new2' } });
    expect(await notionCreatePage('parent', 'Title 2', '\n\n### H3\n\n```\nplain code\n```\n')).toEqual({
      id: 'new-2',
      url: 'https://n/new2',
    });
  });

  it('notionCreatePage 校验父页面和标题', async () => {
    await expect(notionCreatePage('', 'title')).rejects.toThrow('父页面');
    await expect(notionCreatePage('parent', '  ')).rejects.toThrow('需要 title');
  });

  it('setLarkCredentials / getLarkCredentials / getLarkPublicConfig 覆盖默认值', async () => {
    readSettingsMock.mockResolvedValue({});
    await setLarkCredentials({ appId: ' app ', appSecret: ' secret ', domain: '', tools: '' });
    expect(writeSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ larkAppId: 'app', larkAppSecret: 'secret' }),
    );
    readSettingsMock.mockResolvedValue({});
    expect(await getLarkCredentials()).toMatchObject({ domain: 'https://open.feishu.cn', tools: 'preset.light' });
    expect(await getLarkPublicConfig()).toMatchObject({ domain: 'https://open.feishu.cn', tools: 'preset.light' });
  });

  it('setConnectorToken 处理非字符串输入', async () => {
    await setConnectorToken('slack', 123 as unknown as string);
    expect(writeSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ slackToken: '' }));
  });

  it('maps missing connector response fields and token fallbacks', async () => {
    readSettingsMock.mockResolvedValue({
      slackToken: 'slack',
      driveToken: 'drive',
      notionToken: 'notion',
      larkAppId: 'app',
      larkAppSecret: 'secret',
      larkDomain: 'https://open.feishu.cn/',
    });
    axiosMock.get.mockResolvedValueOnce({ data: {} });
    expect((await testConnector('slack')).message).toContain('0');
    axiosMock.get.mockResolvedValueOnce({ data: {} });
    expect((await testConnector('drive')).message).toContain('0');
    axiosMock.post.mockResolvedValueOnce({ data: {} });
    expect((await testConnector('notion')).message).toContain('0');
    axiosMock.post.mockResolvedValueOnce({ data: { code: 0, tenant_access_token: 't' } });
    expect((await testConnector('lark')).ok).toBe(true);

    readSettingsMock.mockResolvedValue({ slackToken: 'slack' });
    axiosMock.get.mockResolvedValueOnce({ data: { ok: true, channels: [null, { id: 1, name: 2, num_members: 'x' }] } });
    expect(await slackListChannels(0)).toEqual([{ id: '1', name: '2', isPrivate: false, memberCount: undefined }]);

    axiosMock.post.mockResolvedValueOnce({ data: { ok: true, channel: '', ts: '', message: {} } });
    expect(await slackPostMessage('c', 'text')).toEqual({ channel: 'c', ts: '', message: 'text' });
    axiosMock.post.mockResolvedValueOnce({ data: { ok: false } });
    await expect(slackPostMessage('c', 'text')).rejects.toThrow('Slack API 返回错误');

    readSettingsMock.mockResolvedValue({ driveToken: 'drive' });
    axiosMock.get.mockResolvedValueOnce({ data: {} });
    expect(await driveList('  ', 0)).toEqual([]);
    axiosMock.get.mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ data: Buffer.alloc(0) });
    expect(await driveRead('f')).toMatchObject({ name: 'f', bytes: 0, base64: '' });

    readSettingsMock.mockResolvedValue({ notionToken: 'notion' });
    axiosMock.post.mockResolvedValueOnce({ data: { results: [null, { id: 1, object: 2, url: 3 }] } });
    expect(await notionSearch('  ', 0)).toEqual([{ id: '1', title: '2' }]);
    expect(await notionCreatePage('parent', 'Title', '')).toEqual({ id: '' });
  });
});
