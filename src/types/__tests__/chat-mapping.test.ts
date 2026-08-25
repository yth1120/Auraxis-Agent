import { describe, it, expect } from 'vitest';
import { mapThinkingLevelToEffort, modelSupportsImageInput, toApiMessageContent } from '../chat';

describe('mapThinkingLevelToEffort — UI 三档 → DeepSeek API 三档', () => {
  it('轻度→low、中度→high、深度→max', () => {
    expect(mapThinkingLevelToEffort('low')).toBe('low');
    expect(mapThinkingLevelToEffort('medium')).toBe('high');
    expect(mapThinkingLevelToEffort('high')).toBe('max');
  });
});

describe('vision model content mapping', () => {
  it('parses composer image blocks into OpenAI image_url parts', () => {
    const raw = '看图\n【图片: a.png】\ndata:image/png;base64,AA==\n后续';
    const out = toApiMessageContent(raw, true) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ type: 'text', text: '看图\n' });
    expect(out[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } });
    expect(out[2]).toEqual({ type: 'text', text: '\n后续' });
  });

  it('keeps raw text for non-vision models', () => {
    expect(toApiMessageContent('看图\n【图片: a.png】\ndata:image/png;base64,AA==', false)).toBe('看图\n【图片: a.png】\ndata:image/png;base64,AA==');
  });

  it('recognizes the built-in vision model', () => {
    expect(modelSupportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true);
    expect(modelSupportsImageInput('deepseek-v4-pro')).toBe(false);
  });
});
