/**
 * agent-trace-otlp.ts — 把 Agent 运行轨迹导出为 OTLP/HTTP(JSON) 的 span。
 *
 * 定位：**导出层**，不是新的采集层。事实来源仍是 `AgentTraceRun`（它本身是会话事件流
 * 的投影，见 electron/contracts/agent-trace.ts），本文件只做契约到 OTLP 的映射与投递。
 *
 * 刻意只映射**有真实采集源**的四类 span：
 *   · run       —— 根 span（AgentTraceRun）
 *   · turn      —— 模型回合（TraceTurn）
 *   · tool      —— 工具调用（TraceToolCall）
 *   · subagent  —— 子代理（TraceSubAgent）
 * 另有 approval 作为 run 上的事件属性（它由宿主从权限通道注入，不是独立时间段）。
 * **不生成 llm span**：轨迹契约里没有逐次模型调用的耗时/token 记录，凭空造一个只有
 * 名字没有数据的 span 属于自欺。接入方若要 llm span，需先在事件流补齐采集源。
 *
 * 默认关闭：只有设置了 `AURAXIS_OTLP_ENDPOINT` 才导出。遥测永远不能影响主流程，
 * 因此投递失败只记日志、不抛出。
 */
import { createHash } from 'node:crypto';
import axios from 'axios';
import { app } from 'electron';
import type { AgentTraceRun, TraceToolCall, TraceTurn } from './contracts/agent-trace';

// ─── OTLP 数据形状（只覆盖本文件用到的字段） ────────────

export interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  /** OTLP 状态码：0=未设置 1=OK 2=ERROR。 */
  status: { code: number; message?: string };
}

export interface OtlpExportOptions {
  serviceName: string;
  /** 缺省时按 sessionId 派生，保证同一次运行重复导出结果稳定（可对照、可测试）。 */
  traceId?: string;
}

// ─── 工具 ──────────────────────────────────────────────

const MS_TO_NANO = 1_000_000;
const SPAN_KIND_INTERNAL = 1;

/** 由稳定种子派生十六进制 id：traceId 取 32 位、spanId 取 16 位。 */
function deriveId(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

function str(key: string, value: string | undefined | null): OtlpAttribute[] {
  return value === undefined || value === null || value === '' ? [] : [{ key, value: { stringValue: value } }];
}

function int(key: string, value: number | undefined): OtlpAttribute[] {
  return typeof value === 'number' && Number.isFinite(value)
    ? [{ key, value: { intValue: String(Math.trunc(value)) } }]
    : [];
}

function nanos(ms: number): string {
  return String(Math.max(0, Math.trunc(ms)) * MS_TO_NANO);
}

/** 运行状态 → OTLP span status（失败才算 ERROR；停止/未知不算失败）。 */
function runStatus(run: AgentTraceRun): { code: number; message?: string } {
  if (run.status === 'failed') {
    return run.error ? { code: 2, message: run.error } : { code: 2 };
  }
  if (run.status === 'running' || run.status === 'unknown') return { code: 0 };
  return { code: 1 };
}

// ─── 映射 ──────────────────────────────────────────────

function toolSpan(call: TraceToolCall, traceId: string, parentSpanId: string): OtlpSpan {
  const start = call.startedAt;
  const end = call.endedAt ?? (call.durationMs !== undefined ? start + call.durationMs : start);
  return {
    traceId,
    spanId: deriveId(`tool:${call.id}`, 16),
    parentSpanId,
    name: `tool ${call.name}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: [
      { key: 'auraxis.span.kind', value: { stringValue: 'tool' } },
      ...str('tool.name', call.name),
      ...str('tool.status', call.status),
      ...int('tool.duration_ms', call.durationMs),
      ...str('tool.error', call.error),
    ],
    status: call.status === 'error' ? { code: 2, message: call.error } : { code: 1 },
  };
}

function turnSpan(turn: TraceTurn, traceId: string, parentSpanId: string): OtlpSpan {
  return {
    traceId,
    spanId: deriveId(`turn:${turn.id}`, 16),
    parentSpanId,
    name: `turn ${turn.index}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(turn.startedAt),
    endTimeUnixNano: nanos(turn.endedAt ?? turn.startedAt),
    attributes: [
      { key: 'auraxis.span.kind', value: { stringValue: 'turn' } },
      ...int('turn.index', turn.index),
      ...int('turn.tool_calls', turn.toolCallIds.length),
    ],
    status: { code: 0 },
  };
}

/**
 * 轨迹 → OTLP span 列表。纯函数：不读环境变量、不发网络请求，便于直接单测映射规则。
 */
export function toOtlpSpans(run: AgentTraceRun, options: OtlpExportOptions): OtlpSpan[] {
  const traceId = options.traceId ?? deriveId(`run:${run.sessionId}`, 32);
  const rootSpanId = deriveId(`run:${run.sessionId}`, 16);
  const start = run.startedAt ?? run.turns[0]?.startedAt ?? 0;
  const end = run.endedAt ?? run.turns.at(-1)?.endedAt ?? start;

  // 工具挂到它所属回合下；轨迹没有归属信息时挂根 span。
  const turnByToolId = new Map<string, TraceTurn>();
  for (const turn of run.turns) {
    for (const toolId of turn.toolCallIds) turnByToolId.set(toolId, turn);
  }

  const root: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: run.title || `agent run ${run.sessionId}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(end),
    attributes: [
      { key: 'auraxis.span.kind', value: { stringValue: 'run' } },
      ...str('agent.session_id', run.sessionId),
      ...str('agent.status', run.status),
      ...str('agent.goal', run.goal),
      ...str('agent.error', run.error),
      ...int('agent.turns', run.stats.turns),
      ...int('agent.tool_calls', run.stats.toolCalls),
      ...int('agent.failed_tool_calls', run.stats.failedToolCalls),
      ...int('agent.approvals', run.stats.approvals),
      ...int('agent.sub_agents', run.stats.subAgents),
      ...int('agent.iterations', run.stats.iterations),
      ...int('agent.repeated_tool_runs', run.stats.repeatedToolRuns),
    ],
    status: runStatus(run),
  };

  const spans: OtlpSpan[] = [root];
  for (const turn of run.turns) spans.push(turnSpan(turn, traceId, rootSpanId));
  for (const call of run.toolCalls) {
    const turn = turnByToolId.get(call.id);
    const parent = turn ? deriveId(`turn:${turn.id}`, 16) : rootSpanId;
    spans.push(toolSpan(call, traceId, parent));
  }
  for (const sub of run.subAgents) {
    spans.push({
      traceId,
      spanId: deriveId(`subagent:${sub.id}`, 16),
      parentSpanId: rootSpanId,
      name: `subagent ${sub.name || sub.id}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(sub.at),
      endTimeUnixNano: nanos(sub.at),
      attributes: [
        { key: 'auraxis.span.kind', value: { stringValue: 'subagent' } },
        ...str('subagent.id', sub.id),
        ...str('subagent.name', sub.name),
        ...str('subagent.status', sub.status),
      ],
      status: sub.status === 'error' ? { code: 2 } : { code: 0 },
    });
  }

  // 审批不是时间段，作为根 span 的事件属性记录（谁在何时批准/拒绝了什么）。
  for (const approval of run.approvals) {
    root.attributes.push(
      ...str(`approval.${approval.id}.tool`, approval.toolName),
      ...str(`approval.${approval.id}.status`, approval.status),
      ...int(`approval.${approval.id}.at`, approval.at),
    );
  }

  return spans;
}

