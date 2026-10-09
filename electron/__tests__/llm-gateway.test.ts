/**
 * llm-gateway.test.ts — LLM 横切面（限流 / 成本 / 健康）。
 *
 * 重点在**不编造**与**不误判**：
 *   1. 未收录价目表的模型，成本必须是 null + unpricedCalls，而不是 0（0 看起来像"免费"）；
 *   2. 失败必须被记成失败（不能因为"没抛错就算成功"而算进成本）；
 *   3. 令牌桶的时间推进与等待量要能被精确断言，不依赖真实定时器；
 *   4. 默认不限流时，任何调用都不该被延迟。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beginLlmCall,
  costOf,
  llmGatewaySnapshot,
  llmRateLimitRpm,
  refillBucket,
  resetLlmGatewayForTest,
  setModelPricing,
  withLlmGateway,
} from '../agent-runtime/llm-gateway';
import { invokeLlm, registerLlmAdapter } from '../agent-runtime/llm-adapter';

const MODEL = 'test-model-x';
const signal = new AbortController().signal;

beforeEach(() => resetLlmGatewayForTest());

afterEach(() => {
  delete process.env.AURAXIS_LLM_RPM;
  delete process.env.AURAXIS_MODEL_PRICING;
  resetLlmGatewayForTest();
});

describe('计价', () => {
  it('价目表为空时成本是 null，并单独计数 unpriced', () => {
    expect(costOf(MODEL, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
    const handle = beginLlmCall(MODEL);
    handle.usage({ inputTokens: 1000, outputTokens: 2000 });
    handle.succeeded();

    const entry = llmGatewaySnapshot().ledger.find((e) => e.model === MODEL)!;
    expect(entry.costUsd).toBeNull();
    expect(entry.unpricedCalls).toBe(1);
    // 用量仍然照记 —— 成本未知不代表用量未知。
    expect(entry.inputTokens).toBe(1000);
    expect(entry.outputTokens).toBe(2000);
  });

  it('精确匹配计价：输入/输出分别按各自单价折算', () => {
    setModelPricing({ [MODEL]: { inputPerMillion: 1, outputPerMillion: 4 } });
    const handle = beginLlmCall(MODEL);
    handle.usage({ inputTokens: 500_000, outputTokens: 250_000 });
    handle.succeeded();
    expect(llmGatewaySnapshot().ledger[0].costUsd).toBeCloseTo(0.5 + 1, 6);
  });

  it('不做前缀匹配：pro 的调用不会被按基础款计价', () => {
    setModelPricing({ 'test-model': { inputPerMillion: 1, outputPerMillion: 1 } });
    expect(costOf(MODEL, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it('非法价目表项被忽略，不会写出 NaN 成本', () => {
    setModelPricing({ [MODEL]: { inputPerMillion: Number.NaN, outputPerMillion: 1 } as any });
    expect(costOf(MODEL, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it('AURAXIS_MODEL_PRICING 惰性生效；非法 JSON 退化为未计价而不是抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.AURAXIS_MODEL_PRICING = JSON.stringify({ [MODEL]: { inputPerMillion: 2, outputPerMillion: 8 } });
      expect(costOf(MODEL, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2, 6);

      process.env.AURAXIS_MODEL_PRICING = '{不是 JSON';
      expect(costOf(MODEL, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();

      // 显式设置优先于环境变量：代码里的口径就是最终口径。
      process.env.AURAXIS_MODEL_PRICING = JSON.stringify({
        [MODEL]: { inputPerMillion: 1000, outputPerMillion: 1000 },
      });
      setModelPricing({ [MODEL]: { inputPerMillion: 1, outputPerMillion: 0 } });
      expect(costOf(MODEL, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1, 6);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('健康', () => {
  it('失败被记成失败且不计入 token / 成本', () => {
    setModelPricing({ [MODEL]: { inputPerMillion: 10, outputPerMillion: 10 } });
    const handle = beginLlmCall(MODEL);
    handle.usage({ inputTokens: 9999, outputTokens: 9999 });
    handle.failed(new Error('429 rate limited'));

    const snap = llmGatewaySnapshot();
    const entry = snap.ledger[0];
    expect(entry.failures).toBe(1);
    expect(entry.costUsd).toBe(0);
    expect(entry.inputTokens).toBe(0);
    expect(snap.health[0]).toMatchObject({
      model: MODEL,
      failures: 1,
      consecutiveFailures: 1,
      lastError: '429 rate limited',
    });
  });

  it('成功后连续失败计数清零', () => {
    beginLlmCall(MODEL).failed(new Error('boom'));
    const ok = beginLlmCall(MODEL);
    ok.succeeded();
    expect(llmGatewaySnapshot().health[0]).toMatchObject({ calls: 2, failures: 1, consecutiveFailures: 0 });
    expect(llmGatewaySnapshot().health[0].lastSuccessAt).not.toBeNull();
  });

  it('句柄只结算一次：重复 succeeded / failed 不重复计数', () => {
    const handle = beginLlmCall(MODEL);
    handle.succeeded();
    handle.succeeded();
    handle.failed(new Error('late'));
    expect(llmGatewaySnapshot().ledger[0]).toMatchObject({ calls: 1, failures: 0 });
    expect(llmGatewaySnapshot().inFlight).toBe(0);
  });

  it('用量分次上报取各字段最大值，不重复累加', () => {
    const handle = beginLlmCall(MODEL);
    handle.usage({ inputTokens: 100, outputTokens: 10 });
    handle.usage({ inputTokens: 100, outputTokens: 250 });
    handle.succeeded();
    expect(llmGatewaySnapshot().ledger[0]).toMatchObject({ inputTokens: 100, outputTokens: 250 });
  });
});

describe('接入 invokeLlm（唯一 LLM 出口）', () => {
  it('适配器上报的用量进账本，同时**照旧**转发给调用方的 onUsage', async () => {
    const seen: number[] = [];
    registerLlmAdapter('gw-test', async (params) => {
      params.onUsage?.({ inputTokens: 120, outputTokens: 34 });
      return {
        contentTimeline: [],
        toolCalls: [],
        rawText: 'ok',
        isFinal: true,
        completionStopReason: 'end_turn',
      };
    });
    await invokeLlm({
      model: MODEL,
      apiKey: 'k',
      apiBase: 'http://x',
      systemPrompt: 's',
      messages: [],
      tools: [],
      signal,
      adapter: 'gw-test',
      sessionId: 'sess-1',
      onUsage: (u) => seen.push(u.inputTokens),
    });

    // 两条都不能少：网关记账不能把调用方原有的用量回调吃掉。
    expect(seen).toEqual([120]);
    expect(llmGatewaySnapshot().ledger[0]).toMatchObject({
      model: MODEL,
      sessionId: 'sess-1',
      inputTokens: 120,
      outputTokens: 34,
    });
  });

  it('适配器抛错时记成失败并原样抛出', async () => {
    registerLlmAdapter('gw-fail', async () => {
      throw new Error('provider 500');
    });
    await expect(
      invokeLlm({
        model: MODEL,
        apiKey: 'k',
        apiBase: 'http://x',
        systemPrompt: 's',
        messages: [],
        tools: [],
        signal,
        adapter: 'gw-fail',
      }),
    ).rejects.toThrow('provider 500');
    expect(llmGatewaySnapshot().ledger[0]).toMatchObject({ failures: 1, sessionId: null });
    expect(llmGatewaySnapshot().health[0]).toMatchObject({ consecutiveFailures: 1, lastError: 'provider 500' });
  });

  it('同一模型在不同会话下分账', () => {
    const a = beginLlmCall(MODEL, 'sess-a');
    a.usage({ inputTokens: 10, outputTokens: 1 });
    a.succeeded();
    const b = beginLlmCall(MODEL, 'sess-b');
    b.usage({ inputTokens: 20, outputTokens: 2 });
    b.succeeded();
    const ledger = llmGatewaySnapshot().ledger;
    expect(ledger).toHaveLength(2);
    expect(ledger.map((e) => [e.sessionId, e.inputTokens])).toEqual([
      ['sess-a', 10],
      ['sess-b', 20],
    ]);
  });
});

describe('令牌桶', () => {
  it('首次调用立即通过（不预借突发额度）', () => {
    expect(refillBucket(undefined, 60, 1000)).toEqual({ tokens: 0, updatedAt: 1000, waitMs: 0 });
  });

  it('桶空时算出等待时间，且不倒退配额', () => {
    const empty = { tokens: 0, updatedAt: 1000 };
    // 60 rpm = 每 1000ms 回填 1 个
    const next = refillBucket(empty, 60, 1100);
    expect(next.waitMs).toBeGreaterThan(0);
    expect(next.waitMs).toBeLessThanOrEqual(1000);
    expect(next.tokens).toBe(0);
  });

  it('容量为 1：长期空闲也不会攒出突发额度', () => {
    const idle = { tokens: 1, updatedAt: 0 };
    const refilled = refillBucket(idle, 60, 600_000);
    expect(refilled.tokens).toBe(0); // 只有一个额度，用掉即空
    expect(refilled.waitMs).toBe(0);
  });

  it('默认不限流：调用立即返回，不引入任何等待', async () => {
    expect(llmRateLimitRpm()).toBeNull();
    const started = Date.now();
    await withLlmGateway(MODEL, signal, async () => 'ok');
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('开启限流后超额的调用会被推迟（而不是失败）', async () => {
    process.env.AURAXIS_LLM_RPM = '600'; // 每 100ms 一个
    const started = Date.now();
    for (let i = 0; i < 3; i++) await withLlmGateway(MODEL, signal, async () => i);
    // 第 2、3 次各等约 100ms；断言"确实等了"而不是具体毫秒，避免时钟抖动误判。
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(llmGatewaySnapshot().rateLimitRpm).toBe(600);
  });

  it('等待配额期间被取消 → AbortError，且不产生调用记录', async () => {
    process.env.AURAXIS_LLM_RPM = '1'; // 一分钟一个，第二次必然要等
    await withLlmGateway(MODEL, signal, async () => 'first');
    const ctrl = new AbortController();
    const pending = withLlmGateway(MODEL, ctrl.signal, async () => 'second');
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // 第二次调用根本没发出去，不该记进 ledger。
    expect(llmGatewaySnapshot().ledger[0].calls).toBe(1);
  });
});
