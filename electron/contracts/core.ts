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
export type ModelProvider = 'deepseek';

export interface ModelDefinition {
  id: string;
  name: string;
  provider: ModelProvider;
  maxTokens?: number;
  /** 官方上下文窗口（DeepSeek V4 为 1M）。 */
  contextWindow?: number;
  /** 是否支持图片输入（仅 DeepSeek Vision Exp）。 */
  supportsImages?: boolean;
  /** 官方标记为实验性质的模型。 */
  experimental?: boolean;
  /** 官方已下线、但仍被接受并路由到新模型的旧名字（保留用于兼容已保存的设置）。 */
  legacy?: boolean;
  apiBase?: string;
  apiKey?: string;
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
  },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'deepseek', maxTokens: 384000, contextWindow: 1_000_000 },
  {
    // 旧名（官方已下线对应模型，请求被路由到 V4.1 Flash，按 Flash 计费）。
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash（旧名 → V4.1 Flash）',
    provider: 'deepseek',
    maxTokens: 384000,
    contextWindow: 1_000_000,
    supportsImages: true,
    legacy: true,
  },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision Exp（旧名 → V4.1 Flash）',
    provider: 'deepseek',
    maxTokens: 384000,
    contextWindow: 1_000_000,
    supportsImages: true,
    legacy: true,
  },
];

/**
 * 官方已下线的模型名 → 当前规范名。
 * 旧设置里保存的 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 会被
 * 路由到 V4.1 Flash；这里在发请求前统一规范化，避免依赖官方的临时路由。
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

/** 判断模型是否支持图片输入（内置模型使用能力元数据，其余按名称启发式判断）。 */
export function modelSupportsImageInput(model: string): boolean {
  const id = model.toLowerCase();
  const builtIn = BUILT_IN_MODELS.find((m) => m.id.toLowerCase() === id);
  if (builtIn) return Boolean(builtIn.supportsImages);
  if (!id.startsWith('deepseek-')) return true;
  return /(vl|vision|omni|multimodal)/.test(id);
}

export function isDeepSeekVisionModel(model: string): boolean {
  return model.toLowerCase().startsWith('deepseek-') && modelSupportsImageInput(model);
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
