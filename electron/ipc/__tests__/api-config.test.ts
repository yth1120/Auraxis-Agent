import { describe, expect, it, afterEach } from 'vitest';
import {
  DEEPSEEK_DEFAULT_ANTHROPIC_BASE_URL,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_BALANCE_URL,
  DEEPSEEK_DEFAULT_MODELS_URL,
  DEEPSEEK_DEFAULT_SEARCH_BASE_URL,
  getDeepSeekAnthropicBaseUrl,
  getDeepSeekBalanceUrl,
  getDeepSeekBaseUrl,
  getDeepSeekModelsUrl,
  getDeepSeekSearchBaseUrl,
} from '../../api-config';

afterEach(() => {
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_ANTHROPIC_BASE_URL;
  delete process.env.DEEPSEEK_SEARCH_BASE_URL;
});

describe('DeepSeek endpoint config', () => {
  it('exposes stable official defaults', () => {
    expect(getDeepSeekBaseUrl()).toBe(DEEPSEEK_DEFAULT_BASE_URL);
    expect(getDeepSeekAnthropicBaseUrl()).toBe(DEEPSEEK_DEFAULT_ANTHROPIC_BASE_URL);
    expect(getDeepSeekModelsUrl()).toBe(DEEPSEEK_DEFAULT_MODELS_URL);
    expect(getDeepSeekBalanceUrl()).toBe(DEEPSEEK_DEFAULT_BALANCE_URL);
    expect(getDeepSeekSearchBaseUrl()).toBe(DEEPSEEK_DEFAULT_SEARCH_BASE_URL);
  });

  it('honors environment overrides for chat, Anthropic, and search endpoints', () => {
    process.env.DEEPSEEK_BASE_URL = 'https://proxy.example.com/v1/chat/completions';
    process.env.DEEPSEEK_ANTHROPIC_BASE_URL = 'https://proxy.example.com/anthropic/v1/messages';
    process.env.DEEPSEEK_SEARCH_BASE_URL = 'https://proxy.example.com/anthropic/v1';

    expect(getDeepSeekBaseUrl()).toBe('https://proxy.example.com/v1/chat/completions');
    expect(getDeepSeekAnthropicBaseUrl()).toBe('https://proxy.example.com/anthropic/v1/messages');
    expect(getDeepSeekSearchBaseUrl()).toBe('https://proxy.example.com/anthropic/v1');
  });

  it('derives the models endpoint from chat-completions and beta URLs', () => {
    expect(getDeepSeekModelsUrl('https://proxy.example.com/v1/chat/completions')).toBe(
      'https://proxy.example.com/models',
    );
    expect(getDeepSeekModelsUrl('https://proxy.example.com/beta/chat/completions')).toBe(
      'https://proxy.example.com/models',
    );
  });
});
