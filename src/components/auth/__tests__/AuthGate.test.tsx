// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import AuthGate from '../AuthGate';

describe('AuthGate — 注册登录按钮', () => {
  beforeEach(() => {
    (window as any).electronAPI = {
      auth: {
        status: vi.fn(async () => ({ ok: true, data: { phase: 'setup', registered: false } })),
        setup: vi.fn(async () => ({ ok: true })),
        login: vi.fn(async () => ({ ok: true })),
      },
      system: { getVersion: vi.fn(async () => ({ ok: true, data: '1.0.0' })) },
    };
  });

  it('registers through the submit button', async () => {
    render(
      <AuthGate>
        <div />
      </AuthGate>,
    );
    const nameInput = await screen.findByPlaceholderText('怎么称呼你');
    fireEvent.change(nameInput, { target: { value: '测试' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('至少 6 位'), { target: { value: '123456' } });
    fireEvent.change(screen.getByPlaceholderText('再次输入密码'), { target: { value: '123456' } });
    const submit = [...screen.getAllByRole('button')].find((b) => b.textContent?.includes('创建账户'))!;
    fireEvent.click(submit);
    await waitFor(() => {
      expect((window as any).electronAPI.auth.setup).toHaveBeenCalled();
    });
  });

  it('从登录页可以返回创建账户页面', async () => {
    (window as any).electronAPI.auth.status = vi.fn(async () => ({
      ok: true,
      data: { phase: 'locked', registered: true },
    }));
    render(
      <AuthGate>
        <div />
      </AuthGate>,
    );
    const link = await screen.findByRole('button', { name: '还没有账户？创建账户' });
    fireEvent.click(link);
    expect(await screen.findByPlaceholderText('怎么称呼你')).toBeTruthy();
  });
});
