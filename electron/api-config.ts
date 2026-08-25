/** Central DeepSeek endpoint constants and URL derivation. */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/beta/chat/completions';
export const DEEPSEEK_DEFAULT_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic/v1/messages';
export const DEEPSEEK_DEFAULT_MODELS_URL = 'https://api.deepseek.com/v1/models';
export const DEEPSEEK_DEFAULT_BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const DEEPSEEK_DEFAULT_SEARCH_BASE_URL = 'https://api.deepseek.com/anthropic/v1';

export function getDeepSeekBaseUrl(): string {
  return process.env.DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL;
}

export function getDeepSeekAnthropicBaseUrl(): string {
  return process.env.DEEPSEEK_ANTHROPIC_BASE_URL || DEEPSEEK_DEFAULT_ANTHROPIC_BASE_URL;
}

/** Resolve the OpenAI-compatible models endpoint relative to a chat base URL. */
export function getDeepSeekModelsUrl(baseUrl = getDeepSeekBaseUrl()): string {
  if (baseUrl === DEEPSEEK_DEFAULT_BASE_URL) return DEEPSEEK_DEFAULT_MODELS_URL;
  const root = baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions\/?$/i, '')
    .replace(/\/v1$/i, '');
  return root.replace(/\/beta$/i, '') + '/models';
}

export function getDeepSeekBalanceUrl(): string {
  return DEEPSEEK_DEFAULT_BALANCE_URL;
}

export function getDeepSeekSearchBaseUrl(): string {
  return process.env.DEEPSEEK_SEARCH_BASE_URL || DEEPSEEK_DEFAULT_SEARCH_BASE_URL;
}
