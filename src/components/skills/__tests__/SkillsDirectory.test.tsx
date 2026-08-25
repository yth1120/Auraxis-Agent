// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import { App } from 'antd';
import SkillsDirectory from '../SkillsDirectory';

describe('SkillsDirectory — 技能目录按钮', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      skills: {
        list: vi.fn(async () => ({
          ok: true,
          data: { skills: [{ name: 'Code Review', description: '审查', path: 'x', updatedAt: 1 }] },
        })),
      },
      shell: { openSkillsDirectory: vi.fn(async () => ({ ok: true })) },
    };
  });

  it('renders the directory and opens the folder button', async () => {
    const { getByText } = render(
      <App>
        <SkillsDirectory open onClose={() => {}} />
      </App>,
    );
    await act(async () => {});
    expect(getByText('Code Review')).toBeTruthy();
    fireEvent.click(getByText('打开技能目录'));
    await waitFor(() => {
      expect((window as any).electronAPI.shell.openSkillsDirectory).toHaveBeenCalled();
    });
  });
});
