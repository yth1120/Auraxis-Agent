import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  getConnectorStatuses,
  setConnectorToken,
  testConnector,
  slackListChannels,
  slackPostMessage,
  driveList,
  driveRead,
  notionSearch,
  notionCreatePage,
} from '../connectors';

vi.mock('../ipc/settings-store', () => ({
  readSettings: vi.fn(async () => ({
    slackToken: 'xoxb-1234567890abcdef',
    driveToken: 'ya29-1234567890abcdef',
    notionToken: 'secret-1234567890abcdef',
  })),
  writeSettings: vi.fn(async () => {}),
}));
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const axiosGet = vi.mocked(axios.get);
const axiosPost = vi.mocked(axios.post);

describe('connectors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports configured status without leaking tokens', async () => {
    const statuses = await getConnectorStatuses();
    expect(statuses).toHaveLength(3);
    for (const s of statuses) {
      expect(s.configured).toBe(true);
      expect(s.tokenHint).not.toContain('test');
      expect(s.tokenHint).toMatch(/…[A-Za-z0-9]+$/);
    }
  });

  it('setConnectorToken writes through encrypted settings', async () => {
    const { writeSettings } = await import('../ipc/settings-store');
    await setConnectorToken('slack', '  xoxb-new  ');
    expect(writeSettings).toHaveBeenCalledWith(expect.objectContaining({ slackToken: 'xoxb-new' }));
  });

  it('testConnector returns friendly error when token missing', async () => {
    const { readSettings } = await import('../ipc/settings-store');
    vi.mocked(readSettings).mockResolvedValueOnce({});
    const r = await testConnector('slack');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Slack 未配置 Token');
  });

  it('slackListChannels maps channels', async () => {
    axiosGet.mockResolvedValueOnce({
      data: { ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, num_members: 3 }] },
    });
    const channels = await slackListChannels(10);
    expect(channels[0]).toMatchObject({ id: 'C1', name: 'general', isPrivate: false, memberCount: 3 });
    expect(axiosGet).toHaveBeenCalledWith(
      'https://slack.com/api/conversations.list',
      expect.objectContaining({ params: expect.objectContaining({ limit: 10 }) }),
    );
  });

  it('slackPostMessage posts and returns ts', async () => {
    axiosPost.mockResolvedValueOnce({ data: { ok: true, channel: 'C1', ts: '123', message: { text: 'hi' } } });
    const r = await slackPostMessage('C1', 'hi');
    expect(r).toMatchObject({ channel: 'C1', ts: '123' });
  });

  it('driveList sends optional query', async () => {
    axiosGet.mockResolvedValueOnce({ data: { files: [{ id: 'F1', name: 'a.txt', mimeType: 'text/plain' }] } });
    const files = await driveList("name contains 'a'");
    expect(files[0].id).toBe('F1');
    expect(axiosGet.mock.calls[0][1]).toMatchObject({ params: expect.objectContaining({ q: "name contains 'a'" }) });
  });

  it('driveRead returns text for text mime and base64 otherwise', async () => {
    axiosGet
      .mockResolvedValueOnce({ data: { id: 'F1', name: 'a.txt', mimeType: 'text/plain' } })
      .mockResolvedValueOnce({ data: Buffer.from('hello') });
    const text = await driveRead('F1');
    expect(text.text).toBe('hello');

    axiosGet
      .mockResolvedValueOnce({ data: { id: 'F2', name: 'b.bin', mimeType: 'application/octet-stream' } })
      .mockResolvedValueOnce({ data: Buffer.from('abc') });
    const bin = await driveRead('F2');
    expect(bin.base64).toBe(Buffer.from('abc').toString('base64'));
  });

  it('notionSearch returns page summaries', async () => {
    axiosPost.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 'P1',
            object: 'page',
            url: 'https://notion.so/P1',
            properties: { title: { title: [{ plain_text: '周报' }] } },
          },
        ],
      },
    });
    const results = await notionSearch('周报');
    expect(results[0]).toMatchObject({ id: 'P1', title: '周报' });
    expect(axiosPost.mock.calls[0][2]).toMatchObject({
      headers: expect.objectContaining({ 'Notion-Version': '2022-06-28' }),
    });
  });

  it('notionCreatePage converts markdown to blocks', async () => {
    axiosPost.mockResolvedValueOnce({ data: { id: 'NP1', url: 'https://notion.so/NP1' } });
    const r = await notionCreatePage('P1', '新页面', '# 标题\n- 要点\n1. 编号\n\n正文');
    expect(r.id).toBe('NP1');
    const body = axiosPost.mock.calls[0][1] as { children: Record<string, unknown>[] };
    expect(body.children.some((b) => b.type === 'heading_1')).toBe(true);
    expect(body.children.some((b) => b.type === 'bulleted_list_item')).toBe(true);
    expect(body.children.some((b) => b.type === 'numbered_list_item')).toBe(true);
    expect(body.children.some((b) => b.type === 'paragraph')).toBe(true);
  });
});
