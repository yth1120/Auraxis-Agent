import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  win: null as null | any,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: Function) => h.handlers.set(channel, fn)),
  },
  BrowserWindow: {
    fromWebContents: () => h.win,
  },
  app: { getPath: vi.fn(() => '') },
}));

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../agent-loop', () => ({
  readErrorBody: vi.fn(async () => '{}'),
}));
vi.mock('../query-engine', () => ({
  runQuery: vi.fn(async () => {}),
}));
vi.mock('../permission-handlers', () => ({
  requestPermission: vi.fn(async () => true),
}));
vi.mock('../stats-handlers', () => ({
  trackMessage: vi.fn(async () => {}),
}));
vi.mock('../settings-store', () => ({
  readSettings: vi.fn(async () => ({ deepseekApiKey: 'sk-settings' })),
  resolveMaxOutputTokens: vi.fn(() => 8192),
}));
vi.mock('../model-config', () => ({
  resolveApiBase: vi.fn(() => 'https://api.example/v1/chat/completions'),
  resolveModelApiBase: vi.fn(async () => 'https://api.example/v1/chat/completions'),
  resolveModelApiKey: vi.fn(async () => undefined),
}));
vi.mock('../tool-handlers', () => ({
  executeToolCall: vi.fn(async () => ({ output: { results: [] }, error: null })),
  abortTool: vi.fn(() => true),
}));
vi.mock('../event-bridge', () => ({
  toToolStreamEvent: vi.fn(() => null),
}));
vi.mock('../query-context', () => ({
  clearLlmContext: vi.fn(async () => {}),
}));
vi.mock('../../credentials', () => ({
  resolveCredential: vi.fn(async () => null),
}));

import axios from 'axios';
import { registerAiHandlers, cleanupWindowStreams } from '../ai-handlers';
import { runQuery } from '../query-engine';
import { requestPermission } from '../permission-handlers';
import { readSettings } from '../settings-store';
import { executeToolCall } from '../tool-handlers';
import { toToolStreamEvent } from '../event-bridge';
import { clearLlmContext } from '../query-context';
import { resolveCredential } from '../../credentials';
import { readErrorBody } from '../agent-loop';

const handler = (ch: string) => h.handlers.get(ch)! as any;

function makeWin() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

async function* sse(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

function chatPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'r1',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '你好' }],
    isDeepThink: false,
    isWebSearch: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.win = makeWin();
  vi.mocked(axios.post).mockResolvedValue({ data: sse('data: [DONE]\n\n') } as any);
  vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { data: [{ id: 'deepseek-v4-pro' }] } } as any);
  vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: 'sk-settings' });
  vi.mocked(executeToolCall).mockResolvedValue({ output: { results: [] }, error: undefined });
  vi.mocked(resolveCredential).mockResolvedValue(null as any);
  vi.mocked(toToolStreamEvent).mockReturnValue(null as any);
  delete process.env.DEEPSEEK_API_KEY;
  registerAiHandlers();
});

