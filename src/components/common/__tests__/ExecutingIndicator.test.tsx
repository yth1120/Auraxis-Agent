// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ExecutingIndicator from '../ExecutingIndicator';

/**
 * 这个组件曾是位图（`executing.gif`），用例只断言"有没有 img"。
 * 现在它是品牌矢量标记，断言应该钉住**构成与动画机制**：
 *   · 三个部件（轴 / 光环 / 巡行弧）都在 —— 少一个就不是这个标记了；
 *   · `pathLength=100` + dasharray 是"循环无缝"的实现方式，去掉会跳帧；
 *   · 尺寸必须落到 AGENTS.md 的图标档位。
 */
describe('ExecutingIndicator — Auraxis 运行标记', () => {
  it('渲染出轴 / 光环 / 巡行弧三个部件', () => {
    const { container } = render(<ExecutingIndicator />);
    expect(container.querySelector('svg.ax-axis-mark')).toBeTruthy();
    expect(container.querySelector('.ax-axis-mark__axis')).toBeTruthy();
    expect(container.querySelector('.ax-axis-mark__aura')).toBeTruthy();
    expect(container.querySelector('.ax-axis-mark__comet')).toBeTruthy();
  });

  it('不再是位图（回归钉子：曾用 <img src=executing.gif>）', () => {
    const { container } = render(<ExecutingIndicator />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('巡行弧用 pathLength 归一化 —— 循环处不跳帧的前提', () => {
    const { container } = render(<ExecutingIndicator />);
    const comet = container.querySelector('.ax-axis-mark__comet');
    expect(comet?.getAttribute('pathLength')).toBe('100');
    expect(comet?.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('size 映射到 svg 的宽高', () => {
    const { container } = render(<ExecutingIndicator size={20} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
  });

  it('对读屏隐藏（语义由旁边的 role="status" 文案承担）', () => {
    const { container } = render(<ExecutingIndicator />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
