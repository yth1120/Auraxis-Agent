import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_MODELS,
  deriveProtocolFromApiBase,
  isModelProtocol,
  isOfficialDeepSeekEndpoint,
  modelCapabilities,
  modelSupportsImageInput,
  isDeepSeekVisionModel,
  normalizeDeepSeekMessages,
  resolveModelId,
  resolveModelProtocol,
} from '../core';

describe('DeepSeek built-in model registry', () => {
  it('只注册当前在售模型：V4.1 Flash 与 V4 Pro', () => {
    expect(BUILT_IN_MODELS.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    // V4.1 Flash 原生多模态，是新的官方默认模型。
    const flash = BUILT_IN_MODELS.find((m) => m.id === 'deepseek-flash');
    expect(flash?.supportsImages).toBe(true);
    expect(flash?.maxTokens).toBe(384000);
    expect(flash?.contextWindow).toBe(1_000_000);
    // 旧名不再作为独立条目出现，只保留兼容别名（见下一个用例）。
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(BUILT_IN_MODELS.some((m) => m.id === id)).toBe(false);
    }
    // Pro 不支持图片。
    expect(BUILT_IN_MODELS.find((m) => m.id === 'deepseek-v4-pro')?.supportsImages).toBeUndefined();
  });

  it('legacy 名字被规范化到 deepseek-flash', () => {
    expect(resolveModelId('deepseek-v4-flash')).toBe('deepseek-flash');
    expect(resolveModelId('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash');
    expect(resolveModelId('deepseek-flash')).toBe('deepseek-flash');
    expect(resolveModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(resolveModelId('custom-model')).toBe('custom-model');
  });

  it('routes image capabilities through model metadata / heuristic', () => {
    expect(modelSupportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(modelSupportsImageInput('deepseek-v4-flash')).toBe(true);
    expect(modelSupportsImageInput('deepseek-flash')).toBe(true);
    expect(modelSupportsImageInput('gpt-4o')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-flash')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-v4-pro')).toBe(false);
  });

  it('derives the protocol from the endpoint shape (single decision point)', () => {
    expect(deriveProtocolFromApiBase('https://api.deepseek.com/beta/chat/completions')).toBe('openai-chat');
    expect(deriveProtocolFromApiBase('https://api.deepseek.com/anthropic/v1/messages')).toBe('anthropic-messages');
    expect(deriveProtocolFromApiBase('https://api.deepseek.com/responses')).toBe('openai-responses');
    // 端点优先判定：/responses 即使同时含 /anthropic/ 也走 Responses
    expect(deriveProtocolFromApiBase('https://x/anthropic/responses')).toBe('openai-responses');
    expect(deriveProtocolFromApiBase('')).toBe('openai-chat');
  });

  it('resolveModelProtocol 归一化旧模型名并跟随端点', () => {
    // 内置模型不写死协议：同一个模型换端点即换协议。
    expect(resolveModelProtocol('deepseek-flash', 'https://api.deepseek.com/responses')).toBe('openai-responses');
    expect(resolveModelProtocol('deepseek-flash', 'https://api.deepseek.com/beta/chat/completions')).toBe(
      'openai-chat',
    );
    // 旧名归一化后仍能命中内置定义。
    expect(resolveModelProtocol('deepseek-v4-flash', 'https://api.deepseek.com/anthropic/v1/messages')).toBe(
      'anthropic-messages',
    );
    // 未知模型同样按端点推断。
    expect(resolveModelProtocol('custom-model', 'https://x/v1/chat/completions')).toBe('openai-chat');
  });

  it('exposes a capability matrix instead of scattered string checks', () => {
    expect(modelCapabilities('deepseek-flash')).toEqual({ tools: true, vision: true, reasoning: true });
    expect(modelCapabilities('deepseek-v4-pro')).toEqual({ tools: true, vision: false, reasoning: true });
    // 旧名归一化后命中同一份能力声明。
    expect(modelCapabilities('deepseek-v4-flash-vision-exp')).toEqual({
      tools: true,
      vision: true,
      reasoning: true,
    });
    // 自定义模型：不注入 thinking，图片仍按启发式放行。
    expect(modelCapabilities('my-custom-model')).toEqual({ tools: true, vision: true, reasoning: false });
    expect(modelCapabilities('gpt-4o')).toEqual({ tools: true, vision: true, reasoning: false });
  });

  it('strict tools 只认官方端点', () => {
    expect(isOfficialDeepSeekEndpoint('https://api.deepseek.com/beta/chat/completions')).toBe(true);
    expect(isOfficialDeepSeekEndpoint('https://api.deepseek.com/responses')).toBe(true);
    expect(isOfficialDeepSeekEndpoint('https://my-proxy.example.com/v1/chat/completions')).toBe(false);
    expect(isOfficialDeepSeekEndpoint('')).toBe(false);
  });

  it('协议取值有守卫（设置里写错时回退到端点推断）', () => {
    expect(isModelProtocol('openai-chat')).toBe(true);
    expect(isModelProtocol('anthropic-messages')).toBe(true);
    expect(isModelProtocol('openai-responses')).toBe(true);
    expect(isModelProtocol('bogus')).toBe(false);
    expect(isModelProtocol(undefined)).toBe(false);
    expect(isModelProtocol(42)).toBe(false);
  });

  it('keeps user image blocks for the Vision model and degrades for other roles/models', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
    const user = { role: 'user', content: [{ type: 'text', text: '看图' }, imagePart] };
    expect(normalizeDeepSeekMessages([user], 'deepseek-flash')[0]).toEqual(user);
    expect(normalizeDeepSeekMessages([user], 'deepseek-v4-pro')[0].content).toBe('看图');

    const system = { role: 'system', content: [{ type: 'text', text: '规则' }, imagePart] };
    expect(normalizeDeepSeekMessages([system], 'deepseek-v4-flash-vision-exp')[0].content).toBe('规则');

    const svg = {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,AA==' } },
      ],
    };
    expect(normalizeDeepSeekMessages([svg], 'deepseek-v4-flash-vision-exp')[0].content).toBe('看图');
  });
});