describe('ai:chatStream', () => {
  it('无窗口实例时直接报错', async () => {
    h.win = null;
    const sender = { send: vi.fn() };
    await handler('ai:chatStream')({ sender }, chatPayload());
    expect(sender.send).toHaveBeenCalledWith('ai:chunk:r1', expect.objectContaining({ type: 'error' }));
  });

  it('未配置 API Key 时拒绝', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: '' });
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
    expect(h.win.webContents.send).toHaveBeenCalledWith(
      'ai:chunk:r1',
      expect.objectContaining({ type: 'error', error: expect.stringContaining('API Key') }),
    );
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('SSE 分块转发到渲染层并单次 done', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: [DONE]\n\n',
      ),
    } as any);
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
    const sends = h.win.webContents.send.mock.calls.filter((c: any) => c[0] === 'ai:chunk:r1');
    expect(sends.filter((c: any) => c[1].type === 'chunk').map((c: any) => c[1].text)).toEqual(['你', '好']);
    expect(sends.filter((c: any) => c[1].type === 'done')).toHaveLength(1);
  });

  it('DeepSeek thinking 的 reasoning_content 以 thinking 事件转发', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'data: {"choices":[{"delta":{"reasoning_content":"推理"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
        'data: [DONE]\n\n',
      ),
    } as any);
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload({ isDeepThink: true }));
    const sends = h.win.webContents.send.mock.calls.filter((c: any) => c[0] === 'ai:chunk:r1');
    expect(sends.filter((c: any) => c[1].type === 'thinking').map((c: any) => c[1].text)).toEqual(['推理']);
    expect(sends.filter((c: any) => c[1].type === 'chunk').map((c: any) => c[1].text)).toEqual(['答案']);
  });

  it('流式末尾 usage 块以 usage 事件转发（含缓存命中）', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'data: {"choices":[{"delta":{"content":"答案"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_cache_hit_tokens":30,"prompt_cache_miss_tokens":20,"completion_tokens_details":{"reasoning_tokens":8}}}\n\n',
        'data: [DONE]\n\n',
      ),
    } as any);
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
    const sends = h.win.webContents.send.mock.calls.filter((c: any) => c[0] === 'ai:chunk:r1');
    expect(sends.find((c: any) => c[1].type === 'usage')?.[1].usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      reasoningTokens: 8,
      cacheHitTokens: 30,
      cacheMissTokens: 20,
    });
  });

  it('Chat 请求体包含 include_usage', async () => {
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('prefix 续写：追加 assistant 前缀消息并设置 stop', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse('data: {"choices":[{"delta":{"content":"more"}}]}\n\n', 'data: [DONE]\n\n'),
    } as any);
    await handler('ai:chatStream')(
      { sender: { send: vi.fn() } },
      chatPayload({
        prefix: { content: '```ts\nconst x = 1;', stop: ['```'] },
      }),
    );
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    const last = body.messages.at(-1);
    expect(last.role).toBe('assistant');
    expect(last.prefix).toBe(true);
    expect(last.content).toBe('```ts\nconst x = 1;');
    expect(body.stop).toEqual(['```']);
  });

  it('isDeepThink 时注入 thinking 参数', async () => {
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload({ isDeepThink: true }));
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('网络搜索开启时先检索再注入系统消息', async () => {
    vi.mocked(executeToolCall).mockResolvedValue({
      output: {
        results: [{ title: 'T', snippet: 'S', url: 'https://e.com' }],
      },
      error: undefined,
    });
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload({ isWebSearch: true }));
    expect(executeToolCall).toHaveBeenCalledWith('WebSearch', { query: '你好' }, expect.anything());
    const body = vi.mocked(axios.post).mock.calls[0][1] as any;
    expect(body.messages.at(-1).content).toContain('网络搜索结果');
  });

  it('中止流只发出一次 done', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce({ name: 'AbortError' });
    await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
    const done = h.win.webContents.send.mock.calls.filter((c: any) => c[1].type === 'done');
    expect(done).toHaveLength(1);
  });

  it('超时 / 401 / 429 / 带 JSON 详情的错误 / 网络错误分别映射', async () => {
    const cases: Array<[any, RegExp]> = [
      [{ code: 'ECONNABORTED', message: 'timeout' }, /请求超时/],
      [{ response: { status: 401 } }, /API Key 无效/],
      [{ response: { status: 429 } }, /请求过于频繁/],
      [{ response: { status: 402 } }, /余额不足/],
      [{ response: { status: 503 } }, /服务繁忙/],
      [{ response: { status: 500 } }, /服务器故障/],
      [{ response: { status: 422, statusText: 'x' } }, /API 错误 \(422\)/],
      [new Error('ECONNRESET'), /网络错误: ECONNRESET/],
    ];
    for (const [err, pattern] of cases) {
      vi.mocked(axios.post).mockRejectedValueOnce(err);
      h.win.webContents.send.mockClear();
      await handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
      const errorSend = h.win.webContents.send.mock.calls.find((c: any) => c[1].type === 'error');
      expect(errorSend?.[1].error).toMatch(pattern);
    }
  });
});

