// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import WorkbenchActionsButton from '../WorkbenchActionsButton';
import { useAppStore } from '@/stores/useAppStore';

describe('WorkbenchActionsButton — 右侧面板开关', () => {
  beforeEach(() => {
    useAppStore.setState({ showRightPanel: false, rightPanelView: 'none' });
  });

  it('首次打开进入功能清单（menu），而不是直接进某个详情', () => {
    const { getByRole } = render(<WorkbenchActionsButton />);
    fireEvent.click(getByRole('button'));
    const s = useAppStore.getState();
    expect(s.showRightPanel).toBe(true);
    expect(s.rightPanelView).toBe('menu');
  });

  it('已经选过功能时，再打开回到上次的功能', () => {
    useAppStore.setState({ showRightPanel: false, rightPanelView: 'file-tree' });
    const { getByRole } = render(<WorkbenchActionsButton />);
    fireEvent.click(getByRole('button'));
    expect(useAppStore.getState().rightPanelView).toBe('file-tree');
  });


  it('hides the panel when already open', () => {
    useAppStore.setState({ showRightPanel: true, rightPanelView: 'inspector' });
    const { getByRole } = render(<WorkbenchActionsButton />);
    fireEvent.click(getByRole('button'));
    expect(useAppStore.getState().showRightPanel).toBe(false);
  });

  it('收起面板时一并退出全屏（否则会残留铺满窗口的固定层挡住点击）', () => {
    useAppStore.setState({ showRightPanel: true, rightPanelView: 'file-tree', rightPanelFullscreen: true });
    const { getByRole } = render(<WorkbenchActionsButton />);
    fireEvent.click(getByRole('button'));
    const s = useAppStore.getState();
    expect(s.showRightPanel).toBe(false);
    expect(s.rightPanelFullscreen).toBe(false);
  });
});
