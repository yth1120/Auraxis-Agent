// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { App } from 'antd';
import PermissionSelector from '../PermissionSelector';
import { useAppStore } from '../../../stores/useAppStore';

describe('PermissionSelector — 统一运行权限面板', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      permissionProfile: {
        list: vi.fn(async () => ({
          ok: true,
          data: {
            profiles: [
              { id: 'standard', name: '标准', builtin: true },
              { id: 'readonly', name: '只读', builtin: true },
              { id: 'custom-1', name: '我的档案', builtin: false },
            ],
            activeId: 'standard',
          },
        })),
      },
    };
    useAppStore.setState({ showSettings: false, settingsInitialKey: 'general' });
  });

  it('renders the current preset on the compact pill', async () => {
    const { getByRole } = render(<PermissionSelector preset="ask" onChangePreset={() => {}} />);
    // Flush the async profile fetch so its state update is wrapped in act().
    await act(async () => {});
    expect(getByRole('button', { name: '运行权限' }).textContent).toContain('每次确认');
  });

  it('opens a radio-style panel with four presets and selects one immediately', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<PermissionSelector preset="readonly" onChangePreset={onChange} />);
    fireEvent.click(getByRole('button', { name: '运行权限' }));

    await waitFor(() => {
      expect(document.body.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    });

    const autoRow = [...document.querySelectorAll('[role="menuitemradio"]')].find((b) =>
      b.textContent?.includes('自动代批'),
    )!;
    expect(autoRow.getAttribute('title')).toContain('工作区内自动执行；质量门失败时暂停等你确认');
    fireEvent.click(autoRow);
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('requires risk confirmation before switching to full access', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <App>
        <PermissionSelector preset="ask" onChangePreset={onChange} />
      </App>,
    );
    fireEvent.click(getByRole('button', { name: '运行权限' }));

    await waitFor(() => {
      expect(document.body.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    });
    const fullRow = [...document.querySelectorAll('[role="menuitemradio"]')].find((b) =>
      b.textContent?.includes('完全访问'),
    )!;
    fireEvent.click(fullRow);

    await waitFor(() => {
      expect(document.body.textContent).toContain('我已了解风险，继续');
    });
    expect(onChange).not.toHaveBeenCalled();

    const ackBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('我已了解风险，继续'))!;
    fireEvent.click(ackBtn);
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('full');
    });
  });

  it('opens the permissions settings pane from the more-profiles row', async () => {
    const { getByRole } = render(<PermissionSelector preset="ask" onChangePreset={() => {}} />);
    fireEvent.click(getByRole('button', { name: '运行权限' }));

    await waitFor(() => {
      expect(document.body.textContent).toContain('更多档案');
      expect(document.body.textContent).toContain('标准');
    });

    const moreRow = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('更多档案'))!;
    fireEvent.click(moreRow);

    expect(useAppStore.getState().settingsInitialKey).toBe('permissions');
    expect(useAppStore.getState().showSettings).toBe(true);
  });
});
