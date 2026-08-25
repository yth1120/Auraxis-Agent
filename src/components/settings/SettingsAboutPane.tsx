import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import logoPng from '../../assets/auraxis-logo.png';

export function SettingsAboutPane() {
  const t = useT();
  const [appVersion, setAppVersion] = useState('0.0.0');
  useEffect(() => {
    window.electronAPI?.system?.getVersion().then((result) => {
      if (result.ok && result.data) setAppVersion(result.data);
    });
  }, []);
  return (
    <div className="text-center py-8">
      <img src={logoPng} alt="Auraxis" className="w-16 h-16 object-contain mx-auto mb-3" />
      <h2 className="auraxis-wordmark" style={{ fontSize: 30, margin: '0 0 6px' }}>
        Auraxis
      </h2>
      <p className="text-text-muted text-sm font-mono my-1 mb-6">Version {appVersion}</p>
      <p className="text-text-secondary text-sm leading-[1.8] mx-auto mb-6 max-w-[400px]">{t('settings.aboutBody')}</p>
      <div className="flex justify-center flex-wrap gap-2">
        {['Electron', 'React 18', 'TypeScript', 'Ant Design 5', 'Zustand', 'DeepSeek SDK'].map((tech) => (
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
