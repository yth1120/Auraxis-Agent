import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import axios from 'axios';
import { readErrorBody } from './agent-loop';
import { runQuery } from './query-engine';
import { requestPermission } from './permission-handlers';
import { trackMessage } from './stats-handlers';
import { readSettings, resolveMaxOutputTokens } from './settings-store';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { getDeepSeekModelsUrl } from '../api-config';
import { abortTool } from './tool-handlers';
import type { EngineEvent } from './engine-events';
import { toToolStreamEvent } from './event-bridge';
import { clearLlmContext } from './query-context';
import { isPermissionPreset, PERMISSION_PRESETS } from '../contracts/permission';
import { errorRecord, errorText } from '../errors';
import { normalizeApprovalPolicy, apiMessageText, type ApiMessage, type ApprovalPolicy } from '../contracts/core';
import type { SandboxMode } from '../sandbox-policy';
import {
  getApiKey,
  isRecord,
  performWebSearch,
  resolveFimApiBase,
  sendQueryEvent,
  sendToRenderer,
} from './ai-handlers-utils';
import { streamDeepSeek } from './ai-handlers-stream';

const activeStreams = new Map<string, AbortController>();
const activeQueries = new Map<string, AbortController>();
const nudgeQueues = new Map<string, string[]>();

interface ChatStreamPayload {
  requestId: string;
  model: string;
  messages: ApiMessage[];
  isDeepThink: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  isWebSearch: boolean;
  apiKey?: string;
  /** 对话前缀续写（Beta）：强制模型从给定 assistant 前缀继续输出。 */
  prefix?: { content: string; stop?: string[] };
}

interface QueryPayload {
  requestId: string;
  sessionId?: string;
  model: string;
  messages: ApiMessage[];
  memoryContext?: string;
  isDeepThink: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  projectRoot: string;
  autoApprove?: boolean;
  mode?: string;
  apiKey?: string;
  maxIterations?: number;
  approvedPlanSteps?: string[];
  surface?: 'chat' | 'work' | 'code';
}

