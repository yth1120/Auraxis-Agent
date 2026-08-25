import { describe, it, expect } from 'vitest';
import { BUILT_IN_MODELS, modelSupportsImageInput, isDeepSeekVisionModel, normalizeDeepSeekMessages } from '../core';

describe('DeepSeek built-in model registry', () => {
  it('registers Flash, Pro, and the experimental Vision model', () => {
    expect(BUILT_IN_MODELS.map((m) => m.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ]);
    const vision = BUILT_IN_MODELS.find((m) => m.id === 'deepseek-v4-flash-vision-exp');
    expect(vision?.supportsImages).toBe(true);
    expect(vision?.experimental).toBe(true);
    expect(vision?.maxTokens).toBe(384000);
  });

  it('routes image capabilities through model metadata / heuristic', () => {
    expect(modelSupportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(modelSupportsImageInput('deepseek-v4-flash')).toBe(false);
    expect(modelSupportsImageInput('gpt-4o')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(isDeepSeekVisionModel('deepseek-v4-pro')).toBe(false);
  });

  it('keeps user image blocks for the Vision model and degrades for other roles/models', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
    const user = { role: 'user', content: [{ type: 'text', text: '看图' }, imagePart] };
    expect(normalizeDeepSeekMessages([user], 'deepseek-v4-flash-vision-exp')[0]).toEqual(user);
    expect(normalizeDeepSeekMessages([user], 'deepseek-v4-flash')[0].content).toBe('看图');

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
