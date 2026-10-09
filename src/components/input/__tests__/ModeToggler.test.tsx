// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useChatStore } from '../../../stores/useChatStore';
import { useAppStore } from '../../../stores/useAppStore';
import { ModeTrigger, ModePanelContent } from '../ModeToggler';

beforeEach(() => {
  useChatStore.setState({ selectedModel: 'deepseek-v4-pro', isDeepThink: false });
  useAppStore.setState({ sidebarMode: 'code' });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ModeTrigger', () => {
  it('shows the current model name (DeepSeek V4 Pro by default)', () => {
    render(<ModeTrigger onClick={() => {}} />);
    expect(screen.getByText((content) => content.includes('DeepSeek V4 Pro'))).toBeDefined();
  });

  it('fires onClick when clicked', () => {
    let clicked = false;
    render(
      <ModeTrigger
        onClick={() => {
          clicked = true;
        }}
      />,
    );
    fireEvent.click(screen.getByText((content) => content.includes('DeepSeek V4 Pro')));
    expect(clicked).toBe(true);
  });

  it('shows the current name when an old saved model id is selected', () => {
    useChatStore.setState({ selectedModel: 'deepseek-v4-flash' });
    render(<ModeTrigger onClick={() => {}} />);
    expect(screen.getByText((content) => content.includes('DeepSeek V4.1 Flash'))).toBeDefined();
  });

  it('Chat 思考关闭时触发器不显示思考深度', () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    useChatStore.setState({ isDeepThink: false, reasoningEffort: 'high' });
    render(<ModeTrigger onClick={() => {}} />);
    expect(screen.queryByText('/ 深度思考')).toBeNull();
    expect(screen.getByText((content) => content.includes('DeepSeek V4 Pro'))).toBeDefined();
  });

  it('Chat 模式触发器始终不显示思考深度（开启时也不显示）', () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    useChatStore.setState({ isDeepThink: true, reasoningEffort: 'high' });
    render(<ModeTrigger onClick={() => {}} />);
    expect(screen.queryByText('/ 深度思考')).toBeNull();
  });

  it('Work/Code 触发器显示当前思考深度', () => {
    useAppStore.setState({ sidebarMode: 'code' });
    useChatStore.setState({ isDeepThink: true, reasoningEffort: 'high' });
    render(<ModeTrigger onClick={() => {}} />);
    expect(screen.getByText('/ 深度思考')).toBeDefined();
  });
});

describe('ModePanelContent', () => {
  it('只列出当前在售模型，不再出现旧名条目', () => {
    useChatStore.setState({ reasoningEffort: 'medium' });
    render(<ModePanelContent />);
    expect(screen.getByText('DeepSeek V4.1 Flash')).toBeDefined();
    expect(screen.getByText('DeepSeek V4 Pro')).toBeDefined();
    // 旧名已从产品里移除：既没有旧名条目，也没有「旧名」徽标。
    expect(screen.queryByText(/旧名/)).toBeNull();
    expect(screen.queryByText(/Vision Exp/)).toBeNull();
    expect(screen.getByText('思考深度')).toBeDefined();
    expect(screen.getByRole('slider', { name: '思考深度' })).toBeDefined();
    expect(screen.getByText('中度思考')).toBeDefined();
  });

  it('clicking DeepSeek V4.1 Flash switches model', () => {
    render(<ModePanelContent />);
    fireEvent.click(screen.getByText('DeepSeek V4.1 Flash'));
    expect(useChatStore.getState().selectedModel).toBe('deepseek-flash');
  });

  it('旧设置里保存的旧模型名显示为当前名（不会漏出旧 id）', () => {
    useChatStore.setState({ selectedModel: 'deepseek-v4-flash-vision-exp' });
    render(<ModeTrigger onClick={() => {}} />);
    expect(screen.getByText((content) => content.includes('DeepSeek V4.1 Flash'))).toBeDefined();
    expect(screen.queryByText((content) => content.includes('deepseek-v4-flash-vision-exp'))).toBeNull();
  });

  it('clicking DeepSeek V4 Pro switches model', () => {
    useChatStore.setState({ selectedModel: 'deepseek-v4-flash' });
    render(<ModePanelContent />);
    fireEvent.click(screen.getByText('DeepSeek V4 Pro'));
    expect(useChatStore.getState().selectedModel).toBe('deepseek-v4-pro');
  });

  it('thinking-depth rail exposes a canvas particle layer', () => {
    const { container } = render(<ModePanelContent />);
    expect(container.querySelector('canvas.ax-effort-canvas')).toBeTruthy();
  });

  it('clicking a thinking-depth dot switches effort', async () => {
    vi.useFakeTimers();
    const { container } = render(<ModePanelContent />);
    const lowDot = container.querySelector('[data-level="low"]') as HTMLButtonElement;
    fireEvent.click(lowDot);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(useChatStore.getState().reasoningEffort).toBe('low');
  });

  it('slider reflects the current effort level', () => {
    useChatStore.setState({ reasoningEffort: 'high' });
    render(<ModePanelContent />);
    expect(screen.getByRole('slider', { name: '思考深度' }).getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByText('深度思考')).toBeDefined();
  });

  it('renders content via ModePanelContent', () => {
    render(<ModePanelContent />);
    expect(screen.getByText('DeepSeek V4.1 Flash')).toBeDefined();
    expect(screen.getByText('DeepSeek V4 Pro')).toBeDefined();
    expect(screen.getByText('思考深度')).toBeDefined();
  });

  it('Chat 面板不渲染思考开关与滑轨（关闭时）', () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    useChatStore.setState({ isDeepThink: false, reasoningEffort: 'medium' });
    render(<ModePanelContent />);
    expect(screen.queryByRole('slider', { name: '思考深度' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '思考' })).toBeNull();
    expect(useChatStore.getState().reasoningEffort).toBe('medium');
  });

  it('Chat 面板不渲染思考开关与滑轨（开启时）', () => {
    useAppStore.setState({ sidebarMode: 'chat' });
    useChatStore.setState({ isDeepThink: true, reasoningEffort: 'high' });
    render(<ModePanelContent />);
    expect(screen.queryByRole('switch', { name: '思考' })).toBeNull();
    expect(screen.queryByRole('slider', { name: '思考深度' })).toBeNull();
    expect(screen.queryByText('思考深度')).toBeNull();
  });

  it('Work/Code 模式不显示思考开关，滑轨始终可用', async () => {
    useAppStore.setState({ sidebarMode: 'work' });
    useChatStore.setState({ isDeepThink: false, reasoningEffort: 'medium' });
    vi.useFakeTimers();
    const { container } = render(<ModePanelContent />);
    expect(screen.queryByRole('switch', { name: '思考' })).toBeNull();
    const slider = screen.getByRole('slider', { name: '思考深度' });
    expect(slider).toBeDefined();

    const lowDot = container.querySelector('[data-level="low"]') as HTMLButtonElement;
    fireEvent.click(lowDot);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(useChatStore.getState().reasoningEffort).toBe('low');
  });
});
