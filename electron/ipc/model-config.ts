import { readSettings } from './settings-store';
import { getDeepSeekBaseUrl } from '../api-config';
import { BUILT_IN_MODELS } from '../types';
import type { ModelDefinition } from '../types';

export type { ModelDefinition };

export function getProvider(_modelId: string): 'deepseek' {
  return 'deepseek';
}

/**
 * Default API endpoint: OpenAI-compatible format (verified stable).
 * Set DEEPSEEK_ANTHROPIC_BASE_URL to opt into the Anthropic-compatible endpoint,
 * which provides native thinking blocks and structured SSE.
 */
export function getDefaultApiBase(): string {
  return getDeepSeekBaseUrl();
}

/** Parse custom models from AURAXIS_MODELS env var (JSON) — cached */
let _cachedEnvModels: ModelDefinition[] | null = null;
function parseEnvModels(): ModelDefinition[] {
  if (_cachedEnvModels) return _cachedEnvModels;
  try {
    const raw = process.env.AURAXIS_MODELS;
    if (!raw) {
      _cachedEnvModels = [];
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      _cachedEnvModels = [];
      return [];
    }
    _cachedEnvModels = parsed
      .filter(
        (m): m is Record<string, unknown> =>
          !!m && typeof m === 'object' && !Array.isArray(m) && typeof m.id === 'string' && typeof m.name === 'string',
      )
      .map((m) => ({
        id: m.id as string,
        name: m.name as string,
        provider: 'deepseek' as const,
        maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : undefined,
        contextWindow:
          typeof m.contextWindow === 'number'
            ? m.contextWindow
            : typeof m.context_window === 'number'
              ? m.context_window
              : undefined,
        supportsImages: m.supportsImages === true || m.supports_images === true,
        experimental: m.experimental === true,
        apiBase: typeof m.apiBase === 'string' ? m.apiBase : typeof m.api_base === 'string' ? m.api_base : undefined,
        apiKey: typeof m.apiKey === 'string' ? m.apiKey : typeof m.api_key === 'string' ? m.api_key : undefined,
      }));
    return _cachedEnvModels;
  } catch {
    _cachedEnvModels = [];
    return [];
  }
}

/** Resolve API base URL for a model */
export function resolveApiBase(modelId: string): string {
  const envModels = parseEnvModels();
  const envMatch = envModels.find((m) => m.id === modelId);
  if (envMatch?.apiBase) return envMatch.apiBase;
  return getDefaultApiBase();
}

/** 异步解析模型专属端点：优先环境变量，其次设置中的持久化自定义模型。 */
export async function resolveModelApiBase(modelId: string): Promise<string> {
  const envModels = parseEnvModels();
  const envMatch = envModels.find((m) => m.id === modelId);
  if (envMatch?.apiBase) return envMatch.apiBase;
  try {
    const settings = await readSettings();
    const saved = settings.customModels as ModelDefinition[] | undefined;
    const savedMatch = Array.isArray(saved) ? saved.find((m) => m.id === modelId) : undefined;
    if (savedMatch?.apiBase) return savedMatch.apiBase;
  } catch {
    /* 设置不可读时回退默认端点 */
  }
  return getDefaultApiBase();
}

/** 异步解析模型专属 API Key（环境变量 > 持久化自定义模型）。 */
export async function resolveModelApiKey(modelId: string): Promise<string | undefined> {
  const envModels = parseEnvModels();
  const envMatch = envModels.find((m) => m.id === modelId);
  if (envMatch?.apiKey) return envMatch.apiKey;
  try {
    const settings = await readSettings();
    const saved = settings.customModels as ModelDefinition[] | undefined;
    const savedMatch = Array.isArray(saved) ? saved.find((m) => m.id === modelId) : undefined;
    if (savedMatch?.apiKey) return savedMatch.apiKey;
  } catch {
    /* 设置不可读时回退默认密钥 */
  }
  return undefined;
}

/** Get all available models (built-in + env custom + persisted custom) */
export async function getAllModels(): Promise<ModelDefinition[]> {
  const models = [...BUILT_IN_MODELS];

  // Merge env custom models
  const envModels = parseEnvModels();
  for (const em of envModels) {
    if (!models.find((m) => m.id === em.id)) {
      models.push(em);
    }
  }

  // Merge persisted custom models from settings
  const settings = await readSettings();
  const savedModels = settings.customModels as ModelDefinition[] | undefined;
  if (savedModels && Array.isArray(savedModels)) {
    for (const sm of savedModels) {
      if (!models.find((m) => m.id === sm.id)) {
        models.push(sm);
      }
    }
  }

  return models;
}
