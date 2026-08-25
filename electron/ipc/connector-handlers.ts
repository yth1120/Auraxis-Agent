/**
 * connector-handlers.ts — Slack / Drive / Notion connector IPC for Settings.
 */
import { errorText } from '../errors';
import { secureHandle } from './trust';
import {
  getConnectorStatuses,
  getLarkPublicConfig,
  setConnectorToken,
  setLarkCredentials,
  testConnector,
  type ConnectorKind,
} from '../connectors';

function isKind(v: unknown): v is ConnectorKind {
  return v === 'slack' || v === 'drive' || v === 'notion' || v === 'lark';
}

export function registerConnectorHandlers() {
  secureHandle('connector:status', async () => {
    try {
      return { ok: true, data: await getConnectorStatuses() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('connector:setToken', async (_event, kind: unknown, token: unknown) => {
    try {
      if (!isKind(kind)) return { ok: false, error: '连接器类型无效' };
      if (kind === 'lark') return { ok: false, error: '飞书/Lark 请使用凭据配置' };
      if (typeof token !== 'string') return { ok: false, error: 'Token 必须是字符串' };
      await setConnectorToken(kind, token);
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('connector:getLark', async () => {
    try {
      return { ok: true, data: await getLarkPublicConfig() };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('connector:setLark', async (_event, input: unknown) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: '飞书/Lark 配置无效' };
      }
      const record = input as Record<string, unknown>;
      if (typeof record.appId !== 'string' || typeof record.appSecret !== 'string') {
        return { ok: false, error: '飞书/Lark 需要 App ID 和 App Secret' };
      }
      await setLarkCredentials({
        appId: record.appId,
        appSecret: record.appSecret,
        domain: typeof record.domain === 'string' ? record.domain : undefined,
        tools: typeof record.tools === 'string' ? record.tools : undefined,
      });
      return { ok: true };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });

  secureHandle('connector:test', async (_event, kind: unknown) => {
    try {
      if (!isKind(kind)) return { ok: false, error: '连接器类型无效' };
      return { ok: true, data: await testConnector(kind) };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  });
}
