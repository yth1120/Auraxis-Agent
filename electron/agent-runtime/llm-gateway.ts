/**
 * llm-gateway.ts — LLM 调用的横切面：速率限制、成本计价、provider 健康。
 *
 * **为什么挂在这里**：`invokeLlm` 是全应用唯一的 LLM 出口（Agent 循环、规划、Replan、
 * 会话标题、记忆抽取、上下文压缩全部经过它）。横切关切只有挂在这个位置才不会漏。
 *
 * 三件事的定位不同，别把它们混成一种机制：
 *   · **速率限制**（默认关闭，`AURAXIS_LLM_RPM`）：保护性。开启后**只会等，不会让请求
 *     失败** —— 一个会在高峰时中断 Agent 运行的限流器，比没有限流更糟。
 *   · **成本**（常开）：观测性，纯累加。价目表**默认是空的**：没有收录的模型计为
 *     未计价，而不是猜一个价格。编出来的成本数字比没有数字危险得多。
 *   · **provider 健康**（常开）：观测性，只记录不外推。**刻意不做自动熔断** ——
 *     引擎已经有重试 + fallbackModel 两级降级，再叠一套熔断会让"为什么这次没调用"
 *     变得极难回答。健康数据给人和上层策略看，不自己动手。
 *
 * 本模块是纯引擎：不得 import `electron/ipc/**`（守卫 `check:runtime-boundary`）。
 */

export interface LlmUsageSample {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
}

/** 每百万 token 的价格（USD）。 */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface LlmModelLedger {
  model: string;
  /** 来源会话；调用方没带 sessionId 时为 null（归到「无会话」一档）。 */
  sessionId: string | null;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  /** 计价未知时为 null —— 宁可不显示，也不要编一个数字。 */
  costUsd: number | null;
  /** 价目表里没有这个模型的调用次数（成本因此不完整，必须显示出来）。 */
  unpricedCalls: number;
}

export interface LlmModelHealth {
  model: string;
  calls: number;
  failures: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
}

export interface LlmGatewaySnapshot {
  ledger: LlmModelLedger[];
  health: LlmModelHealth[];
  /** 当前生效的限流（每分钟请求数）；未启用为 null。 */
  rateLimitRpm: number | null;
  /** 正在等待配额或正在请求中的调用数。 */
  inFlight: number;
}

type LedgerState = LlmModelLedger;

interface HealthState {
  model: string;
  calls: number;
  failures: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastLatencyMs: number | null;
  totalLatencyMs: number;
}

const ledger = new Map<string, LedgerState>();
const health = new Map<string, HealthState>();
const buckets = new Map<string, { tokens: number; updatedAt: number }>();
let pricing: Record<string, ModelPrice> = {};
let inFlight = 0;

// ─── 配置 ──────────────────────────────────────────────

/**
 * 设置价目表。**精确匹配模型 id，不做前缀/通配** —— 金额上的"猜"比缺省更糟，
 * 前缀匹配会让 `xxx-pro` 的调用悄悄按 `xxx` 的价格记账。
 */
export function setModelPricing(table: Record<string, ModelPrice>): void {
  pricing = {};
  for (const [model, price] of Object.entries(table || {})) {
    if (!price) continue;
    const inputPerMillion = Number(price.inputPerMillion);
    const outputPerMillion = Number(price.outputPerMillion);
    if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) continue;
    pricing[model] = { inputPerMillion, outputPerMillion };
  }
}

/**
 * `AURAXIS_MODEL_PRICING` 解析结果，**按原始字符串惰性缓存**。
 *
 * 惰性而不是启动时装载：本仓库的其它开关（如 `embeddingsEnabled`）一律在调用点读
 * `process.env`，加载 .env 的时机不在本模块的控制范围内。按原始值缓存既能在 env 变化
 * 后自动失效，又不会因为每次计价都 JSON.parse（或重复打告警）而浪费。
 */
let envPricingRaw: string | null = null;
let envPricingCache: Record<string, ModelPrice> = {};

