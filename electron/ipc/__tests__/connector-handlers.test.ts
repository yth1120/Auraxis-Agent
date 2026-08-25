import { describe, it, expect, vi, beforeEach } from 'vitest';

const electronMock = vi.hoisted(() => ({
  handle: vi.fn(),
  app: { getPath: vi.fn(() => '/tmp/auraxis-userdata') },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: electronMock.handle },
  app: electronMock.app,
}));

vi.mock('../../connectors', () => ({
  getConnectorStatuses: vi.fn(async () => [
    { kind: 'slack', configured: true, tokenHint: 'xoxb…test' },
    { kind: 'drive', configured: false },
    { kind: 'notion', configured: false },
  ]),
  getLarkPublicConfig: vi.fn(async () => ({
    appId: 'cli-test',
    domain: 'https://open.feishu.cn',
    tools: 'preset.light',
  })),
  setLarkCredentials: vi.fn(async () => {}),
  setConnectorToken: vi.fn(async () => {}),
  testConnector: vi.fn(async () => ({ ok: true, message: 'Slack 连接成功' })),
}));

import { registerConnectorHandlers } from '../connector-handlers';
import {
  getLarkPublicConfig,
  getConnectorStatuses,
  setConnectorToken,
  setLarkCredentials,
  testConnector,
} from '../../connectors';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

function capture(): Map<string, Handler> {
  electronMock.handle.mockClear();
  registerConnectorHandlers();
  const map = new Map<string, Handler>();
  for (const [channel, fn] of electronMock.handle.mock.calls) {
    map.set(channel as string, fn as Handler);
  }
  return map;
}

describe('connector-handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('status returns connector statuses', async () => {
    const h = capture();
    const r = await h.get('connector:status')!({});
    expect(r.ok).toBe(true);
    expect(r.data[0]).toMatchObject({ kind: 'slack', configured: true });
  });

  it('setToken validates kind and delegates', async () => {
    const h = capture();
    expect((await h.get('connector:setToken')!({}, 'github', 'x')).ok).toBe(false);
    const r = await h.get('connector:setToken')!({}, 'slack', 'xoxb-new');
    expect(r.ok).toBe(true);
    expect(setConnectorToken).toHaveBeenCalledWith('slack', 'xoxb-new');
  });

  it('test returns connector result', async () => {
    const h = capture();
    const r = await h.get('connector:test')!({}, 'notion');
    expect(r.data).toEqual({ ok: true, message: 'Slack 连接成功' });
    expect(testConnector).toHaveBeenCalledWith('notion');
  });

  it('getConnectorStatuses is used (no token leak)', async () => {
    const h = capture();
    await h.get('connector:status')!({});
    expect(getConnectorStatuses).toHaveBeenCalled();
  });

  it('setLark validates and delegates the credential payload', async () => {
    const h = capture();
    expect(await h.get('connector:setLark')!({}, { appId: 1, appSecret: 's' })).toMatchObject({ ok: false });
    const r = await h.get('connector:setLark')!(
      {},
      {
        appId: 'cli-new',
        appSecret: 'secret-new',
        domain: 'https://open.larksuite.com',
        tools: 'preset.im.default',
      },
    );
    expect(r.ok).toBe(true);
    expect(setLarkCredentials).toHaveBeenCalledWith({
      appId: 'cli-new',
      appSecret: 'secret-new',
      domain: 'https://open.larksuite.com',
      tools: 'preset.im.default',
    });
  });

  it('getLark returns public config without a secret', async () => {
    const h = capture();
    const r = await h.get('connector:getLark')!({});
    expect(r).toEqual({
      ok: true,
      data: { appId: 'cli-test', domain: 'https://open.feishu.cn', tools: 'preset.light' },
    });
    expect(getLarkPublicConfig).toHaveBeenCalled();
  });
});
