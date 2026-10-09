// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RightPanelDetailHeader, RightPanelMenu, WorkbenchRightAside } from '../WorkbenchRightPanelNav';
import { useAppStore } from '@/stores/useAppStore';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

/**
 * 右侧栏「清单 → 详情」两态的核心契约：
 *  · 清单态：**一次性全部列出**、自上而下一行一个（不折叠 —— 让清单短的正确做法
 *    是删掉重复功能，而不是把它们藏起来）；
 *  · **清单里没有 `+`**：`+` 是"给当前这个模块新增一个条目"，只出现在详情头里；
 *  · 未接线的能力不占位（注册表仍保留真实能力判断，接上就自动回来）。
 */
describe('右侧栏功能清单', () => {
  it('一次列全部可用功能，自上而下（没有折叠入口）', () => {
    const { getByText, queryByText, getAllByRole } = render(<RightPanelMenu onSelect={() => {}} />);

    for (const label of ['概览', '计划', '变更', '文件', '执行详情', '时间线', '预览']) {
      expect(getByText(label), `清单缺少「${label}」`).toBeTruthy();
    }
    expect(getAllByRole('button')).toHaveLength(7);
    // 折叠入口已移除
    expect(queryByText(/更多功能/)).toBeNull();
    expect(queryByText('收起')).toBeNull();
  });

  it('七行**每一行**都带快捷键提示（补上了此前空着的概览 / 计划 / 文件）', () => {
    const { getByText } = render(<RightPanelMenu onSelect={() => {}} />);

    for (const hint of [
      'Ctrl+Shift+5', // 概览
      'Ctrl+Shift+6', // 计划
      'Ctrl+Shift+3', // 变更
      'Ctrl+Shift+7', // 文件
      'Ctrl+Shift+1', // 执行详情
      'Ctrl+Shift+2', // 时间线
      'Ctrl+Shift+4', // 预览
    ]) {
      expect(getByText(hint), `清单缺少快捷键提示 ${hint}`).toBeTruthy();
    }
  });

  it('「产物」已并入「变更」，不再单独占一行（它列的就是同一批改动文件）', () => {
    const { queryByText } = render(<RightPanelMenu onSelect={() => {}} />);

    expect(queryByText('产物')).toBeNull();
    // 变更面板仍在，且带快捷键提示
    expect(queryByText('变更')).toBeTruthy();
    expect(queryByText('Ctrl+Shift+3')).toBeTruthy();
  });

  it('未接线的能力不占位（不留两个永远灰着的行）', () => {
    const { queryByText } = render(<RightPanelMenu onSelect={() => {}} />);

    expect(queryByText('Pull Request')).toBeNull();
    expect(queryByText('Computer Use')).toBeNull();
  });

  it('清单里**没有** `+`（`+` 属于详情头）', () => {
    const { queryByLabelText } = render(<RightPanelMenu onSelect={() => {}} />);

    expect(queryByLabelText(/在新的一栏打开/)).toBeNull();
    expect(queryByLabelText('新建文件')).toBeNull();
  });

  it('点某一行把该功能的 key 交回调用方（进入详情）', () => {
    const onSelect = vi.fn();
    const { getByText } = render(<RightPanelMenu onSelect={onSelect} />);

    fireEvent.click(getByText('变更'));
    expect(onSelect).toHaveBeenCalledWith('diff');
  });
});

