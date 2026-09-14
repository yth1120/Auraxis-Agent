import { afterEach, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Modal, message, notification } from 'antd';

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverMock,
  });
}

// Ant Design 的静态 Modal / message / notification 会在 portal 里创建独立的
// React root，并带有 motion 定时器（rc-motion 默认 300ms 级）。若这些任务在
// jsdom 环境卸载后才执行，React 调度器会访问已销毁的 window 并抛出
// `ReferenceError: window is not defined`，让 vitest 以非零码退出（Linux CI 上
// 曾稳定复现）。这里先销毁 portal，再抽干宏任务队列，让所有延迟调度落地。
afterEach(async () => {
  vi.useRealTimers();
  if (typeof document === 'undefined') return;

  await act(async () => {
    Modal.destroyAll();
    message.destroy();
    notification.destroy();
    cleanup();
  });

  // 5 × 100ms 覆盖 rc-motion 的离场动画窗口，确保 teardown 前不再有排队任务。
  for (let drain = 0; drain < 5; drain += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  }
});
