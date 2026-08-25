import { errorText } from '../../electron/errors';
import { create } from 'zustand';
import type { AuthChangePasswordParams, AuthLoginParams, AuthPhase, AuthSetupParams } from '../types/electron-api';

interface AuthStore {
  /** Auth state has been hydrated from the main process. */
  ready: boolean;
  phase: AuthPhase;
  name: string;
  email: string;
  avatar: string;
  rememberMe: boolean;
  /** Transient notice shown on the login screen (e.g. account just created). */
  notice: string;

  hydrate: () => Promise<void>;
  setup: (params: AuthSetupParams) => Promise<{ ok: boolean; error?: string }>;
  login: (params: AuthLoginParams) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  switchToSetup: () => void;
  switchToLogin: () => void;
  changePassword: (params: AuthChangePasswordParams) => Promise<{ ok: boolean; error?: string }>;
  setAvatar: (avatar: string) => Promise<{ ok: boolean; error?: string }>;
  changeName: (name: string) => Promise<{ ok: boolean; error?: string }>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  ready: false,
  phase: 'locked',
  name: '',
  email: '',
  avatar: '',
  rememberMe: false,
  notice: '',

  hydrate: async () => {
    let statusResolved = false;
    try {
      const res = await window.electronAPI?.auth?.status();
      if (res?.ok && res.data) {
        statusResolved = true;
        set({
          phase: res.data.phase,
          name: res.data.name ?? '',
          email: res.data.email ?? '',
          avatar: res.data.avatar ?? '',
          rememberMe: res.data.rememberMe,
          notice: '',
        });
      }
    } catch {
      // 认证服务不可用时仍允许进入注册页，避免用户卡死在登录页。
    } finally {
      set({ ready: true, ...(statusResolved ? {} : { phase: 'setup' as const }) });
    }
  },

  setup: async (params) => {
    try {
      const res = await window.electronAPI?.auth?.setup(params);
      if (res?.ok) {
        // 注册成功后回到登录页，必须登录一次才能进入工作台。
        set({
          phase: 'locked',
          name: params.name.trim(),
          email: params.email.trim().toLowerCase(),
          avatar: '',
          rememberMe: false,
          notice: 'created',
        });
      }
      return res ?? { ok: false, error: '认证服务不可用' };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  },

  login: async (params) => {
    try {
      const res = await window.electronAPI?.auth?.login(params);
      if (res?.ok) {
        set({
          phase: 'unlocked',
          email: params.email.trim().toLowerCase(),
          rememberMe: !!params.rememberMe,
          notice: '',
        });
      }
      return res ?? { ok: false, error: '认证服务不可用' };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  },

  logout: async () => {
    try {
      await window.electronAPI?.auth?.logout();
    } finally {
      set({ phase: 'locked', rememberMe: false, notice: '' });
    }
  },

  switchToSetup: () => set({ phase: 'setup', notice: '' }),

  switchToLogin: () => set({ phase: 'locked', notice: '' }),

  changePassword: async (params) => {
    try {
      return (await window.electronAPI?.auth?.changePassword(params)) ?? { ok: false, error: '认证服务不可用' };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  },

  setAvatar: async (avatar) => {
    try {
      const res = (await window.electronAPI?.auth?.setAvatar(avatar)) ?? { ok: false, error: '认证服务不可用' };
      if (res.ok) set({ avatar });
      return res;
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  },

  changeName: async (name) => {
    try {
      const res = (await window.electronAPI?.auth?.changeName(name)) ?? { ok: false, error: '认证服务不可用' };
      if (res.ok) set({ name: name.trim() });
      return res;
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  },
}));