// ─── 投递 ──────────────────────────────────────────────

export interface OtlpConfig {
  endpoint: string;
  serviceName: string;
  headers?: Record<string, string>;
}

/** 读取 OTLP 配置；未设置 endpoint 时返回 null（默认关闭）。 */
export function readOtlpConfig(env: NodeJS.ProcessEnv = process.env): OtlpConfig | null {
  const endpoint = (env.AURAXIS_OTLP_ENDPOINT || '').trim();
  if (!endpoint) return null;
  const headers: Record<string, string> = {};
  for (const pair of (env.AURAXIS_OTLP_HEADERS || '').split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return {
    endpoint,
    serviceName: (env.AURAXIS_OTLP_SERVICE_NAME || 'auraxis').trim() || 'auraxis',
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** 组装 OTLP/HTTP JSON 请求体（resourceSpans 结构）。 */
export function buildOtlpPayload(
  spans: OtlpSpan[],
  serviceName: string,
  scopeVersion: string,
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
        },
        scopeSpans: [
          {
            scope: { name: 'auraxis.agent-trace', version: scopeVersion },
            spans,
          },
        ],
      },
    ],
  };
}

function appVersion(): string {
  try {
    return app.getVersion();
  } catch {
    /* 测试或非 Electron 环境 */
    return '0.0.0';
  }
}

/**
 * 导出一次运行轨迹。未配置 endpoint 时直接返回。
 * 失败一律吞掉并记日志 —— 遥测不得影响 Agent 主流程。
 */
export async function exportAgentTraceOtlp(run: AgentTraceRun): Promise<void> {
  const config = readOtlpConfig();
  if (!config) return;
  try {
    const spans = toOtlpSpans(run, { serviceName: config.serviceName });
    const payload = buildOtlpPayload(spans, config.serviceName, appVersion());
    await axios.post(config.endpoint, payload, {
      headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
      timeout: 10_000,
    });
  } catch (err: unknown) {
    console.error(`[otlp] 轨迹导出失败（不影响运行）: ${err instanceof Error ? err.message : String(err)}`);
  }
}