function pricingFromEnv(): Record<string, ModelPrice> {
  const raw = (process.env.AURAXIS_MODEL_PRICING || '').trim();
  if (raw === envPricingRaw) return envPricingCache;
  envPricingRaw = raw;
  if (!raw) {
    envPricingCache = {};
    return envPricingCache;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    const next: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
      const inputPerMillion = Number((price as ModelPrice)?.inputPerMillion);
      const outputPerMillion = Number((price as ModelPrice)?.outputPerMillion);
      if (Number.isFinite(inputPerMillion) && Number.isFinite(outputPerMillion)) {
        next[model] = { inputPerMillion, outputPerMillion };
      }
    }
    envPricingCache = next;
  } catch (err) {
    console.warn('[llm-gateway] AURAXIS_MODEL_PRICING 不是合法 JSON，按「未计价」处理:', err);
    envPricingCache = {};
  }
  return envPricingCache;
}

/** 每分钟请求上限；未设置或非法值表示不限流。 */
export function llmRateLimitRpm(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = Number((env.AURAXIS_LLM_RPM || '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** 显式设置的价目表优先于环境变量（代码里设的就是最终口径）。 */
function priceOf(model: string): ModelPrice | null {
  return pricing[model] ?? pricingFromEnv()[model] ?? null;
}

/** 单次调用的成本；未收录计价返回 null。 */
export function costOf(model: string, usage: LlmUsageSample): number | null {
  const price = priceOf(model);
  if (!price) return null;
  return (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000;
}

// ─── 限流 ──────────────────────────────────────────────

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError('LLM 调用在等待速率配额时被取消'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError('LLM 调用在等待速率配额时被取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 取一个配额：令牌桶按分钟匀速回填，桶空时**等待**而不是拒绝。
 *
 * **容量刻意设为 1（不允许突发）**：`AURAXIS_LLM_RPM=600` 的朴素读法是「每分钟最多
 * 600 次」，而不是「先一口气发 600 次再停一分钟」。突发额度在 API 限额下没有好处，
 * 却会让"限流开着却仍然撞 429"这种结果出现，非常难解释。
 *
 * 纯函数化的桶状态更新单独导出，便于对时间推进做精确断言，不必依赖真实定时器。
 */
export function refillBucket(
  state: { tokens: number; updatedAt: number } | undefined,
  rpm: number,
  now: number,
): { tokens: number; updatedAt: number; waitMs: number } {
  if (!state) return { tokens: 0, updatedAt: now, waitMs: 0 };
  const elapsed = Math.max(0, now - state.updatedAt);
  const tokens = Math.min(1, state.tokens + (elapsed * rpm) / 60_000);
  if (tokens >= 1) return { tokens: tokens - 1, updatedAt: now, waitMs: 0 };
  const waitMs = Math.ceil(((1 - tokens) * 60_000) / rpm);
  return { tokens: 0, updatedAt: now + waitMs, waitMs };
}

async function acquireSlot(model: string, signal: AbortSignal): Promise<void> {
  const rpm = llmRateLimitRpm();
  if (!rpm) return;
  const state = refillBucket(buckets.get(model), rpm, Date.now());
  buckets.set(model, { tokens: state.tokens, updatedAt: state.updatedAt });
  if (state.waitMs > 0) await sleep(state.waitMs, signal);
}

// ─── 每次调用的记账句柄 ────────────────────────────────

export interface LlmCallHandle {
  /** 用量回填。可被调用多次（流式实现可能分次上报），按各字段取最大值，不累加。 */
  usage(sample: LlmUsageSample): void;
  succeeded(): void;
  failed(error: unknown): void;
}

function ledgerKey(sessionId: string | null, model: string): string {
  return `${sessionId ?? ''}\u0000${model}`;
}

function ledgerFor(sessionId: string | null, model: string): LedgerState {
  const key = ledgerKey(sessionId, model);
  let entry = ledger.get(key);
  if (!entry) {
    entry = {
      model,
      sessionId,
      calls: 0,
      failures: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      costUsd: priceOf(model) ? 0 : null,
      unpricedCalls: 0,
    };
    ledger.set(key, entry);
  }
  return entry;
}

function healthFor(model: string): HealthState {
  let entry = health.get(model);
  if (!entry) {
    entry = {
      model,
      calls: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
      lastLatencyMs: null,
      totalLatencyMs: 0,
    };
    health.set(model, entry);
  }
  return entry;
}

/** 记一次调用开始。返回的句柄必须被 succeeded/failed 终结（否则健康统计会缺一笔）。 */
export function beginLlmCall(model: string, sessionId?: string | null): LlmCallHandle {
  const startedAt = Date.now();
  const entry = ledgerFor(sessionId ?? null, model);
  const state = healthFor(model);
  entry.calls += 1;
  state.calls += 1;
  inFlight += 1;
  const best: LlmUsageSample = { inputTokens: 0, outputTokens: 0 };
  let settled = false;

  return {
    usage(sample) {
      best.inputTokens = Math.max(best.inputTokens, sample?.inputTokens ?? 0);
      best.outputTokens = Math.max(best.outputTokens, sample?.outputTokens ?? 0);
      if (sample?.cacheHitTokens) best.cacheHitTokens = Math.max(best.cacheHitTokens ?? 0, sample.cacheHitTokens);
      if (sample?.reasoningTokens) best.reasoningTokens = Math.max(best.reasoningTokens ?? 0, sample.reasoningTokens);
    },
    succeeded() {
      if (settled) return;
      settled = true;
      inFlight -= 1;
      const latency = Date.now() - startedAt;
      state.consecutiveFailures = 0;
      state.lastSuccessAt = Date.now();
      state.lastLatencyMs = latency;
      state.totalLatencyMs += latency;
      entry.inputTokens += best.inputTokens;
      entry.outputTokens += best.outputTokens;
      entry.cacheHitTokens += best.cacheHitTokens ?? 0;
      const cost = costOf(model, best);
      if (cost === null) entry.unpricedCalls += 1;
      else entry.costUsd = (entry.costUsd ?? 0) + cost;
    },
    failed(error) {
      if (settled) return;
      settled = true;
      inFlight -= 1;
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.lastLatencyMs = Date.now() - startedAt;
      entry.failures += 1;
    },
  };
}

/**
 * 执行一次 LLM 调用：先取配额，再调用，最后按结果记账。
 *
 * 记账在 `finally` 之外显式分支 —— 需要区分成功与失败，而不是"没抛错就算成功"。
 */
export async function withLlmGateway<T>(
  model: string,
  signal: AbortSignal,
  run: (handle: LlmCallHandle) => Promise<T>,
  sessionId?: string | null,
): Promise<T> {
  await acquireSlot(model, signal);
  const handle = beginLlmCall(model, sessionId);
  try {
    const result = await run(handle);
    handle.succeeded();
    return result;
  } catch (err) {
    handle.failed(err);
    throw err;
  }
}

// ─── 快照与测试缝 ──────────────────────────────────────

export function llmGatewaySnapshot(): LlmGatewaySnapshot {
  return {
    ledger: [...ledger.values()].map((e) => ({ ...e })),
    health: [...health.values()].map((s) => ({
      model: s.model,
      calls: s.calls,
      failures: s.failures,
      consecutiveFailures: s.consecutiveFailures,
      lastError: s.lastError,
      lastSuccessAt: s.lastSuccessAt,
      lastLatencyMs: s.lastLatencyMs,
      avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : null,
    })),
    rateLimitRpm: llmRateLimitRpm(),
    inFlight,
  };
}

/** Test seam — 清空所有累积状态与配置（含惰性 env 缓存）。 */
export function resetLlmGatewayForTest(): void {
  ledger.clear();
  health.clear();
  buckets.clear();
  pricing = {};
  envPricingRaw = null;
  envPricingCache = {};
  inFlight = 0;
}