function readErrorDetail(errorBody: string): string {
  try {
    const parsed = JSON.parse(errorBody) as { message?: string; error?: string | { message?: string } };
    if (typeof parsed?.error === 'string') return parsed.error;
    if (typeof parsed?.error === 'object') return parsed?.error?.message || '';
    return parsed?.message || '';
  } catch {
    return errorBody.slice(0, 200);
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'API Key 无效或已过期。',
  429: '请求过于频繁，请稍后重试。',
  402: '账户余额不足，请前往 DeepSeek 平台充值后重试。',
  503: '服务繁忙，请稍后重试。',
  500: '服务器故障，请稍后重试。',
};

/** Map a thrown stream error onto the renderer-facing message. */
async function describeChatStreamFailure(error: unknown): Promise<string> {
  const apiError = errorRecord(error);
  const status =
    typeof apiError.response === 'object' && apiError.response
      ? (apiError.response as { status?: number }).status
      : undefined;
  const errorMessage = errorText(error);
  if (apiError.code === 'ECONNABORTED' || errorMessage.includes('timeout')) return '请求超时，请重试。';
  if (!status) return `网络错误: ${errorMessage}`;
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  const errorBody = await readErrorBody(error);
  const detail = readErrorDetail(errorBody);
  console.error('[chatStream] API error:', { status, body: errorBody.slice(0, 500) });
  return `API 错误 (${status}): ${detail || errorMessage}`;
}

/** Clean up all active streams/queries for a closed window */
export function cleanupWindowStreams() {
  for (const [id, ctrl] of activeStreams) {
    ctrl.abort();
    activeStreams.delete(id);
  }
  for (const [id, ctrl] of activeQueries) {
    ctrl.abort();
    activeQueries.delete(id);
  }
  nudgeQueues.clear();
}

const handleChatStream = async (event: IpcMainInvokeEvent, payload: ChatStreamPayload): Promise<void> => {
  const { requestId, model, messages, isDeepThink, reasoningEffort, isWebSearch, apiKey, prefix } = payload;
  const win = BrowserWindow.fromWebContents(event.sender);

  if (!win) {
    event.sender.send(`ai:chunk:${requestId}`, { requestId, type: 'error' as const, error: '无法获取窗口实例' });
    return;
  }

  const resolvedKey = apiKey || (await resolveModelApiKey(model)) || (await getApiKey(undefined));
  const apiBase = await resolveModelApiBase(model);
  const settings = (await readSettings().catch(() => null)) as Record<string, unknown> | null;
  const maxOutputTokens = resolveMaxOutputTokens(settings);
  if (!resolvedKey) {
    sendToRenderer(
      win,
      requestId,
      'error',
      undefined,
      '未配置 DeepSeek API Key。请在设置中添加或在环境变量中设置。',
    );
    return;
  }

  let searchPromise: Promise<string | null> = Promise.resolve(null);
  if (isWebSearch) {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const searchQuery = lastUserMsg ? apiMessageText(lastUserMsg.content).slice(0, 200) : '';
    if (searchQuery) {
      searchPromise = performWebSearch(searchQuery);
    }
  }

  const abortController = new AbortController();
  activeStreams.set(requestId, abortController);

  const signal = abortController.signal;
  // 'done' is emitted exactly once from the finally block. The previous
  // implementation sent 'done' from BOTH an abort listener AND the success
  // path, causing the renderer to receive duplicate done events under
  // certain abort timings. Single-emit invariant keeps cleanup deterministic.
  let doneEmitted = false;
  const emitDone = () => {
    if (doneEmitted) return;
    doneEmitted = true;
    sendToRenderer(win, requestId, 'done');
  };

  try {
    const searchResults = await searchPromise;
    await streamDeepSeek(
      { model, messages, isDeepThink, reasoningEffort, isWebSearch, prefix, maxTokens: maxOutputTokens },
      resolvedKey,
      apiBase,
      requestId,
      win,
      signal,
      searchResults,
    );
    emitDone();
  } catch (error: unknown) {
    if (errorRecord(error).name === 'AbortError') {
      emitDone();
      return;
    }
    sendToRenderer(win, requestId, 'error', undefined, await describeChatStreamFailure(error));
  } finally {
    activeStreams.delete(requestId);
    emitDone();
  }
};

  secureHandle('ai:abortStream', async (_event, requestId: string) => {
    const controller = activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      activeStreams.delete(requestId);
    }
  });

