import { BrowserWindow } from 'electron';
import { secureHandle } from './trust';
import { resolveTrustedProjectRoot } from './project-access';
import axios from 'axios';
import type { Readable } from 'stream';
import { readErrorBody } from './agent-loop';
import { runQuery } from './query-engine';
import { requestPermission } from './permission-handlers';
import { trackMessage } from './stats-handlers';
import { readSettings, resolveMaxOutputTokens } from './settings-store';
import { resolveModelApiBase, resolveModelApiKey } from './model-config';
import { getDeepSeekModelsUrl } from '../api-config';
import { executeToolCall, abortTool } from './tool-handlers';
import type { EngineEvent } from './engine-events';
import { toToolStreamEvent } from './event-bridge';
import { clearLlmContext } from './query-context';
import { resolveCredential } from '../credentials';
import { getDeepSeekUserId } from '../auth-store';
import { isPermissionPreset, PERMISSION_PRESETS } from '../contracts/permission';
import { errorRecord, errorText } from '../errors';
import { normalizeApprovalPolicy, normalizeDeepSeekMessages, apiMessageText, type ApiMessage } from '../contracts/core';

const activeStreams = new Map<string, AbortController>();
const activeQueries = new Map<string, AbortController>();
const nudgeQueues = new Map<string, string[]>();

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

async function performWebSearch(query: string): Promise<string | null> {
  try {
    const result = await executeToolCall(
      'WebSearch',
      { query },
      { projectRoot: '', requestId: 'websearch', mode: 'ask' },
    );
    if (result.error || !result.output) return null;
    const output = result.output as any;
    if (!output.results || output.results.length === 0) return null;
    return output.results.map((r: any, i: number) => `[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`).join('\n\n');
  } catch {
    console.warn('[chatStream] 联网搜索未返回结果，已跳过（不影响主回答）');
    return null;
  }
}

async function getApiKey(overrideKey?: string): Promise<string | null> {
  if (overrideKey) return overrideKey;
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  const credential = await resolveCredential('DEEPSEEK_API_KEY');
  if (credential) return credential.value;
  const settings = await readSettings();
  const key = settings.deepseekApiKey;
  if (key && typeof key === 'string' && key.length > 0) return key;
  return null;
}

function sendToRenderer(
  win: BrowserWindow,
  requestId: string,
  type: 'chunk' | 'thinking' | 'done' | 'error',
  text?: string,
  error?: string,
) {
  try {
    win.webContents.send(`ai:chunk:${requestId}`, { requestId, type, text, error });
  } catch {
    /* window destroyed */
  }
}

function sendUsageToRenderer(
  win: BrowserWindow,
  requestId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
  },
) {
  try {
    win.webContents.send(`ai:chunk:${requestId}`, { requestId, type: 'usage', usage });
  } catch {
    /* window destroyed */
  }
}

/** FIM 补全（Beta）走 /completions；从 chat 端点推导即可。 */
function resolveFimApiBase(apiBase: string): string {
  return apiBase.replace(/\/chat\/completions$/, '/completions');
}

function sendQueryEvent(win: BrowserWindow, requestId: string, type: 'done' | 'error', text?: string, error?: string) {
  try {
    win.webContents.send(`ai:queryEvent:${requestId}`, { requestId, type, text, error });
  } catch {
    /* window destroyed */
  }
}

