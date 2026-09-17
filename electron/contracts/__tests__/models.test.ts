import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_MODELS,
  modelSupportsImageInput,
  isDeepSeekVisionModel,
  normalizeDeepSeekMessages,
  resolveModelId,
} from '../core';

describe('DeepSeek built-in model registry', () => {
  it('registers V4.1 Flash, Pro and the two legacy aliases', () => {
    expect(BUILT_IN_MODELS.map((m) => m.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ]);
    // V4.1 Flash 原生多模态，是新的官方默认模型。
    const flash = BUILT_IN_MODELS.find((m) => m.id === 'deepseek-flash');
    expect(flash?.supportsImages).toBe(true);
    expect(flash?.legacy).toBeUndefined();
    expect(flash?.maxTokens).toBe(384000);
    expect(flash?.contextWindow).toBe(1_000_000);
    // 旧名保留但标记 legacy，用于兼容已保存的设置。
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      expect(BUILT_IN_MODELS.find((m) => m.id === id)?.legacy).toBe(true);
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