const handleFim = async (_event: IpcMainInvokeEvent, params: FimPayload): Promise<unknown> => {
  const { model, apiKey, prompt, suffix, maxTokens } = params ?? {};
  const resolvedKey = apiKey || (await resolveModelApiKey(model)) || (await getApiKey(undefined));
  if (!resolvedKey) return { ok: false, error: '未配置 DeepSeek API Key。' };
  const apiBase = resolveFimApiBase(await resolveModelApiBase(model));
  try {
    const body: Record<string, unknown> = {
      model,
      prompt,
      max_tokens: Math.min(Math.max(maxTokens ?? 512, 16), 4096),
      stream: false,
      temperature: 0.2,
    };
    if (suffix) body.suffix = suffix;
    const response = await axios.post(apiBase, body, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolvedKey}` },
      timeout: 60_000,
    });
    const text = typeof response.data?.choices?.[0]?.text === 'string' ? response.data.choices[0].text : '';
    return { ok: true, data: { text } };
  } catch (error: unknown) {
    return { ok: false, error: errorText(error) };
  }
};

interface FimPayload {
  model: string;
  apiKey?: string;
  prompt: string;
  suffix?: string;
  maxTokens?: number;
}

interface QuerySetup {
  resolvedKey: string | null;
  apiBase: string;
  settings: Awaited<ReturnType<typeof readSettings>> | null;
  sandboxMode: SandboxMode;
  approval: ApprovalPolicy;
  effectiveAutoApprove: boolean;
}

/** Resolve key/base/settings and fold the permission preset into the run config. */
async function resolveQuerySetup(
  model: string,
  apiKey: string | undefined,
  mode: string | undefined,
  autoApprove: boolean | undefined,
): Promise<QuerySetup> {
  const resolvedKey = apiKey || (await resolveModelApiKey(model)) || (await getApiKey(undefined));
  const apiBase = await resolveModelApiBase(model);
  const settings = await readSettings().catch(() => null);
  const presetSpec =
    typeof settings?.permissionPreset === 'string' && isPermissionPreset(settings.permissionPreset)
      ? PERMISSION_PRESETS[settings.permissionPreset]
      : undefined;
  const settingsSandbox =
    settings?.sandboxMode === 'read' ||
    settings?.sandboxMode === 'workspace-write' ||
    settings?.sandboxMode === 'full'
      ? settings.sandboxMode
      : undefined;
  return {
    resolvedKey,
    apiBase,
    settings,
    sandboxMode: presetSpec?.sandboxMode ?? settingsSandbox ?? 'workspace-write',
    approval: normalizeApprovalPolicy(mode ?? presetSpec?.mode ?? 'ask'),
    effectiveAutoApprove: autoApprove ?? presetSpec?.autoApprove ?? false,
  };
}

const handleSendQuery = async (event: IpcMainInvokeEvent, payload: QueryPayload): Promise<void> => {
  const {
    requestId,
    sessionId,
    model,
    messages,
    memoryContext,
    isDeepThink,
    reasoningEffort,
    projectRoot,
    autoApprove,
    mode,
    apiKey,
    maxIterations,
    approvedPlanSteps,
    surface,
  } = payload;
  const win = BrowserWindow.fromWebContents(event.sender);
  const trustedProjectRoot = await resolveTrustedProjectRoot(projectRoot);

  if (!win) {
    event.sender.send(`ai:queryEvent:${requestId}`, {
      requestId,
      type: 'error' as const,
      error: '无法获取窗口实例',
    });
    return;
  }

  // Backend-enforced mode isolation: the unified tool/agent engine must
  // never run for a chat-mode request, even if the renderer misbehaves.
  if (surface === 'chat') {
    sendQueryEvent(win, requestId, 'error', undefined, 'Chat 模式不支持 Agent 功能，请切换到 Work 或 Code 模式。');
    return;
  }

  const { resolvedKey, apiBase, settings, sandboxMode, approval, effectiveAutoApprove } = await resolveQuerySetup(
    model,
    apiKey,
    mode,
    autoApprove,
  );

  if (!resolvedKey) {
    sendQueryEvent(win, requestId, 'error', undefined, '未配置 DeepSeek API Key。请在设置中添加。');
    return;
  }

  const abortController = new AbortController();
  activeQueries.set(requestId, abortController);

  // Stats: count each user message sent (non-system messages)
  const userMsgCount = messages.filter((m) => m.role === 'user').length;
  for (let i = 0; i < userMsgCount; i++) trackMessage().catch(() => {});

  try {
    const checkPermission = effectiveAutoApprove
      ? () => Promise.resolve(true)
      : (toolName: string, input: Record<string, unknown>, toolCallId?: string) =>
          requestPermission(toolName, input, win, toolCallId, {
            mode: approval,
            approvedPlanSteps,
            projectRoot: trustedProjectRoot,
          });

    nudgeQueues.set(requestId, []);
    await runQuery(
      {
        requestId,
        sessionId,
        model,
        messages,
        memoryContext,
        isDeepThink,
        reasoningEffort,
        projectRoot: trustedProjectRoot,
        apiKey: resolvedKey,
        apiBase,
        checkPermission,
        autoApprove: effectiveAutoApprove,
        mode: approval,
        maxIterations,
        fallbackModel:
          typeof settings?.fallbackModel === 'string' && settings.fallbackModel
            ? settings.fallbackModel
            : undefined,
        sandboxMode,
        approvedPlanSteps,
        surface,
        clarifyBeforeWork: settings?.clarifyBeforeWork !== false,
        win,
        getPendingNudge: () => {
          const q = nudgeQueues.get(requestId);
          return q && q.length > 0 ? q.shift()! : null;
        },
      },
      (event: EngineEvent) => {
        // Engine emits the unified EngineEvent contract; the bridge is the
        // only place that maps it to the renderer ToolStreamEvent shape.
        const streamEvent = toToolStreamEvent(event, requestId);
        if (!streamEvent) return; // engine-internal lifecycle event
        try {
          win.webContents.send(`ai:queryEvent:${requestId}`, streamEvent);
        } catch {
          /* window destroyed */
        }
      },
      abortController.signal,
    );
  } catch (error: unknown) {
    if (errorRecord(error).name !== 'AbortError') {
      sendQueryEvent(win, requestId, 'error', undefined, `查询失败: ${errorText(error)}`);
    }
  } finally {
    activeQueries.delete(requestId);
    nudgeQueues.delete(requestId);
  }
};

  secureHandle('ai:clearQueryContext', async (_event, sessionId: string) => {
    try {
      await clearLlmContext(sessionId);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('ai:abortQuery', async (_event, requestId: string) => {
    const controller = activeQueries.get(requestId);
    if (controller) {
      controller.abort();
      activeQueries.delete(requestId);
    }
  });

  secureHandle('ai:abortTool', async (_event, _requestId: string, toolCallId: string) => {
    const ok = abortTool(toolCallId);
    if (!ok) {
      console.warn('[ai:abortTool] no running tool found for', toolCallId);
    }
    return { ok };
  });

  secureHandle('ai:retryTool', async (_event, requestId: string, toolName: string) => {
    const queue = nudgeQueues.get(requestId);
    if (!queue) {
      console.warn('[ai:retryTool] no active query found for', requestId);
      return { ok: false, error: '无活跃查询' };
    }
    const nudge = `工具 ${toolName} 之前执行失败，请重试该工具调用。如果该方法反复失败，请换一种完全不同的方式。`;
    queue.push(nudge);
    return { ok: true };
  });

const handleTestConnection = async (_event: IpcMainInvokeEvent, payload: { apiKey: string }): Promise<unknown> => {
const { apiKey } = payload;
const resolvedKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey : await getApiKey(undefined);
if (!resolvedKey) return { ok: false, error: '未配置 API Key，无法测试连接' };
try {
  // DEEPSEEK_BASE_URL in .env.example points at the chat completions
  // endpoint (`.../v1/chat/completions`). Strip the chat path so we can
  // append `/models` for the GET probe, otherwise we'd hit
  // `.../chat/completions/models` → 404.
  const response = await axios.get(getDeepSeekModelsUrl(), {
    headers: { Authorization: `Bearer ${resolvedKey}` },
    timeout: 15000,
  });
  if (response.status === 200) {
    const responseData = isRecord(response.data) ? response.data : {};
    const models = Array.isArray(responseData.data)
      ? responseData.data
          .filter(isRecord)
          .map((m) => String(m.id ?? ''))
          .filter(Boolean)
      : [];
    const modelIds = models.slice(0, 10);
    return { ok: true, data: { message: 'DeepSeek API 连接成功', models: modelIds } };
  }
  return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
} catch (err: unknown) {
  const apiError = errorRecord(err);
  const status =
    typeof apiError.response === 'object' && apiError.response
      ? (apiError.response as { status?: number }).status
      : undefined;
  if (status === 401 || status === 403) {
    return { ok: false, error: 'API Key 无效或未授权，请检查密钥是否正确' };
  }
  if (status === 429) {
    return { ok: false, error: '请求过于频繁，请稍后重试' };
  }
  if (status === 402) {
    return { ok: false, error: '账户余额不足，请前往 DeepSeek 平台充值后重试' };
  }
  if (status === 503) {
    return { ok: false, error: '服务繁忙，请稍后重试' };
  }
  if (apiError.code === 'ECONNREFUSED' || apiError.code === 'ENOTFOUND') {
    return { ok: false, error: '无法连接到 API 服务器，请检查网络或 API 地址' };
  }
  const errorBody = await readErrorBody(err);
  let detail = '';
  try {
    const p = JSON.parse(errorBody);
    detail = p?.error?.message || p?.message || p?.error || '';
  } catch {
    detail = errorBody.slice(0, 200);
  }
  console.error('[testConnection] error:', { status, body: errorBody.slice(0, 500) });
  return { ok: false, error: `连接失败${detail ? `: ${detail}` : `: ${errorText(err)}`}` };
}
};

export function registerAiHandlers() {
  secureHandle('ai:chatStream', handleChatStream);
  secureHandle('ai:fim', handleFim);
  secureHandle('ai:sendQuery', handleSendQuery);
  secureHandle('ai:testConnection', handleTestConnection);
}
