// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import PreviewBrowser from '../PreviewBrowser';

describe('PreviewBrowser — 预览浏览器按钮', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      browser: {
        open: vi.fn(async () => ({ ok: true, data: {} })),
        navigate: vi.fn(async () => ({ ok: true, data: {} })),
        back: vi.fn(async () => ({ ok: true, data: {} })),
        forward: vi.fn(async () => ({ ok: true, data: {} })),
        reload: vi.fn(async () => ({ ok: true, data: {} })),
        home: vi.fn(async () => ({ ok: true, data: {} })),
      },
    };
  });

  it('renders viewport switch buttons', () => {
    const { container } = render(<PreviewBrowser tabId="p1" />);
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(4);
  });
});
