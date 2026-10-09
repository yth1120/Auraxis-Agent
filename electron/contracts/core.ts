/**
 * core.ts — single source of truth for cross-process core types.
 *
 * electron/types.ts and the renderer both re-export from here, so IPC contract
 * types (ApprovalPolicy, IpcResponse, ModelDefinition, …) are never
 * duplicated across the process boundary.
 */

/** 审批策略 — how much the loop asks before acting.
 *  · ask  — prompt per risky tool.
 *  · plan — plan approval authorizes the run.
 *  · auto — approve everything (was historically spelled 'afe'). */
export type ApprovalPolicy = 'ask' | 'plan' | 'auto';

/** Normalize persisted/CLI values, including the legacy 'afe' spelling. */
export function normalizeApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === 'ask' || value === 'plan' || value === 'auto') return value;
  if (value === 'afe') return 'auto';
  return 'ask';
}

export interface FileResult {
  name: string;
  path: string;
  content: string;
  mimeType: string;
}

export interface FileSearchResult {
  name: string;
  path: string;
  isDirectory: boolean;
  /** 内容命中时的上下文片段（文件名命中为空）。 */
  snippet?: string;
  matchType?: 'name' | 'content';
}

export interface ApplyCodePayload {
  filePath: string;
  code: string;
  projectRoot: string;
}

export interface ApplyCodeResult {
  ok: boolean;
  filePath: string;
  action: 'created' | 'overwritten';
  error?: string;
}

export interface PreviewCodeResult {
  ok: boolean;
  filePath?: string;
  url?: string;
  error?: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DirectoryEntry[];
}

export interface AIStreamRequest {
  requestId: string;
  model: string;
  messages: ApiMessage[];
  isDeepThink: boolean;
  isWebSearch: boolean;
}

export interface AIStreamChunk {
  requestId: string;
  type: 'chunk' | 'done' | 'error';
  text?: string;
  error?: string;
}

// ─── Workspace task diff (read-only 变更 view) ───────────
export interface WorkspaceFileDiff {
  path: string;
  oldContent?: string;
  newContent?: string;
  /** Set when content is withheld: binary file or over the size cap. */
  skipped?: 'binary' | 'too-large';
}

export interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** OpenAI 兼容的消息内容：纯文本或内容块数组（图片/文件等）。 */
export type ApiMessageContent = string | Array<Record<string, unknown>>;

export interface ApiMessage {
  role: string;
  content: ApiMessageContent;
}

// ─── Model definitions (single source of truth) ──────────
/** 已知 provider 标识。`ModelProvider` 对其开放扩展：自定义模型可声明任意 provider。 */
export type KnownModelProvider = 'deepseek' | 'openai' | 'anthropic';
export type ModelProvider = KnownModelProvider | (string & {});

/**
 * 线上协议。与 provider 解耦：同一 provider 可走不同协议（DeepSeek 同时提供
 * OpenAI 兼容、Anthropic 兼容与原生 Responses），同一协议也可服务多个 provider。
 */
export type ModelProtocol = 'openai-chat' | 'anthropic-messages' | 'openai-responses';

/** 协议取值校验：设置里的自定义模型可能写入非法值，非法时应回退到端点推断。 */
export function isModelProtocol(value: unknown): value is ModelProtocol {
  return value === 'openai-chat' || value === 'anthropic-messages' || value === 'openai-responses';
}

/** 模型**内在**能力矩阵：把散落在各 provider 里的字符串判断收敛成一份数据。 */
export interface ModelCapabilities {
  /** 支持工具调用。 */
  tools: boolean;
  /** 支持图片输入。 */
  vision: boolean;
  /** 思考开关与强度参数生效（DeepSeek 系自 2026-09 起默认开启思考）。 */
  reasoning: boolean;
}

export interface ModelDefinition {
  id: string;
  name: string;
  provider: ModelProvider;
  /** 显式协议；缺省时由解析出的 `apiBase` 形状推断（见 `resolveModelProtocol`）。 */
  protocol?: ModelProtocol;
  /** 显式能力声明；缺省时按内置元数据与名称启发式推断（见 `modelCapabilities`）。 */
  capabilities?: Partial<ModelCapabilities>;
  maxTokens?: number;
  /** 官方上下文窗口（DeepSeek V4 为 1M）。 */
  contextWindow?: number;
  /** 是否支持图片输入（仅 DeepSeek Vision Exp）。 */
  supportsImages?: boolean;
  /** 官方标记为实验性质的模型。 */
  experimental?: boolean;
  apiBase?: string;
  apiKey?: string;
}

/** 官方端点：strict tools 等 Beta 能力只对官方域名启用，第三方兼容端点不强制。 */
export function isOfficialDeepSeekEndpoint(apiBase: string): boolean {
  return (apiBase || '').includes('api.deepseek.com');
}

/** Anthropic Messages 端点判定（`/messages` 或 `/anthropic/`）。 */
export function isAnthropicFormatEndpoint(apiBase: string): boolean {
  return (apiBase || '').includes('/messages') || (apiBase || '').includes('/anthropic/');
}

/** Responses 端点判定（`apiBase` 以 `/responses` 结尾）。 */
export function isResponsesFormatEndpoint(apiBase: string): boolean {
  return /\/responses\/?$/i.test(apiBase || '');
}

/**
 * 单一协议判定入口：显式 `protocol` 优先，其次按端点形状推断。
 * 迁移目标是把「猜协议」收敛到这里一处，而不是散落在各 provider 里。
 */
