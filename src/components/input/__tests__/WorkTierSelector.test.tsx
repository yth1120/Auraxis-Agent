// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { App } from 'antd';
import WorkTierSelector from '../WorkTierSelector';
import { useAppStore } from '../../../stores/useAppStore';

describe('WorkTierSelector — Work 执行档位按钮', () => {
  beforeEach(() => {
    useAppStore.setState({ workAutonomyTier: 'smart', showSettings: false });
  });

  it('renders a compact trigger and opens three radio options', async () => {
    const { container } = render(
      <App>
        <WorkTierSelector />
      </App>,
    );
    const trigger = container.querySelector('button')!;
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(document.body.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3);
    });
    expect(document.body.textContent).toContain('智能放行');
  });

  it('switches to 计划确认 / 智能放行 without confirmation', async () => {
    const { container } = render(
      <App>
        <WorkTierSelector />
      </App>,
    );
    fireEvent.click(container.querySelector('button')!);
    await waitFor(() => {
      expect(document.body.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3);
    });
    const plan = [...document.querySelectorAll('[role="menuitemradio"]')].find((b) =>
      b.textContent?.includes('计划确认'),
    )!;
    fireEvent.click(plan);
    expect(useAppStore.getState().workAutonomyTier).toBe('plan');
  });

  it('requires confirmation before switching to 全自动', async () => {
    const { container } = render(
      <App>
        <WorkTierSelector />
      </App>,
    );
    fireEvent.click(container.querySelector('button')!);
    await waitFor(() => {
      expect(document.body.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3);
    });
    const full = [...document.querySelectorAll('[role="menuitemradio"]')].find((b) =>
      b.textContent?.includes('全自动'),
    )!;
    fireEvent.click(full);
    await waitFor(() => {
      expect(document.body.textContent).toContain('切换到全自动？');
    });
    expect(useAppStore.getState().workAutonomyTier).toBe('smart');

    const ack = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('已了解，切换'))!;
    fireEvent.click(ack);
    await act(async () => {});
    expect(useAppStore.getState().workAutonomyTier).toBe('full');
  });
});
