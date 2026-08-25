import { errorText } from '../errors';
import { secureHandle } from './trust';
import {
  getAuthStatus,
  setupAccount,
  loginAccount,
  logoutAccount,
  changeAccountPassword,
  setAccountAvatar,
  changeAccountName,
} from '../auth-store';
import type {
  AuthChangeNameParams,
  AuthChangePasswordParams,
  AuthLoginParams,
  AuthSetupParams,
} from '../contracts/auth';

export function registerAuthHandlers(): void {
  secureHandle('auth:status', async () => {
    try {
      return { ok: true, data: await getAuthStatus() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('auth:setup', async (_event, params: AuthSetupParams) => {
    try {
      return await setupAccount(params ?? {});
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('auth:login', async (_event, params: AuthLoginParams) => {
    try {
      return await loginAccount(params ?? {});
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('auth:logout', async () => {
    try {
      await logoutAccount();
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('auth:changePassword', async (_event, params: AuthChangePasswordParams) => {
    try {
      return await changeAccountPassword(params ?? {});
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('auth:setAvatar', async (_event, avatar: string) => {
    try {
      return await setAccountAvatar(avatar);
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('auth:changeName', async (_event, params: AuthChangeNameParams) => {
    try {
      return await changeAccountName(params ?? {});
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
