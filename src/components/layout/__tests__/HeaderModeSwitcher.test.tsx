// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import HeaderModeSwitcher from '../HeaderModeSwitcher';
import { useAppStore } from '@/stores/useAppStore';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('HeaderModeSwitcher — 模式切换按钮组', () => {
  beforeEach(() => {
    (globalThis as any).ResizeObserver = ResizeObserverStub;
    useAppStore.setState({ sidebarMode: 'chat' });
  });

  it('renders three tabs and switches to work/code', () => {
    const { getAllByRole } = render(<HeaderModeSwitcher />);
    const tabs = getAllByRole('radio');
    expect(tabs).toHaveLength(3);
    fireEvent.click(tabs[1]);
    expect(useAppStore.getState().sidebarMode).toBe('work');
    fireEvent.click(tabs[2]);
    expect(useAppStore.getState().sidebarMode).toBe('code');
  });

  it('collapsed variant still switches modes', () => {
    const { getAllByRole } = render(<HeaderModeSwitcher collapsed />);
    const tabs = getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    fireEvent.click(tabs[0]);
    expect(useAppStore.getState().sidebarMode).toBe('chat');
  });
});
