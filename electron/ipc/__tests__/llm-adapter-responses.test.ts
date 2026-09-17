/**
 * Responses API 适配器（Codex 类客户端格式）。
 *
 * 事件样本按官方文档 + 真实接口探测结果构造：
 * event: response.output_text.delta / response.reasoning_text.delta /
 * response.output_item.done(function_call) / response.completed(usage)，
 * 且**没有 `data: [DONE]`**。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

import { llmClientInvoke } from '../../agent-runtime/llm-adapter';
import { installAgentRuntimePorts } from '../runtime-ports';

installAgentRuntimePorts();

async function* sse(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p, 'utf8');
}

const baseParams = () => ({
  model: 'deepseek-flash',
  apiKey: 'key',
  apiBase: 'https://api.deepseek.com/responses',
  systemPrompt: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
});

describe('Responses API 适配器', () => {
  it('解析文本 + 思考增量，并以 response.completed 收尾（无 [DONE]）', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"先想"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"世界"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
      ),
    } as never);
    const thinking: string[] = [];
    const usage: unknown[] = [];
    const out = await llmClientInvoke({
      ...baseParams(),
      isDeepThink: true,
      onThinkingChunk: (c: string) => thinking.push(c),
      onUsage: (u: unknown) => usage.push(u),
    } as never);
    expect(out!.rawText).toBe('你好世界');
    expect(out!.thinkingText).toBe('先想');
    expect(out!.isFinal).toBe(true);
    expect(thinking).toEqual(['先想']);
    expect(usage[0]).toMatchObject({ inputTokens: 12, outputTokens: 5, reasoningTokens: 3 });
  });

  it('function_call item → toolCalls，且思考档位按 none 关闭', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc1","call_id":"call_1","name":"get_time","arguments":"{\\"city\\":\\"北京\\"}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ),
    } as never);
    const out = await llmClientInvoke({ ...baseParams(), isDeepThink: false } as never);
    expect(out!.toolCalls).toEqual([{ id: 'call_1', name: 'get_time', input: { city: '北京' } }]);
    expect(out!.isFinal).toBe(false);
    const body = vi.mocked(axios.post).mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBeGreaterThan(0);
  });

  it('request 形状：instructions / input / 扁平 tools / effort', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'),
    } as never);
    await llmClientInvoke({
      ...baseParams(),
      messages: [
        { role: 'system', content: 'sys-prompt' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ name: 'Read', description: 'd', isConcurrencySafe: true, input_schema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } }],
      isDeepThink: true,
      reasoningEffort: 'max',
    } as never);
    const [url, body] = vi.mocked(axios.post).mock.calls.at(-1)! as [string, Record<string, never>];
    expect(url).toBe('https://api.deepseek.com/responses');
    expect(body.instructions).toBe('sys-prompt');
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'Read' });
    expect(body.reasoning).toEqual({ effort: 'max' });
  });

  it('response.failed → 抛出可读错误', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: sse(
        'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":"bad request detail"}}}\n\n',
      ),
    } as never);
    await expect(llmClientInvoke(baseParams() as never)).rejects.toThrow(/bad request detail/);
  });
});
