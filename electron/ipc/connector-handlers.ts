/**
 * connector-handlers.ts — Slack / Drive / Notion connector IPC for Settings.
 */
import { errorText } from '../errors';
import { secureHandle } from './trust';
import { getConnectorStatuses, setConnectorToken, testConnector, type ConnectorKind } from '../connectors';

function isKind(v: unknown): v is ConnectorKind {
  return v === 'slack' || v === 'drive' || v === 'notion';
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
      if (typeof token !== 'string') return { ok: false, error: 'Token 必须是字符串' };
      await setConnectorToken(kind, token);
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
