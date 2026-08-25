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

// Ant Design 的静态 Modal / message / notification 会注册 portal 与定时器。
// 在 jsdom 环境卸载前统一销毁，并让 React 的延迟调度完成，避免 CI 上出现
// 测试文件结束后仍触发 window is not defined 的未处理异常。
afterEach(async () => {
  vi.useRealTimers();
  if (typeof document === 'undefined') return;

  cleanup();
  Modal.destroyAll();
  message.destroy();
  notification.destroy();

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
