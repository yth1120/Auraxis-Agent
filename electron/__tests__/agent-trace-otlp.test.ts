/**
 * agent-trace-otlp.test.ts — 轨迹 → OTLP span 的映射与投递契约。
 *
 * 两件事分别钉住：
 *   1. 纯映射（`toOtlpSpans` / `buildOtlpPayload`）：只映射有真实采集源的四类 span，
 *      id 稳定可复现，父子关系正确，失败状态如实上报。
 *   2. 投递（`exportAgentTraceOtlp`）：默认关闭、按 endpoint 开启、失败吞掉不影响主流程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '3.4.0' } }));
vi.mock('axios', () => ({ default: { post: vi.fn(async () => ({ status: 200 })) } }));

import axios from 'axios';
import { buildOtlpPayload, exportAgentTraceOtlp, readOtlpConfig, toOtlpSpans } from '../agent-trace-otlp';
import type { AgentTraceRun } from '../contracts/agent-trace';

function run(overrides: Partial<AgentTraceRun> = {}): AgentTraceRun {
  return {
    sessionId: 'sess-1',
    title: '修一个 bug',
    status: 'completed',
    startedAt: 1_000,
    endedAt: 2_000,
    goal: '修好它',
    turns: [
      { id: 't1', index: 1, startedAt: 1_000, endedAt: 1_500, toolCallIds: ['c1'] },
      { id: 't2', index: 2, startedAt: 1_500, endedAt: 2_000, toolCallIds: [] },
    ],
    toolCalls: [
      { id: 'c1', name: 'Read', status: 'done', startedAt: 1_100, endedAt: 1_200, durationMs: 100 },
      { id: 'c2', name: 'Bash', status: 'error', startedAt: 1_600, error: 'boom' },
    ],
    approvals: [{ id: 'a1', toolName: 'Bash', at: 1_550, status: 'granted' }],
    subAgents: [{ id: 'sub1', name: 'Explore', status: 'done', at: 1_700 }],
    stats: {
      turns: 2,
      toolCalls: 2,
      failedToolCalls: 1,
      approvals: 1,
      subAgents: 1,
      iterations: 3,
      repeatedToolRuns: 0,
    },
    ...overrides,
  };
}

const HEX = /^[0-9a-f]+$/;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(axios.post).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('toOtlpSpans — 映射规则', () => {
  it('产出根 span + turn + tool + subagent，id 为合法长度的十六进制且可复现', () => {
    const spans = toOtlpSpans(run(), { serviceName: 'auraxis' });
    // 1 根 + 2 turn + 2 tool + 1 subagent
    expect(spans).toHaveLength(6);

    const root = spans[0];
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toHaveLength(32);
    expect(root.spanId).toHaveLength(16);
    expect(root.traceId).toMatch(HEX);
    expect(root.spanId).toMatch(HEX);
    expect(root.name).toBe('修一个 bug');

    // 同一输入重复映射必须完全一致（同一次运行多次导出可对照）。
    expect(toOtlpSpans(run(), { serviceName: 'auraxis' })).toEqual(spans);

    // 纳秒换算：1000ms → 1e12 ns
    expect(root.startTimeUnixNano).toBe(String(1_000 * 1_000_000));
    expect(root.endTimeUnixNano).toBe(String(2_000 * 1_000_000));
  });

  it('tool span 挂到声明它的 turn 下；未归属的挂根 span', () => {
    const spans = toOtlpSpans(run(), { serviceName: 'auraxis' });
    const byKind = (kind: string) =>
      spans.filter((s) => s.attributes.some((a) => a.key === 'auraxis.span.kind' && a.value.stringValue === kind));

    const turnSpan = byKind('turn').find((s) => s.name === 'turn 1')!;
    const tool = byKind('tool').find((s) => s.name === 'tool Read')!;
    // c1 由 turn t1 声明 → 父 span 是该 turn
    expect(tool.parentSpanId).toBe(turnSpan.spanId);

    // c2 不在任何 turn 的 toolCallIds 里 → 退化为挂在根 span 下
    const orphan = byKind('tool').find((s) => s.name === 'tool Bash')!;
    expect(orphan.parentSpanId).toBe(spans[0].spanId);
  });

  it('状态映射：失败 → ERROR 带原因，成功 → OK，运行中 → 未设置', () => {
    const failed = toOtlpSpans(run({ status: 'failed', error: '上下文超限' }), { serviceName: 'a' });
    expect(failed[0].status).toEqual({ code: 2, message: '上下文超限' });

    // 工具级：error 的工具 span 为 ERROR，done 的为 OK
    const bash = failed.find((s) => s.name === 'tool Bash')!;
    expect(bash.status).toEqual({ code: 2, message: 'boom' });
    expect(failed.find((s) => s.name === 'tool Read')!.status).toEqual({ code: 1 });

    expect(toOtlpSpans(run(), { serviceName: 'a' })[0].status).toEqual({ code: 1 });
    expect(toOtlpSpans(run({ status: 'running' }), { serviceName: 'a' })[0].status).toEqual({ code: 0 });
    // 停止不算失败
    expect(toOtlpSpans(run({ status: 'stopped' }), { serviceName: 'a' })[0].status).toEqual({ code: 1 });
  });

  it('审批作为根 span 属性记录（不是独立时间段）', () => {
    const spans = toOtlpSpans(run(), { serviceName: 'auraxis' });
    const root = spans[0];
    const keys = root.attributes.map((a) => a.key);
    expect(keys).toContain('approval.a1.tool');
    expect(keys).toContain('approval.a1.status');
    expect(keys).toContain('approval.a1.at');
    // 审批没有生成 span
    expect(spans.filter((s) => s.name.includes('a1'))).toHaveLength(0);
  });

  // 刻意的不作为：契约里没有逐次模型调用的耗时/token，凭空造 llm span 属于自欺。
  it('不生成 llm span（轨迹契约里没有对应采集源）', () => {
    const kinds = toOtlpSpans(run(), { serviceName: 'auraxis' }).map(
      (s) => s.attributes.find((a) => a.key === 'auraxis.span.kind')?.value.stringValue,
    );
    expect(kinds).not.toContain('llm');
    expect(new Set(kinds)).toEqual(new Set(['run', 'turn', 'tool', 'subagent']));
  });

  it('显式 traceId 覆盖派生值；空字符串属性不落进 attributes', () => {
    const spans = toOtlpSpans(run({ goal: '', error: '' }), { serviceName: 'a', traceId: 'f'.repeat(32) });
    expect(spans[0].traceId).toBe('f'.repeat(32));
    const keys = spans[0].attributes.map((a) => a.key);
    // 空串等同于缺省：不该产出一个空值属性。
    expect(keys).not.toContain('agent.goal');
    expect(keys).not.toContain('agent.error');
  });

  it('失败但没有 error 文案时仍是 ERROR（无 message）', () => {
    const spans = toOtlpSpans(run({ status: 'failed', error: undefined }), { serviceName: 'a' });
    expect(spans[0].status).toEqual({ code: 2 });
  });

  it('turn 缺 endedAt 时退化为 startedAt（零长度 span 而不是 NaN）', () => {
    const spans = toOtlpSpans(run({ turns: [{ id: 't1', index: 1, startedAt: 1_234, toolCallIds: [] }] }), {
      serviceName: 'a',
    });
    const turn = spans.find((s) => s.name === 'turn 1')!;
    expect(turn.startTimeUnixNano).toBe(String(1_234 * 1_000_000));
    expect(turn.endTimeUnixNano).toBe(turn.startTimeUnixNano);
  });

  it('根 span 统计属性来自 stats', () => {
    const root = toOtlpSpans(run(), { serviceName: 'auraxis' })[0];
    const value = (key: string) => root.attributes.find((a) => a.key === key)?.value.intValue;
    expect(value('agent.turns')).toBe('2');
    expect(value('agent.failed_tool_calls')).toBe('1');
    expect(value('agent.iterations')).toBe('3');
  });
});

describe('readOtlpConfig — 默认关闭', () => {
  it('未设置 endpoint 时返回 null', () => {
    expect(readOtlpConfig({})).toBeNull();
    expect(readOtlpConfig({ AURAXIS_OTLP_ENDPOINT: '   ' })).toBeNull();
  });

  it('serviceName 为空串时回退到 auraxis；headers 空串得到空对象', () => {
    expect(readOtlpConfig({ AURAXIS_OTLP_ENDPOINT: 'http://c/v1/traces', AURAXIS_OTLP_SERVICE_NAME: '  ' })).toEqual({
      endpoint: 'http://c/v1/traces',
      serviceName: 'auraxis',
    });
    // 全是坏片段 → 没有 headers 字段（而不是空对象）。
    expect(
      readOtlpConfig({ AURAXIS_OTLP_ENDPOINT: 'http://c/v1/traces', AURAXIS_OTLP_HEADERS: ',broken,=x' }),
    ).not.toHaveProperty('headers');
  });

  it('解析 endpoint / serviceName / headers，缺省 serviceName 为 auraxis', () => {
    expect(readOtlpConfig({ AURAXIS_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces' })).toEqual({
      endpoint: 'http://localhost:4318/v1/traces',
      serviceName: 'auraxis',
    });
    expect(
      readOtlpConfig({
        AURAXIS_OTLP_ENDPOINT: 'http://c/v1/traces',
        AURAXIS_OTLP_SERVICE_NAME: 'my-app',
        AURAXIS_OTLP_HEADERS: 'authorization=Bearer x, x-tenant = acme ,broken',
      }),
    ).toEqual({
      endpoint: 'http://c/v1/traces',
      serviceName: 'my-app',
      headers: { authorization: 'Bearer x', 'x-tenant': 'acme' },
    });
  });
});

describe('buildOtlpPayload — resourceSpans 结构', () => {
  it('service.name 与 scope 版本写入载荷', () => {
    const payload = buildOtlpPayload(toOtlpSpans(run(), { serviceName: 'x' }), 'svc', '9.9.9') as any;
    expect(payload.resourceSpans[0].resource.attributes[0]).toEqual({
      key: 'service.name',
      value: { stringValue: 'svc' },
    });
    expect(payload.resourceSpans[0].scopeSpans[0].scope).toEqual({ name: 'auraxis.agent-trace', version: '9.9.9' });
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(6);
  });
});

describe('exportAgentTraceOtlp — 投递', () => {
  it('未配置 endpoint 时完全不发请求', async () => {
    vi.stubEnv('AURAXIS_OTLP_ENDPOINT', '');
    await exportAgentTraceOtlp(run());
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('配置后 POST 到 endpoint 并带上自定义头', async () => {
    vi.stubEnv('AURAXIS_OTLP_ENDPOINT', 'http://collector:4318/v1/traces');
    vi.stubEnv('AURAXIS_OTLP_HEADERS', 'x-tenant=acme');
    await exportAgentTraceOtlp(run());

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = vi.mocked(axios.post).mock.calls[0] as [string, any, any];
    expect(url).toBe('http://collector:4318/v1/traces');
    expect(config.headers).toMatchObject({ 'Content-Type': 'application/json', 'x-tenant': 'acme' });
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(6);
  });

  // 遥测不得影响主流程：投递失败必须被吞掉且只记日志。
  it('投递失败不抛出，只记日志', async () => {
    vi.stubEnv('AURAXIS_OTLP_ENDPOINT', 'http://collector:4318/v1/traces');
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('collector down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(exportAgentTraceOtlp(run())).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('collector down'));

    spy.mockRestore();
  });
});
