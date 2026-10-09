// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * 工具视图（通知 / 定时 / 插件 / 技能）直接占满主界面：
 * 这些面板本身是 ToolViewShell 页面级布局，塞进 440px 抽屉会把内容挤碎。
 * 这里同时钉住「不再是窄抽屉 + 遮罩」与「四个入口各自路由到对应面板」。
 */
vi.mock('../../tools/NotificationsPanel', () => ({ default: () => <div data-testid="notifications" /> }));
vi.mock('../../tools/ScheduledPanel', () => ({ default: () => <div data-testid="scheduled" /> }));
vi.mock('../../tools/PluginsPanel', () => ({ default: () => <div data-testid="plugins" /> }));
vi.mock('../../skills/SkillsDirectory', () => ({ default: () => <div data-testid="skills" /> }));

import { ChatToolOverlay } from '../ChatAreaOverlays';

describe('ChatToolOverlay — 工具视图占满主界面', () => {
  it.each([
    ['notifications', 'notifications'],
    ['scheduled', 'scheduled'],
    ['plugins', 'plugins'],
    ['skills', 'skills'],
  ])('%s 路由到对应面板', async (view, testId) => {
    const { getByTestId } = render(<ChatToolOverlay activeToolView={view} onClose={() => {}} />);
    await waitFor(() => expect(getByTestId(testId)).toBeTruthy());
  });

  it('容器铺满主界面，但让开顶部悬浮栏（不盖顶栏、无遮罩）', async () => {
    const { container, getByTestId } = render(
      <ChatToolOverlay activeToolView="plugins" onClose={() => {}} topInset={52} />,
    );
    await waitFor(() => expect(getByTestId('plugins')).toBeTruthy());

    const root = container.firstElementChild as HTMLElement;
    // 左右下铺满，但顶部从悬浮栏下沿开始，且层级低于顶栏（z-30）
    expect(root.className).toContain('absolute');
    expect(root.className).toContain('inset-x-0');
    expect(root.className).toContain('bottom-0');
    expect(root.className).not.toContain('inset-0');
    expect(root.style.top).toBe('52px');
    expect(root.className).toContain('z-20');
    expect(root.className).not.toContain('z-30');
    // 旧的窄抽屉（440px）与点击遮罩都不应再出现
    expect(root.className).not.toContain('w-[440px]');
    expect(container.querySelector('.bg-black\\/20')).toBeNull();
  });

  it('顶部栏高度未测量出来时也不会盖住它（默认 0 只是让面板贴顶）', async () => {
    const { container, getByTestId } = render(<ChatToolOverlay activeToolView="plugins" onClose={() => {}} />);
    await waitFor(() => expect(getByTestId('plugins')).toBeTruthy());
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('z-20');
    expect(root.style.top).toBe('0px');
  });

  it('none 与 terminal 不渲染任何覆盖层', () => {
    for (const view of ['none', 'terminal']) {
      const { container } = render(<ChatToolOverlay activeToolView={view} onClose={() => {}} />);
      expect(container.firstElementChild).toBeNull();
    }
  });
});