export function registerAiHandlers() {
  secureHandle(
    'ai:chatStream',
    async (
      event,
      payload: {
        requestId: string;
        model: string;
        messages: ApiMessage[];
        isDeepThink: boolean;
        reasoningEffort?: 'low' | 'high' | 'max';
        isWebSearch: boolean;
        apiKey?: string;
        /** 对话前缀续写（Beta）：强制模型从给定 assistant 前缀继续输出。 */
        prefix?: { content: string; stop?: string[] };
      },
    ) => {
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
        const apiError = errorRecord(error);
        const status =
          typeof apiError.response === 'object' && apiError.response
            ? (apiError.response as { status?: number }).status
            : undefined;
        const errorMessage = errorText(error);
        if (apiError.name === 'AbortError') {
          emitDone();
          return;
        }
        if (apiError.code === 'ECONNABORTED' || errorMessage.includes('timeout')) {
          sendToRenderer(win, requestId, 'error', undefined, '请求超时，请重试。');
        } else if (status === 401) {
          sendToRenderer(win, requestId, 'error', undefined, 'API Key 无效或已过期。');
        } else if (status === 429) {
          sendToRenderer(win, requestId, 'error', undefined, '请求过于频繁，请稍后重试。');
        } else if (status === 402) {
          sendToRenderer(win, requestId, 'error', undefined, '账户余额不足，请前往 DeepSeek 平台充值后重试。');
        } else if (status === 503) {
          sendToRenderer(win, requestId, 'error', undefined, '服务繁忙，请稍后重试。');
        } else if (status === 500) {
          sendToRenderer(win, requestId, 'error', undefined, '服务器故障，请稍后重试。');
        } else if (status) {
          const errorBody = await readErrorBody(error);
          let detail = '';
          try {
            const p = JSON.parse(errorBody);
            const parsed = p as { message?: string; error?: string | { message?: string } };
            detail =
              typeof parsed?.error === 'string'
                ? parsed.error
                : typeof parsed?.error === 'object'
                  ? parsed.error.message || ''
                  : parsed?.message || '';
          } catch {
            detail = errorBody.slice(0, 200);
          }
          console.error('[chatStream] API error:', { status, body: errorBody.slice(0, 500) });
          sendToRenderer(win, requestId, 'error', undefined, `API 错误 (${status}): ${detail || errorMessage}`);
        } else {
          sendToRenderer(win, requestId, 'error', undefined, `网络错误: ${errorMessage}`);
        }
      } finally {
        activeStreams.delete(requestId);
        emitDone();
      }
    },
  );

  secureHandle('ai:abortStream', async (_event, requestId: string) => {
    const controller = activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      activeStreams.delete(requestId);
    }
  });

  secureHandle(
    'ai:fim',
    async (
      _event,
      params: {
        model: string;
        apiKey?: string;
        prompt: string;
        suffix?: string;
        maxTokens?: number;
      },
    ) => {
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
    },
  );

  secureHandle(
    'ai:sendQuery',
    async (
      event,
      payload: {
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
      },
    ) => {
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

      const resolvedKey = apiKey || (await resolveModelApiKey(model)) || (await getApiKey(undefined));
      const apiBase = await resolveModelApiBase(model);
      const settings = (await readSettings().catch(() => null)) as Record<string, any> | null;
      const presetSpec = isPermissionPreset(settings?.permissionPreset)
        ? PERMISSION_PRESETS[settings.permissionPreset]
        : undefined;
      const sandboxMode =
        presetSpec?.sandboxMode ??
        (settings?.sandboxMode === 'read' ||
        settings?.sandboxMode === 'workspace-write' ||
        settings?.sandboxMode === 'full'
          ? settings.sandboxMode
          : 'workspace-write');
      const approval = normalizeApprovalPolicy(mode ?? presetSpec?.mode ?? 'ask');
      const effectiveAutoApprove = autoApprove ?? presetSpec?.autoApprove ?? false;

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
            fallbackModel: (settings?.fallbackModel as string) || undefined,
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
    },
  );

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

  secureHandle('ai:testConnection', async (_event, payload: { apiKey: string }) => {
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
        const modelIds = (response.data?.data || []).map((m: any) => m.id).slice(0, 10);
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
  });
}

async function streamDeepSeek(
  request: {
    model: string;
    messages: ApiMessage[];
    isDeepThink: boolean;
    reasoningEffort?: 'low' | 'high' | 'max';
    isWebSearch?: boolean;
    prefix?: { content: string; stop?: string[] };
    maxTokens?: number;
  },
  apiKey: string,
  apiBase: string,
  requestId: string,
  win: BrowserWindow,
  signal: AbortSignal,
  searchResults?: string | null,
): Promise<void> {
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    messages: normalizeDeepSeekMessages(request.messages, request.model),
    stream: true,
    // 官方用法：流式末尾额外返回 usage 块（含缓存命中与推理 tokens）。
    stream_options: { include_usage: true },
  };

  const userId = await getDeepSeekUserId();
  if (userId) {
    body.user_id = userId;
  }

  if (searchResults) {
    (body.messages as any[]).push({
      role: 'system',
      content: `以下是与用户问题相关的网络搜索结果，请基于这些信息回答：\n\n${searchResults}\n\n请结合搜索结果提供准确、最新的回答，并引用来源编号。`,
    });
  }

  if (request.prefix?.content) {
    // 官方对话前缀续写：最后一条消息必须是 assistant 且 prefix=true，
    // 模型从给定内容继续生成；stop 避免多输出代码块闭合标记。
    (body.messages as any[]).push({
      role: 'assistant',
      content: request.prefix.content,
      prefix: true,
    });
    body.stop = request.prefix.stop && request.prefix.stop.length > 0 ? request.prefix.stop : ['```'];
  }

  if (request.isDeepThink) {
    if (request.model.startsWith('deepseek-')) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = request.reasoningEffort || 'high';
    }
  }

  const response = await axios.post(apiBase, body, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    responseType: 'stream',
    signal,
    timeout: 120000,
  });

  const stream = response.data as Readable;
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  // ── Per‑chunk heartbeat: detect upstream stalls ──────────
  // Axios timeout (120 s) is per‑request, not per‑byte, so a
  // stream that starts sending data then stalls can sit idle
  // indefinitely.  Reset lastDataTime on every chunk and
  // abort if no data arrives for 60 s.
  let lastDataTime = Date.now();
  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastDataTime > 60_000) {
      // Abort the Axios request — this propagates to the signal
      // and triggers the catch path with a timeout error.
      signal.dispatchEvent(new Event('abort'));
    }
  }, 15_000);

  try {
    for await (const chunk of stream) {
      lastDataTime = Date.now();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            const usage = parsed.usage;
            if (usage) {
              sendUsageToRenderer(win, requestId, {
                inputTokens: usage.prompt_tokens || 0,
                outputTokens: usage.completion_tokens || 0,
                reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
                cacheHitTokens: usage.prompt_cache_hit_tokens,
                cacheMissTokens: usage.prompt_cache_miss_tokens,
              });
            }
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              sendToRenderer(win, requestId, 'chunk', content);
            }
            // DeepSeek thinking mode: reasoning_content 单独流式下发，供 Chat 渲染思考块。
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
            if (reasoning) {
              sendToRenderer(win, requestId, 'thinking', reasoning);
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}
