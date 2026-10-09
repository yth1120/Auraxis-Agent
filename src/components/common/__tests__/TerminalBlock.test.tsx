// @vitest-environment jsdom
/**
 * TerminalBlock.test.tsx — 终端卡片的运行时行为。
 *
 * 这个文件此前**没有测试**，而它正是 G1 缺口的现场：实时输出一路从主进程采到了
 * `streamOutput`，却被 `{!running && …}` 挡在界面外 —— 跑测试/构建时用户只看到转圈。
 *
 * 这里钉四件事：
 *   · 运行中**真的**渲染输出（不是只有 banner）；
 *   · 运行中没有输出时不显示"无输出"（刚起步就说丧气话没有意义）；
 *   · 运行中只渲染尾部一个有界窗口（几百 KB stdout 不能把聊天区拖死）；
 *   · 自动跟随**只在用户本来就贴着底时**发生（不能抢走用户的滚动位置）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import TerminalBlock from '../TerminalBlock';
import { useI18nStore } from '../../../i18n';
import { TERMINAL_STREAM_MAX_LINES } from '../../../core/activity/liveOutput';

beforeEach(() => {
  useI18nStore.setState({ locale: 'zh-CN' });
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

const LINES = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');

/** jsdom 里 scrollHeight/clientHeight 恒为 0 —— 手工造出"内容比视口高"的几何。 */
function fakeGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

describe('TerminalBlock 运行中', () => {
  it('渲染实时输出（旧行为是只有 banner + 转圈）', () => {
    const { container } = render(<TerminalBlock command="npm test" output={'PASS a\nPASS b'} running />);
    const out = container.querySelector('.terminal-block-output');
    expect(out).not.toBeNull();
    expect(out!.textContent).toContain('PASS a');
    expect(out!.textContent).toContain('PASS b');
  });

  it('还没有输出时不画"无输出"', () => {
    const { container } = render(<TerminalBlock command="npm test" output="" running />);
    expect(container.querySelector('.terminal-block-output')).toBeNull();
    expect(container.querySelector('.terminal-block-empty')).toBeNull();
  });

  it('只渲染尾部有界窗口（300 行 → 至多 200 行）', () => {
    const { container } = render(<TerminalBlock command="npm test" output={LINES} running />);
    const rendered = container.querySelectorAll('.terminal-block-line').length;
    expect(rendered).toBeLessThanOrEqual(TERMINAL_STREAM_MAX_LINES);
    expect(container.querySelector('.terminal-block-output')!.textContent).toContain('line 299');
    // 运行中不做 head+tail 折叠（那是读完的日志才需要的）
    expect(container.querySelector('.terminal-block-expand')).toBeNull();
  });

  it('输出超过单帧窗口时如实说明省略了多少行', () => {
    const big = `${'x'.repeat(200)}\n`.repeat(100); // ≈20KB > 8KB 窗口
    const { container } = render(<TerminalBlock command="build" output={big} running />);
    expect(container.querySelector('.terminal-block-stream-note')?.textContent).toMatch(/省略/);
  });

  it('用户贴着底 → 新输出继续跟随', () => {
    const { container, rerender } = render(<TerminalBlock command="npm test" output={'a\nb'} running />);
    const out = container.querySelector('.terminal-block-output') as HTMLElement;
    fakeGeometry(out, 1000, 200, 800); // 距底 0
    fireEvent.scroll(out);
    rerender(<TerminalBlock command="npm test" output={'a\nb\nc'} running />);
    expect(out.scrollTop).toBe(1000);
  });

  it('用户滚上去看历史 → 新输出**不**把他拽回底部', () => {
    const { container, rerender } = render(<TerminalBlock command="npm test" output={'a\nb'} running />);
    const out = container.querySelector('.terminal-block-output') as HTMLElement;
    fakeGeometry(out, 1000, 200, 100); // 距底 700，用户在读历史
    fireEvent.scroll(out);
    rerender(<TerminalBlock command="npm test" output={'a\nb\nc\nd'} running />);
    expect(out.scrollTop).toBe(100); // 没有被拽走
  });
});

describe('TerminalBlock 已结束', () => {
  it('保留原行为：超长折叠 + 可展开 + 复制', () => {
    const { container } = render(<TerminalBlock command="npm test" output={LINES} />);
    expect(container.querySelector('.terminal-block-expand')).not.toBeNull();
    expect(container.querySelector('.terminal-block-copy')).not.toBeNull();
    expect(container.querySelector('.terminal-block-line')).not.toBeNull();
    expect(container.querySelector('.terminal-block-stream-note')).toBeNull();
  });

  it('没有输出时显示"无输出"', () => {
    const { container } = render(<TerminalBlock command="npm test" output="" />);
    expect(container.querySelector('.terminal-block-empty')).not.toBeNull();
  });

  it('失败但拿不到退出码时不伪造 code（只显示失败胶囊）', () => {
    const { container } = render(<TerminalBlock command="npm test" output="boom" failed />);
    const pill = container.querySelector('.terminal-block-pill')?.textContent ?? '';
    expect(pill).not.toMatch(/\d/);
  });

  it('复制把当前输出写进剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(<TerminalBlock command="npm test" output="hello" />);
    fireEvent.click(container.querySelector('.terminal-block-copy') as HTMLElement);
    expect(writeText).toHaveBeenCalledWith('hello');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
});
