/**
 * annotation.test.ts — 页面标注的渲染。
 *
 * 一份标注有两个读者（模型与用户），必须由同一段文字供给，否则两边会漂移。
 * 这里钉住的是：模型能看到**这是用户手动标注的**、看到元素与选择器、看到评论。
 */
import { describe, it, expect } from 'vitest';
import { annotationLabel, renderAnnotationBlock } from '../annotation';
import type { BrowserAnnotation } from '../../../../electron/contracts/browser';

const base: BrowserAnnotation = {
  id: 'a1',
  url: 'http://localhost:3000/login',
  title: '登录页',
  selector: '#submit',
  elementText: '登录按钮',
  tag: 'button',
  comment: '按钮离顶部太远',
  ts: 1,
};

describe('renderAnnotationBlock', () => {
  it('空列表 → 空串（调用方据此不注入任何东西）', () => {
    expect(renderAnnotationBlock([])).toBe('');
  });

  it('写明"这是用户手动标注"，并带上地址 / 元素 / 选择器 / 评论', () => {
    const block = renderAnnotationBlock([base]);
    expect(block).toContain('用户');
    expect(block).toContain('http://localhost:3000/login');
    expect(block).toContain('登录按钮');
    expect(block).toContain('#submit');
    expect(block).toContain('按钮离顶部太远');
  });

  it('多条标注逐条列出', () => {
    const block = renderAnnotationBlock([base, { ...base, id: 'a2', comment: '第二条' }]);
    expect(block.match(/^- /gm)?.length).toBe(2);
    expect(block).toContain('第二条');
  });
});

describe('annotationLabel', () => {
  it('优先元素文本，过长截断', () => {
    expect(annotationLabel(base)).toBe('登录按钮');
    expect(annotationLabel({ ...base, elementText: 'x'.repeat(80) })?.length).toBeLessThanOrEqual(41);
  });

  it('没有文本时退回标签名，再退回选择器', () => {
    expect(annotationLabel({ ...base, elementText: '' })).toBe('button');
    expect(annotationLabel({ ...base, elementText: '', tag: '' })).toBe('#submit');
  });

  it('空白字符被规范成单个空格（页面文本里换行很多）', () => {
    expect(annotationLabel({ ...base, elementText: '  登录\n   按钮  ' })).toBe('登录 按钮');
  });
});