export function deriveProtocolFromApiBase(apiBase: string): ModelProtocol {
  if (isResponsesFormatEndpoint(apiBase)) return 'openai-responses';
  if (isAnthropicFormatEndpoint(apiBase)) return 'anthropic-messages';
  return 'openai-chat';
}

/** 解析模型最终使用的协议：内置定义里的显式声明优先，其余按端点推断。 */
export function resolveModelProtocol(modelId: string, apiBase: string): ModelProtocol {
  const id = resolveModelId(modelId).toLowerCase();
  const def = BUILT_IN_MODELS.find((m) => m.id.toLowerCase() === id);
  return def?.protocol ?? deriveProtocolFromApiBase(apiBase);
}

/** 解析模型能力矩阵；未声明的维度按内置元数据与名称启发式兜底。 */
export function modelCapabilities(modelId: string): ModelCapabilities {
  const id = resolveModelId(modelId).toLowerCase();
  const declared = BUILT_IN_MODELS.find((m) => m.id.toLowerCase() === id)?.capabilities;
  return {
    tools: declared?.tools ?? true,
    vision: declared?.vision ?? modelSupportsImageInput(modelId),
    // 思考开关是 DeepSeek 系特有语义；自定义/第三方模型默认不注入 thinking。
    reasoning: declared?.reasoning ?? id.startsWith('deepseek-'),
  };
}

export const BUILT_IN_MODELS: ModelDefinition[] = [
  {
    // 2026-09-10 官方发布 V4.1-Flash：新架构、原生多模态（图片输入）。
    // 官方名 `deepseek-flash`；旧的 flash / flash-vision-exp 名字已被路由到它。
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    provider: 'deepseek',
    maxTokens: 384000,
    contextWindow: 1_000_000,
    supportsImages: true,
    capabilities: { tools: true, vision: true, reasoning: true },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    maxTokens: 384000,
    contextWindow: 1_000_000,
    capabilities: { tools: true, vision: false, reasoning: true },
  },
];

/**
 * 官方已下线的模型名 → 当前规范名。
 * 旧设置里保存的 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 会被
 * 路由到 V4.1 Flash；这里在发请求前统一规范化，避免依赖官方的临时路由。
 * 这些旧名不再出现在模型列表里，只作为兼容别名存在。
 */
export const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
};

/** 把旧模型名规范化为当前模型名（未知模型原样返回）。 */
export function resolveModelId(model: string): string {
  return LEGACY_MODEL_ALIASES[model.toLowerCase()] ?? model;
}

const API_IMAGE_PART_TYPES = new Set(['image_url', 'image', 'file']);
const DEEPSEEK_IMAGE_MIME_TYPES = new Set(['jpeg', 'png', 'gif', 'webp']);

function isApiImagePart(part: unknown): boolean {
  const record = part && typeof part === 'object' && !Array.isArray(part) ? (part as Record<string, unknown>) : {};
  return API_IMAGE_PART_TYPES.has(String(record.type ?? ''));
}

export function apiMessageText(content: ApiMessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 判断模型是否支持图片输入（内置模型使用能力元数据，其余按名称启发式判断）。
 *
 * 先做旧名规范化：旧设置里保存的 `deepseek-v4-flash*` 已不在内置表里，
 * 若不规范化会被启发式判成「不支持图片」，导致历史会话里的图片被静默丢弃。
 */
export function modelSupportsImageInput(model: string): boolean {
  const id = resolveModelId(model).toLowerCase();
  const builtIn = BUILT_IN_MODELS.find((m) => m.id.toLowerCase() === id);
  if (builtIn) return Boolean(builtIn.capabilities?.vision ?? builtIn.supportsImages);
  if (!id.startsWith('deepseek-')) return true;
  return /(vl|vision|omni|multimodal)/.test(id);
}

export function isDeepSeekVisionModel(model: string): boolean {
  return resolveModelId(model).toLowerCase().startsWith('deepseek-') && modelSupportsImageInput(model);
}

/**
 * 按 DeepSeek 官方限制规范化消息：
 *  - 非视觉模型不发送图片块；
 *  - 视觉模型仅允许 user 消息携带图片；
 *  - 图片仅接受 JPEG/PNG/GIF/WebP，其它内联格式降级为文本。
 */
export function normalizeDeepSeekMessageContent(message: ApiMessage, model: string): ApiMessage {
  const content = message.content;
  if (typeof content === 'string' || !/^deepseek-/i.test(model)) return message;

  const hasImage = content.some((part) => isApiImagePart(part));
  if (!hasImage) return message;

  if (!modelSupportsImageInput(model) || message.role !== 'user') {
    return { ...message, content: apiMessageText(content) };
  }

  const filtered = content.filter((part) => {
    if (!isApiImagePart(part)) return true;
    const url =
      (part as Record<string, unknown>).type === 'image_url'
        ? ((part as Record<string, unknown>).image_url as Record<string, unknown> | undefined)?.url
        : undefined;
    if (typeof url !== 'string') return true;
    const mime = /^data:image\/([^;]+);/i.exec(url);
    return !mime || DEEPSEEK_IMAGE_MIME_TYPES.has(mime[1].toLowerCase());
  });

  if (filtered.length === content.length) return message;
  return { ...message, content: apiMessageText(content) };
}

export function normalizeDeepSeekMessages(messages: ApiMessage[], model: string): ApiMessage[] {
  return messages.map((message) => normalizeDeepSeekMessageContent(message, model));
}
