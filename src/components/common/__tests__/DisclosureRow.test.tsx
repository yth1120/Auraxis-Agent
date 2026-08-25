// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import DisclosureRow from '../DisclosureRow';

describe('DisclosureRow — 上下文注入披露行', () => {
  it('renders the instructions role with the AGENTS.md producer', () => {
    const { container } = render(
      <DisclosureRow data={{ source: 'instructions', producer: 'AGENTS.md', detail: '项目指令已注入系统提示' }} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('上下文注入');
    expect(text).toContain('AGENTS.md');
    expect(text).toContain('项目指令已注入系统提示');
  });

  it('renders 跨会话召回 for memory recalls', () => {
    const { container } = render(
      <DisclosureRow data={{ source: 'memory', producer: '记忆库', detail: '3 条跨会话记忆' }} />,
    );
    expect(container.textContent).toContain('跨会话召回');
    expect(container.textContent).toContain('记忆库');
    expect(container.textContent).toContain('3 条跨会话记忆');
  });

  it('expands the injected content preview on click', () => {
    const { container } = render(
      <DisclosureRow data={{ source: 'memory', producer: '记忆库', content: '## 项目记忆\n- 决策：使用石墨黑主色' }} />,
    );
    expect(container.textContent).not.toContain('决策：使用石墨黑主色');
    fireEvent.click(container.querySelector('button')!);
    expect(container.textContent).toContain('决策：使用石墨黑主色');
  });
});
