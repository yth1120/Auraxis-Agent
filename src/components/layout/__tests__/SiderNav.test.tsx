// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import SiderNav from '../SiderNav';
import { useAppStore } from '@/stores/useAppStore';
import { useChatStore } from '@/stores/useChatStore';

describe('SiderNav — 侧栏按钮组', () => {
  beforeEach(() => {
    useAppStore.setState({
      sidebarMode: 'code',
      sidebarCollapsed: false,
      showSettings: false,
      activeToolView: 'none',
      settingsInitialKey: 'general',
    });
    useChatStore.setState({ pendingNewTask: false });
  });

  it('renders new-task entry and arms a fresh task', () => {
    const { getByText } = render(<SiderNav collapsed={false} />);
    fireEvent.click(getByText('新建对话'));
    expect(useChatStore.getState().pendingNewTask).toBe(true);
  });

  it('renders tools directly without the tools button', () => {
    const { queryByText, getByText } = render(<SiderNav collapsed={false} />);
    expect(queryByText('工具')).toBeNull();
    expect(getByText('技能')).toBeTruthy();
  });

  it('opens settings from the avatar menu', () => {
    const { getByLabelText, getByText } = render(<SiderNav collapsed={false} />);
    fireEvent.click(getByLabelText('账户'));
    fireEvent.click(getByText('设置'));
    expect(useAppStore.getState().showSettings).toBe(true);
  });
});
