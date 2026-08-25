// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import CommandDropdown from '../CommandDropdown';

const items = [
  { name: 'clear', description: '清空', usage: '/clear' },
  { name: 'plan', description: '计划', usage: '/plan' },
] as any;

describe('CommandDropdown — 斜杠命令按钮列表', () => {
  it('renders items and selects on click', () => {
    const onSelect = vi.fn();
    const { getByText } = render(<CommandDropdown items={items} selected={0} onSelect={onSelect} onHover={() => {}} />);
    fireEvent.mouseDown(getByText('clear'));
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });
});
