import { describe, it, expect } from 'vitest';
import { finalResultFromJsonl } from '../fork-runner';

describe('fork-runner — 结果解析', () => {
  it('从 NDJSON 事件流提取最终结果', () => {
    const stream = [
      JSON.stringify({ type: 'step', text: '中间过程' }),
      JSON.stringify({ type: 'result', result: '最终答案' }),
    ].join('\n');
    expect(finalResultFromJsonl(stream)).toBe('最终答案');
  });

  it('无 JSON 结果时回退到尾部文本', () => {
    const stream = 'line1\nline2\nplain final text';
    expect(finalResultFromJsonl(stream)).toBe('line1\nline2\nplain final text');
  });

  it('result 字段优先于 final_result 和 text 别名', () => {
    const stream = JSON.stringify({
      result: 'primary',
      final_result: 'fallback-1',
      text: 'fallback-2',
    });
    expect(finalResultFromJsonl(stream)).toBe('primary');
  });

  it('忽略非字符串结果并返回最近的自然文本', () => {
    const lines = [JSON.stringify({ result: 123 }), ...Array.from({ length: 25 }, (_, i) => `line-${i}`)];
    expect(finalResultFromJsonl(lines.join('\n'))).toBe(lines.slice(-20).join('\n'));
  });
});
