import { describe, it, expect } from 'vitest';
import { stripModelArtifacts, isAllArtifacts } from '../text-filter';

describe('stripModelArtifacts', () => {
  it('去除 <thinking> 整块（含内容）', () => {
    const input = 'Hello <thinking>internal reasoning here</thinking>World';
    const result = stripModelArtifacts(input);
    expect(result).not.toContain('internal reasoning');
    expect(result).not.toContain('<thinking>');
    expect(result).not.toContain('</thinking>');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('去除 <think> 标签（DeepSeek R1 / Qwen 思考块）', () => {
    const input = 'Answer:<think>Let me think step by step...</think>The result is 42.';
    const result = stripModelArtifacts(input);
    expect(result).not.toContain('<think>');
    expect(result).not.toContain('</think>');
    expect(result).not.toContain('step by step');
    expect(result).toContain('Answer:');
    expect(result).toContain('The result is 42.');
  });

  it('清理 <|im_start|> 等聊天模板标记', () => {
    const input = '<|im_start|>assistant\nHello<|im_end|>';
    const result = stripModelArtifacts(input);
    expect(result).not.toContain('<|im_start|>');
    expect(result).not.toContain('<|im_end|>');
    expect(result).not.toContain('<|assistant|>');
  });

  it('在 artifact 混合时保留非 artifact 的正常文本', () => {
    const input = '<|im_start|>system\nYou are helpful.<|im_end|>\n<|im_start|>user\nHi<|im_end|>';
    const result = stripModelArtifacts(input);
    // Template markers stripped, but text content survives
    expect(result).toContain('system');
    expect(result).toContain('You are helpful');
    expect(result).toContain('user');
    expect(result).toContain('Hi');
    expect(result).not.toContain('<|im_');
  });

  it('清理 data: SSE 标记', () => {
    const input = 'data: {"choices":[]}\n\ndata: {"choices":[{"delta":{"content":"Hi"}}]}';
    const result = stripModelArtifacts(input);
    expect(result).not.toMatch(/^data:\s*/gm);
  });

  it('合并 3+ 连续空行为最多 2 行', () => {
    const input = 'Line 1\n\n\n\n\nLine 2';
    const result = stripModelArtifacts(input);
    // At most 2 consecutive newlines
    expect(result).not.toContain('\n\n\n');
    // Should still contain Line 1 and Line 2
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });

  it('合并 2 行空行保持不变', () => {
    const input = 'Line 1\n\nLine 2';
    const result = stripModelArtifacts(input);
    expect(result).toContain('\n\n');
  });

  it('空字符串不改动', () => {
    expect(stripModelArtifacts('')).toBe('');
  });

  it('不含任何 artifact 的正常文本原样返回', () => {
    const input = 'This is a normal response with no artifacts.';
    const result = stripModelArtifacts(input);
    expect(result).toBe(input);
  });

  it('同时存在多种 artifact 时全部清理', () => {
    const input =
      '<|im_start|>assistant\n' +
      '<thinking>Plan the answer</thinking>\n' +
      'Here is the final output.\n' +
      '<|im_end|>';
    const result = stripModelArtifacts(input);
    expect(result).not.toContain('<|im_start|>');
    expect(result).not.toContain('<|im_end|>');
    expect(result).not.toContain('<thinking>');
    expect(result).not.toContain('</thinking>');
    expect(result).not.toContain('Plan the answer');
    expect(result).toContain('Here is the final output');
  });

  it('多行 thinking 块跨行清除', () => {
    const input = ['Before', '<thinking>', 'Line 1 of reasoning', 'Line 2 of reasoning', '</thinking>', 'After'].join(
      '\n',
    );
    const result = stripModelArtifacts(input);
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('reasoning');
    expect(result).not.toContain('<thinking>');
  });
});

describe('isAllArtifacts', () => {
  it('纯 artifact 文本返回 true', () => {
    // Only template markers, no real content
    expect(isAllArtifacts('<|im_start|><|im_end|>')).toBe(true);
    expect(isAllArtifacts('<thinking>just thinking</thinking>')).toBe(true);
    expect(isAllArtifacts('<think>reasoning</think>')).toBe(true);
  });

  it('纯空白/零宽字符返回 true（去除 artifact 后为空）', () => {
    // Only SSE markers and whitespace
    expect(isAllArtifacts('data: \n')).toBe(true);
  });

  it('正常文本返回 false', () => {
    expect(isAllArtifacts('Hello world')).toBe(false);
    expect(isAllArtifacts('const x = 1;')).toBe(false);
  });

  it('混合文本（artifact + 正常内容）返回 false', () => {
    expect(isAllArtifacts('<|im_start|>assistant\nHello<|im_end|>')).toBe(false);
    expect(isAllArtifacts('<thinking>plan</thinking>\nActual answer')).toBe(false);
  });

  it('空字符串返回 true（无内容即全为 artifact）', () => {
    expect(isAllArtifacts('')).toBe(true);
  });

  it('仅含空白字符返回 true', () => {
    expect(isAllArtifacts('   \t\n  ')).toBe(true);
  });
});

describe('createStreamFilter — 跨 chunk 有状态过滤', () => {
  it('吞掉跨 chunk 的 <function> 预演块', async () => {
    const { createStreamFilter } = await import('../text-filter');
    const f = createStreamFilter();
    expect(f('我先创建任务清单。<function>')).toBe('我先创建任务清单。');
    expect(f('<TodoWrite>{"tasks":[...]}\n执行假装')).toBe(''); // 全部在块内
    expect(f('结束</function>之后是正文')).toBe('之后是正文'); // 跨块闭合
  });

  it('剥除 <FINAL_ANSWER> 停止标记', async () => {
    const { createStreamFilter } = await import('../text-filter');
    const f = createStreamFilter();
    expect(f('任务完成。<FINAL_ANSWER>')).toBe('任务完成。');
  });

  it('正常文本原样透传', async () => {
    const { createStreamFilter } = await import('../text-filter');
    const f = createStreamFilter();
    expect(f('普通的一段文字，无任何标记。')).toBe('普通的一段文字，无任何标记。');
  });
});
