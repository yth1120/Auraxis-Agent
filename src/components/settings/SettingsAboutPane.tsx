import { useCallback, useEffect, useState } from 'react';
import { Button, Progress } from 'antd';
import { useT } from '../../i18n';
import logoPng from '../../assets/auraxis-logo.png';
import type { UpdateStatePayload } from '../../types/electron-api';

export function SettingsAboutPane() {
  const t = useT();
  const [appVersion, setAppVersion] = useState('0.0.0');
  const [update, setUpdate] = useState<UpdateStatePayload | null>(null);

  useEffect(() => {
    window.electronAPI?.system?.getVersion().then((result) => {
      if (result.ok && result.data) setAppVersion(result.data);
    });
  }, []);

  const refresh = useCallback(async () => {
    const result = await window.electronAPI?.update?.getState();
    if (result?.ok && result.data) setUpdate(result.data);
  }, []);

  useEffect(() => {
    void refresh();
    const off = window.electronAPI?.update?.onState((state) => setUpdate(state));
    return () => {
      off?.();
    };
  }, [refresh]);

  const runCheck = useCallback(async () => {
    await window.electronAPI?.update?.check();
    await refresh();
  }, [refresh]);

  const runDownload = useCallback(async () => {
    await window.electronAPI?.update?.download();
    await refresh();
  }, [refresh]);

  const runInstall = useCallback(async () => {
    await window.electronAPI?.update?.install();
  }, []);

  const status = update?.status ?? 'idle';
  const busy = status === 'checking' || status === 'downloading';
  const statusText: string = (() => {
    switch (status) {
      case 'checking':
        return t('settings.update.checking');
      case 'available':
        return t('settings.update.available', { version: update?.availableVersion ?? '' });
      case 'not-available':
        return t('settings.update.latest');
      case 'downloading':
        return t('settings.update.downloading', { percent: update?.progressPercent ?? 0 });
      case 'downloaded':
        return t('settings.update.downloaded');
      case 'error':
        return t('settings.update.error', { message: update?.error ?? '' });
      case 'unsupported':
        return t('settings.update.unsupported');
      default:
        return t('settings.update.idle');
    }
  })();

  return (
    <div className="text-center py-8">
      <img src={logoPng} alt="Auraxis" className="w-16 h-16 object-contain mx-auto mb-3" />
      <h2 className="auraxis-wordmark" style={{ fontSize: 30, margin: '0 0 6px' }}>
        Auraxis
      </h2>
      <p className="text-text-muted text-sm font-mono my-1">Version {appVersion}</p>
      <div className="mb-6 mt-3">
        <p className="text-text-secondary text-sm my-1" data-testid="update-status">
          {statusText}
        </p>
        {status === 'downloading' && (
          <div className="mx-auto mt-2 max-w-[240px]">
            <Progress percent={update?.progressPercent ?? 0} size="small" />
          </div>
        )}
        <div className="flex justify-center flex-wrap gap-2 mt-3">
          <Button size="small" onClick={runCheck} disabled={busy || status === 'unsupported'}>
            {t('settings.update.check')}
          </Button>
          {status === 'available' && (
            <Button size="small" type="primary" onClick={runDownload}>
              {t('settings.update.download')}
            </Button>
          )}
          {status === 'downloaded' && (
            <Button size="small" type="primary" onClick={runInstall}>
              {t('settings.update.install')}
            </Button>
          )}
        </div>
      </div>
      <p className="text-text-secondary text-sm leading-[1.8] mx-auto mb-6 max-w-[400px]">{t('settings.aboutBody')}</p>
      <div className="flex justify-center flex-wrap gap-2">
        {['Electron 44', 'React 19', 'TypeScript', 'Ant Design 6', 'Zustand', 'DeepSeek SDK'].map((tech) => (
          <span
            key={tech}
            className="inline-flex items-center h-6 px-2.5 rounded-full text-2xs font-medium whitespace-nowrap bg-[var(--color-bg-secondary)] border border-[var(--color-border-dim)] text-text-secondary"
          >
            {tech}
          </span>
        ))}
      </div>
    </div>
  );
}