describe('右侧栏详情头部', () => {
  beforeEach(() => {
    useSettingsStore.setState({ projectPath: 'C:/proj' });
  });

  it('显示当前功能名与返回键', () => {
    const onBack = vi.fn();
    const { getByText, getByLabelText } = render(
      <RightPanelDetailHeader view="diff" compact={false} onBack={onBack} />,
    );

    expect(getByText('变更')).toBeTruthy();
    fireEvent.click(getByLabelText('返回'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('`+` 是"给这个模块新增条目"，**不是**"再开一栏"（那件事由分栏按钮做）', () => {
    const { getByLabelText, queryByLabelText } = render(
      <RightPanelDetailHeader view="file-tree" compact={false} onBack={() => {}} />,
    );

    // 文件模块的 `+` = 新建文件，标签写明新建的是什么
    fireEvent.click(getByLabelText('新建文件'));
    expect(useFileTreeStore.getState().pendingCreate).toEqual({ parentPath: 'C:/proj', type: 'createFile' });
    // 与"再开一栏"无关：分栏按钮才是那个
    expect(queryByLabelText(/在新的一栏打开/)).toBeNull();
    expect(getByLabelText('分栏')).toBeTruthy();
  });

  it('没有可新增实体的模块不画 `+`（不放点了没反应的按钮）', () => {
    const { queryByLabelText } = render(
      <RightPanelDetailHeader view="diff" compact={false} onBack={() => {}} />,
    );

    expect(queryByLabelText('新建文件')).toBeNull();
  });

  it('没打开项目时也不画 `+`（新建文件无处可建）', () => {
    useSettingsStore.setState({ projectPath: '' });
    const { queryByLabelText } = render(
      <RightPanelDetailHeader view="file-tree" compact={false} onBack={() => {}} />,
    );

    expect(queryByLabelText('新建文件')).toBeNull();
  });

  it('窄面板时不显示快捷键提示，但功能名与返回键仍在', () => {
    const { getByText, getByLabelText, queryByText } = render(
      <RightPanelDetailHeader view="inspector" compact onBack={() => {}} />,
    );

    expect(getByText('执行详情')).toBeTruthy();
    expect(getByLabelText('返回')).toBeTruthy();
    expect(queryByText('Ctrl+Shift+1')).toBeNull();
  });
});

describe('右侧栏全屏与分栏', () => {
  beforeEach(() => {
    useAppStore.setState({ rightPanelFullscreen: false, rightPanelSplit: false, rightPanelView2: 'menu' });
  });

  it('全屏开关切换 rightPanelFullscreen，并在全屏时给出退出入口', () => {
    const { getByLabelText, rerender } = render(
      <RightPanelDetailHeader view="diff" compact={false} onBack={() => {}} />,
    );

    fireEvent.click(getByLabelText('全屏'));
    expect(useAppStore.getState().rightPanelFullscreen).toBe(true);

    rerender(<RightPanelDetailHeader view="diff" compact={false} onBack={() => {}} />);
    expect(getByLabelText('退出全屏')).toBeTruthy();

    fireEvent.click(getByLabelText('退出全屏'));
    expect(useAppStore.getState().rightPanelFullscreen).toBe(false);
  });

  it('分栏开关切换 rightPanelSplit；全屏时不再显示分栏按钮', () => {
    const { getByLabelText, queryByLabelText } = render(
      <RightPanelDetailHeader view="file-tree" compact={false} onBack={() => {}} />,
    );

    fireEvent.click(getByLabelText('分栏'));
    expect(useAppStore.getState().rightPanelSplit).toBe(true);

    useAppStore.setState({ rightPanelFullscreen: true });
    render(<RightPanelDetailHeader view="file-tree" compact={false} onBack={() => {}} />);
    expect(queryByLabelText('分栏')).toBeNull();
  });

  it('第二栏头部只提供「关闭分栏」，不重复全屏/分栏按钮', () => {
    useAppStore.setState({ rightPanelSplit: true });
    const { getByLabelText, queryByLabelText } = render(
      <RightPanelDetailHeader view="timeline" pane={2} compact={false} onBack={() => {}} />,
    );

    expect(queryByLabelText('全屏')).toBeNull();
    expect(queryByLabelText('分栏')).toBeNull();

    fireEvent.click(getByLabelText('关闭分栏'));
    expect(useAppStore.getState().rightPanelSplit).toBe(false);
  });
});

describe('右侧栏左右分栏', () => {
  beforeEach(() => {
    useAppStore.setState({
      rightPanelFullscreen: false,
      rightPanelSplit: true,
      // 两栏都停在清单态：断言的是外框结构，不触发各功能面板的懒加载。
      rightPanelView: 'menu',
      rightPanelView2: 'menu',
    });
  });

  it('两栏左右并排（同一行 flex，中轴是竖 hairline），不再上下堆叠', () => {
    const { container } = render(<WorkbenchRightAside compact={false} />);
    const aside = container.firstElementChild as HTMLElement;
    expect(aside.className).toContain('flex');
    expect(aside.className).not.toContain('flex-col');

    const panes = container.querySelectorAll('[data-pane="1"], [data-pane="2"]');
    expect(panes).toHaveLength(2);
    for (const pane of Array.from(panes)) {
      expect(pane.className).toContain('flex-1');
      expect(pane.className).toContain('min-w-0');
    }

    const divider = aside.querySelector('div[aria-hidden="true"]') as HTMLElement;
    expect(divider.className).toContain('w-px');
    expect(divider.className).toContain('my-2');
  });
});
