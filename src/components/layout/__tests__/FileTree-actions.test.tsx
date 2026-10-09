// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import FileTree from '../FileTree';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useSettingsStore } from '@/stores/useSettingsStore';

/**
 * 回归：行内操作按钮的 hover 门控与删除确认气泡的关系。
 *
 * 曾经的 bug：`Popconfirm` 气泡是挂 body 的 portal，位置在行**外面**；鼠标从行里走向
 * 气泡必然先离开行 → 行的 onMouseLeave 清 hoveredPath → `renderActions` 返回 null →
 * 触发按钮被卸载 → 气泡跟着关掉。用户看到的就是"手还没点到，删除面板就没了"。
 */
const TREE = {
  path: '/p',
  name: 'p',
  isDirectory: true,
  children: [{ path: '/p/a.ts', name: 'a.ts', isDirectory: false }],
};

function rowOf(container: HTMLElement, name: string): HTMLElement {
  const label = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === name);
  if (!label) throw new Error(`没找到文件行：${name}`);
  const row = label.closest('div');
  if (!row) throw new Error('行容器不存在');
  return row as HTMLElement;
}

describe('FileTree — 行内操作按钮', () => {
  beforeEach(() => {
    // projectPath 必须有值，否则组件只渲染「选择项目目录」空态（FileTree.tsx:330）。
    useSettingsStore.setState({ projectPath: '/p' });
    useFileTreeStore.setState({
      tree: TREE,
      expandedPaths: new Set(['/p']),
      loading: false,
      error: null,
      projectRoot: '/p',
      pendingCreate: null,
    });
    // 挂载时 useFileTreeActions 会拉一次树；返回同一棵树，避免把测试数据冲掉。
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      project: { getTree: vi.fn(async () => ({ ok: true, data: TREE })) },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('默认不显示操作按钮，hover 该行才显示', async () => {
    const { container, queryByLabelText } = render(<FileTree />);
    await act(async () => {});

    expect(queryByLabelText('删除')).toBeNull();

    fireEvent.mouseEnter(rowOf(container, 'a.ts'));
    expect(queryByLabelText('删除')).toBeTruthy();
    expect(queryByLabelText('重命名')).toBeTruthy();
  });

  it('确认气泡打开后，鼠标离开该行按钮**不消失**（回归：删除面板提前关闭）', async () => {
    const { container, queryByLabelText, getByRole } = render(<FileTree />);
    await act(async () => {});

    const row = rowOf(container, 'a.ts');
    fireEvent.mouseEnter(row);
    await act(async () => {
      fireEvent.click(queryByLabelText('删除')!);
    });
    // antd 会在两个汉字之间插空格（"取 消"），所以用正则而不是精确串。
    expect(getByRole('button', { name: /取\s*消/ }), '确认气泡没打开').toBeTruthy();

    // 鼠标走向气泡的过程 = 离开该行；按钮与气泡都必须还在
    fireEvent.mouseLeave(row);
    expect(queryByLabelText('删除'), '鼠标离开行后删除按钮被卸载了，气泡会跟着关').toBeTruthy();
  });

  it('取消气泡后按钮回到 hover 门控（不会永久钉住）', async () => {
    const { container, queryByLabelText, getByRole } = render(<FileTree />);
    await act(async () => {});

    const row = rowOf(container, 'a.ts');
    fireEvent.mouseEnter(row);
    await act(async () => {
      fireEvent.click(queryByLabelText('删除')!);
    });
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /取\s*消/ }));
    });

    fireEvent.mouseLeave(row);
    expect(queryByLabelText('删除')).toBeNull();
  });
});