describe('ai:fim', () => {
  it('走 /completions 并返回补全文本', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { choices: [{ text: '  return fib(a-1) + fib(a-2)' }] },
    } as any);
    const result = await handler('ai:fim')(
      {},
      {
        model: 'deepseek-v4-pro',
        prompt: 'def fib(a):',
        suffix: ' return fib(a-1) + fib(a-2)',
      },
    );
    expect(result.ok).toBe(true);
    expect(result.data.text).toContain('return fib');
    const [url, body] = vi.mocked(axios.post).mock.calls.at(-1)! as any;
    expect(url).toMatch(/\/completions$/);
    expect(body.prompt).toBe('def fib(a):');
    expect(body.suffix).toContain('return fib');
  });

  it('未配置 API Key 时拒绝', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: '' });
    const result = await handler('ai:fim')({}, { model: 'deepseek-v4-pro', prompt: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('API Key');
  });
});

describe('ai:sendQuery / abortQuery / abortTool / retryTool', () => {
  const queryPayload = () => ({
    requestId: 'q1',
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '做点事' }],
    isDeepThink: false,
    projectRoot: 'C:/proj',
    surface: 'code' as const,
  });

  it('对话模式被后端隔离拒绝', async () => {
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, { ...queryPayload(), surface: 'chat' });
    expect(h.win.webContents.send).toHaveBeenCalledWith('ai:queryEvent:q1', expect.objectContaining({ type: 'error' }));
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('未配置 Key 拒绝', async () => {
    vi.mocked(readSettings).mockResolvedValue({ deepseekApiKey: '' });
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, queryPayload());
    expect(h.win.webContents.send).toHaveBeenCalledWith('ai:queryEvent:q1', expect.objectContaining({ type: 'error' }));
  });

  it('autoApprove 时权限回调恒真并运行查询', async () => {
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, { ...queryPayload(), autoApprove: true });
    const req = vi.mocked(runQuery).mock.calls[0][0] as any;
    expect(req.mode).toBe('ask');
    expect(req.sandboxMode).toBe('workspace-write');
    await expect(req.checkPermission('Bash', {})).resolves.toBe(true);
  });

  it('非 autoApprove 走 requestPermission，事件经 event-bridge 映射后发送', async () => {
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, queryPayload());
    const req = vi.mocked(runQuery).mock.calls[0][0] as any;
    await expect(req.checkPermission('Bash', {}, 'c1')).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledWith('Bash', {}, h.win, 'c1', expect.objectContaining({ mode: 'ask' }));

    vi.mocked(toToolStreamEvent).mockReturnValueOnce({ type: 'tool_start' } as any);
    const emit = vi.mocked(runQuery).mock.calls[0][1] as any;
    emit({ type: 'tool_start' });
    expect(h.win.webContents.send).toHaveBeenCalledWith('ai:queryEvent:q1', { type: 'tool_start' });
  });

  it('memoryContext 与 sessionId 透传给 runQuery', async () => {
    await handler('ai:sendQuery')(
      { sender: { send: vi.fn() } },
      { ...queryPayload(), sessionId: 'session-1', memoryContext: '## 项目记忆（带证据溯源，来自之前的会话）\nFACT' },
    );
    const req = vi.mocked(runQuery).mock.calls[0][0] as any;
    expect(req.sessionId).toBe('session-1');
    expect(req.memoryContext).toContain('## 项目记忆');
  });

  it('sandboxMode 来自设置并归一化', async () => {
    vi.mocked(readSettings).mockResolvedValue({ sandboxMode: 'read', deepseekApiKey: 'sk' });
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, queryPayload());
    expect((vi.mocked(runQuery).mock.calls[0][0] as any).sandboxMode).toBe('read');

    vi.mocked(readSettings).mockResolvedValue({ sandboxMode: 'bogus', deepseekApiKey: 'sk' });
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, queryPayload());
    expect((vi.mocked(runQuery).mock.calls[1][0] as any).sandboxMode).toBe('workspace-write');
  });

  it('查询失败向渲染层发送错误', async () => {
    vi.mocked(runQuery).mockRejectedValueOnce(new Error('boom'));
    await handler('ai:sendQuery')({ sender: { send: vi.fn() } }, queryPayload());
    expect(h.win.webContents.send).toHaveBeenCalledWith(
      'ai:queryEvent:q1',
      expect.objectContaining({ type: 'error', error: '查询失败: boom' }),
    );
  });

  it('retryTool 在活跃查询中入队，无活跃查询报错', async () => {
    expect(await handler('ai:retryTool')({}, 'nope', 'Bash')).toEqual({ ok: false, error: '无活跃查询' });

    let resolveRun: (v: any) => void = () => {};
    vi.mocked(runQuery).mockImplementation(() => new Promise((r) => (resolveRun = r)));
    const pending = handler('ai:sendQuery')({ sender: { send: vi.fn() } }, queryPayload());
    await new Promise((r) => setTimeout(r, 0));
    expect(await handler('ai:retryTool')({}, 'q1', 'Bash')).toEqual({ ok: true });
    const getPendingNudge = (vi.mocked(runQuery).mock.calls.at(-1)![0] as any).getPendingNudge;
    expect(getPendingNudge()).toContain('Bash');
    expect(getPendingNudge()).toBeNull();
    resolveRun(undefined);
    await pending;
  });

  it('abortTool 返回注册状态', async () => {
    expect(await handler('ai:abortTool')({}, 'q1', 'c1')).toEqual({ ok: true });
    vi.mocked(executeToolCall); // keep import alive for other tests
    const { abortTool } = await import('../tool-handlers');
    vi.mocked(abortTool).mockReturnValueOnce(false);
    expect(await handler('ai:abortTool')({}, 'q1', 'c2')).toEqual({ ok: false });
  });

  it('ai:clearQueryContext 作废规范上下文', async () => {
    await handler('ai:clearQueryContext')({}, 'session-1');
    expect(clearLlmContext).toHaveBeenCalledWith('session-1');
    expect(await handler('ai:clearQueryContext')({}, 'session-2')).toEqual({ ok: true });
  });
});

