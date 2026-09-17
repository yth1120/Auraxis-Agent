/**
 * Chat 路径契约（渲染层直连版）。
 *
 * Chat 有两条 SSE 解析实现：主进程的 `streamDeepSeek`（走 IPC）与渲染层兜底的
 * `streamChat`（`src/services/ai-service.ts`）。两边必须把同一段 SSE 解析成同样的
 * 文本/思考序列，否则"离线兜底"会与正常路径表现不一致。
 *
 * 这里冻结一组规范样本；electron 侧的 `llm-adapter.test.ts` 用同样的样本断言
 * 主进程路径（见该文件 "SSE 契约样本" 用例）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../stores/useSettingsStore', () => ({
  getApiKeyFromStore: () => 'test-key',
}));

import { streamChat } from '../ai-service';

/** 与 electron/ipc/__tests__/llm-adapter.test.ts 中同名用例保持一致。 */
const SSE_CONTRACT = {
  lines: [
    'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"再想"}}]}',
    'data: {"choices":[{"delta":{"content":"你好"}}]}',
    'data: {"choices":[{"delta":{"content":"，世界"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
    'data: [DONE]',
  ],
  expectText: '你好，世界',
  expectThinking: '先想再想',
};

function fetchWithSse(lines: string[]): void {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 })),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  if (typeof requestAnimationFrame === 'undefined') {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as never);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  }
});

describe('streamChat SSE 契约样本', () => {
  it('同一段 SSE 得到相同的文本与思考序列', async () => {
    fetchWithSse(SSE_CONTRACT.lines);
    let text = '';
    let thinking = '';
    await streamChat(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }] as never,
        isDeepThink: true,
        isWebSearch: false,
      },
      (chunk) => {
        text += chunk;
      },
      undefined,
      (chunk) => {
        thinking += chunk;
      },
    );
    expect(text).toBe(SSE_CONTRACT.expectText);
    expect(thinking).toBe(SSE_CONTRACT.expectThinking);
  });

  it('请求体：非思考模式必须显式关闭 thinking（官方默认开启）', async () => {
    fetchWithSse(['data: [DONE]']);
    await streamChat(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }] as never,
        isDeepThink: false,
        isWebSearch: false,
      },
      () => {},
    );
    const calls = vi.mocked(global.fetch).mock.calls as unknown as Array<[string, { body: string }]>;
    const body = JSON.parse(calls.at(-1)![1].body);
    // 渲染层兜底路径此前只是"不发送 thinking"，等于默认开启思考；这里锁死显式关闭。
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});