describe('ai:testConnection / cleanupWindowStreams', () => {
  it('连接成功返回模型列表', async () => {
    const r = await handler('ai:testConnection')({}, { apiKey: 'sk' });
    expect(r).toEqual({ ok: true, data: { message: expect.any(String), models: ['deepseek-v4-pro'] } });
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk' } }),
    );
  });

  it('401/429/网络错误映射', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 401 } });
    expect((await handler('ai:testConnection')({}, { apiKey: 'sk' })).error).toMatch(/无效或未授权/);
    vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 429 } });
    expect((await handler('ai:testConnection')({}, { apiKey: 'sk' })).error).toMatch(/过于频繁/);
    vi.mocked(axios.get).mockRejectedValueOnce({ code: 'ENOTFOUND' });
    expect((await handler('ai:testConnection')({}, { apiKey: 'sk' })).error).toMatch(/无法连接/);
  });

  it('错误体携带 JSON detail 时拼进文案', async () => {
    vi.mocked(readErrorBody).mockResolvedValueOnce('{"error":{"message":"bad request"}}');
    vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 400 } });
    const r = await handler('ai:testConnection')({}, { apiKey: 'sk' });
    expect(r.error).toContain('bad request');
  });

  it('清理活跃流并中止其信号', async () => {
    let resolvePost: (v: any) => void = () => {};
    vi.mocked(axios.post).mockReturnValueOnce(new Promise((r) => (resolvePost = r)));
    const p = handler('ai:chatStream')({ sender: { send: vi.fn() } }, chatPayload());
    await vi.waitFor(() => expect(vi.mocked(axios.post).mock.calls).toHaveLength(1));
    cleanupWindowStreams();
    const call = vi.mocked(axios.post).mock.calls[0] as any;
    const signal = call[2].signal;
    expect(signal.aborted).toBe(true);
    resolvePost({ data: sse('data: [DONE]\n\n') });
    await p;
  });
});
